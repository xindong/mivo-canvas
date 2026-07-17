import { describe, expect, it, vi, beforeEach } from 'vitest'

// zustand v5 persist only attaches `api.persist` when a storage resolves. Install an
// in-memory localStorage + window before the store module loads (same hermetic approach
// as canvasStore.contract.test.ts).
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage }
  if (g.localStorage === undefined) g.localStorage = memStorage
})

vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1234,
    hasTransparency: false,
    size: '300x200',
    sourceDimensions: { width: 300, height: 200 },
  })),
  saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imported' })),
  readImportedAssetFile: vi.fn(),
}))

vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import { useCanvasStore } from './canvasStore'
import type { CanvasDocument } from '../types/mivoCanvas'

const baseState = useCanvasStore.getState()

const seed = (overrides: Record<string, unknown> = {}) =>
  useCanvasStore.setState({ ...baseState, ...overrides } as never, true)

const blankDocument = (overrides: Partial<CanvasDocument> = {}): CanvasDocument => ({
  title: 'Canvas',
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T10:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeId: undefined,
  selectedNodeIds: [],
  ...overrides,
})

beforeEach(() => {
  const ls = (globalThis as { localStorage?: { clear: () => void } }).localStorage
  if (ls) ls.clear()
  useCanvasStore.setState({ ...baseState } as never, true)
})

describe('projectsSlice: createProject', () => {
  it('creates a project with the given name and returns its id', () => {
    const before = new Date().toISOString()
    const id = useCanvasStore.getState().createProject('Moodboard')
    const after = new Date().toISOString()

    expect(id).toMatch(/^project-/)
    const project = useCanvasStore.getState().projects.find((p) => p.id === id)
    expect(project).toBeDefined()
    expect(project!.name).toBe('Moodboard')
    expect(project!.createdAt >= before).toBe(true)
    expect(project!.createdAt <= after).toBe(true)
  })

  it('defaults the name to "Untitled Project" when called with no name', () => {
    const id = useCanvasStore.getState().createProject()
    const project = useCanvasStore.getState().projects.find((p) => p.id === id)
    expect(project!.name).toBe('Untitled Project')
  })

  it('persists the new project through the partialize layer', () => {
    const id = useCanvasStore.getState().createProject('Persisted')
    const opts = useCanvasStore.persist.getOptions()
    const partialized = opts.partialize!(useCanvasStore.getState()) as Record<string, unknown>
    expect(Array.isArray(partialized.projects)).toBe(true)
    const projects = partialized.projects as Array<{ id: string }>
    expect(projects.some((p) => p.id === id)).toBe(true)
  })
})

describe('projectsSlice: renameProject', () => {
  it('updates the project name', () => {
    const id = useCanvasStore.getState().createProject('Old')
    useCanvasStore.getState().renameProject(id, 'New')
    const project = useCanvasStore.getState().projects.find((p) => p.id === id)
    expect(project!.name).toBe('New')
  })

  it('trims whitespace before committing the name', () => {
    const id = useCanvasStore.getState().createProject('Old')
    useCanvasStore.getState().renameProject(id, '  Trimmed  ')
    const project = useCanvasStore.getState().projects.find((p) => p.id === id)
    expect(project!.name).toBe('Trimmed')
  })

  it('rejects an empty/whitespace name as a no-op (keeps the old name)', () => {
    const id = useCanvasStore.getState().createProject('Keep')
    useCanvasStore.getState().renameProject(id, '   ')
    const project = useCanvasStore.getState().projects.find((p) => p.id === id)
    expect(project!.name).toBe('Keep')
  })

  it('is a no-op (warn) when the project id does not exist', () => {
    const before = useCanvasStore.getState().projects
    useCanvasStore.getState().renameProject('project-does-not-exist', 'X')
    expect(useCanvasStore.getState().projects).toBe(before)
  })

  it('allows duplicate names (id distinguishes)', () => {
    const a = useCanvasStore.getState().createProject('Same')
    const b = useCanvasStore.getState().createProject('Same')
    expect(a).not.toBe(b)
    const projects = useCanvasStore.getState().projects
    expect(projects.filter((p) => p.name === 'Same')).toHaveLength(2)
  })
})

describe('projectsSlice: deleteProject', () => {
  it('removes the project entity', () => {
    const id = useCanvasStore.getState().createProject('Gone')
    const result = useCanvasStore.getState().deleteProject(id)
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)).toBeUndefined()
    // e2e FAIL 修复:删除成功返回 status:'deleted'(UI 据此弹 success toast)
    expect(result.status).toBe('deleted')
  })

  it('cascades: canvases whose projectId matches fall back to standalone (projectId undefined)', () => {
    const projectId = useCanvasStore.getState().createProject('P')
    seed({
      canvases: {
        'c-in-project': blankDocument({ title: 'in', projectId }),
        'c-standalone': blankDocument({ title: 'out', projectId: undefined }),
        'c-other-project': blankDocument({ title: 'other', projectId: 'project-other' }),
      },
      projects: [...useCanvasStore.getState().projects, { id: 'project-other', name: 'Other', createdAt: '2026-07-06T10:00:00.000Z' }],
    })

    useCanvasStore.getState().deleteProject(projectId)

    const canvases = useCanvasStore.getState().canvases
    expect(canvases['c-in-project'].projectId).toBeUndefined()
    expect(canvases['c-standalone'].projectId).toBeUndefined()
    expect(canvases['c-other-project'].projectId).toBe('project-other')
  })

  it('does not bump updatedAt on cascaded canvases (归属回落不是内容变更)', () => {
    const projectId = useCanvasStore.getState().createProject('P')
    const before = '2026-07-06T10:00:00.000Z'
    seed({
      canvases: { 'c-in-project': blankDocument({ title: 'in', projectId, updatedAt: before }) },
    })

    useCanvasStore.getState().deleteProject(projectId)

    expect(useCanvasStore.getState().canvases['c-in-project'].updatedAt).toBe(before)
  })

  it('does not delete the canvases themselves (only the projectId link)', () => {
    const projectId = useCanvasStore.getState().createProject('P')
    seed({
      canvases: { 'c-in-project': blankDocument({ title: 'in', projectId }) },
    })

    useCanvasStore.getState().deleteProject(projectId)

    expect(useCanvasStore.getState().canvases['c-in-project']).toBeDefined()
    expect(useCanvasStore.getState().canvases['c-in-project'].title).toBe('in')
  })

  it('is a no-op (warn) when the project id does not exist', () => {
    const before = useCanvasStore.getState().projects
    const result = useCanvasStore.getState().deleteProject('project-does-not-exist')
    expect(useCanvasStore.getState().projects).toBe(before)
    // e2e FAIL 修复:project 不存在返回 status:'skipped'(供 UI 静默处理,不误弹 success toast)
    expect(result).toEqual({ status: 'skipped', reason: 'missing' })
  })

  it('PR-C2:local 模式彻底删除 archived project 时整树移除，不把子画布回落到回收站 standalone', () => {
    const projectId = 'project-archived'
    seed({
      projects: [{ id: projectId, name: 'Archived', createdAt: '2026-07-01T00:00:00.000Z', status: 'archived' }],
      canvases: {
        archivedChild: blankDocument({ title: 'archived child', projectId, status: 'archived' }),
        activeSurvivor: blankDocument({ title: 'active survivor', status: 'active' }),
      },
      sceneId: 'activeSurvivor',
    })

    const result = useCanvasStore.getState().deleteProject(projectId)

    expect(result).toEqual({ status: 'deleted' })
    expect(useCanvasStore.getState().projects).toEqual([])
    expect(useCanvasStore.getState().canvases.archivedChild).toBeUndefined()
    expect(useCanvasStore.getState().canvases.activeSurvivor).toBeDefined()
  })
})

describe('documentSlice: moveCanvasToProject', () => {
  it('sets projectId on the target canvas and bumps updatedAt', () => {
    const before = '2026-07-06T10:00:00.000Z'
    seed({
      canvases: { 'c1': blankDocument({ title: 'C', projectId: undefined, updatedAt: before, createdAt: before }) },
      sceneId: 'c1',
    })
    // Create the project AFTER seed so the seed (which resets state to baseState)
    // doesn't wipe the project entity.
    const projectId = useCanvasStore.getState().createProject('P')
    useCanvasStore.getState().moveCanvasToProject('c1', projectId)

    const doc = useCanvasStore.getState().canvases['c1']
    expect(doc.projectId).toBe(projectId)
    expect(doc.updatedAt > before).toBe(true)
  })

  it('clears projectId when moving to undefined (back to Canvas 区)', () => {
    seed({
      canvases: { 'c1': blankDocument({ title: 'C', projectId: 'p1' }) },
      projects: [{ id: 'p1', name: 'P', createdAt: '2026-07-01T00:00:00.000Z' }],
    })

    useCanvasStore.getState().moveCanvasToProject('c1', undefined)

    expect(useCanvasStore.getState().canvases['c1'].projectId).toBeUndefined()
  })

  it('is a no-op when the target project does not exist (warn, no bump)', () => {
    const before = '2026-07-06T10:00:00.000Z'
    seed({
      canvases: { 'c1': blankDocument({ title: 'C', projectId: undefined, updatedAt: before, createdAt: before }) },
      projects: [{ id: 'p1', name: 'P', createdAt: '2026-07-01T00:00:00.000Z' }],
    })

    useCanvasStore.getState().moveCanvasToProject('c1', 'project-missing')

    expect(useCanvasStore.getState().canvases['c1'].projectId).toBeUndefined()
    expect(useCanvasStore.getState().canvases['c1'].updatedAt).toBe(before)
  })

  it('is a no-op when the target equals the current归属 (no bump)', () => {
    const before = '2026-07-06T10:00:00.000Z'
    seed({
      canvases: { 'c1': blankDocument({ title: 'C', projectId: 'p1', updatedAt: before, createdAt: before }) },
      projects: [{ id: 'p1', name: 'P', createdAt: '2026-07-01T00:00:00.000Z' }],
    })

    useCanvasStore.getState().moveCanvasToProject('c1', 'p1')

    expect(useCanvasStore.getState().canvases['c1'].updatedAt).toBe(before)
  })

  it('warns + no-op when the canvas id does not exist', () => {
    seed({
      canvases: { 'c1': blankDocument({ title: 'C', projectId: undefined }) },
      projects: [{ id: 'p1', name: 'P', createdAt: '2026-07-01T00:00:00.000Z' }],
    })
    const before = useCanvasStore.getState().canvases
    useCanvasStore.getState().moveCanvasToProject('missing-canvas', 'p1')
    expect(useCanvasStore.getState().canvases).toBe(before)
  })
})
