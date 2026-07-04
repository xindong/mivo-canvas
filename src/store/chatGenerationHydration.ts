import type { ChatMessage, ChatMessageStatus } from './chatStore'

const expiredGenerationMessage = '任务已过期,请重试。'

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
          retryDisabledReason: undefined,
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
