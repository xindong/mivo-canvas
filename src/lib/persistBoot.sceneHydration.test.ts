// persistBoot.sceneHydration.test.ts
// A2-S3 block 8:scene 切换 re-hydrate —— server 模式切画布触发对新 scene 的 full-content fetch。
//
// 验收(对齐 lead task block 8 / e2e 4.2 bug):
//  ① server 模式:boot readiness durable 后,用户点侧栏切到另一张 server 画布 → 对新 scene 调
//     adapter.fetchCanvas(补 content)。修前:boot 只对"开机时 active 的 scene"调一次
//     hydrateActiveCanvasContent,切走后无任何路径触发 fetch → store sceneId 切但 nodesLength=0。
//  ② 同 scene 会话内去重:已 hydrate 的 sceneId 不重复 fetch(切走再切回不双拉);in-flight 防并发。
//  ③ local(默认)模式零行为变化:boot 后切 scene 零 fetchCanvas 请求(订阅不启动)。
//
// 端到端经 bootPersistWiring(readiness 门控 + hydrate + 订阅启动);fake adapter 注入断言 fetchCanvas。

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

// 动态 persistMode(beforeEach 切 server/local)。persistBoot 静态 import 的 isLocalPersist/getPersistMode
// 经 getter live 读,bootPersistWiring 调用时按当前 mode 分派(local 第一行 return;server/shadow 走订阅)。
const persistState = vi.hoisted(() => ({ mode: 'server' as 'local' | 'server' | 'shadow' }))
vi.mock('./persistMode', () => ({
  getPersistMode: () => persistState.mode,
  get isLocalPersist() { return persistState.mode === 'local' },
  get isServerPersist() { return persistState.mode === 'server' },
  get isShadowPersist() { return persistState.mode === 'shadow' },
  persistMode: persistState.mode,
}))

// fake adapter 注入:getServerPersistAdapter 返 fake(fetchCanvas = vi.fn spy),断言调用。
const adapterHolder = vi.hoisted(() => ({ adapter: null as null | ServerPersistAdapter }))
vi.mock('./serverPersistAdapterSelector', () => ({
  getServerPersistAdapter: () => adapterHolder.adapter,
  __resetServerPersistAdapterSelector: () => { adapterHolder.adapter = null },
  persistMode: persistState.mode,
}))

vi.mock('./demoImages', () => ({ createDemoImage: () => 'data:image/png;base64,mock' }))
vi.mock('../store/remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))

import {
  bootPersistWiring,
  stopPersistWriteQueue,
  enqueuePersistWrite,
  drainPersistQueue,
  __resetPersistBoot,
} from './persistBoot'
import { __resetWriteQueueDb } from './writeRetryQueue'
import { useCanvasStore } from '../store/canvasStore'
import { useAuthStore } from '../store/authSlice'
import { setPersistUserId, __resetPersistUserId } from './persistUserId'
import type { ServerPersistAdapter } from './serverPersistAdapter'
import type { CanvasDocument } from '../types/mivoCanvas'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })
const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

const healthzPg = (): Response =>
  new Response(JSON.stringify({ status: 'ok', persist: { backend: 'pg', durable: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const emptyUserState = (): Response =>
  new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } })

/** boot opts:readiness /healthz=pg durable + /api/user-state 空 map(hydrateUserStateMap 不触达真实)。 */
const bootOpts = () => ({
  fetch: async (input: string): Promise<Response> => {
    if (input === '/healthz') return healthzPg()
    if (input.startsWith('/api/user-state')) return emptyUserState()
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  },
  baseUrl: '',
  getAuthHeaders: () => authHeaders(),
})

const blankCanvas = (id: string): CanvasDocument => ({
  id,
  title: id,
  projectId: undefined,
  createdAt: 't',
  updatedAt: 't',
  metaRevision: 0,
  contentVersion: 0,
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeId: null,
  selectedNodeIds: [],
} as unknown as CanvasDocument)

/** fake fetchCanvas 响应:空 content(nodes/edges/anchors 空 → storeCanvasCursor/R-7 merge 不 throw)。 */
const fakeFetchCanvasResp = (id: string) => ({
  id,
  projectId: 'p1',
  title: id,
  createdAt: 't',
  updatedAt: 't',
  metaRevision: 0,
  contentVersion: 0,
  sinceSeq: 0,
  nodes: [],
  edges: [],
  anchors: [],
})

const makeFakeAdapter = (fetchCanvasSpy: ReturnType<typeof vi.fn>): ServerPersistAdapter => ({
  listProjects: async () => ({ projects: [] }),
  listCanvas: async () => ({ canvases: [] }),
  fetchCanvas: fetchCanvasSpy,
  listChatMessages: async () => ({ messages: [], orderRevision: 0 }),
} as unknown as ServerPersistAdapter)

let fetchCanvasSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
  __resetPersistUserId()
  persistState.mode = 'server'
  fetchCanvasSpy = vi.fn(async (id: string) => fakeFetchCanvasResp(id))
  adapterHolder.adapter = makeFakeAdapter(fetchCanvasSpy)
  useCanvasStore.setState({ projects: [], canvases: {}, sceneId: 'sceneA' })
  useAuthStore.setState({ user: null, status: 'unknown' })
})

describe('A2-S3 block 8 — server 模式切 scene re-hydrate(对新 scene 调 fetchCanvas)', () => {
  it('① boot 后切到另一张 server 画布 → 对新 scene 调 fetchCanvas(补 content)', async () => {
    persistState.mode = 'server'
    useCanvasStore.setState({
      sceneId: 'sceneA',
      canvases: {
        sceneA: blankCanvas('sceneA'),
        sceneB: blankCanvas('sceneB'),
      },
    })
    await bootPersistWiring(bootOpts())
    await flush()
    // boot 已对 active sceneA 调 fetchCanvas(hydrateFromServer step 2.5;55dcad8 既有行为)
    expect(fetchCanvasSpy).toHaveBeenCalledWith('sceneA')
    // 清 spy 计数,聚焦"切 scene 触发"的断言
    fetchCanvasSpy.mockClear()
    // 切到 sceneB(用户点侧栏 CanvasRow → loadScene;修前此处无路径触发 fetch)
    useCanvasStore.getState().loadScene('sceneB')
    await flush()
    // 切 scene 触发对新 sceneB 的 fetchCanvas(block 8 核心行为;修前 0 调用)
    expect(fetchCanvasSpy).toHaveBeenCalledWith('sceneB')
  })

  it('② 同 scene 会话内去重:切走再切回不重复 fetch(已 hydrate 的 sceneId 不双拉)', async () => {
    persistState.mode = 'server'
    useCanvasStore.setState({
      sceneId: 'sceneA',
      canvases: {
        sceneA: blankCanvas('sceneA'),
        sceneB: blankCanvas('sceneB'),
      },
    })
    await bootPersistWiring(bootOpts())
    await flush()
    // 切到 sceneB → fetchCanvas sceneB(首次 hydrate)
    useCanvasStore.getState().loadScene('sceneB')
    await flush()
    expect(fetchCanvasSpy).toHaveBeenCalledWith('sceneB')
    const callsAfterFirstSwitch = fetchCanvasSpy.mock.calls.length
    // 切回 sceneA(sceneA boot 已 hydrate → 去重,不重复 fetch)
    useCanvasStore.getState().loadScene('sceneA')
    await flush()
    // 切回 sceneB(sceneB 刚已 hydrate → 去重,不重复 fetch)
    useCanvasStore.getState().loadScene('sceneB')
    await flush()
    // 切走再切回期间无新增 fetchCanvas 调用(去重生效;in-flight 防并发双拉)
    expect(fetchCanvasSpy.mock.calls.length).toBe(callsAfterFirstSwitch)
  })

  it('③ local(默认)模式:boot 后切 scene 零 fetchCanvas 请求(订阅不启动,零行为变化)', async () => {
    persistState.mode = 'local'
    useCanvasStore.setState({
      sceneId: 'sceneA',
      canvases: {
        sceneA: blankCanvas('sceneA'),
        sceneB: blankCanvas('sceneB'),
      },
    })
    // local 模式 bootPersistWiring 第一行 return(isLocalPersist=true)→ 不启动订阅
    await bootPersistWiring(bootOpts())
    await flush()
    // 切 scene(用户点侧栏)
    useCanvasStore.getState().loadScene('sceneB')
    await flush()
    // local 模式零行为变化:不发任何 fetchCanvas 请求(订阅未启动)
    expect(fetchCanvasSpy).not.toHaveBeenCalled()
  })

  it('④ shadow 模式:boot 后切 scene 零 fetchCanvas 调用(shadow 恒不 populate,IDB 读源契约;切 scene re-hydrate 仅 server)', async () => {
    persistState.mode = 'shadow'
    useCanvasStore.setState({
      sceneId: 'sceneA',
      canvases: {
        sceneA: blankCanvas('sceneA'),
        sceneB: blankCanvas('sceneB'),
      },
    })
    // shadow 模式 bootPersistWiring:readiness durable → shadowCompareWithServer + startPersistWriteQueue,
    // 但不启动 scene 切换订阅(shadow 恒不 populate canvas content,IDB 读源契约;A3 灰度观察窗前提)。
    await bootPersistWiring(bootOpts())
    await flush()
    // 切 scene(用户点侧栏)
    useCanvasStore.getState().loadScene('sceneB')
    await flush()
    // shadow 模式零 fetchCanvas 请求(切 scene re-hydrate 仅 server 模式;shadow 不订阅;
    // shadowCompareWithServer 的 listProjects 请求走 adapter 非 fetchCanvas,不算)
    expect(fetchCanvasSpy).not.toHaveBeenCalled()
  })

  it('⑤ shadow onConflict(mock 409)零 fetchCanvas(mode gate 跳过 step 2.5);server onConflict 仍补 content(gate 不跳过,正例)', async () => {
    const conflict409 = (): Response =>
      new Response(JSON.stringify({ error: 'revision-conflict', currentRevision: 0 }), { status: 409, headers: { 'content-type': 'application/json' } })
    // opts:GET /healthz=pg / GET /api/user-state=空 map / PUT /api/user-state/*=409(撞 conflict → onConflict)
    const opts409 = () => ({
      fetch: async (input: string, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (input === '/healthz') return healthzPg()
        if (input.startsWith('/api/user-state')) {
          if (method === 'GET') return emptyUserState()
          return conflict409()
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
      },
      baseUrl: '',
      getAuthHeaders: () => authHeaders(),
    })

    // ── shadow:onConflict → step 2.5 mode gate 跳过 → 0 fetchCanvas(不变量:shadow 恒不 populate) ──
    persistState.mode = 'shadow'
    useCanvasStore.setState({ sceneId: 'sceneA', canvases: { sceneA: blankCanvas('sceneA') } })
    setPersistUserId('user-A')
    await bootPersistWiring(opts409())
    await flush()
    fetchCanvasSpy.mockClear()
    await (enqueuePersistWrite({ kind: 'putUserState', key: 'ui:theme', value: 'dark' }) ?? Promise.resolve())
    await flush()
    await drainPersistQueue()
    await flush(50) // 等 onConflict 的 hydrateFromServer(void fire-and-forget)完成
    // shadow:canvas content 不 populate(mode gate 跳过 step 2.5)→ 0 fetchCanvas
    expect(fetchCanvasSpy).not.toHaveBeenCalled()

    // ── server 正例:onConflict → step 2.5 gate 不跳过 → 补 content(权威源正确) ──
    stopPersistWriteQueue()
    __resetPersistBoot()
    await __resetWriteQueueDb()
    persistState.mode = 'server'
    // boot fetchCanvas 返 null(canvas 不存在 → applied false → 不记 hydrated);
    // onConflict 第二次返正常 resp(补 content,证 step 2.5 gate 不跳过 server)
    fetchCanvasSpy = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(fakeFetchCanvasResp('sceneA'))
    adapterHolder.adapter = makeFakeAdapter(fetchCanvasSpy)
    useCanvasStore.setState({ sceneId: 'sceneA', canvases: { sceneA: blankCanvas('sceneA') } })
    useAuthStore.setState({ user: null, status: 'unknown' })
    setPersistUserId('user-A')
    await bootPersistWiring(opts409())
    await flush()
    expect(fetchCanvasSpy).toHaveBeenCalledWith('sceneA') // boot step 2.5 fetchCanvas sceneA → null
    fetchCanvasSpy.mockClear()
    await (enqueuePersistWrite({ kind: 'putUserState', key: 'ui:theme', value: 'dark' }) ?? Promise.resolve())
    await flush()
    await drainPersistQueue()
    await flush(50)
    // server:onConflict → step 2.5 gate 不跳过 → sceneA 未 hydrated(boot null)→ fetchCanvas sceneA 补 content
    expect(fetchCanvasSpy).toHaveBeenCalledWith('sceneA')
  })
})
