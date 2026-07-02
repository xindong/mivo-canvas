import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { MarkupBrushKind, MarkupPoint } from '../types/mivoCanvas'

export type BrushWidthPresetId = 'thin' | 'medium' | 'bold'

export type BrushWidthPreset = {
  id: BrushWidthPresetId
  label: string
  width: number
}

export const brushWidthPresets: BrushWidthPreset[] = [
  { id: 'thin', label: 'Thin', width: 2 },
  { id: 'medium', label: 'Medium', width: 4 },
  { id: 'bold', label: 'Bold', width: 8 },
]

export const defaultBrushWidth = 4
export const highlighterWidthMultiplier = 3
export const highlighterOpacity = 0.42

export const brushRenderWidthFor = (strokeWidth: number, brushKind: MarkupBrushKind) =>
  Math.max(2, strokeWidth) * (brushKind === 'highlighter' ? highlighterWidthMultiplier : 1)

/**
 * Stroke options tuned to the values Excalidraw ships for perfect-freehand
 * (thinning 0.6 / smoothing 0.5 / streamline 0.5). Highlighters use zero
 * thinning so the band keeps a uniform marker-tip width, and pressure is only
 * simulated when no real pen pressure was recorded on the points.
 */
export const brushStrokeOptionsFor = (
  points: MarkupPoint[],
  strokeWidth: number,
  brushKind: MarkupBrushKind,
  options?: { last?: boolean },
): StrokeOptions => ({
  size: brushRenderWidthFor(strokeWidth, brushKind) * 2,
  thinning: brushKind === 'highlighter' ? 0 : 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: brushKind === 'marker' && !points.some((point) => point.pressure !== undefined),
  last: options?.last ?? true,
})

const averagePoint = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

/** Converts a perfect-freehand outline polygon into a closed SVG path (quadratic midpoint smoothing). */
export const svgPathFromStrokeOutline = (outline: number[][]) => {
  if (!outline.length) return ''

  const [first, ...rest] = outline
  const mid = averagePoint(first, rest[0] || first)
  let path = `M${first[0].toFixed(2)},${first[1].toFixed(2)} Q${first[0].toFixed(2)},${first[1].toFixed(2)} ${mid[0].toFixed(2)},${mid[1].toFixed(2)}`

  for (let index = 0; index < rest.length; index += 1) {
    const point = rest[index]
    const next = rest[index + 1] || first
    const middle = averagePoint(point, next)
    path += ` Q${point[0].toFixed(2)},${point[1].toFixed(2)} ${middle[0].toFixed(2)},${middle[1].toFixed(2)}`
  }

  return `${path} Z`
}

export const brushOutlinePathFor = (
  points: MarkupPoint[],
  strokeWidth: number,
  brushKind: MarkupBrushKind,
  options?: { last?: boolean },
) => {
  if (points.length < 2) return ''

  const strokeInput = points.map((point) => ({
    x: point.x,
    y: point.y,
    pressure: point.pressure ?? 0.5,
  }))

  return svgPathFromStrokeOutline(
    getStroke(strokeInput, brushStrokeOptionsFor(points, strokeWidth, brushKind, options)),
  )
}
