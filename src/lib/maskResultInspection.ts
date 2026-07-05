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
