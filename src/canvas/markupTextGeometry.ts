// markupTextGeometry — markup 文字层共享几何（FU-11，自 CanvasNodeView 抽出）。
//
// CanvasNodeView（dom 模式全渲染 + leafer 模式纯文字壳）与 leaferLinePaint
// （leafer 模式线体的 label 缺口）消费同一份 label 估宽 / 中点 / 分段数学，
// 保证 dom / leafer 两模式的线上 label 缺口逐像素一致（visual:diff
// --fixture=markup-text 的对齐前提）。纯函数，无渲染依赖。

import type { MivoCanvasNode } from '../types/mivoCanvas'
import { defaultTextAlign, defaultTextFontSize } from './textGeometry'

export type MarkupTextPoint = { x: number; y: number }

/** label 几何只读取这几个字段——MivoCanvasNode 与 projection RenderNode
 *  （geometry.width/height + text/fontSize 展平后）都结构性满足。 */
export type MarkupLabelBox = {
  width: number
  height: number
  text?: string
  fontSize?: number
}

export type LineSegmentWithGap = {
  start: MarkupTextPoint
  end: MarkupTextPoint
  markerEnd: boolean
}

export const isLineMarkup = (node: { markupKind?: string }): boolean =>
  node.markupKind === 'arrow' || node.markupKind === 'line'

export const markupTextAlignFor = (node: Pick<MivoCanvasNode, 'markupKind' | 'textAlign'>) =>
  node.textAlign || (node.markupKind === 'note' ? defaultTextAlign : 'center')

export const defaultMarkupPointsFor = (node: {
  markupKind?: string
  markupStrokeWidth?: number
  width: number
  height: number
}): MarkupTextPoint[] => {
  if (node.markupKind === 'arrow' || node.markupKind === 'line') {
    return [
      { x: Math.max(2, node.markupStrokeWidth || 3), y: Math.max(2, node.height - (node.markupStrokeWidth || 3)) },
      { x: Math.max(2, node.width - (node.markupStrokeWidth || 3)), y: Math.max(2, node.markupStrokeWidth || 3) },
    ]
  }

  if (node.markupKind === 'brush') {
    return [
      { x: 8, y: node.height * 0.6 },
      { x: node.width * 0.32, y: node.height * 0.25 },
      { x: node.width * 0.56, y: node.height * 0.68 },
      { x: node.width - 8, y: node.height * 0.3 },
    ]
  }

  return []
}

export const lineLabelPositionFor = (
  node: MarkupLabelBox,
  points: MarkupTextPoint[],
): MarkupTextPoint => {
  const start = points[0] || { x: 0, y: node.height }
  const end = points[1] || { x: node.width, y: 0 }

  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  }
}

export const estimatedMarkupLabelWidth = (text: string, fontSize: number): number => {
  const chars = Array.from(text || ' ')
  const rawWidth = chars.reduce((width, char) => {
    if (/[\u2e80-\u9fff\uf900-\ufaff]/.test(char)) return width + fontSize
    if (char === ' ') return width + fontSize * 0.35
    if (/[A-Z0-9]/.test(char)) return width + fontSize * 0.68
    return width + fontSize * 0.56
  }, 0)

  return Math.max(54, Math.min(360, rawWidth + 18))
}

export const lineSegmentsWithLabelGap = (
  node: MarkupLabelBox,
  points: MarkupTextPoint[],
  labelActive: boolean,
): LineSegmentWithGap[] => {
  const start = points[0] || { x: 0, y: node.height }
  const end = points[1] || { x: node.width, y: 0 }

  if (!labelActive) return [{ start, end, markerEnd: true }]

  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 1) return [{ start, end, markerEnd: true }]

  const labelWidth = estimatedMarkupLabelWidth(node.text || 'Label', node.fontSize || defaultTextFontSize)
  const gap = Math.min(length * 0.42, labelWidth / 2 + 10)
  const gapRatio = gap / length
  const beforeEnd = {
    x: start.x + dx * Math.max(0, 0.5 - gapRatio),
    y: start.y + dy * Math.max(0, 0.5 - gapRatio),
  }
  const afterStart = {
    x: start.x + dx * Math.min(1, 0.5 + gapRatio),
    y: start.y + dy * Math.min(1, 0.5 + gapRatio),
  }

  return [
    { start, end: beforeEnd, markerEnd: false },
    { start: afterStart, end, markerEnd: true },
  ]
}
