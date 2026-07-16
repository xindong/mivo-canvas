// persistBoot.snapshotRace.test.ts
// P1 r6(2026-07-16 三轮终审 P1):collectionOk 快照时机 —— start() drain 内 onConflict rehydrate
// 覆写 module-global migrationCollectionOk=true;bootPersistWiring 必须用 start **之前**的快照(false)
// 传入 flushServerMigration,不得在 start 之后复读 module-global(被覆写为 true)。
//
// 修前(读 global):行 1170 读到 rehydrate 覆写的 true → flush >0-op 分支 allRecoverable && collectionOk=true
//   → 种 marker('done')→ 下次 boot marker 已种跳迁移 → 未收集侧(canvas,step2 抛致未收集)永久滞留 local
//   (真实数据丢失)。
// 修后(读快照):行 1170 传 collectionOkSnapshot=false(本次 boot partial 真值)→ flush 不种 marker
//   → 下次 boot 重收集补漏(canvas 侧)。
//
// 复审确定性复现(照 lead 规格):预置 2 条 stale updateProject(baseRevision=0,due pending)→
//   start() immediate drain 各撞 PATCH /api/projects/:id 409 → onConflict fire `void hydrateFromServer()`
//   (rehydrate)。rehydrate 用同一 fake adapter(failListCanvasOnce:boot 首调 listCanvas 抛 → partial;
//   rehydrate 二次调成功)→ 行 661 乐观置 global=true 且 list 全成功 → stays true。
//   时序确定性(barrier,非微任务余量假设):onConflict 在 drain 行 1950 同步 fire rehydrate;rehydrate 行 661
//   置 global=true 后调 listProjects(第 2 次)→ fake adapter resolve rehydrateStarted;第 2 条 PATCH(stale-2)
//   在返回 409 前 await rehydrateStarted → start()(await drain)不可能在 global=true 之前返回 → 行 1176 flush
//   必读到 global=true(修前 bug)。不再依赖"2 条 stale + recordTerminal/deleteWrite await 让微任务余量"假设——
//   未来 dynamic import/调度变化致 rehydrate 晚于 drain 完成时旧实现也读 false → marker=null → 断言假绿;barrier 杜绝。
//   双向自证:r6 快照 false → marker=null → PASS;r5(797ddf9)复读 global=true → marker='done' → FAIL(expected null)。

import { describe, expect, it, beforeEach, vi } from 'vitest'

// Hermetic setup(同 persistBootReadiness.test.ts):node env 无 DOM/localStorage;canvasStore 经
// demoScenes→demoImages 在 module load 触发 createDemoImage→document.createElement 炸。装 in-memory
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

// server 模式注入:覆写 persistMode 让 bootPersistWiring 走 server 分支(node 默认 local → 第一行 return)。
vi.mock('./persistMode', () => ({
  getPersistMode: () => 'server' as const,
  isLocalPersist: false,
  isServerPersist: true,
  isShadowPersist: false,
  persistMode: 'server' as const,
}))
vi.mock('./demoImages', () => ({ createDemoImage: () => 'data:image/png;base64,mock-demo-image' }))
vi.mock('../store/remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))

// 关键:覆写 serverPersistAdapterSelector —— bootPersistWiring 用 getServerPersistAdapter() 取 adapter(行 1159);
// onConflict 的 `void hydrateFromServer()` 默认参也取 getServerPersistAdapter()(行 650 默认)。两处都读
// adapterHolder.current → boot hydrate 与 rehydrate 共用同一 fake adapter(state 共享 + failListCanvasOnce)。
const adapterHolder = vi.hoisted(() => ({ current: null as ServerPersistAdapter | null }))
vi.mock('./serverPersistAdapterSelector', () => ({
  getServerPersistAdapter: () => adapterHolder.current,
  __resetServerPersistAdapterSelector: () => { adapterHolder.current = null },
  persistMode: 'server' as const,
}))

import { useCanvasStore } from '../store/canvasStore'
import { useAuthStore } from '../store/authSlice'
import { bootPersistWiring, __resetPersistBoot } from './persistBoot'
import { __resetWriteQueueDb, __seedWritesForTest } from './writeRetryQueue'
import { setPersistUserId, __resetPersistUserId, ANONYMOUS_USER_ID } from './persistUserId'
import type { ServerPersistAdapter } from './serverPersistAdapter'
import type { Project, CanvasMeta } from '../../shared/persist-contract.ts'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })
const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

const healthz = (): Response =>
  new Response(JSON.stringify({ status: 'ok', persist: { backend: 'pg', durable: true } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

const proj = (id: string, name: string): Project => ({
  id, name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false,
})

/**
 * fake adapter + 共享 state fetch:adapter.listProjects/listCanvas 读 state;fetch POST /api/projects|canvas
 * 写 state(让 flush 的 verifyMigrationCandidatesRecoverable 能在 drain 后见到 candidate 已上 server →
 * allRecoverable=true,使 collectionOk 成为唯一 marker-seed 阻断项,干净区分快照修复)。
 * failListCanvasOnce:首调 listCanvas 抛(boot hydrate step2 → partial collection,migrationCollectionOk=false);
 *   二次调成功(rehydrate → 行 661 置 true 且 list 全成功 stays true)。
 * fetch PATCH /api/projects/* → 409(stale updateProject 触发 onConflict rehydrate)。
 */
const makeServer = (opts: { failListCanvasOnce?: boolean } = {}): {
  adapter: ServerPersistAdapter
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  state: { projects: Project[]; canvases: CanvasMeta[] }
  listProjectsCalls: number
} => {
  const state = { projects: [] as Project[], canvases: [] as CanvasMeta[] }
  let listCanvasFailed = false
  // 显式 barrier(lead 规格,防假绿):rehydrate 在 hydrateFromServer 行 661 置 migrationCollectionOk=true 之后
  //   才调 listProjects(第 2 次;boot hydrate 是第 1 次)。第 2 次 listProjects → resolve rehydrateStarted;
  //   第 2 条 PATCH 在返回 409 前 await rehydrateStarted → start()(await drain)不可能在 global=true 之前返回。
  //   消除旧实现靠"2 条 stale + recordTerminal/deleteWrite 的 await 让微任务余量"的时序假设——未来 dynamic
  //   import/调度变化致 rehydrate 晚于 drain 完成时,旧实现也读 false → marker=null → 断言假绿;barrier 后不再假绿。
  let listProjectsCalls = 0
  let resolveRehydrateStarted!: () => void
  const rehydrateStarted = new Promise<void>((r) => { resolveRehydrateStarted = r })
  const adapter: ServerPersistAdapter = {
    listProjects: async () => {
      listProjectsCalls++
      // 第 2 次调用 = onConflict rehydrate 的 listProjects(此时已越过 hydrateFromServer 行 661 置 global=true)。
      //   resolve barrier → 放行第 2 条 PATCH 的 409,使 start() 返回前 global 必为 true。
      if (listProjectsCalls === 2) resolveRehydrateStarted()
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
  let patchCalls = 0
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(input, 'http://stub').pathname
    if (method === 'PATCH' && path.startsWith('/api/projects/')) {
      patchCalls++
      // 第 1 条 PATCH(stale-1):立即 409 → drain 同步 fire onConflict `void hydrateFromServer()`(rehydrate 开始;
      //   rehydrate 行 661 置 global=true 后调 listProjects 第 2 次 → resolve rehydrateStarted)。
      // 第 2 条 PATCH(stale-2):await rehydrateStarted 后才返回 409 → 保证 start()(await drain)返回前 global 已 true
      //   (r5 旧实现复读 global=true → 种 marker='done' → 测试 FAIL;r6 用快照 false → 不种 → PASS)。双向自证非假绿。
      if (patchCalls === 2) await rehydrateStarted
      return new Response(JSON.stringify({ error: 'revision-conflict', currentRevision: 9 }), { status: 409, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && path === '/api/projects') {
      const b = JSON.parse(init?.body as string) as { id: string; name: string }
      if (!state.projects.some((p) => p.id === b.id)) {
        state.projects.push({ id: b.id, name: b.name, ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 1, isDeleted: false })
      }
      return new Response(JSON.stringify({ id: b.id, name: b.name, revision: 1, ownerId: KEY_A, createdAt: 't', updatedAt: 't', isDeleted: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && path === '/api/canvas') {
      const b = JSON.parse(init?.body as string) as { id: string; projectId: string; title?: string }
      if (!state.canvases.some((c) => c.id === b.id)) {
        state.canvases.push({ id: b.id, projectId: b.projectId, title: b.title ?? '', createdAt: 't', updatedAt: 't', metaRevision: 1, contentVersion: 0 })
      }
      return new Response(JSON.stringify({ id: b.id, projectId: b.projectId, title: b.title ?? '', metaRevision: 1, contentVersion: 0, createdAt: 't', updatedAt: 't' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'DELETE') return new Response(null, { status: 204 })
    // GET /api/user-state(boot hydrate step3 经 opts.fetch)→ 空 entries(rehydrate step3 经 real fetch 失败被 catch,不影响 global)
    if (path.startsWith('/api/user-state')) {
      return new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { adapter, fetch, state, get listProjectsCalls() { return listProjectsCalls } }
}

beforeEach(async () => {
  __resetPersistBoot()
  await __resetWriteQueueDb()
  __resetPersistUserId()
  adapterHolder.current = null
  useCanvasStore.setState({ projects: [], canvases: {}, sceneId: '' as never })
  useAuthStore.setState({ user: null, status: 'unknown' })
})

describe('P1 r6 三轮终审 — collectionOk 快照时机(onConflict rehydrate 覆写 global 不致误种 marker)', () => {
  it('原 boot partial(step2 listCanvas 抛)+ start drain 撞 409 rehydrate 覆写 global=true → flush 用快照 false → marker=null(修前 done)', async () => {
    const server = makeServer({ failListCanvasOnce: true })
    adapterHolder.current = server.adapter
    setPersistUserId(ANONYMOUS_USER_ID)
    // 本地:真实 uuid project + canvas(均非 demo → 候选)。real-p1 会被 boot hydrate step1 收集为 createProject 候选;
    //   real-c1 在 step2 listCanvas 抛时未收集(partial)。sceneId='' 跳 step 2.5/4(fetchCanvas/chat hydrate 不触达)。
    useCanvasStore.setState({
      projects: [proj('real-p1', 'RealP1')],
      canvases: { 'real-c1': { title: 'RealC1', projectId: 'real-p1', createdAt: 't', updatedAt: 't', nodes: [], edges: [], tasks: [] } as never },
      sceneId: '' as never,
    })
    // 预置 2 条 stale updateProject(baseRevision=0,due pending)→ start() immediate drain 各撞 PATCH 409 → onConflict rehydrate
    await __seedWritesForTest([
      { id: 'stale-1', idempotencyKey: 'k-stale-1', userId: ANONYMOUS_USER_ID, op: { kind: 'updateProject', projectId: 'pY', name: 'pY', baseRevision: 0 }, resourceKey: 'project:pY', createdAt: 0, attempts: 0, nextAttemptAt: 0, status: 'pending' },
      { id: 'stale-2', idempotencyKey: 'k-stale-2', userId: ANONYMOUS_USER_ID, op: { kind: 'updateProject', projectId: 'pZ', name: 'pZ', baseRevision: 0 }, resourceKey: 'project:pZ', createdAt: 1, attempts: 0, nextAttemptAt: 0, status: 'pending' },
    ])
    const o = {
      fetch: async (input: string, init?: RequestInit): Promise<Response> => {
        if (input === '/healthz') return healthz()
        return server.fetch(input, init)
      },
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    }
    await bootPersistWiring(o)
    await flush(20) // 让 fire-and-forget rehydrate 完全落地(失败亦落地;marker 决策已在 bootPersistWiring 行 1176 flush 完成)
    // 修前(r5):flush 收到 global=true(rehydrate 覆写)→ allRecoverable && collectionOk → 种 marker='done'(bug)
    // 修后(r6):flush 收到快照=false(boot partial 真值)→ 不种 marker → 下次 boot 重收集补 canvas
    expect(localStorage.getItem('mivo:server-migration:anonymous')).toBeNull()
    // barrier 落点核证:rehydrate 的 listProjects(第 2 次)确被调 → rehydrateStarted 已 resolve → start() 返回前
    //   global 必已=true(barrier 生效,非微任务余量巧合)。boot hydrate 第 1 次 + rehydrate 第 2 次 + flush 的
    //   verifyMigrationCandidates 第 3 次 → ≥ 2;双向自证依赖第 2 次达 global=true 才让 r5 FAIL、r6 PASS。
    expect(server.listProjectsCalls).toBeGreaterThanOrEqual(2)
    // real-p1 的 createProject op 照常 drain 上 server(partial 数据能上多少上多少;combineOps 去重无重复 POST)
    expect(server.state.projects.map((p) => p.id)).toContain('real-p1')
  })
})
