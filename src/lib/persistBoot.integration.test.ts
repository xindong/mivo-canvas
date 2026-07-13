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
import { enqueueChatAppend } from '../store/chatPersistSync'
import {
  drainPersistQueue,
  startPersistWriteQueue,
  stopPersistWriteQueue,
  __resetPersistBoot,
  hydrateFromServer,
  shadowCompareWithServer,
  getHydratedUserState,
  getChatOrderRevision,
  backfillChatAfterDrain,
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
    useCanvasStore.getState().deleteProject(pidA)
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
    useCanvasStore.getState().deleteProject(pid)
    await flush()
    await drainPersistQueue()
    // P1-2:无 survivor → 阻止删除(project + canvas 仍在,sceneId 不变,无 DELETE 入队)
    expect(useCanvasStore.getState().projects.find((p) => p.id === pid)).toBeDefined()
    expect(useCanvasStore.getState().canvases[c1]).toBeDefined()
    expect(useCanvasStore.getState().sceneId).toBe(c1)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/projects/${encodeURIComponent(pid)}`)).toBe(false)
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/canvas/${encodeURIComponent(c1)}`)).toBe(false)
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
