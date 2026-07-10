// src/store/chatTaskReconcile.ts
// FX-3: post-hydrate server-truth reconciliation for mask-edit chat cards.
//
// settleExpiredChatMessages (the chatStore merge step) blanket-marks every
// in-flight (enhancing/generating) message as 'error' ("任务已过期,请重试。") on
// hydrate. That is correct when the task is genuinely gone (server restarted /
// swept / TTL'd), but WRONG when the task actually SUCCEEDED on the server — the
// card shows "expired" even though the result exists, and the user is told to
// retry a task that already finished. This asks the per-user task registry
// (POST /api/mivo/tasks/settle, FX-2) for the truth and recovers done cards.
//
// Scope: only mask-edit cards carry a persisted serverTaskId (chat-origin
// generations use a runtime pendingSlotId + a non-persisted taskId, unrecoverable
// post-hydrate). The target signature is exactly the blanket-settle output
// (error + expired text + unknown kind), so genuine upstream errors (timeout /
// upstream-error) are left untouched.
//
// IMPORTANT — characterization red line (#167, 114 expects): this runs from
// useStoreHydration AFTER rehydrate, NOT from the chatStore merge. The
// chatHydration characterization calls useChatStore.persist.rehydrate() directly
// (not this hook), so this async pass never runs under the characterization — the
// blanket settle's synchronous post-rehydrate assertions are untouched. "只允许改
// 数据来源": the recover path's data source changes from the blanket assumption
// to server truth, but the blanket settle function + its observed output are
// unchanged.
//
// Residual: result-image recovery to the canvas slot is out of scope (the maskEdit
// commit needs source/mask data not available post-hydrate); this recovers the
// card STATUS (no longer wrongly "expired") so the card is not stuck. Still-running
// tasks aren't re-polled (the runtime poll controller is gone post-hydrate); the
// card stays as the blanket 'expired' so the user can retry — not a stuck card.

import { useChatStore, type ChatMessage } from './chatStore'
import { expiredGenerationMessage } from './chatGenerationHydration'
import { settleChatTasks, type TaskView } from '../lib/mivoTaskClient'
import { debugLogger } from './debugLogStore'

const SOURCE = 'Chat Task Reconcile'

// A mask-edit card that the blanket settle just killed: 'error' + the exact
// expired text + 'unknown' kind (settleExpiredChatMessages always sets these three
// together). Genuine upstream errors carry a different errorKind/text and are
// excluded, so we never clobber a real failure with a "recovered" status.
const isBlanketSettledMaskEditCard = (message: ChatMessage): boolean =>
  message.origin === 'mask-edit' &&
  message.status === 'error' &&
  message.error === expiredGenerationMessage &&
  message.errorKind === 'unknown' &&
  typeof message.generationContext?.maskEdit?.serverTaskId === 'string' &&
  message.generationContext.maskEdit.serverTaskId.length > 0

const recoverPatchedMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  status: 'done' as const,
  error: undefined,
  errorKind: undefined,
  timeoutRetryKey: undefined,
  timeoutRetryCount: undefined,
  retryDisabledReason: undefined,
})

/**
 * Ask the server (per-user task registry) for the truth behind blanket-settled
 * mask-edit cards and recover the ones that actually succeeded. Safe to call any
 * time after hydrate; no-op when there are no candidate cards or the settle fetch
 * fails (the blanket settle stays in place). Never throws to the caller.
 */
export const reconcileExpiredChatTasks = async (): Promise<void> => {
  const { messagesByScene } = useChatStore.getState()

  const taskIds: string[] = []
  for (const messages of Object.values(messagesByScene)) {
    for (const message of messages) {
      if (isBlanketSettledMaskEditCard(message)) {
        taskIds.push(message.generationContext!.maskEdit!.serverTaskId!)
      }
    }
  }
  if (taskIds.length === 0) return

  let results: Record<string, TaskView>
  try {
    results = await settleChatTasks(taskIds)
  } catch (error) {
    debugLogger.warn(
      SOURCE,
      `Settle fetch failed for ${taskIds.length} card(s); leaving blanket settle: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  // Count outcomes from the (target × results) cross-product — deterministic, no
  // state re-read, so the log is stable even if the store changed mid-pass.
  let recovered = 0
  let confirmedExpired = 0
  let stillRunning = 0
  let otherTerminal = 0
  for (const taskId of taskIds) {
    const view = results[taskId]
    if (!view) {
      confirmedExpired += 1 // server omitted → gone/non-owner → blanket 'expired' confirmed
    } else if (view.status === 'done' || view.status === 'partial') {
      recovered += 1
    } else if (view.status === 'running' || view.status === 'pending') {
      stillRunning += 1 // blanket 'expired' was premature, but can't re-poll post-hydrate
    } else {
      otherTerminal += 1 // failed/canceled → leave blanket 'expired' (terminal error either way)
    }
  }

  if (recovered > 0) {
    // Functional setState: apply the recover patch to the CURRENT messagesByScene
    // (race-safe if the user acted during the settle fetch). Re-checks the blanket-
    // settle signature so a card the user already retried is not clobbered.
    useChatStore.setState((state) => {
      const updated: Record<string, ChatMessage[]> = {}
      let didChange = false
      for (const [sceneId, messages] of Object.entries(state.messagesByScene)) {
        updated[sceneId] = messages.map((message) => {
          if (!isBlanketSettledMaskEditCard(message)) return message
          const view = results[message.generationContext!.maskEdit!.serverTaskId!]
          if (view && (view.status === 'done' || view.status === 'partial')) {
            didChange = true
            return recoverPatchedMessage(message)
          }
          return message
        })
      }
      return didChange ? { messagesByScene: updated } : {}
    })
  }

  debugLogger.warn(
    SOURCE,
    `Settle pass: ${taskIds.length} mask-edit card(s) — recovered=${recovered}, confirmed-expired=${confirmedExpired}, still-running=${stillRunning}, other-terminal=${otherTerminal}`,
  )
}
