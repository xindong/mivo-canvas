import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { createAiResultNode } from './aiCanvasCommands'

const sourceNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'source-1',
  type: 'image',
  title: 'Source',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  assetUrl: '/source.png',
  ...overrides,
})

describe('aiCanvasCommands', () => {
  it('creates a normalized beside-generation result node', () => {
    const node = createAiResultNode({
      id: 'result-1',
      title: 'AI result from Source',
      sourceNodes: [sourceNode()],
      anchorNode: sourceNode(),
      operation: 'beside-generation',
      prompt: 'make it brighter',
      placement: 'right',
      position: { x: 360, y: 20 },
      size: { width: 300, height: 200 },
      assetUrl: '/result.png',
      createdAt: 12345,
      taskId: 'task-result-1',
      model: 'Mivo Mock Image Workflow',
      strength: 0.58,
    })

    expect(node).toMatchObject({
      id: 'result-1',
      type: 'image',
      title: 'AI result from Source',
      x: 360,
      y: 20,
      width: 300,
      height: 200,
      assetUrl: '/result.png',
      parentIds: ['source-1'],
    })
    expect(node.transform).toEqual({ x: 360, y: 20, width: 300, height: 200, rotation: 0 })
    expect(node.asset).toEqual({ url: '/result.png' })
    expect(node.relations?.parentIds).toEqual(['source-1'])
    expect(node.aiWorkflow).toMatchObject({
      kind: 'result',
      status: 'ready',
      operation: 'beside-generation',
      prompt: 'make it brighter',
      sourceNodeIds: ['source-1'],
      anchorNodeId: 'source-1',
      placement: 'right',
      createdAt: 12345,
    })
    expect(node.relations?.aiWorkflow).toEqual(node.aiWorkflow)
  })

  it('records slot and annotation relation fields when provided', () => {
    const node = createAiResultNode({
      id: 'result-2',
      title: 'Edited result',
      sourceNodes: [sourceNode()],
      anchorNode: sourceNode({ id: 'annotation-1', type: 'annotation' }),
      annotationNode: sourceNode({ id: 'annotation-1', type: 'annotation' }),
      slotNode: sourceNode({ id: 'slot-1', type: 'ai-slot' }),
      operation: 'annotation-edit',
      prompt: 'fix hand',
      placement: 'slot',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 120 },
      assetUrl: '/edited.png',
      createdAt: 1,
      taskId: 'task-result-2',
    })

    expect(node.parentIds).toEqual(['source-1', 'annotation-1', 'slot-1'])
    expect(node.aiWorkflow?.sourceNodeIds).toEqual(['source-1'])
    expect(node.aiWorkflow?.annotationNodeId).toBe('annotation-1')
    expect(node.aiWorkflow?.slotId).toBe('slot-1')
    expect(node.relations?.parentIds).toEqual(['source-1', 'annotation-1', 'slot-1'])
  })
})
