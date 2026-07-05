import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import type { MivoCanvasNode } from '../types/mivoCanvas'
import { useDebugLogStore } from './debugLogStore'
import { equalAreaSizeForDimensions, reflowRightObstacles } from './aiCanvasWorkflow'

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'img-1',
  type: 'image',
  title: 'Image',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'ready',
  assetUrl: '/a.png',
  ...overrides,
})

describe('reflowRightObstacles', () => {
  beforeEach(() => {
    useDebugLogStore.setState({ entries: [] })
  })

  it('only pushes movable right-side nodes whose y projection intersects the placed rect', () => {
    const placed = imageNode({ id: 'slot', x: 100, y: 0, width: 50, height: 50 })
    const nodes = [
      placed,
      imageNode({ id: 'move-me', x: 120, y: 10, width: 20, height: 20 }),
      imageNode({ id: 'no-y-overlap', x: 120, y: 70, width: 20, height: 20 }),
      imageNode({ id: 'left-side', x: 40, y: 10, width: 30, height: 20 }),
      imageNode({ id: 'locked', x: 125, y: 10, width: 20, height: 20, locked: true }),
      imageNode({ id: 'section-member', x: 130, y: 10, width: 20, height: 20, sectionId: 'frame-1' }),
    ]

    const next = reflowRightObstacles(nodes, placed, 10)

    expect(next.find((node) => node.id === 'move-me')?.x).toBe(160)
    expect(next.find((node) => node.id === 'no-y-overlap')?.x).toBe(120)
    expect(next.find((node) => node.id === 'left-side')?.x).toBe(40)
    expect(next.find((node) => node.id === 'locked')?.x).toBe(125)
    expect(next.find((node) => node.id === 'section-member')?.x).toBe(130)
  })

  it('pushes chained obstacles in x order', () => {
    const placed = imageNode({ id: 'slot', x: 100, y: 0, width: 50, height: 50 })
    const nodes = [
      placed,
      imageNode({ id: 'b', x: 120, y: 0, width: 20, height: 50 }),
      imageNode({ id: 'c', x: 150, y: 0, width: 20, height: 50 }),
    ]

    const next = reflowRightObstacles(nodes, placed, 10)

    expect(next.find((node) => node.id === 'b')?.x).toBe(160)
    expect(next.find((node) => node.id === 'c')?.x).toBe(190)
  })

  it('warns when the iteration cap is reached', () => {
    const placed = imageNode({ id: 'slot', x: 100, y: 0, width: 50, height: 50 })
    const nodes = [
      placed,
      ...Array.from({ length: 61 }, (_, index) =>
        imageNode({ id: `obstacle-${index}`, x: 120 + index, y: 0, width: 20, height: 50 }),
      ),
    ]

    reflowRightObstacles(nodes, placed, 10)

    expect(useDebugLogStore.getState().entries.some((entry) => entry.source === 'AI Slot Reflow')).toBe(true)
  })
})


describe('equalAreaSizeForDimensions (chat slot 替换按结果图比例落画布)', () => {
  const base = { width: 320, height: 320 }

  it('matches the result aspect ratio and preserves the placeholder area (16:9)', () => {
    const size = equalAreaSizeForDimensions(base, { width: 1920, height: 1080 })
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1)
    expect(size.width * size.height).toBeGreaterThan(base.width * base.height * 0.95)
    expect(size.width * size.height).toBeLessThan(base.width * base.height * 1.05)
  })

  it('handles portrait results (1080×1920 → 240×427)', () => {
    expect(equalAreaSizeForDimensions(base, { width: 1080, height: 1920 })).toEqual({ width: 240, height: 427 })
  })

  it('keeps a square result at the placeholder size (1:1 无跳变)', () => {
    expect(equalAreaSizeForDimensions(base, { width: 1024, height: 1024 })).toEqual(base)
  })

  it('falls back to the placeholder size without natural dimensions', () => {
    expect(equalAreaSizeForDimensions(base, undefined)).toEqual(base)
    expect(equalAreaSizeForDimensions(base, { width: 0, height: 900 })).toEqual(base)
  })
})
