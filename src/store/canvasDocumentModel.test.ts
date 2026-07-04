import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import type { MivoCanvasNode } from '../types/mivoCanvas'
import { firstAnchorImageFor, rollbackLatestHistoryBaseline } from './canvasDocumentModel'

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

const textNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'text-1',
  type: 'text',
  title: 'Text',
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  status: 'ready',
  text: 'hello',
  ...overrides,
})

describe('firstAnchorImageFor', () => {
  it('selects the leftmost visible image on the top visual row', () => {
    const anchor = firstAnchorImageFor([
      imageNode({ id: 'lower-left', x: 0, y: 340, height: 200 }),
      imageNode({ id: 'top-right', x: 300, y: 100, height: 200 }),
      imageNode({ id: 'top-left', x: 50, y: 120, height: 200 }),
      imageNode({ id: 'hidden-earlier', x: -100, y: 80, hidden: true }),
      textNode({ id: 'text-earlier', x: -200, y: 70 }),
    ])

    expect(anchor?.id).toBe('top-left')
  })

  it('does not pull images from a lower row outside the half-median-height tolerance', () => {
    const anchor = firstAnchorImageFor([
      imageNode({ id: 'top', x: 100, y: 100, height: 100 }),
      imageNode({ id: 'lower-but-left', x: 0, y: 170, height: 100 }),
    ])

    expect(anchor?.id).toBe('top')
  })

  it('returns undefined when there is no visible image', () => {
    expect(firstAnchorImageFor([
      textNode({ id: 'text-only' }),
      imageNode({ id: 'hidden-image', hidden: true }),
    ])).toBeUndefined()
  })
})

describe('rollbackLatestHistoryBaseline', () => {
  it('removes the current placeholder and restores reflowed nodes from the baseline', () => {
    const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
    const obstacleBefore = imageNode({ id: 'obstacle', x: 156, y: 0, width: 100, height: 100 })
    const slot = imageNode({ id: 'slot', type: 'ai-slot', x: 156, y: 0, width: 100, height: 100 })
    const obstacleAfter = imageNode({ id: 'obstacle', x: 312, y: 0, width: 100, height: 100 })
    const currentNodes = [source, slot, obstacleAfter]
    const baselineNodes = [source, obstacleBefore]
    const state = {
      sceneId: 'c1',
      nodes: currentNodes,
      edges: [],
      tasks: [{ id: 'task-1', label: 'running', status: 'running', progress: 0, nodeIds: [] }],
      selectedNodeId: 'slot',
      selectedNodeIds: ['slot'],
      historyPast: [{
        version: 2,
        sceneId: 'c1',
        nodes: baselineNodes,
        edges: [],
        tasks: [],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      }],
      historyFuture: [{
        version: 2,
        sceneId: 'c1',
        nodes: currentNodes,
        edges: [],
        tasks: [],
        selectedNodeId: 'slot',
        selectedNodeIds: ['slot'],
      }],
      canvases: {
        c1: {
          title: 'Canvas',
          nodes: currentNodes,
          edges: [],
          tasks: [],
          selectedNodeId: 'slot',
          selectedNodeIds: ['slot'],
        },
      },
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', { removeNodeId: 'slot' })

    expect(patch).toBeDefined()
    if (!patch) return
    const patchNodes = patch.nodes || []
    expect(patchNodes.map((node) => node.id)).toEqual(['src', 'obstacle'])
    expect(patchNodes.find((node) => node.id === 'obstacle')?.x).toBe(156)
    expect(patch.historyPast).toEqual([])
    expect(patch.historyFuture).toEqual([])
    expect(patch.selectedNodeId).toBeUndefined()
  })

  it('S01: rolls back normally when expectedBaseline matches the栈顶 snapshot (same reference)', () => {
    const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
    const slot = imageNode({ id: 'slot', type: 'ai-slot', x: 156, y: 0, width: 100, height: 100 })
    const currentNodes = [source, slot]
    const baselineSnapshot = {
      version: 2 as const,
      sceneId: 'c1',
      nodes: [source],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    }
    const state = {
      sceneId: 'c1',
      nodes: currentNodes,
      edges: [],
      tasks: [],
      selectedNodeId: 'slot',
      selectedNodeIds: ['slot'],
      historyPast: [baselineSnapshot],
      historyFuture: [],
      canvases: {
        c1: {
          title: 'Canvas',
          nodes: currentNodes,
          edges: [],
          tasks: [],
          selectedNodeId: 'slot',
          selectedNodeIds: ['slot'],
        },
      },
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', {
      removeNodeId: 'slot',
      expectedBaseline: baselineSnapshot,
    })

    expect(patch).toBeDefined()
    expect(patch?.historyPast).toEqual([])
  })

  it('S01: returns undefined when expectedBaseline does not match the栈顶 (user edited during async)', () => {
    // 异步生成期间用户编辑过 → pushHistory 推了新快照 → 栈顶已不是生成基线引用。
    // expectedBaseline 指向生成开始时的基线，与栈顶不是同一引用 → 返回 undefined，
    // caller 走 filter-removal 保留用户编辑（保编辑 > 还原位移）。
    const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
    const obstacleBefore = imageNode({ id: 'obstacle', x: 156, y: 0, width: 100, height: 100 })
    const slot = imageNode({ id: 'slot', type: 'ai-slot', x: 156, y: 0, width: 100, height: 100 })
    const userEditNode = imageNode({ id: 'user-edit', x: 500, y: 0 })
    const currentNodes = [source, slot, userEditNode]
    const generationBaseline = {
      version: 2 as const,
      sceneId: 'c1',
      nodes: [source, obstacleBefore],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    }
    // 用户编辑后栈顶：与 generationBaseline 不是同一引用
    const topAfterUserEdit = {
      version: 2,
      sceneId: 'c1',
      nodes: [source, slot, userEditNode],
      edges: [],
      tasks: [],
      selectedNodeId: 'user-edit',
      selectedNodeIds: ['user-edit'],
    }
    const state = {
      sceneId: 'c1',
      nodes: currentNodes,
      edges: [],
      tasks: [],
      selectedNodeId: 'user-edit',
      selectedNodeIds: ['user-edit'],
      historyPast: [generationBaseline, topAfterUserEdit],
      historyFuture: [],
      canvases: {
        c1: {
          title: 'Canvas',
          nodes: currentNodes,
          edges: [],
          tasks: [],
          selectedNodeId: 'user-edit',
          selectedNodeIds: ['user-edit'],
        },
      },
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', {
      removeNodeId: 'slot',
      expectedBaseline: generationBaseline,
    })

    expect(patch).toBeUndefined()
  })
})
