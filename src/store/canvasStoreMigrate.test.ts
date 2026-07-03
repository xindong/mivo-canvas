import { describe, expect, it, vi } from 'vitest'

// Importing canvasStore triggers `scenes()` at module load, which renders demo images
// via an HTML canvas (`document.createElement('canvas')`). The node test environment has
// no DOM, so we stub `createDemoImage` to a plain data URL — the migrate function never
// inspects demo-image content, so the placeholder is safe and keeps the test hermetic.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import { migratePersistedState } from './canvasStore'
import type { MivoCanvasNode, CanvasTask } from '../types/mivoCanvas'
import type { BrushStyle } from './canvasStore'

// Helpers ---------------------------------------------------------------------

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'img-1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  assetUrl: '/a.png',
  ...overrides,
})

const longMarkdownNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'md-1',
  type: 'markdown',
  title: 'Long doc',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'ready',
  text: 'x'.repeat(3600), // > 3500 chars triggers markdownShouldUsePreviewMode
  ...overrides,
})

const task = (overrides: Partial<CanvasTask> = {}): CanvasTask => ({
  id: 'task-1',
  label: 'task',
  status: 'done',
  progress: 100,
  nodeIds: ['img-1'],
  ...overrides,
})

const defaultBrushStyle: BrushStyle = { color: '#232323', width: 4, kind: 'marker' }

// Tests -----------------------------------------------------------------------

describe('migratePersistedState (canvas persist v8)', () => {
  describe('flat-state compatibility (top-level nodes/tasks/edges)', () => {
    it('merges persisted top-level nodes/tasks into the active scene and surfaces them on the result', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [imageNode()],
          tasks: [task()],
          selectedNodeId: 'img-1',
          selectedNodeIds: ['img-1'],
        },
        7,
      )

      expect(result.sceneId).toBe('character-flow')
      expect(result.nodes.map((n) => n.id)).toContain('img-1')
      expect(result.tasks.map((t) => t.id)).toContain('task-1')
      expect(result.selectedNodeId).toBe('img-1')
      // v2 normalization augments the node with transform/fills/asset
      const node = result.nodes.find((n) => n.id === 'img-1')
      expect(node?.transform).toEqual({ x: 10, y: 20, width: 300, height: 200, rotation: 0 })
      expect(node?.asset).toEqual({ url: '/a.png' })
    })

    it('uses edges from persisted flat-state when provided', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [imageNode({ id: 'a' }), imageNode({ id: 'b', x: 400 })],
          edges: [{ id: 'e1', from: 'a', to: 'b', type: 'generate', prompt: 'p', createdAt: 1 }],
          tasks: [task()],
        },
        7,
      )

      expect(result.edges.map((e) => e.id)).toContain('e1')
    })

    it('falls back to the default scene when persisted.sceneId is unknown', () => {
      const result = migratePersistedState(
        { sceneId: 'does-not-exist', nodes: [imageNode()], tasks: [task()] },
        7,
      )

      expect(result.sceneId).toBe('character-flow')
    })
  })

  describe('<6 markdown normalization branch', () => {
    it('forces long-markdown nodes into preview display mode at version 5', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [longMarkdownNode()],
          tasks: [task()],
        },
        5,
      )

      const md = result.nodes.find((n) => n.id === 'md-1')
      expect(md?.markdownDisplayMode).toBe('preview')
      expect(md?.width).toBe(560)
      expect(md?.height).toBe(620)
    })

    it('does not force preview mode at version 6+ (preserves whatever was persisted)', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [longMarkdownNode({ markdownDisplayMode: 'full', width: 100, height: 100 })],
          tasks: [task()],
        },
        6,
      )

      const md = result.nodes.find((n) => n.id === 'md-1')
      expect(md?.markdownDisplayMode).toBe('full')
      expect(md?.width).not.toBe(560)
    })
  })

  describe('<8 brushStyle reset branch', () => {
    it('resets brushStyle to the default at version 7 (ignores persisted custom style)', () => {
      const custom: BrushStyle = { color: '#ff0000', width: 10, kind: 'highlighter' }
      const result = migratePersistedState(
        { sceneId: 'character-flow', brushStyle: custom } as never,
        7,
      )

      expect(result.brushStyle).toEqual(defaultBrushStyle)
      expect(result.brushStyle).not.toEqual(custom)
    })

    it('preserves the persisted brushStyle at version 8', () => {
      const custom: BrushStyle = { color: '#ff0000', width: 10, kind: 'highlighter' }
      const result = migratePersistedState({ brushStyle: custom } as never, 8)

      expect(result.brushStyle).toEqual(custom)
    })

    it('falls back to the default when persisted.brushStyle is missing at version 8', () => {
      const result = migratePersistedState({} as never, 8)

      expect(result.brushStyle).toEqual(defaultBrushStyle)
    })
  })

  describe('runtime fields reset on every migration', () => {
    it('clears clipboard and history regardless of persisted values', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          // these should NOT survive migration
          clipboardNodes: [imageNode()] as never,
          clipboardAssets: [{ x: 1 } as never] as never,
        } as never,
        8,
      )

      expect(result.clipboardNodes).toEqual([])
      expect(result.clipboardAssets).toEqual([])
      expect(result.historyPast).toEqual([])
      expect(result.historyFuture).toEqual([])
    })

    it('defaults activeTool to select when persisted value is missing', () => {
      const result = migratePersistedState({} as never, 8)
      expect(result.activeTool).toBe('select')
    })

    it('preserves a persisted activeTool', () => {
      const result = migratePersistedState({ activeTool: 'brush' } as never, 8)
      expect(result.activeTool).toBe('brush')
    })
  })
})
