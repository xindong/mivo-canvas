import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { brushCursorCssFor } from './brushCursors'
import {
  brushOutlinePathFor,
  brushRenderWidthFor,
  brushStrokeOptionsFor,
  brushWidthPresets,
  eraserHitStrokeIds,
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

describe('eraserHitStrokeIds', () => {
  const brushNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
    id: 'brush-1',
    type: 'markup',
    title: 'Brush annotation',
    x: 100,
    y: 100,
    width: 100,
    height: 50,
    status: 'ready',
    markupKind: 'brush',
    markupStrokeWidth: 4,
    markupPoints: [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ],
    ...overrides,
  })

  it('hits a stroke whose segment passes within the eraser circle', () => {
    expect(eraserHitStrokeIds([brushNode()], { x: 150, y: 128 }, 10)).toEqual(['brush-1'])
  })

  it('misses points far away from every segment', () => {
    expect(eraserHitStrokeIds([brushNode()], { x: 150, y: 180 }, 10)).toEqual([])
    expect(eraserHitStrokeIds([brushNode()], { x: 400, y: 400 }, 10)).toEqual([])
  })

  it('ignores hidden strokes and non-brush markup', () => {
    const hidden = brushNode({ id: 'hidden', hidden: true })
    const rect = brushNode({ id: 'rect', markupKind: 'rect' })
    const image = brushNode({ id: 'image', type: 'image', markupKind: undefined })

    expect(eraserHitStrokeIds([hidden, rect, image], { x: 150, y: 125 }, 10)).toEqual([])
  })

  it('expands the hit area for wider highlighter strokes', () => {
    const wide = brushNode({ id: 'wide', markupBrushKind: 'highlighter', markupStrokeWidth: 8 })
    const point = { x: 150, y: 140 }

    expect(eraserHitStrokeIds([brushNode()], point, 2)).toEqual([])
    expect(eraserHitStrokeIds([wide], point, 2)).toEqual(['wide'])
  })
})

describe('brushCursorCssFor', () => {
  it('embeds the picked color into marker and highlighter cursors', () => {
    const cursor = brushCursorCssFor('marker', '#ff8a00')

    expect(cursor).toContain('data:image/svg+xml')
    expect(cursor).toContain(encodeURIComponent('#ff8a00'))
    expect(cursor.endsWith(', crosshair')).toBe(true)
  })

  it('keeps the eraser cursor color fixed regardless of brush color', () => {
    const cursor = brushCursorCssFor('eraser', '#ff8a00')

    expect(cursor).not.toContain(encodeURIComponent('#ff8a00'))
    expect(cursor).toContain('data:image/svg+xml')
  })

  it('renders a distinct cursor per tool mode', () => {
    const color = '#232323'
    const cursors = new Set([
      brushCursorCssFor('marker', color),
      brushCursorCssFor('highlighter', color),
      brushCursorCssFor('eraser', color),
    ])

    expect(cursors.size).toBe(3)
  })
})
