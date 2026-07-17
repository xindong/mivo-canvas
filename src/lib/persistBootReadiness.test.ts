// persistBootReadiness.test.ts
// G1-a R2 F3:persist readiness 门控 —— ?persist=server 在默认 memory 后端下不得假持久。
//
// 验收(对齐 finding F3):
//  - fetchPersistReadiness:pg → {durable:true,backend:'pg'};memory → {durable:false,backend:'memory'};
//    fetch 失败/非 2xx/无 persist 字段 → null(fail-closed 哨兵)。
//  - bootPersistWiring(server):memory readiness → 不 start queue(isPersistWriteActive false)、
//    不 hydrate(不触达 /api/projects);pg ready → start queue。
//  - readiness fetch 失败 → fail-closed(不 start)。

import { describe, expect, it, beforeEach, vi } from 'vitest'

// Hermetic setup(同 persistBoot.integration.test.ts):node env 无 DOM/localStorage;canvasStore
// 经 demoScenes→demoImages 在 module load 触发 createDemoImage→document.createElement 炸。装 in-memory
// localStorage + stub demoImage + stub remoteDebugReporter。
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
  const noop = (): void => {}
  const eventTarget = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage, ...eventTarget }
  if (g.localStorage === undefined) g.localStorage = memStorage
  if (g.document === undefined) g.document = { ...eventTarget }
})

// server 模式注入:覆写 persistMode 让 bootPersistWiring 走 server 分支(node 默认 local)。
vi.mock('./persistMode', () => ({
  getPersistMode: () => 'server' as const,
  isLocalPersist: false,
  isServerPersist: true,
  isShadowPersist: false,
  persistMode: 'server' as const,
}))
vi.mock('./demoImages', () => ({ createDemoImage: () => 'data:image/png;base64,mock' }))
vi.mock('../store/remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))

import {
  fetchPersistReadiness,
  bootPersistWiring,
  isPersistWriteActive,
  stopPersistWriteQueue,
  startPersistWriteQueue,
  drainPersistQueue,
  enqueuePersistWrite,
  resumePersistQueue,
  reconcileProjectCanvasStatus,
  __resetPersistBoot,
} from './persistBoot'
import { __resetWriteQueueDb, __dumpWritesForTest } from './writeRetryQueue'
import { useCanvasStore } from '../store/canvasStore'
import { useAuthStore } from '../store/authSlice'
import { setPersistUserId, __resetPersistUserId, ANONYMOUS_USER_ID } from './persistUserId'
import type { FetchAdapterOptions } from './serverPersistAdapter'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })
const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** /healthz 响应 + /api/projects|/api/canvas|/api/user-state 空列表(供 hydrate 不触达真实)。 */
const healthz = (backend: 'pg' | 'memory', durable: boolean) =>
  new Response(JSON.stringify({ status: 'ok', persist: { backend, durable } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const emptyLists = (): Response =>
  new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
  __resetPersistUserId()
  useCanvasStore.setState({ projects: [], canvases: {} })
  useAuthStore.setState({ user: null, status: 'unknown' })
})

describe('G1-a R2 F3 — fetchPersistReadiness 三态 + fail-closed', () => {
  const opts = (fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): FetchAdapterOptions => ({
    fetch: fetchImpl,
    baseUrl: '',
    getAuthHeaders: () => authHeaders(),
  })

  it('pg /healthz → {durable:true, backend:"pg"}', async () => {
    const o = opts(async (input) => {
      expect(input).toBe('/healthz')
      return healthz('pg', true)
    })
    const r = await fetchPersistReadiness(o)
    expect(r).toEqual({ backend: 'pg', durable: true })
  })

  it('memory /healthz → {durable:false, backend:"memory"}', async () => {
    const o = opts(async () => healthz('memory', false))
    const r = await fetchPersistReadiness(o)
    expect(r).toEqual({ backend: 'memory', durable: false })
  })

  it('fetch reject → null(fail-closed)', async () => {
    const o = opts(async () => Promise.reject(new Error('network down')))
    const r = await fetchPersistReadiness(o)
    expect(r).toBeNull()
  })

  it('非 2xx → null(fail-closed)', async () => {
    const o = opts(async () => new Response('err', { status: 503 }))
    const r = await fetchPersistReadiness(o)
    expect(r).toBeNull()
  })

  it('无 persist 字段(旧版 BFF)→ null(fail-closed)', async () => {
    const o = opts(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const r = await fetchPersistReadiness(o)
    expect(r).toBeNull()
  })
})

describe('G1-a R2 F3 — bootPersistWiring(server)durable 门控', () => {
  it('memory readiness → 不 start queue、不 hydrate(0 业务 fetch)', async () => {
    const calls: string[] = []
    const o: FetchAdapterOptions = {
      fetch: async (input) => {
        calls.push(new URL(input, 'http://stub').pathname)
        if (input === '/healthz') return healthz('memory', false)
        return emptyLists()
      },
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await bootPersistWiring(o)
    await flush()
    // 只触达 /healthz,不触达 /api/projects(hydrate 被门控)
    expect(calls).toEqual(['/healthz'])
    expect(isPersistWriteActive()).toBe(false)
  })

  it('pg readiness → start queue(isPersistWriteActive true)', async () => {
    const o: FetchAdapterOptions = {
      fetch: async (input) => {
        if (input === '/healthz') return healthz('pg', true)
        return emptyLists()
      },
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await bootPersistWiring(o)
    await flush()
    expect(isPersistWriteActive()).toBe(true)
  })

  it('readiness fetch 失败 → fail-closed(不 start queue、不 hydrate)', async () => {
    const calls: string[] = []
    const o: FetchAdapterOptions = {
      fetch: async (input) => {
        calls.push(new URL(input, 'http://stub').pathname)
        if (input === '/healthz') return Promise.reject(new Error('down'))
        return emptyLists()
      },
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await bootPersistWiring(o)
    await flush()
    expect(calls).toEqual(['/healthz'])
    expect(isPersistWriteActive()).toBe(false)
  })
})

// ── G1-a R2 F5:paused-401 resume(已认证 boot 自动重放;leftover 记录不再永久卡死)─────
// 验收(对齐 finding F5):
//  - session A 写遇 401 → 队列暂停,记录留存 paused-401(不删)。
//  - session B 已认证 boot → 队列 start 恢复 paused 拒 drain,boot 在已认证场景 resume → 记录自动重放 + 删除。
//  - 未认证 boot → 不 resume,记录仍 paused-401 保留(不重放)。
const userState401 = (): Response =>
  new Response(JSON.stringify({ error: 'require-login' }), { status: 401, headers: { 'content-type': 'application/json' } })
const userState200 = (): Response =>
  new Response(JSON.stringify({ id: 'ui:theme', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })

const sessionFetch = (writeResp: () => Response) => {
  const calls: string[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(new URL(input, 'http://stub').pathname)
    if (input === '/healthz') return healthz('pg', true)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'PUT' && input.startsWith('/api/user-state/')) return writeResp()
    return emptyLists()
  }
  return { fetch, calls }
}

describe('G1-a R2 F5 — paused-401 resume(已认证 boot 自动重放)', () => {
  it('session A 造 paused-401;session B 已认证 boot → 记录自动重放 + 删除', async () => {
    // session A:putUserState 遇 401 → 队列暂停,记录留存 paused-401。
    setPersistUserId('user-A')
    const a = sessionFetch(userState401)
    startPersistWriteQueue({ fetch: a.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useAuthStore.setState({ user: { id: 'user-A', name: 'A', avatar: null }, status: 'authenticated' })
    const enq = enqueuePersistWrite({ kind: 'putUserState', key: 'ui:theme', value: 'dark' })
    await enq
    await flush()
    await drainPersistQueue()
    const afterA = await __dumpWritesForTest()
    expect(afterA.length).toBe(1)
    expect(afterA[0]!.status).toBe('paused-401')
    // session A 结束:停队列实例(IDB 保留 paused-401 记录)。
    stopPersistWriteQueue()
    __resetPersistBoot()

    // session B:replay 返 200;已认证 boot → start 恢复 paused + resume 重放。
    setPersistUserId('user-A')
    const b = sessionFetch(userState200)
    useAuthStore.setState({ user: { id: 'user-A', name: 'A', avatar: null }, status: 'authenticated' })
    await bootPersistWiring({ fetch: b.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    // 重放触达 PUT /api/user-state/ui:theme(key 经 encodeURIComponent → ui%3Atheme)
    expect(b.calls.some((c) => c.startsWith('/api/user-state/ui'))).toBe(true)
    // 记录已删除(成功重放后 drain 删)
    const afterB = await __dumpWritesForTest()
    expect(afterB.length).toBe(0)
  })

  it('未认证 boot → 不 resume,记录仍 paused-401 保留', async () => {
    // seed paused-401 via session A
    setPersistUserId('user-A')
    const a = sessionFetch(userState401)
    startPersistWriteQueue({ fetch: a.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useAuthStore.setState({ user: { id: 'user-A', name: 'A', avatar: null }, status: 'authenticated' })
    await (enqueuePersistWrite({ kind: 'putUserState', key: 'ui:theme', value: 'dark' }) ?? Promise.resolve())
    await flush()
    await drainPersistQueue()
    stopPersistWriteQueue()
    __resetPersistBoot()

    // session B 未认证:boot durable 但 auth=unauthenticated → 不 resume
    setPersistUserId(ANONYMOUS_USER_ID) // 未登录 → anonymous 命名空间
    useAuthStore.setState({ user: null, status: 'unauthenticated' })
    const b = sessionFetch(userState200)
    await bootPersistWiring({ fetch: b.fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    await flush()
    // 不重放(未认证,user-A 的 paused-401 不被 anonymous 命名空间触达)
    expect(b.calls.some((c) => c.startsWith('/api/user-state/ui'))).toBe(false)
    const after = await __dumpWritesForTest()
    expect(after.length).toBe(1)
    expect(after[0]!.status).toBe('paused-401')
  })

  it('resumePersistQueue 已导出且未启动队列时 no-op(不抛)', async () => {
    __resetPersistBoot()
    await expect(resumePersistQueue()).resolves.toBeUndefined()
  })
})

// ── G1-a R2 F2:standalone canvas 在 server 模式强制归 project(不再 projectId='' → 404)─────
// 验收(对齐 finding F2 子项2):server 模式 createCanvas 无显式 projectId → enqueue 的 createCanvas op
// 带 projects[0].id(非 ''),防 POST /api/canvas 空 projectId 走 unknown-project 404 被队列当 rejected 删。
describe('G1-a R2 F2 — server 模式 standalone canvas 强制归 project', () => {
  it('createCanvas 无 projectId → enqueue op.projectId = projects[0].id(非空)', async () => {
    useCanvasStore.setState({ projects: [{ id: 'p1', name: 'P1', createdAt: 't' }] as never })
    // start queue 让 enqueue 落 IDB(便于 dump op);fetch stub 仅 readiness 不触达(createCanvas 入队即停)
    startPersistWriteQueue({ fetch: async () => healthz('pg', true), baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.getState().createCanvas('Untitled Canvas')
    await flush()
    const recs = await __dumpWritesForTest()
    const createOp = recs.find((r) => r.op.kind === 'createCanvas')
    expect(createOp).toBeDefined()
    expect((createOp!.op as { projectId: string }).projectId).toBe('p1')
  })

  it('createCanvas 显式 projectId → 用显式值(不强覆盖)', async () => {
    useCanvasStore.setState({ projects: [{ id: 'p1', name: 'P1', createdAt: 't' }, { id: 'p2', name: 'P2', createdAt: 't' }] as never })
    startPersistWriteQueue({ fetch: async () => healthz('pg', true), baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.getState().createCanvas('T', { projectId: 'p2' })
    await flush()
    const recs = await __dumpWritesForTest()
    const createOp = recs.find((r) => r.op.kind === 'createCanvas')
    expect((createOp!.op as { projectId: string }).projectId).toBe('p2')
  })
})

describe('P1-3(返修):reconcileProjectCanvasStatus — fresh-device unarchiveProject 后用 server status reconcile 子画布', () => {
  // 跨设备 hydrate:client archivedByCascade=undefined(wire 不回传 provenance)→ 乐观 unarchiveProject 后
  //   undefined 的全留 archived(client 持久错误态:project active 但 cascade 子画布仍 archived)。
  //   reconcile 拉 includeArchived canvas meta 用 server 权威:server unarchiveProjectTree 已恢复 cascade 子画布
  //   (active)、保留 direct(archived)。不猜 provenance(防 client 误恢复 direct / 误留 cascade)。
  //   client 态用 createCanvas 建 valid CanvasDocument(免触发 persist middleware 的 compactCanvasesForPersist
  //   读 undefined.nodes.map 崩),再 setState 标 archived 模拟 fresh-device 错误态。
  type AdapterLike = NonNullable<Parameters<typeof reconcileProjectCanvasStatus>[1]>
  type CanvasLike = { status?: string; id?: string }

  /** 建 2 个 valid client canvas(createCanvas 产 valid doc)+ 标双 archived 模拟 fresh-device 错误态。返两 id。 */
  const seedTwoArchivedChildren = (projectId: string): { cascadeId: string; directId: string } => {
    useCanvasStore.setState({ projects: [{ id: projectId, name: 'P1', createdAt: 't' }] as never })
    useCanvasStore.getState().createCanvas('cascade', { projectId })
    useCanvasStore.getState().createCanvas('direct', { projectId })
    const state = useCanvasStore.getState()
    const ids = Object.keys(state.canvases)
    const cascadeId = ids[0]!
    const directId = ids[1]!
    const canvases = state.canvases as Record<string, CanvasLike>
    useCanvasStore.setState({
      canvases: {
        ...state.canvases,
        [cascadeId]: { ...canvases[cascadeId]!, status: 'archived' },
        [directId]: { ...canvases[directId]!, status: 'archived' },
      } as never,
    })
    return { cascadeId, directId }
  }

  it('cascade 子画布(server active)→ client reconcile active;direct 子画布(server archived)→ 保留 archived(不强制恢复)', async () => {
    const { cascadeId, directId } = seedTwoArchivedChildren('p1')
    // server 权威:unarchiveProjectTree 恢复 cascade(active),保留 direct(archived)
    const fakeAdapter = {
      listCanvas: async () => ({ canvases: [{ id: cascadeId, status: 'active' }, { id: directId, status: 'archived' }] }),
    } as unknown as AdapterLike
    await reconcileProjectCanvasStatus('p1', fakeAdapter)
    const canvases = useCanvasStore.getState().canvases as Record<string, CanvasLike>
    expect(canvases[cascadeId]?.status).toBe('active') // cascade → reconcile active(server 权威恢复)
    expect(canvases[directId]?.status).toBe('archived') // direct → 保留 archived(server 仍 archived,不动)
  })

  it('本地无此 canvas(server 有但 client 未 hydrate content)→ 不动(不创 ghost);下轮 hydrate 补', async () => {
    useCanvasStore.setState({
      projects: [{ id: 'p1', name: 'P1', createdAt: 't' }] as never,
      canvases: {} as never, // 本地无 canvas
    })
    const fakeAdapter = {
      listCanvas: async () => ({ canvases: [{ id: 'cX', status: 'active' }] }),
    } as unknown as AdapterLike
    await reconcileProjectCanvasStatus('p1', fakeAdapter)
    const canvases = useCanvasStore.getState().canvases as Record<string, unknown>
    expect(Object.keys(canvases)).toHaveLength(0) // 不创 ghost(本地无 → 不动)
  })

  it('reconcile 失败(adapter throw)→ best-effort 不抛(下轮 hydrate 再 reconcile);client 态不动', async () => {
    const { cascadeId } = seedTwoArchivedChildren('p1')
    const fakeAdapter = {
      listCanvas: async () => { throw new Error('network down') },
    } as unknown as AdapterLike
    await expect(reconcileProjectCanvasStatus('p1', fakeAdapter)).resolves.toBeUndefined() // best-effort 不抛
    const canvases = useCanvasStore.getState().canvases as Record<string, CanvasLike>
    expect(canvases[cascadeId]?.status).toBe('archived') // 失败 → client 不动(下轮 hydrate 再 reconcile)
  })

  it('P2-1(二审 TOCTOU):reconcile GET 在途时用户再 archiveProject → store project 翻 archived → 守卫跳过(不覆回 active,防撤销新 archive)', async () => {
    const { cascadeId } = seedTwoArchivedChildren('p1') // fresh-device:cascade 子画布 archived
    // fake adapter.listCanvas 在返回前模拟用户 archiveProject(乐观 set project archived)→ 触发 TOCTOU
    const fakeAdapter = {
      listCanvas: async () => {
        // GET 在途时用户 archiveProject(setState project archived,模拟 archiveProject action 同步置)
        useCanvasStore.setState({ projects: [{ id: 'p1', name: 'P1', createdAt: 't', status: 'archived' }] as never })
        return { canvases: [{ id: cascadeId, status: 'active' }] } // 旧 GET(server unarchiveProjectTree 已恢复 cascade)
      },
    } as unknown as AdapterLike
    await reconcileProjectCanvasStatus('p1', fakeAdapter)
    // 守卫:project archived(GET 在途时被用户 archive)→ 跳过 reconcile(不用旧 GET 覆回 active,防撤销新 archive)
    const canvases = useCanvasStore.getState().canvases as Record<string, CanvasLike>
    expect(canvases[cascadeId]?.status).toBe('archived') // 未被旧 GET 覆回 active(守卫跳过 stale reconcile)
  })
})
