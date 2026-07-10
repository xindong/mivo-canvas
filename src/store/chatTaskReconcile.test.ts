// @vitest-environment node
// src/store/chatTaskReconcile.test.ts
// FX-3 (client unit): reconcileExpiredChatTasks recovers blanket-settled mask-edit
// cards whose tasks actually succeeded (server says done) and leaves genuine
// errors / gone tasks / non-targets alone. settleChatTasks is mocked (no network);
// useChatStore is a minimal in-memory stand-in (the reconcile only uses
// getState/setState — no IDB, no heavy store deps).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settleChatTasksMock = vi.fn()
vi.mock('../lib/mivoTaskClient', () => ({
  settleChatTasks: (...args: unknown[]) => settleChatTasksMock(...args),
}))

// Minimal in-memory chatStore stand-in. The reconcile only uses getState/setState
// (no persist/IDB), so this isolates the reconcile logic from the real store's
// heavy deps. Functional setState mirrors zustand's updater form (used by the
// reconcile's race-safe patch).
let storeState: { messagesByScene: Record<string, import('./chatStore').ChatMessage[]> } = {
  messagesByScene: {},
}
vi.mock('./chatStore', () => ({
  useChatStore: {
    getState: () => storeState,
    setState: (updater: unknown) => {
      const next = typeof updater === 'function' ? (updater as (s: typeof storeState) => typeof storeState)(storeState) : updater
      storeState = { ...storeState, ...(next as typeof storeState) }
    },
  },
}))

// FX-3b: minimal in-memory canvasStore stand-in. The reconcile reads
// canvases[sceneId].nodes (to check slot/source existence) and calls
// commitGenerationResult (async, IDB in prod). Both are isolated here.
type CanvasNodeStub = { id: string; type: 'image' | 'ai-slot' | string; hidden?: boolean }
let canvasState: { canvases: Record<string, { nodes: CanvasNodeStub[] }> } = { canvases: {} }
const commitGenerationResultMock = vi.fn()
vi.mock('./canvasStore', () => ({
  useCanvasStore: {
    getState: () => ({
      canvases: canvasState.canvases,
      commitGenerationResult: (...args: unknown[]) => commitGenerationResultMock(...args),
    }),
  },
}))

import { reconcileExpiredChatTasks } from './chatTaskReconcile'
import { expiredGenerationMessage, recoveredTaskDoneMessage } from './chatGenerationHydration'
import { useDebugLogStore } from './debugLogStore'
import type { ChatMessage } from './chatStore'

const ctx = (serverTaskId: string) => ({
  model: 'gpt-image-2',
  requestedImgRatio: 'auto' as const,
  requestedQuality: 'auto' as const,
  maskEdit: { serverTaskId },
})

// A mask-edit card exactly as settleExpiredChatMessages leaves it (error + expired
// text + unknown kind + a persisted serverTaskId).
const blanketSettledCard = (id: string, taskId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text: '',
  createdAt: 0,
  status: 'error',
  error: expiredGenerationMessage,
  errorKind: 'unknown',
  origin: 'mask-edit',
  generationContext: ctx(taskId),
  ...extra,
})

const setScene = (sceneId: string, messages: ChatMessage[]): void => {
  storeState = { messagesByScene: { [sceneId]: messages } }
}

// FX-3b: canvas node stubs + a generationContext that carries pendingSlotId (the
// persisted slot id the recover path backfills into) + sourceNodeId + finalPrompt.
const setCanvas = (sceneId: string, nodes: CanvasNodeStub[]): void => {
  canvasState = { canvases: { [sceneId]: { nodes } } }
}

const ctxWithSlot = (
  serverTaskId: string,
  pendingSlotId: string,
  extra: Partial<import('./chatStore').ChatGenerationContext> = {},
): import('./chatStore').ChatGenerationContext => ({
  model: 'gpt-image-2',
  requestedImgRatio: 'auto' as const,
  requestedQuality: 'auto' as const,
  maskEdit: { serverTaskId },
  pendingSlotId,
  ...extra,
})

const doneView = (taskId: string, withImages = true) => ({
  id: taskId,
  kind: 'edit' as const,
  status: 'done' as const,
  progress: 100,
  stage: 'done',
  requestId: 'r',
  model: 'gpt-image-2',
  ...(withImages ? { result: { images: [{ b64: 'abc' }] } } : {}),
})

describe('FX-3 reconcileExpiredChatTasks', () => {
  beforeEach(() => {
    storeState = { messagesByScene: {} }
    canvasState = { canvases: {} }
    settleChatTasksMock.mockReset()
    commitGenerationResultMock.mockReset()
  })

  it('recovers a blanket-settled card when the server says done', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done')])
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2', result: { images: [{ b64: 'x' }] } },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.error).toBeUndefined()
    expect(msg.errorKind).toBeUndefined()
    expect(msg.retryDisabledReason).toBeUndefined()
    expect(msg.timeoutRetryKey).toBeUndefined()
    expect(settleChatTasksMock).toHaveBeenCalledWith(['t-done'])
  })

  it('leaves the card as expired when the server omits it (gone)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-gone')])
    settleChatTasksMock.mockResolvedValue({}) // omitted → gone

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('error')
    expect(msg.error).toBe(expiredGenerationMessage)
  })

  it('leaves the card when the server says still-running (no re-poll post-hydrate)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-run')])
    settleChatTasksMock.mockResolvedValue({
      't-run': { id: 't-run', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'r', model: 'gpt-image-2' },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('error') // not recovered, not stuck-generating
  })

  it('leaves a genuine upstream error untouched (not a blanket-settle signature) → no fetch', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-real', { status: 'error', error: '上游超时', errorKind: 'upstream-timeout' })])

    await reconcileExpiredChatTasks()

    expect(settleChatTasksMock).not.toHaveBeenCalled()
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.error).toBe('上游超时')
  })

  it('skips chat-origin cards (no persisted serverTaskId) → no fetch', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-chat', {
        origin: 'chat',
        generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto' as const, requestedQuality: 'auto' as const, pendingSlotId: 'slot-1' },
      }),
    ])

    await reconcileExpiredChatTasks()

    expect(settleChatTasksMock).not.toHaveBeenCalled()
  })

  it('no candidate cards → no fetch, no state change', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done', { status: 'done', error: undefined, errorKind: undefined })])

    await reconcileExpiredChatTasks()

    expect(settleChatTasksMock).not.toHaveBeenCalled()
  })

  it('settle fetch throws → leaves blanket settle, does not throw to caller', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-net')])
    settleChatTasksMock.mockRejectedValue(new Error('network'))

    await expect(reconcileExpiredChatTasks()).resolves.toBeUndefined()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('error')
  })

  it('batch: recovers the done one, leaves the gone one (single settle call)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done'), blanketSettledCard('m2', 't-gone'), blanketSettledCard('m3', 't-run')])
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' },
      't-run': { id: 't-run', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'r', model: 'gpt-image-2' },
    })

    await reconcileExpiredChatTasks()

    expect(settleChatTasksMock).toHaveBeenCalledTimes(1)
    expect(settleChatTasksMock).toHaveBeenCalledWith(['t-done', 't-gone', 't-run'])
    const msgs = storeState.messagesByScene['s1']
    expect(msgs.map((m) => m.status)).toEqual(['done', 'error', 'error'])
  })

  it('does not clobber a card the caller already retried during the settle fetch (race-safe)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done')])
    settleChatTasksMock.mockImplementation(async () => {
      // Simulate the user retrying DURING the settle fetch (after the scan found the
      // target, before setState runs). The card is no longer a blanket-settled card.
      storeState.messagesByScene['s1'][0] = { ...storeState.messagesByScene['s1'][0], status: 'generating', error: undefined, errorKind: undefined }
      return { 't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' } }
    })

    await reconcileExpiredChatTasks()

    // The functional setState re-checked the blanket-settle signature and left the
    // retried card alone (did not clobber 'generating' back to 'done').
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('generating')
  })

  it('P1-1: 空 text 的 mask-edit 卡 recover 后兜底 text(done 分支必有可渲染内容)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done')]) // text: '' (helper 默认)
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2', result: { images: [{ b64: 'x' }] } },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    // 原 text 空 → 兜底文案;done 分支必有可渲染内容(text 或 resultNodeIds 至少其一)
    expect(msg.text).toBe(recoveredTaskDoneMessage)
    expect(msg.text.length).toBeGreaterThan(0)
  })

  it('P1-1: recover 保留既有 text(非空不覆盖)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done', { text: '把背景换成蓝色' })])
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.text).toBe('把背景换成蓝色') // 原 text 保留,不被兜底覆盖
  })

  it('P1-1: recover 保留既有 resultNodeIds(done 分支 result 可渲染)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done', { resultNodeIds: ['node-1'] })])
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.resultNodeIds).toEqual(['node-1']) // 既有 resultNodeIds 保留,done 分支定位链接可渲染
  })

  it('P1-1 补: 带 enhance.richPrompt 且无 resultNodeIds 的卡 recover 后剥离 enhance + 兜底 text', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done', {
      enhance: { richPrompt: '原 richPrompt' },
    })])
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    // 无 resultNodeIds → 剥离 enhance,否则 ChatMessageList done 文本分支门控
    // enhance?.richPrompt === undefined 会跳过 text 渲染,兜底 text 被屏蔽 → 空白卡
    expect(msg.enhance).toBeUndefined()
    expect(msg.text).toBe(recoveredTaskDoneMessage) // 兜底 text 接管 done 文本分支
  })

  it('P1-1 补: 带 resultNodeIds 的卡 recover 后 enhance 保留(卡片走图渲染,richPrompt 无害)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done', {
      resultNodeIds: ['node-1'],
      enhance: { richPrompt: '原 richPrompt' },
    })])
    settleChatTasksMock.mockResolvedValue({
      't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' },
    })

    await reconcileExpiredChatTasks()

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.resultNodeIds).toEqual(['node-1'])
    // 有 resultNodeIds → enhance 保留(卡片走 resultNodeId 图渲染,richPrompt 不影响)
    expect(msg.enhance).toEqual({ richPrompt: '原 richPrompt' })
  })
})

// P1-2: settle 有限重试(指数退避 3 次)。fake timers 避免真实 200/400ms 等待。
describe('FX-3 reconcileExpiredChatTasks — P1-2 settle retry', () => {
  beforeEach(() => {
    storeState = { messagesByScene: {} }
    settleChatTasksMock.mockReset()
    useDebugLogStore.getState().clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('瞬态失败 → 重试成功 → 恢复卡(settleChatTasks 调用 2 次)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-done')])
    settleChatTasksMock
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ 't-done': { id: 't-done', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'r', model: 'gpt-image-2' } })

    const promise = reconcileExpiredChatTasks()
    await vi.advanceTimersByTimeAsync(1000) // flush 200ms 退避 + microtasks
    await promise

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.text).toBe(recoveredTaskDoneMessage)
    expect(settleChatTasksMock).toHaveBeenCalledTimes(2)
  })

  it('全部失败 → 不抛、warn 留痕、卡片维持 error(settleChatTasks 调用 3 次)', async () => {
    setScene('s1', [blanketSettledCard('m1', 't-net')])
    settleChatTasksMock.mockRejectedValue(new Error('network'))

    const promise = reconcileExpiredChatTasks()
    await vi.advanceTimersByTimeAsync(10000) // flush 200+400ms 退避 + microtasks
    await promise

    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('error')
    expect(msg.error).toBe(expiredGenerationMessage)
    expect(settleChatTasksMock).toHaveBeenCalledTimes(3)
    const warn = useDebugLogStore
      .getState()
      .entries.find((e) => /Settle failed after 3 attempt/.test(e.message))
    expect(warn).toBeDefined()
  })
})

// FX-3b: recovered 分支从「只翻 status」升级为「先回灌结果图到 canvas 槽,再翻卡」。
// settleChatTasks 已在上面覆盖;这里聚焦 commitGenerationResult 调度 + payload + 降级 + race-safe。
describe('FX-3b reconcileExpiredChatTasks — result-image backfill', () => {
  beforeEach(() => {
    storeState = { messagesByScene: {} }
    canvasState = { canvases: {} }
    settleChatTasksMock.mockReset()
    commitGenerationResultMock.mockReset()
    useDebugLogStore.getState().clear()
  })

  it('(a) done+images+slot 存活(ai-slot) → commit 被调(payload: replaceSlotId/resultImages/kind=edit/不含 maskBounds) 且卡片 done + resultNodeIds = commit 返回值', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-done', {
        generationContext: ctxWithSlot('t-done', 'slot-1', { sourceNodeId: 'src-1', finalPrompt: '把背景换蓝' }),
      }),
    ])
    setCanvas('s1', [
      { id: 'slot-1', type: 'ai-slot', hidden: false },
      { id: 'src-1', type: 'image', hidden: false },
    ])
    settleChatTasksMock.mockResolvedValue({ 't-done': doneView('t-done') })
    commitGenerationResultMock.mockResolvedValue(['node-result-1'])

    await reconcileExpiredChatTasks()

    expect(commitGenerationResultMock).toHaveBeenCalledTimes(1)
    const payload = commitGenerationResultMock.mock.calls[0][0]
    expect(payload.replaceSlotId).toBe('slot-1')
    expect(payload.resultImages).toEqual([{ b64: 'abc' }])
    expect(payload.kind).toBe('edit')
    expect(payload.sourceNodeId).toBe('src-1') // source 仍存在 → 传
    expect(payload.lineageSourceId).toBe('src-1')
    expect(payload.createDerivationEdge).toBe(true)
    expect(payload.reflow).toBe(true)
    expect(payload.model).toBe('gpt-image-2')
    expect(payload.taskId).toBe('t-done')
    expect(payload.placement).toBe('right')
    expect(payload.prompt).toBe('把背景换蓝')
    expect(payload.maskBounds).toBeUndefined() // P2-4: 未持久化,不传
    expect(payload.maskSourceSize).toBeUndefined()
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.resultNodeIds).toEqual(['node-result-1'])
    expect(msg.error).toBeUndefined()
    expect(msg.errorKind).toBeUndefined()
    expect(msg.retryDisabledReason).toBeUndefined()
    expect(msg.generationContext?.maskEdit?.sourceDeleted).toBe(false)
    expect(msg.generationContext?.maskEdit?.phase).toBeUndefined()
    // 成功路径有 log(debugLogger.log)
    const log = useDebugLogStore.getState().entries.find((e) => /commit succeeded/.test(e.message))
    expect(log).toBeDefined()
  })

  it('(b) slot 已删 → 不调 commit,仅翻 done', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-done', {
        generationContext: ctxWithSlot('t-done', 'slot-gone', { sourceNodeId: 'src-1' }),
      }),
    ])
    setCanvas('s1', [{ id: 'src-1', type: 'image', hidden: false }]) // slot 不在
    settleChatTasksMock.mockResolvedValue({ 't-done': doneView('t-done') })
    commitGenerationResultMock.mockResolvedValue(['should-not-be-called'])

    await reconcileExpiredChatTasks()

    expect(commitGenerationResultMock).not.toHaveBeenCalled()
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.resultNodeIds).toBeUndefined() // 仅翻 status,不回灌
    // 跳过路径有 warn(debugLogger.warn)
    const warn = useDebugLogStore.getState().entries.find((e) => /not an active ai-slot/.test(e.message))
    expect(warn).toBeDefined()
  })

  it('(c) done 但 result.images 空/缺 → 不调 commit,仅翻 done', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-done', { generationContext: ctxWithSlot('t-done', 'slot-1') }),
    ])
    setCanvas('s1', [{ id: 'slot-1', type: 'ai-slot', hidden: false }])
    settleChatTasksMock.mockResolvedValue({ 't-done': doneView('t-done', false) }) // 无 result
    commitGenerationResultMock.mockResolvedValue(['should-not-be-called'])

    await reconcileExpiredChatTasks()

    expect(commitGenerationResultMock).not.toHaveBeenCalled()
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.resultNodeIds).toBeUndefined()
  })

  it('(d) pendingSlotId 节点已是 type=image → 不调 commit,resultNodeIds=[slotId] 翻 done', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-done', { generationContext: ctxWithSlot('t-done', 'slot-1') }),
    ])
    // slot 已被原位替换为 image(commitGenerationResult 复用 slot id)→ 上次会话死于 commit 后翻卡前
    setCanvas('s1', [{ id: 'slot-1', type: 'image', hidden: false }])
    settleChatTasksMock.mockResolvedValue({ 't-done': doneView('t-done') })
    commitGenerationResultMock.mockResolvedValue(['should-not-be-called'])

    await reconcileExpiredChatTasks()

    expect(commitGenerationResultMock).not.toHaveBeenCalled()
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done')
    expect(msg.resultNodeIds).toEqual(['slot-1']) // 复用 slot id
    // pre-flip 复用路径有 log
    const log = useDebugLogStore.getState().entries.find((e) => /already committed as image/.test(e.message))
    expect(log).toBeDefined()
  })

  it('(e) commit 抛错 → 降级仅翻 done,reconcileExpiredChatTasks 不抛', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-done', { generationContext: ctxWithSlot('t-done', 'slot-1', { finalPrompt: 'p' }) }),
    ])
    setCanvas('s1', [{ id: 'slot-1', type: 'ai-slot', hidden: false }])
    settleChatTasksMock.mockResolvedValue({ 't-done': doneView('t-done') })
    commitGenerationResultMock.mockRejectedValue(new Error('asset save failed'))

    await expect(reconcileExpiredChatTasks()).resolves.toBeUndefined()

    expect(commitGenerationResultMock).toHaveBeenCalledTimes(1)
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('done') // 降级仅翻 status
    expect(msg.resultNodeIds).toBeUndefined() // commit 失败,无结果图
    // 失败路径有 warn(debugLogger.warn)
    const warn = useDebugLogStore.getState().entries.find((e) => /commit failed/.test(e.message))
    expect(warn).toBeDefined()
  })

  it('(SC-6) commit 期间用户 retry 卡(签名已变)→ setState 不覆盖,卡保持 generating', async () => {
    setScene('s1', [
      blanketSettledCard('m1', 't-done', { generationContext: ctxWithSlot('t-done', 'slot-1', { finalPrompt: 'p' }) }),
    ])
    setCanvas('s1', [{ id: 'slot-1', type: 'ai-slot', hidden: false }])
    settleChatTasksMock.mockResolvedValue({ 't-done': doneView('t-done') })
    // commit 执行期间用户 retry:卡离开 blanket-settle 签名(status=generating,清 error/errorKind)
    commitGenerationResultMock.mockImplementation(async () => {
      storeState.messagesByScene['s1'][0] = {
        ...storeState.messagesByScene['s1'][0],
        status: 'generating',
        error: undefined,
        errorKind: undefined,
      }
      return ['node-result-1']
    })

    await reconcileExpiredChatTasks()

    // commit 已执行(canvas 侧效:结果图落地但成为孤儿;可接受的残余)
    expect(commitGenerationResultMock).toHaveBeenCalledTimes(1)
    // 但卡状态未被翻回 done(setState 内复查 blanket 签名失败 → 不覆盖)
    const msg = storeState.messagesByScene['s1'][0]
    expect(msg.status).toBe('generating')
    expect(msg.resultNodeIds).toBeUndefined()
  })
})
