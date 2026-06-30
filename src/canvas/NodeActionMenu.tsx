import { Fragment, useCallback, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { contextMenuGroupsFor, type CanvasActionItem } from './actions/canvasActionModel'
import { useCanvasActionRuntime } from './actions/useCanvasActionRuntime'

type NodeActionMenuProps = {
  node?: MivoCanvasNode
  selectedNodes?: MivoCanvasNode[]
  canvasPosition?: { x: number; y: number }
  onClose: () => void
  onOpenDetails?: () => void
  onFitAll?: () => void
  onFitSelection?: () => void
  onCreateTextAt?: (position: { x: number; y: number }) => void
  onCreateFrameAt?: (position: { x: number; y: number }) => void
  onEditText?: (nodeId: string) => void
  onRenameNode?: (nodeId: string) => void
  onImportAssetAt?: (position: { x: number; y: number }) => void
  onCropNode?: (nodeId: string) => void
  onDownloadOriginal?: (node?: MivoCanvasNode) => void
}

export function NodeActionMenu({
  node,
  selectedNodes,
  canvasPosition,
  onClose,
  onOpenDetails,
  onFitAll,
  onFitSelection,
  onCreateTextAt,
  onCreateFrameAt,
  onEditText,
  onRenameNode,
  onImportAssetAt,
  onCropNode,
  onDownloadOriginal,
}: NodeActionMenuProps) {
  const runtime = useCanvasActionRuntime({
    primaryNode: node,
    selectedNodes,
    canvasPosition,
    onOpenDetails,
    onFitAll,
    onFitSelection,
    onCreateTextAt,
    onCreateFrameAt,
    onEditText,
    onRenameNode,
    onImportAssetAt,
    onCropNode,
    onDownloadOriginal,
  })
  const actionGroups = contextMenuGroupsFor(runtime)
  const [openSubmenu, setOpenSubmenu] = useState<{ id?: string; side: 'left' | 'right' }>({ side: 'right' })

  const runAction = (action: () => void) => {
    action()
    onClose()
  }

  const openChildMenu = useCallback((actionId: string, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect()
    const submenuWidth = 190
    const margin = 12
    const side = rect.right + submenuWidth + margin <= window.innerWidth ? 'right' : 'left'

    setOpenSubmenu({ id: actionId, side })
  }, [])

  const renderAction = ({ id, label, icon: Icon, text, danger, disabled, children, onClick }: CanvasActionItem) => {
    const hasChildren = Boolean(children?.length)
    const submenuOpen = openSubmenu.id === id

    return (
      <span key={id} className="node-action-item">
        <button
          type="button"
          role="menuitem"
          aria-haspopup={hasChildren ? 'menu' : undefined}
          aria-expanded={hasChildren ? submenuOpen : undefined}
          className={`${danger ? 'danger' : ''} ${hasChildren ? 'has-children' : ''} ${submenuOpen ? 'active' : ''}`}
          disabled={disabled}
          onPointerEnter={(event) => {
            if (hasChildren) openChildMenu(id, event.currentTarget)
            else setOpenSubmenu({ side: 'right' })
          }}
          onFocus={(event) => {
            if (hasChildren) openChildMenu(id, event.currentTarget)
          }}
          onClick={(event) => {
            if (hasChildren) {
              openChildMenu(id, event.currentTarget)
              return
            }

            runAction(onClick)
          }}
        >
          {Icon ? <Icon size={16} /> : <b>{text}</b>}
          <span>{label}</span>
          {hasChildren ? <ChevronRight className="node-action-chevron" size={15} /> : null}
        </button>
        {hasChildren && submenuOpen ? (
          <div
            className={`node-action-submenu side-${openSubmenu.side}`}
            role="menu"
            aria-label={`${label} options`}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {children?.map((child) => renderAction(child))}
          </div>
        ) : null}
      </span>
    )
  }

  return (
    <div className="node-action-menu" role="menu" aria-label="Canvas object actions">
      {actionGroups.map((group, groupIndex) => (
        <Fragment key={group.id}>
          {groupIndex > 0 ? <div className="node-action-separator" role="separator" /> : null}
          <div className="node-action-group" role="group">
            {group.actions.map(renderAction)}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
