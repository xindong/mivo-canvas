// W1 · 局部重绘黑盘检测器
//
// 现象：mask-edit 在某些上游条件下返回结果图在 mask 区域整片纯黑（RGB≈0），
// 像被黑色色块"涂掉"——不是用户要的内容。需要在上游结果 commit 到画布前检出
// 并自愈重试一次（见 maskEditGeneration.runMaskEditGeneration done 分支）。
//
// 输入契约（显式，F2）：{sourceSizePx, resultSizePx, maskBoundsPx}。
//   - maskBoundsPx 与 ImageMaskSubmitPayload.maskBounds 同空间 —— 源图 natural pixel
//     坐标（boundsForRegions 产出，已 clamp 到源图尺寸）。
//   - sourceSizePx 是源图 natural pixel（payload.sourceSize）。
//   - resultSizePx 是结果图 natural pixel —— low 档通常 1024，可能与源不同尺寸。
//
// 采样前按 result/source 比例把 maskBounds 缩放到结果图空间并 clamp（F2），
// 否则源 1600 的 bounds 直接套到 1024 的结果图上会越界 / 错位，漏判黑盘。
//
// 判定：结果图 mask 区 ≥70% 近黑（RGB<16）且源图同区不黑（<30%）→ 黑盘。
//   源本黑（用户真要画纯黑区）→ 不判黑盘，避免误触发自愈（W1.4 已知风险）。
//
// 像素解码：b64→Blob→createImageBitmap→(Offscreen)Canvas.getImageData。
// 任一步解码失败 → 保守返回 false（不误触发自愈）。

import type { ImageMaskBounds } from '../canvas/imageMaskGeometry'

export type MaskInspectionInput = {
  sourceSizePx: { width: number; height: number }
  maskBoundsPx: ImageMaskBounds
  /** 结果图尺寸由检测器内部从解码 bitmap 得到 —— 调用方无法预知 low 档 1024
   *  vs medium 档实际尺寸，故不入输入契约。mapBoundsToResultSpace 的单测直接
   *  传 resultSizePx 验证映射纯函数。 */
}

export type MaskInspectionSources = {
  /** 源图 Blob（readCanvasImageBlob 产出的 File）。 */
  sourceBlob: Blob
  /** 结果图 base64（无 data: 前缀），来自 pollTask done view.result.images[i].b64。 */
  resultB64: string
}

const BLACK_RGB_MAX = 16 // RGB 三通道均 < 16 视为近黑
const BLACK_RATIO_THRESHOLD = 0.7 // 结果图 mask 区 ≥70% 近黑 → 疑似黑盘
const SOURCE_BLACK_RATIO_MAX = 0.3 // 源图同区 ≥30% 黑 → 视为源本黑，不判黑盘

// —— 黑块修复：全图近黑连通组件检测阈值（out-of-mask 黑块） ——
// 禁止"全图单一 black ratio 阈值"：110x110 黑块在 512x512 里只占 4.6%，任何全图
// 占比阈值都会漏判或误伤，必须按连通组件的面积/形状判。
const NEAR_BLACK_LUMA_MAX = 35 // luma(0.299r+0.587g+0.114b) < 35 也视为近黑（组件检测用）
const COMPONENT_MIN_AREA_FLOOR = 900 // 组件面积下限（px），过滤细黑线/小字
const COMPONENT_MIN_AREA_RATIO = 0.002 // 面积下限的相对分量：resultPixels * 0.002
const COMPONENT_MIN_EDGE = 24 // bbox 最小边 >= 24px（过滤长细线）
const COMPONENT_BBOX_FILL_MIN = 0.35 // 组件像素 / bbox 面积 >= 0.35（过滤稀疏笔画）
const IN_MASK_OVERLAP_SKIP = 0.5 // 组件 bbox 与当前 mask 区重叠 >= 50% → 视为本次编辑区内容，跳过

/** 把 source 空间的 maskBounds 映射到 result 空间并 clamp。
 *  result 图可能与源图不同尺寸（low 档 1024 vs 源 1600），bounds 必须等比缩放，
 *  否则直接套用会越界 / 错位。导出供单测验证 1600x900→1024 映射。 */
export const mapBoundsToResultSpace = (
  maskBoundsPx: ImageMaskBounds,
  sourceSizePx: { width: number; height: number },
  resultSizePx: { width: number; height: number },
): ImageMaskBounds => {
  const scaleX = resultSizePx.width / Math.max(1, sourceSizePx.width)
  const scaleY = resultSizePx.height / Math.max(1, sourceSizePx.height)
  const x = Math.max(0, Math.floor(maskBoundsPx.x * scaleX))
  const y = Math.max(0, Math.floor(maskBoundsPx.y * scaleY))
  const right = Math.min(resultSizePx.width, Math.ceil((maskBoundsPx.x + maskBoundsPx.width) * scaleX))
  const bottom = Math.min(resultSizePx.height, Math.ceil((maskBoundsPx.y + maskBoundsPx.height) * scaleY))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/** 纯函数：给定 RGBA 像素 + 图片尺寸 + 区域 bounds，返回该区域近黑像素占比。
 *  跳过完全透明像素（alpha=0）不计入分母，避免透明 PNG 的透明区（RGB 可能=0）
 *  被误算为黑。导出供单测构造像素数据覆盖四态。 */
export const blackRatioInRegion = (
  rgba: Uint8ClampedArray,
  imageSize: { width: number; height: number },
  bounds: ImageMaskBounds,
): { ratio: number; sampled: number } => {
  const x0 = Math.max(0, Math.floor(bounds.x))
  const y0 = Math.max(0, Math.floor(bounds.y))
  const x1 = Math.min(imageSize.width, Math.ceil(bounds.x + bounds.width))
  const y1 = Math.min(imageSize.height, Math.ceil(bounds.y + bounds.height))
  let black = 0
  let sampled = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * imageSize.width + x) * 4
      const a = rgba[idx + 3]
      if (a === 0) continue // 透明像素不计入
      sampled++
      const r = rgba[idx]
      const g = rgba[idx + 1]
      const b = rgba[idx + 2]
      if (r < BLACK_RGB_MAX && g < BLACK_RGB_MAX && b < BLACK_RGB_MAX) black++
    }
  }
  return { ratio: sampled > 0 ? black / sampled : 0, sampled }
}

/** 纯函数：黑盘判定。结果区近黑占比 ≥70% 且源区近黑占比 <30% → 黑盘。
 *  抽成纯函数以便单测覆盖四态判定逻辑（不依赖 DOM 解码）。 */
export const judgeBlackPlate = (
  resultBlackRatio: number,
  sourceBlackRatio: number,
): boolean =>
  resultBlackRatio >= BLACK_RATIO_THRESHOLD && sourceBlackRatio < SOURCE_BLACK_RATIO_MAX

const b64ToBlob = (b64: string, mime = 'image/png'): Blob => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

type CanvasLike = HTMLCanvasElement | OffscreenCanvas
type ContextLike = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const createCanvas = (width: number, height: number): CanvasLike => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

const readImageDataFromBitmap = async (
  bitmap: ImageBitmap,
  targetSize: { width: number; height: number },
): Promise<ImageData> => {
  const canvas = createCanvas(targetSize.width, targetSize.height)
  const ctx = canvas.getContext('2d') as ContextLike | null
  if (!ctx) throw new Error('no 2d context for mask inspection')
  ;(ctx as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, targetSize.width, targetSize.height)
  return (ctx as CanvasRenderingContext2D).getImageData(0, 0, targetSize.width, targetSize.height)
}

/** 解码 base64 结果图，返回原始尺寸 ImageData（drawImage 不缩放；结果图尺寸
 *  由解码决定，调用方无法预知 low 档 1024 vs medium 档实际尺寸）。 */
const readResultImageData = async (resultB64: string): Promise<ImageData> => {
  const blob = b64ToBlob(resultB64)
  const bitmap = await createImageBitmap(blob)
  const data = await readImageDataFromBitmap(bitmap, { width: bitmap.width, height: bitmap.height })
  bitmap.close?.()
  return data
}

/** 解码源图 Blob，返回原始尺寸 ImageData（不缩放，maskBounds 已是源空间坐标）。 */
const readSourceImageData = async (sourceBlob: Blob): Promise<ImageData> => {
  const bitmap = await createImageBitmap(sourceBlob)
  const data = await readImageDataFromBitmap(bitmap, { width: bitmap.width, height: bitmap.height })
  bitmap.close?.()
  return data
}

// —— 黑块修复：全图近黑连通组件 + 历史洞区高优先检测 ————————————————————

export type MaskArtifactReason = 'current-mask-black-plate' | 'out-of-mask-new-black-component'

export type MaskArtifactComponent = {
  /** result 图空间 bbox */
  bounds: ImageMaskBounds
  /** 组件近黑像素数（result 空间） */
  areaPx: number
  /** 组件像素 / bbox 面积 */
  bboxFillRatio: number
  /** 回映射 source 同区域的近黑占比（>=0.3 视为源本黑已被忽略，不会出现在 components 里） */
  sourceBlackRatio: number
}

export type MaskArtifactInspection = {
  hasArtifact: boolean
  reason?: MaskArtifactReason
  components: MaskArtifactComponent[]
}

export type MaskArtifactInput = {
  sourceSizePx: { width: number; height: number }
  /** 本次编辑的 mask 区（源图 natural pixel）。缺省时跳过 plate 判定，只做全图组件检测。 */
  maskBoundsPx?: ImageMaskBounds
  /** 历史局部重绘洞区（已映射到当前源图 natural pixel 空间）—— 黑块高发区，高优先检测。 */
  priorMaskBoundsPx?: ImageMaskBounds[]
}

/** 纯函数：全图找近黑连通组件（4 连通 flood fill）。近黑 = alpha>0 且
 *  （RGB 三通道均 <16 或 luma<35）。返回通过面积/最小边/bbox 填充率过滤的组件。
 *  导出供单测直接构造像素数据覆盖阈值边界（细黑线 / 小字 / 大块）。 */
export const findNearBlackComponents = (
  rgba: Uint8ClampedArray,
  imageSize: { width: number; height: number },
): Array<{ bounds: ImageMaskBounds; areaPx: number; bboxFillRatio: number }> => {
  const { width, height } = imageSize
  const total = width * height
  const minArea = Math.max(COMPONENT_MIN_AREA_FLOOR, total * COMPONENT_MIN_AREA_RATIO)

  // 近黑位图（1 = 近黑且未访问；访问后清 0，兼作 visited 标记）
  const nearBlack = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    const idx = i * 4
    if (rgba[idx + 3] === 0) continue
    const r = rgba[idx]
    const g = rgba[idx + 1]
    const b = rgba[idx + 2]
    if (
      (r < BLACK_RGB_MAX && g < BLACK_RGB_MAX && b < BLACK_RGB_MAX) ||
      0.299 * r + 0.587 * g + 0.114 * b < NEAR_BLACK_LUMA_MAX
    ) {
      nearBlack[i] = 1
    }
  }

  const components: Array<{ bounds: ImageMaskBounds; areaPx: number; bboxFillRatio: number }> = []
  const stack: number[] = []
  for (let start = 0; start < total; start++) {
    if (!nearBlack[start]) continue
    let areaPx = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    stack.push(start)
    nearBlack[start] = 0
    while (stack.length) {
      const p = stack.pop()!
      const x = p % width
      const y = (p - x) / width
      areaPx++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && nearBlack[p - 1]) { nearBlack[p - 1] = 0; stack.push(p - 1) }
      if (x < width - 1 && nearBlack[p + 1]) { nearBlack[p + 1] = 0; stack.push(p + 1) }
      if (y > 0 && nearBlack[p - width]) { nearBlack[p - width] = 0; stack.push(p - width) }
      if (y < height - 1 && nearBlack[p + width]) { nearBlack[p + width] = 0; stack.push(p + width) }
    }
    const bboxWidth = maxX - minX + 1
    const bboxHeight = maxY - minY + 1
    if (areaPx < minArea) continue
    if (Math.min(bboxWidth, bboxHeight) < COMPONENT_MIN_EDGE) continue
    const bboxFillRatio = areaPx / (bboxWidth * bboxHeight)
    if (bboxFillRatio < COMPONENT_BBOX_FILL_MIN) continue
    components.push({ bounds: { x: minX, y: minY, width: bboxWidth, height: bboxHeight }, areaPx, bboxFillRatio })
  }
  return components
}

/** 纯函数：bounds a 与 b 的交叠面积占 a 面积的比例（in-mask 组件跳过判定用）。 */
export const overlapRatioOf = (a: ImageMaskBounds, b: ImageMaskBounds): number => {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const areaA = Math.max(1, a.width * a.height)
  return (ix * iy) / areaA
}

/** 黑块主入口（检测扩面）：
 *  ① 保留现有 maskBounds plate 判定（reason='current-mask-black-plate'）；
 *  ② 历史洞区（priorMaskBoundsPx，上次编辑的 mask 区映射到当前源图空间）按同一
 *     plate 规则高优先检测 —— 用户黑块高度疑似落在上次编辑洞区；
 *  ③ 全图近黑连通组件：面积 >= max(900, resultPixels*0.002)、bbox 最小边 >=24、
 *     bbox 填充率 >=0.35 的组件，回映射 source 同区域 —— source 黑占比 >=0.3 视为
 *     源本黑忽略；与当前 mask 区重叠 >=50% 视为本次编辑内容跳过。
 *  解码失败 → 保守返回 hasArtifact:false（不误触发自愈）。 */
export const inspectMaskResultForBlackArtifacts = async (
  input: MaskArtifactInput,
  sources: MaskInspectionSources,
): Promise<MaskArtifactInspection> => {
  try {
    const resultImageData = await readResultImageData(sources.resultB64)
    const resultSizePx = { width: resultImageData.width, height: resultImageData.height }

    let sourceImageData: ImageData | undefined
    const getSourceImageData = async () => {
      if (!sourceImageData) sourceImageData = await readSourceImageData(sources.sourceBlob)
      return sourceImageData
    }
    const sourceBlackRatioAt = async (sourceBounds: ImageMaskBounds) => {
      const source = await getSourceImageData()
      return blackRatioInRegion(source.data, { width: source.width, height: source.height }, sourceBounds).ratio
    }

    // ① 当前 mask 区 plate 判定（保留现有语义）
    if (input.maskBoundsPx) {
      const resultBounds = mapBoundsToResultSpace(input.maskBoundsPx, input.sourceSizePx, resultSizePx)
      const resultBlack = blackRatioInRegion(resultImageData.data, resultSizePx, resultBounds)
      if (resultBlack.ratio >= BLACK_RATIO_THRESHOLD) {
        const sourceRatio = await sourceBlackRatioAt(input.maskBoundsPx)
        if (judgeBlackPlate(resultBlack.ratio, sourceRatio)) {
          return {
            hasArtifact: true,
            reason: 'current-mask-black-plate',
            components: [{
              bounds: resultBounds,
              areaPx: Math.round(resultBounds.width * resultBounds.height * resultBlack.ratio),
              bboxFillRatio: resultBlack.ratio,
              sourceBlackRatio: sourceRatio,
            }],
          }
        }
      }
    }

    // ② 历史洞区高优先检测（同 plate 规则）
    for (const prior of input.priorMaskBoundsPx ?? []) {
      const resultBounds = mapBoundsToResultSpace(prior, input.sourceSizePx, resultSizePx)
      const resultBlack = blackRatioInRegion(resultImageData.data, resultSizePx, resultBounds)
      if (resultBlack.ratio < BLACK_RATIO_THRESHOLD) continue
      const sourceRatio = await sourceBlackRatioAt(prior)
      if (judgeBlackPlate(resultBlack.ratio, sourceRatio)) {
        return {
          hasArtifact: true,
          reason: 'out-of-mask-new-black-component',
          components: [{
            bounds: resultBounds,
            areaPx: Math.round(resultBounds.width * resultBounds.height * resultBlack.ratio),
            bboxFillRatio: resultBlack.ratio,
            sourceBlackRatio: sourceRatio,
          }],
        }
      }
    }

    // ③ 全图近黑连通组件
    const candidates = findNearBlackComponents(resultImageData.data, resultSizePx)
    if (candidates.length > 0) {
      const maskResultBounds = input.maskBoundsPx
        ? mapBoundsToResultSpace(input.maskBoundsPx, input.sourceSizePx, resultSizePx)
        : undefined
      const offenders: MaskArtifactComponent[] = []
      for (const candidate of candidates) {
        if (maskResultBounds && overlapRatioOf(candidate.bounds, maskResultBounds) >= IN_MASK_OVERLAP_SKIP) continue
        // mapBoundsToResultSpace 是纯等比缩放，交换 size 参数即得逆映射 result→source。
        const sourceBounds = mapBoundsToResultSpace(candidate.bounds, resultSizePx, input.sourceSizePx)
        const sourceRatio = await sourceBlackRatioAt(sourceBounds)
        if (sourceRatio >= SOURCE_BLACK_RATIO_MAX) continue // 源本黑，忽略
        offenders.push({ ...candidate, sourceBlackRatio: sourceRatio })
      }
      if (offenders.length > 0) {
        return { hasArtifact: true, reason: 'out-of-mask-new-black-component', components: offenders }
      }
    }

    return { hasArtifact: false, components: [] }
  } catch {
    // 解码失败 → 保守不判黑块，让正常失败路径处理
    return { hasArtifact: false, components: [] }
  }
}

/** 主入口：检测结果图是否为黑盘。
 *  true = 应触发 self-heal 重试；false = 正常或无法判定（保守不重试）。 */
export const inspectMaskResultForBlackPlate = async (
  input: MaskInspectionInput,
  sources: MaskInspectionSources,
): Promise<boolean> => {
  try {
    const resultImageData = await readResultImageData(sources.resultB64)
    const resultSizePx = { width: resultImageData.width, height: resultImageData.height }
    const resultBounds = mapBoundsToResultSpace(input.maskBoundsPx, input.sourceSizePx, resultSizePx)
    const resultBlack = blackRatioInRegion(resultImageData.data, resultSizePx, resultBounds)
    if (resultBlack.ratio < BLACK_RATIO_THRESHOLD) return false

    const sourceImageData = await readSourceImageData(sources.sourceBlob)
    const sourceBlack = blackRatioInRegion(
      sourceImageData.data,
      { width: sourceImageData.width, height: sourceImageData.height },
      input.maskBoundsPx,
    )
    return judgeBlackPlate(resultBlack.ratio, sourceBlack.ratio)
  } catch {
    // 解码失败 → 保守不重试，让正常失败路径处理
    return false
  }
}
