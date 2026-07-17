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

// PR-C1 二轮 SC-1/SC-2:spy on enqueuePersistWrite to assert blocked path does NOT enqueue.
//   local 模式下真 enqueuePersistWrite 本就是 no-op(writeQueue 未启动),替换为 vi.fn 仅为可断言,
//   不改语义。其余导出(含 isPersistWriteActive)保留真实实现。
const enqueueMock = vi.hoisted(() => vi.fn(() => undefined))
vi.mock('../lib/persistBoot', async () => {
  const actual = await vi.importActual<typeof import('../lib/persistBoot')>('../lib/persistBoot')
  return { ...actual, enqueuePersistWrite: enqueueMock }
})

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
  enqueueMock.mockClear()
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

// PR-C1 二轮 P2(SC-1 local 模式):createCanvas 显式 archived projectId 阻止。
//   server 模式同名用例见 documentSlice.persist.test.ts(断言不发 POST /api/canvas)。
describe('createCanvas archived project guard', () => {
  it('blocks an explicit archived projectId, leaves state untouched, and warns (local mode)', () => {
    seed({ c1: canvas('existing') }, [project('p-arch', 'archived')], 'c1')
    const beforeKeys = Object.keys(useCanvasStore.getState().canvases)

    const result = useCanvasStore.getState().createCanvas('new', { projectId: 'p-arch' })

    expect(result).toBeUndefined()
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual(beforeKeys)
    expect(useCanvasStore.getState().sceneId).toBe('c1')
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(useToastStore.getState().entries.at(-1)).toMatchObject({
      level: 'warning',
      message: '目标项目已归档,请先恢复项目再新建画板',
    })
  })

  it('still tolerates an unknown projectId (no expansion of scope)', () => {
    seed({ c1: canvas('existing') }, [], 'c1')

    const result = useCanvasStore.getState().createCanvas('new', { projectId: 'p-unknown' })

    expect(result).not.toBeUndefined()
    expect(Object.keys(useCanvasStore.getState().canvases)).toContain(result)
  })
})

// PR-C1 二轮 P2(SC-2):duplicateCanvas archived 源 / archived 父项目 阻止 + 放行路径副本 active。
describe('duplicateCanvas archived guard', () => {
  it('blocks an archived source, leaves state untouched, and warns', () => {
    seed({ c1: canvas('src', undefined, 'archived') }, [], 'c1')
    const beforeKeys = Object.keys(useCanvasStore.getState().canvases)

    const result = useCanvasStore.getState().duplicateCanvas('c1')

    expect(result).toBeUndefined()
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual(beforeKeys)
    expect(useCanvasStore.getState().sceneId).toBe('c1')
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(useToastStore.getState().entries.at(-1)).toMatchObject({
      level: 'warning',
      message: '画布已归档,请先恢复再复制',
    })
  })

  it('blocks an active source whose parent project is archived (dirty data) and warns', () => {
    seed({ c1: canvas('src', 'p-arch') }, [project('p-arch', 'archived')], 'c1')

    const result = useCanvasStore.getState().duplicateCanvas('c1')

    expect(result).toBeUndefined()
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual(['c1'])
    expect(useCanvasStore.getState().sceneId).toBe('c1')
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(useToastStore.getState().entries.at(-1)).toMatchObject({
      level: 'warning',
      message: '画布已归档,请先恢复再复制',
    })
  })

  it('on allow path produces an active copy without archivedByCascade', () => {
    seed({ c1: { ...canvas('src', 'p1'), archivedByCascade: true } }, [project('p1')], 'c1')

    const result = useCanvasStore.getState().duplicateCanvas('c1')

    expect(result).not.toBeUndefined()
    const copy = useCanvasStore.getState().canvases[result as string]
    expect(copy.status).toBe('active')
    expect(copy.archivedByCascade).toBeUndefined()
    expect(useCanvasStore.getState().sceneId).toBe(result)
  })
})
