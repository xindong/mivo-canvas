import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasActionRuntime } from './canvasActionTypes'
import type { NodeRecord } from '../../kernel/records'
import type { MivoCanvasNode } from '../../types/mivoCanvas'

vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage }
  if (g.localStorage === undefined) g.localStorage = localStorage
})

vi.mock('../../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

vi.mock('../../store/remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 120,
  height: 80,
  status: 'ready',
  assetUrl: '/image.png',
  ...overrides,
})

const nodeRecord = (overrides: Partial<NodeRecord> = {}): NodeRecord => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  revision: 0,
  transform: { x: 10, y: 20, width: 120, height: 80, rotation: 0 },
  fills: [],
  strokes: [],
  effects: [],
  relations: {},
  ...overrides,
})

const loadRuntimeModule = async (options: { local?: boolean } = {}) => {
  vi.resetModules()
  const submitChange = vi.fn(async () => ({
    kind: 'accepted' as const,
    cursor: 'cursor' as never,
  }))
  vi.doMock('../../lib/persistMode', () => ({
    isLocalPersist: options.local ?? false,
  }))
  vi.doMock('../../lib/canvasSyncPortClient', () => ({
    getCanvasSyncPort: () => ({ submitChange }),
    persistMode: options.local ? 'local' : 'server',
  }))
  const mod = await import('./canvasSyncRuntime')
  const { useCanvasStore } = await import('../../store/canvasStore')
  return { ...mod, useCanvasStore, submitChange }
}

describe('canvasSyncRuntime(Block 1 runtime driving)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('buildCanvasSyncChanges emits delete-field when an optional field is removed', async () => {
    const { buildCanvasSyncChanges } = await loadRuntimeModule()

    const changes = buildCanvasSyncChanges(
      {
        canvasId: 'c1',
        nodes: new Map([['n1', nodeRecord({ sectionLockMode: 'all' })]]),
        edges: new Map(),
        anchors: new Map(),
        nodeOrder: ['n1'],
        edgeOrder: [],
        anchorOrder: [],
      },
      {
        canvasId: 'c1',
        nodes: new Map([['n1', nodeRecord()]]),
        edges: new Map(),
        anchors: new Map(),
        nodeOrder: ['n1'],
        edgeOrder: [],
        anchorOrder: [],
      },
    )

    expect(changes).toEqual([
      {
        kind: 'edit-node',
        nodeId: 'n1',
        intents: [{ op: 'delete-field', fieldPath: ['sectionLockMode'] }],
      },
    ])
  })

  it('wrapCanvasActionRuntimeWithSync drives submitChange from the existing runtime mutation path', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, useCanvasStore, wrapCanvasActionRuntimeWithSync } =
      await loadRuntimeModule()
    const baseState = useCanvasStore.getInitialState()
    useCanvasStore.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: {
          c1: {
            title: 'Canvas',
            createdAt: '2026-07-13T00:00:00.000Z',
            updatedAt: '2026-07-13T00:00:00.000Z',
            nodes: [imageNode()],
            edges: [],
            tasks: [],
            selectedNodeId: 'n1',
            selectedNodeIds: ['n1'],
          },
        },
        nodes: [imageNode()],
        edges: [],
        tasks: [],
        selectedNodeId: 'n1',
        selectedNodeIds: ['n1'],
      } as never,
      true,
    )

    const runtime = wrapCanvasActionRuntimeWithSync({
      deleteNode: (nodeId: string) => useCanvasStore.getState().deleteNode(nodeId),
    } as unknown as CanvasActionRuntime)

    runtime.deleteNode('n1')
    await Promise.resolve()
    await Promise.resolve()

    expect(submitChange).toHaveBeenCalledWith('c1', { kind: 'delete-node', nodeId: 'n1' })
    expect(useCanvasStore.getState().nodes).toHaveLength(0)
    __resetCanvasSyncRuntimeQueue()
  })

  it('returns the original runtime unchanged in local mode', async () => {
    const { wrapCanvasActionRuntimeWithSync } = await loadRuntimeModule({ local: true })
    const runtime = { deleteNode: vi.fn() } as unknown as CanvasActionRuntime
    expect(wrapCanvasActionRuntimeWithSync(runtime)).toBe(runtime)
  })
})
