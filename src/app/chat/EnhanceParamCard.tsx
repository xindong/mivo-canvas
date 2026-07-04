import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useChatStore } from '../../store/chatStore'
import type { ChatMessage } from '../../store/chatStore'
import { qualityDisplayLabel } from './chatDisplayLabels'

type EnhanceParamCardProps = {
  message: ChatMessage
  sceneId: string
}

export function EnhanceParamCard({ message, sceneId }: EnhanceParamCardProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const cancelGeneration = useChatStore((s) => s.cancelGeneration)
  const { enhance } = message
  const context = message.generationContext
  const effectiveRatio = context?.imgRatio || enhance?.imgRatio
  const effectiveQuality = context?.quality || enhance?.quality
  const agentSuggestionChanged = Boolean(
    enhance &&
      ((enhance.imgRatio && effectiveRatio && enhance.imgRatio !== effectiveRatio) ||
        (enhance.quality && effectiveQuality && enhance.quality !== effectiveQuality)),
  )
  const agentSuggestionText = agentSuggestionChanged
    ? [
        enhance?.imgRatio,
        enhance?.quality ? qualityDisplayLabel(enhance.quality) : undefined,
      ].filter(Boolean).join(' / ')
    : ''
  const showSlowHint = effectiveQuality === 'high' || effectiveRatio === '16:9' || effectiveRatio === '9:16'

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
            onClick={() => cancelGeneration({ sceneId, messageId: message.id })}
            title="取消本次生成"
          >
            取消
          </button>
        </div>
      )}

      {enhance && (
        <>
          {(enhance.reasoning || agentSuggestionText) && (
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
                <div className="chat-param-fold-body chat-reasoning-text">
                  {enhance.reasoning && <p>{enhance.reasoning}</p>}
                  {agentSuggestionText && (
                    <p className="chat-agent-suggestion">Agent 建议：{agentSuggestionText}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {showSlowHint && (
            <div className="chat-param-slow-hint">预计较慢（1-3 分钟）</div>
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
