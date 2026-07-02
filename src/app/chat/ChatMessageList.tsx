import { useCallback, useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { useChatStore } from '../../store/chatStore'
import { useCanvasStore } from '../../store/canvasStore'
import { EnhanceParamCard } from './EnhanceParamCard'
import { ChatResultImage } from './ChatResultImage'

type ChatMessageListProps = {
  sceneId: string
}

const EMPTY_MESSAGES: import('../../store/chatStore').ChatMessage[] = []

export function ChatMessageList({ sceneId }: ChatMessageListProps) {
  const messages = useChatStore((s) => s.messagesByScene[sceneId] ?? EMPTY_MESSAGES)
  const retryMessage = useChatStore((s) => s.retryMessage)
  const cancelGeneration = useChatStore((s) => s.cancelGeneration)
  const isBusy = useChatStore((s) => s.isBusy)
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

  return (
    <div
      className="chat-message-list"
      ref={listRef}
      onScroll={handleScroll}
    >
      {messages.map((message) => {
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
        const resultNodeId = message.resultNodeIds?.[0]

        return (
          <div key={message.id} className="chat-message chat-message-assistant">
            <div className="chat-bubble chat-bubble-assistant">
              <EnhanceParamCard
                message={message}
              />

              {message.status === 'generating' && (
                <div className="chat-generating-indicator">
                  <span className="chat-spin-icon" />
                  <span>生成中…</span>
                  <button
                    type="button"
                    className="chat-cancel-btn"
                    onClick={cancelGeneration}
                    title="取消本次生成"
                  >
                    取消
                  </button>
                </div>
              )}

              {message.status === 'done' && resultNodeId && (
                <ChatResultImage
                  nodeId={resultNodeId}
                  onLocate={() => selectNode(resultNodeId)}
                />
              )}

              {message.status === 'done' && !resultNodeId && message.text && message.enhance?.richPrompt === undefined && (
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
                    title={isBusy ? '当前仍有生成任务，完成或取消后可重试' : '重新生成'}
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
