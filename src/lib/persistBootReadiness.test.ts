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
