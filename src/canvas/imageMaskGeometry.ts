import type { ImageCrop } from '../types/mivoCanvas'

export type ImageMaskPoint = {
  x: number
  y: number
}

export type ImageMaskRegion =
  | { type: 'box'; x: number; y: number; width: number; height: number }
  | { type: 'brush'; points: ImageMaskPoint[]; radius: number }

export type ImageMaskBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type ImageMaskSubmitPayload = {
  prompt: string
  mask?: Blob
  maskBounds?: ImageMaskBounds
  sourceSize: { width: number; height: number }
}

export const maxMaskCanvasPixels = 24_000_000
export const maxMaskCanvasEdge = 6000

export const validateMaskCanvasSize = (naturalSize: { width: number; height: number }) => {
  const width = Math.max(1, Math.round(naturalSize.width))
  const height = Math.max(1, Math.round(naturalSize.height))
  if (width > maxMaskCanvasEdge || height > maxMaskCanvasEdge || width * height > maxMaskCanvasPixels) {
    throw new Error(`图片尺寸 ${width} x ${height} 过大，局部重绘请先导入较低分辨率版本。`)
  }
}

type DisplayRectInput = {
  nodeWidth: number
  nodeHeight: number
  naturalWidth: number
  naturalHeight: number
  imageCrop?: ImageCrop
}

export const displayRectForImage = ({
  nodeWidth,
  nodeHeight,
  naturalWidth,
  naturalHeight,
  imageCrop,
}: DisplayRectInput): ImageMaskBounds => {
  if (imageCrop) {
    return { x: 0, y: 0, width: nodeWidth, height: nodeHeight }
  }

  const imageRatio = naturalWidth / Math.max(1, naturalHeight)
  const nodeRatio = nodeWidth / Math.max(1, nodeHeight)
  if (imageRatio > nodeRatio) {
    const height = nodeWidth / imageRatio
    return { x: 0, y: (nodeHeight - height) / 2, width: nodeWidth, height }
  }

  const width = nodeHeight * imageRatio
  return { x: (nodeWidth - width) / 2, y: 0, width, height: nodeHeight }
}

export const nodePointToImagePixel = (
  point: ImageMaskPoint,
  displayRect: ImageMaskBounds,
  naturalSize: { width: number; height: number },
  imageCrop?: ImageCrop,
): ImageMaskPoint | undefined => {
  if (
    point.x < displayRect.x ||
    point.y < displayRect.y ||
    point.x > displayRect.x + displayRect.width ||
    point.y > displayRect.y + displayRect.height
  ) {
    return undefined
  }

  const localX = (point.x - displayRect.x) / Math.max(1, displayRect.width)
  const localY = (point.y - displayRect.y) / Math.max(1, displayRect.height)
  const crop = imageCrop || { x: 0, y: 0, width: 1, height: 1 }

  return {
    x: Math.round((crop.x + localX * crop.width) * naturalSize.width),
    y: Math.round((crop.y + localY * crop.height) * naturalSize.height),
  }
}

export const imagePixelToNodePoint = (
  pixel: ImageMaskPoint,
  displayRect: ImageMaskBounds,
  naturalSize: { width: number; height: number },
  imageCrop?: ImageCrop,
): ImageMaskPoint => {
  const crop = imageCrop || { x: 0, y: 0, width: 1, height: 1 }
  const normalizedX = pixel.x / Math.max(1, naturalSize.width)
  const normalizedY = pixel.y / Math.max(1, naturalSize.height)

  return {
    x: displayRect.x + ((normalizedX - crop.x) / crop.width) * displayRect.width,
    y: displayRect.y + ((normalizedY - crop.y) / crop.height) * displayRect.height,
  }
}

const clampBounds = (bounds: ImageMaskBounds, naturalSize: { width: number; height: number }) => {
  const x = Math.max(0, Math.floor(bounds.x))
  const y = Math.max(0, Math.floor(bounds.y))
  const right = Math.min(naturalSize.width, Math.ceil(bounds.x + bounds.width))
  const bottom = Math.min(naturalSize.height, Math.ceil(bounds.y + bounds.height))

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  }
}

export const boundsForRegions = (
  regions: ImageMaskRegion[],
  naturalSize?: { width: number; height: number },
): ImageMaskBounds | undefined => {
  if (!regions.length) return undefined

  const bounds = regions.map((region): ImageMaskBounds | undefined => {
    if (region.type === 'box') return region
    if (!region.points.length) return undefined

    const minX = Math.min(...region.points.map((point) => point.x)) - region.radius
    const maxX = Math.max(...region.points.map((point) => point.x)) + region.radius
    const minY = Math.min(...region.points.map((point) => point.y)) - region.radius
    const maxY = Math.max(...region.points.map((point) => point.y)) + region.radius
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }).filter((bounds): bounds is ImageMaskBounds => Boolean(bounds))

  if (!bounds.length) return undefined

  const minX = Math.min(...bounds.map((bound) => bound.x))
  const minY = Math.min(...bounds.map((bound) => bound.y))
  const maxX = Math.max(...bounds.map((bound) => bound.x + bound.width))
  const maxY = Math.max(...bounds.map((bound) => bound.y + bound.height))
  const union = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  return naturalSize ? clampBounds(union, naturalSize) : union
}

const drawRegion = (context: CanvasRenderingContext2D, region: ImageMaskRegion) => {
  context.beginPath()
  if (region.type === 'box') {
    context.fillRect(region.x, region.y, region.width, region.height)
    return
  }
  if (!region.points.length) return

  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = region.radius * 2
  context.moveTo(region.points[0].x, region.points[0].y)
  region.points.slice(1).forEach((point) => context.lineTo(point.x, point.y))
  context.stroke()
  if (region.points.length === 1) {
    context.arc(region.points[0].x, region.points[0].y, region.radius, 0, Math.PI * 2)
    context.fill()
  }
}

export const buildEditMaskBlob = async ({
  naturalSize,
  regions,
}: {
  naturalSize: { width: number; height: number }
  imageCrop?: ImageCrop
  regions: ImageMaskRegion[]
}) => {
  validateMaskCanvasSize(naturalSize)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(naturalSize.width))
  canvas.height = Math.max(1, Math.round(naturalSize.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to create mask canvas')

  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalCompositeOperation = 'destination-out'
  context.fillStyle = '#000'
  context.strokeStyle = '#000'
  regions.forEach((region) => drawRegion(context, region))
  context.globalCompositeOperation = 'source-over'

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Unable to export mask PNG'))
    }, 'image/png')
  })
}
