import type { ChatMessage, ChatMessageStatus } from './chatStore'

export const expiredGenerationMessage = '任务已过期,请重试。'
// FX-3 P1-1: mask-edit 卡被 reconcile 恢复为 done 后,若原 text 为空且无 resultNodeIds
// (结果未在 hydrate 前提交到 canvas),done 分支既无图又无文 → 空白卡。兜底一句文案保证
// 必有可渲染内容。与 expiredGenerationMessage 同源(模块级常量,非硬编码裸串),遵循
// i18n / 单一文案源惯例;不在此处恢复 result 图像 b64(ChatMessage 无 inline b64 字段,
// done 分支靠 text 或 resultNodeIds 渲染;b64→canvas 节点恢复需 source/mask 数据,
// post-hydrate 不可得,见 chatTaskReconcile.ts 顶部 residual 注释)。
export const recoveredTaskDoneMessage = '任务已完成。'
// mask-chat-card: 局部重绘刷新后无 runtime controller 可恢复轮询，chat card settle 为
// error 且第一版不支持 card Retry，引导用户重新选择区域。保留 pendingSlotId 让 canvas
// hydration 的 failed slot 与卡片对应（SC-15）。
const maskEditExpiredRetryDisabledReason = '局部重绘任务已过期，请重新选择区域后再试'

const isInFlightChatStatus = (status: ChatMessageStatus) => status === 'enhancing' || status === 'generating'

export const settleExpiredChatMessages = (messagesByScene: Record<string, ChatMessage[]>) => {
  let settledMessages = 0
  const nextMessagesByScene = Object.fromEntries(
    Object.entries(messagesByScene).map(([sceneId, messages]) => [
      sceneId,
      messages.map((message) => {
        if (!isInFlightChatStatus(message.status)) return message
        settledMessages += 1
        return {
          ...message,
          status: 'error' as const,
          error: expiredGenerationMessage,
          errorKind: 'unknown' as const,
          timeoutRetryKey: undefined,
          timeoutRetryCount: undefined,
          // mask-chat-card: mask-edit 卡片第一版不支持 Retry；保留 generationContext.pendingSlotId。
          retryDisabledReason:
            message.origin === 'mask-edit' ? maskEditExpiredRetryDisabledReason : undefined,
        }
      }),
    ]),
  )

  return { messagesByScene: nextMessagesByScene, settledMessages }
}

export const fallbackCancelTarget = (
  messagesByScene: Record<string, ChatMessage[]>,
  options: { sceneId?: string; messageId?: string } = {},
) => {
  const sceneEntries = options.sceneId
    ? ([[options.sceneId, messagesByScene[options.sceneId] || []]] as Array<[string, ChatMessage[]]>)
    : Object.entries(messagesByScene)

  for (const [sceneId, messages] of sceneEntries) {
    const candidates = options.messageId
      ? messages.filter((message) => message.id === options.messageId)
      : [...messages].reverse()
    const message = candidates.find((item) => item.role === 'assistant' && isInFlightChatStatus(item.status))
    if (message) return { sceneId, message }
  }

  return undefined
}
