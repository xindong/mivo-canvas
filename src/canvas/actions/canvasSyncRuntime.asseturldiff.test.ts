// src/canvas/actions/canvasSyncRuntime.asseturldiff.test.ts
// T2.2 Block 2 — computeAssetSideEffects edit-node assetUrl-diff side-effects。
// 从 canvasSyncRuntime.test.ts 拆出(structure-guard 上限非 allowlist 文件 900 行;同
// canvasCommandExecutor.deferred.test.ts 拆分先例)。覆盖 computeAssetSideEffects 对 before/after
// 都存在的 node(edit-node)做 serverAssetIdFromUrl(asset.url) diff,及 submitChanges 的
// edit-node accepted 路径 enqueue detach 旧 + attach 新。
//
// 共享 imageNode/nodeRecord/loadRuntimeModule 走 canvasSyncRuntimeTestFactories;本文件仅保留
// vitest 必须 per-file 的文件级 vi.hoisted(localStorage shim)+ vi.mock(demoImages/remoteDebugReporter)。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnchorRecord, EdgeRecord, NodeRecord } from '../../kernel/records'
import type { CanvasSyncPort } from '../../lib/canvasSyncPort'
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

describe('canvasSyncRuntime — Block 2 edit-node assetUrl-diff side-effects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 通用单 node SyncSnapshot 构造器:before/after 同 id 'n1',asset 按 assetUrl 覆盖。
  // 返回结构兼容 computeAssetSideEffects 的 SyncSnapshot 入参(edges/anchors 用空 Map)。
  const snapshot = (assetUrl: string | undefined) => {
    const node = assetUrl ? nodeRecord({ id: 'n1', asset: { url: assetUrl } }) : nodeRecord({ id: 'n1' })
    return {
      canvasId: 'c1',
      nodes: new Map<string, NodeRecord>([['n1', node]]),
      edges: new Map<string, EdgeRecord>(),
      anchors: new Map<string, AnchorRecord>(),
      nodeOrder: ['n1'],
      edgeOrder: [],
      anchorOrder: [],
    }
  }

  describe('computeAssetSideEffects — edit-node assetUrl diff', () => {
    // ① undefined→server:attach 触发
    it('① edit-node 无 asset(undefined)→ server 资产 → attach 新 assetId,canvasId/nodeId 正确', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(snapshot(undefined), snapshot('mivo-sasset:asset-1'))
      expect(effects.attach.get('n1')).toBe('asset-1')
      expect(effects.detach.has('n1')).toBe(false)
    })

    // ② server→undefined:detach 触发
    it('② edit-node server 资产 → 无 asset(undefined)→ detach 旧 assetId', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(snapshot('mivo-sasset:asset-1'), snapshot(undefined))
      expect(effects.detach.get('n1')).toBe('asset-1')
      expect(effects.attach.has('n1')).toBe(false)
    })

    // ③ server A→server B:detach 旧 + attach 新
    it('③ edit-node server A → server B → detach A + attach B', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(snapshot('mivo-sasset:asset-A'), snapshot('mivo-sasset:asset-B'))
      expect(effects.detach.get('n1')).toBe('asset-A')
      expect(effects.attach.get('n1')).toBe('asset-B')
    })

    // ④ 非 server url 任意变更:零触发
    it('④ edit-node 非 server url(local://、asset://、data:、/path)任意变更 → 零 effect', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const cases: Array<[string | undefined, string | undefined]> = [
        ['local://x', 'asset:///y'],
        ['data:image/png;base64,zzz', 'local://w'],
        ['/image.png', 'local://z'],
        [undefined, 'local://x'],
        ['local://x', undefined],
        ['/path.png', '/other.png'],
      ]
      for (const [beforeUrl, afterUrl] of cases) {
        const effects = computeAssetSideEffects(snapshot(beforeUrl), snapshot(afterUrl))
        expect(effects.attach.size).toBe(0)
        expect(effects.detach.size).toBe(0)
      }
    })

    // ⑤ assetUrl 不变的普通 edit(挪位置/改字):零触发
    it('⑤ edit-node assetUrl 不变(仅 transform/title 变)→ 零 effect', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const before: Parameters<typeof computeAssetSideEffects>[0] = {
        canvasId: 'c1',
        nodes: new Map([
          ['n1', nodeRecord({ id: 'n1', title: 'old', transform: { x: 10, y: 20, width: 120, height: 80, rotation: 0 }, asset: { url: 'mivo-sasset:asset-1' } })],
        ]),
        edges: new Map(),
        anchors: new Map(),
        nodeOrder: ['n1'],
        edgeOrder: [],
        anchorOrder: [],
      }
      const after: Parameters<typeof computeAssetSideEffects>[0] = {
        canvasId: 'c1',
        nodes: new Map([
          ['n1', nodeRecord({ id: 'n1', title: 'new', transform: { x: 30, y: 40, width: 120, height: 80, rotation: 0 }, asset: { url: 'mivo-sasset:asset-1' } })],
        ]),
        edges: new Map(),
        anchors: new Map(),
        nodeOrder: ['n1'],
        edgeOrder: [],
        anchorOrder: [],
      }
      const effects = computeAssetSideEffects(before, after)
      expect(effects.attach.size).toBe(0)
      expect(effects.detach.size).toBe(0)
    })

    // ③ 边界:server→非 server(local://)→ detach 旧(等同 server→无;非 server 无 assetId,不算 attach 新)
    it('③边界 edit-node server A → 非 server(local://)→ 仅 detach A,不 attach', async () => {
      const { computeAssetSideEffects } = await loadRuntimeModule()
      const effects = computeAssetSideEffects(snapshot('mivo-sasset:asset-A'), snapshot('local://x'))
      expect(effects.detach.get('n1')).toBe('asset-A')
      expect(effects.attach.has('n1')).toBe(false)
    })
  })

  describe('submitChanges — edit-node accepted enqueue', () => {
    // ① edit-node undefined→server accepted → enqueueAssetAttach(canvasId, assetId, nodeId)
    it('① edit-node accepted(undefined→server)→ enqueueAssetAttach(c1, asset-1, n1);detach 不发', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule()
      const fakePort = { submitChange } as unknown as CanvasSyncPort
      const effects = { attach: new Map([['n1', 'asset-1']]), detach: new Map() }
      await enqueueCanvasSyncChanges(
        'c1',
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['asset'], value: { url: 'mivo-sasset:asset-1' } }] }],
        fakePort,
        effects,
      )
      expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'edit-node', nodeId: 'n1' }))
      expect(enqueueAssetAttach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
    })

    // ② edit-node server→undefined accepted → enqueueAssetDetach
    it('② edit-node accepted(server→undefined)→ enqueueAssetDetach(c1, asset-1, n1);attach 不发', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule()
      const fakePort = { submitChange } as unknown as CanvasSyncPort
      const effects = { attach: new Map(), detach: new Map([['n1', 'asset-1']]) }
      await enqueueCanvasSyncChanges(
        'c1',
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'delete-field', fieldPath: ['asset'] }] }],
        fakePort,
        effects,
      )
      expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
    })

    // ③ edit-node server A→B accepted → 先 detach A 再 attach B(顺序断言)
    it('③ edit-node accepted(server A→B)→ 先 enqueueAssetDetach(A) 再 enqueueAssetAttach(B)', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule()
      const fakePort = { submitChange } as unknown as CanvasSyncPort
      const effects = { attach: new Map([['n1', 'asset-B']]), detach: new Map([['n1', 'asset-A']]) }
      await enqueueCanvasSyncChanges(
        'c1',
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['asset'], value: { url: 'mivo-sasset:asset-B' } }] }],
        fakePort,
        effects,
      )
      expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-A', 'n1')
      expect(enqueueAssetAttach).toHaveBeenCalledWith('c1', 'asset-B', 'n1')
      const detachOrder = enqueueAssetDetach.mock.invocationCallOrder[0]
      const attachOrder = enqueueAssetAttach.mock.invocationCallOrder[0]
      expect(detachOrder).toBeLessThan(attachOrder)
    })

    // ⑤ 回归:edit-node accepted 但 effects 无该 nodeId(assetUrl 没变)→ 不 enqueue
    it('⑤ edit-node accepted 但无 asset 变更 → 不 enqueue attach/detach', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule()
      const fakePort = { submitChange } as unknown as CanvasSyncPort
      const effects = { attach: new Map(), detach: new Map() }
      await enqueueCanvasSyncChanges(
        'c1',
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['title'], value: 'x' }] }],
        fakePort,
        effects,
      )
      expect(submitChange).toHaveBeenCalled()
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
    })

    // R1 回归:edit-node rejected → 不发 attach/detach(reject 不发 side-effect)
    it('R1: edit-node rejected → 不 enqueue attach/detach', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach, submitChange } = await loadRuntimeModule({
        submitChangeImpl: async () => ({ kind: 'rejected', reason: 'forbidden' }),
      })
      const fakePort = { submitChange } as unknown as CanvasSyncPort
      const effects = { attach: new Map([['n1', 'asset-1']]), detach: new Map() }
      await enqueueCanvasSyncChanges(
        'c1',
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['asset'], value: { url: 'mivo-sasset:asset-1' } }] }],
        fakePort,
        effects,
      )
      expect(submitChange).toHaveBeenCalled()
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
    })

    // ⑦ 既有 create/delete 行为零回归:create-node accepted 仍 enqueueAssetAttach
    it('⑦ 回归 create-node accepted 仍 enqueueAssetAttach(Block 2 不破 create 路径)', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach } = await loadRuntimeModule()
      const fakePort = { submitChange: vi.fn(async () => ({ kind: 'accepted', cursor: 'c' as never })) } as unknown as CanvasSyncPort
      const node = nodeRecord({ id: 'n1', asset: { url: 'mivo-sasset:asset-1' } })
      const effects = { attach: new Map([['n1', 'asset-1']]), detach: new Map() }
      await enqueueCanvasSyncChanges('c1', [{ kind: 'create-node', node }], fakePort, effects)
      expect(enqueueAssetAttach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
    })

    // ⑦ 回归:delete-node accepted 仍 enqueueAssetDetach
    it('⑦ 回归 delete-node accepted 仍 enqueueAssetDetach(Block 2 不破 delete 路径)', async () => {
      const { enqueueCanvasSyncChanges, enqueueAssetAttach, enqueueAssetDetach } = await loadRuntimeModule()
      const fakePort = { submitChange: vi.fn(async () => ({ kind: 'accepted', cursor: 'c' as never })) } as unknown as CanvasSyncPort
      const effects = { attach: new Map(), detach: new Map([['n1', 'asset-1']]) }
      await enqueueCanvasSyncChanges('c1', [{ kind: 'delete-node', nodeId: 'n1' }], fakePort, effects)
      expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-1', 'n1')
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
    })
  })

  describe('local 模式整链不发', () => {
    // ⑥ local 模式:wrapMutation local gate 短路 → submitChange + enqueue 全不发。
    // gate 在 wrapMutation 入口(先于 computeAssetSideEffects/submitChanges),故对 create/delete/edit
    // 任意 kind 都短路;此处用 delete server-asset node 作触发(它在 server 模式会发 detach,local 下静默)。
    it('⑥ local 模式 wrapMutation(delete server-asset node)→ submitChange 与 enqueueAssetAttach/Detach 全不发', async () => {
      const { __resetCanvasSyncRuntimeQueue, wrapMutation, submitChange, enqueueAssetAttach, enqueueAssetDetach, useCanvasStore } =
        await loadRuntimeModule({ local: true })
      const baseState = useCanvasStore.getInitialState()
      const img = imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-1' })
      useCanvasStore.setState(
        {
          ...baseState,
          sceneId: 'c1',
          canvases: {
            c1: { title: 'Canvas', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', nodes: [img], edges: [], tasks: [], selectedNodeId: 'n1', selectedNodeIds: ['n1'] },
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
      expect(submitChange).not.toHaveBeenCalled()
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
      __resetCanvasSyncRuntimeQueue()
    })
  })
})
