import { Loader2, PanelRightClose, PanelRightOpen, Sparkles } from 'lucide-react'
import { useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { ChatComposer, type ChatComposerHandle } from './ChatComposer'
import { ChatMessageList } from './ChatMessageList'

type ChatPanelProps = {
  open: boolean
  onToggle: () => void
  focusRequestId?: number
}

// R6：面板头部仅在生成中显示旋转指示。
const TasksIndicator = () => {
  const tasks = useCanvasStore((state) => state.tasks)
  const running = tasks.some((task) => task.status === 'running')
  if (!running) return null

  return (
    <div className="ai-panel-tasks" aria-label="生成中" title="生成中">
      <Loader2 size={14} className="spin ai-panel-tasks-spinner" />
    </div>
  )
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
        <TasksIndicator />
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
