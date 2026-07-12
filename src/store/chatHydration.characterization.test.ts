// T0.4④ 表征测试 — chat 持久化 / hydrate 回落现状基线
// 计划: docs/plan/arch-migration-execution-plan.md v3 (三票评审通过)
// 断言数 baseline: 114 expect() 调用点 / 30 it / 6 describe
//   (迁移后断言数不减、断言内容一字不改；改一个数 = 改基线，须在 PR 说明)
//
// 本文件 CHARACTERIZES 当前 main 的行为，不改 chatStore 本体。覆盖 5 个面：
// ① messagesByScene 按 sceneId 键的读写语义
// ② 持久化白名单（isBusy 等瞬态不入 persist）
// ③ hydrate 后 settleExpiredChatMessages 对 in-flight 消息的确切回落（状态/文案/task card 呈现字段）
// ④ 删画布后对话残留的现状语义（DP-3 迁移前：无级联清对话）
// ⑤ 过期判定边界（何谓 in-flight）
//
// 现状疑点（不改行为，迁移时单独决策）见 PR 描述"现状疑点"段。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// zustand v5 persist 只在 `createJSONStorage(() => <storage>)` 解析到一个 storage 时
// 挂 `api.persist`。Node 测试环境无 window/localStorage，且 idbStateStorage 在
// `isIdbAvailable()` 为 false 时回落到 localStorage.getItem —— 所以必须先装一个
// 内存 localStorage（同 chatStore.test.ts / canvasStore.contract.test.ts 的 hermetic
// 套路）。vi.hoisted 保证它在下方 `import` 之前执行（ESM import 会被提升到普通
// 语句之上）。
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

// chatStore 经 generationFacade / chatEnhanceFlow 间接 import canvasStore，后者在
// module load 时跑 scenes() → createDemoImage → document.createElement('canvas')
// （node 无 DOM）。stub 掉，保持 hermetic（同 chatStore.test.ts）。
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1,
    hasTransparency: false,
    size: '100x100',
    sourceDimensions: { width: 100, height: 100 },
  })),
  saveImportedAsset: vi.fn(),
  readImportedAssetFile: vi.fn(),
}))
vi.mock('../lib/mivoImageClient', () => ({
  enhanceMivoPrompt: vi.fn(),
  MivoImageRequestError: class MivoImageRequestError extends Error {
    kind: string
    constructor(message: string, kind: string) {
      super(message)
      this.name = 'MivoImageRequestError'
      this.kind = kind
    }
  },
}))
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))
// ④ 需要驱动 canvasStore.deleteCanvas，但不应触发真实 generationFacade 副作用。
const genFacadeSpies = vi.hoisted(() => ({
  prepareChatSlot: vi.fn(),
  generateIntoAiSlot: vi.fn(),
  generateBesideNode: vi.fn(),
  getSceneChangeInfo: vi.fn().mockReturnValue({ sceneChanged: false, currentSceneId: '', sceneTitle: '' }),
}))
vi.mock('./generationFacade', () => ({ generationFacade: genFacadeSpies }))
const maskEditFlowSpies = vi.hoisted(() => ({
  cancelMaskEditMessage: vi.fn(),
}))
vi.mock('./chatMaskEditFlow', () => ({
  cancelMaskEditMessage: maskEditFlowSpies.cancelMaskEditMessage,
  beginMaskEditMessage: vi.fn(() => 'mask-msg-stub'),
  runMaskEditChatFlow: vi.fn(async () => {}),
  finishMaskEditMessage: vi.fn(),
  failMaskEditMessage: vi.fn(),
}))

import { useChatStore } from './chatStore'
import { useCanvasStore } from './canvasStore'
import { settleExpiredChatMessages } from './chatGenerationHydration'
import type { ChatMessage, ChatMessageStatus } from './chatStore'

// Helpers ---------------------------------------------------------------------

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  role: 'assistant',
  text: '',
  createdAt: 0,
  status: 'done',
  ...overrides,
})

const EXPIRED_TEXT = '任务已过期,请重试。'
const MASK_EXPIRED_RETRY = '局部重绘任务已过期，请重新选择区域后再试'

const ls = () => (globalThis as { localStorage: { setItem: (k: string, v: string) => void; getItem: (k: string) => string | null; clear: () => void } }).localStorage

/** Seed persisted chat state (version 2 by default) into the in-memory localStorage. */
const seedPersisted = (state: Record<string, unknown>, version = 2) => {
  ls().setItem('mivo-chat-demo', JSON.stringify({ state, version }))
}

const resetChatStore = () => {
  useChatStore.setState({ ...useChatStore.getInitialState() } as never, true)
}

beforeEach(() => {
  ls().clear()
  resetChatStore()
  useCanvasStore.setState({ ...useCanvasStore.getInitialState() } as never, true)
  genFacadeSpies.getSceneChangeInfo.mockReturnValue({ sceneChanged: false, currentSceneId: '', sceneTitle: '' })
})

// ① messagesByScene: sceneId 键读写语义 ========================================

describe('① messagesByScene: sceneId 键读写语义', () => {
  it('不同 sceneId 是独立桶：写一个不影响另一个', () => {
    useChatStore.setState({
      messagesByScene: {
        'scene-a': [makeMessage({ id: 'a1', text: 'A' })],
        'scene-b': [makeMessage({ id: 'b1', text: 'B' })],
      },
    } as never)

    const state = useChatStore.getState()
    expect(state.messagesByScene['scene-a']).toHaveLength(1)
    expect(state.messagesByScene['scene-b']).toHaveLength(1)
    expect(state.messagesByScene['scene-a'][0].text).toBe('A')
    expect(state.messagesByScene['scene-b'][0].text).toBe('B')

    // 向 scene-b 追加，scene-a 不变
    useChatStore.getState().appendNotice({ sceneId: 'scene-b', origin: 'chat', prompt: 'notice-b' })
    const after = useChatStore.getState().messagesByScene
    expect(after['scene-a']).toHaveLength(1)
    expect(after['scene-b']).toHaveLength(2)
    expect(after['scene-b'][1].kind).toBe('notice')
  })

  it('未设 key 的 sceneId 读为 undefined，调用方靠 || [] fallback', () => {
    useChatStore.setState({ messagesByScene: { 'exists': [makeMessage()] } } as never)
    const state = useChatStore.getState()
    // 现状：key 不存在时值为 undefined（不是 []），消费方必须 || []
    expect(state.messagesByScene['missing']).toBeUndefined()
    expect(state.messagesByScene['missing'] || []).toEqual([])
  })

  it('appendNotice 写入正确 sceneId 桶且构造 notice 行（role=assistant/kind=notice/status=done）', () => {
    useChatStore.getState().appendNotice({ sceneId: 'scene-x', origin: 'chat', prompt: '生成完毕' })
    const msgs = useChatStore.getState().messagesByScene['scene-x']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].kind).toBe('notice')
    expect(msgs[0].status).toBe('done')
    expect(msgs[0].text).toBe('生成完毕')
    expect(msgs[0].origin).toBe('chat')
  })

  it('clearScene 把 [sceneId] 设为 [] 但【保留 key】（不 delete 属性）', () => {
    useChatStore.setState({
      messagesByScene: {
        'scene-keep': [makeMessage({ id: 'k1' }), makeMessage({ id: 'k2' })],
        'scene-other': [makeMessage({ id: 'o1' })],
      },
    } as never)

    useChatStore.getState().clearScene('scene-keep')

    const after = useChatStore.getState().messagesByScene
    // 现状（DP-3 相关）：clearScene 留下空数组，key 不被删除
    expect(after['scene-keep']).toEqual([])
    expect('scene-keep' in after).toBe(true)
    // 其他桶不受影响
    expect(after['scene-other']).toHaveLength(1)
  })
})

// ② 持久化白名单：isBusy 等瞬态不入 persist ===================================

describe('② 持久化白名单：isBusy 等瞬态不入 persist', () => {
  it('partialize 产出 {messagesByScene, paramOverrides, selectedModel, unsyncedChatMsgIds} 四个字段(白名单,无瞬态)', () => {
    const opts = useChatStore.persist.getOptions()
    const partialized = opts.partialize!(useChatStore.getState()) as Record<string, unknown>
    // P2-3:unsyncedChatMsgIds sidecar 入 partialize(R-7 local-only 保留证明,跨 boot 持久);isBusy 仍排除。
    expect(Object.keys(partialized).sort()).toEqual(['messagesByScene', 'paramOverrides', 'selectedModel', 'unsyncedChatMsgIds'])
  })

  it('partialize 排除 isBusy（runtime 状态）', () => {
    useChatStore.setState({ isBusy: true } as never)
    const opts = useChatStore.persist.getOptions()
    const partialized = opts.partialize!(useChatStore.getState()) as Record<string, unknown>
    expect(partialized).not.toHaveProperty('isBusy')
  })

  it('partialize 不持久化任何 action（函数应随 store 实例重建，不落盘）', () => {
    const opts = useChatStore.persist.getOptions()
    const partialized = opts.partialize!(useChatStore.getState()) as Record<string, unknown>
    for (const action of ['sendMessage', 'retryMessage', 'cancelGeneration', 'clearScene', 'setSelectedModel', 'setParamOverride', 'appendNotice']) {
      expect(partialized).not.toHaveProperty(action)
    }
  })

  it('persist name/version 锚定：mivo-chat-demo / version 2', () => {
    const opts = useChatStore.persist.getOptions()
    expect(opts.name).toBe('mivo-chat-demo')
    expect(opts.version).toBe(2)
  })

  it('round-trip：persisted 无 isBusy → rehydrate 后 isBusy===false（即使 rehydrate 前 runtime 是 true）', async () => {
    // runtime 先把 isBusy 置 true（模拟刷新前一刻 in-flight）
    useChatStore.setState({ isBusy: true } as never)
    expect(useChatStore.getState().isBusy).toBe(true)

    // 落盘的 v2 状态不含 isBusy（partialize 排除）
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: { 'scene-rt': [makeMessage({ id: 'rt1', status: 'done' })] },
    })

    await useChatStore.persist.rehydrate()

    // merge 强制 isBusy:false（chatStore.ts:854）—— 现状回落契约
    expect(useChatStore.getState().isBusy).toBe(false)
    expect(useChatStore.getState().messagesByScene['scene-rt']).toHaveLength(1)
  })
})

// ③ hydrate 后 settleExpiredChatMessages 对 in-flight 消息的确切回落 =============

describe('③ hydrate 后 settleExpiredChatMessages 对 in-flight 消息的确切回落', () => {
  it('enhancing 消息 → error / unknown / 过期文案 / chat retryDisabledReason=undefined', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-e': [makeMessage({ id: 'e1', status: 'enhancing', text: '', origin: 'chat', timeoutRetryKey: 'old-key', timeoutRetryCount: 2, retryDisabledReason: 'old-disabled', generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto' } })],
      },
    })
    await useChatStore.persist.rehydrate()

    const msg = useChatStore.getState().messagesByScene['scene-e'][0]
    expect(msg.status).toBe('error')
    expect(msg.error).toBe(EXPIRED_TEXT)
    expect(msg.errorKind).toBe('unknown')
    // fixture 预置旧 timeoutRetryKey/Count/retryDisabledReason → settle 清空三者，
    // 证明 chatGenerationHydration.ts:24-28 覆盖赋值生效（非字段本就缺失）
    expect(msg.timeoutRetryKey).toBeUndefined()
    expect(msg.timeoutRetryCount).toBeUndefined()
    // chat-origin：retryDisabledReason=undefined → task card 的 Retry 按钮可用
    expect(msg.retryDisabledReason).toBeUndefined()
  })

  it('generating 消息 → error / unknown / 过期文案 / pendingSlotId 保留', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-g': [makeMessage({
          id: 'g1',
          status: 'generating',
          text: 'final-prompt-x',
          origin: 'chat',
          enhance: { richPrompt: 'final-prompt-x', stage: 'primary' },
          generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto', finalPrompt: 'final-prompt-x', pendingSlotId: 'slot-9' },
        })],
      },
    })
    await useChatStore.persist.rehydrate()

    const msg = useChatStore.getState().messagesByScene['scene-g'][0]
    expect(msg.status).toBe('error')
    expect(msg.error).toBe(EXPIRED_TEXT)
    expect(msg.errorKind).toBe('unknown')
    // task card 呈现字段（spread 保留）：prompt 文案、enhance、generationContext（含 pendingSlotId）
    expect(msg.text).toBe('final-prompt-x')
    expect(msg.enhance?.richPrompt).toBe('final-prompt-x')
    expect(msg.generationContext?.pendingSlotId).toBe('slot-9')
    expect(msg.generationContext?.finalPrompt).toBe('final-prompt-x')
    expect(msg.origin).toBe('chat')
  })

  it('mask-edit origin 的 generating 消息 → retryDisabledReason = 局部重绘过期文案', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-m': [makeMessage({
          id: 'm1',
          status: 'generating',
          origin: 'mask-edit',
          retryDisabledReason: 'old-disabled',
          generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto', pendingSlotId: 'slot-m', maskEdit: { sourceTitle: 'src', serverTaskId: 't-1' } },
        })],
      },
    })
    await useChatStore.persist.rehydrate()

    const msg = useChatStore.getState().messagesByScene['scene-m'][0]
    expect(msg.status).toBe('error')
    expect(msg.error).toBe(EXPIRED_TEXT)
    expect(msg.errorKind).toBe('unknown')
    // mask-edit：旧 retryDisabledReason='old-disabled' 被 settle 覆盖为精确局部重绘过期文案（全等）
    expect(msg.retryDisabledReason).toBe(MASK_EXPIRED_RETRY)
    // maskEdit context 保留（供刷新后 cancel fallback 与归因）
    expect(msg.generationContext?.maskEdit?.serverTaskId).toBe('t-1')
    expect(msg.generationContext?.pendingSlotId).toBe('slot-m')
  })

  it('同 scene 多条 in-flight 全部回落，且 settle 计数正确', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-multi': [
          makeMessage({ id: 'i1', status: 'enhancing' }),
          makeMessage({ id: 'i2', status: 'generating' }),
          makeMessage({ id: 'd1', status: 'done', text: 'finished' }),
        ],
      },
    })
    await useChatStore.persist.rehydrate()

    const msgs = useChatStore.getState().messagesByScene['scene-multi']
    expect(msgs.map((m) => m.status)).toEqual(['error', 'error', 'done'])
    expect(msgs.map((m) => m.error)).toEqual([EXPIRED_TEXT, EXPIRED_TEXT, undefined])
    // 第三条 done 消息的 text 原样保留
    expect(msgs[2].text).toBe('finished')
  })

  it('hydrate 后 isBusy 强制 false（merge 落点 chatStore.ts:854）', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: { 'scene-b': [makeMessage({ id: 'b1', status: 'generating' })] },
    })
    await useChatStore.persist.rehydrate()
    expect(useChatStore.getState().isBusy).toBe(false)
  })
})

// ④ 删画布后对话残留现状（DP-3 迁移前）========================================

describe('④ 删画布后对话残留现状（DP-3 迁移前：无级联清对话）', () => {
  it('chatStore 对外无 deleteScene API —— clearScene 仅清空不删 key', () => {
    const state = useChatStore.getState() as Record<string, unknown>
    // 现状：chatStore 只暴露 clearScene（set []），没有删 sceneId key 的入口
    expect(typeof state.clearScene).toBe('function')
    expect(state).not.toHaveProperty('deleteScene')
    expect(state).not.toHaveProperty('removeScene')
  })

  it('clearScene 之后 sceneId key 仍存在于 messagesByScene（残留）', () => {
    useChatStore.setState({
      messagesByScene: { 'scene-doomed': [makeMessage({ id: 'd1', text: '历史对话' })] },
    } as never)
    useChatStore.getState().clearScene('scene-doomed')
    const after = useChatStore.getState().messagesByScene
    expect('scene-doomed' in after).toBe(true)
    expect(after['scene-doomed']).toEqual([])
  })

  it('canvasStore.deleteCanvas 不级联清 chatStore.messagesByScene（跨 store 无订阅）', () => {
    // 画布侧：两个 canvas，删掉 'doomed'（非 active）
    const base = useCanvasStore.getInitialState()
    useCanvasStore.setState({
      ...base,
      canvases: {
        'doomed': { title: 'Doomed', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        'survivor': { title: 'Survivor', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
      },
      sceneId: 'survivor',
    } as never, true)
    // 对话侧：doomed 有历史对话
    useChatStore.setState({
      messagesByScene: { 'doomed': [makeMessage({ id: 'c1', text: '删画布前的对话' })] },
    } as never)

    useCanvasStore.getState().deleteCanvas('doomed')

    // 现状（DP-3）：画布删了，对话还在 chatStore.messagesByScene['doomed']
    expect(useChatStore.getState().messagesByScene['doomed']).toHaveLength(1)
    expect(useChatStore.getState().messagesByScene['doomed'][0].text).toBe('删画布前的对话')
  })

  it('orphan sceneId key 跨 hydrate 存活（不会被 settle/merge GC）', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'orphan-scene': [makeMessage({ id: 'or1', status: 'done', text: '孤儿对话' })],
        'current-scene': [makeMessage({ id: 'cu1', status: 'done' })],
      },
    })
    await useChatStore.persist.rehydrate()
    const after = useChatStore.getState().messagesByScene
    // 现状：orphan sceneId 既不被删也不被 settle，原样存活（IDB blob 随删画布增长）
    expect(after['orphan-scene']).toHaveLength(1)
    expect(after['orphan-scene'][0].text).toBe('孤儿对话')
    expect(after['current-scene']).toHaveLength(1)
  })
})

// ⑤ 过期判定边界：何谓 in-flight =============================================

describe('⑤ 过期判定边界：何谓 in-flight（settleExpiredChatMessages 纯函数）', () => {
  it('enhancing 与 generating 是 in-flight → settle；done / error 不被 settle', () => {
    const input: Record<string, ChatMessage[]> = {
      's1': [
        makeMessage({ id: 'enh', status: 'enhancing' }),
        makeMessage({ id: 'gen', status: 'generating' }),
        makeMessage({ id: 'done1', status: 'done' }),
        makeMessage({ id: 'err1', status: 'error', error: '旧错', errorKind: 'upstream-timeout', timeoutRetryKey: 'k', timeoutRetryCount: 1 }),
      ],
    }
    const { messagesByScene, settledMessages } = settleExpiredChatMessages(input)
    const out = messagesByScene['s1']
    // enhancing → error, generating → error, done → done, error → error（原样）
    expect(out.map((m) => m.status)).toEqual(['error', 'error', 'done', 'error'])
    // 只有 enhancing + generating 两条被 settle；error 状态不在 in-flight 判定内
    expect(settledMessages).toBe(2)
    // done 消息与旧 error 消息均原样返回（引用不变）
    expect(out[2]).toBe(input['s1'][2])
    expect(out[3]).toBe(input['s1'][3])
    // 旧 error 消息的已有字段不被 settle 覆盖
    expect(out[3].error).toBe('旧错')
    expect(out[3].errorKind).toBe('upstream-timeout')
    expect(out[3].timeoutRetryKey).toBe('k')
    expect(out[3].timeoutRetryCount).toBe(1)
  })

  it('旧 error 消息【不】被 settle 重写（in-flight 判定只认 enhancing/generating，不看已有 error）', () => {
    const input: Record<string, ChatMessage[]> = {
      's2': [makeMessage({ id: 'err', status: 'error', error: '旧错', errorKind: 'upstream-timeout' })],
    }
    const { messagesByScene, settledMessages } = settleExpiredChatMessages(input)
    const out = messagesByScene['s2'][0]
    expect(settledMessages).toBe(0)
    expect(out.status).toBe('error')
    expect(out.error).toBe('旧错') // 不被覆盖为过期文案
    expect(out.errorKind).toBe('upstream-timeout')
    expect(out).toBe(input['s2'][0])
  })

  it('done 消息携带 error 字段也不被 settle（非 in-flight，原样保留）', () => {
    const input: Record<string, ChatMessage[]> = {
      's3': [makeMessage({ id: 'd', status: 'done', error: '遗留error', errorKind: 'unknown' })],
    }
    const { messagesByScene, settledMessages } = settleExpiredChatMessages(input)
    expect(settledMessages).toBe(0)
    expect(messagesByScene['s3'][0].status).toBe('done')
    expect(messagesByScene['s3'][0].error).toBe('遗留error')
  })

  it('未识别 status（如未来扩展值）不被 settle（isInFlightChatStatus 只认 enhancing/generating）', () => {
    const input: Record<string, ChatMessage[]> = {
      's4': [makeMessage({ id: 'weird', status: 'pending' as ChatMessageStatus })],
    }
    const { messagesByScene, settledMessages } = settleExpiredChatMessages(input)
    expect(settledMessages).toBe(0)
    expect(messagesByScene['s4'][0].status).toBe('pending')
  })

  it('空 messagesByScene → 返回空对象，settledMessages=0', () => {
    const { messagesByScene, settledMessages } = settleExpiredChatMessages({})
    expect(messagesByScene).toEqual({})
    expect(settledMessages).toBe(0)
  })

  it('空数组 scene（[]）→ 保留空数组，settledMessages=0', () => {
    const input: Record<string, ChatMessage[]> = { 'empty': [] }
    const { messagesByScene, settledMessages } = settleExpiredChatMessages(input)
    expect(messagesByScene['empty']).toEqual([])
    expect(settledMessages).toBe(0)
  })

  it('跨多 scene：只 settle 含 in-flight 的 scene，全 done 的 scene 不变', () => {
    const input: Record<string, ChatMessage[]> = {
      'all-done': [makeMessage({ id: 'a', status: 'done' }), makeMessage({ id: 'b', status: 'done' })],
      'has-inflight': [makeMessage({ id: 'c', status: 'generating' }), makeMessage({ id: 'd', status: 'done' })],
    }
    const { messagesByScene, settledMessages } = settleExpiredChatMessages(input)
    expect(messagesByScene['all-done'][0]).toBe(input['all-done'][0])
    expect(messagesByScene['all-done'][1]).toBe(input['all-done'][1])
    expect(messagesByScene['has-inflight'][0].status).toBe('error')
    expect(messagesByScene['has-inflight'][1].status).toBe('done')
    expect(settledMessages).toBe(1)
  })

  it('in-flight 消息被 settle 后，spread 保留的字段不被清空（resultNodeIds/enhance/origin）', () => {
    const input: Record<string, ChatMessage[]> = {
      's5': [makeMessage({
        id: 'g',
        status: 'generating',
        text: 'prompt',
        origin: 'chat',
        timeoutRetryKey: 'old-key',
        timeoutRetryCount: 2,
        retryDisabledReason: 'old-disabled',
        enhance: { richPrompt: 'prompt', stage: 'primary' },
        resultNodeIds: ['n-1', 'n-2'],
        selectedNodeId: 'src-1',
        selectedNodeType: 'image',
        generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto' },
      })],
    }
    const { messagesByScene } = settleExpiredChatMessages(input)
    const out = messagesByScene['s5'][0]
    expect(out.status).toBe('error')
    expect(out.text).toBe('prompt')
    expect(out.origin).toBe('chat')
    expect(out.enhance?.richPrompt).toBe('prompt')
    expect(out.resultNodeIds).toEqual(['n-1', 'n-2'])
    expect(out.selectedNodeId).toBe('src-1')
    expect(out.selectedNodeType).toBe('image')
    // settle 只重写 6 个字段：status/error/errorKind/timeoutRetryKey/timeoutRetryCount/retryDisabledReason
    expect(out.generationContext?.model).toBe('gpt-image-2')
    // 旧 retry 字段被 settle 清空（chatGenerationHydration.ts:24-28 覆盖赋值生效，非字段本就缺失）
    expect(out.timeoutRetryKey).toBeUndefined()
    expect(out.timeoutRetryCount).toBeUndefined()
    expect(out.retryDisabledReason).toBeUndefined()
  })

  it('mask-edit in-flight 消息的旧 retryDisabledReason 被 settle 覆盖为局部重绘过期文案', () => {
    const input: Record<string, ChatMessage[]> = {
      's-mask': [makeMessage({
        id: 'gm',
        status: 'generating',
        origin: 'mask-edit',
        retryDisabledReason: 'old-disabled',
        timeoutRetryKey: 'old-key',
        timeoutRetryCount: 2,
        generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto', pendingSlotId: 'slot-m' },
      })],
    }
    const { messagesByScene } = settleExpiredChatMessages(input)
    const out = messagesByScene['s-mask'][0]
    expect(out.status).toBe('error')
    // 旧 retryDisabledReason 被覆盖为精确局部重绘过期文案（全等，非字段本就缺失）
    expect(out.retryDisabledReason).toBe(MASK_EXPIRED_RETRY)
    // 其余 retry 字段被清空
    expect(out.timeoutRetryKey).toBeUndefined()
    expect(out.timeoutRetryCount).toBeUndefined()
  })
})

describe('⑤b 过期判定边界：经 hydrate（rehydrate）端到端', () => {
  it('persisted done 消息（含旧 error 字段）hydrate 后原样保留，不被 settle', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-done': [makeMessage({ id: 'd1', status: 'done', text: '已完成', error: '遗留', errorKind: 'unknown' })],
      },
    })
    await useChatStore.persist.rehydrate()
    const msg = useChatStore.getState().messagesByScene['scene-done'][0]
    expect(msg.status).toBe('done')
    expect(msg.error).toBe('遗留')
    expect(msg.errorKind).toBe('unknown')
  })

  it('persisted error 消息（旧错）hydrate 后原样保留，不被 settle 覆盖为过期文案', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-err': [makeMessage({ id: 'e1', status: 'error', text: '失败', error: '上游超时', errorKind: 'upstream-timeout', timeoutRetryKey: 'k1', timeoutRetryCount: 2 })],
      },
    })
    await useChatStore.persist.rehydrate()
    const msg = useChatStore.getState().messagesByScene['scene-err'][0]
    expect(msg.status).toBe('error')
    expect(msg.error).toBe('上游超时')
    expect(msg.errorKind).toBe('upstream-timeout')
    expect(msg.timeoutRetryKey).toBe('k1')
    expect(msg.timeoutRetryCount).toBe(2)
  })

  it('多 scene 混合：仅 in-flight 被回落，跨 scene 边界正确', async () => {
    seedPersisted({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: {
        'scene-all-done': [makeMessage({ id: 'ad1', status: 'done' })],
        'scene-inflight': [makeMessage({ id: 'ai1', status: 'enhancing' }), makeMessage({ id: 'ai2', status: 'done' })],
        'scene-empty': [],
      },
    })
    await useChatStore.persist.rehydrate()
    const out = useChatStore.getState().messagesByScene
    expect(out['scene-all-done'].map((m) => m.status)).toEqual(['done'])
    expect(out['scene-inflight'].map((m) => m.status)).toEqual(['error', 'done'])
    expect(out['scene-empty']).toEqual([])
  })
})
