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

// R6：TASKS 指示器进面板头部（替代原「AI / AI 对话」title）。
// 数据源与原底部任务条同一 store selector（state.tasks）；只显示队列数量与进度，不放详情列表。
// 格式 TASKS {done}/{total} + running 时小 spinner；空队列 0/0 subdued（保持头部不跳动）。
const TasksIndicator = () => {
  const tasks = useCanvasStore((state) => state.tasks)
  const total = tasks.length
  const done = tasks.filter((task) => task.status === 'done').length
  const running = tasks.some((task) => task.status === 'running')
  const idle = total === 0
  return (
    <div
      className={`ai-panel-tasks${idle ? ' ai-panel-tasks-idle' : ''}`}
      aria-label={`任务队列 ${done}/${total}${running ? '，生成中' : ''}`}
      title={`TASKS ${done}/${total}`}
    >
      <span className="ai-panel-tasks-label">TASKS</span>
      <span className="ai-panel-tasks-count">{done}/{total}</span>
      {running ? <Loader2 size={14} className="spin ai-panel-tasks-spinner" /> : null}
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
