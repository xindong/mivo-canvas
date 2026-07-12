// persistBoot — G1-a P1-1 真接线:boot 单点读 persistMode 分派 + 队列启停 + mutation enqueue 出口。
//
// 计划 §4 G1-a 要的是"真接线"——?persist=server 下行为可观测地不同于 local:
//   local(默认)  :IDB-only(zustand persist 走 idbStateStorage),queue 不 start,enqueue no-op。生产零变化。
//   server       :boot 从 BFF hydrate 非画布域(project 全量 + canvas meta 列表 + user-state map),
//                  mutation 经 enqueuePersistWrite → writeRetryQueue → executor → BFF;断网入队恢复后 drain。
//   shadow       :IDB 仍为读源(现状 rehydrate)+ 读服务端 listProjects 做差异 debugLogger 记录 +
//                  mutation 双写(同样 enqueue → queue → BFF)。
//
// 本模块 **不静态 import** canvasStore(防 canvasStore→projectsSlice→persistBoot→canvasStore 静态环);
// hydrate/compare 内通过 dynamic import 访问 store。enqueuePersistWrite 只触 queue + debugLogger(无 store 依赖),
// 故 projectsSlice/documentSlice 可静态安全 import 本模块的 enqueue 出口。
//
// 范围(非画布域,G1-a):project/canvas-meta/user-state/asset。画布域写(node/edge/anchor)与 chat 不接
// (G1-c / DP-6R seam——executor 返 unsupported-retained 留存不删)。canvas 全量 content hydrate
// (fetchCanvas + RecordEntry→NodeRecord 转换)属 G1-c,本轮只 hydrate project 全量 + canvas meta 列表 +
// user-state map 作可观测差异,不做全量 content hydrate(如实声明,见回报)。

import { getPersistMode, isLocalPersist } from './persistMode'
import { getServerPersistAdapter } from './serverPersistAdapterSelector'
import { createAdapterWriteExecutor } from './persistWriteExecutor'
import { createWriteQueue, type WriteOp, type WriteQueue } from './writeRetryQueue'
import { hydrateUserStateMap } from './serverPersistHydrate'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import { defaultFetch, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'
import type { ChatMessage } from '../store/chatStore'
import type { Revision } from '../../shared/persist-contract.ts'

const SOURCE = 'Persist Boot'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// 生产 fetch opts(与 serverPersistAdapterSelector 的 wired adapter 同源:default fetch + '' baseUrl + lazy authHeaders)。
// executor 与 adapter 必须走同一 BFF + 同一鉴权,防双实现漂移(P1-1 接线硬约束)。
const lazyAuthHeaders: GetAuthHeaders = async () => (await import('./authHeaders')).authHeaders()
const getProductionFetchOptions = (): FetchAdapterOptions => ({ getAuthHeaders: lazyAuthHeaders })

// ── 队列单例(仅 server/shadow 启动;local 永不启动 → enqueuePersistWrite no-op)──
let writeQueue: WriteQueue | undefined

/**
 * G1-a P1-1:非画布域 mutation enqueue 出口。store mutation(set 后)调此。
 * - local(默认):writeQueue undefined → 立即 return(零副作用,表征测试不红)。
 * - server/shadow:enqueue 到 writeRetryQueue(IDB 持久化意图 + timer drain → executor → BFF)。
 *   网络失败记录留存 + 退避重试;断网恢复后 drain。
 * fire-and-forget(mutations 不 await);返回 promise 供测试 flush/drain;enqueue 失败 debugLogger.error(不静默)。
 */
export const enqueuePersistWrite = (op: WriteOp): Promise<void> | undefined => {
  if (!writeQueue) return undefined // local inert OR queue 未启动
  const p = writeQueue.enqueue(op).then(
    () => {},
    (error) => {
      debugLogger.error(SOURCE, `enqueue failed (${op.kind}): ${msg(error)}; local set 已生效,服务端可能滞后(队列恢复后补发)`)
    },
  )
  return p
}

/** G1-a:手动 drain(server/shadow 启动后;测试用 + 断网恢复后补发)。local no-op(undefined)。 */
export const drainPersistQueue = async (): Promise<{ processed: number; successes: number; failures: number; terminals: number; paused: boolean } | undefined> =>
  writeQueue?.drain()

/** 测试/observability:队列是否 active(server/shadow 已 start)。 */
export const isPersistWriteActive = (): boolean => writeQueue !== undefined

/** 测试用:重置队列单例(逐 test 隔离;不重置 persistMode)。 */
export const __resetPersistBoot = (): void => {
  writeQueue?.stop()
  writeQueue = undefined
}

// ── server 模式 boot:hydrate 非画布域(从 BFF 恢复)──
/**
 * server 模式冷启动 hydrate:project 全量(替换 store.projects)+ canvas meta 列表(可观测,
 * 全量 content hydrate 属 G1-c 本轮不做)+ user-state map(无 client KV store,application deferred)。
 * 失败降级:各步独立 try/catch + debugLogger,任一失败不阻断其余(绝不因部分 hydrate 失败挂死 app)。
 * @param adapter 注入 adapter(测试用 fake);production 默认 getServerPersistAdapter()。
 * @param opts 注入 fetch opts(测试用,hydrateUserStateMap);production 默认 getProductionFetchOptions()。
 */
export const hydrateFromServer = async (
  adapter: ReturnType<typeof getServerPersistAdapter> = getServerPersistAdapter(),
  opts: FetchAdapterOptions = getProductionFetchOptions(),
): Promise<void> => {
  // dynamic import:防 canvasStore→projectsSlice→persistBoot→canvasStore 静态环。
  const { useCanvasStore } = await import('../store/canvasStore')

  // 1. project 全量(非画布域,完全在 G1-a 范围)——替换 store.projects 为服务端真值。
  try {
    const { projects } = await adapter.listProjects()
    useCanvasStore.setState({ projects })
    debugLogger.log(SOURCE, `server hydrate: ${projects.length} project(s) from BFF (replaced local)`)
  } catch (error) {
    debugLogger.error(SOURCE, `listProjects hydrate failed: ${msg(error)} (degrade to local/demo state)`)
  }

  // 2. canvas meta 列表(可观测差异证据;全量 content hydrate fetchCanvas + RecordEntry→NodeRecord 转换属 G1-c,
  //    本轮只读 list 作 observability + 为 G1-c 铺底,不替换 store.canvases——否则 content 缺失致画布空)。
  try {
    const { canvases } = await adapter.listCanvas()
    debugLogger.log(
      SOURCE,
      `server hydrate: ${canvases.length} canvas meta(s) from BFF (content hydrate deferred to G1-c; store.canvases unchanged)`,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `listCanvas hydrate failed: ${msg(error)}`)
  }

  // 3. user-state map(可观测;无 client KV store——selection/camera 当前 ephemeral,settings=API keys 受 DP-7 排除;
  //    application 到 store deferred 到 pref KV 落地,本轮只 log 作 server-truth 证据)。
  try {
    const map = await hydrateUserStateMap(opts)
    debugLogger.log(
      SOURCE,
      `server hydrate: ${Object.keys(map).length} user-state key(s) from BFF (no client KV store yet; apply deferred)`,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `hydrateUserStateMap failed: ${msg(error)}`)
  }

  // 4. chat(DP-6R P1-1,per-actor):hydrate active canvas 的 chat collection(当前 actor 自己的)。
  //    RecordEntry.payload = opaque ChatMessage,窄化灌入 useChatStore.messagesByScene[activeSceneId]。
  //    仅 active canvas(chat 是 per-canvas 子资源;切 scene 时按需 re-hydrate 属 G1-c 范畴,本轮只 hydrate active)。
  try {
    const { useChatStore } = await import('../store/chatStore')
    const sceneId = useCanvasStore.getState().sceneId
    if (sceneId) {
      const { messages } = await adapter.listChatMessages(sceneId)
      const chatMessages = messages.map((r) => r.payload as ChatMessage)
      useChatStore.setState({
        messagesByScene: {
          ...useChatStore.getState().messagesByScene,
          [sceneId]: chatMessages,
        },
      })
      debugLogger.log(
        SOURCE,
        `server hydrate: ${chatMessages.length} chat message(s) for active canvas ${sceneId} from BFF (per-actor DP-6R)`,
      )
    }
  } catch (error) {
    debugLogger.warn(SOURCE, `listChatMessages hydrate failed: ${msg(error)} (chat stays IDB/local)`)
  }
}

// ── shadow 模式 boot:IDB 读源 + 服务端 read + 差异 debugLogger(不 populate)──
/**
 * shadow 模式:IDB 仍为读源(useStoreHydration 已 rehydrate),此处读服务端 listProjects 与本地比对,
 * 差异写 debugLogger(灰度比对,非生产默认)。不 populate(避免覆盖 IDB 读源)。
 * @param adapter 注入 adapter(测试用);production 默认 getServerPersistAdapter()。
 */
export const shadowCompareWithServer = async (
  adapter: ReturnType<typeof getServerPersistAdapter> = getServerPersistAdapter(),
): Promise<void> => {
  const { useCanvasStore } = await import('../store/canvasStore')
  try {
    const [{ projects: serverProjects }, localState] = await Promise.all([
      adapter.listProjects(),
      Promise.resolve(useCanvasStore.getState()),
    ])
    const localIds = new Set(localState.projects.map((p) => p.id))
    const serverIds = new Set(serverProjects.map((p) => p.id))
    const onlyLocal = [...localIds].filter((id) => !serverIds.has(id))
    const onlyServer = [...serverIds].filter((id) => !localIds.has(id))
    debugLogger.log(
      SOURCE,
      `shadow compare: local ${localIds.size} vs server ${serverIds.size} projects; only-local [${onlyLocal.join(',')}] (count ${onlyLocal.length}); only-server [${onlyServer.join(',')}] (count ${onlyServer.length})`,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `shadow listProjects compare failed: ${msg(error)} (IDB read source unaffected)`)
  }
}

// ── 队列启停(server/shadow 启动;local inert)──
/**
 * G1-a R2 F1:成功写回灌——把服务端返回的新 revision/metaRevision 写回 store,下一次 strict
 * update(PATCH/PUT 带 If-Match)用 fresh base,否则 create 成功后 rename 仍带缺省/陈旧 base → 428,
 * 或第二次 rename → 409(revision 永久陈旧)。local 模式不调(队列未启动)。dynamic import 防静态环。
 * drain 会 await 本函数,保证回灌在 drain 返回前落地。
 */
const applyServerRevision = async (op: WriteOp, outcome: { revision?: Revision }): Promise<void> => {
  if (outcome.revision === undefined) return
  const rev = outcome.revision
  const { useCanvasStore } = await import('../store/canvasStore')
  const state = useCanvasStore.getState()
  if (op.kind === 'createProject' || op.kind === 'updateProject') {
    const id = op.kind === 'createProject' ? (op.id ?? null) : op.projectId
    if (!id) return
    if (!state.projects.some((p) => p.id === id)) return
    useCanvasStore.setState((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, revision: rev } : p)),
    }))
  } else if (op.kind === 'createCanvas' || op.kind === 'updateCanvas') {
    if (!state.canvases[op.canvasId]) return
    useCanvasStore.setState((s) => ({
      canvases: { ...s.canvases, [op.canvasId]: { ...s.canvases[op.canvasId]!, metaRevision: rev } },
    }))
  }
}

/**
 * G1-a P1-1:启动 writeRetryQueue。server/shadow 在 boot 调此。local 永不调(生产零变化)。
 * executor 复用 createAdapterWriteExecutor(与 adapter 同源 fetch opts);onConflict 触发 re-hydrate
 * 作可恢复处理(P1-3:conflict 不静默删——re-hydrate 让本地从服务端真值刷新,用户可基于新 revision 重放)。
 * onConflict 回灌:F1 —— create/update 成功后把服务端新 revision 写回 store,防下一次 strict update 陈旧。
 * @param opts 注入 fetch opts(测试用 Hono app.request / fetch 计数 stub);production 默认 getProductionFetchOptions()。
 */
export const startPersistWriteQueue = (opts: FetchAdapterOptions = getProductionFetchOptions()): void => {
  if (writeQueue) return
  const executor = createAdapterWriteExecutor(opts)
  writeQueue = createWriteQueue({
    executor,
    // P1-3:conflict 强制提供可恢复处理——re-hydrate 刷新本地 revision,用户可重放(非静默删 op)。
    onConflict: (op, currentRevision) => {
      debugLogger.warn(
        SOURCE,
        `conflict on ${op.kind} (server rev ${currentRevision}); re-hydrating non-canvas state for recoverable rebase`,
      )
      void hydrateFromServer().catch((error) => {
        debugLogger.warn(SOURCE, `conflict re-hydrate failed: ${msg(error)}`)
      })
    },
    // R2 F1:成功写回灌 revision/metaRevision,防 strict update 陈旧。
    onSuccess: applyServerRevision,
  })
  void writeQueue.start().catch((error) => {
    debugLogger.error(SOURCE, `queue start failed: ${msg(error)}`)
  })
  debugLogger.log(SOURCE, `write queue started (mode=${getPersistMode()}; non-canvas domain G1-a wired, canvas/chat deferred)`)
}

/** 停队列(HMR / 测试清理)。生产常驻。 */
export const stopPersistWriteQueue = (): void => {
  if (!writeQueue) return
  writeQueue.stop()
  writeQueue = undefined
  debugLogger.log(SOURCE, 'write queue stopped')
}

// ── G1-a R2 F3:persist readiness 门控(fail-closed 防 memory 假持久)──────────────
export type PersistReadiness = { backend: string; durable: boolean }

/**
 * G1-a R2 F3:GET /healthz 解析 persist readiness。返 {backend,durable} 或 null(任何失败 →
 * fail-closed 哨兵,调用方据此不发业务写)。/healthz 免鉴权,但走同一 fetch+getAuthHeaders 无害
 * (服务端忽略);失败:网络 reject / 非 2xx / 无 persist 字段 / durable 非 boolean → null。
 * 不泄密:backend kind('pg'/'memory')非敏感;不暴露连接串/密码。
 */
export const fetchPersistReadiness = async (opts: FetchAdapterOptions): Promise<PersistReadiness | null> => {
  try {
    const doFetch: FetchLike = opts.fetch ?? defaultFetch
    const baseUrl = opts.baseUrl ?? ''
    const res = await doFetch(`${baseUrl}/healthz`, { method: 'GET', headers: { ...(await opts.getAuthHeaders()) } })
    if (res.status < 200 || res.status >= 300) return null
    const text = await res.text()
    if (!text) return null
    const body = JSON.parse(text) as { persist?: { backend?: unknown; durable?: unknown } }
    const p = body.persist
    if (!p || typeof p.durable !== 'boolean' || typeof p.backend !== 'string') return null
    return { backend: p.backend, durable: p.durable }
  } catch (error) {
    debugLogger.warn(SOURCE, `fetchPersistReadiness failed (fail-closed): ${msg(error)}`)
    return null
  }
}

/**
 * G1-a P1-1 boot 单点:useStoreHydration 在 auth hydrate 后调此,按 persistMode 分派。
 * - local(默认):no-op(零变化,IDB rehydrate 由调用方现有逻辑跑)。
 * - server:R2 F3 先 fetchPersistReadiness;durable(pg ready)才 hydrate + start queue,否则 fail-closed
 *   (不发业务写、不删 durable 记录、不覆盖本地态,toast 告知降级本地)。readiness 失败同样 fail-closed。
 * - shadow:同门控(durable 才 compare + start;否则 fail-closed)。
 * @param opts 注入 fetch opts(测试用);production 默认 getProductionFetchOptions()。
 */
export const bootPersistWiring = async (opts: FetchAdapterOptions = getProductionFetchOptions()): Promise<void> => {
  if (isLocalPersist) return // 默认零变化
  // R2 F3:durable-backend readiness 门控。memory 后端 + ?persist=server 会收到写成功并删 durable 记录,
  // pm2 重启后服务端清空 → 不可恢复的“成功保存”假象。fail-closed:durable 不达标不发业务写、
  // 不 hydrate(不覆盖本地 IDB 真值)、不 start queue(durable 记录若已存在也保留不被 drain 删)。
  const readiness = await fetchPersistReadiness(opts)
  if (!readiness?.durable) {
    debugLogger.warn(
      SOURCE,
      `persist backend not durable (backend=${readiness?.backend ?? 'unreachable'}); ${getPersistMode()} mode disabled — writes stay local IDB, no false-success (fail-closed)`,
    )
    toastFeedback.warn('服务端持久存储未就绪,已保持本地模式,改动不会同步到服务器。')
    return
  }
  if (getPersistMode() === 'server') {
    await hydrateFromServer(undefined, opts)
    startPersistWriteQueue(opts)
  } else {
    // shadow:IDB 已 rehydrate(读源),此处 compare + 双写队列(mutation enqueue 同时写 BFF)
    await shadowCompareWithServer()
    startPersistWriteQueue(opts)
  }
}
