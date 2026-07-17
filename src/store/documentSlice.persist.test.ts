// documentSlice.persist.test.ts
// G1-a R3 F2-B:server 模式零项目账号 createCanvas 不再 enqueue 空 projectId。
//
// R3 verdict:server 模式 createCanvas() fallback `get().projects[0]?.id ?? ''`,零项目账号 →
// projectId='' → 真 Hono POST /api/canvas 400 bad-body → 队列 terminal 删记录 → 刷新画布消失。
// 修:零项目时先自动建默认 project(createProject 同步 mint id + enqueue),canvas 归它;createProject
// 先于 createCanvas enqueue(drain 顺序保证 projectId 先服务端建好)。
//
// 本测试 mock persistMode=server(test env 默认 local),用计数 fetch 验证 enqueue 的 wire shape:
//  - 零项目 createCanvas → 先发 POST /api/projects(自动建默认 project),再发 POST /api/canvas 带
//    与该 project id 一致的非空 projectId(不再是 '')。
//  - 有项目时 createCanvas 不重复建 project(直接用既有 project[0].id)。
//
// 注:真 Hono route 行为(空 projectId → 400、有效 projectId → 201)由 server/routes/canvas.route.test.ts
// 覆盖;本文件覆盖客户端不再 enqueue 空 projectId + 自动建 project 的接线。
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Hermetic setup(同 persistBoot.integration.test.ts):node env 无 DOM/localStorage;canvasStore 经
// demoScenes→demoImages 在 module load 触发 createDemoImage→document.createElement 炸。装 in-memory
// localStorage + stub demoImage renderer;mock remoteDebugReporter(经 debugLogger flush)。
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k) },
    setItem: (k: string, v: string) => store.set(k, String(v)),
  }
  const noop = (): void => {}
  const eventTarget = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage, ...eventTarget }
  if (g.localStorage === undefined) g.localStorage = memStorage
  if (g.document === undefined) g.document = { ...eventTarget }
})
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))
// 钉 persistMode=server(必须在 import documentSlice 之前;vi.mock 提升)。test env 默认 local。
vi.mock('../lib/persistMode', () => ({
  isLocalPersist: false,
  isShadowPersist: false,
  isServerPersist: true,
  persistMode: 'server' as const,
  getPersistMode: () => 'server' as const,
}))

import { useCanvasStore } from './canvasStore'
import { useToastStore } from './toastStore'
import { startPersistWriteQueue, stopPersistWriteQueue, __resetPersistBoot } from '../lib/persistBoot'
import { __resetWriteQueueDb } from '../lib/writeRetryQueue'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })
const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 计数 fetch + 记录 wire shape(method/path/body)。返 201/200/204 让非画布 op success。 */
const makeCountingFetch = () => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(input, 'http://stub').pathname
    const body = init?.body ? JSON.parse(init.body as string) : null
    calls.push({ method, path, body })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ id: 'srv', revision: 0, metaRevision: 0, contentVersion: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
  useCanvasStore.setState({ projects: [], canvases: {} })
  useToastStore.getState().clearToasts()
})

describe('G1-a R3 F2-B — server 模式零项目账号 createCanvas 自动建 project(不再 enqueue 空 projectId)', () => {
  it('零项目 createCanvas → 先 POST /api/projects(自动建默认 project)再 POST /api/canvas 带一致非空 projectId', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    expect(useCanvasStore.getState().projects).toHaveLength(0)

    const canvasId = useCanvasStore.getState().createCanvas('first-canvas')
    await flush()
    const { drainPersistQueue } = await import('../lib/persistBoot')
    await drainPersistQueue()

    // 自动建了一个默认 project
    const projectPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')
    expect(projectPosts).toHaveLength(1)
    const autoProjectId = projectPosts[0]!.body as { id: string; name: string }
    expect(autoProjectId.id).toBeTruthy()
    expect(autoProjectId.name).toBeTruthy()

    // canvas POST 带与自动 project 一致的非空 projectId(R3 F2-B:修前为 '' → 真 Hono 400 → terminal 删)
    const canvasPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(canvasPosts).toHaveLength(1)
    const canvasBody = canvasPosts[0]!.body as { id: string; projectId: string; title: string }
    expect(canvasBody.id).toBe(canvasId)
    expect(canvasBody.projectId).toBe(autoProjectId.id) // 一致
    expect(canvasBody.projectId).not.toBe('') // R3 F2-B 核心:不再空
    expect(canvasBody.title).toBe('first-canvas')
  })

  it('有项目时 createCanvas 直接用既有 project[0].id(不重复建 project)', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.setState({ projects: [{ id: 'p-existing', name: 'Existing', createdAt: 't' }] as never })

    useCanvasStore.getState().createCanvas('second-canvas')
    await flush()
    const { drainPersistQueue } = await import('../lib/persistBoot')
    await drainPersistQueue()

    // 既有项目 → 不自动建 project
    const projectPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')
    expect(projectPosts).toHaveLength(0)
    // canvas 用既有 project id
    const canvasPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(canvasPosts).toHaveLength(1)
    expect((canvasPosts[0]!.body as { projectId: string }).projectId).toBe('p-existing')
  })
})

// PR-C1 二轮 P2(SC-1 server 模式):显式 archived projectId 阻止——不发 POST /api/canvas、不切 scene、warn toast。
//   与 archiveActions.test.ts 的 local 模式同名用例互补(两端都堵)。
describe('PR-C1 二轮 P2(SC-1 server) — createCanvas 显式 archived projectId 阻止', () => {
  it('不发 POST /api/canvas(archived 父项目闸门),不自动建 project,warn toast', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.setState({
      projects: [
        { id: 'p-arch', name: 'Archived', createdAt: 't', status: 'archived' },
      ] as never,
      canvases: {
        existing: {
          title: 'Existing',
          createdAt: 't',
          updatedAt: 't',
          nodes: [],
          edges: [],
          tasks: [],
          selectedNodeIds: [],
        },
      },
      sceneId: 'existing',
      nodes: [],
      edges: [],
      tasks: [],
    } as never)

    const result = useCanvasStore.getState().createCanvas('blocked-canvas', { projectId: 'p-arch' })
    await flush()
    const { drainPersistQueue } = await import('../lib/persistBoot')
    await drainPersistQueue()

    expect(result).toBeUndefined()
    const canvasPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(canvasPosts).toHaveLength(0) // 闸门前置短路,不 enqueue
    const projectPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')
    expect(projectPosts).toHaveLength(0) // 不自动建 Default Project(blocked 在建项目分支前)
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual(['existing']) // 不建档
    expect(useCanvasStore.getState().sceneId).toBe('existing') // 不切 scene
    expect(useToastStore.getState().entries.at(-1)).toMatchObject({
      level: 'warning',
      message: '目标项目已归档,请先恢复项目再新建画板',
    })
  })
})
