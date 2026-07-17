import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasActionRuntime } from './canvasActionTypes'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import type { ChangeOutcome, CanvasSyncPort } from '../../lib/canvasSyncPort'
import { imageNode, nodeRecord, loadRuntimeModule } from './canvasSyncRuntimeTestFactories'

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

  it('array length changes are fail-visible dropped and do not block other legal changes in the same batch', async () => {
    const { buildCanvasSyncChanges, useDebugLogStore } = await loadRuntimeModule()
    useDebugLogStore.setState({ entries: [] })

    const changes = buildCanvasSyncChanges(
      {
        canvasId: 'c1',
        nodes: new Map([
          ['n1', nodeRecord({ fills: [{ kind: 'solid', color: '#111111', opacity: 1, visible: true }] as never })],
          ['n2', nodeRecord({ id: 'n2', title: 'Before' })],
        ]),
        edges: new Map(),
        anchors: new Map(),
        nodeOrder: ['n1', 'n2'],
        edgeOrder: [],
        anchorOrder: [],
      },
      {
        canvasId: 'c1',
        nodes: new Map([
          [
            'n1',
            nodeRecord({
              fills: [
                { kind: 'solid', color: '#111111', opacity: 1, visible: true },
                { kind: 'solid', color: '#222222', opacity: 1, visible: true },
              ] as never,
            }),
          ],
          ['n2', nodeRecord({ id: 'n2', title: 'After' })],
        ]),
        edges: new Map(),
        anchors: new Map(),
        nodeOrder: ['n1', 'n2'],
        edgeOrder: [],
        anchorOrder: [],
      },
    )

    expect(changes).toEqual([
      {
        kind: 'edit-node',
        nodeId: 'n2',
        intents: [{ op: 'set', fieldPath: ['title'], value: 'After' }],
      },
    ])
    expect(useDebugLogStore.getState().entries[0]?.message).toContain('drop invalid edit-node intent')
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

  // PR-C1 CR-6:submitChange 返 rejected reason 'archived'(canvasSyncPortClient 把 409 {error:'archived'}
  //   映射为此)→ canvasSyncRuntime rejected 分支 toastFeedback.warn "先恢复再编辑"(不静默丢编辑)。
  it('rejected reason archived → toastFeedback warn "先恢复再编辑" (CR-6)', async () => {
    const { enqueueCanvasSyncChanges, submitChange } = await loadRuntimeModule({
      submitChangeImpl: async () => ({ kind: 'rejected', reason: 'archived', detail: 'canvas archived (CR-6)' }),
    })
    const { toastFeedback } = await import('../../store/toastStore')
    const warnSpy = vi.spyOn(toastFeedback, 'warn').mockImplementation(() => 'stub')
    const fakePort = { submitChange } as unknown as CanvasSyncPort
    await enqueueCanvasSyncChanges(
      'c1',
      [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['title'], value: 'renamed' }] }],
      fakePort,
    )
    expect(warnSpy).toHaveBeenCalledWith('此画布已归档,请先恢复再编辑。')
    warnSpy.mockRestore()
  })

  // PR-C1 CR-6:其他 rejected 原因(forbidden 等)只 debugLog,不弹 archived 专用 toast(不误引导)。
  it('rejected reason != archived does NOT fire the archived toast', async () => {
    const { enqueueCanvasSyncChanges, submitChange } = await loadRuntimeModule({
      submitChangeImpl: async () => ({ kind: 'rejected', reason: 'forbidden', detail: 'no access' }),
    })
    const { toastFeedback } = await import('../../store/toastStore')
    const warnSpy = vi.spyOn(toastFeedback, 'warn').mockImplementation(() => 'stub')
    const fakePort = { submitChange } as unknown as CanvasSyncPort
    await enqueueCanvasSyncChanges(
      'c1',
      [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['title'], value: 'x' }] }],
      fakePort,
    )
    expect(warnSpy).not.toHaveBeenCalledWith('此画布已归档,请先恢复再编辑。')
    warnSpy.mockRestore()
  })

  it('create retryable is fail-visible aborted so later same-canvas batches do not deadlock', async () => {
    let released = false
    const { abortPendingCreate, enqueueCanvasSyncChanges, submitChange, useDebugLogStore } =
      await loadRuntimeModule({
        submitChangeImpl: async (canvasId, change) => {
          void canvasId
          if (change.kind === 'create-node') return { kind: 'retryable', reason: 'http_503' }
          if (change.kind === 'edit-node' && change.nodeId === 'n1') {
            if (!released) return await new Promise<ChangeOutcome>(() => {})
            return { kind: 'rejected', reason: 'dependency-failed', detail: 'released by caller' }
          }
          return { kind: 'accepted', cursor: 'cursor' as never }
        },
        abortPendingCreateImpl: (port, canvasId, change) => {
          void port
          void canvasId
          if (change.kind === 'create-node') {
            released = true
            return true
          }
          return false
        },
      })
    useDebugLogStore.setState({ entries: [] })

    const fakePort = { submitChange } as unknown as CanvasSyncPort
    await enqueueCanvasSyncChanges('c1', [{ kind: 'create-node', node: nodeRecord() }], fakePort)
    await enqueueCanvasSyncChanges(
      'c1',
      [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['title'], value: 'later' }] }],
      fakePort,
    )
    await enqueueCanvasSyncChanges(
      'c1',
      [{ kind: 'edit-node', nodeId: 'n2', intents: [{ op: 'set', fieldPath: ['title'], value: 'survives' }] }],
      fakePort,
    )

    expect(abortPendingCreate).toHaveBeenCalledTimes(1)
    expect(
      submitChange.mock.calls.some(
        ([canvasId, change]) => {
          if (canvasId !== 'c1' || change.kind !== 'edit-node') return false
          return change.nodeId === 'n2'
        },
      ),
    ).toBe(true)
    expect(
      useDebugLogStore.getState().entries.some((entry) => entry.message.includes('submitChange retryable')),
    ).toBe(true)
  })
})

describe('canvasSyncRuntime — Block 3 asset attach/detach side-effects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('computeAssetSideEffects — diff + URL 过滤(§5 #2 #4)', () => {
    it('新建的 server 资产 node → attach map 记 assetId(剥 mivo-sasset: 前缀)', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(
        { canvasId: 'c1', nodes: new Map(), edges: new Map(), anchors: new Map(), nodeOrder: [], edgeOrder: [], anchorOrder: [] },
        {
          canvasId: 'c1',
          nodes: new Map([['n1', nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:asset-1' } })]]),
          edges: new Map(), anchors: new Map(), nodeOrder: ['n1'], edgeOrder: [], anchorOrder: [],
        },
      )
      expect(effects.attach.get('n1')).toBe('asset-1')
      expect(effects.detach.size).toBe(0)
    })

    it('删除的 server 资产 node → detach map 记 assetId', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(
        {
          canvasId: 'c1',
          nodes: new Map([['n1', nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:asset-1' } })]]),
          edges: new Map(), anchors: new Map(), nodeOrder: ['n1'], edgeOrder: [], anchorOrder: [],
        },
        { canvasId: 'c1', nodes: new Map(), edges: new Map(), anchors: new Map(), nodeOrder: [], edgeOrder: [], anchorOrder: [] },
      )
      expect(effects.detach.get('n1')).toBe('asset-1')
      expect(effects.attach.size).toBe(0)
    })

    it('非 server 资产(local://、/path.png、无 asset)的增删 node 不产 effect —— 不 enqueue', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const before = {
        canvasId: 'c1',
        nodes: new Map([['gone', nodeRecord({ id: 'gone', asset: { url: 'local://x' } })]]),
        edges: new Map(), anchors: new Map(), nodeOrder: ['gone'], edgeOrder: [], anchorOrder: [],
      }
      const after = {
        canvasId: 'c1',
        nodes: new Map([
          ['new', nodeRecord({ id: 'new', asset: { url: '/image.png' } })],
          ['bare', nodeRecord({ id: 'bare' })],
        ]),
        edges: new Map(), anchors: new Map(), nodeOrder: ['new', 'bare'], edgeOrder: [], anchorOrder: [],
      }
      const effects = computeAssetSideEffects(before, after)
      expect(effects.attach.size).toBe(0) // /image.png 与 bare(无 asset)都不产
      expect(effects.detach.size).toBe(0) // local:// 不产
    })

    it('已存在 node 且 assetUrl 不变 → 不产 effect(assetUrl 不变的 edit-node 不触发 attach/detach)', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(
        { canvasId: 'c1', nodes: new Map([['n1', nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:a1' } })]]), edges: new Map(), anchors: new Map(), nodeOrder: ['n1'], edgeOrder: [], anchorOrder: [] },
        { canvasId: 'c1', nodes: new Map([['n1', nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:a1' } })]]), edges: new Map(), anchors: new Map(), nodeOrder: ['n1'], edgeOrder: [], anchorOrder: [] },
      )
      expect(effects.attach.size).toBe(0)
      expect(effects.detach.size).toBe(0)
    })
  })

  it('create-node accepted → enqueueAssetAttach(canvasId, assetId, nodeId);detach 不发(§5 #2 #3 ordering)', async () => {
    const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule()
    const fakePort = { submitChange } as unknown as CanvasSyncPort
    const node = nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:asset-1' } })
    const effects = { attach: new Map([['n1', 'asset-1']]), detach: new Map() }
    await enqueueCanvasSyncChanges('c1', [{ kind: 'create-node', node }], fakePort, effects)
    expect(submitChange).toHaveBeenCalledWith('c1', { kind: 'create-node', node })
    expect(enqueueAssetAttach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
    expect(enqueueAssetDetach).not.toHaveBeenCalled()
  })

  it('delete-node accepted → enqueueAssetDetach;attach 不发(§5 #2 #3)', async () => {
    const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule()
    const fakePort = { submitChange } as unknown as CanvasSyncPort
    const effects = { attach: new Map(), detach: new Map([['n1', 'asset-1']]) }
    await enqueueCanvasSyncChanges('c1', [{ kind: 'delete-node', nodeId: 'n1' }], fakePort, effects)
    expect(submitChange).toHaveBeenCalledWith('c1', { kind: 'delete-node', nodeId: 'n1' })
    expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
    expect(enqueueAssetAttach).not.toHaveBeenCalled()
  })

  it('R1: create-node submitChange rejected → 不发 attach(reject 不 enqueue side-effect)', async () => {
    const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule({
      submitChangeImpl: async () => ({ kind: 'rejected', reason: 'forbidden' }),
    })
    const fakePort = { submitChange } as unknown as CanvasSyncPort
    const node = nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:asset-1' } })
    const effects = { attach: new Map([['n1', 'asset-1']]), detach: new Map() }
    await enqueueCanvasSyncChanges('c1', [{ kind: 'create-node', node }], fakePort, effects)
    expect(submitChange).toHaveBeenCalled()
    expect(enqueueAssetAttach).not.toHaveBeenCalled()
    expect(enqueueAssetDetach).not.toHaveBeenCalled()
  })

  it('无 asset 的 create-node accepted → 不 enqueue attach(text/frame 等非资产 node)', async () => {
    const { enqueueCanvasSyncChanges, enqueueAssetAttach } = await loadRuntimeModule()
    const fakePort = {
      submitChange: vi.fn(async () => ({ kind: 'accepted', cursor: 'c' as never })),
    } as unknown as CanvasSyncPort
    const node = nodeRecord({ id: 'n-text', type: 'text' }) // 无 asset
    const effects = { attach: new Map(), detach: new Map() } // computeAssetSideEffects 对无 asset 返空
    await enqueueCanvasSyncChanges('c1', [{ kind: 'create-node', node }], fakePort, effects)
    expect(enqueueAssetAttach).not.toHaveBeenCalled()
  })

  // F1:快捷键(useGlobalCanvasEvents)直调 wrapMutation(store action)—— 证明快捷键路径经 wrap →
  // submitChange → enqueue attach/detach(项目无 React render harness,无法 fire 真实 keydown/paste event,
  // 此处测快捷键调用的 wrapMutation 本身的行为:server 模式 + image node → submitChange accepted → enqueue)。
  it('F1: wrapMutation 直接包 deleteSelectedNodes(Delete 快捷键)→ delete-node submitChange + enqueueAssetDetach', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, enqueueAssetDetach, useCanvasStore } = await loadRuntimeModule()
    const baseState = useCanvasStore.getInitialState()
    const img = imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-1' })
    useCanvasStore.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: {
          c1: { title: 'Canvas', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', nodes: [img], edges: [], tasks: [], selectedNodeId: 'n1', selectedNodeIds: ['n1'] },
        },
        nodes: [img],
        edges: [],
        tasks: [],
        selectedNodeId: 'n1',
        selectedNodeIds: ['n1'],
      } as never,
      true,
    )
    wrapMutation(useCanvasStore.getState().deleteSelectedNodes)()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'delete-node', nodeId: 'n1' }))
    expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
    __resetCanvasSyncRuntimeQueue()
  })

  it('F1: wrapMutation 直接包 duplicateSelectedNodes(Cmd+D 快捷键)→ create-node submitChange + enqueueAssetAttach', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, enqueueAssetAttach, useCanvasStore } = await loadRuntimeModule()
    const baseState = useCanvasStore.getInitialState()
    const img = imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-1' })
    useCanvasStore.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: {
          c1: { title: 'Canvas', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', nodes: [img], edges: [], tasks: [], selectedNodeId: 'n1', selectedNodeIds: ['n1'] },
        },
        nodes: [img],
        edges: [],
        tasks: [],
        selectedNodeId: 'n1',
        selectedNodeIds: ['n1'],
      } as never,
      true,
    )
    wrapMutation(useCanvasStore.getState().duplicateSelectedNodes)()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    expect(enqueueAssetAttach).toHaveBeenCalledWith('c1', 'asset-1', expect.any(String))
    __resetCanvasSyncRuntimeQueue()
  })

  // ── A2 SC:为新包 action 加行为单元(server 模式 → wrapMutation → submitChange + change kind)──
  // 复用 F1 的 imageNode + setState 种子;setupSelectedImageNode 共享选中 image node 的画布态。
  const setupSelectedImageNode = (store: Awaited<ReturnType<typeof loadRuntimeModule>>['useCanvasStore'], img: MivoCanvasNode) => {
    const baseState = store.getInitialState()
    store.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: { c1: { title: 'Canvas', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', nodes: [img], edges: [], tasks: [], selectedNodeId: 'n1', selectedNodeIds: ['n1'] } },
        nodes: [img],
        edges: [],
        tasks: [],
        selectedNodeId: 'n1',
        selectedNodeIds: ['n1'],
      } as never,
      true,
    )
  }

  it('A2 SC: wrapMutation(store.cutSelectedNodes) → delete-node submitChange + enqueueAssetDetach(Cmd+X)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, enqueueAssetDetach, useCanvasStore } = await loadRuntimeModule()
    const img = imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-1' })
    setupSelectedImageNode(useCanvasStore, img)
    wrapMutation(useCanvasStore.getState().cutSelectedNodes)()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'delete-node', nodeId: 'n1' }))
    expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 SC: wrapMutation(store.moveSelectedNodesBy)(10,0) → edit-node submitChange(transform diff;Arrow)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    const img = imageNode({ id: 'n1' })
    setupSelectedImageNode(useCanvasStore, img)
    wrapMutation(useCanvasStore.getState().moveSelectedNodesBy)(10, 0)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'edit-node', nodeId: 'n1' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 SC: wrapMutation(pasteClipboardAssets) → create-node submitChange(paste image assets 创 nodes)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    const baseState = useCanvasStore.getInitialState()
    useCanvasStore.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: { c1: { title: 'Canvas', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] } },
        nodes: [],
        edges: [],
        tasks: [],
        clipboardAssets: [{ url: 'mivo-sasset:asset-1', name: 'a.png', width: 100, height: 100 }] as never,
      } as never,
      true,
    )
    wrapMutation(() => useCanvasStore.getState().pasteClipboardAssets({ x: 0, y: 0 }))()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 SC 特测(硬化): wrapMutation(store.undo) → undo batch [delete-node(copyId), reorder-children](Cmd+Z)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    const img = imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-1' })
    setupSelectedImageNode(useCanvasStore, img)
    // 审核官定性:duplicate batch = [create-node(copyId), reorder-children](buildCanvasSyncChanges diff,
    //   异步串行提交);undo batch = [delete-node(copyId), reorder-children](inverse,副本确删)。
    //   旧版只等 3 microtask → 断到的"第 2 次 call"实为 duplicate 自己的 reorder(false-positive)。
    //   硬化:等 duplicate 两条完整提交 → 捕获 copyId → clear mock → wrapped undo → 等 undo batch → 明确断言。
    const drain = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    wrapMutation(useCanvasStore.getState().duplicateSelectedNodes)()
    await drain() // 等 duplicate batch(create-node + reorder-children)完整提交
    const createCall = submitChange.mock.calls.find(
      ([cid, ch]) => cid === 'c1' && (ch as { kind?: string }).kind === 'create-node',
    )
    const copyId = (createCall?.[1] as { node?: { id?: string } } | undefined)?.node?.id
    expect(copyId).toBeTruthy()
    submitChange.mockClear() // 隔离 duplicate 的 call → 后续全来自 undo batch
    wrapMutation(useCanvasStore.getState().undo)()
    await drain() // 等 undo batch(delete-node + reorder-children)完整提交
    expect(submitChange).toHaveBeenNthCalledWith(1, 'c1', expect.objectContaining({ kind: 'delete-node', nodeId: copyId }))
    expect(submitChange).toHaveBeenNthCalledWith(2, 'c1', expect.objectContaining({ kind: 'reorder-children' }))
    __resetCanvasSyncRuntimeQueue()
  })

  // ── A2 ptr: pointerup stamp 放置 addMarkupNode 行为单元(server→create-node / local→no submit)──
  const setupEmptyCanvas = (store: Awaited<ReturnType<typeof loadRuntimeModule>>['useCanvasStore']) => {
    const baseState = store.getInitialState()
    store.setState(
      {
        ...baseState,
        sceneId: 'c1',
        canvases: { c1: { title: 'Canvas', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] } },
        nodes: [],
        edges: [],
        tasks: [],
      } as never,
      true,
    )
  }

  it('A2 ptr: wrapMutation(store.addMarkupNode)(pointerup stamp) → server 模式 create-node submitChange accepted', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    setupEmptyCanvas(useCanvasStore)
    wrapMutation(useCanvasStore.getState().addMarkupNode)('stamp', { x: 0, y: 0 }, { width: 10, height: 10 }, { stampKind: 'star', select: false })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 ptr: wrapMutation(store.addMarkupNode) → local 模式不 submitChange 但 mutate 真发生 + 返值保留(local gate)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule({ local: true })
    setupEmptyCanvas(useCanvasStore)
    const placedId = wrapMutation(useCanvasStore.getState().addMarkupNode)('stamp', { x: 0, y: 0 }, { width: 10, height: 10 }, { stampKind: 'star', select: false })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).not.toHaveBeenCalled() // local gate:不发 submitChange
    // 钉死 local 下 mutate 真发生 + 返值保留(防 local 分支错误 return 不 mutate 也绿):
    const nodes = useCanvasStore.getState().nodes
    expect(nodes).toHaveLength(1)
    expect(placedId).toBe(nodes[0]?.id)
    __resetCanvasSyncRuntimeQueue()
  })

  // ── A2 alias: 别名形态 call site 行为单元(pointer-end 创建→create-node / interaction delete→delete-node)──
  it('A2 alias: wrapMutation(addTextNode) → server 模式 create-node submitChange', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    setupEmptyCanvas(useCanvasStore)
    wrapMutation(useCanvasStore.getState().addTextNode)({ x: 0, y: 0 })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 alias: wrapMutation(addFrameNode) → server 模式 create-node submitChange', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    setupEmptyCanvas(useCanvasStore)
    wrapMutation(useCanvasStore.getState().addFrameNode)({ x: 0, y: 0 }, { width: 100, height: 100 })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 alias: wrapMutation(deleteNode) → server 模式 delete-node submitChange + enqueueAssetDetach(interaction 空文本自动删)', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, enqueueAssetDetach, useCanvasStore } = await loadRuntimeModule()
    const img = imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-1' })
    setupSelectedImageNode(useCanvasStore, img)
    wrapMutation(useCanvasStore.getState().deleteNode)('n1')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'delete-node', nodeId: 'n1' }))
    expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
    __resetCanvasSyncRuntimeQueue()
  })

  // ── A2 alias F1[复审]: 拖拽创建文字复合 mutation(create+条件 resize 同 wrap)→ 单条 create-node 最终几何 ──
  it('A2 alias F1[复审]: 拖拽创建文字(dragged 非默认几何)→ 单条 create-node 带最终 transform + textAutoWidth=false', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    setupEmptyCanvas(useCanvasStore)
    const store = useCanvasStore.getState()
    const x = 100, y = 200, width = 300, height = 80 // 非默认(dragged)
    // 复合 lambda:create + resize(同 useTextAnnotation tryEndTextCreation 的 dragged 路径)。
    const id = wrapMutation(() => {
      const nodeId = store.addTextNode({ x, y })
      store.resizeTextNode(nodeId, x, width, height)
      return nodeId
    })()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    // 唯一 create-node(create+resize 同 wrap 的 after-snapshot 捕获最终几何;另可能含 reorder-children 同 append 模式,不计)。
    const createCalls = submitChange.mock.calls.filter((c) => (c[1] as { kind?: string }).kind === 'create-node')
    expect(createCalls).toHaveLength(1)
    const createCall = createCalls[0]?.[1] as { node?: { transform?: { x: number; y: number; width: number; height: number }; textAutoWidth?: boolean } }
    expect(createCall.node?.transform).toMatchObject({ x, y, width, height })
    expect(createCall.node?.textAutoWidth).toBe(false)
    // 本地节点与 payload 一致 + 返回 id。
    const localNode = useCanvasStore.getState().nodes.find((n) => n.id === id)
    expect(localNode).toBeDefined()
    expect(localNode?.x).toBe(x)
    expect(localNode?.y).toBe(y)
    expect(localNode?.width).toBe(width)
    expect(localNode?.height).toBe(height)
    expect(localNode?.textAutoWidth).toBe(false)
    __resetCanvasSyncRuntimeQueue()
  })

  it('A2 alias F1[复审]: 非拖拽创建文字(默认几何,无 resize)→ 单条 create-node 回归不破', async () => {
    const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, useCanvasStore } = await loadRuntimeModule()
    setupEmptyCanvas(useCanvasStore)
    const store = useCanvasStore.getState()
    const id = wrapMutation(() => store.addTextNode({ x: 50, y: 60 }))()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    // 唯一 create-node(回归:复合 lambda create-only 仍发 create-node;reorder-children 同 append 模式,不计)。
    const createCalls = submitChange.mock.calls.filter((c) => (c[1] as { kind?: string }).kind === 'create-node')
    expect(createCalls).toHaveLength(1)
    expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'create-node' }))
    const localNode = useCanvasStore.getState().nodes.find((n) => n.id === id)
    expect(localNode).toBeDefined()
    expect(localNode?.x).toBe(50)
    expect(localNode?.y).toBe(60)
    __resetCanvasSyncRuntimeQueue()
  })
})
