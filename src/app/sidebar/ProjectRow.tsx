// ProjectRow — a project node + its child canvases (Phase 4 / B4·B6·B7·B8·C10).
//
// Click toggles collapse; double-click name starts inline rename; hover shows a
// `+` (在此项目新建画板); right-click opens 重命名 / 在此项目新建画板 / ─ / 删除项目.
// Delete confirm copy makes the cascade explicit ("画板将移回 Canvas,不会被删除").
// Rename state is LIFTED to ProjectSidebar so a freshly-created project can enter
// rename mode immediately (B7). When expanded, renders CanvasRow for each child.
import { useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Pencil, Plus, SquarePen, Trash2 } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { toastFeedback } from '../../store/toastStore'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { EditableName } from './EditableName'
import { CanvasRow } from './CanvasRow'
import type { CanvasId, CanvasProject } from '../../types/mivoCanvas'

export function ProjectRow(props: {
  project: CanvasProject
  canvasIds: CanvasId[]
  collapsed: boolean
  onToggle: () => void
  onExpandProject: (projectId: string) => void
  onOpenCanvas: (canvasId: CanvasId) => void
  renaming: boolean
  onRenameStart: () => void
  onRenameSubmit: (name: string) => void
  onRenameCancel: () => void
}) {
  const {
    project,
    canvasIds,
    collapsed,
    onToggle,
    onExpandProject,
    onOpenCanvas,
    renaming,
    onRenameStart,
    onRenameSubmit,
    onRenameCancel,
  } = props
  const renameProject = useCanvasStore((s) => s.renameProject)
  const deleteProject = useCanvasStore((s) => s.deleteProject)
  const createCanvas = useCanvasStore((s) => s.createCanvas)
  const loadScene = useCanvasStore((s) => s.loadScene)

  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const canvasCount = canvasIds.length

  const submitRename = (next: string) => {
    renameProject(project.id, next)
    onRenameSubmit(next)
  }

  const newCanvasInProject = () => {
    const newId = createCanvas('Untitled Canvas', { projectId: project.id })
    loadScene(newId)
    onOpenCanvas(newId)
    onExpandProject(project.id) // ensure the project is expanded so the new canvas is visible
    toastFeedback.success(`已在"${project.name}"中新建画板`)
  }

  const confirmRemove = () => {
    deleteProject(project.id)
    setConfirmOpen(false)
    toastFeedback.success(`已删除项目"${project.name}",${canvasCount} 块画板已移回 Canvas`)
  }

  const menuItems: ContextMenuItem[] = [
    { kind: 'item', id: 'rename', label: '重命名', icon: Pencil, onSelect: onRenameStart },
    { kind: 'item', id: 'new-canvas', label: '在此项目新建画板', icon: SquarePen, onSelect: newCanvasInProject },
    { kind: 'separator', id: 'sep-delete' },
    { kind: 'item', id: 'delete', label: '删除项目', icon: Trash2, danger: true, onSelect: () => setConfirmOpen(true) },
  ]

  return (
    <div className="project-branch">
      <div className="project-row-wrap">
        <button
          type="button"
          className="project-row tree-row"
          aria-expanded={!collapsed}
          onClick={onToggle}
          onDoubleClick={(event) => {
            event.preventDefault()
            onRenameStart()
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuPosition({ x: event.clientX, y: event.clientY })
          }}
        >
          {collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}
          {renaming ? (
            <EditableName value={project.name} editing={renaming} onSubmit={submitRename} onCancel={onRenameCancel} />
          ) : (
            <span className="project-row-name">{project.name}</span>
          )}
          {/* row-hover-arrow must be the 3rd DOM child (right after the name) — the
              archive-assets e2e asserts children[2] carries this class and is hidden
              (opacity 0) by default, same contract as canvas rows. The count badge
              follows as children[3]; both are hidden during rename. */}
          {!renaming &&
            (collapsed ? (
              <ChevronRight size={14} className="row-hover-arrow" />
            ) : (
              <ChevronDown size={14} className="row-hover-arrow" />
            ))}
          {!renaming && (
            <span className="project-row-count" aria-hidden="true">
              {canvasCount}
            </span>
          )}
        </button>
        {!renaming && (
          <button
            type="button"
            className="project-row-create"
            aria-label="在此项目新建画板"
            title={`在此项目新建画板:${project.name}`}
            onClick={(event) => {
              event.stopPropagation()
              newCanvasInProject()
            }}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {menuPosition && (
        <ContextMenu position={menuPosition} items={menuItems} onClose={() => setMenuPosition(null)} />
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`删除项目"${project.name}"?`}
        description={`项目下 ${canvasCount} 块画板将移回 Canvas,画板不会被删除。`}
        confirmLabel="删除项目"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setConfirmOpen(false)}
      />
      {!collapsed && canvasCount > 0 && (
        <div className="canvas-tree project-canvas-tree">
          {canvasIds.map((canvasId) => (
            <CanvasRow
              key={canvasId}
              canvasId={canvasId}
              onOpenCanvas={onOpenCanvas}
              onExpandProject={onExpandProject}
            />
          ))}
        </div>
      )}
    </div>
  )
}
