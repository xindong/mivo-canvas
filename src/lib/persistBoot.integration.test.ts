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
  getHydratedUserState,
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
