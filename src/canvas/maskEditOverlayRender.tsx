// 从 ImageMaskEditOverlay 机械抽离(structure guard >900),行为不变。
// 渲染辅助:图像像素坐标 → 节点坐标的几何换算 + SVG 标记绘制。纯函数,
// 依赖通过参数进;renderPointMarker/renderRegionBadge 的 viewportScale 由
// overlay 调用点传入(原为组件内闭包捕获,抽离后参数化,行为不变)。
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  imagePixelToNodePoint,
  type ImageMaskPoint,
  type ImageMaskRegion,
  type PointAnchor,
} from './imageMaskGeometry'
import { MaskPointMarker } from './MaskPointIcon'

type DisplayRect = { x: number; y: number; width: number; height: number }
type NaturalSize = { width: number; height: number }

export const radiusToNode = (
  center: ImageMaskPoint,
  radius: number,
  displayRect: DisplayRect,
  naturalSize: NaturalSize,
  imageCrop: MivoCanvasNode['imageCrop'],
) => {
  const centerNode = imagePixelToNodePoint(center, displayRect, naturalSize, imageCrop)
  const edgeNode = imagePixelToNodePoint(
    { x: center.x + radius, y: center.y },
    displayRect,
    naturalSize,
    imageCrop,
  )
  return Math.max(4, Math.abs(edgeNode.x - centerNode.x))
}

export const regionPath = (
  region: ImageMaskRegion,
  displayRect: DisplayRect,
  naturalSize: NaturalSize,
  imageCrop: MivoCanvasNode['imageCrop'],
) => {
  if (region.type === 'box' || region.type === 'ellipse') {
    const start = imagePixelToNodePoint({ x: region.x, y: region.y }, displayRect, naturalSize, imageCrop)
    const end = imagePixelToNodePoint(
      { x: region.x + region.width, y: region.y + region.height },
      displayRect,
      naturalSize,
      imageCrop,
    )
    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    }
    return region.type === 'box' ? { kind: 'rect' as const, ...rect } : { kind: 'ellipse' as const, ...rect }
  }

  if (region.type === 'loop') {
    return {
      kind: 'loop' as const,
      points: region.points.map((point) => imagePixelToNodePoint(point, displayRect, naturalSize, imageCrop)),
    }
  }

  if (region.points.length === 1) {
    const center = imagePixelToNodePoint(region.points[0], displayRect, naturalSize, imageCrop)
    return {
      kind: 'point' as const,
      cx: center.x,
      cy: center.y,
      r: radiusToNode(region.points[0], region.radius, displayRect, naturalSize, imageCrop),
    }
  }

  return {
    kind: 'polyline' as const,
    points: region.points.map((point) => imagePixelToNodePoint(point, displayRect, naturalSize, imageCrop)),
    strokeWidth: radiusToNode(region.points[0], region.radius, displayRect, naturalSize, imageCrop) * 2,
  }
}

export const pointAnchorPath = (
  anchor: PointAnchor,
  displayRect: DisplayRect,
  naturalSize: NaturalSize,
  imageCrop: MivoCanvasNode['imageCrop'],
) => {
  const center = imagePixelToNodePoint(anchor.center, displayRect, naturalSize, imageCrop)
  return {
    cx: center.x,
    cy: center.y,
    r: radiusToNode(anchor.center, anchor.radius, displayRect, naturalSize, imageCrop),
  }
}

// 用户反馈:旧的「虚线大圆环 + 十字线」太大且表达不精准。锚点只保留一枚固定
// 屏幕尺寸的紫色实心坐标 pin,尖端精确落在点击坐标;半径圆环不再可视化,
// 但重绘区域几何(pointMaskRadiusFor / maskBounds)不变。
export const renderPointMarker = (
  center: ImageMaskPoint,
  index: string | number,
  viewportScale: number,
  badge?: number,
) => (
  <g key={`point-marker-${index}`} className="image-mask-edit-point-marker">
    <MaskPointMarker tipX={center.x} tipY={center.y} viewportScale={viewportScale} badge={badge} />
  </g>
)

// 框/椭圆/圈选区域的序号徽标(区域左上角,固定屏幕尺寸),与输入框标签序号对应。
export const renderRegionBadge = (
  x: number,
  y: number,
  n: number,
  index: string | number,
  viewportScale: number,
) => {
  const badgeRadius = 9 / Math.max(0.1, viewportScale)
  return (
    <g key={`region-badge-${index}`} className="image-mask-edit-region-badge">
      <circle cx={x} cy={y} r={badgeRadius} />
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={badgeRadius * 1.1}>
        {n}
      </text>
    </g>
  )
}
