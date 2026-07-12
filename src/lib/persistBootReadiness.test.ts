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
  __resetPersistBoot,
} from './persistBoot'
import { __resetWriteQueueDb } from './writeRetryQueue'
import { useCanvasStore } from '../store/canvasStore'
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
  useCanvasStore.setState({ projects: [], canvases: {} })
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
