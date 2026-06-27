import { AlertTriangle, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import type { CanvasTask } from '../types/mivoCanvas'

const TaskIcon = ({ task }: { task: CanvasTask }) => {
  if (task.status === 'running') return <Loader2 size={16} className="spin" />
  if (task.status === 'failed') return <AlertTriangle size={16} />
  if (task.status === 'done') return <CheckCircle2 size={16} />
  return <CircleDashed size={16} />
}

export function TaskQueue() {
  const tasks = useCanvasStore((state) => state.tasks)

  return (
    <div className="task-queue" aria-label="Task queue">
      <div className="queue-title">Tasks</div>
      {tasks.length === 0 ? (
        <div className="queue-empty">No active task</div>
      ) : (
        tasks.slice(0, 3).map((task) => (
          <div key={task.id} className={`queue-item ${task.status}`}>
            <TaskIcon task={task} />
            <span>{task.label}</span>
            <div className="queue-progress" aria-hidden="true">
              <i style={{ width: `${task.progress}%` }} />
            </div>
          </div>
        ))
      )}
    </div>
  )
}
