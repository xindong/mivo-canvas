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
import type { CanvasDocument } from '../types/mivoCanvas'
import type { Revision, UserStateEntry } from '../../shared/persist-contract.ts'

const SOURCE = 'Persist Boot'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// 生产 fetch opts(与 serverPersistAdapterSelector 的 wired adapter 同源:default fetch + '' baseUrl + lazy authHeaders)。
// executor 与 adapter 必须走同一 BFF + 同一鉴权,防双实现漂移(P1-1 接线硬约束)。
const lazyAuthHeaders: GetAuthHeaders = async () => (await import('./authHeaders')).authHeaders()
const getProductionFetchOptions = (): FetchAdapterOptions => ({ getAuthHeaders: lazyAuthHeaders })

// ── 队列单例(仅 server/shadow 启动;local 永不启动 → enqueuePersistWrite no-op)──
let writeQueue: WriteQueue | undefined

// G1-a R2 F4:per-canvas chat orderRevision(DP-6R 契约)落点。hydrate 从 listChatMessages 读出后存此,
// 供未来 reorder If-Match 用(reorder cursor 真相源;消费方属 DP-6R/G1-c defer 域,此处只存不消费,
// 非"只 log"——是可观测的应用点 + accessor)。local 模式永不写入(hydrate 不跑)。
const orderRevisionByCanvas = new Map<string, Revision>()

/**
 * G1-a R2 F4:取某 canvas 的 chat orderRevision(DP-6R per-actor×canvas reorder cursor)。
 * 由 hydrateFromServer 在 server 模式 listChatMessages 后写入;未 hydrate / local → undefined。
 * DP-6R/G1-c reorder 接线时读此作 If-Match base(非陈旧)。
 */
export const getChatOrderRevision = (canvasId: string): Revision | undefined =>
  orderRevisionByCanvas.get(canvasId)

// G1-a R2 F2 / R3 F2-A:user-state hydrate 落点(非只 log)。selection/camera 当前 ephemeral、settings=API keys
// 受 DP-7 排除——无 client KV store 消费;但 hydrate 把 map 存此,供未来 selection/camera/pref KV 接线消费。
// R3 F2-A:`canvas:<id>:selection`(DP-1 frozen key)由本模块 hydrateFromServer 真实消费(恢复 active canvas
// selection 到 store),其余 key 仍存此供未来 pref-KV(G1-c)消费。local 模式永不写入(hydrate 不跑)。
const userStateMap = new Map<string, UserStateEntry>()

/**
 * G1-a R2 F2:取 hydrate 的 user-state entry。由 hydrateFromServer 在 server 模式写入;未 hydrate / local →
 * undefined。消费方(selection/camera/pref-KV)defer 到 G1-c,此处是 server-truth 应用点(非只 log)。
 */
export const getHydratedUserState = (key: string): UserStateEntry | undefined => userStateMap.get(key)

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
  orderRevisionByCanvas.clear()
  userStateMap.clear()
}

// ── server 模式 boot:hydrate 非画布域(从 BFF 恢复)──

/**
 * R-7:hydrate 某 scene 的 chat collection(merge 语义,非 wholesale replace)。
 *
 * 痛(计划 A2 前置 a / R-7):离线 append 的 chat 消息本地已 committed + 入 writeRetryQueue
 * (IDB 持久),但尚未 drain 到 PG。若 hydrate 用服务端返回 wholesale replace
 * `messagesByScene[sceneId]`,本地未同步消息被覆盖 → "离线 append chat → 上线刷新消失"。
 *
 * 解:merge-by-id —— server 消息是已同步消息的 canonical 真值(按 id 覆盖本地);本地消息
 * 中 id 不在 server 集的(= pending 在队列、未 drain 到 PG)按 union 保留,append 在 server
 * 消息之后(离线 append 的消息 createdAt 最新,时序正确)。drain 把 pending 消息发到 PG 后,
 * 下次 hydrate 该消息已在 server 集 → 取 server canonical(内容一致,opaque payload)。
 *
 * orderRevision 落点(DP-6R per-actor×canvas reorder cursor;供 reorder If-Match,非只 log)。
 * 仅处理传入 sceneId;切 scene 的 per-scene re-hydrate 属 G1-c 范畴,本轮只 hydrate active。
 */
const hydrateChatForScene = async (
  sceneId: string,
  adapter: ReturnType<typeof getServerPersistAdapter>,
): Promise<void> => {
  const { useChatStore } = await import('../store/chatStore')
  const { messages, orderRevision } = await adapter.listChatMessages(sceneId)
  const serverMessages = messages.map((r) => r.payload as ChatMessage)
  // R-7 merge:server canonical for synced(按 id);本地未同步(id 不在 server 集)保留。
  const serverIds = new Set(serverMessages.map((m) => m.id))
  const localMessages = useChatStore.getState().messagesByScene[sceneId] ?? []
  const localOnly = localMessages.filter((m) => !serverIds.has(m.id))
  const merged = [...serverMessages, ...localOnly]
  useChatStore.setState({
    messagesByScene: {
      ...useChatStore.getState().messagesByScene,
      [sceneId]: merged,
    },
  })
  // R2 F4:orderRevision 落点(DP-6R 契约;供 reorder If-Match,非只 log)。
  orderRevisionByCanvas.set(sceneId, orderRevision)
  debugLogger.log(
    SOURCE,
    `server hydrate: ${serverMessages.length} chat message(s) from BFF + ${localOnly.length} local unsynced retained for canvas ${sceneId} (R-7 merge; orderRevision=${orderRevision})`,
  )
}

/**
 * R-7:drain 后 store 回填——重拉 active scene(或指定 scene)chat 并 merge,让 store 与 PG
 * canonical 状态对齐。drain 把 pending 未同步消息发到 PG 后,回填确认 store 反映服务端真值
 * (merge 语义同 hydrateChatForScene,保留 drain 期间新产生的本地未同步消息)。
 *
 * 用途:测试 SC "drain 后 store 回填" 的显式钩子;未来生产可接 post-drain 钩子(当前 fire-and-
 * forget 调用方控制时机,避免与 queue 内部 timer drain 竞态)。local 模式无 hydrate 概念,调用
 * 为 no-op(adapter unwired → listChatMessages reject → warn,不阻断)。
 */
export const backfillChatAfterDrain = async (
  sceneId?: string,
  adapter: ReturnType<typeof getServerPersistAdapter> = getServerPersistAdapter(),
): Promise<void> => {
  const { useCanvasStore } = await import('../store/canvasStore')
  const target = sceneId ?? useCanvasStore.getState().sceneId
  if (!target) return
  try {
    await hydrateChatForScene(target, adapter)
  } catch (error) {
    debugLogger.warn(SOURCE, `backfillChatAfterDrain failed for ${target}: ${msg(error)}`)
  }
}

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

  // 2. canvas meta 列表 → 合并进 store.canvases(R2 F2:不再 only-log)。全量 content hydrate
  //    (fetchCanvas + RecordEntry→NodeRecord)属 G1-c defer —— 此处只 merge meta(title/projectId/
  //    metaRevision/contentVersion/updatedAt),本地 content(nodes/edges/tasks)保留;服务端有但本地
  //    无的 canvas 插入 meta-stub(content 空,G1-c 补 content);本地有但服务端无的保留(pending create /
  //    demo,G1-c reconcile)。active sceneId 的 meta 刷新但其 flattened nodes/edges 不动(content 不变)。
  try {
    const { canvases } = await adapter.listCanvas()
    const serverById = new Map(canvases.map((m) => [m.id, m] as const))
    useCanvasStore.setState((s) => {
      const local = s.canvases
      const merged: Record<string, CanvasDocument> = {}
      for (const meta of canvases) {
        const existing = local[meta.id]
        if (existing) {
          // 刷新 meta 字段,保留本地 content(nodes/edges/tasks/selection)+ sourceTemplateId
          // (sourceTemplateId 客户端是 DemoSceneId,服务端 string 不覆盖)。
          merged[meta.id] = {
            ...existing,
            title: meta.title,
            projectId: meta.projectId,
            metaRevision: meta.metaRevision,
            contentVersion: meta.contentVersion,
            updatedAt: meta.updatedAt,
          }
        } else {
          // meta-stub:content 空(G1-c content hydrate defer);meta 已恢复,非 only-log。
          // sourceTemplateId 不从服务端 string 覆盖(客户端 DemoSceneId 域,留 undefined)。
          merged[meta.id] = {
            title: meta.title,
            projectId: meta.projectId,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            metaRevision: meta.metaRevision,
            contentVersion: meta.contentVersion,
            nodes: [],
            edges: [],
            tasks: [],
          } as CanvasDocument
        }
      }
      // 本地有但服务端无:保留(pending create / demo;G1-c 全量 reconcile owns drop)
      for (const [id, doc] of Object.entries(local)) {
        if (!serverById.has(id)) merged[id] = doc
      }
      return { canvases: merged }
    })
    debugLogger.log(
      SOURCE,
      `server hydrate: ${canvases.length} canvas meta(s) merged into store.canvases (content hydrate deferred to G1-c; local-only canvases retained)`,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `listCanvas hydrate failed: ${msg(error)}`)
  }

  // 3. user-state map → 落点 + 真实消费方(R3 F2-A:不再只存 module 级 accessor)。
  //    selection/camera 当前 ephemeral、settings=API keys 受 DP-7 排除;但 `canvas:<id>:selection`
  //    是 DP-1 frozen user-state(每画布选中节点 id 列表),hydrate 后真实应用:恢复 active canvas 的
  //    selection —— 用 selectionFrom 过滤已删/hidden node 防悬空,同时写入 document(切 scene 不丢)+ 顶层
  //    (active 可见)。这是真实 store 消费方(非只 accessor)。其余 key 仍存 userStateMap 供未来 pref-KV(G1-c)消费。
  try {
    const map = await hydrateUserStateMap(opts)
    userStateMap.clear()
    for (const [k, v] of Object.entries(map)) userStateMap.set(k, v)
    // R3 F2-A:真实消费方 —— 恢复 active canvas 的 selection(server user-state `canvas:<id>:selection`)。
    const sceneId = useCanvasStore.getState().sceneId
    if (sceneId) {
      const selEntry = userStateMap.get(`canvas:${sceneId}:selection`)
      if (selEntry && Array.isArray(selEntry.value) && selEntry.value.length > 0) {
        const doc = useCanvasStore.getState().canvases[sceneId]
        if (doc && doc.nodes.length > 0) {
          const { selectionFrom } = await import('../store/canvasDocumentModel')
          const sel = selectionFrom(selEntry.value as string[], undefined, doc.nodes)
          if (sel.selectedNodeIds.length > 0) {
            useCanvasStore.setState((s) => ({
              selectedNodeId: sel.selectedNodeId,
              selectedNodeIds: sel.selectedNodeIds,
              canvases: {
                ...s.canvases,
                [sceneId]: {
                  ...s.canvases[sceneId]!,
                  selectedNodeId: sel.selectedNodeId,
                  selectedNodeIds: sel.selectedNodeIds,
                },
              },
            }))
            debugLogger.log(
              SOURCE,
              `server hydrate: restored selection for ${sceneId} from user-state (${sel.selectedNodeIds.length} node(s); real consumer)`,
            )
          }
        }
      }
    }
    debugLogger.log(
      SOURCE,
      `server hydrate: ${userStateMap.size} user-state key(s) from BFF (active-canvas selection applied to store; pref-KV consumer deferred to G1-c)`,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `hydrateUserStateMap failed: ${msg(error)}`)
  }

  // 4. chat(DP-6R P1-1,per-actor):hydrate active canvas 的 chat collection(R-7 merge 语义,
  //    非 wholesale replace——保留本地未同步消息,见 hydrateChatForScene)。仅 active canvas
  //    (chat 是 per-canvas 子资源;切 scene 时按需 re-hydrate 属 G1-c 范畴,本轮只 hydrate active)。
  try {
    const sceneId = useCanvasStore.getState().sceneId
    if (sceneId) {
      await hydrateChatForScene(sceneId, adapter)
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
export const startPersistWriteQueue = (opts: FetchAdapterOptions = getProductionFetchOptions()): Promise<void> => {
  if (writeQueue) return Promise.resolve()
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
  const startPromise = writeQueue.start().catch((error) => {
    debugLogger.error(SOURCE, `queue start failed: ${msg(error)}`)
  })
  debugLogger.log(SOURCE, `write queue started (mode=${getPersistMode()}; non-canvas domain G1-a wired, canvas/chat deferred)`)
  return startPromise
}

/** 停队列(HMR / 测试清理)。生产常驻。 */
export const stopPersistWriteQueue = (): void => {
  if (!writeQueue) return
  writeQueue.stop()
  writeQueue = undefined
  debugLogger.log(SOURCE, 'write queue stopped')
}

/**
 * G1-a R2 F5:恢复被 401 暂停的队列(清 paused + drain 重放 leftover paused-401 记录)。
 * 队列未启动(local 模式 / boot 前)→ no-op(undefined);未暂停 → no-op(resume 内部守卫)。
 * 由 bootPersistWiring 在已认证 boot 后调用,并由 authSlice 在 status→authenticated 时调用
 * (覆盖 SSO re-login 后重载场景 + 未来 mid-session re-auth)。
 */
export const resumePersistQueue = async (): Promise<void> => {
  await writeQueue?.resume()
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
    await startPersistWriteQueue(opts)
  } else {
    // shadow:IDB 已 rehydrate(读源),此处 compare + 双写队列(mutation enqueue 同时写 BFF)
    await shadowCompareWithServer()
    await startPersistWriteQueue(opts)
  }
  // R2 F5:已认证 boot 时 resume 暂停的 401 记录。queue.start() 把 leftover paused-401 从 prior
  // session 恢复后置 paused=true 拒 drain;此处 auth 已 hydrate,authenticated → resume 清 paused +
  // drain 重放(记录成功后删);unauthenticated → 不 resume(记录仍 paused-401 保留,不重放)。
  // dynamic import 防静态环(persistBoot↔authSlice)。
  try {
    const { useAuthStore } = await import('../store/authSlice')
    if (useAuthStore.getState().status === 'authenticated') {
      await resumePersistQueue()
    }
  } catch (error) {
    debugLogger.warn(SOURCE, `post-start resume check failed: ${msg(error)}`)
  }
}
