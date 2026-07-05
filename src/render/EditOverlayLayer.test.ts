import { describe, expect, it } from 'vitest'
import { toContainer, type Viewport } from './EditOverlayLayer'

describe('toContainer — canvas → screen for overlay children', () => {
  it('maps canvas coords → screen via cx*scale+vx, cy*scale+vy', () => {
    const vp: Viewport = { x: 100, y: 200, scale: 2 }
    expect(toContainer(vp, 10, 20)).toEqual({ x: 120, y: 240 })
  })

  it('scale 1 + zero translate = identity', () => {
    const vp: Viewport = { x: 0, y: 0, scale: 1 }
    expect(toContainer(vp, 5, 7)).toEqual({ x: 5, y: 7 })
  })

  it('matches the .dom-canvas-layer transform applied to a single point', () => {
    // .dom-canvas-layer style: translate(vx, vy) scale(s) → (cx*s+vx, cy*s+vy).
    // An overlay child at canvas (cx, cy) must land at the same screen point as
    // a DOM node at (cx, cy) inside .dom-canvas-layer.
    const vp: Viewport = { x: -40, y: 12, scale: 1.5 }
    const { x, y } = toContainer(vp, 8, 4)
    expect(x).toBeCloseTo(8 * 1.5 + -40)
    expect(y).toBeCloseTo(4 * 1.5 + 12)
  })

  it('handles negative viewport translate (panned up-left)', () => {
    const vp: Viewport = { x: -250, y: -300, scale: 0.5 }
    expect(toContainer(vp, 1000, 1000)).toEqual({ x: 250, y: 200 })
  })
})
