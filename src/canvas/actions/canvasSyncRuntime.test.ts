import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasActionRuntime } from './canvasActionTypes'
import type { NodeRecord } from '../../kernel/records'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import type { CanvasChange, ChangeOutcome, CanvasSyncPort } from '../../lib/canvasSyncPort'

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

const loadRuntimeModule = async (
  options: {
    local?: boolean
    submitChangeImpl?: (canvasId: string, change: CanvasChange) => Promise<ChangeOutcome>
    abortPendingCreateImpl?: (port: CanvasSyncPort, canvasId: string, change: CanvasChange, detail: string) => boolean
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
  const abortPendingCreate = vi.fn(options.abortPendingCreateImpl ?? (() => false))
  // Block 3: mock assetAttachWiring —— 透传真 serverAssetIdFromUrl(URL 过滤逻辑走真路径),enqueueAssetAttach/Detach
  // 为 spy(验 submitChanges accepted 后的 enqueue 行为)。在 doMock persistMode 之后 import 真 assetAttachWiring,
  // 保证 persistBoot→canvasStore 链拿 mock persistMode。
  vi.doMock('../../lib/persistMode', () => ({
    isLocalPersist: options.local ?? false,
  }))
  vi.doMock('../../lib/canvasSyncPortClient', () => ({
    getCanvasSyncPort: () => ({ submitChange }),
    abortPendingCanvasSyncCreate: abortPendingCreate,
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
  const mod = await import('./canvasSyncRuntime')
  const { useCanvasStore } = await import('../../store/canvasStore')
  const { useDebugLogStore } = await import('../../store/debugLogStore')
  return { ...mod, useCanvasStore, useDebugLogStore, submitChange, abortPendingCreate, enqueueAssetAttach, enqueueAssetDetach }
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

    it('已存在 node(既不新建也不删除)不产 effect(edit-node 不触发 attach/detach)', async () => {
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
})
