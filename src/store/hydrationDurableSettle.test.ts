// SC-15 R2 (mainfix 复审返修) — hydration settle 必须 durable 回写持久层。
//
// 根因：chatStore.merge 的 settleExpiredChatMessages 与 canvasGenerationHydration 的
// settleExpiredCanvasGenerations 把过期 generating 消息/slot 在 rehydrate 时 settle 成
// error/failed（内存正确，UI 也正确显示过期态），但 zustand persist v5 的 hydrate 把
// merge 结果用 *vanilla* set 写回（middleware.mjs:421 `set(stateFromStorage, true)`），
// 仅在版本 *migrate* 时才调 setItem（line 422-424 `if (migrated) return setItem()`）。
// 当 persisted version == options.version（v2==v2 / v11==v11，无 migrate）时，setItem
// 根本不会被调 → settled 状态只活在内存里，IDB / localStorage 仍是旧 generating blob。
// reload-2 从旧 durable 状态重新 settle，SC-15 规定的"chat card error + canvas slot
// failed 持久化"未真正实现。
//
// 本文件是该根因的红测试：不经过 e2e harness 的 waitForPersistedKv fallback（那正是
// 掩盖本 bug 的假阳性源 — harness.mjs:165 超时返回任意非空 raw），直接在 rehydrate 后
// 用原生 localStorage 断言"持久层里有语义正确的 settled 数据"。fix 前：rehydrate 不
// 触发 setItem → blob 仍是 generating → waitForBlob 超时返回 null → expect RED。
// fix 后：onRehydrateStorage 受 settle 计数门控触发一次受控 writeback → blob 落 settled → GREEN。
//
// Node 测试环境无 indexedDB，idbStateStorage 在 isIdbAvailable()=false 时回落到
// localStorage.getItem/setItem（与 chatHydration.characterization.test.ts 同套路），
// 故此处用内存 localStorage 即可走满真实 persist 路径（merge + persist storage + writeback）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

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
import type { ChatMessage } from './chatStore'
import type { CanvasDocument, CanvasId, CanvasTask, MivoCanvasNode } from '../types/mivoCanvas'

const MASK_EXPIRED_RETRY = '局部重绘任务已过期，请重新选择区域后再试'

const ls = () =>
  (globalThis as { localStorage: { setItem: (k: string, v: string) => void; getItem: (k: string) => string | null; clear: () => void } }).localStorage

const seedChat = (state: Record<string, unknown>, version = 2) => {
  ls().setItem('mivo-chat-demo', JSON.stringify({ state, version }))
}
const seedCanvas = (state: Record<string, unknown>, version = 11) => {
  ls().setItem('mivo-canvas-demo', JSON.stringify({ state, version }))
}

// 诚实 polling helper：predicate 不满足 → 超时返回 null（绝不像旧的
// waitForPersistedKv fallback 那样返回最后一个非空 raw 制造假绿）。RED 时 predicate
// 永远 false（blob 仍 generating）→ 返回 null → expect(raw).not.toBeNull() 失败。
const waitForBlob = async (
  key: string,
  predicate: (raw: string) => boolean,
  { timeout = 1000, interval = 10 } = {},
): Promise<string | null> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const raw = ls().getItem(key)
    if (raw !== null && predicate(raw)) return raw
    await new Promise((r) => setTimeout(r, interval))
  }
  return null
}

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  role: 'assistant',
  text: '',
  createdAt: 0,
  status: 'done',
  ...overrides,
})

const slotNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'slot-1',
  type: 'ai-slot',
  title: 'Slot',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'generating',
  aiWorkflow: { kind: 'slot', status: 'generating', operation: 'slot-generation', prompt: 'p' },
  ...overrides,
})

const document = (overrides: Partial<CanvasDocument> = {}): CanvasDocument => ({
  title: 'demo',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  ...overrides,
})

const resetStores = () => {
  useChatStore.setState({ ...useChatStore.getInitialState() } as never, true)
  useCanvasStore.setState({ ...useCanvasStore.getInitialState() } as never, true)
  genFacadeSpies.getSceneChangeInfo.mockReturnValue({ sceneChanged: false, currentSceneId: '', sceneTitle: '' })
}

beforeEach(() => {
  ls().clear()
  resetStores()
})

describe('SC-15 R2: hydration settle must durable-writeback to persist storage', () => {
  it('chat: mask-edit generating → error+retryDisabledReason durable in storage after rehydrate', async () => {
    const generatingMaskEdit = makeMessage({
      id: 'm1',
      status: 'generating',
      origin: 'mask-edit',
      retryDisabledReason: 'old-disabled',
      generationContext: {
        model: 'gpt-image-2',
        requestedImgRatio: 'auto',
        requestedQuality: 'auto',
        pendingSlotId: 'slot-m',
        maskEdit: { sourceTitle: 'src', serverTaskId: 't-1' },
      },
    })
    seedChat({
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: { 'scene-m': [generatingMaskEdit] },
    })

    await useChatStore.persist.rehydrate()

    // 内存 sanity（fix 前后都成立：merge 在内存里 settle）
    const msg = useChatStore.getState().messagesByScene['scene-m'][0]
    expect(msg.status).toBe('error')
    expect(msg.retryDisabledReason).toBe(MASK_EXPIRED_RETRY)

    // DURABLE 断言（不经 harness fallback，直接读持久层）。
    // fix 前：rehydrate 不触发 setItem → blob 仍 generating → waitForBlob 超时返 null → RED。
    // fix 后：onRehydrateStorage 受 settle 计数门控触发 writeback → blob 落 settled → GREEN。
    const settledRaw = await waitForBlob('mivo-chat-demo', (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const m = parsed?.state?.messagesByScene?.['scene-m']?.[0]
        return (
          m?.status === 'error' &&
          typeof m?.retryDisabledReason === 'string' &&
          m.retryDisabledReason.includes('局部重绘')
        )
      } catch {
        return false
      }
    })
    expect(settledRaw).not.toBeNull()
  })

  it('canvas: ai-slot generating → aiWorkflow.status=failed durable in storage after rehydrate', async () => {
    const sceneId: CanvasId = 'character-flow'
    seedCanvas({
      sceneId,
      canvases: {
        [sceneId]: document({ nodes: [slotNode({ id: 'slot-1', status: 'generating' })], tasks: [] }),
      },
    })

    await useCanvasStore.persist.rehydrate()

    // 内存 sanity：ai-slot 被 settle 成 failed
    const canvases = useCanvasStore.getState().canvases
    const slot = (canvases[sceneId]?.nodes || []).find((n) => n.type === 'ai-slot')
    expect(slot?.aiWorkflow?.status).toBe('failed')

    // DURABLE 断言。fix 前：blob 仍 aiWorkflow.status=generating → RED。fix 后：failed → GREEN。
    const settledRaw = await waitForBlob('mivo-canvas-demo', (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const canvasesParsed = parsed?.state?.canvases ?? {}
        return Object.values(canvasesParsed).some((c) =>
          (Array.isArray((c as CanvasDocument).nodes) ? (c as CanvasDocument).nodes : []).some(
            (n) => n.type === 'ai-slot' && n.aiWorkflow?.status === 'failed',
          ),
        )
      } catch {
        return false
      }
    })
    expect(settledRaw).not.toBeNull()
  })

  it('gate: no settle (already-settled state) → no writeback, blob unchanged', async () => {
    // settle 计数=0 时不得无条件 rewrite（避免每次 reload 都重写 10k 节点 canvas blob）。
    // seed 一条已 settled（error）消息 → rehydrate 不 settle → 不触发 writeback →
    // blob 应与 seed 字节一致。fix 前后都应绿（fix 前根本不 writeback；fix 后门控不 fire）。
    const settledMsg = makeMessage({
      id: 'e1',
      status: 'error',
      origin: 'chat',
      error: '任务已过期,请重试。',
      errorKind: 'unknown',
    })
    const state = {
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      messagesByScene: { 'scene-s': [settledMsg] },
    }
    seedChat(state)
    const before = ls().getItem('mivo-chat-demo')

    await useChatStore.persist.rehydrate()
    // flush 任何 fire-and-forget setItem（fix 后若错误触发 writeback，这里有变动）
    await new Promise((r) => setTimeout(r, 50))

    const after = ls().getItem('mivo-chat-demo')
    expect(after).toBe(before)
  })
})

// 收口：复用 CanvasTask 类型占位（document() 的 tasks 字段类型对齐，避免 TS unused 报错）
export type _CanvasTaskRef = CanvasTask
