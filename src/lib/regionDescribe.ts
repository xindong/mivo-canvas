// src/lib/regionDescribe.ts
// 局部重绘「锚点识别 + Set-of-Mark 标注图」前端能力。被 ImageMaskEditOverlay 消费:
// - cropRegionBlob:裁出选区(+上下文边距)给识别端点;点选锚点时在 marker 处叠红环。
// - anchorContextBlob:全图缩略(红环标锚点位置),双图识别的全局 context 图。
// - buildAnchorMarkedImage:全分辨率副本上把所有选区用红描边 + 序号画出,发给图像模型
//   的 Set-of-Mark 标注图(图2)。失败静默退回纯文字定位,不阻塞提交。
// - describeRegionCrop:调 /api/mivo/describe-region 拿候选标签。识别是提示,任何失败
//   一律返回 [] 永不阻塞出图。
//
// 红色取 overlay 标记红(#ff2d2d,见 App.css .image-mask-edit-region)保持一致;
// 线宽/圆环半径随图像尺寸按比例缩放,大图上不写死小像素(否则看不见)。
import { debugLogger } from '../store/debugLogStore'
import { authHeaders } from './authHeaders'
import type { ImageMaskBounds, ImageMaskPoint } from '../canvas/imageMaskGeometry'

/** 端点返回的候选标签(由粗到细,末位为最具体部位)。scope: whole=整体主体 / part=具体部位。 */
export type RegionCandidate = { label: string; scope: 'whole' | 'part' }

/**
 * Set-of-Mark 标注形状(坐标均为原图自然像素空间)。n = 1-based 序号,与画布 pin /
 * 输入框标签块序号一一对应。bounds/points 复用 imageMaskGeometry 的几何类型,不重定义。
 */
export type MarkedShape =
  | { kind: 'point'; x: number; y: number; n: number }
  | { kind: 'rect'; bounds: ImageMaskBounds; n: number }
  | { kind: 'ellipse'; bounds: ImageMaskBounds; n: number }
  | { kind: 'loop'; points: ImageMaskPoint[]; n: number }

const ANCHOR_RED = '#ff2d2d'

/** 线宽随图像尺寸按比例缩放(大图上写死 2px 看不见);下限 2px。 */
const markerStrokeFor = (size: { width: number; height: number }) =>
  Math.max(2, Math.round(Math.min(size.width, size.height) * 0.004))

/** 圆环半径随图像尺寸按比例缩放;下限 8px。 */
const ringRadiusFor = (size: { width: number; height: number }) =>
  Math.max(8, Math.round(Math.min(size.width, size.height) * 0.018))

/**
 * 加载原图为 ImageBitmap。走 fetch+blob+createImageBitmap:blob 是同源数据,画进 canvas
 * 不被跨源 taint(toBlob 安全),且 fetch 的 signal 在请求阶段即可干净中止。失败/中止
 * 返回 null,不 throw。buildAnchorMarkedImage 无 signal 参数(提交时一次性),signal 可选。
 */
const loadBitmap = async (url: string, signal?: AbortSignal): Promise<ImageBitmap | null> => {
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const blob = await response.blob()
    if (!blob.size || !blob.type.startsWith('image/')) return null
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

/** canvas + 2d context 工厂;getContext 失败返回 null。 */
const createCanvas = (
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  return ctx ? { canvas, ctx } : null
}

/** 画红色空心圆环(marker 锚点位置)。 */
const drawRing = (ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, lineWidth: number): void => {
  ctx.beginPath()
  ctx.strokeStyle = ANCHOR_RED
  ctx.lineWidth = lineWidth
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.stroke()
}

/** 画序号徽标:白字红底小圆(清晰可读即可)。 */
const drawBadge = (ctx: CanvasRenderingContext2D, x: number, y: number, n: number, radius: number): void => {
  ctx.beginPath()
  ctx.fillStyle = ANCHOR_RED
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(radius * 1.1)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(n), x, y)
}

const toBlobPng = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })

/**
 * 裁出 bounds(+ 各向外扩 ~25% 上下文边距,夹在图内)的局部图;有 marker(点选锚点)时
 * 在 marker 处叠红色空心圆环。输出 png blob。失败/中止返回 null,不 throw。
 */
export const cropRegionBlob = async (
  resolvedAssetUrl: string,
  naturalSize: { width: number; height: number },
  bounds: ImageMaskBounds,
  signal: AbortSignal,
  marker?: { x: number; y: number },
): Promise<Blob | null> => {
  const bitmap = await loadBitmap(resolvedAssetUrl, signal)
  if (!bitmap) {
    debugLogger.warn('Mask Edit', 'cropRegionBlob 原图加载失败,识别裁片回退 null')
    return null
  }
  try {
    const { width: natW, height: natH } = naturalSize
    // 向外扩 25% 上下文,夹在图内,给识别端点更多周边信息(避免裁太紧认错归属)。
    const expandX = bounds.width * 0.25
    const expandY = bounds.height * 0.25
    const sx = Math.max(0, Math.min(natW, bounds.x - expandX))
    const sy = Math.max(0, Math.min(natH, bounds.y - expandY))
    const ex = Math.min(natW, bounds.x + bounds.width + expandX)
    const ey = Math.min(natH, bounds.y + bounds.height + expandY)
    const sw = Math.max(1, ex - sx)
    const sh = Math.max(1, ey - sy)
    const scene = createCanvas(sw, sh)
    if (!scene) return null
    const { canvas, ctx } = scene
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    if (marker) {
      const lw = markerStrokeFor({ width: sw, height: sh })
      const r = ringRadiusFor({ width: sw, height: sh })
      drawRing(ctx, marker.x - sx, marker.y - sy, r, lw)
    }
    return await toBlobPng(canvas)
  } catch (error) {
    // 降级契约:绘制/导出主体任意异常(解码后 drawImage 失败、toBlob 失败等)静默回退
    // null,不阻塞提交(调用方退回纯文字定位)。bitmap.close() 仍在 finally 执行。
    debugLogger.warn('Mask Edit', `cropRegionBlob 绘制/导出失败: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * 全图缩略(长边限 ~768px 省带宽)+ marker 处红环。双图识别的全局 context 图
 * (完整原图红圈标锚点位置,给端点判断锚点属于什么整体/物件)。失败返回 null。
 */
export const anchorContextBlob = async (
  resolvedAssetUrl: string,
  naturalSize: { width: number; height: number },
  marker: { x: number; y: number },
  signal: AbortSignal,
): Promise<Blob | null> => {
  const bitmap = await loadBitmap(resolvedAssetUrl, signal)
  if (!bitmap) {
    debugLogger.warn('Mask Edit', 'anchorContextBlob 原图加载失败,context 图回退 null')
    return null
  }
  try {
    const { width: natW, height: natH } = naturalSize
    const longEdge = Math.max(natW, natH)
    const scale = longEdge > 768 ? 768 / longEdge : 1
    const dw = Math.max(1, Math.round(natW * scale))
    const dh = Math.max(1, Math.round(natH * scale))
    const scene = createCanvas(dw, dh)
    if (!scene) return null
    const { canvas, ctx } = scene
    ctx.drawImage(bitmap, 0, 0, dw, dh)
    const lw = markerStrokeFor({ width: dw, height: dh })
    const r = ringRadiusFor({ width: dw, height: dh })
    drawRing(ctx, marker.x * scale, marker.y * scale, r, lw)
    return await toBlobPng(canvas)
  } catch (error) {
    debugLogger.warn('Mask Edit', `anchorContextBlob 绘制/导出失败: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * 全分辨率图副本上把所有 shape 用红色描边画出:point=空心圆环、rect=红框、
 * ellipse=红椭圆、loop=闭合红色折线;每个 shape 旁画序号 n(白字红底小圆)。这张是
 * 发给图像模型的 Set-of-Mark 标注图(图2)。失败返回 null(调用方静默退回纯文字定位,
 * 不阻塞提交)。无 signal 参数:提交时一次性,不可中止。
 */
export const buildAnchorMarkedImage = async (
  resolvedAssetUrl: string,
  naturalSize: { width: number; height: number },
  shapes: MarkedShape[],
): Promise<Blob | null> => {
  const bitmap = await loadBitmap(resolvedAssetUrl)
  if (!bitmap) {
    debugLogger.warn('Mask Edit', 'buildAnchorMarkedImage 原图加载失败,标注图回退 null(退回纯文字定位)')
    return null
  }
  try {
    const { width: natW, height: natH } = naturalSize
    const scene = createCanvas(natW, natH)
    if (!scene) return null
    const { canvas, ctx } = scene
    ctx.drawImage(bitmap, 0, 0, natW, natH)
    const lw = markerStrokeFor(naturalSize)
    const r = ringRadiusFor(naturalSize)
    for (const shape of shapes) {
      if (shape.kind === 'point') {
        drawRing(ctx, shape.x, shape.y, r, lw)
        drawBadge(ctx, shape.x, shape.y - r - lw, shape.n, r)
      } else if (shape.kind === 'rect') {
        const { x, y, width, height } = shape.bounds
        ctx.strokeStyle = ANCHOR_RED
        ctx.lineWidth = lw
        ctx.strokeRect(x, y, width, height)
        drawBadge(ctx, x, y, shape.n, r)
      } else if (shape.kind === 'ellipse') {
        const { x, y, width, height } = shape.bounds
        ctx.beginPath()
        ctx.strokeStyle = ANCHOR_RED
        ctx.lineWidth = lw
        ctx.ellipse(x + width / 2, y + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2)
        ctx.stroke()
        drawBadge(ctx, x, y, shape.n, r)
      } else {
        // loop:闭合红色折线(首尾自动闭合)。
        const pts = shape.points
        if (pts.length < 2) continue
        ctx.beginPath()
        ctx.strokeStyle = ANCHOR_RED
        ctx.lineWidth = lw
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.closePath()
        ctx.stroke()
        const minX = Math.min(...pts.map((p) => p.x))
        const minY = Math.min(...pts.map((p) => p.y))
        drawBadge(ctx, minX, minY, shape.n, r)
      }
    }
    return await toBlobPng(canvas)
  } catch (error) {
    debugLogger.warn('Mask Edit', `buildAnchorMarkedImage 绘制/导出失败: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * 调 /api/mivo/describe-region:POST multipart(crop 必、context 可选)→ 候选标签数组。
 * 成功解析返回 candidates;非 2xx / 响应无 candidates / 解析失败 / 网络异常 / 中止
 * 一律返回 [] 不 throw(识别只是提示,永不阻塞出图)。
 */
export const describeRegionCrop = async (
  crop: Blob,
  signal: AbortSignal,
  contextImage?: Blob | null,
): Promise<RegionCandidate[]> => {
  try {
    const form = new FormData()
    form.append('crop', crop, 'crop.png')
    if (contextImage) form.append('context', contextImage, 'context.png')
    const response = await fetch('/api/mivo/describe-region', { method: 'POST', headers: authHeaders(), body: form, signal })
    if (!response.ok) {
      debugLogger.warn('Mask Edit', `describe-region 非 2xx(${response.status}),识别回退 []`)
      return []
    }
    const payload = (await response.json()) as { candidates?: unknown }
    if (!Array.isArray(payload.candidates)) {
      debugLogger.warn('Mask Edit', 'describe-region 响应无 candidates 数组,识别回退 []')
      return []
    }
    const list = payload.candidates
      .map((item): RegionCandidate | null => {
        if (!item || typeof item !== 'object') return null
        const rec = item as { label?: unknown; scope?: unknown }
        const label = typeof rec.label === 'string' ? rec.label.trim() : ''
        if (!label) return null
        const scope = rec.scope === 'whole' ? 'whole' : 'part'
        return { label, scope }
      })
      .filter((c): c is RegionCandidate => Boolean(c))
    debugLogger.log('Mask Edit', `describe-region 识别到 ${list.length} 个候选`)
    return list
  } catch {
    debugLogger.warn('Mask Edit', 'describe-region 请求失败/中止,识别回退 []')
    return []
  }
}
