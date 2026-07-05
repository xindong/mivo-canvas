import { describe, expect, it } from 'vitest'
import { leaferHostOptions } from './useLeaferHost'
import hookSource from './useLeaferHost.ts?raw'

const makeStubHost = (width: number, height: number) => ({
  getBoundingClientRect: () => ({ width, height, x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, toJSON: () => '' }) as DOMRect,
})

describe('leaferHostOptions — D1 hittable:false + dimensions', () => {
  it('always sets hittable: false (D1: canvas must not consume pointer events)', () => {
    const opts = leaferHostOptions(makeStubHost(800, 600))
    expect(opts.hittable).toBe(false)
  })

  it('uses host rect dimensions, floored + min-1 (0×0 collapses Leafer canvas to 1px)', () => {
    const opts = leaferHostOptions(makeStubHost(800.7, 600.2))
    expect(opts.width).toBe(800)
    expect(opts.height).toBe(600)
  })

  it('clamps sub-1 dimensions to 1 (avoid 0×0 Leafer canvas)', () => {
    const opts = leaferHostOptions(makeStubHost(0, 0))
    expect(opts.width).toBe(1)
    expect(opts.height).toBe(1)
  })

  it('transparent fill + smooth + design type (paint surface, no own background)', () => {
    const opts = leaferHostOptions(makeStubHost(100, 100))
    expect(opts.fill).toBe('rgba(246, 243, 235, 0)')
    expect(opts.smooth).toBe(true)
    expect(opts.type).toBe('design')
  })

  it('view is the host element (Leafer mounts into it)', () => {
    const host = makeStubHost(100, 100)
    const opts = leaferHostOptions(host)
    expect(opts.view).toBe(host)
  })
})

describe('useLeaferHost — D1 source-contract', () => {
  it('hook source asserts hittable: false in the options builder (D1 guard)', () => {
    // A future edit flipping hittable to true would let the Leafer canvas steal
    // pointer events from the DOM interaction layer. The options builder is the
    // single place hittable is set; lock it here.
    expect(hookSource).toMatch(/hittable:\s*false/)
  })

  it('hook source does not subscribe to Leafer events (no leafer.on)', () => {
    expect(hookSource).not.toMatch(/\.on\(/)
  })
})
