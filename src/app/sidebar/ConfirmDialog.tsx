// ConfirmDialog — self-researched lightweight confirm modal (Phase 3 / C6).
//
// No Radix AlertDialog. Portal + backdrop, Escape/backdrop-click cancel,
// aria-modal, danger renders the confirm button in the rust accent. Visual
// structure (title / description / cancel / confirm) aligns maker's ConfirmDialog.
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export function ConfirmDialog(props: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { open, title, description, confirmLabel, danger, onConfirm, onCancel } = props

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div
      className="sidebar-confirm-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="sidebar-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sidebar-confirm-title">{title}</div>
        <div className="sidebar-confirm-description">{description}</div>
        <div className="sidebar-confirm-actions">
          {/* 默认焦点落在「取消」(maker/Radix AlertDialog 破坏性操作安全默认):
              弹窗刚出现时误敲 Enter 不应直接执行删除。 */}
          <button type="button" className="sidebar-confirm-cancel" onClick={onCancel} autoFocus>
            取消
          </button>
          <button
            type="button"
            className={`sidebar-confirm-confirm${danger ? ' is-danger' : ''}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
