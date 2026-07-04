import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundsForRegions, buildEditMaskBlob, pointMaskRadiusFor } from './imageMaskGeometry'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('point mask regions', () => {
  it('uses 8% of the source short edge as the default point radius', () => {
    expect(pointMaskRadiusFor({ width: 1000, height: 500 })).toBe(40)
    expect(pointMaskRadiusFor({ width: 9, height: 20 })).toBe(1)
  })

  it('builds circular bounds for a single-point brush region', () => {
    const bounds = boundsForRegions(
      [{ type: 'brush', points: [{ x: 100, y: 200 }], radius: 40 }],
      { width: 500, height: 500 },
    )

    expect(bounds).toEqual({ x: 60, y: 160, width: 80, height: 80 })
  })

  it('draws a single-point brush region as a circular mask area', async () => {
    const context = {
      beginPath: vi.fn(),
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      lineCap: '',
      lineJoin: '',
      lineWidth: 0,
      fillStyle: '',
      strokeStyle: '',
      globalCompositeOperation: '',
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
        callback(new Blob(['mask'], { type: 'image/png' }))
      }),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => canvas),
    })

    const blob = await buildEditMaskBlob({
      naturalSize: { width: 500, height: 500 },
      regions: [{ type: 'brush', points: [{ x: 100, y: 200 }], radius: 40 }],
    })

    expect(blob.type).toBe('image/png')
    expect(context.arc).toHaveBeenCalledWith(100, 200, 40, 0, Math.PI * 2)
    expect(context.fill).toHaveBeenCalled()
  })
})
