import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const data = new Map<string, string>()
  const storage = {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key) },
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
  const target = globalThis as Record<string, unknown>
  if (target.window === undefined) target.window = { localStorage: storage }
  if (target.localStorage === undefined) target.localStorage = storage
})

vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

vi.mock('./remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))

import { useCanvasStore } from './canvasStore'
import { useToastStore } from './toastStore'
import type { CanvasDocument, CanvasProject } from '../types/mivoCanvas'

const baseState = useCanvasStore.getInitialState()
const project = (id: string, status: 'active' | 'archived' = 'active'): CanvasProject => ({
  id,
  name: id,
  createdAt: '2026-07-18T00:00:00.000Z',
  status,
})
const canvas = (
  title: string,
  projectId?: string,
  status: 'active' | 'archived' = 'active',
): CanvasDocument => ({
  title,
  projectId,
  status,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeIds: [],
})

const seed = (canvases: Record<string, CanvasDocument>, projects: CanvasProject[], sceneId: string): void => {
  useCanvasStore.setState({
    ...baseState,
    canvases,
    projects,
    sceneId,
    nodes: canvases[sceneId]?.nodes ?? [],
    edges: canvases[sceneId]?.edges ?? [],
    tasks: canvases[sceneId]?.tasks ?? [],
  } as never, true)
}

beforeEach(() => {
  useCanvasStore.setState({ ...baseState } as never, true)
  useToastStore.getState().clearToasts()
})

describe('archive next-state active survivor invariant', () => {
  it('blocks archiveCanvas when the target is the last active canvas and warns', () => {
    seed({ c1: canvas('only') }, [], 'c1')

    useCanvasStore.getState().archiveCanvas('c1')

    expect(useCanvasStore.getState().canvases.c1?.status).not.toBe('archived')
    expect(useCanvasStore.getState().sceneId).toBe('c1')
    expect(useToastStore.getState().entries.at(-1)).toMatchObject({
      level: 'warning',
      message: '至少保留一个活跃画布,请先创建或恢复其他画布再归档',
    })
  })

  it('blocks archiveProject when its cascade would leave no active canvas and warns', () => {
    seed({ c1: canvas('only', 'p1') }, [project('p1')], 'c1')

    useCanvasStore.getState().archiveProject('p1')

    expect(useCanvasStore.getState().projects[0]?.status).not.toBe('archived')
    expect(useCanvasStore.getState().canvases.c1?.status).not.toBe('archived')
    expect(useToastStore.getState().entries.at(-1)?.message).toContain('至少保留一个活跃画布')
  })

  it('archives and switches to an active survivor', () => {
    seed({ c1: canvas('target'), c2: canvas('survivor') }, [], 'c1')

    useCanvasStore.getState().archiveCanvas('c1')

    expect(useCanvasStore.getState().canvases.c1?.status).toBe('archived')
    expect(useCanvasStore.getState().sceneId).toBe('c2')
  })

  it('cascade-archives a project and switches to a survivor outside it', () => {
    seed(
      { c1: canvas('target', 'p1'), c2: canvas('survivor', 'p2') },
      [project('p1'), project('p2')],
      'c1',
    )

    useCanvasStore.getState().archiveProject('p1')

    expect(useCanvasStore.getState().projects.find((item) => item.id === 'p1')?.status).toBe('archived')
    expect(useCanvasStore.getState().canvases.c1).toMatchObject({
      status: 'archived',
      archivedByCascade: true,
    })
    expect(useCanvasStore.getState().sceneId).toBe('c2')
  })

  it('reconciles an already-archived scene while archiving its project', () => {
    seed(
      { c1: canvas('stale scene', 'p1', 'archived'), c2: canvas('survivor', 'p2') },
      [project('p1'), project('p2')],
      'c1',
    )

    useCanvasStore.getState().archiveProject('p1')

    expect(useCanvasStore.getState().projects.find((item) => item.id === 'p1')?.status).toBe('archived')
    expect(useCanvasStore.getState().sceneId).toBe('c2')
  })
})

describe('moveCanvasToProject archived target guard', () => {
  it('rejects an archived target project and warns', () => {
    seed({ c1: canvas('canvas') }, [project('p-archived', 'archived')], 'c1')

    useCanvasStore.getState().moveCanvasToProject('c1', 'p-archived')

    expect(useCanvasStore.getState().canvases.c1?.projectId).toBeUndefined()
    expect(useToastStore.getState().entries.at(-1)).toMatchObject({
      level: 'warning',
      message: '目标项目已归档,请先恢复项目再移动',
    })
  })
})
