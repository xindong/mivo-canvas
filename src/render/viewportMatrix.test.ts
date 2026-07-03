import { describe, expect, it } from 'vitest'
import {
  applyMatrix,
  canvasToContainer,
  canvasToScreen,
  containerToCanvas,
  createViewportMatrix,
  invertMatrix,
  screenToCanvas,
  type Viewport,
  type ViewportRect,
} from './viewportMatrix'

// Reference rect: 1920×1080 CSS px window at origin (DPR 1 baseline).
const rectAtOrigin: ViewportRect = { left: 0, top: 0, width: 1920, height: 1080 }
// DPR 2 equivalent: same physical window is 960×540 CSS px (rect dims shrink).
// Viewport math must be DPR-agnostic because getBoundingClientRect returns CSS px.
const rectDpr2: ViewportRect = { left: 0, top: 0, width: 960, height: 540 }
// Shifted rect (canvas host not at window origin, e.g. sidebar present).
const rectShifted: ViewportRect = { left: 240, top: 64, width: 1440, height: 900 }

const identityViewport: Viewport = { x: 0, y: 0, scale: 1 }
const pannedViewport: Viewport = { x: -420, y: 180, scale: 1 }

const ZOOMS = [0.1, 0.5, 1, 2, 4]
const RECTS: Array<[string, ViewportRect]> = [
  ['dpr1-origin', rectAtOrigin],
  ['dpr2-origin', rectDpr2],
  ['dpr1-shifted', rectShifted],
]

describe('createViewportMatrix', () => {
  it('canvas→screen = canvas*scale + (viewport + rect origin)', () => {
    const m = createViewportMatrix({ x: 100, y: 200, scale: 2 }, rectShifted)
    // canvas (5, 10) → 5*2 + (100+240) = 350, 10*2 + (200+64) = 284
    expect(applyMatrix(m, 5, 10)).toEqual({ x: 350, y: 284 })
  })
})

describe('invertMatrix', () => {
  it('is a true inverse of applyMatrix at any zoom/pan/rect', () => {
    for (const [, rect] of RECTS) {
      for (const scale of ZOOMS) {
        const viewport: Viewport = { x: -300, y: 250, scale }
        const m = createViewportMatrix(viewport, rect)
        const inv = invertMatrix(m)
        const canvasPoint = { x: 4321.5, y: -6789.25 }
        const screen = applyMatrix(m, canvasPoint.x, canvasPoint.y)
        const back = applyMatrix(inv, screen.x, screen.y)
        expect(back.x).toBeCloseTo(canvasPoint.x, 9)
        expect(back.y).toBeCloseTo(canvasPoint.y, 9)
      }
    }
  })
})

describe('screenToCanvas / canvasToScreen round-trip', () => {
  it.each(ZOOMS)('round-trips at zoom=%s with pan + identity rect', (scale) => {
    const viewport: Viewport = { x: -500, y: 333, scale }
    const canvasPoint = { x: 1234.5, y: -987.6 }
    const screen = canvasToScreen(rectAtOrigin, viewport, canvasPoint.x, canvasPoint.y)
    const back = screenToCanvas(rectAtOrigin, viewport, screen.x, screen.y)
    expect(back.x).toBeCloseTo(canvasPoint.x, 9)
    expect(back.y).toBeCloseTo(canvasPoint.y, 9)
  })

  it('round-trips across the full zoom × rect matrix (DPR 1/2 + shifted)', () => {
    for (const [, rect] of RECTS) {
      for (const scale of ZOOMS) {
        const viewport: Viewport = { x: -120, y: 88, scale }
        const canvasPoint = { x: 7777.7, y: -5555.5 }
        const screen = canvasToScreen(rect, viewport, canvasPoint.x, canvasPoint.y)
        const back = screenToCanvas(rect, viewport, screen.x, screen.y)
        expect(back.x).toBeCloseTo(canvasPoint.x, 9)
        expect(back.y).toBeCloseTo(canvasPoint.y, 9)
      }
    }
  })

  it('matches the legacy clientPointToCanvas formula (bit-for-bit)', () => {
    // Legacy: canvas = (client - rect.left - viewport.x) / viewport.scale
    const viewport = pannedViewport
    const rect = rectShifted
    const clientX = 915.4
    const clientY = 207.1
    const expected = {
      x: (clientX - rect.left - viewport.x) / viewport.scale,
      y: (clientY - rect.top - viewport.y) / viewport.scale,
    }
    expect(screenToCanvas(rect, viewport, clientX, clientY)).toEqual(expected)
  })
})

describe('canvasToContainer / containerToCanvas (intra-layer offset)', () => {
  it('is independent of rect origin (container-local space)', () => {
    const viewport: Viewport = { x: -50, y: 25, scale: 1.5 }
    const canvasPoint = { x: 100, y: 200 }
    const container = canvasToContainer(viewport, canvasPoint.x, canvasPoint.y)
    // = canvas*scale + viewport (no rect)
    expect(container).toEqual({ x: 100 * 1.5 - 50, y: 200 * 1.5 + 25 })
    // round-trip
    const back = containerToCanvas(viewport, container.x, container.y)
    expect(back.x).toBeCloseTo(canvasPoint.x, 9)
    expect(back.y).toBeCloseTo(canvasPoint.y, 9)
  })

  it('canvasToScreen - rect origin == canvasToContainer', () => {
    const viewport: Viewport = { x: 30, y: -40, scale: 0.8 }
    const rect = rectShifted
    const canvasPoint = { x: 500, y: -300 }
    const screen = canvasToScreen(rect, viewport, canvasPoint.x, canvasPoint.y)
    const container = canvasToContainer(viewport, canvasPoint.x, canvasPoint.y)
    expect(container.x).toBeCloseTo(screen.x - rect.left, 9)
    expect(container.y).toBeCloseTo(screen.y - rect.top, 9)
  })
})

describe('undefined rect fallback', () => {
  it('screenToCanvas returns origin when rect is undefined (matches clientPointToCanvas)', () => {
    expect(screenToCanvas(undefined, identityViewport, 100, 200)).toEqual({ x: 0, y: 0 })
    expect(canvasToScreen(undefined, identityViewport, 100, 200)).toEqual({ x: 0, y: 0 })
  })
})
