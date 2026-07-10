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
import { expiredGenerationMessage, recoveredTaskDoneMessage } from './chatGenerationHydration'
import { settleChatTasks, type TaskView } from '../lib/mivoTaskClient'
import { debugLogger } from './debugLogStore'

const SOURCE = 'Chat Task Reconcile'

// P1-2: settle 有限重试(指数退避)。瞬态失败(settle 5xx/网络)原本 fire-and-forget
// 一次失败本会话永久停"已过期";重试给瞬态故障恢复窗口。纯确定性(固定 3 次、固定退避)。
// 401-because-ordering 由 useStoreHydration 在 reconcile 前 await settings rehydrate 修
// (保证 mivoKey 已恢复),不靠重试硬扛;重试只兜其余瞬态。耗尽 → warn 留痕,卡片维持
// blanket settle(下次 hydrate 天然再试)。
const SETTLE_MAX_ATTEMPTS = 3
const SETTLE_BASE_BACKOFF_MS = 200
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  // P1-1: 兜底 text。mask-edit 卡原 text 常为空(编辑靠 mask 选择,非文本 prompt);blanket
  // settle 已 ...message 保留既有 resultNodeIds(hydrate 前结果若已提交 canvas,节点引用仍在
  // → done 分支定位链接可渲染)。无 resultNodeIds 时(结果未提交)done 分支无图无文 → 空白卡,
  // 故兜底文案保证必有可渲染内容(text 或 result 至少其一)。保留原 text(非空不覆盖)。
  // result 图像 b64 不在此恢复:ChatMessage 无 inline b64 字段,done 分支靠 text 或
  // resultNodeIds 渲染;b64→canvas 节点恢复需 source/mask 数据,post-hydrate 不可得(见
  // 顶部 residual 注释),属 FX-3 既有 out-of-scope。
  text: message.text || recoveredTaskDoneMessage,
  // P1-1 补(Greptile 复扫 6198b49):...message 保留 enhance.richPrompt 时,done 文本分支
  // 因 ChatMessageList 门控 `enhance?.richPrompt === undefined` 跳过 text 渲染 → 兜底 text 被
  // 屏蔽,无 resultNodeIds 的恢复卡仍空白。无 resultNodeIds 时剥离 enhance,让兜底 text 接管
  // done 文本分支;有 resultNodeIds 时保留 enhance(卡片走 resultNodeId 图渲染,richPrompt 无害)。
  enhance: message.resultNodeIds?.length ? message.enhance : undefined,
})

/**
 * Ask the server (per-user task registry) for the truth behind blanket-settled
 * mask-edit cards and recover the ones that actually succeeded. Safe to call any
 * time after hydrate; no-op when there are no candidate cards or the settle fetch
 * fails after retries (the blanket settle stays in place). Never throws to the
 * caller. P1-2: settle 有限重试(指数退避 3 次)兜瞬态失败;P1-1: recovered 卡兜底
 * text 保证 done 分支必有可渲染内容(text 或既有 resultNodeIds)。
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

  // P1-2: 有限重试(指数退避)。瞬态失败(settle 5xx/网络)原本 fire-and-forget 一次
  // 失败本会话永久停"已过期";重试给瞬态故障恢复窗口。纯确定性(固定 3 次、固定退避)。
  // 401-because-ordering 由 useStoreHydration 在 reconcile 前 await settings rehydrate 修
  // (保证 mivoKey 已恢复),不靠重试硬扛;重试只兜其余瞬态。耗尽 → warn 留痕,卡片维持
  // blanket settle(下次 hydrate 天然再试)。
  let results: Record<string, TaskView> = {}
  let settled = false
  let lastError: unknown
  for (let attempt = 0; attempt < SETTLE_MAX_ATTEMPTS && !settled; attempt += 1) {
    try {
      results = await settleChatTasks(taskIds)
      settled = true
    } catch (error) {
      lastError = error
      if (attempt < SETTLE_MAX_ATTEMPTS - 1) {
        await sleep(SETTLE_BASE_BACKOFF_MS * 2 ** attempt)
      }
    }
  }
  if (!settled) {
    debugLogger.warn(
      SOURCE,
      `Settle failed after ${SETTLE_MAX_ATTEMPTS} attempt(s) for ${taskIds.length} card(s); leaving blanket settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
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
