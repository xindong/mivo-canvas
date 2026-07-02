import { PanelRightClose, PanelRightOpen, Sparkles } from 'lucide-react'
import { useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { ChatComposer, type ChatComposerHandle } from './ChatComposer'
import { ChatMessageList } from './ChatMessageList'

type ChatPanelProps = {
  open: boolean
  onToggle: () => void
  focusRequestId?: number
}

export function ChatPanel({ open, onToggle, focusRequestId = 0 }: ChatPanelProps) {
  const sceneId = useCanvasStore((s) => s.sceneId)
  const composerRef = useRef<ChatComposerHandle>(null)

  if (!open) {
    return (
      <aside className="ai-panel collapsed" aria-label="AI chat panel">
        <button type="button" className="ai-compact-toggle" onClick={onToggle} aria-label="Open AI panel">
          <PanelRightOpen size={18} />
        </button>
        <button
          type="button"
          className="ai-compact-icon active"
          onClick={() => {
            onToggle()
            composerRef.current?.focus()
          }}
          aria-label="AI 对话"
          title="AI 对话"
        >
          <Sparkles size={19} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="ai-panel chat-panel-expanded" aria-label="AI chat panel">
      <div className="ai-panel-header">
        <div>
          <span>AI</span>
          <strong>AI 对话</strong>
        </div>
        <button type="button" className="ai-panel-toggle" onClick={onToggle} aria-label="Collapse AI panel">
          <PanelRightClose size={18} />
        </button>
      </div>
      <ChatMessageList sceneId={sceneId} />
      <ChatComposer
        ref={composerRef}
        sceneId={sceneId}
        focusRequestId={focusRequestId}
        onEsc={onToggle}
      />
    </aside>
  )
}
