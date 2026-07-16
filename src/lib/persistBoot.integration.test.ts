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
import { useChatStore } from '../store/chatStore'
import { debugLogger } from '../store/debugLogStore'
import { enqueueChatAppend } from '../store/chatPersistSync'
import {
  drainPersistQueue,
  enqueuePersistWrite,
  startPersistWriteQueue,
  stopPersistWriteQueue,
  __resetPersistBoot,
  __flushServerMigrationForTest,
  hydrateFromServer,
  shadowCompareWithServer,
  getHydratedUserState,
  getChatOrderRevision,
  backfillChatAfterDrain,
} from './persistBoot'
import { __resetWriteQueueDb, __seedWritesForTest } from './writeRetryQueue'
import { ANONYMOUS_USER_ID, setPersistUserId, __resetPersistUserId } from './persistUserId'
import type { ServerPersistAdapter } from './serverPersistAdapter'
import type { Project, CanvasMeta } from '../../shared/persist-contract.ts'
import { DEMO_PROJECT_IDS } from '../store/demoScenes'

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

describe('G1-a P1-1 — server 冷启动 hydrate 从 BFF 恢复(store.projects = server 真值 ∪ local-only)', () => {
  it('hydrateFromServer(fakeAdapter) → server projects 入 store + local-only 保留 union(无 marker 差集迁移)+ listCanvas 读取', async () => {
    const serverProjects: Project[] = [
      { id: 'srv-1', name: 'Server Project A', ownerId: KEY_A, createdAt: 't1', updatedAt: 't1', revision: 0, isDeleted: false },
      { id: 'srv-2', name: 'Server Project B', ownerId: KEY_A, createdAt: 't2', updatedAt: 't2', revision: 0, isDeleted: false },
    ]
    const serverCanvases: CanvasMeta[] = [
      { id: 'c-srv', projectId: 'srv-1', title: 'c', createdAt: 't', updatedAt: 't', metaRevision: 0, contentVersion: 0 },
    ]
    // local 先有 demo project(server 没有 → local-only)
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

    // 无 marker:server 真值 ∪ local-only demo(差集迁移——不丢 local-only,SC-G 详测 op 入队)。
    //   旧版此处整替换丢 demo(线程1 数据丢失 bug);新版 union 保留 demo + 收集 createProject(demo)。
    const projects = useCanvasStore.getState().projects
    expect(projects.map((p) => p.id)).toEqual(['srv-1', 'srv-2', 'demo'])
    expect(projects[0].name).toBe('Server Project A')
    expect(projects.find((p) => p.id === 'demo')).toBeDefined() // local-only 保留(union)
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

// ── G1-a R2 Finding 1 负例:create/update coalesce 不丢 create + revision 回灌 ──────
// 验收(对齐 finding F1):
//  - create→rename(未 drain)只发单个 POST(不丢 create、不替换为 PATCH),body 为最终 name。
//  - create→drain→rename→drain:rename 的 PATCH 用回灌的新 revision(不陈旧),不 409/428。
//  - rename→drain→rename→drain:第二次 rename 用回灌的新 revision(不陈旧)。
//  - create→delete(未 drain)净消:0 请求(资源从未服务端创建,delete 无意义)。
//  - canvas 同模式:create→rename 合并为 POST;create→drain→rename→drain 用回灌 metaRevision。
// 严格 stub fetch:POST 返带 revision 的 Project/CanvasMeta;PATCH/PUT 缺/陈旧 if-match → 409(对齐真实
// server routes 的 revision-conflict 契约,非恒 200 假阳性);DELETE 204。revision 单调递增证明回灌后下次用新 base。
const makeRevisioningFetch = () => {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = []
  const projRev: Record<string, number> = {}
  const canvasRev: Record<string, number> = {}
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(input, 'http://stub').pathname
    const body = init?.body ? JSON.parse(init.body as string) : null
    const headers = (init?.headers as Record<string, string>) ?? {}
    calls.push({ method, path, body, headers })
    const json = (obj: unknown, status: number) =>
      new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (method === 'POST' && path === '/api/projects') {
      const id = (body?.id as string) ?? 'srv'
      const rev = (projRev[id] ?? -1) + 1
      projRev[id] = rev
      return json({ id, name: body?.name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: rev, isDeleted: false }, 201)
    }
    if (method === 'PATCH' && path.startsWith('/api/projects/')) {
      const id = decodeURIComponent(path.split('/').pop() as string)
      const ifMatch = headers['if-match']
      if (ifMatch === undefined || projRev[id] === undefined || Number(ifMatch) !== projRev[id]) {
        return json({ error: 'revision-conflict', currentRevision: projRev[id] ?? 0 }, 409)
      }
      const rev = projRev[id] + 1
      projRev[id] = rev
      return json({ id, name: body?.name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: rev, isDeleted: false }, 200)
    }
    if (method === 'POST' && path === '/api/canvas') {
      const id = (body?.id as string) ?? 'srv-c'
      const rev = (canvasRev[id] ?? -1) + 1
      canvasRev[id] = rev
      return json({ id, projectId: body?.projectId, title: body?.title, createdAt: 't', updatedAt: 't', metaRevision: rev, contentVersion: 0 }, 201)
    }
    if (method === 'PUT' && path.startsWith('/api/canvas/')) {
      const id = decodeURIComponent(path.split('/').pop() as string)
      const ifMatch = headers['if-match']
      if (ifMatch === undefined || canvasRev[id] === undefined || Number(ifMatch) !== canvasRev[id]) {
        return json({ error: 'revision-conflict', currentRevision: canvasRev[id] ?? 0 }, 409)
      }
      const rev = canvasRev[id] + 1
      canvasRev[id] = rev
      return json({ id, projectId: body?.payload?.projectId, title: body?.payload?.title, createdAt: 't', updatedAt: 't', metaRevision: rev, contentVersion: 0 }, 200)
    }
    return new Response(null, { status: 404 })
  }
  return { fetch, calls }
}

/**
 * P1-1 忠实三态 stub:忠实 mimic createCanvasWithCollection 的 existing 路径(backend.ts:720-724 /
 * pgBackend.ts:774-778)——POST 命中同 owner live existing → 返原 record(旧 title/projectId)不应用 incoming
 * (非"恒新建"假绿)。createCanvas op 的 create-or-update fix(P1-1)据此触发 mismatch → PUT 补写目标值。
 *
 * 真实 Hono route 跨 tsconfig src/server 项目边界不可行(app 项目 types=vite/client 无 node,引不进 server/app),
 * 故用忠实三态 stub 替代——mimic 真实 existing 语义(createCanvasWithCollection existing→clone(existing) 不应用
 * incoming),非恒新建;backend.ts:720-724 为语义真相源。expose canvases/projects map 供预建 + 断言 server 状态。
 */
const makeThreeStateCanvasFetch = () => {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = []
  const projects = new Map<string, { name: string; revision: number }>()
  const canvases = new Map<string, { title: string; projectId: string; metaRevision: number }>()
  const json = (obj: unknown, status: number) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(input, 'http://stub').pathname
    const body = init?.body ? JSON.parse(init.body as string) : null
    const headers = (init?.headers as Record<string, string>) ?? {}
    calls.push({ method, path, body, headers })
    if (method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop() as string)
      canvases.delete(id); projects.delete(id)
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && path === '/api/projects') {
      const id = (body?.id as string) ?? `p${projects.size}`
      projects.set(id, { name: body?.name ?? 'P', revision: 0 })
      return json({ id, name: body?.name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false }, 201)
    }
    if (method === 'POST' && path === '/api/canvas') {
      const id = (body?.id as string) ?? `c${canvases.size}`
      // 忠实 mimic backend.ts existing→clone(existing):命中 live existing 返旧 record 不应用 incoming。
      const existing = canvases.get(id)
      if (existing) {
        return json({ id, projectId: existing.projectId, title: existing.title, createdAt: 't', updatedAt: 't', metaRevision: existing.metaRevision, contentVersion: 0 }, 200)
      }
      const rec = { title: body?.title ?? 'Untitled', projectId: body?.projectId ?? '', metaRevision: 0 }
      canvases.set(id, rec)
      return json({ id, projectId: rec.projectId, title: rec.title, createdAt: 't', updatedAt: 't', metaRevision: 0, contentVersion: 0 }, 201)
    }
    if (method === 'PUT' && path.startsWith('/api/canvas/')) {
      const id = decodeURIComponent(path.split('/').pop() as string)
      const ifMatch = headers['if-match']
      const existing = canvases.get(id)
      if (!existing || ifMatch === undefined || Number(ifMatch) !== existing.metaRevision) {
        return json({ error: 'revision-conflict', currentRevision: existing?.metaRevision ?? 0 }, 409)
      }
      const updated = {
        title: body?.payload?.title ?? existing.title,
        projectId: body?.payload?.projectId ?? existing.projectId,
        metaRevision: existing.metaRevision + 1,
      }
      canvases.set(id, updated)
      return json({ id, projectId: updated.projectId, title: updated.title, createdAt: 't', updatedAt: 't', metaRevision: updated.metaRevision, contentVersion: 0 }, 200)
    }
    return new Response(null, { status: 404 })
  }
  return { fetch, calls, projects, canvases }
}

describe('G1-a R2 F1 — project create+update coalesce 不丢 create + revision 回灌', () => {
  it('create→rename(未 drain)合并为单个 POST,body 为最终 name(不丢 create)', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const id = useCanvasStore.getState().createProject('orig')
    useCanvasStore.getState().renameProject(id, 'final')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({ name: 'final', id })
  })

  it('create→drain→rename→drain:rename 用回灌的新 revision(不 409/428),revision 二次回灌', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const id = useCanvasStore.getState().createProject('p')
    await flush()
    await drainPersistQueue()
    expect(calls[0].method).toBe('POST')
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)?.revision).toBe(0)
    calls.length = 0
    useCanvasStore.getState().renameProject(id, 'p2')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].headers['if-match']).toBe('0')
    expect(calls[0].path).toBe(`/api/projects/${encodeURIComponent(id)}`)
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)?.revision).toBe(1)
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)?.name).toBe('p2')
  })

  it('rename→drain→rename→drain:第二次 rename 用回灌的新 revision(不陈旧 409)', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const id = useCanvasStore.getState().createProject('p')
    await flush()
    await drainPersistQueue() // POST → rev0 回灌
    useCanvasStore.getState().renameProject(id, 'r1')
    await flush()
    await drainPersistQueue() // PATCH if-match=0 → rev1 回灌
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)?.revision).toBe(1)
    useCanvasStore.getState().renameProject(id, 'r2')
    await flush()
    await drainPersistQueue() // PATCH if-match=1 → rev2(若用陈旧 0 → 409,记录被 terminal 删)
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)?.revision).toBe(2)
    expect(useCanvasStore.getState().projects.find((p) => p.id === id)?.name).toBe('r2')
    const patchCalls = calls.filter((c) => c.method === 'PATCH')
    expect(patchCalls[0].headers['if-match']).toBe('0')
    expect(patchCalls[1].headers['if-match']).toBe('1')
  })

  it('create→delete(未 drain)净消:0 请求(资源从未服务端创建)', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const id = useCanvasStore.getState().createProject('doomed')
    useCanvasStore.getState().deleteProject(id)
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(0)
  })
})

describe('G1-a R2 F1 — canvas create+update coalesce 不丢 create + metaRevision 回灌', () => {
  it('create→rename(未 drain)合并为单个 POST,body 为最终 title', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const id = useCanvasStore.getState().createCanvas('orig', { projectId: 'p1' })
    useCanvasStore.getState().renameCanvas(id, 'final')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({ id, projectId: 'p1', title: 'final' })
  })

  it('create→drain→rename→drain:rename 用回灌的新 metaRevision(不 409)', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const id = useCanvasStore.getState().createCanvas('c', { projectId: 'p1' })
    await flush()
    await drainPersistQueue()
    expect(useCanvasStore.getState().canvases[id]?.metaRevision).toBe(0)
    calls.length = 0
    useCanvasStore.getState().renameCanvas(id, 'c2')
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].headers['if-match']).toBe('0')
    expect(useCanvasStore.getState().canvases[id]?.metaRevision).toBe(1)
    expect(useCanvasStore.getState().canvases[id]?.title).toBe('c2')
  })
})

// ── G1-a R2 F2:server 冷启动恢复 canvas-meta + user-state(不 only-log)────────────────
// 验收(对齐 finding F2):
//  - 空 IDB + BFF 预置 canvas meta → store.canvases 出现 meta-stub(title/projectId/metaRevision 对齐;
//    content 空,全量 content hydrate 属 G1-c defer)。
//  - 本地已有 canvas + BFF meta → meta 字段刷新(title/metaRevision),本地 content(nodes)保留。
//  - user-state map 落点(getHydratedUserState 返值;非只 log)。
const canvasMeta = (id: string, projectId: string, title: string, metaRevision: number): CanvasMeta => ({
  id,
  projectId,
  title,
  createdAt: 't',
  updatedAt: 't',
  metaRevision,
  contentVersion: 0,
})

describe('G1-a R2 F2 — canvas-meta hydrate 合并进 store.canvases(不 only-log)', () => {
  it('空 IDB + BFF canvas meta → store.canvases 出现 meta-stub(meta 对齐,content 空 G1-c defer)', async () => {
    useCanvasStore.setState({ canvases: {} })
    expect(Object.keys(useCanvasStore.getState().canvases)).toHaveLength(0)
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [canvasMeta('c-srv', 'p1', 'server-canvas', 3)] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = {
      fetch: async () => new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const c = useCanvasStore.getState().canvases['c-srv']
    expect(c).toBeDefined()
    expect(c.title).toBe('server-canvas')
    expect(c.projectId).toBe('p1')
    expect(c.metaRevision).toBe(3)
    // content 空(全量 content hydrate 属 G1-c defer;meta 已恢复,非 only-log)
    expect(c.nodes).toEqual([])
  })

  it('本地已有 canvas + BFF meta → meta 刷新(title/metaRevision),本地 content 保留', async () => {
    const localNode = { id: 'n1', type: 'text', title: 'local', x: 0, y: 0, width: 100, height: 40, text: 'hi' } as never
    useCanvasStore.setState({
      canvases: {
        c1: { title: 'old-title', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [localNode], edges: [], tasks: [] } as never,
      },
    })
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [canvasMeta('c1', 'p1', 'new-title', 7)] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = {
      fetch: async () => new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const c = useCanvasStore.getState().canvases['c1']
    expect(c.title).toBe('new-title') // 服务端 meta 刷新
    expect(c.metaRevision).toBe(7)
    expect(c.nodes).toEqual([localNode]) // 本地 content 保留(G1-c content hydrate 未跑)
  })
})

describe('G1-a R2 F2 — user-state hydrate 落点(不 only-log)', () => {
  it('hydrate user-state map → getHydratedUserState 返值(非只 log)', async () => {
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = {
      fetch: async () =>
        new Response(
          JSON.stringify({ entries: { 'pref:theme': { key: 'pref:theme', value: 'dark', revision: 2, updatedAt: 't' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const entry = getHydratedUserState('pref:theme')
    expect(entry).toBeDefined()
    expect(entry?.value).toBe('dark')
    expect(entry?.revision).toBe(2)
    expect(getHydratedUserState('absent-key')).toBeUndefined()
  })
})

// ── G1-a R3 F2-A:user-state 真实消费方 ──────────────────────────────────────────
// R3 verdict:R2 只把 hydrate 存进 module 级 Map + getHydratedUserState accessor,全仓搜索 accessor 仅测试
// 用;生产 selection/camera/preferences 不读它("only cache")。修:hydrate 后真实应用 `canvas:<id>:selection`
// (DP-1 frozen user-state,每画布选中节点 id 列表)—— 恢复 active canvas 的 selection 到 store。用
// selectionFrom 过滤已删/hidden node 防悬空;同时写入 document(切 scene 不丢)。这是真实 store 消费方。
describe('G1-a R3 F2-A — user-state 真实消费方:canvas selection 恢复到 store', () => {
  const node = (id: string) => ({ id, type: 'text', title: id, x: 0, y: 0, width: 100, height: 40, text: 'hi' }) as never
  const docWith = (ids: string[], selIds: string[] = []) =>
    ({ title: 'c1', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: ids.map(node), edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: selIds }) as never

  const makeOpts = (entries: Record<string, unknown>): { fetch: typeof fetch; baseUrl: string; getAuthHeaders: () => Record<string, string> } => ({
    fetch: async () =>
      new Response(JSON.stringify({ entries }), { status: 200, headers: { 'content-type': 'application/json' } }),
    baseUrl: '',
    getAuthHeaders: () => authHeaders(),
  })

  it('hydrate canvas:<id>:selection → active canvas selection 恢复(节点存在;selectionFrom 过滤)', async () => {
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: { c1: docWith(['n1', 'n2']) },
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [canvasMeta('c1', 'p1', 'c1', 0)] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = makeOpts({ 'canvas:c1:selection': { key: 'canvas:c1:selection', value: ['n1', 'n2'], revision: 1, updatedAt: 't' } })
    await hydrateFromServer(fakeAdapter, fakeOpts)
    // R3 F2-A:selection 从服务端 user-state 恢复到 store(真实消费方,非只 accessor)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n1', 'n2'])
    expect(useCanvasStore.getState().selectedNodeId).toBe('n1') // primary = first
    // 写入 document(切 scene 不丢)
    expect(useCanvasStore.getState().canvases['c1']!.selectedNodeIds).toEqual(['n1', 'n2'])
  })

  it('selection 含已删 node → 过滤后只保留存在的(防悬空 selection)', async () => {
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: { c1: docWith(['n1']) }, // 本地只有 n1
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [canvasMeta('c1', 'p1', 'c1', 0)] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    // 服务端 selection 含 n-gone(本地已删)→ selectionFrom 过滤
    const fakeOpts = makeOpts({ 'canvas:c1:selection': { key: 'canvas:c1:selection', value: ['n1', 'n-gone'], revision: 1, updatedAt: 't' } })
    await hydrateFromServer(fakeAdapter, fakeOpts)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n1']) // n-gone 过滤掉
  })

  it('无 canvas:<id>:selection 条目 → selection 不变(本地读源保留)', async () => {
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: { c1: docWith(['n1']) },
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
    })
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [canvasMeta('c1', 'p1', 'c1', 0)] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = makeOpts({}) // 无 selection 条目
    await hydrateFromServer(fakeAdapter, fakeOpts)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n1']) // 不变
  })
})

// ── A2 前置 a / R-7 — chat hydrate merge 语义(保留本地未同步消息)──────────────────────
// 验收(计划 A2 前置 a / SC a):
//  - 离线 append chat(本地未同步,不在 server)→ server hydrate 不消失(merge-by-id 保留本地)。
//  - drain 把 pending 消息发到 PG(PG 侧可查)→ backfillChatAfterDrain 回填 store(server canonical)。
describe('A2 前置 a / R-7 — chat hydrate merge 语义(保留本地未同步消息)', () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByScene: {}, unsyncedChatMsgIds: {} })
  })

  it('离线 append chat → server hydrate 不消失(merge-by-id 保留本地未同步 + orderRevision 落点)', async () => {
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: { c1: { title: 'c', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never },
    })
    const localUnsynced = { id: 'msg-local', role: 'user', kind: 'text', text: 'offline append', createdAt: 1, status: 'done' } as never
    // P2-3:离线 append 经 enqueueChatAppend 置位 sidecar(模拟 prior-session enqueue 持久);hydrate 见
    //   local-only id 在 sidecar 内才保留(= pending append 证明),否则按 server canonical 删除。
    useChatStore.setState({ messagesByScene: { c1: [localUnsynced] }, unsyncedChatMsgIds: { c1: ['msg-local'] } })
    // server 有另一条已同步消息,不含本地未同步
    const serverMsg = { id: 'msg-srv', role: 'assistant', kind: 'text', text: 'server', createdAt: 0, status: 'done' } as never
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [{ payload: serverMsg }], orderRevision: 5 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = { fetch: async () => new Response('{}', { status: 200 }), baseUrl: '', getAuthHeaders: () => authHeaders() }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const msgs = useChatStore.getState().messagesByScene['c1']!
    // R-7 merge:server 消息 + 本地未同步都在(wholesale replace 会丢 msg-local)
    expect(msgs.map((m) => m.id).sort()).toEqual(['msg-local', 'msg-srv'])
    expect(getChatOrderRevision('c1')).toBe(5) // orderRevision 落点
  })

  it('drain 后 PG 侧可查 + backfillChatAfterDrain 回填 store(本地未同步已发 PG → server canonical)', async () => {
    const pgChat: { payload: unknown }[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      if (method === 'POST' && path.includes('/chat')) {
        const body = init?.body ? JSON.parse(init.body as string) : null
        pgChat.push({ payload: body?.message })
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 204 })
    }
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: { c1: { title: 'c', projectId: 'p1', createdAt: 't', updatedAt: 't', metaRevision: 0, nodes: [], edges: [], tasks: [] } as never },
    })
    const localMsg = { id: 'msg-offline', role: 'user', kind: 'text', text: 'offline', createdAt: 1, status: 'done' } as never
    // P2-3:localMsg 是 prior-session 离线 append(enqueue 置位 sidecar,跨 boot 持久);hydrate 前 sidecar 已就绪。
    useChatStore.setState({ messagesByScene: { c1: [localMsg] }, unsyncedChatMsgIds: { c1: ['msg-offline'] } })
    const fakeOpts = { fetch, baseUrl: '', getAuthHeaders: () => authHeaders() }
    // hydrate:server 无该消息 → merge 保留本地未同步(不消失)
    const adapterBefore = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    await hydrateFromServer(adapterBefore, fakeOpts)
    expect(useChatStore.getState().messagesByScene['c1']!.map((m) => m.id)).toEqual(['msg-offline'])
    // enqueue + drain:pending 消息发到 PG
    const { enqueueChatAppend } = await import('../store/chatPersistSync')
    enqueueChatAppend('c1', localMsg)
    await flush()
    await drainPersistQueue()
    expect(pgChat.length).toBe(1) // PG 侧可查
    // backfill:server 现在有该消息 → merge 取 server canonical(store 回填,内容一致)
    const adapterAfter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: pgChat, orderRevision: 1 }),
    } as unknown as ServerPersistAdapter
    await backfillChatAfterDrain('c1', adapterAfter)
    expect(useChatStore.getState().messagesByScene['c1']!.map((m) => m.id)).toEqual(['msg-offline']) // store 回填
  })
})

// ── A2 前置 b — project delete 整树软删 + restore(server 模式对齐 soft-delete 决议)──────────
// 验收(计划 A2 前置 b / SC b):
//  - server 模式 deleteProject 从 store 移除 project + 其画板(不 standalone 回落)+ enqueue deleteProject
//    + 为被移除画板 enqueue deleteCanvas(cancel pending createCanvas / 幂等已软删)。
//  - local 模式 deleteProject 保留 standalone 回落(防 IDB 数据丢失,软删基础设施仅服务端有)。
//  - restoreProject 重加 project + enqueue createProject(POST → server restoreProjectTree 整树恢复)。
describe('A2 前置 b — project delete 整树软删 + restore', () => {
  it('server 模式 deleteProject 从 store 移除 project + 其画板(不 standalone)+ enqueue deleteProject/deleteCanvas', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = useCanvasStore.getState().createProject('P')
    const cid = useCanvasStore.getState().createCanvas('c', { projectId: pid })
    await flush()
    await drainPersistQueue() // create project + canvas on server
    useCanvasStore.getState().deleteProject(pid)
    await flush()
    await drainPersistQueue()
    // project removed from store
    expect(useCanvasStore.getState().projects.find((p) => p.id === pid)).toBeUndefined()
    // canvas removed(NOT standalone — 整条画板从 store 移除,刷新后 hydrate 不再返回 → 不复现"迁回 standalone")
    expect(useCanvasStore.getState().canvases[cid]).toBeUndefined()
    // enqueue deleteProject(服务端 softDeleteProjectTree 整树级联)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/projects/${encodeURIComponent(pid)}`)).toBe(true)
    // 为被移除画板 enqueue deleteCanvas(cancel pending createCanvas / 幂等已软删)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/canvas/${encodeURIComponent(cid)}`)).toBe(true)
  })

  it('local 模式 deleteProject 保留 standalone 回落(不丢 IDB 数据,软删基础设施仅服务端有)', async () => {
    // 不 startPersistWriteQueue → isPersistWriteActive()=false → local standalone 回落
    const pid = useCanvasStore.getState().createProject('P')
    const cid = useCanvasStore.getState().createCanvas('c', { projectId: pid })
    useCanvasStore.getState().deleteProject(pid)
    expect(useCanvasStore.getState().projects.find((p) => p.id === pid)).toBeUndefined()
    // canvas body 保留,projectId→undefined(standalone 回落,防数据丢失)
    expect(useCanvasStore.getState().canvases[cid]).toBeDefined()
    expect(useCanvasStore.getState().canvases[cid]!.projectId).toBeUndefined()
  })

  it('restoreProject 重加 project + enqueue createProject(POST /api/projects 带被软删 id → restoreProjectTree)', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = 'p-soft-deleted'
    useCanvasStore.getState().restoreProject(pid, 'Restored')
    await flush()
    await drainPersistQueue()
    expect(useCanvasStore.getState().projects.find((p) => p.id === pid)?.name).toBe('Restored')
    // POST /api/projects with the deleted id → server ensureCreate 命中 deleted → restoreProjectTree 整树恢复
    const restoreCall = calls.find((c) => c.method === 'POST' && c.path === '/api/projects')
    expect(restoreCall).toBeDefined()
    expect(restoreCall!.body).toMatchObject({ id: pid, name: 'Restored' })
  })
})

// ── A2 前置 c — duplicateCanvas enqueue + 无 metaRevision 首写 baseline 消 428──────────────
// 验收(计划 A2 前置 c / SC c):
//  - duplicateCanvas(server 模式)enqueue createCanvas(POST /api/canvas,带新 id+projectId+title)→ duplicate 后服务端有记录。
//  - renameCanvas 无 metaRevision(旧 IDB 画板)→ enqueue createCanvas(POST ensureCreate)而非 updateCanvas(PUT)→ 不 428。
//  - renameCanvas 有 metaRevision → enqueue updateCanvas(PUT,If-Match,不变)。
describe('A2 前置 c — duplicateCanvas enqueue + 无 metaRevision 首写 baseline 消 428', () => {
  it('duplicateCanvas(server 模式)enqueue createCanvas(POST /api/canvas,带新 id+projectId+title "... Copy")', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = useCanvasStore.getState().createProject('P')
    const sourceId = useCanvasStore.getState().createCanvas('orig', { projectId: pid })
    await flush()
    await drainPersistQueue() // create source on server
    calls.length = 0
    const newId = useCanvasStore.getState().duplicateCanvas(sourceId)!
    expect(newId).not.toBe(sourceId)
    await flush()
    await drainPersistQueue()
    // duplicate → POST /api/canvas with new id + projectId + title "... Copy"(服务端有记录)
    const dupCall = calls.find((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(dupCall).toBeDefined()
    expect(dupCall!.body).toMatchObject({ id: newId, projectId: pid, title: 'orig Copy' })
  })

  it('renameCanvas 无 metaRevision(旧 IDB 画板)→ enqueue createCanvas 而非 updateCanvas(POST 不 428)', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = useCanvasStore.getState().createProject('P')
    // 预置旧画板(无 metaRevision,模拟 IDB-only 未 hydrate 到服务端)
    useCanvasStore.setState({
      canvases: { 'c-old': { title: 'old', projectId: pid, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never },
    })
    useCanvasStore.getState().renameCanvas('c-old', 'new-name')
    await flush()
    await drainPersistQueue()
    // 无 metaRevision → enqueue createCanvas(POST ensureCreate 带新 title),不发 updateCanvas(PUT 对 existing 缺 base → 428)
    const createCall = calls.find((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(createCall).toBeDefined()
    expect(createCall!.body).toMatchObject({ id: 'c-old', title: 'new-name' })
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/canvas/c-old')).toBe(false)
  })

  it('renameCanvas 有 metaRevision → enqueue updateCanvas(PUT,If-Match,不变,不 428)', async () => {
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = useCanvasStore.getState().createProject('P')
    const cid = useCanvasStore.getState().createCanvas('c', { projectId: pid })
    await flush()
    await drainPersistQueue() // create → metaRevision=0 回灌
    calls.length = 0
    useCanvasStore.getState().renameCanvas(cid, 'c2')
    await flush()
    await drainPersistQueue()
    // 有 metaRevision → PUT with if-match=0(不 428,对齐既有 happy path)
    expect(calls.some((c) => c.method === 'PUT' && c.path === `/api/canvas/${encodeURIComponent(cid)}` && c.headers['if-match'] === '0')).toBe(true)
  })

  it('moveCanvasToProject 无 metaRevision → enqueue createCanvas(POST,带 target projectId)', async () => {
    // P1-1:用 makeRevisioningFetch(POST 回显 body.title/projectId = created 路径,无 mismatch → 无 PUT);
    //   "server 有 existing(返旧 title)→ POST+PUT" 由 P1-1 真实 Hono route 用例覆盖(非本 stub)。
    const { fetch, calls } = makeRevisioningFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pidA = useCanvasStore.getState().createProject('PA')
    const pidB = useCanvasStore.getState().createProject('PB')
    // 旧画板在 pidA,无 metaRevision
    useCanvasStore.setState({
      canvases: { 'c-old': { title: 'old', projectId: pidA, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never },
    })
    useCanvasStore.getState().moveCanvasToProject('c-old', pidB)
    await flush()
    await drainPersistQueue()
    // 无 metaRevision → POST createCanvas with target projectId=pidB(不 428)
    const moveCreateCall = calls.find((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(moveCreateCall).toBeDefined()
    expect(moveCreateCall!.body).toMatchObject({ id: 'c-old', projectId: pidB })
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/canvas/c-old')).toBe(false)
  })
})

// ── P1-1(sol 返修)— createCanvas create-or-update:POST 命中 existing 返旧 record → mismatch 触发 PUT ────
// 验收(计划 P1-1 / sol 路径):服务端 createCanvasWithCollection 对同 owner live existing 返原 record 不应用
//   incoming title/projectId(backend.ts:720-724 / pgBackend.ts:774-778)→ POST 200 但 rename 静默回退
//   (applyServerRevision 只回灌 metaRevision 不比对值)。修:createCanvas op 改 create-or-update——POST 后
//   比对 title/projectId,不等则用返回 metaRevision 立即 PUT If-Match 写目标值。测试用忠实三态 stub
//   (真实 Hono route 跨 tsconfig src/server 项目边界不可行;stub mimic existing 语义,非恒新建假绿)。
describe('P1-1 — createCanvas create-or-update:POST 命中 existing → mismatch 触发 PUT 补写', () => {
  it('服务端预建 c-old(title=server-old)→ 本地同 id 无 metaRevision rename → drain 后 server title=new + store metaRevision 对齐 PUT + 无 terminal', async () => {
    const server = makeThreeStateCanvasFetch()
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = 'p-1'
    // 预建 server:c-old title=server-old, metaRevision=0(画板已在 server,本地却无 metaRevision)
    server.projects.set(pid, { name: 'P', revision: 0 })
    server.canvases.set('c-old', { title: 'server-old', projectId: pid, metaRevision: 0 })
    // 本地 c-old 无 metaRevision(旧 IDB 画板未 hydrate 到服务端)
    useCanvasStore.setState({
      sceneId: 'c-old',
      canvases: { 'c-old': { title: 'server-old', projectId: pid, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never },
    })
    useCanvasStore.getState().renameCanvas('c-old', 'new-name')
    await flush()
    const drainResult = await drainPersistQueue()
    // POST /api/canvas 命中 existing(返旧 title=server-old, metaRevision=0;不应用 incoming)
    const createCall = server.calls.find((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(createCall).toBeDefined()
    expect(createCall!.body).toMatchObject({ id: 'c-old', projectId: pid, title: 'new-name' })
    // P1-1:POST 返旧 title → mismatch → PUT 补写目标 title + If-Match=0(POST 返的 existing metaRevision)
    const putCall = server.calls.find((c) => c.method === 'PUT' && c.path === '/api/canvas/c-old')
    expect(putCall).toBeDefined()
    expect(putCall!.body).toMatchObject({ payload: { title: 'new-name', projectId: pid } })
    expect(putCall!.headers['if-match']).toBe('0')
    // server 现有 c-old title=new-name(POST 未应用 incoming,PUT 补写生效——无静默回退)
    expect(server.canvases.get('c-old')!.title).toBe('new-name')
    // 队列无 terminal/failure(create-or-update 成功,非 428/409 假绿)
    expect(drainResult?.terminals).toBe(0)
    expect(drainResult?.failures).toBe(0)
    // store metaRevision 对齐最终 PUT 回灌(=1;非 POST 的 0,亦非 undefined——刷新不再回退)
    expect(useCanvasStore.getState().canvases['c-old']!.metaRevision).toBe(1)
  })
})

// ── P1-2(sol 返修)— deleteProject server 分支维护 active-document 不变量 ────────────────
// 验收(计划 P1-2):server 模式删完须维护 active-document 不变量——active canvas 被删时原子切首个存活
//   canvas + 同步顶层 flattened document(nodes/edges/tasks/selection/tool/history),否则 sceneId 悬空 →
//   generation/mask 读 canvases[sceneId] 崩。无 survivor → 按 ≥1 canvas 不变量阻止删除(soft-delete-semantics.md:128)。
describe('P1-2 — deleteProject server 分支 active-document 不变量', () => {
  it('删含 active canvas 的项目(有 survivor)→ sceneId 切首个存活 + 顶层 state 同步', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pidA = useCanvasStore.getState().createProject('PA')
    const pidB = useCanvasStore.getState().createProject('PB')
    // 先 drain createProject(让 PA/PB 上 server,防 combineOps 把 pending createProject(PA)+deleteProject(PA) 净消)
    await flush()
    await drainPersistQueue()
    calls.length = 0
    const c1 = 'c-1'
    const c2 = 'c-2'
    // c1 属 PA(随 PA 删,且为 active);c2 属 PB(survivor)
    useCanvasStore.setState({
      sceneId: c1,
      canvases: {
        [c1]: { title: 'c1', projectId: pidA, createdAt: 't', updatedAt: 't', nodes: [{ id: 'n1' }] as never, edges: [], tasks: [] } as never,
        [c2]: { title: 'c2', projectId: pidB, createdAt: 't', updatedAt: 't', nodes: [{ id: 'n2' }] as never, edges: [], tasks: [] } as never,
      } as never,
    })
    const deleteResult = useCanvasStore.getState().deleteProject(pidA)
    await flush()
    await drainPersistQueue()
    // P1-2:c1(active)被删 → sceneId 切首个存活 c2 + 顶层 nodes 与 c2 一致(不悬空)
    expect(useCanvasStore.getState().sceneId).toBe(c2)
    expect(useCanvasStore.getState().canvases[c1]).toBeUndefined()
    expect(useCanvasStore.getState().canvases[c2]).toBeDefined()
    // P1-2:顶层 nodes 切到 c2 的 node(normalizeDocument 补全为完整 MivoCanvasNode;按 id+length 验,不 deep-equal)
    expect(useCanvasStore.getState().nodes).toHaveLength(1)
    expect(useCanvasStore.getState().nodes[0]?.id).toBe('n2')
    expect(useCanvasStore.getState().activeTool).toBe('select')
    expect(useCanvasStore.getState().historyPast).toEqual([])
    // e2e FAIL 修复:有 survivor 的删除返回 status:'deleted'(UI 据此弹 success toast)
    expect(deleteResult.status).toBe('deleted')
    // enqueue deleteProject(PA) + deleteCanvas(c1)(c2 属 PB 不被删,无 deleteCanvas c2)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/projects/${encodeURIComponent(pidA)}`)).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/canvas/${encodeURIComponent(c1)}`)).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/canvas/${encodeURIComponent(c2)}`)).toBe(false)
  })

  it('删最后全部 canvas(无 survivor)→ 阻止删除(≥1 canvas 不变量),project/canvas 仍在 + 不 enqueue DELETE', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = useCanvasStore.getState().createProject('P')
    const c1 = 'c-1'
    // 仅 c1 属 P(删 P 会零 canvas)
    useCanvasStore.setState({
      sceneId: c1,
      canvases: { [c1]: { title: 'c1', projectId: pid, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never } as never,
    })
    const deleteResult = useCanvasStore.getState().deleteProject(pid)
    await flush()
    await drainPersistQueue()
    // P1-2:无 survivor → 阻止删除(project + canvas 仍在,sceneId 不变,无 DELETE 入队)
    expect(useCanvasStore.getState().projects.find((p) => p.id === pid)).toBeDefined()
    expect(useCanvasStore.getState().canvases[c1]).toBeDefined()
    expect(useCanvasStore.getState().sceneId).toBe(c1)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/projects/${encodeURIComponent(pid)}`)).toBe(false)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/canvas/${encodeURIComponent(c1)}`)).toBe(false)
    // e2e FAIL 修复:零-survivor 阻止删除须返回 status:'blocked' + reason:'no-survivor'
    //   (UI 据此弹 warn toast"至少需保留一个画板",不误称"已删除"导致项目还在却显示成功)
    expect(deleteResult).toEqual({ status: 'blocked', reason: 'no-survivor' })
  })

  // sol 非阻断建议(顺手做):project/canvas 双删除次序 404 幂等——deleteProject 软删整树后,后续
  // deleteCanvas 撞已软删的 canvas → server 返 404 → executor 判 success(非 terminal/dead-letter 假阳性)。
  it('deleteProject 后 deleteCanvas 撞 404(已软删)→ executor 判 success,无 terminal(幂等组合)', async () => {
    const calls: { method: string; path: string }[] = []
    // DELETE /api/projects → 204;DELETE /api/canvas/* → 404(softDeleteProjectTree 已级联软删 canvas)
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      calls.push({ method, path })
      if (method === 'DELETE' && path.startsWith('/api/canvas/')) return new Response(JSON.stringify({ error: 'unknown-canvas' }), { status: 404, headers: { 'content-type': 'application/json' } })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    const pid = useCanvasStore.getState().createProject('P')
    await flush()
    await drainPersistQueue() // create project on server(204/200)
    calls.length = 0
    const c1 = 'c-1'
    useCanvasStore.setState({
      sceneId: c1,
      canvases: {
        [c1]: { title: 'c1', projectId: pid, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never,
        // survivor(防 P1-2 无 survivor 阻止删除;c2 属另一 project 不被删)
        'c-2': { title: 'c2', projectId: 'p-other', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never,
      } as never,
    })
    useCanvasStore.getState().deleteProject(pid)
    await flush()
    const drainResult = await drainPersistQueue()
    // 双 DELETE 都发出:deleteProject(pid)+ deleteCanvas(c1)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/projects/${encodeURIComponent(pid)}`)).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/canvas/${encodeURIComponent(c1)}`)).toBe(true)
    // deleteCanvas 撞 404(已软删)→ executor 判 success → 无 terminal/dead-letter 假阳性
    expect(drainResult?.terminals).toBe(0)
    expect(drainResult?.failures).toBe(0)
  })
})

// ── P2-3(sol 返修)— R-7 local-only 保留由 unsynced sidecar 证明,远端已删不复活 ────────────
// 验收(计划 P2-3):local-only 保留必须有 pending append 证明(chatStore.unsyncedChatMsgIds sidecar,
//   enqueueChatAppend 置位,hydrate 见在 server 集清位);否则远端已删消息被永久 union 复活。
describe('P2-3 — local-only 保留由 unsynced sidecar 证明,远端已删不复活', () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByScene: {}, unsyncedChatMsgIds: {} })
  })

  it('pending append(local-only + sidecar)→ hydrate 保留 + sidecar 维持 pending(synced id 清位)', async () => {
    useCanvasStore.setState({ sceneId: 'c1', canvases: { c1: { title: 'c', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never } })
    const m1 = { id: 'm1', role: 'user', kind: 'text', text: 'synced-before', createdAt: 0, status: 'done' } as never
    const m2 = { id: 'm2', role: 'user', kind: 'text', text: 'pending-append', createdAt: 1, status: 'done' } as never
    // m1 + m2 都曾在 sidecar(enqueue 标记);m1 已 drain 到 server(synced),m2 pending(未 drain)
    useChatStore.setState({ messagesByScene: { c1: [m1, m2] }, unsyncedChatMsgIds: { c1: ['m1', 'm2'] } })
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [{ payload: m1 }], orderRevision: 3 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = { fetch: async () => new Response('{}', { status: 200 }), baseUrl: '', getAuthHeaders: () => authHeaders() }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const msgs = useChatStore.getState().messagesByScene['c1']!
    // R-7 merge + P2-3:m1(server canonical)+ m2(local-only + sidecar 证明 pending)都保留
    expect(msgs.map((m) => m.id).sort()).toEqual(['m1', 'm2'])
    // P2-3:sidecar — m1 已 synced(在 server 集)→ 清位;m2 仍 pending(不在 server 集)→ 保留
    expect(useChatStore.getState().unsyncedChatMsgIds['c1']).toEqual(['m2'])
    // orderRevision 落点(含 local-only m2 时不得直接用于 reorder——m2 不在 server order,见 persistBoot 注释)
    expect(getChatOrderRevision('c1')).toBe(3)
  })

  it('远端已删(local-only + 无 sidecar)→ hydrate 不复活(server canonical 删除)', async () => {
    useCanvasStore.setState({ sceneId: 'c1', canvases: { c1: { title: 'c', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never } })
    const mDeleted = { id: 'm-del', role: 'user', kind: 'text', text: 'was-synced-then-deleted-remotely', createdAt: 0, status: 'done' } as never
    const mPending = { id: 'm-pend', role: 'user', kind: 'text', text: 'offline-append', createdAt: 1, status: 'done' } as never
    // m-del 曾 synced(不在 sidecar),远端已删;m-pend pending(在 sidecar)
    useChatStore.setState({ messagesByScene: { c1: [mDeleted, mPending] }, unsyncedChatMsgIds: { c1: ['m-pend'] } })
    // server 返空(m-del 远端已删;m-pend 未 drain)→ m-del 无 sidecar 证明 → 不复活;m-pend 有 sidecar → 保留
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fakeOpts = { fetch: async () => new Response('{}', { status: 200 }), baseUrl: '', getAuthHeaders: () => authHeaders() }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const msgs = useChatStore.getState().messagesByScene['c1']!
    // P2-3:m-del(远端已删,无 sidecar)→ 丢弃不复活;m-pend(pending,sidecar 证明)→ 保留
    expect(msgs.map((m) => m.id)).toEqual(['m-pend'])
    expect(useChatStore.getState().unsyncedChatMsgIds['c1']).toEqual(['m-pend'])
  })
})

// ── P2-3(sol 第二轮返修)— unsynced sidecar 生命周期矩阵(真实 enqueue→outcome→hydrate 链,禁手工 set marker)──
// 验收(lead 第二轮 P1):marker 生命周期经真实 enqueue/outcome 驱动(非手工 setState),覆盖 6 路径:
//   local no-op 无 marker / transient 保留 / 401 保留 / success 清 / terminal 不伪装 pending / success 后 remote delete 不复活。
// 修:sol 最小路径——marker 仅 queue active 时置位;writeRetryQueue onOutcome 终态 fire 清位;非终态保留。
describe('P2-3 生命周期矩阵 — unsynced sidecar 真实 enqueue→outcome→hydrate(禁手工 set marker)', () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByScene: {}, unsyncedChatMsgIds: {} })
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: { c1: { title: 'c', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never },
    })
  })

  /** appendChatMessage POST /api/canvas/:id/chat → 受控 status;其余 200/204。 */
  const makeChatOutcomeFetch = (chatStatus: number) => {
    const calls: { method: string; path: string }[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      calls.push({ method, path })
      if (method === 'POST' && path.includes('/chat')) {
        const body = chatStatus >= 200 && chatStatus < 300 ? '{}' : JSON.stringify({ error: 'stub' })
        return new Response(body, { status: chatStatus, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { fetch, calls }
  }

  const msg = (id: string): never => ({ id, role: 'user', kind: 'text', text: 'x', createdAt: 1, status: 'done' } as never)
  const emptyChatAdapter = {
    listProjects: async () => ({ projects: [] }),
    listCanvas: async () => ({ canvases: [] }),
    listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
  } as unknown as ServerPersistAdapter

  it('local 模式(无 queue)enqueueChatAppend 不置 marker;hydrate 后 local 消息按 canonical 删除(不复活)', async () => {
    // local:不 startPersistWriteQueue → enqueuePersistWrite 返 undefined → 不置 marker(消"local 假 marker → 切 server 永久 union")
    useChatStore.setState({ messagesByScene: { c1: [msg('m1')] }, unsyncedChatMsgIds: {} })
    enqueueChatAppend('c1', msg('m1'))
    expect(useChatStore.getState().unsyncedChatMsgIds['c1'] ?? []).toEqual([])
    // hydrate(server 空)→ m1 不在 server 集 + 无 marker → 按 canonical 删除(不复活为假 pending)
    await hydrateFromServer(emptyChatAdapter, { fetch: async () => new Response('{}', { status: 200 }), baseUrl: '', getAuthHeaders: () => authHeaders() })
    expect(useChatStore.getState().messagesByScene['c1'] ?? []).toEqual([])
  })

  it('transient(500 retry)→ marker 保留(非终态 onOutcome 不 fire;op 仍 pending 重试)', async () => {
    const { fetch } = makeChatOutcomeFetch(500)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useChatStore.setState({ messagesByScene: { c1: [msg('m1')] } })
    enqueueChatAppend('c1', msg('m1'))
    await flush()
    expect(useChatStore.getState().unsyncedChatMsgIds['c1']).toEqual(['m1']) // enqueue 置位(queue active)
    await drainPersistQueue() // POST chat → 500 → transient-retry → 非终态 → onOutcome 不 fire
    expect(useChatStore.getState().unsyncedChatMsgIds['c1']).toEqual(['m1']) // marker 保留
  })

  it('401(unauthorized paused)→ marker 保留(op 留存 paused-401 等 re-login replay)', async () => {
    const { fetch } = makeChatOutcomeFetch(401)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useChatStore.setState({ messagesByScene: { c1: [msg('m1')] } })
    enqueueChatAppend('c1', msg('m1'))
    await flush()
    await drainPersistQueue() // POST chat → 401 → unauthorized(paused-401)→ 非终态 → onOutcome 不 fire
    expect(useChatStore.getState().unsyncedChatMsgIds['c1']).toEqual(['m1']) // marker 保留
  })

  it('success(201)→ marker 清(无 revision 也清;消"成功不清 outcome.revision!==undefined 才 onSuccess")', async () => {
    const { fetch } = makeChatOutcomeFetch(201)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useChatStore.setState({ messagesByScene: { c1: [msg('m1')] } })
    enqueueChatAppend('c1', msg('m1'))
    await flush()
    expect(useChatStore.getState().unsyncedChatMsgIds['c1']).toEqual(['m1']) // enqueue 置位
    await drainPersistQueue() // POST chat → 201 success → onOutcome fire → 清位
    expect(useChatStore.getState().unsyncedChatMsgIds['c1'] ?? []).toEqual([]) // marker 清
  })

  it('terminal(400 rejected)→ marker 清(不伪装 pending;hydrate 后不复活,消"terminal 留假 pending → 永久 union")', async () => {
    const { fetch } = makeChatOutcomeFetch(400)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useChatStore.setState({ messagesByScene: { c1: [msg('m1')] } })
    enqueueChatAppend('c1', msg('m1'))
    await flush()
    await drainPersistQueue() // POST chat → 400 rejected(terminal)→ onOutcome fire → 清位
    expect(useChatStore.getState().unsyncedChatMsgIds['c1'] ?? []).toEqual([]) // marker 清(不伪装 pending)
    // hydrate(server 空)→ m1 不在 server 集 + 无 marker → 按 canonical 删除(不复活为假 pending)
    await hydrateFromServer(emptyChatAdapter, { fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    expect(useChatStore.getState().messagesByScene['c1'] ?? []).toEqual([])
  })

  it('success 后 remote delete 不复活(success 清 marker → hydrate 见 server 已删 + 无 marker → 丢弃)', async () => {
    const { fetch } = makeChatOutcomeFetch(201)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useChatStore.setState({ messagesByScene: { c1: [msg('m1')] } })
    enqueueChatAppend('c1', msg('m1'))
    await flush()
    await drainPersistQueue() // success → marker 清(消息已 drain 到 server)
    expect(useChatStore.getState().unsyncedChatMsgIds['c1'] ?? []).toEqual([])
    // 远端随后删了 m1 → hydrate server 不返 m1 + marker 已清 → 丢弃(不复活为假 pending)
    await hydrateFromServer(emptyChatAdapter, { fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    expect(useChatStore.getState().messagesByScene['c1'] ?? []).toEqual([])
  })

  it('溢出驱逐的 chat append fire onOutcome → marker 清 + hydrate 不复活(消"eviction 孤儿 marker 净回归")', async () => {
    // P2-3(sol 第三轮 P1):maxQueuePerUser=2 → 第 3 条 enqueue 驱逐最老 pending。stub 返 500(transient)
    //   → op 留 pending、marker 保留(不被 success 清),隔离驱逐路径的清位。flush 间隔保证 createdAt
    //   递增 → c1 为最老(被驱逐)。未修前:驱逐 deleteWrite 不经 drain switch → c1 marker 孤儿 → hydrate 永久
    //   union 复活(相对 main wholesale-replace 净回归)。修后:驱逐 fire onOutcome(terminal)清 c1 marker。
    const { fetch } = makeChatOutcomeFetch(500)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() }, { maxQueuePerUser: 2 })
    useCanvasStore.setState({
      sceneId: 'c1',
      canvases: {
        c1: { title: 'c1', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never,
        c2: { title: 'c2', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never,
        c3: { title: 'c3', projectId: 'p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never,
      } as never,
    })
    const m1 = msg('m1'), m2 = msg('m2'), m3 = msg('m3')
    useChatStore.setState({ messagesByScene: { c1: [m1], c2: [m2], c3: [m3] }, unsyncedChatMsgIds: {} })
    await enqueueChatAppend('c1', m1); await flush()
    await enqueueChatAppend('c2', m2); await flush()
    // 前 2 条 marker 置位(queue active)
    expect(useChatStore.getState().unsyncedChatMsgIds).toEqual({ c1: ['m1'], c2: ['m2'] })
    // 第 3 条 → active=2>=maxQueue → 驱逐 oldest(c1)→ onOutcome(terminal) 清 c1 marker(不孤儿)
    await enqueueChatAppend('c3', m3)
    expect(useChatStore.getState().unsyncedChatMsgIds['c1'] ?? []).toEqual([]) // c1 marker 清(驱逐 fire onOutcome)
    expect(useChatStore.getState().unsyncedChatMsgIds['c2']).toEqual(['m2']) // c2 留 pending
    expect(useChatStore.getState().unsyncedChatMsgIds['c3']).toEqual(['m3']) // c3 留 pending
    // hydrate(active=c1, server 空)→ m1 不在 server 集 + 无 marker → 按 canonical 删除(不复活为孤儿)
    await hydrateFromServer(emptyChatAdapter, { fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    expect(useChatStore.getState().messagesByScene['c1'] ?? []).toEqual([]) // 不复活
  })
})

// ── P1 bug fix(delete-resurrection)— hydrate 差集过滤(C)+ onOutcome 摘除(B)──────────────────
// 验收(lead SC-1~4):
//  SC-1:server 模式删项目/画布后立即刷新(drain 前)→ 已删项不再出现(hydrate 差集过滤 pending-delete)。
//  SC-2:删除后其他 op 撞 409 触发 re-hydrate、DELETE 仍 pending → 不复活(onConflict 复用同一差集过滤)。
//  SC-3:DELETE drain 成功后即使 hydrate 曾先灌回,本地 store 不含该记录(onOutcome success 摘除兜底)。
//  SC-4:restoreProject 恢复仍正常(不破坏恢复路径;pending delete 经 combineOps morph 成 create → C 不过滤)。
// 根因:bootPersistWiring 先 hydrateFromServer 后 startPersistWriteQueue;DELETE 还在 IDB 队列未 drain 时
//   hydrate 读服务端仍 LIVE 记录灌回本地 → 复活留到下次刷新。修 C(hydrateFromServer step1/step2 差集过滤
//   pending-delete)+ B(onOutcome success 摘除兜底,堵 C 未覆盖的 hydrate-先于-putWrite 竞态)。local 模式
//   hydrate/onOutcome 永不调(bootPersistWiring 第一行 return;队列未启动)。
describe('P1 bug fix — delete-resurrection: hydrate 差集过滤(C)+ onOutcome 摘除(B)', () => {
  const proj = (id: string, name: string): Project => ({
    id, name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false,
  })
  const cmeta = (id: string, projectId: string, title: string): CanvasMeta => ({
    id, projectId, title, createdAt: 't', updatedAt: 't', metaRevision: 0, contentVersion: 0,
  })
  const doc = (projectId: string, title: string) =>
    ({ title, projectId, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] }) as never
  const fakeAdapter = (projects: Project[], canvases: CanvasMeta[]): ServerPersistAdapter =>
    ({
      listProjects: async () => ({ projects }),
      listCanvas: async () => ({ canvases }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    }) as unknown as ServerPersistAdapter
  // hydrate 的 opts:user-state step3 fetch 返空 entries(同既有 hydrate 测试 fakeOpts 模式),
  //   与 queue 的 fetch 分离(queue 用注入 fetch 驱动 drain;hydrate 经 fakeAdapter + 此 opts)。
  const hydrateOpts = {
    fetch: async () => new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
    baseUrl: '',
    getAuthHeaders: () => authHeaders(),
  }

  // SC-1: server 模式删项目/画布后立即刷新(drain 前)→ 已删项不再出现(C 差集过滤)。
  it('SC-1: deleteProject(乐观移除 pX/cX + enqueue delete 未 drain)→ hydrate 不灌回(C 差集过滤)', async () => {
    const { fetch } = makeCountingFetch() // DELETE 204(不会被调:不手动 drain,5s timer 不及)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush() // start() immediate drain 在空队列跑完
    // pX/cX(active)+ pY/cY(survivor);sceneId=cX(被删 → P1-2 切 cY)
    resetStoreProjects([proj('pX', 'X'), proj('pY', 'Y')])
    useCanvasStore.setState({
      sceneId: 'cX',
      canvases: { cX: doc('pX', 'cX'), cY: doc('pY', 'cY') } as never,
    })
    // 真实 store action:乐观移除 pX/cX + sceneId→cY + enqueue deleteProject(pX)+deleteCanvas(cX)(pending 未 drain)
    useCanvasStore.getState().deleteProject('pX')
    await flush() // enqueue putWrite 落地(deletes pending,未 drain)
    // hydrate:服务端仍返 pX/cX LIVE(DELETE 未 drain)→ C 必须差集过滤,不灌回(无 C 则复活)
    await hydrateFromServer(
      fakeAdapter([proj('pX', 'X'), proj('pY', 'Y')], [cmeta('cX', 'pX', 'cX'), cmeta('cY', 'pY', 'cY')]),
      hydrateOpts,
    )
    // 已删 pX/cX 不复活(差集过滤);pY/cY 保留;sceneId 停 cY
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['pY'])
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual(['cY'])
    expect(useCanvasStore.getState().sceneId).toBe('cY')
  })

  // SC-2: 删除后其他 op 撞 409 触发 onConflict re-hydrate,DELETE 仍 pending → 不复活。
  it('SC-2: 409 触发 onConflict re-hydrate,pending-delete 被差集过滤(不复活)', async () => {
    // executor 用注入 fetch(wired):PATCH /api/projects/pY → 409 revision-conflict(触发 onConflict);
    //   DELETE → 204。onConflict 调 hydrateFromServer()(无参 → 默认 adapter,local 测试为 unwired →
    //   re-hydrate 失败但证 wiring fire);此处手动调 hydrateFromServer(fakeAdapter)模拟 server 模式
    //   wired adapter 下的 re-hydrate,验 C 差集过滤 pending-delete(production server 模式 onConflict
    //   的 void hydrateFromServer() 即跑此 C)。
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      if (method === 'PATCH' && path.startsWith('/api/projects/')) {
        return new Response(JSON.stringify({ error: 'revision-conflict', currentRevision: 9 }), { status: 409, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    resetStoreProjects([proj('pX', 'X'), proj('pY', 'Y')])
    useCanvasStore.setState({ canvases: {} })
    // pending deleteProject(pX):nextAttemptAt 远未来 → 本次 drain 不取(保持 pending 证 C 过滤)
    await __seedWritesForTest([{
      id: 'rec-del-px', idempotencyKey: 'k-del-px', userId: ANONYMOUS_USER_ID,
      op: { kind: 'deleteProject', projectId: 'pX' }, resourceKey: 'project:pX',
      createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending',
    }])
    // 触发 409:updateProject(pY) 带 stale base → PATCH 409 → onConflict → void hydrateFromServer()
    await enqueuePersistWrite({ kind: 'updateProject', projectId: 'pY', name: 'new', baseRevision: 0 })
    await flush()
    const drainResult = await drainPersistQueue()
    await flush(20) // onConflict 内 void hydrateFromServer fire-and-forget,等其落地(失败亦落地)
    // onConflict 的 re-hydrate 默认 unwired adapter(local 测试)失败 → store 未变(pX/pY 仍在)。
    //   手动调 hydrateFromServer(fakeAdapter)模拟 server 模式 wired re-hydrate → C 差集过滤 pX。
    await hydrateFromServer(fakeAdapter([proj('pX', 'X'), proj('pY', 'Y')], []), hydrateOpts)
    // 409 conflict terminal(证 onConflict 路径 fire)+ pX 不复活(pending-delete 被 C 差集过滤)
    expect(drainResult?.terminals).toBe(1)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['pY'])
  })

  // SC-3: hydrate 先灌回 → DELETE drain 成功 → onOutcome success 摘除(B 兜底)。
  it('SC-3: hydrate 先灌回 pX/cX → drain DELETE 成功 → onOutcome success 摘除(B 兜底)', async () => {
    const { fetch } = makeCountingFetch() // DELETE 204(success)
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    resetStoreProjects([])
    useCanvasStore.setState({ canvases: {} })
    // 第一次 hydrate:无 pending delete → C 不过滤 → pX/cX 灌回(模拟"删前 hydrate 已灌回"状态)
    await hydrateFromServer(fakeAdapter([proj('pX', 'X')], [cmeta('cX', 'pX', 'cX')]), hydrateOpts)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['pX']) // 灌回
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual(['cX']) // 灌回
    // 直接 enqueue delete(此时 pX/cX 已在 store,不经 store action 乐观移除)→ drain DELETE 204
    //   success → onOutcome fire(B 门 outcome.status==='success')→ 从 store 摘除
    await enqueuePersistWrite({ kind: 'deleteProject', projectId: 'pX' })
    await enqueuePersistWrite({ kind: 'deleteCanvas', canvasId: 'cX' })
    await flush()
    await drainPersistQueue()
    // B 摘除:即使 hydrate 曾灌回,drain 成功后 store 不含该记录
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual([])
    expect(Object.keys(useCanvasStore.getState().canvases)).toEqual([])
  })

  // SC-3 辅证:deleteProject 失败(rejected 400)→ onOutcome fire 但 B 不摘(outcome.status!==success)。
  it('SC-3 辅证:deleteProject 撞 400 rejected → onOutcome fire 但 B 不摘(server 仍有,保留一致)', async () => {
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'DELETE') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 400, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    resetStoreProjects([proj('pX', 'X')])
    useCanvasStore.setState({ canvases: {} })
    await enqueuePersistWrite({ kind: 'deleteProject', projectId: 'pX' })
    await flush()
    const drainResult = await drainPersistQueue()
    // 400 → rejected terminal → onOutcome fire 但 B 门 outcome.status==='success' 不满足 → 不摘
    //   (server 仍有 pX,本地保留一致;非"复活"而是"删除失败"——下次 hydrate 自然带回)
    expect(drainResult?.terminals).toBe(1)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['pX']) // 仍在(B 未摘)
  })

  // SC-4: restoreProject 恢复路径不被 C 破坏(pending delete 经 combineOps morph 成 create → C 不再过滤)。
  it('SC-4: restoreProject 把 pending deleteProject morph 成 createProject → hydrate 不再过滤(恢复不被破坏)', async () => {
    const { fetch } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    resetStoreProjects([])
    useCanvasStore.setState({ canvases: {} })
    // 预置 pending deleteProject(pX)(远未来不 drain)
    await __seedWritesForTest([{
      id: 'rec-del-px2', idempotencyKey: 'k-del-px2', userId: ANONYMOUS_USER_ID,
      op: { kind: 'deleteProject', projectId: 'pX' }, resourceKey: 'project:pX',
      createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending',
    }])
    // 第一次 hydrate:pX pending-delete → C 差集过滤 → store 无 pX(确认 C 在工作)
    await hydrateFromServer(fakeAdapter([proj('pX', 'X')], []), hydrateOpts)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual([])
    // restoreProject(pX):重加 project + enqueue createProject(id=pX) → combineOps 把 pending
    //   deleteProject morph 成 createProject(同 resourceKey last-wins)→ IDB 记录不再是 delete。
    useCanvasStore.getState().restoreProject('pX', 'Restored')
    await flush() // enqueue 的 getAllWrites+combineOps+putWrite 落地
    // 第二次 hydrate:IDB 记录已 morph 成 createProject → C 读不到 deleteProject → 不过滤 → pX 保留
    await hydrateFromServer(fakeAdapter([proj('pX', 'X')], []), hydrateOpts)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['pX']) // 恢复未被 C 破坏
  })
})

// ── D2 migration-on-boot + D3 DELETE in-flight + restoreProject 边缘(lead SC-B/D/E)──────────
// 验收:
//  SC-B: server 空 + 本地有存量 → boot 后本地不丢,迁移 create op 全量入队,drain 后服务端拿到全部。
//  SC-C: server 非空 → 现行为不变(#254 C 过滤用例不回归)— 由上文 SC-1~4 覆盖,此处不重复。
//  SC-D: 迁移幂等——同 userId 二次 boot 不重复入队(marker);换 userId 各自独立。
//  SC-E: DELETE in-flight + restoreProject → DELETE success 后 B 跳过摘除(项目仍在);无 restore 不回归。
describe('D2 migration-on-boot + D3 restore-safe edge (lead SC-B/D/E)', () => {
  const proj = (id: string, name: string): Project => ({
    id, name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false,
  })
  const doc = (projectId: string, title: string) =>
    ({ title, projectId, createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] }) as never
  const emptyAdapter = (): ServerPersistAdapter =>
    ({
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    }) as unknown as ServerPersistAdapter
  const hydrateOpts = {
    fetch: async () => new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
    baseUrl: '',
    getAuthHeaders: () => authHeaders(),
  }
  // fakeExecutor fetch:POST /api/projects → 200 {id,name,revision};POST /api/canvas → 200 CanvasMeta(echo,
  //   无 mismatch → 不触发补 PUT);DELETE → 204。记录 wire shape(body.id)供断言。
  const makeMigrationFetch = () => {
    const calls: { method: string; path: string; body: unknown }[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      const body = init?.body ? JSON.parse(init.body as string) : null
      calls.push({ method, path, body })
      if (method === 'POST' && path === '/api/projects') {
        return new Response(JSON.stringify({ id: (body as { id: string }).id, name: (body as { name: string }).name, revision: 1, ownerId: KEY_A, createdAt: 't', updatedAt: 't', isDeleted: false }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'POST' && path === '/api/canvas') {
        const b = body as { id: string; projectId: string; title?: string }
        return new Response(JSON.stringify({ id: b.id, projectId: b.projectId, title: b.title ?? '', metaRevision: 1, contentVersion: 0, createdAt: 't', updatedAt: 't' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { fetch, calls }
  }

  // makeMigrationServer:stateful 迁移服务端 —— adapter(listProjects/listCanvas 读 state)与
  //   queue fetch(POST/DELETE 写 state)**共享同一 state**。F1 flush 在 drain 后重拉 adapter.listProjects/
  //   listCanvas 验证可恢复性,故 adapter 必须反映 drain 后服务端真值(POST 成功的 create 已入 state);
  //   旧 stateless emptyAdapter/nonEmptyAdapter 在全成功路径会让 F1 误判 terminal → 不种 marker(SC-B/D/G 回归)。
  //   failProjectOnce:某 project id 首次 POST /api/projects 返 400(rejected terminal);后续返 200(SC-J 用)。
  const makeMigrationServer = (opts: {
    projects?: Project[]
    canvases?: CanvasMeta[]
    failProjectOnce?: string
    // P1 r5 二轮终审(partial collection):首调抛、后续成功(瞬断),模拟 step1/step2 任一 list 一次性失败。
    //   adapter 的 listProjects/listCanvas 被 hydrate(step1/step2)+ flush 内 verifyMigrationCandidatesRecoverable
    //   共用;首调抛置 flag、后续调成功反映 drain 后真值(F1 stateful 不变)。
    failListProjectsOnce?: boolean
    failListCanvasOnce?: boolean
  } = {}): {
    adapter: ServerPersistAdapter
    fetch: (input: string, init?: RequestInit) => Promise<Response>
    calls: { method: string; path: string; body: unknown }[]
    state: { projects: Project[]; canvases: CanvasMeta[] }
  } => {
    const state = {
      projects: [...(opts.projects ?? [])],
      canvases: [...(opts.canvases ?? [])],
    }
    const calls: { method: string; path: string; body: unknown }[] = []
    const failCount = new Map<string, number>()
    let listProjectsFailed = false
    let listCanvasFailed = false
    const adapter: ServerPersistAdapter = {
      listProjects: async () => {
        if (opts.failListProjectsOnce && !listProjectsFailed) {
          listProjectsFailed = true
          throw new Error('listProjects transient boom (partial collection)')
        }
        return { projects: state.projects.map((p) => ({ ...p })) }
      },
      listCanvas: async () => {
        if (opts.failListCanvasOnce && !listCanvasFailed) {
          listCanvasFailed = true
          throw new Error('listCanvas transient boom (partial collection)')
        }
        return { canvases: state.canvases.map((c) => ({ ...c })) }
      },
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      const body = init?.body ? JSON.parse(init.body as string) : null
      calls.push({ method, path, body })
      if (method === 'POST' && path === '/api/projects') {
        const b = body as { id: string; name: string }
        if (opts.failProjectOnce && b.id === opts.failProjectOnce && (failCount.get(b.id) ?? 0) < 1) {
          failCount.set(b.id, (failCount.get(b.id) ?? 0) + 1)
          return new Response(JSON.stringify({ error: 'rejected-simulated-terminal' }), { status: 400, headers: { 'content-type': 'application/json' } })
        }
        if (!state.projects.some((p) => p.id === b.id)) {
          state.projects.push({ id: b.id, name: b.name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 1, isDeleted: false })
        }
        return new Response(JSON.stringify({ id: b.id, name: b.name, revision: 1, ownerId: KEY_A, createdAt: 't', updatedAt: 't', isDeleted: false }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'POST' && path === '/api/canvas') {
        const b = body as { id: string; projectId: string; title?: string }
        if (!state.canvases.some((c) => c.id === b.id)) {
          state.canvases.push({ id: b.id, projectId: b.projectId, title: b.title ?? '', createdAt: 't', updatedAt: 't', metaRevision: 1, contentVersion: 0 })
        }
        return new Response(JSON.stringify({ id: b.id, projectId: b.projectId, title: b.title ?? '', metaRevision: 1, contentVersion: 0, createdAt: 't', updatedAt: 't' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { adapter, fetch, calls, state }
  }

  // SC-B: server 空 + 本地有 project/canvas → hydrate 保留本地 + flush enqueue + drain 后服务端拿到全部。
  it('SC-B: server 空 + 本地有 project/canvas → hydrate 保留本地 + flush enqueue + drain 后服务端拿到全部记录', async () => {
    const server = makeMigrationServer()
    const calls = server.calls
    resetStoreProjects([proj('p1', 'Proj1'), proj('p2', 'Proj2')])
    useCanvasStore.setState({ canvases: { c1: doc('p1', 'C1'), c2: doc('p2', 'C2') } as never })
    // hydrate:server 空 + 本地有 + 无 marker → 保留本地 + 收集 createProject(p1,p2)+createCanvas(c1,c2)
    await hydrateFromServer(server.adapter, hydrateOpts)
    // 本地不丢(迁移分支保留本地,不 replace 为 [])
    expect(useCanvasStore.getState().projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(Object.keys(useCanvasStore.getState().canvases).sort()).toEqual(['c1', 'c2'])
    // start queue + flush(queue 已启动 → 真 enqueue + drain + F1 可恢复性验证 → 全成功 marker 种)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter)
    await flush()
    // 服务端拿到全部:createProject p1/p2 + createCanvas c1/c2
    const projectCreates = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')
    const canvasCreates = calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas')
    expect(projectCreates.map((c) => (c.body as { id: string }).id).sort()).toEqual(['p1', 'p2'])
    expect(canvasCreates.map((c) => (c.body as { id: string }).id).sort()).toEqual(['c1', 'c2'])
    // marker seeded(F1:全 candidate 可恢复 → 种;SC-D 前置)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    // F1:stateful server 反映 drain 后真值(p1/p2 已入服务端)
    expect(server.state.projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })

  // SC-D: 同 userId 二次 boot marker 已 set → hydrate 跳迁移收集 + 保留本地 → flush 不重复入队。
  it('SC-D: 同 userId 二次 boot marker 已 set → 不重复入队(保留本地,marker 防重迁)', async () => {
    const server = makeMigrationServer()
    const calls = server.calls
    // 第一次 boot:server 空 + 本地 p1 → 迁移 + marker(F1:drain 后 p1 在服务端 → 可恢复 → 种 marker)
    resetStoreProjects([proj('p1', 'P1')])
    useCanvasStore.setState({ canvases: {} })
    await hydrateFromServer(server.adapter, hydrateOpts)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter)
    await flush()
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')).toHaveLength(1)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    // 第二次 boot:仅 stop queue + 清 IDB(保留 marker;不调 __resetPersistBoot 否则清 marker)。
    //   用 emptyAdapter 模拟"server empty + marker set + 本地有"→ keep-local 分支(独立覆盖;stateful
    //   server 实际已有 p1,但此处隔离测 keep-local 不 replace 为 [])。flush 无迁移 op → no-op,无 F1 验证。
    stopPersistWriteQueue()
    await __resetWriteQueueDb()
    resetStoreProjects([proj('p1', 'P1')]) // 本地仍有 p1
    useCanvasStore.setState({ canvases: {} })
    await hydrateFromServer(emptyAdapter(), hydrateOpts)
    // marker set → 跳迁移收集;keep-local 解耦 → 本地 p1 不丢(不 replace 为 [])
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['p1'])
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest() // pendingServerMigrationOps 空(marker 拦截)→ no-op
    await flush()
    // 二次 boot 不重复入队:POST /api/projects 计数不增(仍为 1)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')).toHaveLength(1)
  })

  // SC-D: 换 userId 各自独立(marker 按 userId 分区;userA 已迁不影响 userB)。
  it('SC-D: 换 userId 各自独立(marker 按 userId 分区;userA 已迁不影响 userB)', async () => {
    __resetPersistUserId()
    setPersistUserId('userA')
    try {
      // 各 userId 独立 stateful server(模型 per-user 服务端数据隔离;F1 需 stateful 以种 marker)
      const serverA = makeMigrationServer()
      const serverB = makeMigrationServer()
      // userA boot:server 空 + 本地 pA → 迁移 + marker A
      resetStoreProjects([proj('pA', 'PA')])
      useCanvasStore.setState({ canvases: {} })
      await hydrateFromServer(serverA.adapter, hydrateOpts)
      startPersistWriteQueue({ fetch: serverA.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
      await flush()
      await __flushServerMigrationForTest(serverA.adapter)
      await flush()
      expect(localStorage.getItem('mivo:server-migration:userA')).toBe('done')
      // userB:marker B 未设(独立)
      expect(localStorage.getItem('mivo:server-migration:userB')).toBeNull()
      stopPersistWriteQueue()
      await __resetWriteQueueDb()
      setPersistUserId('userB')
      // userB boot:server 空 + 本地 pB → 迁移 + marker B
      resetStoreProjects([proj('pB', 'PB')])
      useCanvasStore.setState({ canvases: {} })
      await hydrateFromServer(serverB.adapter, hydrateOpts)
      startPersistWriteQueue({ fetch: serverB.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
      await flush()
      await __flushServerMigrationForTest(serverB.adapter)
      await flush()
      expect(localStorage.getItem('mivo:server-migration:userB')).toBe('done')
      // 两 userId 各自 marker 独立
      expect(localStorage.getItem('mivo:server-migration:userA')).toBe('done')
      // 服务端拿到 userA 的 pA + userB 的 pB(各 server 独立 calls 合并)
      const ids = [...serverA.calls, ...serverB.calls]
        .filter((c) => c.method === 'POST' && c.path === '/api/projects')
        .map((c) => (c.body as { id: string }).id)
      expect(ids.sort()).toEqual(['pA', 'pB'])
    } finally {
      __resetPersistUserId()
    }
  })

  // SC-E (D3): deleteProject in-flight + restoreProject → DELETE success → B 跳过摘除,项目仍在。
  it('SC-E: deleteProject in-flight + restoreProject → DELETE success → B 跳过摘除(项目仍在)', async () => {
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      if (method === 'DELETE' && path === '/api/projects/pX') {
        // DELETE in-flight 窗口:用户立即 restoreProject(pX) → 重加 store + enqueue createProject(pX)
        //   (deleteProject 此刻 in-flight → combineOps 不合并 → 两记录共存:delete in-flight + create pending)
        useCanvasStore.getState().restoreProject('pX', 'Restored')
        await flush() // createProject(pX) enqueue 的 putWrite 落地 IDB
        return new Response(null, { status: 204 }) // DELETE success
      }
      if (method === 'POST' && path === '/api/projects') {
        return new Response(JSON.stringify({ id: 'pX', name: 'Restored', revision: 5, ownerId: KEY_A, createdAt: 't', updatedAt: 't', isDeleted: false }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    resetStoreProjects([proj('pX', 'X')])
    // 用户删 pX(store action:乐观移除 + enqueue deleteProject)
    useCanvasStore.getState().deleteProject('pX')
    await flush() // deleteProject(pX) pending
    // drain:deleteProject in-flight → mid-flight restoreProject → DELETE 204 success → B 查 pending create → 跳过摘除
    await drainPersistQueue()
    await flush()
    // pX 仍在(B 跳过:pending createProject(pX) restore 存在)。无 D3 则 B 会摘除 pX → bug。
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toContain('pX')
    // pending createProject(pX) 仍在队列(本轮 sortedDue 快照不含 mid-flight enqueue)→ 再 drain 重建
    await drainPersistQueue()
    await flush()
    // createProject drain success → applyServerRevision 更新 pX(在 store)→ pX 仍在
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toContain('pX')
  })

  // SC-E 回归:DELETE success 无 restore → B 照常摘除(D3 不破坏无 restore 路径;#254 SC-3 同款不回归)。
  it('SC-E 回归: DELETE success 无 restore → B 照常摘除(D3 不破坏无 restore 路径)', async () => {
    const { fetch } = makeCountingFetch() // DELETE 204 success
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    resetStoreProjects([proj('pX', 'X')])
    // 直接 enqueue deleteProject(无 restore)→ drain DELETE success → 无 pending create → B 摘除
    await enqueuePersistWrite({ kind: 'deleteProject', projectId: 'pX' })
    await flush()
    await drainPersistQueue()
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual([])
  })

  // ── 差集迁移(Greptile 线程1 数据丢失修复;lead SC-G/H)──────────
  //  SC-G: server 非空 + 本地有 local-only project/canvas + 无 marker → 本地不丢(store 并集)、
  //        差集 create op 入队、drain 后服务端补齐;已在服务端的 id 不重复入队。
  //  SC-H: marker 已种 + server 非空 + 本地有 local-only → 纯现行为(replace,不再迁移)——线程1 场景在 marker 后收敛。
  const cmeta = (id: string, projectId: string, title: string): CanvasMeta => ({
    id, projectId, title, createdAt: 't', updatedAt: 't', metaRevision: 0, contentVersion: 0,
  })
  // server 已有 pSrv/cSrv(模拟"另一台浏览器已上迁,服务端非空");本地有 local-only pLocal/cLocal + 共享 pSrv/cSrv。
  const nonEmptyAdapter = (projects: Project[], canvases: CanvasMeta[]): ServerPersistAdapter =>
    ({
      listProjects: async () => ({ projects }),
      listCanvas: async () => ({ canvases }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    }) as unknown as ServerPersistAdapter

  // SC-G(兼 SC-L 全成功回归):server 非空 + 本地 local-only + 无 marker → 本地不丢(union)+ 差集 op 入队
  //   + drain 补齐 + server id 不重复入队 + F1 全 candidate 可恢复 → marker 种上(行为同 d3b8927)。
  it('SC-G: server 非空 + 本地 local-only + 无 marker → 本地不丢(union)+ 差集 op 入队 + drain 补齐 + server id 不重复入队', async () => {
    const serverProj = [proj('pSrv', 'Srv')]
    const serverCv = [cmeta('cSrv', 'pSrv', 'CSrv')]
    const server = makeMigrationServer({ projects: serverProj, canvases: serverCv })
    const calls = server.calls
    // 本地:pLocal/cLocal(server 没有 → local-only 差集候选)+ pSrv/cSrv(共享,已在服务端)
    resetStoreProjects([proj('pLocal', 'Local'), proj('pSrv', 'Srv')])
    useCanvasStore.setState({ canvases: { cLocal: doc('pLocal', 'CLocal'), cSrv: doc('pSrv', 'CSrv') } as never })
    await hydrateFromServer(server.adapter, hydrateOpts)
    // 本地不丢(union):pLocal 保留(差集候选,SC-G 核心——旧版此处整替换丢 pLocal = 线程1 bug);
    //   pSrv 取服务端真值;差集 union 不丢 local-only。
    expect(useCanvasStore.getState().projects.map((p) => p.id).sort()).toEqual(['pLocal', 'pSrv'])
    // canvas 同理:union-merge 保留 local-only cLocal(旧版 else 也保留,但漏迁 op;新版补 op)。
    expect(Object.keys(useCanvasStore.getState().canvases).sort()).toEqual(['cLocal', 'cSrv'])
    // start queue + flush(queue 已启动 → 真 enqueue + drain + F1 验证)→ 只为 local-only 候选入队(pLocal, cLocal)。
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter)
    await flush()
    const projectCreates = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects').map((c) => (c.body as { id: string }).id)
    const canvasCreates = calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas').map((c) => (c.body as { id: string }).id)
    // 已在服务端的 id(pSrv/cSrv)不重复入队;只上迁 local-only(pLocal/cLocal)。
    expect(projectCreates.sort()).toEqual(['pLocal'])
    expect(canvasCreates.sort()).toEqual(['cLocal'])
    // F1(SC-L):全 candidate 可恢复(drain 后 pLocal/cLocal 已在服务端)→ marker 种上(行为同 d3b8927)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    // F1:stateful server 反映 drain 后真值(pSrv 初始 + pLocal 上迁)
    expect(server.state.projects.map((p) => p.id).sort()).toEqual(['pLocal', 'pSrv'])
    expect(server.state.canvases.map((c) => c.id).sort()).toEqual(['cLocal', 'cSrv'])
  })

  it('SC-H: marker 已种 + server 非空 + 本地 local-only → 纯现行为(replace,不再迁移;线程1 场景 marker 后收敛)', async () => {
    const { fetch, calls } = makeMigrationFetch()
    // 预种 marker(模拟"曾迁移过的浏览器二次 boot";beforeEach 已清,此处显式种)。
    localStorage.setItem('mivo:server-migration:anonymous', 'done')
    const serverProj = [proj('pSrv', 'Srv')]
    const serverCv = [cmeta('cSrv', 'pSrv', 'CSrv')]
    // 同 SC-G 的本地态(pLocal/cLocal local-only + pSrv/cSrv 共享),但 marker 已种。
    resetStoreProjects([proj('pLocal', 'Local'), proj('pSrv', 'Srv')])
    useCanvasStore.setState({ canvases: { cLocal: doc('pLocal', 'CLocal'), cSrv: doc('pSrv', 'CSrv') } as never })
    await hydrateFromServer(nonEmptyAdapter(serverProj, serverCv), hydrateOpts)
    // marker set → 纯现行为:projects 服务端真值 replace(pLocal 被丢——线程1 场景在 marker 后收敛,
    //   即 marker 后不再走差集 union;local-only 此处 = 迁移后新建/已在队列,replace 不破)。
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(['pSrv'])
    // canvas:marker set 走 else union-merge(同旧版 else——canvas else 本就 union 保留 local-only,不变)。
    expect(Object.keys(useCanvasStore.getState().canvases).sort()).toEqual(['cLocal', 'cSrv'])
    // 不收集迁移 op(marker 拦截两步)→ flush no-op → 无 POST(不再迁移)。
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest() // pendingServerMigrationOps 空(marker 拦截)→ no-op
    await flush()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  // ── F1+F2 r3 返修(lead SC-J/K;Greptile 线程4 数据丢失残根)──────────
  //  SC-J: p1 成功 + p2 4xx terminal → flush 后 marker 未种 + error 日志;二次 boot 差集重收集 p2(重试)
  //        且 p1 不重复入队;p2 二次成功后 marker 种上。
  //  SC-K: marker 已种 + createProject(p2) 仍 pending 于队列 + 服务端仅 p1 → hydrate replace 分支 setState 含 p2
  //        (pending-create 并集保护 F2,不丢)。
  it('SC-J: p1 成功 + p2 4xx terminal → flush 不种 marker + error;二次 boot 差集重收 p2(不重排 p1)+ p2 成功后种 marker', async () => {
    const server = makeMigrationServer({ failProjectOnce: 'p2' })
    const calls = server.calls
    const errorSpy = vi.spyOn(debugLogger, 'error')
    try {
      // 第一次 boot:server 空 + 本地 p1/p2 + 无 marker → 差集收集 p1,p2
      resetStoreProjects([proj('p1', 'P1'), proj('p2', 'P2')])
      useCanvasStore.setState({ canvases: {} })
      await hydrateFromServer(server.adapter, hydrateOpts)
      startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
      await flush()
      await __flushServerMigrationForTest(server.adapter)
      await flush()
      // drain:p1 POST 200(入服务端),p2 POST 400 rejected terminal(不入服务端、recordTerminal 离队)
      const p1Posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects' && (c.body as { id: string }).id === 'p1')
      const p2Posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects' && (c.body as { id: string }).id === 'p2')
      expect(p1Posts).toHaveLength(1)
      expect(p2Posts).toHaveLength(1)
      // F1:p2 terminal(既不在服务端也不在队列)→ marker 未种
      expect(localStorage.getItem('mivo:server-migration:anonymous')).toBeNull()
      // F1(D4):debugLogger.error 出声,指名 p2 terminal(精确匹配 F1 verifyMigrationCandidatesRecoverable 的日志)
      expect(errorSpy).toHaveBeenCalledWith('Persist Boot', expect.stringContaining('createProject p2'))
      expect(
        errorSpy.mock.calls.some((m) => {
          const message = m[1] as string
          return typeof message === 'string' && message.includes('createProject p2') && message.includes('terminally failed')
        }),
      ).toBe(true)
      // stateful server:p1 入,p2 未入
      expect(server.state.projects.map((p) => p.id)).toEqual(['p1'])
    } finally {
      errorSpy.mockRestore()
    }

    // 第二次 boot:stop queue + 清 IDB(保留 marker=null;server.state 保留 [p1])
    stopPersistWriteQueue()
    await __resetWriteQueueDb()
    resetStoreProjects([proj('p1', 'P1'), proj('p2', 'P2')]) // 本地仍 p1/p2(IDB persist rehydrate)
    useCanvasStore.setState({ canvases: {} })
    // marker 仍未种 → 差集重收集;server 已有 p1 → candidates 仅 p2(p1 不重复入队)
    await hydrateFromServer(server.adapter, hydrateOpts)
    expect(useCanvasStore.getState().projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter)
    await flush()
    // p2 二次 POST 200(failProjectOnce 已用尽);p1 不重复入队(计数不增)
    const p1PostsTotal = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects' && (c.body as { id: string }).id === 'p1')
    const p2PostsTotal = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects' && (c.body as { id: string }).id === 'p2')
    expect(p1PostsTotal).toHaveLength(1) // p1 不重排
    expect(p2PostsTotal).toHaveLength(2) // p2:首 boot 400 + 二 boot 200
    // F1:p2 现在服务端 → 全可恢复 → marker 种上
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    expect(server.state.projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })

  it('SC-K: marker 已种 + createProject(p2) 仍 pending 于队列 + 服务端仅 p1 → hydrate replace 含 p2(F2 并集保护,不丢)', async () => {
    // 预种 marker(模拟"曾迁移过的浏览器刷新页面,creates 仍 pending")
    localStorage.setItem('mivo:server-migration:anonymous', 'done')
    // 预置 pending createProject(p2)于 IDB(未 drain;nextAttemptAt 远未来不取,保持 pending 证 F2)
    await __seedWritesForTest([{
      id: 'rec-create-p2-k', idempotencyKey: 'k-create-p2-k', userId: ANONYMOUS_USER_ID,
      op: { kind: 'createProject', name: 'P2', id: 'p2' }, resourceKey: 'project:p2',
      createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending',
    }])
    // 服务端仅 p1(p2 仍 pending 在队列,未 drain 到服务端)
    const server = makeMigrationServer({ projects: [proj('p1', 'P1')] })
    // 本地 p1 + p2(p2 来自 pending create;IDB persist rehydrate 后本地仍在)
    resetStoreProjects([proj('p1', 'P1'), proj('p2', 'P2')])
    useCanvasStore.setState({ canvases: {} })
    // hydrate:marker set → replace 分支;F2 应并集本地 pending-create(p2)→ 不丢
    await hydrateFromServer(server.adapter, hydrateOpts)
    // F2:replace = C 过滤后服务端[p1] ∪ 本地 pending-create[p2] = [p1, p2](无 F2 则丢 p2 = [p1] = 线程4 残根)
    expect(useCanvasStore.getState().projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })

  // ── P1 r5(2026-07-16 二轮终审 P1):partial collection 误种 marker(真实数据永久漏迁)──
  //  复现:本地 real-p1(project)+ real-c1(canvas);step1 listProjects 成功收集 project 候选;step2 listCanvas
  //  瞬断抛(collectionOk=false,c1 未收集);flush >0-op 分支只看 allRecoverable → project drain 成功 → 种 marker
  //  → 下次 boot marker 已种跳迁移 → 未收集的 canvas 永久滞留 local(数据丢失)。修后:>0-op 也要求
  //  collectionOk===true 才种;partial ops 照常 drain(数据能上多少上多少);marker 不种 → 二次 boot 重收集补漏。
  it('P1 r5 ①: step1 ok / step2 listCanvas 一次性抛 → ops 照发但 marker=null;二次 boot 重收集补 canvas 后种', async () => {
    const server = makeMigrationServer({ failListCanvasOnce: true })
    const calls = server.calls
    // 本地:真实 uuid project + canvas(均非 demo → 候选)
    resetStoreProjects([proj('real-p1', 'RealP1')])
    useCanvasStore.setState({ sceneId: '' as never, canvases: { 'real-c1': doc('real-p1', 'RealC1') } as never })
    // boot 1 hydrate:step1 listProjects 成功(收集 real-p1 候选);step2 listCanvas 首调抛 → flag=false,c1 未收集
    await hydrateFromServer(server.adapter, hydrateOpts)
    // boot 1 flush:>0 op(createProject real-p1)→ drain 成功 → allRecoverable=true,但 collectionOk=false → 不种 marker
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter, false) // 显式传 collectionOk=false(镜像 bootPersistWiring 快照)
    await flush()
    // ops 照发:real-p1 已 POST 上 server(数据能上多少上多少);canvas 未收集 → 未 POST
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects').map((c) => (c.body as { id: string }).id)).toEqual(['real-p1'])
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas')).toHaveLength(0)
    // 修前此处 marker='done'(bug → 下次 boot 跳迁移,c1 永久滞留 local);修后 marker=null(下次 boot 重收集补 c1)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBeNull()
    expect(server.state.projects.map((p) => p.id)).toEqual(['real-p1'])
    expect(server.state.canvases.map((c) => c.id)).toEqual([])

    // boot 2:stop queue + 清 IDB(保留 marker=null;server.state 保留 [real-p1])
    stopPersistWriteQueue()
    await __resetWriteQueueDb()
    resetStoreProjects([proj('real-p1', 'RealP1')])
    useCanvasStore.setState({ sceneId: '' as never, canvases: { 'real-c1': doc('real-p1', 'RealC1') } as never })
    // marker 仍未种 → 重收集;listCanvas 二次调成功(failListCanvasOnce 已用尽)→ c1 local-only(server 无)→ 候选;
    //   real-p1 已在服务端 → 不重复入队
    await hydrateFromServer(server.adapter, hydrateOpts)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter, true) // collectionOk=true(本次 list 全成功)
    await flush()
    // c1 补迁上 server;real-p1 不重复入队(计数不增)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas').map((c) => (c.body as { id: string }).id)).toEqual(['real-c1'])
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects').map((c) => (c.body as { id: string }).id)).toEqual(['real-p1'])
    // 全 candidate 可恢复 + collectionOk=true → marker 种
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    expect(server.state.canvases.map((c) => c.id)).toEqual(['real-c1'])
  })

  // P1 r5 ②(反向):step1 listProjects 一次性抛 / step2 listCanvas 成功 → project 未收集(collectionOk=false)
  //   但 canvas 候选已收集。修前 >0-op 分支 canvas drain 成功 → 种 marker → 下次 boot 跳迁移 → project 永久
  //   滞留 local。修后:不种 marker;canvas 照常 drain;二次 boot 重收集补 project 后种。
  it('P1 r5 ②: step1 listProjects 一次性抛 / step2 ok → ops 照发但 marker=null;二次 boot 重收集补 project 后种', async () => {
    const server = makeMigrationServer({ failListProjectsOnce: true })
    const calls = server.calls
    resetStoreProjects([proj('real-p1', 'RealP1')])
    useCanvasStore.setState({ sceneId: '' as never, canvases: { 'real-c1': doc('real-p1', 'RealC1') } as never })
    // boot 1:step1 listProjects 首调抛 → flag=false,project 候选未收集;step2 listCanvas 成功 → canvas 候选收集
    await hydrateFromServer(server.adapter, hydrateOpts)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter, false) // collectionOk=false(step1 抛)
    await flush()
    // canvas 照常 drain 上 server;project 未收集 → 未 POST
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas').map((c) => (c.body as { id: string }).id)).toEqual(['real-c1'])
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects')).toHaveLength(0)
    // 修前 marker='done'(bug → project 永久滞留 local);修后 marker=null
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBeNull()
    expect(server.state.canvases.map((c) => c.id)).toEqual(['real-c1'])
    expect(server.state.projects.map((p) => p.id)).toEqual([])

    // boot 2:real-p1 本地仍在(IDB persist rehydrate);listProjects 二次成功 → real-p1 local-only(server 无)→ 候选;
    //   c1 已在服务端 → 不重复入队
    stopPersistWriteQueue()
    await __resetWriteQueueDb()
    resetStoreProjects([proj('real-p1', 'RealP1')])
    useCanvasStore.setState({ sceneId: '' as never, canvases: { 'real-c1': doc('real-p1', 'RealC1') } as never })
    await hydrateFromServer(server.adapter, hydrateOpts)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter, true) // collectionOk=true
    await flush()
    // real-p1 补迁;c1 不重复入队(计数不增)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects').map((c) => (c.body as { id: string }).id)).toEqual(['real-p1'])
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas').map((c) => (c.body as { id: string }).id)).toEqual(['real-c1'])
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    expect(server.state.projects.map((p) => p.id)).toEqual(['real-p1'])
  })

  // ── P1 (2026-07-16 demo-seed-migration-skip):D2 候选跳过 demo seed + demo scene chat 免噪 ──
  it('P1: local 含 demo project/canvas + 真实 uuid project/canvas,server 空 → 只 enqueue 真实 uuid,demo 跳过(不撞 409/404)', async () => {
    const server = makeMigrationServer()
    const calls = server.calls
    // 本地:demo project(全局稳定 id)+ 真实 uuid project;demo canvas(character-flow)+ 真实 canvas
    resetStoreProjects([
      proj(DEMO_PROJECT_IDS.conceptBattlepass, 'Concept Battlepass'),
      proj('real-proj-1', 'Real Project'),
    ])
    useCanvasStore.setState({
      canvases: {
        'character-flow': doc(DEMO_PROJECT_IDS.conceptBattlepass, 'character-flow'),
        'real-canvas-1': doc('real-proj-1', 'Real Canvas'),
      } as never,
    })
    await hydrateFromServer(server.adapter, hydrateOpts)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter)
    await flush()
    // demo project/canvas 不上迁(不 POST),只 POST 真实 uuid
    const projectPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/projects').map((c) => (c.body as { id: string }).id)
    const canvasPosts = calls.filter((c) => c.method === 'POST' && c.path === '/api/canvas').map((c) => (c.body as { id: string }).id)
    expect(projectPosts.sort()).toEqual(['real-proj-1'])
    expect(canvasPosts.sort()).toEqual(['real-canvas-1'])
    // demo 本地仍可见(union 保留,侧栏种子不丢)
    expect(useCanvasStore.getState().projects.map((p) => p.id)).toContain(DEMO_PROJECT_IDS.conceptBattlepass)
    // 真实 uuid 全成功 → marker 种(P1 后 demo 不再阻塞 marker 收敛)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
    // server 只拿到真实 uuid(demo 未上迁)
    expect(server.state.projects.map((p) => p.id).sort()).toEqual(['real-proj-1'])
    expect(server.state.canvases.map((c) => c.id).sort()).toEqual(['real-canvas-1'])
  })

  it('P1 附加: demo scene 的 chat hydrate 跳过 server(demo canvas 不上迁 → 不再每 boot 404 WARN)', async () => {
    const server = makeMigrationServer()
    const listChatSpy = vi.spyOn(server.adapter, 'listChatMessages')
    // demo scene → hydrateChatForScene early-return,不调 listChatMessages,不打 404 WARN
    await backfillChatAfterDrain('character-flow', server.adapter)
    expect(listChatSpy).not.toHaveBeenCalled()
    // 对照:非 demo scene → 正常调 listChatMessages(不跳过)
    await backfillChatAfterDrain('real-canvas-uuid', server.adapter)
    expect(listChatSpy).toHaveBeenCalledWith('real-canvas-uuid')
  })

  // P1-1:纯 demo 工作区(候选全被 DEMO_PROJECT_ID_SET 滤除)→ 0 op,但收集成功 → flush 种 marker 收敛
  //   (否则每 boot 重收集/过滤/log 刷屏:demo marker 每 boot 为 null)。复审复现:conceptBattlepass +
  //   character-flow only → marker null(修前);修后 marker=done。二次 boot 不再收集(无新 POST)。
  it('P1-1: 纯 demo(无真实 uuid)server 空 → flush 0-op 种 marker(收集 ok);二次 boot 不再收集', async () => {
    const server = makeMigrationServer()
    const calls = server.calls
    // 纯 demo:demo project + demo scene canvases(character-flow/variants 挂 conceptBattlepass;无真实 uuid)
    resetStoreProjects([proj(DEMO_PROJECT_IDS.conceptBattlepass, 'Concept Battlepass')])
    useCanvasStore.setState({
      sceneId: '' as never,
      canvases: {
        'character-flow': doc(DEMO_PROJECT_IDS.conceptBattlepass, 'character-flow'),
        variants: doc(DEMO_PROJECT_IDS.conceptBattlepass, 'variants'),
      } as never,
    })
    await hydrateFromServer(server.adapter, hydrateOpts)
    // 收集后 0 op(demo 全被 DEMO_PROJECT_ID_SET 滤除)+ migrationCollectionOk=true(lists 未抛)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter)
    await flush()
    // demo 不上迁(0 POST);但 marker 必种(0 op + 收集 ok → 收敛;修前此处 null → 每 boot 重收集刷屏)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')

    // 二次 boot:stop queue + 清 IDB(保留 marker;不 __resetPersistBoot 否则清 marker)
    stopPersistWriteQueue()
    await __resetWriteQueueDb()
    resetStoreProjects([proj(DEMO_PROJECT_IDS.conceptBattlepass, 'Concept Battlepass')])
    useCanvasStore.setState({
      sceneId: '' as never,
      canvases: { 'character-flow': doc(DEMO_PROJECT_IDS.conceptBattlepass, 'character-flow') } as never,
    })
    await hydrateFromServer(server.adapter, hydrateOpts)
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter) // marker 已种 → 0-op 跳过 seed(幂等,不重收集)
    await flush()
    // 二次 boot 不再收集:POST 计数不增(仍 0);marker 仍 done
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBe('done')
  })

  // P1-1 收集失败路径:hydrate listProjects 抛 → migrationCollectionOk=false → flush 0-op 不盲种 marker
  //   (失败路径语义不变:不知有无 local-only 候选 → 不种,下次 boot 重试;否则用户数据永久滞留 local)。
  it('P1-1 收集失败: hydrate listProjects 抛 → flush 0-op 不种 marker(失败路径语义不变,下次 boot 重试)', async () => {
    const throwAdapter: ServerPersistAdapter = {
      listProjects: async () => { throw new Error('listProjects boom') },
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
    } as unknown as ServerPersistAdapter
    const server = makeMigrationServer()
    // 纯 demo 本地(marker 未种;listProjects 抛 → 收集不健康 → 不盲种)
    resetStoreProjects([proj(DEMO_PROJECT_IDS.conceptBattlepass, 'Concept BP')])
    useCanvasStore.setState({ sceneId: '' as never, canvases: {} })
    await hydrateFromServer(throwAdapter, hydrateOpts) // listProjects 抛 → step1 catch → migrationCollectionOk=false
    startPersistWriteQueue({ fetch: server.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    await __flushServerMigrationForTest(server.adapter) // 0 op + flag=false → 不种 marker
    await flush()
    // 收集失败 → 不盲种(下次 boot 重试)
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBeNull()
  })

  // P1-3:standalone demo scene(task-states/empty)不在 DEMO_SCENE_PROJECT_MAP(仅 4 grouped),
  //   用完整 DemoSceneId 集合(DEMO_SCENE_ID_SET)判定后也跳过 server chat hydrate(否则每 boot 打 404)。
  //   复审复现场景(task-states/empty 每 boot 404)转正式回归。
  it('P1-3: standalone demo scene(task-states/empty)chat hydrate 也跳过 server(完整 6 scene 覆盖)', async () => {
    const server = makeMigrationServer()
    const listChatSpy = vi.spyOn(server.adapter, 'listChatMessages')
    // task-states/empty:standalone,不在 DEMO_SCENE_PROJECT_MAP(4 grouped)→ 修前漏判 → 调 listChatMessages 404
    await backfillChatAfterDrain('task-states', server.adapter)
    expect(listChatSpy).not.toHaveBeenCalled()
    await backfillChatAfterDrain('empty', server.adapter)
    expect(listChatSpy).not.toHaveBeenCalled()
    // 对照:非 demo scene → 正常调 listChatMessages
    await backfillChatAfterDrain('real-canvas-uuid', server.adapter)
    expect(listChatSpy).toHaveBeenCalledWith('real-canvas-uuid')
  })
})
