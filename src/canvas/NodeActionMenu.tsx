import { Fragment } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { contextMenuGroupsFor } from './actions/canvasActionModel'
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

  const runAction = (action: () => void) => {
    action()
    onClose()
  }

  return (
    <div className="node-action-menu" role="menu" aria-label="Canvas object actions">
      {actionGroups.map((group, groupIndex) => (
        <Fragment key={group.id}>
          {groupIndex > 0 ? <div className="node-action-separator" role="separator" /> : null}
          <div className="node-action-group" role="group">
            {group.actions.map(({ id, label, icon: Icon, text, danger, disabled, onClick }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className={danger ? 'danger' : ''}
                disabled={disabled}
                onClick={() => runAction(onClick)}
              >
                {Icon ? <Icon size={16} /> : <b>{text}</b>}
                {label}
              </button>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
