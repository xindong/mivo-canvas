import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useChatStore } from '../../store/chatStore'
import type { ChatMessage } from '../../store/chatStore'
import { RatioIcon } from './RatioPopover'

type EnhanceParamCardProps = {
  message: ChatMessage
}

export function EnhanceParamCard({ message }: EnhanceParamCardProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const cancelGeneration = useChatStore((s) => s.cancelGeneration)
  const { enhance } = message

  if (!enhance && message.status !== 'enhancing') return null

  return (
    <div className="chat-param-card">
      {message.status === 'enhancing' && (
        <div className="chat-thinking-placeholder">
          <span className="chat-spin-icon" />
          <span>深度思考中…</span>
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

      {enhance && (
        <>
          {enhance.reasoning && (
            <div className="chat-param-section">
              <button
                type="button"
                className="chat-param-fold-btn"
                onClick={() => setReasoningOpen((v) => !v)}
                aria-expanded={reasoningOpen}
              >
                <span>深度思考</span>
                {reasoningOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              {reasoningOpen && (
                <p className="chat-param-fold-body chat-reasoning-text">{enhance.reasoning}</p>
              )}
            </div>
          )}

          {enhance.scene && (
            <div className="chat-param-chips">
              <span className="chat-chip chat-chip-scene">{enhance.scene}</span>
              {enhance.imgRatio && (
                <span className="chat-chip chat-chip-ratio">
                  <RatioIcon ratio={enhance.imgRatio} />
                  <span>{enhance.imgRatio}</span>
                </span>
              )}
              {enhance.quality && (
                <span className="chat-chip chat-chip-quality">
                  {enhance.quality}
                </span>
              )}
            </div>
          )}

          {enhance.richPrompt && (
            <div className="chat-param-section">
              <button
                type="button"
                className="chat-param-fold-btn"
                onClick={() => setPromptOpen((v) => !v)}
                aria-expanded={promptOpen}
              >
                <span>增强 Prompt</span>
                {promptOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              {promptOpen && (
                <p className="chat-param-fold-body">{enhance.richPrompt}</p>
              )}
            </div>
          )}

          {!enhance.scene && enhance.degradedReason && (
            <div className="chat-param-not-enhanced">
              未增强（{enhance.degradedReason}）
            </div>
          )}
        </>
      )}
    </div>
  )
}
