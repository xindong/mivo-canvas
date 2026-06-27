import { useCanvasStore } from '../store/canvasStore'
import type { ToolId } from '../types/mivoCanvas'
import { canvasToolRegistry, isCanvasToolEnabled } from './canvasToolRegistry'

type CanvasToolDockProps = {
  previewTool?: ToolId
}

export function CanvasToolDock({ previewTool }: CanvasToolDockProps) {
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const shownTool = previewTool || (isCanvasToolEnabled(activeTool) ? activeTool : 'select')

  return (
    <div className="canvas-tool-dock" aria-label="Canvas tools">
      {canvasToolRegistry.map(({ id, label, shortcut, dividerBefore, enabled = true, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={shownTool === id ? 'active' : ''}
          onClick={() => {
            if (enabled) setActiveTool(id)
          }}
          aria-label={label}
          title={shortcut ? `${label} (${shortcut})` : label}
          disabled={!enabled}
        >
          {dividerBefore ? <span className="dock-divider" /> : null}
          <Icon size={20} />
        </button>
      ))}
    </div>
  )
}
