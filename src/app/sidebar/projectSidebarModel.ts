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

type Entry = { id: CanvasId; updatedAt: string }

const sortByUpdatedAtDesc = (a: Entry, b: Entry) =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0

// PR-C1:active 视图 status 过滤。hydrate 已 includeArchived=true 把归档项拉进 store
//   (persistBoot CR-8),故不过滤的话归档项会留在主列表“变灰 = 像坏了”。主列表(本函数)
//   一律排除 archived project + archived canvas;archived 项的展示入口(回收站视图)属 PR-C2,
//   届时复用此处的 status 感知。archivedByCascade 不影响过滤(级联归档的也是 archived)。
const isActive = (status: 'active' | 'archived' | undefined): boolean => status !== 'archived'

export const buildSidebarModel = (
  projects: CanvasProject[],
  canvases: Record<CanvasId, CanvasDocument>,
): { projectGroups: SidebarProjectGroup[]; standaloneCanvasIds: CanvasId[] } => {
  // Active 视图:只认未归档项目作为分组依据(归档项目不在主列表;其子画布即便 active 也
  //   不该挂到归档项目组——而级联归档语义下 archived project 的 active 子画布本就不存在)。
  const activeProjects = projects.filter((p) => isActive(p.status))
  const knownProjectIds = new Set(activeProjects.map((p) => p.id))

  const standalone: Entry[] = []
  const byProject = new Map<string, Entry[]>()

  for (const [id, document] of Object.entries(canvases)) {
    // 归档画布不进主列表(既不进项目组,也不进 standalone)。
    if (!isActive(document.status)) continue
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

  const projectGroups: SidebarProjectGroup[] = activeProjects.map((project) => {
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
