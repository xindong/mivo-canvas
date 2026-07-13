// chatPersistSync — G1-a chat 接线(DP-6R P1-1)的 gate + enqueue 出口,从 chatStore 抽出(保持 chatStore ≤900 行)。
//
// 匿名/未认证门控:server/shadow 模式未登录 → chatStore.sendMessage/appendNotice no-op(不写 anonymous chat IDB)。
// local 模式无 auth 概念,匿名 chat 照常(local demo 零变化,表征/e2e 不红)。
// ChatComposer 读同一条件做 UI 禁用 + 登录 CTA。

import { isLocalPersist } from '../lib/persistMode'
import { useAuthStore } from './authSlice'
import { enqueuePersistWrite } from '../lib/persistBoot'
import type { ChatMessage } from './chatStore'

/**
 * server/shadow 模式未登录 → true(阻断 chat 写)。local 模式恒 false(零变化)。
 * status='unknown'(初始未定态)也视为阻断——server 模式不赌未定态写 anonymous IDB。
 */
export const isChatBlockedForAnonymous = (): boolean => {
  if (isLocalPersist) return false
  return useAuthStore.getState().status !== 'authenticated'
}

// P2-3(sol 第二轮返修):R-7 unsynced sidecar 生命周期。DI 模式(同 #236 chatMaskEditFlow 的
//   setChatStoreAccessor 思路)——chatStore 尾部注入 useChatStore 实例,本模块经 accessor 取用,
//   打破 chatPersistSync↔chatStore 静态环(本模块不静态 import chatStore);运行时同步执行无竞态。
//   markUnsynced:enqueueChatAppend 在 queue active 时置位(local 不置,消"local 假 marker → 切 server 永久 union")。
//   clearUnsynced:writeRetryQueue onOutcome 在 op 终态(success/terminal)时清位(消"成功不清/terminal 留假 pending");
//     非终态(transient-retry/401/retained)不清(保持 pending)。
type ChatStoreInstance = typeof import('./chatStore')['useChatStore']
let chatStoreAccessor: ChatStoreInstance | null = null
export const registerChatStoreAccessor = (accessor: ChatStoreInstance): void => {
  chatStoreAccessor = accessor
}

/** P2-3:置位 msgId(enqueueChatAppend 在 queue active 时调;local 不调)。dedup 防重复 push。 */
const markUnsynced = (canvasId: string, messageId: string): void => {
  if (!chatStoreAccessor) return
  chatStoreAccessor.setState((s) => {
    const prev = s.unsyncedChatMsgIds[canvasId] ?? []
    if (prev.includes(messageId)) return {}
    return { unsyncedChatMsgIds: { ...s.unsyncedChatMsgIds, [canvasId]: [...prev, messageId] } }
  })
}

/** P2-3:清 msgId(writeRetryQueue onOutcome 在 op 终态时调;消"成功不清/terminal 留假 pending")。 */
const clearUnsynced = (canvasId: string, messageId: string): void => {
  if (!chatStoreAccessor) return
  chatStoreAccessor.setState((s) => {
    const prev = s.unsyncedChatMsgIds[canvasId]
    if (!prev || !prev.includes(messageId)) return {}
    return { unsyncedChatMsgIds: { ...s.unsyncedChatMsgIds, [canvasId]: prev.filter((id) => id !== messageId) } }
  })
}

/** P2-3:清 sidecar msgId(op 终态时 writeRetryQueue onOutcome 调;dynamic import by persistBoot)。 */
export const clearUnsyncedMarker = (canvasId: string, messageId: string): void => {
  clearUnsynced(canvasId, messageId)
}

/**
 * G1-a chat enqueue 出口:把 appendChatMessage op 入队(server/shadow → BFF;local no-op)。
 * message 是 finalized committed 消息(POST 幂等 per-actor)。
 * P2-3(sol 第二轮返修):marker 仅在 enqueuePersistWrite 返非 undefined(queue active,op 已入队将持久)
 *   时置位——local/无队列(返 undefined)不置(消"local 假 marker → 切 server 被当 pending 永久 union")。
 *   终态(success/terminal)经 writeRetryQueue onOutcome → clearUnsyncedMarker 清位;非终态保留。
 */
export const enqueueChatAppend = (canvasId: string, message: ChatMessage): void => {
  const enqueuePromise = enqueuePersistWrite({ kind: 'appendChatMessage', canvasId, message })
  if (enqueuePromise) markUnsynced(canvasId, message.id) // queue active → real pending append
  // local(返 undefined)→ 不置 marker(hydrate 不当 pending 保留,按 canonical 删除)
}
