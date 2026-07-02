import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useChatStore } from '../../store/chatStore'
import type { ChatMessage } from '../../store/chatStore'

type EnhanceParamCardProps = {
  message: ChatMessage
  sceneId: string
  isLast: boolean
}

const RATIO_DIMS: Record<string, { w: number; h: number }> = {
  '1:1': { w: 16, h: 16 },
  '2:3': { w: 11, h: 17 },
  '3:2': { w: 17, h: 11 },
  '16:9': { w: 19, h: 11 },
  '9:16': { w: 11, h: 19 },
  '3:4': { w: 12, h: 16 },
  '4:3': { w: 16, h: 12 },
  '21:9': { w: 21, h: 9 },
  '5:4': { w: 16, h: 13 },
  '4:5': { w: 13, h: 16 },
}

function RatioIcon({ ratio }: { ratio: string }) {
  const d = RATIO_DIMS[ratio] ?? { w: 16, h: 16 }
  return (
    <svg width={d.w} height={d.h} viewBox={`0 0 ${d.w} ${d.h}`} fill="none" aria-hidden="true">
      <rect x={0.5} y={0.5} width={d.w - 1} height={d.h - 1} rx={2} stroke="currentColor" strokeWidth={1.5} />
    </svg>
  )
}

export function EnhanceParamCard({ message, sceneId, isLast }: EnhanceParamCardProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const regenerateWithParams = useChatStore((s) => s.regenerateWithParams)
  const isBusy = useChatStore((s) => s.isBusy)
  const { enhance } = message

  if (!enhance && message.status !== 'enhancing') return null

  const handleRegenerate = () => {
    if (!isLast || isBusy) return
    void regenerateWithParams({ sceneId, messageId: message.id })
  }

  return (
    <div className="chat-param-card">
      {message.status === 'enhancing' && (
        <div className="chat-thinking-placeholder">
          <span className="chat-spin-icon" />
          <span>深度思考中…</span>
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
                <button
                  type="button"
                  className="chat-chip chat-chip-ratio"
                  onClick={isLast ? handleRegenerate : undefined}
                  disabled={!isLast || isBusy}
                  title={isLast ? '点击重新生成' : undefined}
                >
                  <RatioIcon ratio={enhance.imgRatio} />
                  <span>{enhance.imgRatio}</span>
                </button>
              )}
              {enhance.quality && (
                <button
                  type="button"
                  className="chat-chip chat-chip-quality"
                  onClick={isLast ? handleRegenerate : undefined}
                  disabled={!isLast || isBusy}
                  title={isLast ? '点击重新生成' : undefined}
                >
                  {enhance.quality}
                </button>
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
              {isLast && (
                <button
                  type="button"
                  className="chat-chip chat-chip-fallback"
                  onClick={handleRegenerate}
                  disabled={isBusy}
                >
                  用原文直接生成
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
