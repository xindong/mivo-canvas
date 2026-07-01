import type { CSSProperties } from 'react'
import type {
  CanvasNodeFill,
  CanvasNodeSolidFill,
  CanvasNodeStroke,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from './textGeometry'

export type NodeRenderBox = Pick<CSSProperties, 'width' | 'height' | 'transform' | 'transformOrigin'>

export type FrameRenderStyle = CSSProperties & {
  '--section-fill-color': string
  '--section-border-color': string
  '--section-border-width': string
  '--section-border-style': string
}

export type MarkupRenderStyle = {
  fill: string
  stroke: string
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed'
  strokeOpacity: number
}

const isVisibleSolidFill = (fill: CanvasNodeFill): fill is CanvasNodeSolidFill =>
  fill.kind === 'solid' && fill.visible

const visibleStroke = (stroke: CanvasNodeStroke) => stroke.visible

const firstSolidFillFor = (node: MivoCanvasNode) => normalizeCanvasNodeV2(node).fills?.find(isVisibleSolidFill)

const firstStrokeFor = (node: MivoCanvasNode) => normalizeCanvasNodeV2(node).strokes?.find(visibleStroke)

const transformFor = (node: MivoCanvasNode) => normalizeCanvasNodeV2(node).transform || {
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
  rotation: 0,
}

export const nodeRenderBoxFor = (node: MivoCanvasNode): NodeRenderBox => {
  const transform = transformFor(node)
  const translate = `translate(${transform.x}px, ${transform.y}px)`
  const rotate = transform.rotation ? ` rotate(${transform.rotation}deg)` : ''

  return {
    width: transform.width,
    height: transform.height,
    transform: `${translate}${rotate}`,
    transformOrigin: '50% 50%',
  }
}

export const frameRenderStyleFor = (node: MivoCanvasNode): FrameRenderStyle => {
  const fill = firstSolidFillFor(node)
  const stroke = firstStrokeFor(node)

  return {
    '--section-fill-color': fill?.color || node.sectionFillColor || '#ffffff',
    '--section-border-color': stroke?.color || node.sectionBorderColor || node.frameColor || '#ff8a00',
    '--section-border-width': `${stroke?.width ?? node.sectionBorderWidth ?? 2}px`,
    '--section-border-style': stroke?.style || node.sectionBorderStyle || 'dashed',
  }
}

export const markupRenderStyleFor = (node: MivoCanvasNode): MarkupRenderStyle => {
  const fill = firstSolidFillFor(node)
  const stroke = firstStrokeFor(node)

  return {
    fill: fill?.color || node.markupFillColor || 'rgba(105, 87, 232, 0.08)',
    stroke: stroke?.color || node.markupStrokeColor || '#6957e8',
    strokeWidth: stroke?.width ?? node.markupStrokeWidth ?? 3,
    strokeStyle: stroke?.style || node.markupStrokeStyle || 'solid',
    strokeOpacity: stroke?.opacity ?? node.markupOpacity ?? 1,
  }
}

export const textRenderStyleFor = (node: MivoCanvasNode): CSSProperties => ({
  fontSize: node.fontSize || defaultTextFontSize,
  color: node.textColor || defaultTextColor,
  fontWeight: node.fontWeight || defaultTextWeight,
  textAlign: node.textAlign || defaultTextAlign,
})
