import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  canvasBoundsFromZoomMarquee,
  createZoomMarqueeBox,
  createGroupResizeState,
  createNodeResizeState,
  isZoomToBoundsMarqueeRect,
  resizeGroupSelection,
  resizeNodeTransform,
  runtimeToolFor,
  zoomMarqueeOverlayRect,
} from './canvasInteraction'

const baseNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'node-1',
  type: 'image',
  title: 'Node',
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  status: 'ready',
  ...overrides,
})

describe('resizeNodeTransform', () => {
  it('keeps the opposite corner anchored for a default corner resize', () => {
    const node = baseNode()
    const state = createNodeResizeState(node, 1, 'se', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 40, 0, 1)

    expect(result).toMatchObject({ x: 100, y: 100, width: 240, height: 120 })
  })

  it('keeps the node center anchored for a centered (Alt) corner resize', () => {
    const node = baseNode()
    const state = createNodeResizeState(node, 1, 'se', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 40, 0, 1, { centered: true })

    expect(result).toMatchObject({ x: 60, y: 80, width: 280, height: 140 })
    expect(result.x + result.width / 2).toBe(node.x + node.width / 2)
    expect(result.y + result.height / 2).toBe(node.y + node.height / 2)
    expect(result.guides).toEqual([])
  })

  it('keeps the section center anchored for a centered free resize from any corner', () => {
    const node = baseNode({ type: 'frame', x: 0, y: 0, width: 400, height: 300 })
    const state = createNodeResizeState(node, 1, 'nw', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 20, 10, 1, { centered: true })

    expect(result).toMatchObject({ x: 20, y: 10, width: 360, height: 280 })
    expect(result.x + result.width / 2).toBe(node.x + node.width / 2)
    expect(result.y + result.height / 2).toBe(node.y + node.height / 2)
  })
})

describe('resizeGroupSelection', () => {
  const nodeA = baseNode({ id: 'node-a', x: 0, y: 0, width: 100, height: 100 })
  const nodeB = baseNode({ id: 'node-b', x: 200, y: 100, width: 100, height: 100 })
  const bounds = { x: 0, y: 0, width: 300, height: 200 }

  it('keeps the dragged-from corner anchored for a default group resize', () => {
    const state = createGroupResizeState(1, 'se', 0, 0, bounds, [nodeA, nodeB])

    const result = resizeGroupSelection(state, 60, 40, 1)

    expect(result.bounds).toEqual({ x: 0, y: 0, width: 360, height: 240 })
    expect(result.updates).toEqual([
      { id: 'node-a', x: 0, y: 0, width: 120, height: 120 },
      { id: 'node-b', x: 240, y: 120, width: 120, height: 120 },
    ])
  })

  it('keeps the selection center anchored for a centered (Alt) group resize', () => {
    const state = createGroupResizeState(1, 'se', 0, 0, bounds, [nodeA, nodeB])

    const result = resizeGroupSelection(state, 60, 40, 1, { centered: true })

    expect(result.bounds).toEqual({ x: -60, y: -40, width: 420, height: 280 })
    expect(result.bounds.x + result.bounds.width / 2).toBe(bounds.x + bounds.width / 2)
    expect(result.bounds.y + result.bounds.height / 2).toBe(bounds.y + bounds.height / 2)
    expect(result.updates).toEqual([
      { id: 'node-a', x: -60, y: -40, width: 140, height: 140 },
      { id: 'node-b', x: 220, y: 100, width: 140, height: 140 },
    ])
  })
})

describe('runtimeToolFor', () => {
  it('uses the temporary zoom tool without making zoom a persisted ToolId', () => {
    expect(runtimeToolFor('select', 'zoom')).toBe('zoom')
  })
})

describe('zoom marquee helpers', () => {
  it('converts a shell/client zoom marquee to canvas bounds', () => {
    const marquee = createZoomMarqueeBox(1, 110, 220, { left: 10, top: 20, width: 800, height: 600 })
    marquee.currentClientX = 310
    marquee.currentClientY = 420

    expect(zoomMarqueeOverlayRect(marquee)).toEqual({ x: 100, y: 200, width: 200, height: 200 })
    expect(canvasBoundsFromZoomMarquee(marquee, { x: 50, y: 100, scale: 2 })).toEqual({
      x: 25,
      y: 50,
      width: 100,
      height: 100,
    })
  })

  it('treats sub-4px zoom marquees as click zooms', () => {
    expect(isZoomToBoundsMarqueeRect({ x: 0, y: 0, width: 3, height: 4 })).toBe(false)
    expect(isZoomToBoundsMarqueeRect({ x: 0, y: 0, width: 4, height: 4 })).toBe(true)
  })
})
