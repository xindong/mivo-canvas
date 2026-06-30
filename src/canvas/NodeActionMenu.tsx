import { Fragment, useCallback, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
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
  const [openSubmenu, setOpenSubmenu] = useState<{
    id?: string
    side: 'left' | 'right'
    left?: number
    top?: number
    maxHeight?: number
  }>({ side: 'right' })

  const runAction = (action: () => void) => {
    action()
    onClose()
  }

  const renderActionGlyph = ({ icon: Icon, text, swatch, linePreview }: CanvasActionItem) => {
    if (swatch) {
      return (
        <i
          className={`node-action-swatch ${swatch.transparent ? 'transparent' : ''}`}
          style={{ '--swatch-color': swatch.color } as CSSProperties}
          aria-hidden="true"
        />
      )
    }

    if (linePreview) {
      return (
        <i
          className={`node-action-line-preview ${linePreview.dashed ? 'dashed' : ''}`}
          style={
            {
              '--line-color': linePreview.color || '#554f48',
              '--line-width': `${linePreview.width || 2}px`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span />
        </i>
      )
    }

    return Icon ? <Icon size={16} /> : <b>{text}</b>
  }

  const openChildMenu = useCallback((actionId: string, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft || 0
    const viewportTop = viewport?.offsetTop || 0
    const viewportWidth = viewport?.width || window.innerWidth
    const viewportHeight = viewport?.height || window.innerHeight
    const submenuWidth = 188
    const gap = 8
    const margin = 12
    const maxHeight = Math.min(360, viewportHeight - margin * 2)
    const hasRoomRight = rect.right + gap + submenuWidth + margin <= viewportLeft + viewportWidth
    const side = hasRoomRight ? 'right' : 'left'
    const rawLeft = side === 'right' ? rect.right + gap : rect.left - submenuWidth - gap
    const rawTop = rect.top - 6
    const minLeft = viewportLeft + margin
    const maxLeft = viewportLeft + viewportWidth - submenuWidth - margin
    const minTop = viewportTop + margin
    const maxTop = viewportTop + viewportHeight - maxHeight - margin

    setOpenSubmenu({
      id: actionId,
      side,
      left: Math.round(Math.min(Math.max(rawLeft, minLeft), Math.max(minLeft, maxLeft))),
      top: Math.round(Math.min(Math.max(rawTop, minTop), Math.max(minTop, maxTop))),
      maxHeight: Math.floor(maxHeight),
    })
  }, [])

  const renderAction = (
    action: CanvasActionItem,
    nested = false,
  ) => {
    const { id, label, swatch, linePreview, selected, danger, disabled, children, onClick } = action
    const hasChildren = Boolean(children?.length)
    const submenuOpen = openSubmenu.id === id

    return (
      <span key={id} className="node-action-item">
        <button
          type="button"
          role="menuitem"
          aria-haspopup={hasChildren ? 'menu' : undefined}
          aria-expanded={hasChildren ? submenuOpen : undefined}
          className={`${danger ? 'danger' : ''} ${hasChildren ? 'has-children' : ''} ${swatch ? 'has-swatch' : ''} ${linePreview ? 'has-line-preview' : ''} ${selected ? 'selected' : ''} ${submenuOpen ? 'active' : ''}`}
          disabled={disabled}
          onPointerEnter={(event) => {
            if (hasChildren) openChildMenu(id, event.currentTarget)
            else if (!nested) setOpenSubmenu({ side: 'right' })
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
          {renderActionGlyph(action)}
          <span>{label}</span>
          {hasChildren ? <ChevronRight className="node-action-chevron" size={15} /> : null}
        </button>
        {hasChildren && submenuOpen
          ? createPortal(
          <div
            className={`node-action-submenu side-${openSubmenu.side}`}
            role="menu"
            aria-label={`${label} options`}
            style={{ left: openSubmenu.left, top: openSubmenu.top, maxHeight: openSubmenu.maxHeight }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {children?.map((child) => renderAction(child, true))}
          </div>,
              document.body,
            )
          : null}
      </span>
    )
  }

  return (
    <div className="node-action-menu" role="menu" aria-label="Canvas object actions">
      {actionGroups.map((group, groupIndex) => (
        <Fragment key={group.id}>
          {groupIndex > 0 ? <div className="node-action-separator" role="separator" /> : null}
          <div className="node-action-group" role="group">
            {group.actions.map((action) => renderAction(action))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
