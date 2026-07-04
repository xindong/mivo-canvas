import { describe, expect, it } from 'vitest'
import { reduceMaskPointPending, type MaskInitialClientPoint } from './maskPointPending'

const point: MaskInitialClientPoint = {
  nodeId: 'image-a',
  clientX: 120,
  clientY: 240,
}

describe('mask point pending lifecycle', () => {
  it('consumes the pending point for the matching node', () => {
    expect(reduceMaskPointPending(point, { type: 'consume', nodeId: 'image-a' })).toBeUndefined()
  })

  it('discards a stale pending point when another node opens mask edit', () => {
    expect(reduceMaskPointPending(point, { type: 'discard-stale', nodeId: 'image-b' })).toBeUndefined()
    expect(reduceMaskPointPending(point, { type: 'discard-stale', nodeId: 'image-a' })).toEqual(point)
  })

  it('clears the pending point on cancel', () => {
    expect(reduceMaskPointPending(point, { type: 'clear' })).toBeUndefined()
  })
})
