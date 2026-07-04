import { Fragment, useMemo, useState } from 'react'
import { Crosshair } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import type { ToolId } from '../types/mivoCanvas'
import {
  canvasToolRegistry,
  isCanvasToolEnabled,
  markupShapeToolIds,
  type MarkupShapeToolId,
} from './canvasToolRegistry'

type CanvasToolDockProps = {
  previewTool?: ToolId
  onStartMaskEdit?: (nodeId: string) => void
  maskArmed?: boolean
  onToggleMaskArmed?: () => void
}

export function CanvasToolDock({ previewTool, onStartMaskEdit, maskArmed = false, onToggleMaskArmed }: CanvasToolDockProps) {
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const nodes = useCanvasStore((state) => state.nodes)
  const selectedImageNodeId = (() => {
    const node = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : undefined
    return node?.type === 'image' && !node.hidden ? selectedNodeId : undefined
  })()
  const shownTool = previewTool || (isCanvasToolEnabled(activeTool) ? activeTool : 'select')
  const markupShapeToolSet = useMemo(() => new Set<ToolId>(markupShapeToolIds), [])
  const markupShapeTools = useMemo(
    () => canvasToolRegistry.filter((tool) => markupShapeToolSet.has(tool.id)) as Array<
      (typeof canvasToolRegistry)[number] & { id: MarkupShapeToolId }
    >,
    [markupShapeToolSet],
  )
  const activeMarkupShapeTool = markupShapeToolSet.has(shownTool) ? (shownTool as MarkupShapeToolId) : undefined
  const [lastMarkupShapeTool, setLastMarkupShapeTool] = useState<MarkupShapeToolId>('markup-arrow')
  const primaryMarkupTool =
    markupShapeTools.find((tool) => tool.id === (activeMarkupShapeTool || lastMarkupShapeTool)) || markupShapeTools[0]

  return (
    <div className="canvas-tool-dock" aria-label="Canvas tools">
      {canvasToolRegistry.map(({ id, label, shortcut, dividerBefore, enabled = true, icon: Icon }) => {
        if (markupShapeToolSet.has(id) && id !== markupShapeToolIds[0]) return null

        if (id === markupShapeToolIds[0]) {
          const PrimaryIcon = primaryMarkupTool.icon
          const isActive = Boolean(activeMarkupShapeTool)

          return (
            <div key="draw-tools" className="canvas-tool-group">
              <button
                type="button"
                className={isActive ? 'active' : ''}
                onClick={() => setActiveTool(primaryMarkupTool.id)}
                aria-label="Draw"
                title={`Draw: ${primaryMarkupTool.label}${primaryMarkupTool.shortcut ? ` (${primaryMarkupTool.shortcut})` : ''}`}
              >
                {dividerBefore ? <span className="dock-divider" /> : null}
                <PrimaryIcon size={20} />
              </button>
              <div className="canvas-tool-flyout" role="menu" aria-label="Draw tools">
                {markupShapeTools.map((tool) => {
                  const ToolIcon = tool.icon
                  const toolActive = shownTool === tool.id

                  return (
                    <button
                      key={tool.id}
                      type="button"
                      role="menuitem"
                      className={toolActive ? 'active' : ''}
                      onClick={() => {
                        setLastMarkupShapeTool(tool.id)
                        setActiveTool(tool.id)
                      }}
                      aria-label={tool.label}
                      title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
                    >
                      <ToolIcon size={18} />
                    </button>
                  )
                })}
              </div>
            </div>
          )
        }

        if (id === 'select') {
          return (
            <Fragment key="select-mask-group">
              <button
                type="button"
                className={shownTool === id ? 'active' : ''}
                onClick={() => setActiveTool(id)}
                aria-label={label}
                title={shortcut ? `${label} (${shortcut})` : label}
              >
                <Icon size={20} />
              </button>
              <button
                type="button"
                className={maskArmed ? 'active' : ''}
                onClick={() => {
                  if (selectedImageNodeId) onStartMaskEdit?.(selectedImageNodeId)
                  else onToggleMaskArmed?.()
                }}
                disabled={!onStartMaskEdit}
                aria-label="局部重绘"
                title={selectedImageNodeId ? '局部重绘' : '点击图片上要修改的位置'}
              >
                <Crosshair size={20} />
              </button>
            </Fragment>
          )
        }

        return (
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
        )
      })}
    </div>
  )
}
