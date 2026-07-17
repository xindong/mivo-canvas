// projectSidebarModel — pure derived sidebar model (Phase 2 / B1·A3·B11).
//
// Input: projects + canvases. Output: project groups (sorted by latest activity)
// + standalone canvas ids (sorted by latest activity). Orphan projectIds (pointing
// to a project not in the list) are treated as standalone DEFENSIVELY — the model
// never mutates the documents; orphan cleanup is the persist migration's job.
import type { CanvasDocument, CanvasId, CanvasProject } from '../../types/mivoCanvas'

export type SidebarProjectGroup = {
  project: CanvasProject
  canvasIds: CanvasId[]
  /** Max updatedAt within the group; falls back to project.createdAt when empty. */
  latestActivityAt: string
}

export type SidebarFilterView = 'active' | 'archived'

type Entry = { id: CanvasId; updatedAt: string }

const sortByUpdatedAtDesc = (a: Entry, b: Entry) =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0

// 缺省 status 向后兼容为 active。PR-C2 将 C1 的 active-only 过滤参数化为两态视图；
// archivedByCascade 不参与筛选（直接归档与级联归档都属于回收站）。
const matchesView = (
  status: 'active' | 'archived' | undefined,
  filterView: SidebarFilterView,
): boolean => (status === 'archived' ? 'archived' : 'active') === filterView

export const buildSidebarModel = (
  projects: CanvasProject[],
  canvases: Record<CanvasId, CanvasDocument>,
  filterView: SidebarFilterView = 'active',
): { projectGroups: SidebarProjectGroup[]; standaloneCanvasIds: CanvasId[] } => {
  // 每个视图只认同态项目作为分组依据。异态父项目下的同态 canvas 防御性落到 standalone，
  // 避免脏数据让可操作记录静默消失（例如 active canvas 意外挂在 archived project 下）。
  const visibleProjects = projects.filter((p) => matchesView(p.status, filterView))
  const knownProjectIds = new Set(visibleProjects.map((p) => p.id))

  const standalone: Entry[] = []
  const byProject = new Map<string, Entry[]>()

  for (const [id, document] of Object.entries(canvases)) {
    if (!matchesView(document.status, filterView)) continue
    const projectId = document.projectId
    const updatedAt = document.updatedAt || ''
    // No projectId, or orphan projectId (not in projects list) → standalone.
    if (!projectId || !knownProjectIds.has(projectId)) {
      standalone.push({ id, updatedAt })
      continue
    }
    const group = byProject.get(projectId) ?? []
    group.push({ id, updatedAt })
    byProject.set(projectId, group)
  }

  const projectGroups: SidebarProjectGroup[] = visibleProjects.map((project) => {
    const entries = (byProject.get(project.id) ?? []).sort(sortByUpdatedAtDesc)
    // entries[0] is the max updatedAt after the desc sort; empty group → project.createdAt.
    const latestActivityAt = entries.length ? entries[0]!.updatedAt : project.createdAt
    return {
      project,
      canvasIds: entries.map((entry) => entry.id),
      latestActivityAt,
    }
  })

  projectGroups.sort((a, b) =>
    a.latestActivityAt < b.latestActivityAt ? 1 : a.latestActivityAt > b.latestActivityAt ? -1 : 0,
  )

  standalone.sort(sortByUpdatedAtDesc)

  return {
    projectGroups,
    standaloneCanvasIds: standalone.map((entry) => entry.id),
  }
}
