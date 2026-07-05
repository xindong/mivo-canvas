import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import type { MivoCanvasNode } from '../types/mivoCanvas'
import { useDebugLogStore } from './debugLogStore'
import { reflowRightObstacles, slotSizeForRatio } from './aiCanvasWorkflow'

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


describe('slotSizeForRatio (占位符比例跟随请求比例)', () => {
  const base = { width: 320, height: 320 }

  it('keeps the base square for 1:1 / auto / undefined (无回归)', () => {
    expect(slotSizeForRatio(base, '1:1')).toEqual(base)
    expect(slotSizeForRatio(base, 'auto')).toEqual(base)
    expect(slotSizeForRatio(base, undefined)).toEqual(base)
  })

  it('matches 16:9 within rounding and preserves the base area', () => {
    const size = slotSizeForRatio(base, '16:9')
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1)
    expect(size.width * size.height).toBeGreaterThan(base.width * base.height * 0.95)
    expect(size.width * size.height).toBeLessThan(base.width * base.height * 1.05)
  })

  it('matches 3:2 and the portrait counterpart 2:3', () => {
    const landscape = slotSizeForRatio(base, '3:2')
    expect(landscape.width / landscape.height).toBeCloseTo(3 / 2, 1)
    const portrait = slotSizeForRatio(base, '2:3')
    expect(portrait.width / portrait.height).toBeCloseTo(2 / 3, 1)
    expect(portrait.width).toBeLessThan(portrait.height)
  })

  it('falls back to base on malformed ratios', () => {
    expect(slotSizeForRatio(base, '0:9' as never)).toEqual(base)
    expect(slotSizeForRatio(base, 'x:y' as never)).toEqual(base)
  })
})
