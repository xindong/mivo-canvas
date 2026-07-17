import { describe, expect, it } from 'vitest'
import { buildSidebarModel } from './projectSidebarModel'
import type { CanvasDocument, CanvasProject } from '../../types/mivoCanvas'

const project = (id: string, createdAt = '2026-07-01T00:00:00.000Z', status: 'active' | 'archived' = 'active'): CanvasProject => ({
  id,
  name: id,
  createdAt,
  status,
})

const doc = (updatedAt: string, projectId?: string, title = 'C', status: 'active' | 'archived' = 'active'): CanvasDocument => ({
  title,
  projectId,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt,
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeId: undefined,
  selectedNodeIds: [],
  status,
})

describe('buildSidebarModel — grouping', () => {
  it('groups canvases by projectId', () => {
    const projects = [project('p1'), project('p2')]
    const canvases = {
      c1: doc('2026-07-03T00:00:00.000Z', 'p1'),
      c2: doc('2026-07-04T00:00:00.000Z', 'p1'),
      c3: doc('2026-07-02T00:00:00.000Z', 'p2'),
    }
    const model = buildSidebarModel(projects, canvases)
    expect(model.projectGroups).toHaveLength(2)
    const g1 = model.projectGroups.find((g) => g.project.id === 'p1')!
    expect(g1.canvasIds).toEqual(['c2', 'c1']) // updatedAt desc
    const g2 = model.projectGroups.find((g) => g.project.id === 'p2')!
    expect(g2.canvasIds).toEqual(['c3'])
  })

  it('includes empty projects (no canvases) with empty canvasIds', () => {
    const projects = [project('p1'), project('p-empty')]
    const canvases = { c1: doc('2026-07-03T00:00:00.000Z', 'p1') }
    const model = buildSidebarModel(projects, canvases)
    const empty = model.projectGroups.find((g) => g.project.id === 'p-empty')!
    expect(empty.canvasIds).toEqual([])
    expect(empty.latestActivityAt).toBe('2026-07-01T00:00:00.000Z') // project.createdAt fallback
  })
})

describe('buildSidebarModel — sorting', () => {
  it('sorts canvases within a project by updatedAt desc', () => {
    const projects = [project('p1')]
    const canvases = {
      a: doc('2026-07-01T00:00:00.000Z', 'p1'),
      b: doc('2026-07-05T00:00:00.000Z', 'p1'),
      c: doc('2026-07-03T00:00:00.000Z', 'p1'),
    }
    const model = buildSidebarModel(projects, canvases)
    expect(model.projectGroups[0].canvasIds).toEqual(['b', 'c', 'a'])
  })

  it('sorts projects by latestActivityAt desc (group max updatedAt)', () => {
    const projects = [project('p-old', '2026-07-01T00:00:00.000Z'), project('p-new', '2026-07-01T00:00:00.000Z')]
    const canvases = {
      c1: doc('2026-07-02T00:00:00.000Z', 'p-old'),
      c2: doc('2026-07-06T00:00:00.000Z', 'p-new'),
    }
    const model = buildSidebarModel(projects, canvases)
    expect(model.projectGroups.map((g) => g.project.id)).toEqual(['p-new', 'p-old'])
  })

  it('sorts standalone canvases by updatedAt desc', () => {
    const canvases = {
      s1: doc('2026-07-01T00:00:00.000Z'),
      s2: doc('2026-07-05T00:00:00.000Z'),
      s3: doc('2026-07-03T00:00:00.000Z'),
    }
    const model = buildSidebarModel([], canvases)
    expect(model.standaloneCanvasIds).toEqual(['s2', 's3', 's1'])
  })
})

describe('buildSidebarModel — standalone / orphan defense', () => {
  it('treats canvases with no projectId as standalone', () => {
    const canvases = {
      s1: doc('2026-07-01T00:00:00.000Z'),
      s2: doc('2026-07-02T00:00:00.000Z', undefined),
    }
    const model = buildSidebarModel([], canvases)
    expect(model.standaloneCanvasIds).toEqual(['s2', 's1'])
    expect(model.projectGroups).toEqual([])
  })

  it('treats orphan projectIds (not in projects list) as standalone — does NOT mutate the document', () => {
    const canvases = {
      orphan: doc('2026-07-04T00:00:00.000Z', 'project-ghost'),
      ok: doc('2026-07-03T00:00:00.000Z'),
    }
    const model = buildSidebarModel([], canvases)
    // orphan projectId is treated as standalone (defensive — the model does not
    // repair data; the persist migration is responsible for clearing orphans).
    expect(model.standaloneCanvasIds).toContain('orphan')
    expect(model.standaloneCanvasIds).toContain('ok')
    expect(model.projectGroups).toEqual([])
    // document is not mutated
    expect(canvases.orphan!.projectId).toBe('project-ghost')
  })
})

describe('buildSidebarModel — latestActivityAt', () => {
  it('uses the max updatedAt within a project group', () => {
    const projects = [project('p1')]
    const canvases = {
      c1: doc('2026-07-01T00:00:00.000Z', 'p1'),
      c2: doc('2026-07-09T00:00:00.000Z', 'p1'),
      c3: doc('2026-07-05T00:00:00.000Z', 'p1'),
    }
    const model = buildSidebarModel(projects, canvases)
    expect(model.projectGroups[0].latestActivityAt).toBe('2026-07-09T00:00:00.000Z')
  })
})

// PR-C1:active 视图 status 过滤——主列表排除 archived project + archived canvas。
describe('buildSidebarModel — archived filtering (PR-C1 active view)', () => {
  it('excludes archived projects from projectGroups', () => {
    const projects = [project('p-active'), project('p-arch', '2026-07-01T00:00:00.000Z', 'archived')]
    const canvases = {
      c1: doc('2026-07-03T00:00:00.000Z', 'p-active'),
      c2: doc('2026-07-04T00:00:00.000Z', 'p-arch'),
    }
    const model = buildSidebarModel(projects, canvases)
    expect(model.projectGroups.map((g) => g.project.id)).toEqual(['p-active'])
  })

  it('excludes archived canvases from a project group (active project stays)', () => {
    const projects = [project('p1')]
    const canvases = {
      live: doc('2026-07-03T00:00:00.000Z', 'p1', 'C-live'),
      gone: doc('2026-07-09T00:00:00.000Z', 'p1', 'C-gone', 'archived'),
    }
    const model = buildSidebarModel(projects, canvases)
    const group = model.projectGroups.find((g) => g.project.id === 'p1')!
    expect(group.canvasIds).toEqual(['live'])
  })

  it('excludes archived standalone canvases', () => {
    const canvases = {
      s1: doc('2026-07-01T00:00:00.000Z', undefined, 'S1'),
      s2: doc('2026-07-05T00:00:00.000Z', undefined, 'S2', 'archived'),
    }
    const model = buildSidebarModel([], canvases)
    expect(model.standaloneCanvasIds).toEqual(['s1'])
  })

  it('treats a canvas whose project is archived as standalone when the canvas itself is active', () => {
    // Defensive: cascade-archive semantics make an active child of an archived project
    // impossible, but if data ever lands that way the active canvas must NOT silently
    // vanish — it surfaces as standalone (so the user can still reach it / move it).
    const projects = [project('p-arch', '2026-07-01T00:00:00.000Z', 'archived')]
    const canvases = {
      orphan: doc('2026-07-04T00:00:00.000Z', 'p-arch'),
    }
    const model = buildSidebarModel(projects, canvases)
    expect(model.projectGroups).toEqual([])
    expect(model.standaloneCanvasIds).toEqual(['orphan'])
  })
})
