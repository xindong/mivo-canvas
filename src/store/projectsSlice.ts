// projectsSlice — Project as a first-class entity (Phase 1 / C1·C2·C7).
//
// A CanvasProject is a named grouping owned by the canvas store; canvases attach
// via the existing `CanvasDocument.projectId`. CRUD lives here so the UI layer
// (sidebar rows / context menus) can stay thin. Logging follows the project
// invariant: every user-visible outcome hits debugLogger (log on success, warn
// on skip); the UI layer adds toastFeedback for create/rename/delete where the
// user benefits from immediate acknowledgement (see Phase 5).
import type { SliceCreator } from './canvasStore'
import { logCanvas, warnCanvas } from './canvasStore'

// Project ids use a `project-` prefix (distinct from `canvas-` / `group-`) so a
// projectId is never confused with a canvasId. Mirrors createCanvasId's fallback
// when crypto.randomUUID is unavailable.
export const createProjectId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `project-${crypto.randomUUID()}`
  }
  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const nowIso = () => new Date().toISOString()

const DEFAULT_PROJECT_NAME = 'Untitled Project'

export const createProjectsSlice: SliceCreator = (set, get) => ({
  projects: [],
  createProject: (name) => {
    const id = createProjectId()
    const trimmed = name?.trim() || DEFAULT_PROJECT_NAME

    set((state) => ({
      projects: [...state.projects, { id, name: trimmed, createdAt: nowIso() }],
    }))

    logCanvas(`Created project "${trimmed}" (${id})`)
    return id
  },
  renameProject: (projectId, name) => {
    const trimmed = name.trim()
    if (!trimmed) {
      warnCanvas(`Rename project skipped: empty name (${projectId})`)
      return
    }

    const existing = get().projects.find((p) => p.id === projectId)
    if (!existing) {
      warnCanvas(`Rename project skipped: missing project ${projectId}`)
      return
    }

    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, name: trimmed } : project,
      ),
    }))

    logCanvas(`Renamed project "${existing.name}" to "${trimmed}" (${projectId})`)
  },
  deleteProject: (projectId) => {
    const state = get()
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) {
      warnCanvas(`Delete project skipped: missing project ${projectId}`)
      return
    }

    // Cascade: canvases whose projectId matches fall back to standalone
    // (projectId → undefined). The canvas body is NOT deleted and updatedAt is
    // NOT bumped — 归属回落 is a reclassification, not a content change.
    let returnedToStandalone = 0
    const canvases = Object.fromEntries(
      Object.entries(state.canvases).map(([canvasId, document]) => {
        if (document.projectId === projectId) {
          returnedToStandalone += 1
          return [canvasId, { ...document, projectId: undefined }]
        }
        return [canvasId, document]
      }),
    )

    set({
      projects: state.projects.filter((p) => p.id !== projectId),
      canvases,
    })

    logCanvas(
      `Deleted project "${project.name}" (${projectId}); ${returnedToStandalone} canvas(es) returned to standalone`,
    )
  },
})
