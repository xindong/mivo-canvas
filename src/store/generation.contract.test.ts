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
  submitVariationsTask: vi.fn(),
  pollTask: vi.fn(),
  cancelTask: vi.fn(),
  assetBlobForNode: vi.fn(),
}))

vi.mock('../lib/mivoTaskClient', () => ({
  submitEditTask: mocks.submitEditTask,
  submitGenerationTask: mocks.submitGenerationTask,
  submitVariationsTask: mocks.submitVariationsTask,
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
import { generationFacade } from './generationFacade'
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
  submitVariationsTask: mockSubmitVariationsTask,
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

// P2-C2: partial-view payload for variations (some success + some failure). The
// success subset travels in result.images (with variationIndex); the failed
// subset in failures[] (with variationIndex + desensitized error). partial does
// NOT reject — the action resolves the success subset. Images accept blob OR b64
// (committedImage() carries blob; runtime carries b64) — commitGenerationResult
// handles both via blobFromCommittedGenerationImage.
const partialView = (
  images: Array<{ b64?: string; blob?: Blob; variationIndex?: number }>,
  failures: Array<{ variationIndex: number; error: string }>,
) => ({
  id: 't1',
  kind: 'variations' as const,
  status: 'partial' as const,
  progress: 100,
  stage: 'done',
  requestId: 'req-1',
  model: 'gpt-image-2',
  result: { images },
  failures,
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
  mockSubmitVariationsTask.mockReset().mockResolvedValue({ taskId: 't1', batchId: 'b1', count: 4 })
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

    // Strengthened binding (rev-verify top-3 weakest): each returned id is a real
    // result node in the target scene, sourced from n1, with a derivation edge
    // from n1, and the associated task reached terminal 'done' carrying exactly
    // these nodeIds (not just "is a string array").
    const s = useCanvasStore.getState()
    nodeIds.forEach((id) => {
      const node = s.nodes.find((n) => n.id === id)
      expect(node).toBeDefined()
      expect(node?.sourceNodeId).toBe('n1')
    })
    expect(s.edges.filter((e) => nodeIds.includes(e.to) && e.from === 'n1')).toHaveLength(nodeIds.length)
    expect(s.tasks[0]?.status).toBe('done')
    expect(s.tasks[0]?.nodeIds).toEqual(nodeIds)
  })

  it('generateBesideNode returns a Promise<string[]>', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().generateBesideNode('n1', 'a cat')
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.length).toBeGreaterThan(0)

    // Strengthened binding: result node is sourced from n1 + placed on the
    // source's right side (chooseAdjacentPlacement 'right' → x = source.x +
    // source.width + margin, so x ≥ source.x + source.width) + a 'generate'
    // derivation edge from n1 + task 'done'.
    const s = useCanvasStore.getState()
    const source = s.nodes.find((n) => n.id === 'n1')
    expect(source).toBeDefined()
    nodeIds.forEach((id) => {
      const node = s.nodes.find((n) => n.id === id)
      expect(node).toBeDefined()
      expect(node?.sourceNodeId).toBe('n1')
      expect(node?.x).toBeGreaterThanOrEqual(source!.x + source!.width)
    })
    expect(
      s.edges.filter((e) => nodeIds.includes(e.to) && e.from === 'n1' && e.type === 'generate'),
    ).toHaveLength(nodeIds.length)
    expect(s.tasks[0]?.status).toBe('done')
  })

  it('generateIntoAiSlot returns a Promise<string[]>', async () => {
    seed(seedCanvas('character-flow', [aiSlotNode({ id: 'slot-1' })]))
    const nodeIds = await useCanvasStore.getState().generateIntoAiSlot('slot-1', 'a cat')
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.length).toBeGreaterThan(0)

    // Slot results replace the slot in place and must not keep a self lineage
    // (sourceNodeId/parentIds/edge from slot-1 to slot-1).
    const s = useCanvasStore.getState()
    expect(nodeIds).toEqual(['slot-1'])
    nodeIds.forEach((id) => {
      const node = s.nodes.find((n) => n.id === id)
      expect(node).toBeDefined()
      expect(node?.type).toBe('image')
      expect(node?.sourceNodeId).toBeUndefined()
      expect(node?.parentIds).toBeUndefined()
    })
    expect(s.edges.filter((e) => nodeIds.includes(e.to) && e.from === 'slot-1')).toHaveLength(0)
    const result = s.nodes.find((n) => n.id === 'slot-1')
    expect(result?.aiWorkflow?.status).toBe('ready')
    expect(s.tasks[0]?.status).toBe('done')
  })

  // P2-C2: variations/annotation now return Promise<string[]> (de-mocked → async
  // tasks API), matching the other 3 generation actions.
  it('generateVariations returns a Promise<string[]>', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const result = useCanvasStore.getState().generateVariations('n1')
    expect(result).toBeInstanceOf(Promise)
    const nodeIds = await result
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.every((id) => typeof id === 'string')).toBe(true)
  })

  it('generateFromAnnotation returns a Promise<string[]>', async () => {
    seed({
      ...seedCanvas('character-flow', [imageNode({ id: 'n1' }), annotationNode({ id: 'anno-1', parentIds: ['n1'] })]),
      selectedNodeId: 'anno-1',
      selectedNodeIds: ['anno-1'],
    })
    const result = useCanvasStore.getState().generateFromAnnotation('anno-1')
    expect(result).toBeInstanceOf(Promise)
    const nodeIds = await result
    expect(Array.isArray(nodeIds)).toBe(true)
    expect(nodeIds.every((id) => typeof id === 'string')).toBe(true)
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
    // P1 fix: progress preserved at the last observed sample (0 — never polled),
    // not hardcoded 100 (server contract: 取消停在最后值).
    expect(tasks[0].progress).toBeLessThan(100)
    expect(tasks[0].progress).toBe(0)
  })

  it('cancel preserves the last observed progress (not hardcoded 100)', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    const controller = new AbortController()
    // 1st poll returns running(60) AND aborts. The loop's top-check already passed
    // (signal not yet aborted), so the poll lands + patchRunning(60) commits the
    // sample. The subsequent sleep(0, aborted) hits sleep's aborted branch (rejects
    // canceled without touching window.setTimeout) → loop throws. The live task's
    // last sample was 60, so canceledTask preserves progress=60.
    mockPollTask.mockImplementation(async () => {
      controller.abort()
      return { id: 't1', kind: 'edit', status: 'running', progress: 60, stage: 'poll', requestId: 'r', model: 'gpt-image-2' }
    })

    const promise = useCanvasStore.getState().generateImageEdit('n1', 'prompt-edit', 'a cat', { signal: controller.signal })
    await expect(promise).rejects.toThrow()

    const task = useCanvasStore.getState().tasks[0]
    expect(task.status).toBe('canceled')
    // P1 fix (rev-behavior): progress preserved at the last observed sample (60),
    // not hardcoded 100. Without the fix (progress:100 in canceledTask) this would
    // be 100; with the stale runningTask (progress 0) it would be 0 — both wrong.
    expect(task.progress).toBe(60)
    expect(task.progress).toBeLessThan(100)
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

  it('generateIntoAiSlot: undo after success returns to the ready empty slot', async () => {
    seed(seedCanvas('character-flow', [aiSlotNode({ id: 'slot-1', x: 12, y: 24 })]))

    const nodeIds = await useCanvasStore.getState().generateIntoAiSlot('slot-1', 'fill the slot')

    expect(nodeIds).toEqual(['slot-1'])
    let node = useCanvasStore.getState().nodes.find((item) => item.id === 'slot-1')
    expect(node?.type).toBe('image')
    expect(useCanvasStore.getState().historyPast).toHaveLength(1)

    useCanvasStore.getState().undo()
    node = useCanvasStore.getState().nodes.find((item) => item.id === 'slot-1')
    expect(node?.type).toBe('ai-slot')
    expect(node?.aiWorkflow?.status).not.toBe('generating')
    expect(useCanvasStore.getState().nodes.filter((item) => item.type === 'image')).toHaveLength(0)
  })

  it('generateIntoAiSlot: failure removes the placeholder via the generation baseline', async () => {
    seed(seedCanvas('character-flow', [aiSlotNode({ id: 'slot-1', x: 12, y: 24 })]))
    mockPollTask.mockResolvedValueOnce(failedView('boom'))

    await expect(useCanvasStore.getState().generateIntoAiSlot('slot-1', 'fill the slot')).rejects.toThrow(/boom/)

    const state = useCanvasStore.getState()
    expect(state.nodes.some((node) => node.id === 'slot-1')).toBe(false)
    expect(state.nodes.some((node) => node.aiWorkflow?.status === 'failed')).toBe(false)
    expect(state.tasks.some((task) => task.status === 'failed')).toBe(false)
    expect(state.historyPast).toHaveLength(0)
    expect(state.historyFuture).toHaveLength(0)
  })

  it('generateIntoAiSlot: cancellation removes the placeholder via the generation baseline', async () => {
    seed(seedCanvas('character-flow', [aiSlotNode({ id: 'slot-1' })]))
    const controller = new AbortController()
    controller.abort()

    await expect(
      useCanvasStore.getState().generateIntoAiSlot('slot-1', 'fill the slot', { signal: controller.signal }),
    ).rejects.toThrow()

    const state = useCanvasStore.getState()
    expect(state.nodes.some((node) => node.id === 'slot-1')).toBe(false)
    expect(state.nodes.some((node) => node.aiWorkflow?.status === 'canceled')).toBe(false)
    expect(state.historyPast).toHaveLength(0)
    expect(state.historyFuture).toHaveLength(0)
  })

  it('chat-created slot: failure removes the slot without popping the pre-slot baseline', async () => {
    // S01: chat 路径新建槽位时 generationFacade 传 skipSlotHistoryBaseline →
    // generateIntoAiSlot 不 captureHistory、baselineSnapshot=undefined → 失败时
    // 跳过 rollback 走 filter-removal：删槽位但保留 prepareChatSlot 推入的 pre-slot
    // 基线与 historyFuture（旧语义会 pop 基线并清空 historyFuture）。
    seed(seedCanvas('character-flow', []))
    const prep = generationFacade.prepareChatSlot({
      sceneId: 'character-flow',
      hasSelectedImage: false,
      prompt: 'fill the slot',
    })
    // prepareChatSlot 的 addAiSlotNode({ history: true }) 在活跃画布上 push 了 pre-slot 基线
    expect(useCanvasStore.getState().historyPast).toHaveLength(1)
    // 注入 sentinel 到 historyFuture：旧 rollback 路径会清空它，filter-removal 不会
    const futureSentinel = {
      version: 2 as const,
      sceneId: 'character-flow',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    }
    useCanvasStore.setState({ historyFuture: [futureSentinel] })
    mockPollTask.mockResolvedValueOnce(failedView('boom'))

    await expect(
      generationFacade.generateIntoAiSlot(prep.slotId, 'fill the slot', { sceneId: 'character-flow' }),
    ).rejects.toThrow(/boom/)

    const state = useCanvasStore.getState()
    expect(state.nodes.some((node) => node.id === prep.slotId)).toBe(false)
    expect(state.historyPast).toHaveLength(1) // pre-slot 基线保留（未被 pop）
    expect(state.historyFuture).toHaveLength(1) // sentinel 存活 → 失败路径未清空
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

describe('contract: variations / annotation (P2-C2 de-mocked → async tasks API)', () => {
  it('generateVariations resolves with result nodeIds + commits derivation edges + done task', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    mockPollTask.mockResolvedValueOnce(
      doneView([committedImage(), committedImage(), committedImage(), committedImage()]),
    )
    const nodeIds = await useCanvasStore.getState().generateVariations('n1')
    expect(nodeIds).toHaveLength(4)
    const s = useCanvasStore.getState()
    expect(s.edges.filter((e) => e.from === 'n1')).toHaveLength(4)
    expect(s.tasks[0].status).toBe('done')
    expect(mockSubmitVariationsTask).toHaveBeenCalledWith(
      expect.objectContaining({ variations: expect.any(Array) }),
    )
  })

  it('generateVariations partial (2 success + 1 failure) resolves the success subset + creates a visible failed slot', async () => {
    seed(seedCanvas('character-flow', [imageNode({ id: 'n1' })]))
    mockPollTask.mockResolvedValueOnce(
      partialView(
        [{ ...committedImage(), variationIndex: 0 }, { ...committedImage(), variationIndex: 1 }],
        [{ variationIndex: 2, error: 'Upstream error (500)' }],
      ),
    )
    const nodeIds = await useCanvasStore.getState().generateVariations('n1', [
      { prompt: 'p0' },
      { prompt: 'p1' },
      { prompt: 'p2' },
    ])
    // partial does NOT reject — resolves the success subset (2 of 3).
    expect(nodeIds).toHaveLength(2)
    const s = useCanvasStore.getState()
    // 失败槽位可见: a failed ai-slot node for the failed variation.
    const failedSlots = s.nodes.filter((n) => n.type === 'ai-slot' && n.status === 'failed')
    expect(failedSlots).toHaveLength(1)
    // partial resolves → done task carrying the success nodeIds.
    expect(s.tasks[0].status).toBe('done')
    expect(s.tasks[0].nodeIds).toEqual(nodeIds)
  })

  it('generateFromAnnotation resolves with a result node + edit edge + done task', async () => {
    seed({
      ...seedCanvas('character-flow', [imageNode({ id: 'n1' }), annotationNode({ id: 'anno-1', parentIds: ['n1'] })]),
      selectedNodeId: 'anno-1',
      selectedNodeIds: ['anno-1'],
    })
    const nodeIds = await useCanvasStore.getState().generateFromAnnotation('anno-1')
    expect(nodeIds).toHaveLength(1)
    const s = useCanvasStore.getState()
    expect(s.edges.some((e) => e.type === 'edit')).toBe(true)
    expect(s.tasks[0].status).toBe('done')
  })

  it('generateVariations rejects when there is no source image', async () => {
    seed(seedCanvas('character-flow', []))
    await expect(useCanvasStore.getState().generateVariations()).rejects.toThrow(/没有可用的源图/)
    expect(useCanvasStore.getState().tasks).toHaveLength(0)
  })
})
