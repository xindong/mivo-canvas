import { describe, expect, it, vi, beforeEach } from 'vitest'

// Hermetic setup (same approach as canvasStore.contract.test.ts): stub the demo-image canvas
// renderer, the IndexedDB-backed asset store, and the remote debug-log flusher.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
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
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

// P2-C1b: the 3 real generation actions now go through the async tasks API
// (submitEditTask/submitGenerationTask → pollTask → cancelTask) instead of the
// sync editMivoImage/generateMivoImage. The mock boundary moved from
// mivoImageClient to mivoTaskClient; assetBlobForNode (still in mivoImageClient)
// stays wired. Controlling submit/poll lets us exercise the task state machine
// (running → done/canceled/failed) without HTTP. vi.hoisted keeps the mock fns
// available to the vi.mock factory (which is hoisted above top-level declarations).
const mocks = vi.hoisted(() => ({
  submitEditTask: vi.fn(),
  submitGenerationTask: vi.fn(),
  pollTask: vi.fn(),
  cancelTask: vi.fn(),
  assetBlobForNode: vi.fn(),
}))

vi.mock('../lib/mivoTaskClient', () => ({
  submitEditTask: mocks.submitEditTask,
  submitGenerationTask: mocks.submitGenerationTask,
  pollTask: mocks.pollTask,
  cancelTask: mocks.cancelTask,
  taskPollIntervalMs: () => 0,
  kindForFailedTask: (error: string) =>
    /\btimeout\b|超时|timed[\s-]?out/i.test(error) ? 'upstream-timeout' : 'upstream-error',
}))

vi.mock('../lib/mivoImageClient', () => ({
  assetBlobForNode: mocks.assetBlobForNode,
  MivoImageRequestError: class MivoImageRequestError extends Error {
    kind: string
    constructor(message: string, kind: string) {
      super(message)
      this.name = 'MivoImageRequestError'
      this.kind = kind
    }
  },
}))

import { useCanvasStore } from './canvasStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// Helpers ---------------------------------------------------------------------

function committedImage() {
  return {
    blob: new Blob(['mock-image-bytes'], { type: 'image/png' }),
    title: 'Generated image 1',
    width: 300,
    height: 200,
  }
}

const {
  submitEditTask: mockSubmitEditTask,
  submitGenerationTask: mockSubmitGenerationTask,
  pollTask: mockPollTask,
  cancelTask: mockCancelTask,
  assetBlobForNode: mockAssetBlobForNode,
} = mocks

// A done-view payload the poll loop will resolve with on success. progress=100 +
// stage='done' + result.images matches the server's terminal shape.
const doneView = (images = [committedImage()]) => ({
  id: 't1',
  kind: 'edit' as const,
  status: 'done' as const,
  progress: 100,
  stage: 'done',
  requestId: 'req-1',
  model: 'gpt-image-2',
  result: { images },
})

const failedView = (error: string) => ({
  id: 't1',
  kind: 'edit' as const,
  status: 'failed' as const,
  progress: 50,
  stage: 'failed',
  requestId: 'req-1',
  model: 'gpt-image-2',
  error,
})

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

const aiSlotNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'slot-1',
  type: 'ai-slot',
  title: 'Slot',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  status: 'ready',
  ...overrides,
})

const annotationNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'anno-1',
  type: 'annotation',
  title: 'Annotation',
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  status: 'ready',
  text: 'make it blue',
  ...overrides,
})

const baseState = useCanvasStore.getState()

const seed = (overrides: Record<string, unknown> = {}) =>
  useCanvasStore.setState({ ...baseState, ...overrides } as never, true)

const seedCanvas = (sceneId: string, nodes: MivoCanvasNode[]) => {
  const document = { title: sceneId, nodes, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
  return {
    canvases: { [sceneId]: document },
    sceneId,
    nodes,
    edges: [],
    tasks: [],
    selectedNodeId: undefined,
    selectedNodeIds: [],
  }
}

const taskFor = (id: string) => useCanvasStore.getState().tasks.find((t) => t.id === id)

beforeEach(() => {
  useCanvasStore.setState({ ...baseState } as never, true)
  mockSubmitEditTask.mockReset().mockResolvedValue('t1')
  mockSubmitGenerationTask.mockReset().mockResolvedValue('t1')
  mockPollTask.mockReset().mockResolvedValue(doneView())
  mockCancelTask.mockReset().mockResolvedValue(undefined)
  mockAssetBlobForNode.mockReset().mockResolvedValue(new Blob(['mock-source-bytes'], { type: 'image/png' }))
})

// Tests -----------------------------------------------------------------------

describe('contract: generation action signatures', () => {
  it('generateImageEdit returns a Promise<string[]> (resolves to string[] on success)', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const result = useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat')
    expect(result).toBeInstanceOf(Promise)
    const nodeIds = await result
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.every((id) => typeof id === 'string')).toBe(true)
  })

  it('generateBesideNode returns a Promise<string[]>', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().generateBesideNode('n1', 'a cat')
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.length).toBeGreaterThan(0)
  })

  it('generateIntoAiSlot returns a Promise<string[]>', async () => {
    seed(seedCanvas('character-flow', [aiSlotNode({ id: 'slot-1' })]))
    const nodeIds = await useCanvasStore.getState().generateIntoAiSlot('slot-1', 'a cat')
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.length).toBeGreaterThan(0)
  })

  // P2-C2 will contractualize variations/annotation return values (currently void + mock).
  it('generateVariations returns void (mock adapter; P2-C2 will contract this to Promise<string[]>)', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const result = useCanvasStore.getState().generateVariations('n1')
    expect(result).toBeUndefined()
  })

  it('generateFromAnnotation returns void (mock adapter; P2-C2 will contract this to Promise<string[]>)', () => {
    seed({
      ...seedCanvas('character-flow', [imageNode({ id: 'n1' }), annotationNode({ id: 'anno-1', parentIds: ['n1'] })]),
      selectedNodeId: 'anno-1',
      selectedNodeIds: ['anno-1'],
    })
    const result = useCanvasStore.getState().generateFromAnnotation('anno-1')
    expect(result).toBeUndefined()
  })
})

describe('contract: generateImageEdit orchestration (mock network)', () => {
  it('success: task transitions running→done, result committed, derivation edge created', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat')

    // task ended 'done'
    const tasks = useCanvasStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('done')
    expect(tasks[0].nodeIds).toEqual(nodeIds)

    // result committed + edge
    const s = useCanvasStore.getState()
    expect(s.nodes.map((n) => n.id)).toContain(nodeIds[0])
    const edge = s.edges.find((e) => e.to === nodeIds[0])
    expect(edge?.from).toBe('n1')
    expect(edge?.type).toBe('edit')
  })

  it('cancel: an aborted signal marks the task canceled and rejects (no result committed)', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const controller = new AbortController()
    controller.abort()

    await expect(
      useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat', { signal: controller.signal }),
    ).rejects.toThrow()

    const tasks = useCanvasStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('canceled')
    expect(useCanvasStore.getState().nodes).toHaveLength(1) // only the source node, no result
    // Pre-abort short-circuits before submit — no server task is created.
    expect(mockSubmitEditTask).not.toHaveBeenCalled()
  })

  it('failure: a non-abort error marks the task failed and rejects', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    mockPollTask.mockResolvedValueOnce(failedView('upstream 500'))

    await expect(
      useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat'),
    ).rejects.toThrow(/upstream 500/)

    const tasks = useCanvasStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('failed')
    expect(useCanvasStore.getState().nodes).toHaveLength(1)
  })

  it('returns [] when no source is available (no network call)', async () => {
    seed(seedCanvas('character-flow', []))
    const nodeIds = await useCanvasStore.getState().generateImageEdit(undefined, 'prompt-edit', 'a cat')
    expect(nodeIds).toEqual([])
    expect(mockSubmitEditTask).not.toHaveBeenCalled()
  })

  it('cross-scene: sceneId option commits to the target scene, not the current one', async () => {
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

    const nodeIds = await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat', { sceneId: 'other-scene' })

    expect(nodeIds.length).toBeGreaterThan(0)
    expect(useCanvasStore.getState().canvases['other-scene']!.nodes.map((n) => n.id)).toContain(nodeIds[0])
    expect(useCanvasStore.getState().canvases['character-flow']!.nodes).toEqual([])
    // task landed on the target scene's document
    expect(useCanvasStore.getState().canvases['other-scene']!.tasks).toHaveLength(1)
    expect(useCanvasStore.getState().canvases['character-flow']!.tasks).toEqual([])
  })
})

describe('contract: generateBesideNode / generateIntoAiSlot orchestration', () => {
  it('generateBesideNode: success marks the task done and commits a result node', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().generateBesideNode('n1', 'a cat beside')
    expect(nodeIds.length).toBeGreaterThan(0)
    const tasks = useCanvasStore.getState().tasks
    expect(tasks[0].status).toBe('done')
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toContain(nodeIds[0])
  })

  it('generateIntoAiSlot: success marks the task done and commits a result node (uses submitGenerationTask for a slot)', async () => {
    seed(seedCanvas('character-flow', [aiSlotNode({ id: 'slot-1' })]))
    const nodeIds = await useCanvasStore.getState().generateIntoAiSlot('slot-1', 'fill the slot')
    expect(nodeIds.length).toBeGreaterThan(0)
    expect(useCanvasStore.getState().tasks[0].status).toBe('done')
    expect(mockSubmitGenerationTask).toHaveBeenCalled()
  })
})

describe('contract: task state machine (generation actions)', () => {
  // The CanvasTask status union is 'running' | 'queued' | 'failed' | 'done' | 'canceled'.
  // The 3 real generation actions create a 'running' task directly (no 'queued' is ever produced
  // by these actions — see quirk note in the PR description). Transitions exercised below:
  //   running → done     (success)
  //   running → canceled (abort)
  //   running → failed   (error)
  // No illegal transitions (e.g. done → running) are produced by the action paths.

  it('running → done on success', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat')
    expect(useCanvasStore.getState().tasks[0].status).toBe('done')
  })

  it('running → canceled on abort', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const controller = new AbortController()
    controller.abort()
    await expect(
      useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat', { signal: controller.signal }),
    ).rejects.toThrow()
    expect(useCanvasStore.getState().tasks[0].status).toBe('canceled')
  })

  it('running → failed on error', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    mockPollTask.mockResolvedValueOnce(failedView('boom'))
    await expect(
      useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat'),
    ).rejects.toThrow(/boom/)
    expect(useCanvasStore.getState().tasks[0].status).toBe('failed')
  })

  it('terminal tasks are not re-transitioned by a later action (no done→running regression)', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'first')
    const firstTaskId = useCanvasStore.getState().tasks[0].id
    expect(useCanvasStore.getState().tasks[0].status).toBe('done')

    // a second action creates a NEW task (different id); the first stays 'done'
    await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'second')
    const tasks = useCanvasStore.getState().tasks
    const firstTask = tasks.find((t) => t.id === firstTaskId)
    expect(firstTask?.status).toBe('done')
  })

  it('task list is capped at 5 (upsertTask keeps the most recent)', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    for (let i = 0; i < 7; i++) {
      await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', `p${i}`)
    }
    expect(useCanvasStore.getState().tasks.length).toBeLessThanOrEqual(5)
  })

  it('done task nodeIds are populated with the committed result ids', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat')
    expect(useCanvasStore.getState().tasks[0].nodeIds).toEqual(nodeIds)
    expect(taskFor(useCanvasStore.getState().tasks[0].id)?.progress).toBe(100)
  })
})

describe('contract: variations / annotation (mock adapter — P2-C2 will contract these)', () => {
  it('generateVariations produces 4 result nodes + derivation edges and switches to the variations tool', () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    useCanvasStore.getState().generateVariations('n1')

    const s = useCanvasStore.getState()
    // mockGenerationAdapter.generateVariations returns 4 nodes
    const resultNodes = s.nodes.filter((n) => n.sourceNodeId === 'n1')
    expect(resultNodes).toHaveLength(4)
    expect(s.edges.filter((e) => e.from === 'n1')).toHaveLength(4)
    expect(s.activeTool).toBe('variations')
    expect(s.tasks).toHaveLength(1)
  })

  it('generateFromAnnotation produces a result node with an edit edge (mock)', () => {
    seed({
      ...seedCanvas('character-flow', [imageNode({ id: 'n1' }), annotationNode({ id: 'anno-1', parentIds: ['n1'] })]),
      selectedNodeId: 'anno-1',
      selectedNodeIds: ['anno-1'],
    })
    useCanvasStore.getState().generateFromAnnotation('anno-1')

    const s = useCanvasStore.getState()
    const resultNode = s.nodes.find((n) => n.aiWorkflow?.operation === 'annotation-edit')
    expect(resultNode).toBeDefined()
    expect(s.edges.some((e) => e.type === 'edit')).toBe(true)
    expect(s.tasks[0].status).toBe('done')
  })

  it('generateVariations is a no-op when there is no source node', () => {
    seed(seedCanvas('character-flow', []))
    useCanvasStore.getState().generateVariations()
    expect(useCanvasStore.getState().nodes).toHaveLength(0)
    expect(useCanvasStore.getState().tasks).toHaveLength(0)
  })
})
