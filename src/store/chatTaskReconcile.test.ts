// @vitest-environment node
// src/store/chatTaskReconcile.test.ts
// FX-3 (client unit): reconcileExpiredChatTasks recovers blanket-settled mask-edit
// cards whose tasks actually succeeded (server says done) and leaves genuine
// errors / gone tasks / non-targets alone. settleChatTasks is mocked (no network);
// useChatStore is a minimal in-memory stand-in (the reconcile only uses
// getState/setState — no IDB, no heavy store deps).
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { reconcileExpiredChatTasks } from './chatTaskReconcile'
import { expiredGenerationMessage } from './chatGenerationHydration'
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

describe('FX-3 reconcileExpiredChatTasks', () => {
  beforeEach(() => {
    storeState = { messagesByScene: {} }
    settleChatTasksMock.mockReset()
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
})
