// src/canvas/actions/canvasSyncRuntime.block3.test.ts
// T2.2 Block 3 — deferred-kinds server-wire 验收矩阵(import / generate-result / failedSlots
// 经 getSceneWrap() → wrapMutationForScene → submitChange)。十条 server 档矩阵逐条测试化。
//
// 复用 canvasSyncRuntimeTestFactories.loadRuntimeModule(server 模式 + submitChange /
// enqueueAssetAttach / enqueueAssetDetach spy + 真 serverAssetIdFromUrl),并叠 assetStorage /
// mivoTaskClient / mivoImageClient mock(同 generation.contract.test.ts 边界)以驱动
// commitGenerationResult / generateVariations。local 档用 loadRuntimeModule({ local: true })。
//
// 覆盖映射(lead 派工 deferred-kinds 全清单):
//  ①②③  注册表 fail-visible + boot 注册(C 方案注册表机制)
//  ④⑤⑥⑦ import 路径(nodeCreationSlice.addImportedFileNode / addImportedImage)
//  ⑧⑨⑩  commitGenerationResult set 段(create-node / replace-slot edit-node / local gate)
//        —— 5 个 generate* 变体的 success commit 全经 commitGenerationResult(此处⑧⑨间接覆盖);
//        chatTaskReconcile.reconcileExpiredChatTasks 的 commit 亦经 commitGenerationResult(同)。
//  ⑪    generateVariations 失败槽位(失败路径 node-create,无 attach);
//        generateIntoAiSlot 失败删 slot 已由 canvasSyncRuntime.block1.test.ts(Block 1)覆盖。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import { loadRuntimeModule } from './canvasSyncRuntimeTestFactories'

vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
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
  if (g.window === undefined) g.window = { localStorage }
  if (g.localStorage === undefined) g.localStorage = localStorage
})

vi.mock('../../lib/demoImages', () => ({ createDemoImage: () => 'data:image/png;base64,mock-demo' }))
vi.mock('../../store/remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))

// mivoTaskClient / mivoImageClient / assetStorage mock 边界(同 generation.contract.test.ts)
const mocks = vi.hoisted(() => ({
  saveGeneratedAsset: vi.fn(),
  submitEditTask: vi.fn(),
  submitGenerationTask: vi.fn(),
  submitVariationsTask: vi.fn(),
  pollTask: vi.fn(),
  cancelTask: vi.fn(),
  assetBlobForNode: vi.fn(),
}))

vi.mock('../../lib/assetStorage', () => ({
  saveGeneratedAsset: mocks.saveGeneratedAsset,
  saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imported' })),
  readImportedAssetFile: vi.fn(),
}))
vi.mock('../../lib/mivoTaskClient', () => ({
  submitEditTask: mocks.submitEditTask,
  submitGenerationTask: mocks.submitGenerationTask,
  submitVariationsTask: mocks.submitVariationsTask,
  pollTask: mocks.pollTask,
  cancelTask: mocks.cancelTask,
  taskPollIntervalMs: () => 0,
  kindForFailedTask: () => 'upstream-error' as const,
}))
vi.mock('../../lib/mivoImageClient', () => ({
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

// ── fixtures ──
const imageNode = (o: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  assetUrl: '/a.png',
  ...o,
})
const aiSlotNode = (o: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'slot-1',
  type: 'ai-slot',
  title: 'Slot',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  status: 'ready',
  generation: { prompt: 'a cat', model: 'Mivo Mock Image Workflow', size: '200x200', seed: 1 },
  aiWorkflow: { kind: 'slot', status: 'empty', operation: 'slot-generation', prompt: 'a cat', placement: 'slot', createdAt: 1 },
  ...o,
})

const committedImage = () => ({
  blob: new Blob(['mock-bytes'], { type: 'image/png' }),
  title: 'Gen 1',
  width: 300,
  height: 200,
})
const doneView = (images = [committedImage()]) => ({
  id: 't1',
  kind: 'edit' as const,
  status: 'done' as const,
  progress: 100,
  stage: 'done',
  requestId: 'r1',
  model: 'gpt-image-2',
  result: { images },
})
const partialView = (
  images: Array<{ blob?: Blob; variationIndex?: number }>,
  failures: Array<{ variationIndex: number; error: string }>,
) => ({
  id: 't1',
  kind: 'variations' as const,
  status: 'partial' as const,
  progress: 100,
  stage: 'done',
  requestId: 'r1',
  model: 'gpt-image-2',
  result: { images },
  failures,
})

const seedCanvas = (sceneId: string, nodes: MivoCanvasNode[]) => ({
  canvases: {
    [sceneId]: { title: sceneId, nodes, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
  },
  sceneId,
  nodes,
  edges: [],
  tasks: [],
  selectedNodeId: undefined,
  selectedNodeIds: [],
})

const SCENE = 'character-flow'
// server 资产 assetUrl(mivo-sasset: 前缀 → serverAssetId 剥得 'asset-gen' → enqueueAssetAttach)
const SERVER_ASSET_URL = 'mivo-sasset:asset-gen'

type RuntimeHandle = Awaited<ReturnType<typeof loadRuntimeModule>>

describe('T2.2 Block 3 — deferred-kinds server-wire 验收矩阵', () => {
  let handle: RuntimeHandle
  let useCanvasStore: RuntimeHandle['useCanvasStore']
  let submitChange: RuntimeHandle['submitChange']
  let enqueueAssetAttach: RuntimeHandle['enqueueAssetAttach']
  let baseState: ReturnType<RuntimeHandle['useCanvasStore']['getState']>
  let resetQueue: RuntimeHandle['__resetCanvasSyncRuntimeQueue']

  beforeEach(async () => {
    vi.clearAllMocks()
    handle = await loadRuntimeModule({ local: false })
    useCanvasStore = handle.useCanvasStore
    submitChange = handle.submitChange
    enqueueAssetAttach = handle.enqueueAssetAttach
    resetQueue = handle.__resetCanvasSyncRuntimeQueue
    baseState = useCanvasStore.getInitialState()
    mocks.saveGeneratedAsset.mockReset().mockResolvedValue({
      assetUrl: SERVER_ASSET_URL,
      name: 'gen.png',
      type: 'image/png',
      sizeBytes: 1,
      hasTransparency: false,
      size: '300x200',
      sourceDimensions: { width: 300, height: 200 },
    })
    mocks.submitGenerationTask.mockReset().mockResolvedValue('t1')
    mocks.submitEditTask.mockReset().mockResolvedValue('t1')
    mocks.submitVariationsTask.mockReset().mockResolvedValue({ taskId: 't1', batchId: 'b1', count: 4 })
    mocks.pollTask.mockReset().mockResolvedValue(doneView())
    mocks.cancelTask.mockReset().mockResolvedValue(undefined)
    mocks.assetBlobForNode.mockReset().mockResolvedValue(new Blob(['src'], { type: 'image/png' }))
  })

  const seed = (overrides: Record<string, unknown> = {}) =>
    useCanvasStore.setState({ ...baseState, ...overrides } as never, true)
  // wrapMutationForScene 内 void enqueueCanvasSyncChanges(...) 是 fire-and-forget Promise 链;
  // flush microtask 让 submitChanges 跑完。⑪ 有 2 个串行 batch(commitGenerationResult + failedSlots),
  // 需多 flush(同 canvasSyncRuntime.asseturldiff.test.ts 的 Promise.resolve 套路,放量兜底多 batch)。
  const flushSubmit = async () => {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve()
    }
  }
  const submitChangeKinds = () => submitChange.mock.calls.map((c) => (c[1] as { kind: string }).kind)

  // ── 注册表 fail-visible + boot 注册(①②③)──────────────────────────────────────
  it('① registry 空 + server 模式 → getSceneWrap passthrough 留 debugLogger.error 痕迹(不静默吞同步)', async () => {
    vi.resetModules()
    vi.doMock('../../lib/persistMode', () => ({ isLocalPersist: false }))
    const { getSceneWrap } = await import('../../lib/sceneWrapRegistry')
    const { useDebugLogStore } = await import('../../store/debugLogStore')
    const before = useDebugLogStore.getState().entries.length
    let ran = false
    getSceneWrap()(SCENE, () => {
      ran = true
    })
    expect(ran).toBe(true) // 本地态 mutate 仍跑(不阻塞)
    const after = useDebugLogStore.getState().entries
    expect(after.length).toBeGreaterThan(before)
    expect(after[0].level).toBe('error')
    expect(after[0].message).toContain('registry empty')
  })

  it('② registry 空 + local 模式 → passthrough 正常 mutate,无 error(与 isLocalPersist gate 对称)', async () => {
    vi.resetModules()
    vi.doMock('../../lib/persistMode', () => ({ isLocalPersist: true }))
    const { getSceneWrap } = await import('../../lib/sceneWrapRegistry')
    const { useDebugLogStore } = await import('../../store/debugLogStore')
    const before = useDebugLogStore.getState().entries.length
    let ran = false
    getSceneWrap()(SCENE, () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(useDebugLogStore.getState().entries.length).toBe(before) // 无新 error
  })

  it('③ registerSceneWrap(fn) → getSceneWrap() 返回该 fn(注册表机制 round-trip)', async () => {
    vi.resetModules()
    vi.doMock('../../lib/persistMode', () => ({ isLocalPersist: false }))
    const { registerSceneWrap, getSceneWrap } = await import('../../lib/sceneWrapRegistry')
    const spy = vi.fn()
    registerSceneWrap((sceneId, mutate) => {
      spy(sceneId)
      mutate()
    })
    getSceneWrap()(SCENE, () => {})
    expect(spy).toHaveBeenCalledWith(SCENE)
  })

  // ── import 路径(nodeCreationSlice.addImportedFileNode / addImportedImage)──────────
  // ④ 亦验证 boot side-effect:loadRuntimeModule(server)导入 canvasSyncRuntime → registerSceneWrap 跑;
  //    若未注册,server 模式 addImportedFileNode 会走 passthrough(error + 不 submit),本测 submitChange 必不命中。
  it('④ addImportedFileNode(server)+server assetUrl → submitChange create-node + enqueueAssetAttach(boot 注册已就位)', async () => {
    seed(seedCanvas(SCENE, []))
    useCanvasStore.getState().addImportedFileNode('image', SERVER_ASSET_URL, 'Imp', 'source', { x: 0, y: 0 })
    await flushSubmit()
    expect(submitChange).toHaveBeenCalled()
    const change = submitChange.mock.calls[0][1] as { kind: string; node: { id: string; asset?: { url: string } } }
    expect(change.kind).toBe('create-node')
    expect(change.node.asset?.url).toBe(SERVER_ASSET_URL)
    expect(enqueueAssetAttach).toHaveBeenCalledWith(SCENE, 'asset-gen', change.node.id)
    resetQueue()
  })

  it('⑤ addImportedFileNode(server)+非 server assetUrl → submitChange create-node,无 enqueueAssetAttach', async () => {
    seed(seedCanvas(SCENE, []))
    useCanvasStore.getState().addImportedFileNode('image', '/local/path.png', 'Imp', 'source', { x: 0, y: 0 })
    await flushSubmit()
    expect(submitChange).toHaveBeenCalled()
    expect(submitChangeKinds()).toContain('create-node') // 空 canvas 导入还可能含 reorder-children,放宽
    expect(enqueueAssetAttach).not.toHaveBeenCalled()
    resetQueue()
  })

  it('⑥ addImportedFileNode(local)→ 不 submitChange(gate 短路,零行为变化)', async () => {
    const local = await loadRuntimeModule({ local: true })
    local.useCanvasStore.setState({ ...local.useCanvasStore.getInitialState(), ...seedCanvas(SCENE, []) } as never, true)
    local.useCanvasStore.getState().addImportedFileNode('image', SERVER_ASSET_URL, 'Imp', 'source', { x: 0, y: 0 })
    await flushSubmit()
    expect(local.submitChange).not.toHaveBeenCalled()
    expect(local.enqueueAssetAttach).not.toHaveBeenCalled()
    local.__resetCanvasSyncRuntimeQueue()
  })

  it('⑦ addImportedImage 委派 addImportedFileNode → submitChange create-node 命中(覆盖委派路径)', async () => {
    seed(seedCanvas(SCENE, []))
    useCanvasStore.getState().addImportedImage(SERVER_ASSET_URL, 'Imp')
    await flushSubmit()
    expect(submitChange).toHaveBeenCalled()
    expect(submitChangeKinds()).toContain('create-node')
    expect(enqueueAssetAttach).toHaveBeenCalledWith(SCENE, 'asset-gen', expect.any(String))
    resetQueue()
  })

  // ── commitGenerationResult set 段(⑧⑨⑩)────────────────────────────────────────
  // 5 个 generate* 变体的 success commit 全经 commitGenerationResult → ⑧⑨间接覆盖;
  // chatTaskReconcile.reconcileExpiredChatTasks 的 commit(sceneId 锚定)亦经 commitGenerationResult → 同覆盖。
  it('⑧ commitGenerationResult(server)create-node 路径(sourceNodeId)→ submitChange create-node + create-edge + enqueueAssetAttach', async () => {
    seed(seedCanvas(SCENE, [imageNode({ id: 'n1' })]))
    const nodeIds = await useCanvasStore.getState().commitGenerationResult({
      sceneId: SCENE,
      sourceNodeId: 'n1',
      resultImages: [committedImage()],
      prompt: 'a cat',
      model: 'gpt-image-2',
      kind: 'generate',
    })
    await flushSubmit()
    expect(nodeIds.length).toBe(1)
    const kinds = submitChangeKinds()
    expect(kinds).toContain('create-node') // 结果图 node
    expect(kinds).toContain('create-edge') // derivation edge n1 → 结果
    const createCall = submitChange.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === 'create-node',
    )
    const createdId = (createCall![1] as { node: { id: string } }).node.id
    expect(enqueueAssetAttach).toHaveBeenCalledWith(SCENE, 'asset-gen', createdId)
    resetQueue()
  })

  it('⑨ commitGenerationResult(server)replace-slot 路径 → submitChange edit-node(assetUrl diff)+ enqueueAssetAttach', async () => {
    seed(seedCanvas(SCENE, [aiSlotNode({ id: 'slot-1' })]))
    const nodeIds = await useCanvasStore.getState().commitGenerationResult({
      sceneId: SCENE,
      replaceSlotId: 'slot-1',
      resultImages: [committedImage()],
      prompt: 'a cat',
      model: 'gpt-image-2',
      kind: 'generate',
    })
    await flushSubmit()
    expect(nodeIds).toEqual(['slot-1']) // slot 原位替换,result id = slot id
    expect(submitChangeKinds()).toContain('edit-node') // slot ai-slot→image + assetUrl undefined→server
    expect(enqueueAssetAttach).toHaveBeenCalledWith(SCENE, 'asset-gen', 'slot-1') // 旧无→新有
    resetQueue()
  })

  it('⑩ commitGenerationResult(local)→ 不 submitChange(gate 短路,零行为变化)', async () => {
    const local = await loadRuntimeModule({ local: true })
    local.useCanvasStore.setState(
      { ...local.useCanvasStore.getInitialState(), ...seedCanvas(SCENE, [imageNode({ id: 'n1' })]) } as never,
      true,
    )
    await local.useCanvasStore.getState().commitGenerationResult({
      sceneId: SCENE,
      sourceNodeId: 'n1',
      resultImages: [committedImage()],
      prompt: 'a cat',
      model: 'gpt-image-2',
      kind: 'generate',
    })
    await flushSubmit()
    expect(local.submitChange).not.toHaveBeenCalled()
    expect(local.enqueueAssetAttach).not.toHaveBeenCalled()
    local.__resetCanvasSyncRuntimeQueue()
  })

  // ── generateVariations 失败槽位(⑪,失败路径 node-create)──────────────────────
  it('⑪ generateVariations partial → failedSlots 经 wrap → submitChange create-node(失败槽位,无 attach)', async () => {
    mocks.pollTask.mockResolvedValue(
      partialView(
        [{ blob: new Blob(['ok'], { type: 'image/png' }), variationIndex: 0 }],
        [{ variationIndex: 1, error: 'boom' }],
      ),
    )
    seed(seedCanvas(SCENE, [imageNode({ id: 'n1' })]))
    await useCanvasStore.getState().generateVariations('n1', undefined, {})
    await flushSubmit()
    const createNodeCalls = submitChange.mock.calls.filter(
      (c) => (c[1] as { kind: string }).kind === 'create-node',
    )
    // success 结果(create-node + 有 server asset)+ 失败槽位(create-node + 无 asset)≥ 2 个 create-node
    expect(createNodeCalls.length).toBeGreaterThanOrEqual(2)
    // 失败槽位 = 无 asset.url 的 create-node(createFailedVariationSlot 的 ai-slot 无 asset)
    const noAssetCreate = createNodeCalls.filter(
      (c) => !(c[1] as { node: { asset?: { url?: string } } }).node.asset?.url,
    )
    expect(noAssetCreate.length).toBeGreaterThanOrEqual(1)
    const failedNodeIds = noAssetCreate.map(
      (c) => (c[1] as { node: { id: string } }).node.id,
    )
    // success 结果有 server asset → attach 命中(asset-gen)
    expect(enqueueAssetAttach).toHaveBeenCalledWith(SCENE, 'asset-gen', expect.any(String))
    // 失败槽位无 server asset → 不触发 attach(其 nodeId 不在 attach 调用里)
    const attachedIds = new Set(enqueueAssetAttach.mock.calls.map((c) => c[2] as string))
    for (const id of failedNodeIds) {
      expect(attachedIds.has(id)).toBe(false)
    }
    resetQueue()
  })
})
