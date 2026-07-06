// CanvasRow — a single canvas row in the sidebar (Phase 4 / B2·B6·B9·C8).
//
// Click opens; double-click starts inline rename; right-click opens a context
// menu (重命名 / 移动到项目 ▸ / 复制画板 / ─ / 删除). The right edge shows a
// relative time label (title = absolute). Self-contained: subscribes to the store
// for its data + actions, manages its own menu/confirm/rename state.
import { useState } from 'react'
import { ChevronRight, Copy, Folder, FolderInput, MonitorUp, Move, Pencil, Trash2 } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { toastFeedback } from '../../store/toastStore'
import { formatSidebarTime, formatSidebarTimeTitle } from '../../lib/formatSidebarTime'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { EditableName } from './EditableName'
import type { CanvasId } from '../../types/mivoCanvas'

export function CanvasRow(props: {
  canvasId: CanvasId
  onOpenCanvas: (canvasId: CanvasId) => void
  onExpandProject: (projectId: string) => void
}) {
  const { canvasId, onOpenCanvas, onExpandProject } = props
  const canvases = useCanvasStore((s) => s.canvases)
  const sceneId = useCanvasStore((s) => s.sceneId)
  const projects = useCanvasStore((s) => s.projects)
  const loadScene = useCanvasStore((s) => s.loadScene)
  const renameCanvas = useCanvasStore((s) => s.renameCanvas)
  const duplicateCanvas = useCanvasStore((s) => s.duplicateCanvas)
  const deleteCanvas = useCanvasStore((s) => s.deleteCanvas)
  const moveCanvasToProject = useCanvasStore((s) => s.moveCanvasToProject)

  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const document = canvases[canvasId]
  if (!document) return null
  const title = document.title
  const updatedAt = document.updatedAt
  const active = sceneId === canvasId
  const currentProjectId = document.projectId

  const open = () => {
    loadScene(canvasId)
    onOpenCanvas(canvasId)
  }

  const submitRename = (next: string) => {
    renameCanvas(canvasId, next)
    setRenaming(false)
  }

  const duplicate = () => {
    const newId = duplicateCanvas(canvasId)
    if (newId) toastFeedback.success(`已复制画板"${title}"`)
  }

  const confirmRemove = () => {
    // deleteCanvas guards "at least one canvas remains" (no-ops + errorCanvas).
    // Detect by checking if the canvas still exists after the (synchronous) call.
    deleteCanvas(canvasId)
    setConfirmOpen(false)
    if (useCanvasStore.getState().canvases[canvasId]) {
      toastFeedback.warn('至少保留一块画板')
    } else {
      toastFeedback.success(`已删除画板"${title}"`)
    }
  }

  const moveTo = (projectId?: string) => {
    if (projectId === currentProjectId) return
    moveCanvasToProject(canvasId, projectId)
    const afterProject = useCanvasStore.getState().canvases[canvasId]?.projectId
    if (projectId === undefined) {
      if (afterProject === undefined) {
        toastFeedback.success(`画板"${title}"已移回 Canvas`)
      } else {
        toastFeedback.error('移动失败')
      }
    } else if (afterProject === projectId) {
      toastFeedback.success(`画板"${title}"已移动`)
      onExpandProject(projectId)
    } else {
      toastFeedback.error('移动失败:目标项目不存在')
    }
  }

  const menuItems: ContextMenuItem[] = [
    { kind: 'item', id: 'rename', label: '重命名', icon: Pencil, onSelect: () => setRenaming(true) },
    {
      kind: 'submenu',
      id: 'move',
      label: '移动到项目',
      icon: Move,
      items: [
        // maker parity (SessionProjectMoveSubmenu): project entries carry a Folder
        // icon; an empty project list shows a disabled "暂无项目" placeholder.
        ...(projects.length > 0
          ? projects.map((p) => ({
              kind: 'item' as const,
              id: `move-${p.id}`,
              label: p.name,
              icon: Folder,
              disabled: p.id === currentProjectId,
              onSelect: () => moveTo(p.id),
            }))
          : [
              {
                kind: 'item' as const,
                id: 'move-no-projects',
                label: '暂无项目',
                disabled: true,
                onSelect: () => {},
              },
            ]),
        { kind: 'separator' as const, id: 'sep-move-to-canvas' },
        {
          kind: 'item' as const,
          id: 'move-standalone',
          label: '移到 Canvas',
          icon: FolderInput,
          disabled: currentProjectId === undefined,
          onSelect: () => moveTo(undefined),
        },
      ],
    },
    { kind: 'item', id: 'duplicate', label: '复制画板', icon: Copy, onSelect: duplicate },
    { kind: 'separator', id: 'sep-delete' },
    { kind: 'item', id: 'delete', label: '删除', icon: Trash2, danger: true, onSelect: () => setConfirmOpen(true) },
  ]

  return (
    <>
      <button
        type="button"
        className={active ? 'canvas-row active' : 'canvas-row'}
        onClick={open}
        onDoubleClick={(event) => {
          event.preventDefault()
          setRenaming(true)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuPosition({ x: event.clientX, y: event.clientY })
        }}
      >
        <MonitorUp size={14} className="canvas-row-icon" />
        {renaming ? (
          <EditableName value={title} editing={renaming} onSubmit={submitRename} onCancel={() => setRenaming(false)} />
        ) : (
          <span className="canvas-row-title">{title}</span>
        )}
        {/* row-hover-arrow must be the 3rd DOM child (right after the name) — the
            archive-assets e2e asserts children[2] carries this class and is hidden
            (opacity 0) by default. The time label follows it as children[3]. */}
        {!renaming && <ChevronRight size={14} className="row-hover-arrow" />}
        {!renaming && (
          <time className="canvas-row-time" dateTime={updatedAt} title={formatSidebarTimeTitle(updatedAt)}>
            {formatSidebarTime(updatedAt)}
          </time>
        )}
      </button>
      {menuPosition && (
        <ContextMenu position={menuPosition} items={menuItems} onClose={() => setMenuPosition(null)} />
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`删除画板"${title}"?`}
        description="此操作不可撤销。"
        confirmLabel="删除"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}
