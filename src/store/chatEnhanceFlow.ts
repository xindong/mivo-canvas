// src/store/chatEnhanceFlow.ts
// W4: enhance 永远先出图 —— chat 模式不再早 return 只回文字，而是用原始 text
// 生图、replyText 经 appendNotice 作附言。sendMessage 与 retryMessage 两个 chat
// return 分支共用此 helper。先例：chatStoreMigrate.ts（把逻辑抽出保持 chatStore
// 在 structure-guard 847 行红线内，净增即 FAIL）。
import type { EnhanceResponse } from '../types/generation'
import type { ChatEnhanceResult, ChatMessage } from './chatStore'

export type ChatEnhanceResolution = {
  /** 用于生图的最终 prompt。chat 模式用原始 text（用户说什么画什么），
   *  generate 模式用 enhance.richPrompt（agent 润色后）。 */
  finalPrompt: string
  /** chat 模式的澄清附言（replyText），生成后经 appendNotice 作附言展示。
   *  generate 模式为 undefined（无附言）。 */
  noticeText?: string
}

/** 把 enhance 结果解析为生图 finalPrompt + 可选附言。
 *  - chat 模式（mode='chat' && replyText 非空）：finalPrompt = 原始 text，
 *    noticeText = replyText.trim()
 *  - generate 模式：finalPrompt = richPrompt || 原始 text，noticeText = undefined
 *  调用方生成后若 noticeText 非空，经 appendNotice 作附言展示。 */
export const resolveChatEnhance = (
  enhanceResult: EnhanceResponse,
  originalText: string,
): ChatEnhanceResolution => {
  if (enhanceResult.mode === 'chat' && enhanceResult.replyText?.trim()) {
    return {
      finalPrompt: originalText,
      noticeText: enhanceResult.replyText.trim(),
    }
  }
  return {
    finalPrompt: enhanceResult.richPrompt || originalText,
  }
}

/** mask-chat-card Step 3: mask-edit 调用点专用的 enhance 解析。
 *  - chat 模式（mode='chat' && replyText 非空）：finalPrompt = 原始 text，
 *    noticeText = replyText.trim()（用户输入作生图 prompt，agent 回复作附言）
 *  - degraded（enhanced=false）：finalPrompt = 原始 text，noticeText = undefined
 *    （降级原因 degradedReason/stage 不在此处理，由调用方透传/展示）
 *  - generate 模式（enhanced）：finalPrompt = richPrompt || 原始 text，无 noticeText
 *
 *  与 resolveChatEnhance 同语义，独立命名是为了 mask-edit 调用点可读性 +
 *  未来分叉（mask edit 可能追加 mask 区域提示、把 editContext 透传给 LLM 等）。 */
export const resolveMaskEditEnhance = (
  enhanceResult: EnhanceResponse,
  originalText: string,
): ChatEnhanceResolution => {
  // degraded：直接用原始 text 生图，不读 richPrompt（避免降级残留 richPrompt 的边界）
  if (enhanceResult.enhanced === false) {
    return { finalPrompt: originalText }
  }
  // chat：用原始 text 生图，replyText 作附言
  if (enhanceResult.mode === 'chat' && enhanceResult.replyText?.trim()) {
    return {
      finalPrompt: originalText,
      noticeText: enhanceResult.replyText.trim(),
    }
  }
  // generate（enhanced）：用润色后的 richPrompt，退化回 originalText
  return {
    finalPrompt: enhanceResult.richPrompt || originalText,
  }
}

/** mask-chat-card: 从 chatStore 外迁的 enhance→ChatEnhanceResult 映射（保持 chatStore <= 833 行）。
 *  enhanced 时透传 scene/reasoning/richPrompt/imgRatio/quality/degradedReason/stage；
 *  degraded 时只留 degradedReason/stage。供 sendMessage/retryMessage/mask flow 共用。 */
export const enhanceForGeneration = (enhanceResult: EnhanceResponse): ChatEnhanceResult =>
  enhanceResult.enhanced
    ? {
        scene: enhanceResult.scene,
        reasoning: enhanceResult.reasoning,
        richPrompt: enhanceResult.richPrompt,
        imgRatio: enhanceResult.imgRatio,
        quality: enhanceResult.quality,
        degradedReason: enhanceResult.degradedReason,
        stage: enhanceResult.stage,
      }
    : { degradedReason: enhanceResult.degradedReason, stage: enhanceResult.stage }

/** mask-chat-card: 从 chatStore 外迁的 history 提取（取最近 limit 条 done 的 user/assistant，
 *  content 用 richPrompt 回退 text）。保持 chatStore <= 833 行。 */
export const historyForEnhance = (messages: ChatMessage[], limit = 6) =>
  messages
    .filter((m) => m.status === 'done' && m.kind !== 'notice' && (m.role === 'user' || m.role === 'assistant') && Boolean(m.enhance?.richPrompt || m.text))
    .slice(-limit)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.enhance?.richPrompt || m.text }))

/** mask-chat-card: 从 chatStore 外迁的消息裁剪（保持 chatStore <= 833 行）。 */
export const maxMessagesPerScene = 200
export const trimSceneMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.length > maxMessagesPerScene ? messages.slice(-maxMessagesPerScene) : messages
