import { Image as ImageIcon, Video } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MODEL_CAPABILITIES, type ModelModality } from '../../lib/modelCapabilities'
import { useChatStore } from '../../store/chatStore'
import { modelDisplayLabel } from './chatDisplayLabels'
import { useAnchoredPopoverPosition } from './popoverPosition'

type ModelSelectorPopoverProps = {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

const popoverWidth = 286

export function ModelSelectorPopover({ id, anchorRef, onClose }: ModelSelectorPopoverProps) {
  const selectedModel = useChatStore((s) => s.selectedModel)
  const setSelectedModel = useChatStore((s) => s.setSelectedModel)
  const [activeTab, setActiveTab] = useState<ModelModality>('image')
  const popoverRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPopoverPosition(anchorRef, true, popoverWidth)

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
      const selected = popoverRef.current?.querySelector<HTMLButtonElement>('.chat-model-option.active')
      const first = popoverRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ;(selected || first)?.focus()
    })

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.cancelAnimationFrame(frame)
    }
  }, [anchorRef, onClose])

  const models = Object.entries(MODEL_CAPABILITIES).filter(([, capability]) => capability.modality === activeTab)

  return createPortal(
    <div
      id={id}
      ref={popoverRef}
      className="chat-floating-popover chat-model-popover"
      style={{ left: position.left, top: position.top, width: popoverWidth }}
      role="dialog"
      aria-label="选择模型"
    >
      <div className="chat-popover-tabs" role="tablist" aria-label="模型类型">
        <button
          type="button"
          className={activeTab === 'image' ? 'active' : undefined}
          onClick={() => setActiveTab('image')}
          role="tab"
          aria-selected={activeTab === 'image'}
        >
          <ImageIcon size={14} />
          Image
        </button>
        <button
          type="button"
          className={activeTab === 'video' ? 'active' : undefined}
          onClick={() => setActiveTab('video')}
          role="tab"
          aria-selected={activeTab === 'video'}
        >
          <Video size={14} />
          Video
        </button>
      </div>

      <div className="chat-model-list" role="tabpanel">
        {models.map(([modelId, capability]) => {
          const unavailable = capability.availability === 'unavailable'
          return (
            <button
              key={modelId}
              type="button"
              className={`chat-model-option ${selectedModel === modelId ? 'active' : ''}`}
              onClick={() => {
                if (unavailable) return
                setSelectedModel(modelId)
                onClose()
              }}
              disabled={unavailable}
              title={unavailable ? '视频端点未接通' : modelDisplayLabel(modelId)}
            >
              <span>{modelDisplayLabel(modelId)}</span>
              {unavailable ? <small>视频端点未接通</small> : null}
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
