import { describe, expect, it } from 'vitest'
import {
  brushOutlinePathFor,
  brushRenderWidthFor,
  brushStrokeOptionsFor,
  brushWidthPresets,
  highlighterWidthMultiplier,
} from './brushGeometry'

const strokePoints = [
  { x: 0, y: 0 },
  { x: 24, y: 10 },
  { x: 48, y: 4 },
  { x: 80, y: 22 },
]

describe('brushStrokeOptionsFor', () => {
  it('uses Excalidraw-style thinning for markers and simulates pressure without pen input', () => {
    const options = brushStrokeOptionsFor(strokePoints, 4, 'marker')

    expect(options.thinning).toBe(0.6)
    expect(options.simulatePressure).toBe(true)
    expect(options.last).toBe(true)
  })

  it('keeps real pen pressure instead of simulating it', () => {
    const penPoints = strokePoints.map((point, index) => ({ ...point, pressure: 0.2 + index * 0.1 }))

    expect(brushStrokeOptionsFor(penPoints, 4, 'marker').simulatePressure).toBe(false)
  })

  it('renders highlighters as a wider uniform band', () => {
    const options = brushStrokeOptionsFor(strokePoints, 4, 'highlighter')

    expect(options.thinning).toBe(0)
    expect(options.size).toBe(brushRenderWidthFor(4, 'highlighter') * 2)
    expect(brushRenderWidthFor(4, 'highlighter')).toBe(4 * highlighterWidthMultiplier)
  })

  it('marks in-progress strokes as not final so the tail follows the pointer', () => {
    expect(brushStrokeOptionsFor(strokePoints, 4, 'marker', { last: false }).last).toBe(false)
  })
})

describe('brushOutlinePathFor', () => {
  it('produces a closed SVG path for a stroke', () => {
    const path = brushOutlinePathFor(strokePoints, 4, 'marker')

    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    expect(path).toContain('Q')
  })

  it('returns an empty path for degenerate strokes', () => {
    expect(brushOutlinePathFor([{ x: 4, y: 4 }], 4, 'marker')).toBe('')
    expect(brushOutlinePathFor([], 4, 'marker')).toBe('')
  })

  it('draws a wider outline for bolder width presets', () => {
    const boundsWidthOf = (path: string) => {
      const ys = [...path.matchAll(/[-\d.]+,([-\d.]+)/g)].map((match) => Number(match[1]))
      return Math.max(...ys) - Math.min(...ys)
    }

    const thin = boundsWidthOf(brushOutlinePathFor(strokePoints, brushWidthPresets[0].width, 'marker'))
    const bold = boundsWidthOf(brushOutlinePathFor(strokePoints, brushWidthPresets[2].width, 'marker'))

    expect(bold).toBeGreaterThan(thin)
  })
})
