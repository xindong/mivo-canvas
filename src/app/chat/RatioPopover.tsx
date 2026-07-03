import { useEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MODEL_CAPABILITIES } from '../../lib/modelCapabilities'
import { useChatStore } from '../../store/chatStore'
import { qualityDisplayLabel } from './chatDisplayLabels'
import { useAnchoredPopoverPosition } from './popoverPosition'

type RatioPopoverProps = {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

const popoverWidth = 264
const qualityOptions = ['auto', 'low', 'medium', 'high'] as const

const ratioDims: Record<string, { w: number; h: number }> = {
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

export function RatioIcon({ ratio }: { ratio: string }) {
  const dims = ratioDims[ratio] ?? { w: 16, h: 16 }
  return (
    <svg width={dims.w} height={dims.h} viewBox={`0 0 ${dims.w} ${dims.h}`} fill="none" aria-hidden="true">
      <rect x={0.5} y={0.5} width={dims.w - 1} height={dims.h - 1} rx={2} stroke="currentColor" strokeWidth={1.5} />
    </svg>
  )
}

export function RatioPopover({ id, anchorRef, onClose }: RatioPopoverProps) {
  const selectedModel = useChatStore((s) => s.selectedModel)
  const paramOverrides = useChatStore((s) => s.paramOverrides)
  const setParamOverride = useChatStore((s) => s.setParamOverride)
  const popoverRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPopoverPosition(anchorRef, true, popoverWidth)
  const capabilities = MODEL_CAPABILITIES[selectedModel] ?? MODEL_CAPABILITIES['gpt-image-2']
  const ratios = ['auto', ...capabilities.ratios]
  const qualities = qualityOptions.filter((quality) => quality === 'auto' || capabilities.qualities.includes(quality))

  // 审查 B（Step 4b）：gemini 经 mivo 平台，质量→分辨率映射 low/medium=1K、high=2K；
  // 在质量项 title 上标注分辨率，避免 medium 误以为可"降质"（与 1K 同档）
  const qualityTitleFor = (quality: string): string | undefined => {
    if (selectedModel !== 'gemini-3-pro-image') return undefined
    const resolutionMap: Record<string, string> = { high: '2K', medium: '1K', low: '1K' }
    const res = resolutionMap[quality]
    return res ? `${qualityDisplayLabel(quality)}质量（${res}）` : undefined
  }

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    const frame = window.requestAnimationFrame(() => {
      const selected = popoverRef.current?.querySelector<HTMLButtonElement>('.chat-ratio-btn.active')
      const first = popoverRef.current?.querySelector<HTMLButtonElement>('button')
      ;(selected || first)?.focus()
    })

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.cancelAnimationFrame(frame)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      id={id}
      ref={popoverRef}
      className="chat-floating-popover chat-ratio-popover"
      style={{ left: position.left, top: position.top, width: popoverWidth }}
      role="dialog"
      aria-label="比例和质量"
    >
      <section className="chat-params-section">
        <h3 className="chat-params-heading">比例</h3>
        <div className="chat-ratio-grid">
          {ratios.map((ratio) => (
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
          {qualities.map((quality) => (
            <button
              key={quality}
              type="button"
              className={`chat-quality-btn ${paramOverrides.quality === quality ? 'active' : ''}`}
              onClick={() => setParamOverride('quality', quality)}
              aria-pressed={paramOverrides.quality === quality}
              title={qualityTitleFor(quality)}
            >
              {qualityDisplayLabel(quality)}
            </button>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  )
}
