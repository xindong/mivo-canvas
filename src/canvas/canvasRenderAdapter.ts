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

// R02 (commit #3): the three helpers no longer normalize internally — each exported
// function below normalizes exactly once and passes the already-normalized node in.
// Before this change, frameRenderStyleFor / markupRenderStyleFor each called
// firstSolidFillFor + firstStrokeFor (2 normalizes) + transformFor (1) = up to 3
// normalizes per node per frame. With the R01 fast path, normalize on a store node is
// an O(1) predicate that returns the same reference — but collapsing to one call still
// removes the redundant predicate passes and makes the cost obvious in profiles.
const firstSolidFillOf = (n: MivoCanvasNode) => n.fills?.find(isVisibleSolidFill)

const firstStrokeOf = (n: MivoCanvasNode) => n.strokes?.find(visibleStroke)

const transformOf = (n: MivoCanvasNode) =>
  n.transform || {
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    rotation: 0,
  }

export const nodeRenderBoxFor = (node: MivoCanvasNode): NodeRenderBox => {
  // defensive normalize once — store nodes are already normalized (R01 fast path makes
  // this an O(1) same-ref return), but external callers may pass legacy-shaped nodes.
  const transform = transformOf(normalizeCanvasNodeV2(node))
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
  const n = normalizeCanvasNodeV2(node) // exactly one normalize per call
  const fill = firstSolidFillOf(n)
  const stroke = firstStrokeOf(n)

  return {
    '--section-fill-color': fill?.color || node.sectionFillColor || '#ffffff',
    '--section-border-color': stroke?.color || node.sectionBorderColor || node.frameColor || '#ff8a00',
    '--section-border-width': `${stroke?.width ?? node.sectionBorderWidth ?? 2}px`,
    '--section-border-style': stroke?.style || node.sectionBorderStyle || 'dashed',
  }
}

export const markupRenderStyleFor = (node: MivoCanvasNode): MarkupRenderStyle => {
  const n = normalizeCanvasNodeV2(node) // exactly one normalize per call
  const fill = firstSolidFillOf(n)
  const stroke = firstStrokeOf(n)

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
