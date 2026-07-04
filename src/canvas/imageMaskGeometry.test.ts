import { describe, expect, it } from 'vitest'
import { isPointOnlyMaskEdit } from './imageMaskGeometry'

describe('image mask submit guards', () => {
  it('blocks point-only local redraw submissions because they have no mask region', () => {
    expect(isPointOnlyMaskEdit({ regionCount: 0, pointAnchorCount: 1 })).toBe(true)
    expect(isPointOnlyMaskEdit({ regionCount: 0, pointAnchorCount: 3 })).toBe(true)
  })

  it('allows drawn mask regions and empty inactive selections through this guard', () => {
    expect(isPointOnlyMaskEdit({ regionCount: 1, pointAnchorCount: 1 })).toBe(false)
    expect(isPointOnlyMaskEdit({ regionCount: 1, pointAnchorCount: 0 })).toBe(false)
    expect(isPointOnlyMaskEdit({ regionCount: 0, pointAnchorCount: 0 })).toBe(false)
  })
})
