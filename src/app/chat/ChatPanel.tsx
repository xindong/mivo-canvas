import { Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { ChatComposer, type ChatComposerHandle } from './ChatComposer'
import { ChatMessageList } from './ChatMessageList'

type ChatPanelProps = {
  open: boolean
  onToggle: () => void
  focusRequestId?: number
}

// R6：面板头部常驻 TASKS 标题，生成中在标题旁显示旋转指示。
const TasksIndicator = () => {
  const tasks = useCanvasStore((state) => state.tasks)
  const running = tasks.some((task) => task.status === 'running')
  const statusText = running ? '任务，生成中' : '任务'

  return (
    <div className="ai-panel-tasks" aria-label={statusText} title={statusText}>
      <span className="ai-panel-tasks-label">TASKS</span>
      {running ? <Loader2 size={14} className="spin ai-panel-tasks-spinner" /> : null}
    </div>
  )
}

export function ChatPanel({ open, onToggle, focusRequestId = 0 }: ChatPanelProps) {
  const sceneId = useCanvasStore((s) => s.sceneId)
  const composerRef = useRef<ChatComposerHandle>(null)

  if (!open) {
    // R6+：折叠态唯一入口。位置与展开态 header 右上角的收起按钮屏幕坐标一致
    // （见 App.css .ai-panel.collapsed），点击即在原地重新展开，不再有右下角浮动按钮。
    return (
      <aside className="ai-panel collapsed" aria-label="AI chat panel">
        <button
          type="button"
          className="ai-panel-toggle"
          onClick={onToggle}
          aria-label="Open AI panel"
          title="展开对话"
        >
          <PanelRightOpen size={18} />
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
