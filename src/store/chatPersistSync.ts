// chatPersistSync — G1-a chat 接线(DP-6R P1-1)的 gate + enqueue 出口,从 chatStore 抽出(保持 chatStore ≤900 行)。
//
// 匿名/未认证门控:server/shadow 模式未登录 → chatStore.sendMessage/appendNotice no-op(不写 anonymous chat IDB)。
// local 模式无 auth 概念,匿名 chat 照常(local demo 零变化,表征/e2e 不红)。
// ChatComposer 读同一条件做 UI 禁用 + 登录 CTA。

import { isLocalPersist } from '../lib/persistMode'
import { useAuthStore } from './authSlice'
import { enqueuePersistWrite } from '../lib/persistBoot'
import type { WriteOp } from '../lib/writeRetryQueue'
import type { ChatMessage } from './chatStore'

/**
 * server/shadow 模式未登录 → true(阻断 chat 写)。local 模式恒 false(零变化)。
 * status='unknown'(初始未定态)也视为阻断——server 模式不赌未定态写 anonymous IDB。
 */
export const isChatBlockedForAnonymous = (): boolean => {
  if (isLocalPersist) return false
  return useAuthStore.getState().status !== 'authenticated'
}

/**
 * G1-a chat enqueue 出口:把 appendChatMessage op 入队(server/shadow → BFF;local no-op)。
 * 薄封装减 chatStore 行内冗余;message 是 finalized committed 消息(POST 幂等 per-actor)。
 */
export const enqueueChatAppend = (canvasId: string, message: ChatMessage): void => {
  const op: WriteOp = { kind: 'appendChatMessage', canvasId, message }
  enqueuePersistWrite(op)
}
