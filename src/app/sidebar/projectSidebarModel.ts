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

export const buildSidebarModel = (
  projects: CanvasProject[],
  canvases: Record<CanvasId, CanvasDocument>,
): { projectGroups: SidebarProjectGroup[]; standaloneCanvasIds: CanvasId[] } => {
  const knownProjectIds = new Set(projects.map((p) => p.id))

  const standalone: Entry[] = []
  const byProject = new Map<string, Entry[]>()

  for (const [id, document] of Object.entries(canvases)) {
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

  const projectGroups: SidebarProjectGroup[] = projects.map((project) => {
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
