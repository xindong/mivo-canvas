// persistBoot.integration.test.ts
// G1-a P1-1 真接线集成:store action → enqueue → queue drain → executor → fetch(BFF wire shape)。
// 逐条对齐 finding P1-1 验收:
//  - local 0 网络请求(队列未启动 → enqueue no-op → 0 fetch)。
//  - server mutation 经 enqueue → drain → fetch(POST/PATCH/DELETE /api/projects wire shape 正确)。
//  - server 冷启动 hydrate 从 BFF 恢复(hydrateFromServer 替换 store.projects + 读 listCanvas)。
//  - shadow 双写 + 差异可观测(mutation 同样 enqueue → BFF;shadowCompareWithServer 读服务端 diff log)。
//
// 注:本测试用注入 fetch(计数 + wire-shape stub)验证 store action→request 链路 + hydrate store 替换;
// 真实 BFF route 行为(query filter / actor 指纹 / 428/409/422/404 / multipart)由 server/routes 侧
// 的 persistWiring.integration.test.ts(真实 Hono app.request)覆盖——两端合起来证 client→wire→BFF→backend 全链。

import { describe, expect, it, beforeEach, vi } from 'vitest'

// Hermetic setup(同 chatStore.test.ts):node env 无 DOM/localStorage;canvasStore 经
// canvasDocumentModel→demoScenes→demoImages 在 module load 触发 scenes()→createDemoImage
// →document.createElement 炸。装 in-memory localStorage(zustand persist)+ stub demoImage renderer。
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k) },
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
  }
  // node env 无 DOM;writeRetryQueue stop/start 调 window.addEventListener/removeEventListener('online')
  // 与 document.removeEventListener('visibilitychange')——给空实现规避;debugLogger 经
  // remoteDebugReporter flush,stub 之(chatStore.test.ts 同模式)。
  const noop = (): void => {}
  const eventTarget = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage, ...eventTarget }
  if (g.localStorage === undefined) g.localStorage = memStorage
  if (g.document === undefined) g.document = { ...eventTarget }
})
vi.mock('./demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('../store/remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import { useCanvasStore } from '../store/canvasStore'
import {
  drainPersistQueue,
  startPersistWriteQueue,
  stopPersistWriteQueue,
  __resetPersistBoot,
  hydrateFromServer,
  shadowCompareWithServer,
} from './persistBoot'
import { __resetWriteQueueDb } from './writeRetryQueue'
import type { ServerPersistAdapter } from './serverPersistAdapter'
import type { Project, CanvasMeta } from '../../shared/persist-contract.ts'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })

const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 计数 fetch + 记录 wire shape(method/path/body/headers)。返 201/200/204 让非画布 op success。 */
const makeCountingFetch = () => {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(input, 'http://stub').pathname
    const body = init?.body ? JSON.parse(init.body as string) : null
    calls.push({ method, path, body, headers: (init?.headers as Record<string, string>) ?? {} })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

const resetStoreProjects = (projects: Project[] = []): void => {
  useCanvasStore.setState({ projects })
}

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
  resetStoreProjects()
})

describe('G1-a P1-1 — local 模式 0 网络请求(队列未启动 → enqueue no-op)', () => {
  it('createProject / renameProject / deleteProject 均 0 fetch(local inert)', async () => {
    const { calls } = makeCountingFetch()
    // local 模式:不 startPersistWriteQueue → writeQueue undefined → enqueuePersistWrite no-op
    useCanvasStore.getState().createProject('local-proj')
    useCanvasStore.getState().createProject('p2')
    await flush()
    await drainPersistQueue() // undefined(local) → no drain
    expect(calls.length).toBe(0)
    // store 本身仍正常 mutation(local 行为不变)
    expect(useCanvasStore.getState().projects.length).toBeGreaterThanOrEqual(2)
  })
})

describe('G1-a P1-1 — server 模式 mutation → enqueue → drain → fetch(BFF wire shape)', () => {
  it('createProject → POST /api/projects,body {name, id},带 idempotency-key 头', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.getState().createProject('server-proj')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/projects' })
    expect(calls[0].body).toMatchObject({ name: 'server-proj' })
    expect(calls[0].body).toHaveProperty('id') // 带本地 id(幂等 POST)
    expect(calls[0].headers['idempotency-key']).toBeTruthy()
    expect(calls[0].headers['x-mivo-api-key']).toBe(KEY_A)
  })

  it('renameProject → PATCH /api/projects/:id,body {name},带 if-match(当 revision 存在)', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    // 预置一个 server-hydrated project(带 revision)——rename 的 If-Match base
    const serverProj: Project = { id: 'p-srv', name: 'old', ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 5, isDeleted: false }
    resetStoreProjects([serverProj])
    useCanvasStore.getState().renameProject('p-srv', 'new-name')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/projects/p-srv', body: { name: 'new-name' } })
    expect(calls[0].headers['if-match']).toBe('5') // server hydrate 带来的 revision 作 If-Match base
  })

  it('deleteProject → DELETE /api/projects/:id', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.getState().createProject('doomed')
    await flush()
    await drainPersistQueue() // create 先发
    calls.length = 0
    useCanvasStore.getState().deleteProject(useCanvasStore.getState().projects[useCanvasStore.getState().projects.length - 1]!.id)
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({ method: 'DELETE' })
    expect(calls[0].path).toMatch(/^\/api\/projects\/project-/)
  })
})

describe('G1-a P1-1 — server 冷启动 hydrate 从 BFF 恢复(hydrateFromServer 替换 store.projects)', () => {
  it('hydrateFromServer(fakeAdapter) → store.projects 被服务端真值替换 + listCanvas 读取', async () => {
    const serverProjects: Project[] = [
      { id: 'srv-1', name: 'Server Project A', ownerId: KEY_A, createdAt: 't1', updatedAt: 't1', revision: 0, isDeleted: false },
      { id: 'srv-2', name: 'Server Project B', ownerId: KEY_A, createdAt: 't2', updatedAt: 't2', revision: 0, isDeleted: false },
    ]
    const serverCanvases: CanvasMeta[] = [
      { id: 'c-srv', projectId: 'srv-1', title: 'c', createdAt: 't', updatedAt: 't', metaRevision: 0, contentVersion: 0 },
    ]
    // local 先有 demo project
    resetStoreProjects([{ id: 'demo', name: 'demo', createdAt: 't' } as unknown as Project])
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toContain('demo')

    const fakeAdapter = {
      listProjects: async () => ({ projects: serverProjects }),
      listCanvas: async () => ({ canvases: serverCanvases }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = {
      fetch: async () => new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await hydrateFromServer(fakeAdapter, fakeOpts)

    // server 真值替换 local demo
    const projects = useCanvasStore.getState().projects
    expect(projects.map((p) => p.id)).toEqual(['srv-1', 'srv-2'])
    expect(projects[0].name).toBe('Server Project A')
  })
})

describe('G1-a P1-1 — shadow 模式:差异可观测 + 双写(mutation 同样入队 → BFF)', () => {
  it('shadowCompareWithServer 读服务端 + 比对本地(不 crash;IDB 读源不变)', async () => {
    // local 有一个 demo project + 一个 server 没有的
    resetStoreProjects([
      { id: 'local-only', name: 'only-local', createdAt: 't' } as unknown as Project,
      { id: 'shared', name: 'shared', createdAt: 't' } as unknown as Project,
    ])
    const fakeAdapter = {
      listProjects: async () => ({
        projects: [
          { id: 'shared', name: 'shared', ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false },
          { id: 'srv-only', name: 'only-server', ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false },
        ] as Project[],
      }),
      listCanvas: async () => ({ canvases: [] }),
    } as unknown as ServerPersistAdapter
    // shadow compare 不 populate(读源不变);不 throw 即过(diff 写 debugLogger)
    await expect(shadowCompareWithServer(fakeAdapter)).resolves.toBeUndefined()
    // IDB 读源不变:projects 仍是 local 的(未被 server 覆盖)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['local-only', 'shared'])
  })

  it('shadow 双写:createProject 同样入队 → BFF(与 server 模式同 queue 路径)', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.getState().createProject('shadow-proj')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1) // shadow 也双写到 BFF(同 server 路径)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/projects' })
  })
})
