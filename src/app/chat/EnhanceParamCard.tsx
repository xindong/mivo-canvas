import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useChatStore } from '../../store/chatStore'
import type { ChatMessage } from '../../store/chatStore'
import type { EnhanceDegradedReason } from '../../types/generation'
import { qualityDisplayLabel } from './chatDisplayLabels'

// W4: 把细分 degradedReason 映射为中文可读文案。所有分支都补"已用原始描述出图"
// —— enhance 永远先出图，降级只影响是否走了 agent 润色，不影响生图本身。
// FIX-3: 参数收窄为 EnhanceDegradedReason union（不放宽回 string）；default 兜底
// persisted legacy 字符串（理论上 chatStoreMigrate 已 normalize 到 undefined，
// 但运行时守卫保守保留，避免渲染抛错）。
const degradedReasonLabel = (reason: EnhanceDegradedReason): string => {
  switch (reason) {
    case 'upstream-http': return '上游服务异常，已用原始描述出图'
    case 'upstream-network': return '增强服务网络失败，已用原始描述出图'
    case 'timeout': return '增强超时，已用原始描述出图'
    case 'bad-json': return '增强响应格式异常，已用原始描述出图'
    case 'no-key': return '未配置增强模型，已用原始描述出图'
    case 'upstream-error': return '增强服务异常，已用原始描述出图'
    default: return `未增强（${reason}）`
  }
}

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
            <div className="chat-param-not-enhanced" data-degraded-reason={enhance.degradedReason}>
              {degradedReasonLabel(enhance.degradedReason)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
