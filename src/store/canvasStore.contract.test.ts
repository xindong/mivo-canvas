import { describe, expect, it, vi, beforeEach } from 'vitest'

// zustand v5 persist only attaches `api.persist` (getOptions/partialize/rehydrate) when
// `createJSONStorage(() => window.localStorage)` resolves a storage. In the node env there is
// no `window`, so the middleware early-returns and `useCanvasStore.persist` is undefined.
// We install an in-memory localStorage (and a minimal `window`) before the store module
// loads so the persist API is reachable for the partialize/hydration contract tests. This
// runs in vi.hoisted so it executes before the `import` below (ESM imports are otherwise
// hoisted above plain statements).
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage }
  if (g.localStorage === undefined) g.localStorage = memStorage
})

// Importing canvasStore triggers scenes() → createDemoImage → document.createElement('canvas')
// at module load (node env has no DOM). Stub the image generator (same hermetic approach as P0-a).
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

// commitGenerationResult calls saveGeneratedAsset (IndexedDB-backed). Stub it so the contract
// test stays hermetic; the asset record shape is what the node builder reads.
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1234,
    hasTransparency: false,
    size: '300x200',
    sourceDimensions: { width: 300, height: 200 },
  })),
  saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imported' })),
  readImportedAssetFile: vi.fn(),
}))

// debugLogger.warn/error call reportRemoteDebugEntry, which uses window.setTimeout + fetch to
// flush to the debug-log endpoint. That remote-flush plumbing is outside the store contract;
// stub it so warn/error paths stay hermetic and don't reach into browser globals.
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import { useCanvasStore, migratePersistedState } from './canvasStore'
import { useChatStore } from './chatStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// Helpers ---------------------------------------------------------------------

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
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

const baseState = useCanvasStore.getState()

const seed = (overrides: Record<string, unknown> = {}) =>
  useCanvasStore.setState({ ...baseState, ...overrides } as never, true)

const seedCanvas = (sceneId: string, nodes: MivoCanvasNode[] = [], extra: Record<string, unknown> = {}) => {
  const document = { title: sceneId, nodes, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
  return {
    canvases: { [sceneId]: document },
    sceneId,
    nodes,
    edges: [],
    tasks: [],
    selectedNodeId: undefined,
    selectedNodeIds: [],
    ...extra,
  }
}

beforeEach(() => {
  // Reset both the in-memory singleton state and the in-memory localStorage between tests.
  const ls = (globalThis as { localStorage?: { clear: () => void } }).localStorage
  if (ls) ls.clear()
  useCanvasStore.setState({ ...baseState } as never, true)
  useChatStore.setState({ ...useChatStore.getInitialState() } as never, true)
})

// Tests -----------------------------------------------------------------------

describe('contract: canvas persist v8 shape (partialize field set)', () => {
  const expectedFields = [
    'activeStampKind',
    'activeTool',
    'brushStyle',
    'canvases',
    'sceneId',
    'selectedNodeId',
    'selectedNodeIds',
  ].sort()

  it('pins the persist name and version', () => {
    const opts = useCanvasStore.persist.getOptions()
    expect(opts.name).toBe('mivo-canvas-demo')
    expect(opts.version).toBe(8)
  })

  it('pins the migrate function reference (A2 must not silently swap migrators)', () => {
    const opts = useCanvasStore.persist.getOptions()
    expect(opts.migrate).toBe(migratePersistedState)
  })

  it('partialize produces exactly the persisted field set (no drift)', () => {
    const opts = useCanvasStore.persist.getOptions()
    const partialize = opts.partialize!
    const partialized = partialize(useCanvasStore.getState()) as Record<string, unknown>
    expect(Object.keys(partialized).sort()).toEqual(expectedFields)
  })

  it('partialize excludes runtime fields (history/clipboard/nodes/edges/tasks)', () => {
    const opts = useCanvasStore.persist.getOptions()
    const partialized = opts.partialize!(useCanvasStore.getState()) as Record<string, unknown>
    for (const runtimeField of ['historyPast', 'historyFuture', 'clipboardNodes', 'clipboardAssets', 'nodes', 'edges', 'tasks']) {
      expect(partialized).not.toHaveProperty(runtimeField)
    }
  })

  it('integration: setState persists exactly the partialized field set to localStorage', () => {
    // Trigger the persist setItem path by mutating state.
    useCanvasStore.getState().setActiveTool('brush')
    const raw = (globalThis as { localStorage: { getItem: (k: string) => string | null } }).localStorage.getItem('mivo-canvas-demo')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown>; version: number }
    expect(parsed.version).toBe(8)
    expect(Object.keys(parsed.state).sort()).toEqual(expectedFields)
    expect(parsed.state.activeTool).toBe('brush')
  })

  it('hydration: a persisted v8 state is rehydrated into the store', async () => {
    const persisted = {
      state: { canvases: { 'character-flow': { title: 'Hydrated', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] } }, sceneId: 'character-flow', selectedNodeId: undefined, selectedNodeIds: [], activeTool: 'select', brushStyle: { color: '#000000', width: 8, kind: 'marker' }, activeStampKind: useCanvasStore.getState().activeStampKind },
      version: 8,
    }
    ;(globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('mivo-canvas-demo', JSON.stringify(persisted))
    await useCanvasStore.persist.rehydrate()
    expect(useCanvasStore.getState().canvases['character-flow']?.title).toBe('Hydrated')
    expect(useCanvasStore.getState().brushStyle).toEqual({ color: '#000000', width: 8, kind: 'marker' })
  })
})

describe('contract: chat persist v2 shape', () => {
  it('pins the chat persist name, version, and partialize field set', () => {
    const opts = useChatStore.persist.getOptions()
    expect(opts.name).toBe('mivo-chat-demo')
    expect(opts.version).toBe(2)

    const partialized = opts.partialize!(useChatStore.getState()) as Record<string, unknown>
    expect(Object.keys(partialized).sort()).toEqual(['messagesByScene', 'paramOverrides', 'selectedModel'].sort())
  })

  it('partialize excludes isBusy (runtime state)', () => {
    const opts = useChatStore.persist.getOptions()
    const partialized = opts.partialize!(useChatStore.getState()) as Record<string, unknown>
    expect(partialized).not.toHaveProperty('isBusy')
  })
})

describe('contract: selectNode', () => {
  it('clears selection when called with no nodeId', () => {
    seed({ ...seedCanvas('character-flow', [imageNode({ id: 'n1' })]), selectedNodeId: 'n1', selectedNodeIds: ['n1'] })
    useCanvasStore.getState().selectNode(undefined)
    const s = useCanvasStore.getState()
    expect(s.selectedNodeId).toBeUndefined()
    expect(s.selectedNodeIds).toEqual([])
  })

  it('selects an existing visible node', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    useCanvasStore.getState().selectNode('n1')
    const s = useCanvasStore.getState()
    expect(s.selectedNodeId).toBe('n1')
    expect(s.selectedNodeIds).toEqual(['n1'])
  })

  it('is a no-op when the node is missing (boundary)', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const before = useCanvasStore.getState()
    useCanvasStore.getState().selectNode('does-not-exist')
    const after = useCanvasStore.getState()
    expect(after.selectedNodeId).toBe(before.selectedNodeId)
    expect(after.selectedNodeIds).toBe(before.selectedNodeIds)
  })

  it('is a no-op when the node is hidden (boundary)', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1', hidden: true })]))
    useCanvasStore.getState().selectNode('n1')
    expect(useCanvasStore.getState().selectedNodeId).toBeUndefined()
  })

  it('additive toggle: selecting an already-selected node removes it', () => {
    seed({ ...seedCanvas('character-flow', [imageNode({ id: 'n1' }), imageNode({ id: 'n2', x: 400 })]), selectedNodeId: 'n1', selectedNodeIds: ['n1', 'n2'] })
    useCanvasStore.getState().selectNode('n1', { additive: true })
    const s = useCanvasStore.getState()
    expect(s.selectedNodeIds).not.toContain('n1')
  })
})

describe('contract: selectNodes', () => {
  it('normalizes selection against visible nodes and honors the requested primary', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' }), imageNode({ id: 'n2', x: 400 }), imageNode({ id: 'n3', x: 800, hidden: true })]))
    useCanvasStore.getState().selectNodes(['n1', 'n2', 'n3'], 'n2')
    const s = useCanvasStore.getState()
    expect(s.selectedNodeIds).toEqual(['n1', 'n2'])
    expect(s.selectedNodeId).toBe('n2')
  })

  it('falls back to the first selected id when the requested primary is not in the selection', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' }), imageNode({ id: 'n2', x: 400 })]))
    useCanvasStore.getState().selectNodes(['n1', 'n2'], 'not-in-set')
    expect(useCanvasStore.getState().selectedNodeId).toBe('n1')
  })

  it('clears selection when given an empty list (boundary)', () => {
    seed({ ...seedCanvas('character-flow', [imageNode({ id: 'n1' })]), selectedNodeId: 'n1', selectedNodeIds: ['n1'] })
    useCanvasStore.getState().selectNodes([])
    const s = useCanvasStore.getState()
    expect(s.selectedNodeIds).toEqual([])
    expect(s.selectedNodeId).toBeUndefined()
  })
})

describe('contract: undo / redo', () => {
  it('undo is a no-op when historyPast is empty (boundary)', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const before = useCanvasStore.getState()
    useCanvasStore.getState().undo()
    const after = useCanvasStore.getState()
    expect(after.nodes).toBe(before.nodes)
    expect(after.historyPast).toEqual([])
  })

  it('redo is a no-op when historyFuture is empty (boundary)', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const before = useCanvasStore.getState()
    useCanvasStore.getState().redo()
    expect(useCanvasStore.getState().nodes).toBe(before.nodes)
    expect(useCanvasStore.getState().historyFuture).toEqual([])
  })

  it('captureHistory → mutate → undo restores the prior state, redo re-applies', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    useCanvasStore.getState().captureHistory()
    // mutate: add a second node via setState (simulates a document patch)
    useCanvasStore.setState((s) => ({ nodes: [...s.nodes, imageNode({ id: 'n2', x: 400 })] }))
    expect(useCanvasStore.getState().nodes).toHaveLength(2)

    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().nodes).toHaveLength(1)
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual(['n1'])

    useCanvasStore.getState().redo()
    expect(useCanvasStore.getState().nodes).toHaveLength(2)
  })
})

describe('contract: commitGenerationResult (incl. cross-scene)', () => {
  const resultImage = () => ({
    blob: new Blob(['mock-image-bytes'], { type: 'image/png' }),
    title: 'Generated image 1',
    width: 300,
    height: 200,
  })

  it('rejects on empty prompt', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    await expect(
      useCanvasStore.getState().commitGenerationResult({
        sceneId: 'character-flow',
        sourceNodeId: 'n1',
        resultImages: [resultImage()],
        prompt: '   ',
        model: 'gpt-image-2',
        kind: 'generate',
      }),
    ).rejects.toThrow(/prompt/i)
  })

  it('rejects on no result images', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    await expect(
      useCanvasStore.getState().commitGenerationResult({
        sceneId: 'character-flow',
        sourceNodeId: 'n1',
        resultImages: [],
        prompt: 'a cat',
        model: 'gpt-image-2',
        kind: 'generate',
      }),
    ).rejects.toThrow()
  })

  it('throws when the target scene has been deleted', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    await expect(
      useCanvasStore.getState().commitGenerationResult({
        sceneId: 'deleted-scene',
        resultImages: [resultImage()],
        prompt: 'a cat',
        model: 'gpt-image-2',
        kind: 'generate',
      }),
    ).rejects.toThrow(/目标画布/)
  })

  it('commits result nodes to the TARGET scene and returns their ids (Promise<string[]>)', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().commitGenerationResult({
      sceneId: 'character-flow',
      sourceNodeId: 'n1',
      resultImages: [resultImage()],
      prompt: 'a cat',
      model: 'gpt-image-2',
      kind: 'generate',
    })

    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds).toHaveLength(1)
    expect(typeof nodeIds[0]).toBe('string')

    const s = useCanvasStore.getState()
    expect(s.nodes.map((n) => n.id)).toContain(nodeIds[0])
    const committed = s.canvases['character-flow']!.nodes.find((n) => n.id === nodeIds[0])
    expect(committed?.type).toBe('image')
    expect(committed?.generation?.prompt).toBe('a cat')
    expect(committed?.sourceNodeId).toBe('n1')
  })

  it('cross-scene: target != current scene leaves the current scene untouched (L2519-2659 semantic)', async () => {
    // current scene = 'character-flow' (empty); target = 'other-scene' (has source n1)
    seed({
      canvases: {
        'character-flow': { title: 'CF', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        'other-scene': { title: 'Other', nodes: [imageNode({ id: 'n1' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
      },
      sceneId: 'character-flow',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })

    const nodeIds = await useCanvasStore.getState().commitGenerationResult({
      sceneId: 'other-scene',
      sourceNodeId: 'n1',
      resultImages: [resultImage()],
      prompt: 'a cat',
      model: 'gpt-image-2',
      kind: 'generate',
    })

    expect(nodeIds).toHaveLength(1)
    // target scene received the result node
    const otherScene = useCanvasStore.getState().canvases['other-scene']!
    expect(otherScene.nodes.map((n) => n.id)).toContain(nodeIds[0])
    // current scene was NOT touched
    expect(useCanvasStore.getState().canvases['character-flow']!.nodes).toEqual([])
    expect(useCanvasStore.getState().nodes).toEqual([])
  })

  it('creates a derivation edge from the source to the result by default', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().commitGenerationResult({
      sceneId: 'character-flow',
      sourceNodeId: 'n1',
      resultImages: [resultImage()],
      prompt: 'a cat',
      model: 'gpt-image-2',
      kind: 'generate',
    })

    const s = useCanvasStore.getState()
    const edge = s.edges.find((e) => e.to === nodeIds[0])
    expect(edge).toBeDefined()
    expect(edge?.from).toBe('n1')
    expect(edge?.type).toBe('generate')
  })
})
