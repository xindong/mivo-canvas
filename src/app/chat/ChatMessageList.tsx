import { useCallback, useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { useChatStore } from '../../store/chatStore'
import { useCanvasStore } from '../../store/canvasStore'
import { EnhanceParamCard } from './EnhanceParamCard'

type ChatMessageListProps = {
  sceneId: string
}

export function ChatMessageList({ sceneId }: ChatMessageListProps) {
  const messages = useChatStore((s) => s.messagesByScene[sceneId] ?? [])
  const retryMessage = useChatStore((s) => s.retryMessage)
  const isBusy = useChatStore((s) => s.isBusy)
  const nodes = useCanvasStore((s) => s.nodes)
  const selectNode = useCanvasStore((s) => s.selectNode)

  const listRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    shouldAutoScrollRef.current = distFromBottom < 60
  }, [])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  if (messages.length === 0) {
    return (
      <div className="chat-message-list chat-message-list-empty" ref={listRef}>
        <p className="chat-empty-hint">输入描述，让 AI 帮你生成图像</p>
      </div>
    )
  }

  const lastAssistantIdx = messages.reduce<number>(
    (last, m, i) => (m.role === 'assistant' && m.kind === 'text' ? i : last),
    -1,
  )

  return (
    <div
      className="chat-message-list"
      ref={listRef}
      onScroll={handleScroll}
    >
      {messages.map((message, index) => {
        if (message.kind === 'notice') {
          return (
            <div key={message.id} className="chat-notice">
              <span className="chat-notice-text">{message.text}</span>
              {message.resultNodeIds?.length ? (
                <button
                  type="button"
                  className="chat-notice-locate"
                  onClick={() => selectNode(message.resultNodeIds![0])}
                >
                  定位
                </button>
              ) : null}
            </div>
          )
        }

        if (message.role === 'user') {
          return (
            <div key={message.id} className="chat-message chat-message-user">
              <div className="chat-bubble chat-bubble-user">{message.text}</div>
            </div>
          )
        }

        // assistant text message
        const isLast = index === lastAssistantIdx
        const resultNodeId = message.resultNodeIds?.[0]
        const resultNode = resultNodeId ? nodes.find((n) => n.id === resultNodeId) : undefined
        const resultImageUrl = resultNode?.type === 'image' ? (resultNode as { assetUrl?: string }).assetUrl : undefined

        return (
          <div key={message.id} className="chat-message chat-message-assistant">
            <div className="chat-bubble chat-bubble-assistant">
              <EnhanceParamCard
                message={message}
                sceneId={sceneId}
                isLast={isLast}
              />

              {message.status === 'generating' && (
                <div className="chat-generating-indicator">
                  <span className="chat-spin-icon" />
                  <span>生成中…</span>
                </div>
              )}

              {message.status === 'done' && resultImageUrl && (
                <button
                  type="button"
                  className="chat-result-image-btn"
                  onClick={() => resultNodeId && selectNode(resultNodeId)}
                  title="点击定位到画布节点"
                >
                  <img
                    src={resultImageUrl}
                    alt="生成结果"
                    className="chat-result-image"
                  />
                </button>
              )}

              {message.status === 'done' && !resultImageUrl && message.text && message.enhance?.richPrompt === undefined && (
                <p className="chat-assistant-text">{message.text}</p>
              )}

              {message.status === 'error' && (
                <div className="chat-error-row">
                  <span className="chat-error-text">{message.error || '生成失败'}</span>
                  <button
                    type="button"
                    className="chat-retry-btn"
                    onClick={() => void retryMessage({ sceneId, messageId: message.id })}
                    disabled={isBusy}
                  >
                    <RefreshCw size={13} />
                    重试
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
