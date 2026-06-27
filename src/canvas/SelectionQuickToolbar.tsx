import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { CanvasBounds } from './canvasInteraction'
import { quickToolbarGroupsFor, type CanvasActionItem } from './actions/canvasActionModel'
import { useCanvasActionRuntime } from './actions/useCanvasActionRuntime'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { TextFormatToolbar } from './TextFormatToolbar'

type SelectionQuickToolbarProps = {
  selectedNodes: MivoCanvasNode[]
  selectedBounds?: CanvasBounds
  editingTextNodeId?: string
  scale: number
  viewportOffset: { x: number; y: number }
  onOpenDetails?: () => void
  onFitSelection?: () => void
  onEditText?: (nodeId: string) => void
  onRenameNode?: (nodeId: string) => void
  onCropNode?: (nodeId: string) => void
  onDownloadOriginal?: (node?: MivoCanvasNode) => void
}

const boundsForSingleNode = (node: MivoCanvasNode): CanvasBounds => ({
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
})

export function SelectionQuickToolbar({
  selectedNodes,
  selectedBounds,
  editingTextNodeId,
  scale,
  viewportOffset,
  onOpenDetails,
  onFitSelection,
  onEditText,
  onRenameNode,
  onCropNode,
  onDownloadOriginal,
}: SelectionQuickToolbarProps) {
  const selectionKey = selectedNodes.map((node) => node.id).join('|')
  const [openMenu, setOpenMenu] = useState<{ actionId?: string; selectionKey: string }>({
    selectionKey,
  })
  const openActionId = openMenu.selectionKey === selectionKey ? openMenu.actionId : undefined
  const primaryNode = selectedNodes[0]
  const runtime = useCanvasActionRuntime({
    primaryNode,
    selectedNodes,
    onOpenDetails,
    onFitSelection,
    onEditText,
    onRenameNode,
    onCropNode,
    onDownloadOriginal,
  })
  const actionGroups = quickToolbarGroupsFor(runtime)

  useEffect(() => {
    if (!openActionId) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setOpenMenu({ selectionKey })
      }
    }

    window.addEventListener('keydown', closeOnEscape, { capture: true })

    return () => {
      window.removeEventListener('keydown', closeOnEscape, { capture: true })
    }
  }, [openActionId, selectionKey])

  if (!primaryNode || selectedNodes.some((node) => node.id === editingTextNodeId)) return null

  if (selectedNodes.length === 1 && primaryNode.type === 'text' && !primaryNode.locked) {
    return <TextFormatToolbar node={primaryNode} scale={scale} />
  }

  const toolbarBounds = selectedNodes.length > 1 ? selectedBounds : boundsForSingleNode(primaryNode)
  if (!toolbarBounds || !actionGroups.some((group) => group.actions.length)) return null
  const toolbarScreenTop = toolbarBounds.y * scale + viewportOffset.y
  const placeBelow = toolbarScreenTop < 72
  const toolbarTop = placeBelow ? toolbarBounds.y + toolbarBounds.height + 14 : toolbarBounds.y - 14

  const runAction = (action: CanvasActionItem) => {
    action.onClick()
    setOpenMenu({ selectionKey })
  }

  const renderActionButton = ({ id, label, icon: Icon, text, danger, disabled, children, onClick }: CanvasActionItem) => {
    const hasMenu = Boolean(children?.length)
    const menuOpen = openActionId === id

    return (
      <span key={id} className="selection-quick-toolbar-item">
        <button
          type="button"
          className={`icon-only ${danger ? 'danger' : ''} ${hasMenu ? 'has-menu' : ''} ${menuOpen ? 'active' : ''}`}
          aria-label={label}
          aria-haspopup={hasMenu ? 'menu' : undefined}
          aria-expanded={hasMenu ? menuOpen : undefined}
          data-tooltip={label}
          disabled={disabled}
          onClick={() => {
            if (hasMenu) {
              setOpenMenu((current) => ({
                selectionKey,
                actionId: current.selectionKey === selectionKey && current.actionId === id ? undefined : id,
              }))
              return
            }

            setOpenMenu({ selectionKey })
            onClick()
          }}
        >
          {Icon ? <Icon size={16} /> : <b>{text}</b>}
          <span className="selection-quick-toolbar-label">{label}</span>
          {hasMenu ? <ChevronDown size={13} strokeWidth={2.4} /> : null}
        </button>
        {hasMenu && menuOpen ? (
          <div className="selection-quick-toolbar-menu" role="menu" aria-label={`${label} actions`}>
            {children?.map((child) => {
              const ChildIcon = child.icon

              return (
                <button
                  key={child.id}
                  type="button"
                  role="menuitem"
                  className={child.danger ? 'danger' : ''}
                  disabled={child.disabled}
                  onClick={() => runAction(child)}
                >
                  {ChildIcon ? <ChildIcon size={15} /> : <b>{child.text}</b>}
                  <span>{child.label}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </span>
    )
  }

  return (
    <div
      className="selection-quick-toolbar"
      data-canvas-ui="true"
      style={{
        left: toolbarBounds.x + toolbarBounds.width / 2,
        top: toolbarTop,
        transform: `translate(-50%, ${placeBelow ? '0' : '-100%'}) scale(${1 / scale})`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actionGroups.map((group, groupIndex) => (
        <div key={group.id} className="selection-quick-toolbar-group">
          {groupIndex > 0 ? <span className="selection-quick-toolbar-divider" /> : null}
          {group.actions.map(renderActionButton)}
        </div>
      ))}
    </div>
  )
}
