import { useEffect, useState, type CSSProperties } from 'react'
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
  onStartImageMaskEdit?: (nodeId: string) => void
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
  onStartImageMaskEdit,
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
    onStartImageMaskEdit,
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

  const renderActionGlyph = (action: CanvasActionItem, size = 15) => {
    if (action.swatch) {
      return (
        <span
          className={`selection-quick-toolbar-current-swatch ${action.swatch.transparent ? 'transparent' : ''}`}
          style={{ '--swatch-color': action.swatch.color } as CSSProperties}
          aria-hidden="true"
        />
      )
    }

    if (action.linePreview) {
      return (
        <span
          className={`selection-quick-toolbar-line-preview ${action.linePreview.dashed ? 'dashed' : ''}`}
          style={
            {
              '--line-color': action.linePreview.color || '#fffaf0',
              '--line-width': `${action.linePreview.width || 3}px`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span />
        </span>
      )
    }

    const ChildIcon = action.icon
    return ChildIcon ? <ChildIcon size={size} /> : <b>{action.text}</b>
  }

  const renderCompactMenuAction = (action: CanvasActionItem) => (
    <button
      key={action.id}
      type="button"
      role="menuitem"
      className={`choice-button ${action.danger ? 'danger' : ''} ${action.selected ? 'selected' : ''}`}
      aria-label={action.label}
      title={action.label}
      disabled={action.disabled}
      onClick={() => runAction(action)}
    >
      {renderActionGlyph(action)}
    </button>
  )

  const renderListMenuAction = (action: CanvasActionItem) => (
    <button
      key={action.id}
      type="button"
      role="menuitem"
      className={`${action.danger ? 'danger' : ''} ${action.selected ? 'selected' : ''}`.trim()}
      disabled={action.disabled}
      onClick={() => runAction(action)}
    >
      {renderActionGlyph(action)}
      <span>{action.label}</span>
    </button>
  )

  const renderActionButton = ({
    id,
    label,
    icon: Icon,
    text,
    swatch,
    linePreview,
    danger,
    disabled,
    children,
    menuVariant,
    onClick,
  }: CanvasActionItem) => {
    const hasMenu = Boolean(children?.length)
    const menuOpen = openActionId === id
    const swatchActions = children?.filter((child) => child.swatch) || []
    const commandActions = children?.filter((child) => !child.swatch) || []
    const resolvedMenuVariant = menuVariant || (swatchActions.length > 0 ? 'palette' : 'list')

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
          {renderActionGlyph({ id, label, icon: Icon, text, swatch, linePreview, onClick })}
          <span className="selection-quick-toolbar-label">{label}</span>
          {hasMenu ? <ChevronDown size={13} strokeWidth={2.4} /> : null}
        </button>
        {hasMenu && menuOpen ? (
          <div
            className={`selection-quick-toolbar-menu ${resolvedMenuVariant}-menu`}
            role="menu"
            aria-label={`${label} actions`}
          >
            {resolvedMenuVariant === 'palette' ? (
              <>
                <div className="selection-quick-toolbar-palette" role="none">
                  {swatchActions.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      role="menuitem"
                      className={`palette-swatch-button ${child.swatch?.transparent ? 'transparent' : ''} ${child.selected ? 'selected' : ''}`}
                      style={{ '--swatch-color': child.swatch?.color } as CSSProperties}
                      aria-label={child.label}
                      title={child.label}
                      disabled={child.disabled}
                      onClick={() => runAction(child)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  ))}
                </div>
                {commandActions.length ? (
                  <>
                    <div className="selection-quick-toolbar-menu-divider" />
                    <div className="selection-quick-toolbar-choice-row" role="none">
                      {commandActions.map(renderCompactMenuAction)}
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
            {resolvedMenuVariant === 'segmented' ? (
              <div className="selection-quick-toolbar-choice-row" role="none">
                {(children || []).map(renderCompactMenuAction)}
              </div>
            ) : null}
            {resolvedMenuVariant === 'icon-grid' ? (
              <div className="selection-quick-toolbar-icon-grid" role="none">
                {(children || []).map(renderCompactMenuAction)}
              </div>
            ) : null}
            {resolvedMenuVariant === 'list' ? (
              <>
                {swatchActions.length ? (
                  <div className="selection-quick-toolbar-palette" role="none">
                    {swatchActions.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        role="menuitem"
                        className={`palette-swatch-button ${child.swatch?.transparent ? 'transparent' : ''} ${child.selected ? 'selected' : ''}`}
                        style={{ '--swatch-color': child.swatch?.color } as CSSProperties}
                        aria-label={child.label}
                        title={child.label}
                        disabled={child.disabled}
                        onClick={() => runAction(child)}
                      >
                        <span aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : null}
                {swatchActions.length && commandActions.length ? <div className="selection-quick-toolbar-menu-divider" /> : null}
                {commandActions.map(renderListMenuAction)}
              </>
            ) : null}
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
