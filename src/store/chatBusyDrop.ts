// src/store/chatBusyDrop.ts
// S01: sendMessage 在保存完参考图后发现 isBusy（另一生成在飞），需落失败态
// user+assistant(error) 消息保留用户输入并引用已保存参考图（不孤儿），retry 可重放。
// 抽出纯构造逻辑（不 value-import useChatStore，避免重建 A01 刚打断的值级环），
// 参考 chatEnhanceFlow/chatMaskEditFlow 的抽法。chatStore 调用方负责 warn + set/trim。
import type { ChatGenerationContext, ChatMessage } from './chatStore'
import type { GenerationRatio, MivoImageQuality } from '../types/generation'

/** busy-drop assistant 提示文案。retry 推导 prompt 时不应命中此文案——
 *  调用方必须把用户原始 text 固化进 context.finalPrompt（见 buildBusyDropMessages）。 */
export const busyRetryAdvice = '已有生成进行中，请稍后重试'

const createMessageId = () => `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

export type BuildBusyDropMessagesArgs = {
  text: string
  selectedNodeId?: string
  selectedNodeType?: string
  referenceAssetUrls: string[]
  model: string
  requestedImgRatio: GenerationRatio | 'auto'
  requestedQuality: MivoImageQuality | 'auto'
}

/** 构造 busy-drop 的 user + assistant(error) 两条消息。纯函数，不碰 store。
 *  generationContext.finalPrompt 显式落用户原始 text：retryMessage 推导 prompt 为
 *  `context.finalPrompt || targetMsg.enhance?.richPrompt || targetMsg.text || userMsg.text`，
 *  而 assistant.text = busyRetryAdvice（提示文案），不固化 finalPrompt 会让 retry 误用
 *  提示文案当 prompt 去生成，而非用户原始输入。 */
export const buildBusyDropMessages = (
  args: BuildBusyDropMessagesArgs,
): { userMessage: ChatMessage; assistantMessage: ChatMessage } => {
  const droppedContext: ChatGenerationContext = {
    sourceNodeId: args.selectedNodeId,
    sourceNodeType: args.selectedNodeType,
    referenceAssetUrls: args.referenceAssetUrls,
    model: args.model,
    requestedImgRatio: args.requestedImgRatio,
    requestedQuality: args.requestedQuality,
    // P1（Greptile）：固化用户原始 text，retry 优先命中 finalPrompt 而非 busyRetryAdvice。
    finalPrompt: args.text,
  }
  const userMessage: ChatMessage = {
    id: createMessageId(),
    role: 'user',
    kind: 'text',
    text: args.text,
    createdAt: Date.now(),
    status: 'done',
    selectedNodeId: args.selectedNodeId,
    selectedNodeType: args.selectedNodeType,
    generationContext: droppedContext,
  }
  const assistantMessage: ChatMessage = {
    id: createMessageId(),
    role: 'assistant',
    kind: 'text',
    text: busyRetryAdvice,
    createdAt: Date.now(),
    status: 'error',
    error: busyRetryAdvice,
    errorKind: 'unknown',
    generationContext: droppedContext,
  }
  return { userMessage, assistantMessage }
}
