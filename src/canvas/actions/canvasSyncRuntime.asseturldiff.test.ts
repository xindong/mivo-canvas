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
import type { MivoCanvasNode } from '../../types/mivoCanvas'
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
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['asset', 'url'], value: 'mivo-sasset:asset-1' }] }],
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
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'delete-field', fieldPath: ['asset', 'url'] }] }],
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
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['asset', 'url'], value: 'mivo-sasset:asset-B' }] }],
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
        [{ kind: 'edit-node', nodeId: 'n1', intents: [{ op: 'set', fieldPath: ['asset', 'url'], value: 'mivo-sasset:asset-1' }] }],
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

  // ── Block 1 × Block 2 语义配合:slot→结果原位替换 edit-node 经 wrapMutationForScene → attach ──
  // 验 Block 1 的 wrapMutationForScene(内部已调 computeAssetSideEffects + enqueueCanvasSyncChanges(assetEffects))
  // 与 Block 2 的 edit-node assetUrl-diff + submitChanges edit-node attach 端到端打通。Block 1 注释(line ~459)
  // 明确「result edit-node(slot→结果替换)+ attach 是 Block 2/3」——此条证该衔接在 wrap 通路真生效:
  // slot 占位 node(无 server asset)经 wrapMutationForScene 包「换 assetUrl 为 server 结果资产」的 edit →
  // 应发 edit-node submitChange + enqueueAssetAttach(canvasId, resultAssetId, slotNodeId),不发 detach。
  // 生产里 assetUrl edit 的调用方(commitGenerationResult/mask-edit)是 Block 3;此处 setState 驱动该 mutation
  // 以隔离测 wrap→diff→attach 链(addAiSlotNode 等 slot 创建已由 canvasSyncRuntime.block1.test.ts 覆盖)。
  describe('Block 1 × Block 2 语义配合 — wrapMutationForScene → edit-node assetUrl-diff → attach', () => {
    it('ai-slot→image 真实形态:wrapMutationForScene edit(ai-slot→image + server assetUrl)→ edit-node submitChange + enqueueAssetAttach', async () => {
      const { __resetCanvasSyncRuntimeQueue, wrapMutationForScene, submitChange, enqueueAssetAttach, enqueueAssetDetach, useCanvasStore } =
        await loadRuntimeModule()
      const baseState = useCanvasStore.getInitialState()
      // slot 占位:ai-slot node(type='ai-slot' + generation/aiWorkflow,无 assetUrl;模拟 Block 1 addAiSlotNode 建的待替换 slot)
      const slot = imageNode({
        id: 'slot1',
        type: 'ai-slot',
        title: 'AI Slot 1',
        assetUrl: undefined,
        generation: { prompt: 'a cat', model: 'Mivo Mock Image Workflow', size: '120x80', seed: 1 },
        aiWorkflow: { kind: 'slot', status: 'empty', operation: 'slot-generation', prompt: 'a cat', placement: 'slot', createdAt: 1 },
      })
      useCanvasStore.setState(
        {
          ...baseState,
          sceneId: 'c1',
          canvases: {
            c1: { title: 'Canvas', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', nodes: [slot], edges: [], tasks: [], selectedNodeId: 'slot1', selectedNodeIds: ['slot1'] },
          },
          nodes: [slot],
          edges: [],
          tasks: [],
          selectedNodeId: 'slot1',
          selectedNodeIds: ['slot1'],
        } as never,
        true,
      )
      // edit slot1:ai-slot→image(type 改)+ assetUrl→server 结果资产(模拟 slot→结果原位替换真实形态);wrapMutationForScene 快照 before/after diff
      wrapMutationForScene('c1', () => {
        const s = useCanvasStore.getState()
        useCanvasStore.setState({
          canvases: {
            ...s.canvases,
            c1: {
              ...s.canvases.c1,
              nodes: s.canvases.c1.nodes.map((n) => (n.id === 'slot1' ? { ...n, type: 'image', assetUrl: 'mivo-sasset:result-asset' } : n)),
            },
          },
        })
      })()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'edit-node', nodeId: 'slot1' }))
      expect(enqueueAssetAttach).toHaveBeenCalledWith('c1', 'result-asset', 'slot1')
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
      __resetCanvasSyncRuntimeQueue()
    })
  })

  // ── F1 验收(lead review):wrapMutationForScene 端到端,走 build/validator → submitChanges,不手工注入 change/effects ──
  // 验 ① diffValue 分解 asset 消失为 leaf delete + ③ computeAssetSideEffects(changes) 对齐真相源 联合生效:
  //   server asset→undefined:edit-node 含合法 leaf delete(['asset','url'],validator 放行)→ accepted 后 detach。
  //   不手工注入 delete-field ['asset'](那会被 validator 丢,不反映真实);全程经 build 产出 + validator。
  describe('F1 验收 — wrapMutationForScene 端到端 asset 变更(走 build/validator,不手工注入)', () => {
    const setupCanvasWith = (
      useCanvasStore: Awaited<ReturnType<typeof loadRuntimeModule>>['useCanvasStore'],
      img: MivoCanvasNode,
    ) => {
      const baseState = useCanvasStore.getInitialState()
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
    }

    // 取 n1 的 edit-node change 的 intents(从 submitChange mock calls)
    const editNodeIntentsOf = (
      submitChange: { mock: { calls: Array<[string, unknown]> } },
    ): Array<{ op: string; fieldPath: (string | number)[]; value?: unknown }> => {
      const call = submitChange.mock.calls.find(([cid, ch]) => {
        const change = ch as { kind?: string; nodeId?: string }
        return cid === 'c1' && change?.nodeId === 'n1' && change?.kind === 'edit-node'
      })
      return ((call?.[1] as { intents?: Array<{ op: string; fieldPath: (string | number)[]; value?: unknown }> })?.intents) ?? []
    }

    // (a) server asset→undefined:edit 含合法 leaf delete,accepted 后 detach
    it('(a) server asset→undefined:wrapMutationForScene 产 edit-node 含 delete-field [asset,url] leaf + enqueueAssetDetach', async () => {
      const { __resetCanvasSyncRuntimeQueue, wrapMutationForScene, submitChange, enqueueAssetAttach, enqueueAssetDetach, useCanvasStore } =
        await loadRuntimeModule()
      setupCanvasWith(useCanvasStore, imageNode({ id: 'n1', assetUrl: 'mivo-sasset:asset-A' }))
      // 移除 asset(assetUrl→undefined)经 wrapMutationForScene → buildCanvasSyncChanges → validator → submitChange
      wrapMutationForScene('c1', () => {
        const s = useCanvasStore.getState()
        useCanvasStore.setState({
          canvases: {
            ...s.canvases,
            c1: { ...s.canvases.c1, nodes: s.canvases.c1.nodes.map((n) => (n.id === 'n1' ? { ...n, assetUrl: undefined } : n)) },
          },
        })
      })()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      // 提交的 edit-node 含合法 leaf delete(非手工注入:build 产出 + validator 放行 container-clobber 防线)
      expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'edit-node', nodeId: 'n1' }))
      const intents = editNodeIntentsOf(submitChange)
      expect(intents.some((i) => i.op === 'delete-field' && i.fieldPath[0] === 'asset' && i.fieldPath[1] === 'url')).toBe(true)
      // accepted 后 detach 旧 A(③ 对齐:change 含 asset 叶子 intent → side effect 发)
      expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-A', 'n1')
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
      __resetCanvasSyncRuntimeQueue()
    })

    // (b) asset 移除 + title 同批:server change(edit-node 含 title set + asset leaf delete)与 detach 对齐
    it('(b) asset 移除 + title 同批:edit-node 含 [set title, delete-field asset.url] + enqueueAssetDetach 对齐(无悬空)', async () => {
      const { __resetCanvasSyncRuntimeQueue, wrapMutationForScene, submitChange, enqueueAssetDetach, enqueueAssetAttach, useCanvasStore } =
        await loadRuntimeModule()
      setupCanvasWith(useCanvasStore, imageNode({ id: 'n1', title: 'old', assetUrl: 'mivo-sasset:asset-A' }))
      // 同批:asset 移除 + title 改
      wrapMutationForScene('c1', () => {
        const s = useCanvasStore.getState()
        useCanvasStore.setState({
          canvases: {
            ...s.canvases,
            c1: { ...s.canvases.c1, nodes: s.canvases.c1.nodes.map((n) => (n.id === 'n1' ? { ...n, assetUrl: undefined, title: 'new' } : n)) },
          },
        })
      })()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      // 单条 edit-node 含 title set + asset leaf delete(混合批次,asset 不被 validator 丢)
      expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'edit-node', nodeId: 'n1' }))
      const intents = editNodeIntentsOf(submitChange)
      expect(intents.some((i) => i.op === 'set' && i.fieldPath[0] === 'title' && i.value === 'new')).toBe(true)
      expect(intents.some((i) => i.op === 'delete-field' && i.fieldPath[0] === 'asset' && i.fieldPath[1] === 'url')).toBe(true)
      // detach 与 server change 对齐(都发:server 经 leaf delete 知 asset 移除 + detach 清 refcount,无悬空)
      expect(enqueueAssetDetach).toHaveBeenCalledWith('c1', 'asset-A', 'n1')
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
      __resetCanvasSyncRuntimeQueue()
    })

    // (a 反例/防御)③ 真相源:asset 变更被 validator 丢时(模拟:手工塞 container delete-field ['asset'] 进 change)
    //   → computeAssetSideEffects 应过滤掉 detach。此处用「asset 整体 set(非原子,validator 拒)」绕不开 build,
    //   改用真实路径:仅改 title(asset 不变)→ computeAssetSideEffects 算出 0 effect(无 asset diff)→ 不发 detach。
    it('(防御)③ 真相源:仅 title 改(asset 不变)→ edit-node 无 asset 叶子 intent → 不 enqueue attach/detach', async () => {
      const { __resetCanvasSyncRuntimeQueue, wrapMutationForScene, submitChange, enqueueAssetAttach, enqueueAssetDetach, useCanvasStore } =
        await loadRuntimeModule()
      setupCanvasWith(useCanvasStore, imageNode({ id: 'n1', title: 'old', assetUrl: 'mivo-sasset:asset-A' }))
      wrapMutationForScene('c1', () => {
        const s = useCanvasStore.getState()
        useCanvasStore.setState({
          canvases: {
            ...s.canvases,
            c1: { ...s.canvases.c1, nodes: s.canvases.c1.nodes.map((n) => (n.id === 'n1' ? { ...n, title: 'new' } : n)) },
          },
        })
      })()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(submitChange).toHaveBeenCalledWith('c1', expect.objectContaining({ kind: 'edit-node', nodeId: 'n1' }))
      // asset 未变 → 无 asset 叶子 intent → ③ 过滤后 0 effect → 不发 attach/detach(对齐真相源)
      expect(enqueueAssetAttach).not.toHaveBeenCalled()
      expect(enqueueAssetDetach).not.toHaveBeenCalled()
      __resetCanvasSyncRuntimeQueue()
    })
  })
})
