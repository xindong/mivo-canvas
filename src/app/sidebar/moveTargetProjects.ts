import type { CanvasProject } from '../../types/mivoCanvas'

export const activeMoveTargetProjects = (projects: CanvasProject[]): CanvasProject[] =>
  projects.filter((project) => project.status !== 'archived')
