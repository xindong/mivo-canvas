import { describe, expect, it, vi } from 'vitest'
import { applyCameraToLeafer, type LeaferCameraSurface } from './useLeaferCameraSync'
import type { ViewportState } from './useLeaferSpikeRenderer'
import hookSource from './useLeaferCameraSync.ts?raw'

const makeFakeLeafer = () => {
  const set = vi.fn()
  const on = vi.fn()
  return { zoomLayer: { set }, on } as unknown as LeaferCameraSurface & { on: ReturnType<typeof vi.fn> }
}

const viewport: ViewportState = { x: 100, y: 200, scale: 1.5 }

describe('applyCameraToLeafer — set params + null safety', () => {
  it('calls zoomLayer.set with {x, y, scaleX: scale, scaleY: scale}', () => {
    const leafer = makeFakeLeafer()
    applyCameraToLeafer(leafer, viewport)
    expect(leafer.zoomLayer.set).toHaveBeenCalledTimes(1)
    expect(leafer.zoomLayer.set).toHaveBeenCalledWith({
      x: 100,
      y: 200,
      scaleX: 1.5,
      scaleY: 1.5,
    })
  })

  it('null leafer is a no-op (no throw)', () => {
    expect(() => applyCameraToLeafer(null, viewport)).not.toThrow()
  })

  it('idempotent: same viewport called twice → two set calls (no dedup at this layer)', () => {
    const leafer = makeFakeLeafer()
    applyCameraToLeafer(leafer, viewport)
    applyCameraToLeafer(leafer, viewport)
    expect(leafer.zoomLayer.set).toHaveBeenCalledTimes(2)
  })
})

describe('useLeaferCameraSync — D1 invariant: no Leafer event subscription', () => {
  // D1: the camera sync is one-way (gesture→engine). It MUST NOT call `leafer.on`
  // (no Leafer→store back-write). The pure helper is the entire camera write surface,
  // so asserting it never touches `on` proves the contract.
  it('applyCameraToLeafer never calls leafer.on (D1: no event back-write)', () => {
    const leafer = makeFakeLeafer()
    applyCameraToLeafer(leafer, viewport)
    expect(leafer.on).not.toHaveBeenCalled()
  })

  it('hook source contains no leafer.on( call (source-contract: no Leafer subscription)', () => {
    // The hook must not subscribe to Leafer events anywhere — neither in the React
    // effect nor in the bridge callback. A literal `leafer.on(` would violate D1.
    expect(hookSource).not.toMatch(/\.on\(/)
  })

  it('hook source documents the one-way direction (gesture→engine, not Leafer→store)', () => {
    // Guard against a future edit flipping the direction. The contract comment must
    // state the direction explicitly so a reviewer reading the source sees D1.
    expect(hookSource).toContain('gesture→engine')
    // The only zoomLayer access the pure helper performs is `.set(` (a write). The
    // spy test above already proves `on` is never called; this guards against any
    // `zoomLayer.<other>` read sneaking into the source.
    const zoomLayerAccesses = hookSource.match(/zoomLayer\.\w+/g) ?? []
    expect(zoomLayerAccesses.every((access) => access === 'zoomLayer.set')).toBe(true)
  })
})
