// T2.2 Block 1(F1 + F2):ai-slot 占位落 server + rollback 接 delete-node 的行为测试。
// 从 canvasSyncRuntime.test.ts 拆出独立文件(避免该文件 >900 行触发 structure-guard)。
// 自带 harness(含 mivoTaskClient/mivoImageClient/assetStorage mock,使 generateIntoAiSlot
// 可编排失败/取消)。验:chat slot(prepareChatSlot create)+ mask-edit slot(prepareMaskEditPlaceholder
// create+reflow)经 wrapMutationForScene → server create-node;失败/取消 rollback → delete-node:
//   - mask-edit:removeMaskEditPlaceholder(rollback setState 同包 wrap)
//   - chat:generateIntoAiSlot catch 删 slot 经注入的 onSceneMutation(F1,generationFacade 注入,
//     避 generationSlice→canvasSyncRuntime 静态环)
// retry 在真实失败后(slot 已删)→ 新建 slot(新 id);local 模式 gate 不发。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasActionRuntime } from './canvasActionTypes'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import type { CanvasChange, ChangeOutcome } from '../../lib/canvasSyncPort'

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

type MockTaskView = {
  id: string
  kind: string
  status: string
  progress: number
  stage: string
  requestId: string
  model: string
  result?: { images: Array<{ blob: Blob; title: string; width: number; height: number }> }
  error?: string
}

const doneView = (): MockTaskView => ({
  id: 't1',
  kind: 'edit',
  status: 'done',
  progress: 100,
  stage: 'done',
  requestId: 'req-1',
  model: 'gpt-image-2',
  result: { images: [{ blob: new Blob(['mock-img'], { type: 'image/png' }), title: 'g', width: 10, height: 10 }] },
})

const failedView = (error: string): MockTaskView => ({
  id: 't1',
  kind: 'edit',
  status: 'failed',
  progress: 50,
  stage: 'failed',
  requestId: 'req-1',
  model: 'gpt-image-2',
  error,
})

const loadRuntimeModule = async (
  options: {
    local?: boolean
    submitChangeImpl?: (canvasId: string, change: CanvasChange) => Promise<ChangeOutcome>
  } = {},
) => {
  vi.resetModules()
  const submitChange = vi.fn(
    options.submitChangeImpl ??
      (async () => ({
        kind: 'accepted' as const,
        cursor: 'cursor' as never,
      })),
  )
  vi.doMock('../../lib/persistMode', () => ({
    isLocalPersist: options.local ?? false,
  }))
  vi.doMock('../../lib/canvasSyncPortClient', () => ({
    getCanvasSyncPort: () => ({ submitChange }),
    abortPendingCanvasSyncCreate: () => false,
    persistMode: options.local ? 'local' : 'server',
  }))
  const realAssetWiring = await import('../../lib/assetAttachWiring')
  const enqueueAssetAttach = vi.fn()
  const enqueueAssetDetach = vi.fn()
  vi.doMock('../../lib/assetAttachWiring', () => ({
    serverAssetIdFromUrl: realAssetWiring.serverAssetIdFromUrl,
    enqueueAssetAttach,
    enqueueAssetDetach,
  }))
  // mock 生成任务客户端 + image client + asset storage,使 generateIntoAiSlot 可编排失败/取消(无真实 HTTP)。
  const submitGenerationTask = vi.fn(async () => 't1')
  const submitEditTask = vi.fn(async () => 't1')
  const pollTask = vi.fn(async (): Promise<MockTaskView> => doneView())
  const cancelTask = vi.fn(async () => undefined)
  vi.doMock('../../lib/mivoTaskClient', () => ({
    submitGenerationTask,
    submitEditTask,
    submitVariationsTask: vi.fn(async () => ({ taskId: 't1', batchId: 'b1', count: 4 })),
    pollTask,
    cancelTask,
    taskPollIntervalMs: () => 0,
    kindForFailedTask: () => 'upstream-error',
  }))
  vi.doMock('../../lib/mivoImageClient', () => ({
    assetBlobForNode: vi.fn(async () => new Blob(['mock-source'], { type: 'image/png' })),
    MivoImageRequestError: class MivoImageRequestError extends Error {
      kind: string
      constructor(message: string, kind: string) {
        super(message)
        this.name = 'MivoImageRequestError'
        this.kind = kind
      }
    },
  }))
  vi.doMock('../../lib/assetStorage', () => ({
    saveGeneratedAsset: vi.fn(async (_b: Blob, name: string, type: string) => ({
      assetUrl: 'mivo-asset://mock-gen',
      name,
      type,
      sizeBytes: 1,
      hasTransparency: false,
      size: '10x10',
      sourceDimensions: { width: 10, height: 10 },
    })),
    saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imp' })),
    readImportedAssetFile: vi.fn(),
  }))
  const mod = await import('./canvasSyncRuntime')
  const { useCanvasStore } = await import('../../store/canvasStore')
  const { generationFacade } = await import('../../store/generationFacade')
  return {
    ...mod,
    useCanvasStore,
    generationFacade,
    submitChange,
    enqueueAssetAttach,
    enqueueAssetDetach,
    submitGenerationTask,
    pollTask,
    cancelTask,
  }
}

describe('T2.2 Block 1 — ai-slot 占位落 server + rollback(delete-node)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const drain = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  const seedEmptyCanvas = (store: Awaited<ReturnType<typeof loadRuntimeModule>>['useCanvasStore']) => {
    const baseState = store.getInitialState()
    store.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: {
          c1: { title: 'Canvas', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
        nodes: [],
        edges: [],
        tasks: [],
      } as never,
      true,
    )
  }

  const seedCanvasWithNodes = (
    store: Awaited<ReturnType<typeof loadRuntimeModule>>['useCanvasStore'],
    nodes: MivoCanvasNode[],
    selectedNodeId = 'src1',
  ) => {
    const baseState = store.getInitialState()
    store.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: {
          c1: { title: 'Canvas', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', nodes, edges: [], tasks: [], selectedNodeId, selectedNodeIds: [selectedNodeId] },
        },
        nodes,
        edges: [],
        tasks: [],
        selectedNodeId,
        selectedNodeIds: [selectedNodeId],
      } as never,
      true,
    )
  }

  it('server 模式:prepareChatSlot(chat slot)→ create-node submitChange', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, useCanvasStore, generationFacade } = await loadRuntimeModule()
    seedEmptyCanvas(useCanvasStore)

    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'a cat' })
    await drain()

    expect(prep.slotId).toBeTruthy()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('local 模式:prepareChatSlot(chat slot)→ 不发 submitChange 但 slot 建成(local gate)', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, useCanvasStore, generationFacade } = await loadRuntimeModule({ local: true })
    seedEmptyCanvas(useCanvasStore)

    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'a cat' })
    await drain()

    expect(submitChange).not.toHaveBeenCalled()
    const slot = useCanvasStore.getState().canvases.c1.nodes.find((n) => n.type === 'ai-slot')
    expect(slot).toBeDefined()
    expect(slot?.id).toBe(prep.slotId)
    __resetCanvasSyncRuntimeQueue()
  })

  it('F2 server:mask slot + 右侧 obstacle → create(含 generating 最终态 + obstacle reflow)→ rollback(delete + position-revert);create-ack 探针:delete 在 create 终态后发', async () => {
    // create-ack 探针:create-node 的 submitChange 返 pending,delete 须等其 resolve 才发(实证 queueByCanvas 串行)
    let resolveCreate: () => void = () => {}
    const createPending = new Promise<void>((r) => { resolveCreate = r })
    const { __resetCanvasSyncRuntimeQueue, submitChange, useCanvasStore } = await loadRuntimeModule({
      submitChangeImpl: async (_cid, change) => {
        if (change.kind === 'create-node') { await createPending; return { kind: 'accepted' as const, cursor: 'c' as never } }
        return { kind: 'accepted' as const, cursor: 'c' as never }
      },
    })
    const { prepareMaskEditPlaceholder, removeMaskEditPlaceholder } = await import('../maskEditGeneration')
    const source = imageNode({ id: 'src1', x: 0, y: 0, width: 100, height: 100 })
    // 右侧 obstacle:落在 slot 的 x 区间(reflow 必挤开;source 右边 100 ≤ slot.x 156 不被挤)
    const obstacle = imageNode({ id: 'obs1', x: 200, y: 0, width: 80, height: 80 })
    seedCanvasWithNodes(useCanvasStore, [source, obstacle], 'src1')
    const obstacleXBefore = useCanvasStore.getState().canvases.c1.nodes.find((n) => n.id === 'obs1')!.x

    const { slotId, baselineSnapshot } = prepareMaskEditPlaceholder('c1', source, 'remove the cat')
    await drain()

    // create payload 已是 generating 最终态(patchMaskEditSlotStatus 同包提交,create-node 携最终 aiWorkflow.status)
    const createCall = submitChange.mock.calls.find(([cid, ch]) => cid === 'c1' && (ch as { kind?: string }).kind === 'create-node')
    expect(createCall).toBeDefined()
    expect((createCall![1] as { node?: { aiWorkflow?: { status?: string } } }).node?.aiWorkflow?.status).toBe('generating')
    // obstacle reflow:本地 x 已右移(reflowRightObstacles 同包提交)
    const obstacleXAfterCreate = useCanvasStore.getState().canvases.c1.nodes.find((n) => n.id === 'obs1')!.x
    expect(obstacleXAfterCreate).toBeGreaterThan(obstacleXBefore)
    submitChange.mockClear()

    removeMaskEditPlaceholder('c1', slotId, { baselineSnapshot, error: 'generation failed' })
    await drain()
    // create-ack 探针:create 未 resolve → delete 不发
    expect(submitChange).not.toHaveBeenCalled()
    resolveCreate()
    await drain()
    // delete 在 create 终态后发
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'delete-node', nodeId: slotId }))
    // obstacle position-revert(rollback 还原 reflow):x 回到 create 前
    const obstacleXAfterRollback = useCanvasStore.getState().canvases.c1.nodes.find((n) => n.id === 'obs1')!.x
    expect(obstacleXAfterRollback).toBe(obstacleXBefore)
    expect(useCanvasStore.getState().canvases.c1.nodes.some((n) => n.id === slotId)).toBe(false)
    __resetCanvasSyncRuntimeQueue()
  })

  it('local 模式:prepareMaskEditPlaceholder(mask slot)→ 不发 submitChange 但 slot 建成(local gate)', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, useCanvasStore } = await loadRuntimeModule({ local: true })
    const { prepareMaskEditPlaceholder } = await import('../maskEditGeneration')
    const source = imageNode({ id: 'src1', x: 0, y: 0, width: 100, height: 100 })
    seedCanvasWithNodes(useCanvasStore, [source], 'src1')

    const { slotId } = prepareMaskEditPlaceholder('c1', source, 'remove the cat')
    await drain()

    expect(submitChange).not.toHaveBeenCalled()
    const slot = useCanvasStore.getState().canvases.c1.nodes.find((n) => n.id === slotId)
    expect(slot?.type).toBe('ai-slot')
    __resetCanvasSyncRuntimeQueue()
  })

  it('F1 server:chat failed poll → 同一 slotId 先 create-node 后 delete-node,slot 不存在', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, pollTask, useCanvasStore, generationFacade } = await loadRuntimeModule()
    seedEmptyCanvas(useCanvasStore)

    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'cat' })
    await drain()
    pollTask.mockResolvedValueOnce(failedView('boom'))
    await expect(generationFacade.generateIntoAiSlot(prep.slotId, 'cat', { sceneId: 'c1' })).rejects.toThrow(/boom/)
    await drain()

    const createCalls = submitChange.mock.calls.filter(([cid, ch]) => cid === 'c1' && (ch as { kind?: string }).kind === 'create-node')
    const deleteCalls = submitChange.mock.calls.filter(([cid, ch]) => cid === 'c1' && (ch as { kind?: string }).kind === 'delete-node')
    expect(createCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect((createCalls[0][1] as { node?: { id?: string } }).node?.id).toBe(prep.slotId)
    expect((deleteCalls[0][1] as { nodeId?: string }).nodeId).toBe(prep.slotId)
    // create-ack 串行:create 在 delete 之前(queueByCanvas:delete 经 create 终态后才发)
    expect(submitChange.mock.calls.indexOf(createCalls[0])).toBeLessThan(submitChange.mock.calls.indexOf(deleteCalls[0]))
    expect(useCanvasStore.getState().canvases.c1.nodes.some((n) => n.id === prep.slotId)).toBe(false)
    __resetCanvasSyncRuntimeQueue()
  })

  it('F1 server:chat aborted signal → 同一 slotId 先 create-node 后 delete-node,slot 不存在', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, useCanvasStore, generationFacade } = await loadRuntimeModule()
    seedEmptyCanvas(useCanvasStore)

    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'cat' })
    await drain()
    const controller = new AbortController()
    controller.abort()
    await expect(
      generationFacade.generateIntoAiSlot(prep.slotId, 'cat', { sceneId: 'c1', signal: controller.signal }),
    ).rejects.toThrow()
    await drain()

    const createCalls = submitChange.mock.calls.filter(([cid, ch]) => cid === 'c1' && (ch as { kind?: string }).kind === 'create-node')
    const deleteCalls = submitChange.mock.calls.filter(([cid, ch]) => cid === 'c1' && (ch as { kind?: string }).kind === 'delete-node')
    expect(createCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect((deleteCalls[0][1] as { nodeId?: string }).nodeId).toBe(prep.slotId)
    expect(submitChange.mock.calls.indexOf(createCalls[0])).toBeLessThan(submitChange.mock.calls.indexOf(deleteCalls[0]))
    expect(useCanvasStore.getState().canvases.c1.nodes.some((n) => n.id === prep.slotId)).toBe(false)
    __resetCanvasSyncRuntimeQueue()
  })

  it('F1 local:chat failed poll → 不发 submitChange 但 slot 已删(local gate)', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, pollTask, useCanvasStore, generationFacade } = await loadRuntimeModule({ local: true })
    seedEmptyCanvas(useCanvasStore)

    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'cat' })
    await drain()
    pollTask.mockResolvedValueOnce(failedView('boom'))
    await expect(generationFacade.generateIntoAiSlot(prep.slotId, 'cat', { sceneId: 'c1' })).rejects.toThrow(/boom/)
    await drain()

    expect(submitChange).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().canvases.c1.nodes.some((n) => n.id === prep.slotId)).toBe(false)
    __resetCanvasSyncRuntimeQueue()
  })

  it('F2 server:真实失败后 retry → 失败删 A(delete-node),retry 新建 B(新 id,create-node)', async () => {
    const { __resetCanvasSyncRuntimeQueue, submitChange, pollTask, useCanvasStore, generationFacade } = await loadRuntimeModule()
    seedEmptyCanvas(useCanvasStore)

    const prep1 = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'cat' })
    await drain()
    pollTask.mockResolvedValueOnce(failedView('boom'))
    await expect(generationFacade.generateIntoAiSlot(prep1.slotId, 'cat', { sceneId: 'c1' })).rejects.toThrow(/boom/)
    await drain()

    // 失败已删 A(delete-node for prep1.slotId)
    const deleteA = submitChange.mock.calls.find(
      ([cid, ch]) => cid === 'c1' && (ch as { kind?: string; nodeId?: string }).kind === 'delete-node' && (ch as { nodeId?: string }).nodeId === prep1.slotId,
    )
    expect(deleteA).toBeDefined()
    submitChange.mockClear()

    // retry:pendingSlotId=A 但 A 已删 → prepareChatSlot 新建 B
    const prep2 = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, pendingSlotId: prep1.slotId, prompt: 'cat' })
    await drain()
    expect(prep2.slotId).not.toBe(prep1.slotId) // 新 id(A 已删,不复用)
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('F4 server:菜单/runtime 路径 generateIntoAiSlot 失败 → 同 slotId 先 create-node 后 delete-node(覆盖 baselineSnapshot rollback 分支)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapCanvasActionRuntimeWithSync, submitChange, pollTask, useCanvasStore } = await loadRuntimeModule()
    seedEmptyCanvas(useCanvasStore)
    const store = useCanvasStore.getState()
    // 菜单等价:用 wrapCanvasActionRuntimeWithSync 包的 runtime(生产 canvasActionModel 菜单 / ai-slot view-details 经此路径)
    const runtime = wrapCanvasActionRuntimeWithSync({
      addAiSlotNode: store.addAiSlotNode,
      generateIntoAiSlot: store.generateIntoAiSlot,
    } as unknown as CanvasActionRuntime)

    // 菜单建 slot(经 wrapped addAiSlotNode)→ create-node
    const slotId = runtime.addAiSlotNode({ x: 0, y: 0 }, { width: 200, height: 200 }, 'cat')
    await drain()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))

    pollTask.mockResolvedValueOnce(failedView('boom'))
    // runtime.generateIntoAiSlot(菜单路径)失败 → F4 注入 onSceneMutation → catch 删 slot 发 delete-node。
    // 覆盖 baselineSnapshot rollback 分支:菜单不传 skipSlotHistoryBaseline → generateIntoAiSlot:586 捕获 baselineSnapshot
    // → catch 走 rollbackLatestHistoryBaseline(chat F1 走 skipSlotHistoryBaseline→filter 分支,此例补 rollback 分支)。
    await expect(runtime.generateIntoAiSlot(slotId, 'cat', { sceneId: 'c1' })).rejects.toThrow(/boom/)
    await drain()

    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'delete-node', nodeId: slotId }))
    // create 在 delete 之前(queueByCanvas 串行:create 终态后 delete 才发)
    const createCall = submitChange.mock.calls.find(
      ([cid, ch]) => cid === 'c1' && (ch as { kind?: string; node?: { id?: string } }).kind === 'create-node' && (ch as { node?: { id?: string } }).node?.id === slotId,
    )
    const deleteCall = submitChange.mock.calls.find(
      ([cid, ch]) => cid === 'c1' && (ch as { kind?: string; nodeId?: string }).kind === 'delete-node' && (ch as { nodeId?: string }).nodeId === slotId,
    )
    expect(createCall).toBeDefined()
    expect(deleteCall).toBeDefined()
    expect(submitChange.mock.calls.indexOf(createCall!)).toBeLessThan(submitChange.mock.calls.indexOf(deleteCall!))
    expect(useCanvasStore.getState().canvases.c1.nodes.some((n) => n.id === slotId)).toBe(false)
    __resetCanvasSyncRuntimeQueue()
  })
})
