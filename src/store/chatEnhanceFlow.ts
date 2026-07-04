// src/store/chatEnhanceFlow.ts
// W4: enhance 永远先出图 —— chat 模式不再早 return 只回文字，而是用原始 text
// 生图、replyText 经 appendNotice 作附言。sendMessage 与 retryMessage 两个 chat
// return 分支共用此 helper。先例：chatStoreMigrate.ts（把逻辑抽出保持 chatStore
// 在 structure-guard 847 行红线内，净增即 FAIL）。
import type { EnhanceResponse } from '../types/generation'

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
