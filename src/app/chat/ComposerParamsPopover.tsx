import { useEffect, useRef } from 'react'
import { useChatStore } from '../../store/chatStore'
import { MODEL_CAPABILITIES } from '../../lib/modelCapabilities'

type ComposerParamsPopoverProps = {
  onClose: () => void
}

const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const
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

export function ComposerParamsPopover({ onClose }: ComposerParamsPopoverProps) {
  const selectedModel = useChatStore((s) => s.selectedModel)
  const paramOverrides = useChatStore((s) => s.paramOverrides)
  const setSelectedModel = useChatStore((s) => s.setSelectedModel)
  const setParamOverride = useChatStore((s) => s.setParamOverride)
  const popoverRef = useRef<HTMLDivElement>(null)

  const capabilities = MODEL_CAPABILITIES[selectedModel] ?? MODEL_CAPABILITIES['gpt-image-2']
  const availableRatios: string[] = ['auto', ...capabilities.ratios]

  const imageModels = Object.entries(MODEL_CAPABILITIES).filter(([, c]) => c.modality === 'image')
  const videoModels = Object.entries(MODEL_CAPABILITIES).filter(([, c]) => c.modality === 'video')

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [onClose])

  return (
    <div className="chat-params-popover" ref={popoverRef} role="dialog" aria-label="生成参数">
      <section className="chat-params-section">
        <h3 className="chat-params-heading">比例</h3>
        <div className="chat-ratio-grid">
          {availableRatios.map((ratio) => (
            <button
              key={ratio}
              type="button"
              className={`chat-ratio-btn ${paramOverrides.imgRatio === ratio ? 'active' : ''}`}
              onClick={() => setParamOverride('imgRatio', ratio)}
              aria-pressed={paramOverrides.imgRatio === ratio}
            >
              {ratio === 'auto' ? (
                <span className="chat-ratio-auto">自动</span>
              ) : (
                <>
                  <RatioIcon ratio={ratio} />
                  <span>{ratio}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="chat-params-section">
        <h3 className="chat-params-heading">质量</h3>
        <div className="chat-quality-row">
          {QUALITY_OPTIONS.map((q) => (
            <button
              key={q}
              type="button"
              className={`chat-quality-btn ${paramOverrides.quality === q ? 'active' : ''}`}
              onClick={() => setParamOverride('quality', q)}
              aria-pressed={paramOverrides.quality === q}
            >
              {q === 'auto' ? '自动' : q}
            </button>
          ))}
        </div>
      </section>

      <section className="chat-params-section">
        <h3 className="chat-params-heading">模型</h3>
        {imageModels.length > 0 && (
          <div className="chat-model-group">
            <span className="chat-model-group-label">Image</span>
            {imageModels.map(([id, cap]) => (
              <button
                key={id}
                type="button"
                className={`chat-model-btn ${selectedModel === id ? 'active' : ''} ${cap.availability === 'unavailable' ? 'unavailable' : ''}`}
                onClick={() => cap.availability === 'ok' && setSelectedModel(id)}
                disabled={cap.availability === 'unavailable'}
                title={cap.availability === 'unavailable' ? cap.unavailableReason : undefined}
              >
                {id}
              </button>
            ))}
          </div>
        )}
        {videoModels.length > 0 && (
          <div className="chat-model-group">
            <span className="chat-model-group-label">Video</span>
            {videoModels.map(([id, cap]) => (
              <button
                key={id}
                type="button"
                className={`chat-model-btn ${selectedModel === id ? 'active' : ''} ${cap.availability === 'unavailable' ? 'unavailable' : ''}`}
                onClick={() => cap.availability === 'ok' && setSelectedModel(id)}
                disabled={cap.availability === 'unavailable'}
                title={cap.availability === 'unavailable' ? cap.unavailableReason : undefined}
              >
                {id}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
