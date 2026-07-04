import { describe, expect, it } from 'vitest'
import {
  reduceMaskPointPending,
  shouldCancelPendingMaskEdit,
  type MaskInitialClientPoint,
} from './maskPointPending'

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

// W5 (QoL batch): overlay late-arrival guard — during the overlay-mounting window,
// a pointerdown on a different node or blank canvas must cancel the pending mask
// edit so the late-arriving overlay doesn't pop up over the new selection.
describe('shouldCancelPendingMaskEdit (W5 overlay late-arrival guard)', () => {
  it('returns false when no mask edit is pending', () => {
    expect(shouldCancelPendingMaskEdit(undefined, 'image-b')).toBe(false)
    expect(shouldCancelPendingMaskEdit(undefined, undefined)).toBe(false)
  })

  it('returns true when a different node is clicked during the mounting window', () => {
    expect(shouldCancelPendingMaskEdit('image-a', 'image-b')).toBe(true)
  })

  it('returns true when blank canvas is clicked during the mounting window', () => {
    expect(shouldCancelPendingMaskEdit('image-a', undefined)).toBe(true)
  })

  it('returns false when the mask-edit target itself is re-clicked (re-engage, keep)', () => {
    expect(shouldCancelPendingMaskEdit('image-a', 'image-a')).toBe(false)
  })
})
