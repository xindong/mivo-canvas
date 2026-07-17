import { describe, expect, it } from 'vitest'
import { activeMoveTargetProjects } from './moveTargetProjects'
import type { CanvasProject } from '../../types/mivoCanvas'

describe('CanvasRow move submenu targets', () => {
  it('excludes archived projects', () => {
    const projects: CanvasProject[] = [
      { id: 'active', name: 'Active', createdAt: 't', status: 'active' },
      { id: 'archived', name: 'Archived', createdAt: 't', status: 'archived' },
    ]

    expect(activeMoveTargetProjects(projects).map((project) => project.id)).toEqual(['active'])
  })
})
