// ProjectRow — a project node + its child canvases (Phase 4 / B4·B6·B7·B8·C10).
//
// Click toggles collapse; double-click name starts inline rename; hover shows a
// `+` (在此项目新建画板); right-click opens 重命名 / 在此项目新建画板 / ─ / 删除项目.
// Delete confirm copy makes the cascade explicit ("画板将移回 Canvas,不会被删除").
// Rename state is LIFTED to ProjectSidebar so a freshly-created project can enter
// rename mode immediately (B7). When expanded, renders CanvasRow for each child.
import { useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Folder, FolderOpen, Pencil, Plus, SquarePen, Trash2 } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { toastFeedback } from '../../store/toastStore'
import { isPersistWriteActive } from '../../lib/persistBoot'
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
  const archiveProject = useCanvasStore((s) => s.archiveProject)
  const unarchiveProject = useCanvasStore((s) => s.unarchiveProject)
  const createCanvas = useCanvasStore((s) => s.createCanvas)
  const loadScene = useCanvasStore((s) => s.loadScene)

  // A2 前置 b:server 模式(queue active)delete 走整树软删(画板一并删除,可恢复);
  // local 模式保留旧 standalone 回落(画板移回 Canvas,不删)。文案据此对齐,不误称"移回 Canvas"。
  const serverAligned = isPersistWriteActive()

  // PR-C1 SC-1:归档状态驱动菜单项(归档/恢复互斥)+ 行视觉区分。archived 项被 active 视图
  //   过滤(buildSidebarModel),故【恢复】入口在主列表不可达——PR-C2 回收站视图落地其可见性;
  //   此处接线 action 即满足 C1 任务包(store/e2e 可直触)。
  const isArchived = project.status === 'archived'

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
    const result = deleteProject(project.id)
    setConfirmOpen(false)
    // blocked:零-survivor 不变量阻止删除(server 模式删完全场零 canvas)——提示用户先移画板,
    //   不弹成功 toast 误导(否则用户看到"已删除"但项目还在)。
    if (result.status === 'blocked') {
      toastFeedback.warn(
        `无法删除项目"${project.name}":至少需保留一个画板,请先将画板移动到其他项目或删除`,
      )
      return
    }
    // skipped:project 不存在(UI 不可能触达——row 渲染即存在;debugLog 已 warn),静默不 toast 免噪声。
    if (result.status === 'skipped') {
      return
    }
    toastFeedback.success(
      serverAligned
        ? `已删除项目"${project.name}",${canvasCount} 块画板已一并软删除(可恢复)`
        : `已删除项目"${project.name}",${canvasCount} 块画板已移回 Canvas`,
    )
  }

  // PR-C1 SC-1:归档/恢复。store action 已含级联 + CR-5 语义;UI 只调用 + 即时反馈。
  //   归档命中活跃画布时 store 已切 survivor(SC-4),此处不再额外处理。
  const archive = () => {
    archiveProject(project.id)
    if (useCanvasStore.getState().projects.find((candidate) => candidate.id === project.id)?.status === 'archived') {
      toastFeedback.success(`已归档项目"${project.name}"`)
    }
  }
  const restore = () => {
    unarchiveProject(project.id)
    toastFeedback.success(`已恢复项目"${project.name}"`)
  }

  const menuItems: ContextMenuItem[] = [
    { kind: 'item', id: 'rename', label: '重命名', icon: Pencil, onSelect: onRenameStart },
    { kind: 'item', id: 'new-canvas', label: '在此项目新建画板', icon: SquarePen, onSelect: newCanvasInProject },
    { kind: 'separator', id: 'sep-archive' },
    isArchived
      ? { kind: 'item', id: 'restore', label: '恢复', icon: ArchiveRestore, onSelect: restore }
      : { kind: 'item', id: 'archive', label: '归档', icon: Archive, onSelect: archive },
    { kind: 'separator', id: 'sep-delete' },
    { kind: 'item', id: 'delete', label: '删除项目', icon: Trash2, danger: true, onSelect: () => setConfirmOpen(true) },
  ]

  return (
    <div className="project-branch">
      <div className="project-row-wrap">
        <button
          type="button"
          className={isArchived ? 'project-row tree-row is-archived' : 'project-row tree-row'}
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
          {/* PR-C1 SC-1:archived 行视觉标记。archived 项被 active 视图过滤,主列表不可见;
              此 badge 在 PR-C2 回收站视图(展示 archived 项)落地其可见性。放在 count 之后
              (children[4]),不顶替 row-hover-arrow(children[2])的 DOM 契约。 */}
          {isArchived && (
            <span className="project-row-archived-badge" aria-hidden="true">已归档</span>
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
        description={
          serverAligned
            ? `项目下 ${canvasCount} 块画板将一并软删除(可在回收站恢复)。`
            : `项目下 ${canvasCount} 块画板将移回 Canvas,画板不会被删除。`
        }
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
