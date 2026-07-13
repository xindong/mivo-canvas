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
import { storeCanvasCursor, __resetCanvasCursorStore } from './snapshotCursorStore'
import { fromRecord, edgeFromRecord } from '../kernel/mapping'
import type { NodeRecord, EdgeRecord } from '../kernel/records'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import { defaultFetch, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'
import type { ChatMessage } from '../store/chatStore'
import type { CanvasDocument } from '../types/mivoCanvas'
import type { Revision, UserStateEntry, RecordEntry } from '../../shared/persist-contract.ts'

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

// A2-S3 block 8:scene 切换 re-hydrate 去重 + in-flight 防并发状态(module 级,同 orderRevisionByCanvas 模式)。
//   - hydratedSceneIds:本会话已成功 hydrate content 的 sceneId 集合(切走再切回不重复 fetch;lead 要求
//     "同 scene 会话内去重")。boot step 2.5 对 active scene 调 hydrateCanvasContentIfMissing 时也记入,
//     故 boot active scene 切走再切回不双拉。
//   - inFlightSceneIds:正在 fetch 的 sceneId(防同 scene 并发双拉;hydrate 内 R-7 union 已处理重叠,
//     去重避免浪费网络)。
//   - sceneHydrationUnsub:scene 切换订阅的 unsubscribe(boot durable 后启动;__resetPersistBoot /
//     stopSceneHydrationSubscription 停)。local 模式永不写(订阅永不启动,bootPersistWiring 第一行 return)。
const hydratedSceneIds = new Set<string>()
const inFlightSceneIds = new Set<string>()
let sceneHydrationUnsub: (() => void) | undefined

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
  __resetCanvasCursorStore()
  // A2-S3 block 8:清 scene 切换 re-hydrate 状态(逐 test 隔离;unsub + 清去重/in-flight 集合)。
  stopSceneHydrationSubscription()
  hydratedSceneIds.clear()
  inFlightSceneIds.clear()
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
 * P2-3(sol 返修):local-only 保留必须有 pending append 证明,否则远端已删消息被永久 union 复活。
 *   - 证明源 = chatStore.unsyncedChatMsgIds sidecar(enqueueChatAppend 置位,跨 boot 持久)。
 *   - local-only + 在 sidecar 内 → 保留(pending append,未 drain 到 PG)。
 *   - local-only + 不在 sidecar 内 → server canonical 删除(远端已删,不复活)。
 *   - server 集内的 id → synced,清 sidecar 对应位(下次不再当 pending 保留)。
 *   sidecar 经 chatPersistConfig 持久化,boot 时 IDB rehydrate 先于 hydrateFromServer → hydrate
 *   时 sidecar 已就绪,不依赖 writeQueue.start() 载入 IDB pending(无 boot-order 竞态,优于查队列)。
 *
 * orderRevision 落点(DP-6R per-actor×canvas reorder cursor;供 reorder If-Match,非只 log)。
 *   ⚠️ 含 local-only id 时 orderRevision 不得直接用于 reorder——local-only id 不在 server order
 *   序列,reorder 须先 drain(local-only 落 PG 后 server 给出 order)再取 orderRevision,否则 reorder
 *   If-Match 对 local-only id 无 base。仅处理传入 sceneId;切 scene 的 per-scene re-hydrate 属 G1-c 范畴,
 *   本轮只 hydrate active。
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
  const prevUnsynced = new Set(useChatStore.getState().unsyncedChatMsgIds[sceneId] ?? [])
  const localMessages = useChatStore.getState().messagesByScene[sceneId] ?? []
  // P2-3:local-only 保留必须由 sidecar pending append 证明;否则按 server canonical 删除(远端已删不复活)。
  const localOnly = localMessages.filter(
    (m) => !serverIds.has(m.id) && prevUnsynced.has(m.id),
  )
  // P2-3:server 集内 id = synced → 清 sidecar 位(下次不再当 pending);仅留仍 pending 的 id。
  const stillUnsynced = [...prevUnsynced].filter((id) => !serverIds.has(id))
  const merged = [...serverMessages, ...localOnly]
  useChatStore.setState({
    messagesByScene: {
      ...useChatStore.getState().messagesByScene,
      [sceneId]: merged,
    },
    unsyncedChatMsgIds: {
      ...useChatStore.getState().unsyncedChatMsgIds,
      [sceneId]: stillUnsynced,
    },
  })
  // R2 F4:orderRevision 落点(DP-6R 契约;供 reorder If-Match,非只 log)。
  //   ⚠️ P2-3:含 local-only id 时 orderRevision 仅覆盖 server 已知 id 的 order;local-only id 须
  //   drain 后再取,不可直接用于 reorder(见函数头注释)。
  orderRevisionByCanvas.set(sceneId, orderRevision)
  debugLogger.log(
    SOURCE,
    `server hydrate: ${serverMessages.length} chat message(s) from BFF + ${localOnly.length} local unsynced retained for canvas ${sceneId} (R-7 merge + P2-3 unsynced proof; ${stillUnsynced.length} still pending; orderRevision=${orderRevision})`,
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
 * A2-S3 item 4:server 模式 hydrate 补画布正文拉取/应用(现在只 merge canvas meta → 补 content)。
 * 按 G1-b 冻结 hydrate 语义(inventory §2.2:loadSnapshot → CanvasSnapshot + cursor):
 *  - fetchCanvas(active)→ 构建 canvas 级 bundle cursor(recordId→base + orderCv + sinceSeq;§14.7 hydrate 签发)
 *    存 snapshotCursorStore(Block 7 edit/delete 从此取 wire base 作 If-Match)。
 *  - 应用 nodes/edges 到 store.canvases[sceneId]:R-7 union(server canonical by id 覆盖本地;local-only =
 *    id 不在 server 集 = pending create 未 drain / demo → 保留 union,同 chat R-7)。tasks/selection 不动
 *    (content hydrate 不碰衍生态)。anchors 的 base 入 bundle(供 Block 7),但 anchors 不在 CanvasDocument
 *    (存别处),apply 跳过 anchors。
 *  - kernel=new/legacy 两轨兼容:写 legacy store(canvases[sceneId]);kernel=new 读自己 DocKernel adapter
 *    (src/kernel/adapters.ts,直读 backend),不经此 store → 默认 legacy 不破(只补 content,不改 meta 语义)。
 * local 模式无 hydrate 概念,永不调此。失败降级 try/catch + warn(不阻断其余 hydrate)。
 */
const hydrateActiveCanvasContent = async (
  sceneId: string,
  adapter: ReturnType<typeof getServerPersistAdapter>,
): Promise<boolean> => {
  const { useCanvasStore } = await import('../store/canvasStore')
  let resp
  try {
    resp = await adapter.fetchCanvas(sceneId)
  } catch (error) {
    debugLogger.warn(SOURCE, `fetchCanvas content hydrate failed for ${sceneId}: ${msg(error)} (content stays local)`)
    return false
  }
  if (!resp) return false // canvas 不存在/无权(null,与 fetchCanvas 一致;不应用 content;不计 hydrated 允许重试)
  // 构建 bundle cursor(per-record base + orderCv + sinceSeq;§14.7;Block 7 用)。
  storeCanvasCursor(resp)
  // 应用 nodes/edges(R-7 union:server canonical by id + 保留 local-only)。
  const serverNodes = resp.nodes
    .filter((r): r is RecordEntry & { payload: object } => r.payload != null && typeof r.payload === 'object')
    .map((r) => fromRecord({ ...r.payload, id: r.id, revision: r.revision } as NodeRecord))
  const serverEdges = resp.edges
    .filter((r): r is RecordEntry & { payload: object } => r.payload != null && typeof r.payload === 'object')
    .map((r) => edgeFromRecord({ ...r.payload, id: r.id, revision: r.revision } as EdgeRecord))
  const serverNodeIds = new Set(serverNodes.map((n) => n.id))
  const serverEdgeIds = new Set(serverEdges.map((e) => e.id))
  let localOnlyNodes = 0
  let localOnlyEdges = 0
  useCanvasStore.setState((s) => {
    const existing = s.canvases[sceneId]
    if (!existing) return {} // meta-stub 未建(step 2 应已建);若仍无,返空 set 不动
    const localNodes = existing.nodes.filter((n) => {
      if (serverNodeIds.has(n.id)) return false
      localOnlyNodes++
      return true
    })
    const localEdges = existing.edges.filter((e) => {
      if (serverEdgeIds.has(e.id)) return false
      localOnlyEdges++
      return true
    })
    return {
      canvases: {
        ...s.canvases,
        [sceneId]: {
          ...existing,
          nodes: [...serverNodes, ...localNodes],
          edges: [...serverEdges, ...localEdges],
        },
      },
    }
  })
  debugLogger.log(
    SOURCE,
    `server hydrate: active canvas ${sceneId} content applied (${serverNodes.length} nodes + ${serverEdges.length} edges from BFF; ${localOnlyNodes} local-only nodes + ${localOnlyEdges} local-only edges retained (R-7 union); bundle cursor built)`,
  )
  return true
}

/**
 * A2-S3 block 8:去重 + in-flight 防并发的 content hydrate 包装。成功 hydrate 的 sceneId 记入
 * hydratedSceneIds(切走再切回不重复 fetch);in-flight 标记防同 scene 并发双拉。fetch 失败
 * (hydrateActiveCanvasContent 内 try/catch warn 降级,不 throw)→ 不记 hydrated,下次切回可重试。
 * 仅 server/shadow 模式调(local 短路在 bootPersistWiring 第一行,订阅永不启动)。
 */
const hydrateCanvasContentIfMissing = async (
  sceneId: string,
  adapter: ReturnType<typeof getServerPersistAdapter>,
): Promise<void> => {
  if (hydratedSceneIds.has(sceneId)) {
    debugLogger.log(SOURCE, `scene ${sceneId} content already hydrated this session, skip fetch (dedup)`)
    return
  }
  if (inFlightSceneIds.has(sceneId)) {
    debugLogger.log(SOURCE, `scene ${sceneId} content hydrate already in-flight, skip concurrent fetch (in-flight guard)`)
    return
  }
  inFlightSceneIds.add(sceneId)
  try {
    // hydrateActiveCanvasContent 返 true=成功应用 content(记 hydrated,切回不重复 fetch);
    // false=fetchCanvas 失败/resp null(不记,下次切回可重试;fail-visible 由其内 warn 留痕)。
    const applied = await hydrateActiveCanvasContent(sceneId, adapter)
    if (applied) hydratedSceneIds.add(sceneId)
  } finally {
    inFlightSceneIds.delete(sceneId)
  }
}

/**
 * A2-S3 block 8:启动 scene 切换 re-hydrate 订阅。boot readiness durable 后(server/shadow 分支)调此。
 * 订阅 useCanvasStore.sceneId 变化 → 对新 scene 调 hydrateCanvasContentIfMissing(补 content)。
 * dynamic import canvasStore 防静态环(persistBoot↔canvasStore 经 projectsSlice)。local 模式永不调
 * (bootPersistWiring 第一行 return);故订阅内不再检查 isLocalPersist(local 零行为变化由 boot 入口保证)。
 * 幂等:已启动则直接 return(防重复订阅)。
 */
const startSceneHydrationSubscription = async (
  adapter: ReturnType<typeof getServerPersistAdapter> = getServerPersistAdapter(),
): Promise<void> => {
  if (sceneHydrationUnsub) return
  const { useCanvasStore } = await import('../store/canvasStore')
  sceneHydrationUnsub = useCanvasStore.subscribe((state, prev) => {
    if (state.sceneId && state.sceneId !== prev.sceneId) {
      void hydrateCanvasContentIfMissing(state.sceneId, adapter)
    }
  })
  debugLogger.log(
    SOURCE,
    `scene-switch content re-hydrate subscription started (mode=${getPersistMode()}; dedup + in-flight guard active; local never subscribes)`,
  )
}

/** A2-S3 block 8:停 scene 切换订阅(测试/HMR 清理)。生产 boot 常驻。 */
export const stopSceneHydrationSubscription = (): void => {
  sceneHydrationUnsub?.()
  sceneHydrationUnsub = undefined
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

  // 2.5 A2-S3 item 4:active canvas 正文拉取 + bundle cursor 构建(content hydrate;现 meta 已 merge,补 content)。
  //    fetchCanvas(active)→ 应用 nodes/edges(R-7 union)+ 构建 bundle cursor(Block 7 edit/delete 用)。走
  //    hydrateCanvasContentIfMissing(去重包装):boot active scene 记入 hydratedSceneIds,切走再切回不双拉。
  //    切 scene re-hydrate 由 block 8 订阅(startSceneHydrationSubscription)处理,此处只 hydrate boot active;
  //    local 模式永不调(hydrateFromServer 仅 server 分支)。失败降级 warn 不阻断。
  try {
    const sceneId = useCanvasStore.getState().sceneId
    if (sceneId) {
      await hydrateCanvasContentIfMissing(sceneId, adapter)
    }
  } catch (error) {
    debugLogger.warn(SOURCE, `active canvas content hydrate failed: ${msg(error)} (content stays local/meta-only)`)
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
 * @param queueOpts 注入 writeRetryQueue 阈值(测试用 maxQueuePerUser 触发溢出驱逐;production 默认 createWriteQueue 内 DEFAULT_MAX_QUEUE=256)。
 */
export const startPersistWriteQueue = (
  opts: FetchAdapterOptions = getProductionFetchOptions(),
  queueOpts?: { maxQueuePerUser?: number; maxAttempts?: number },
): Promise<void> => {
  if (writeQueue) return Promise.resolve()
  const executor = createAdapterWriteExecutor(opts)
  writeQueue = createWriteQueue({
    executor,
    ...(queueOpts?.maxQueuePerUser !== undefined ? { maxQueuePerUser: queueOpts.maxQueuePerUser } : {}),
    ...(queueOpts?.maxAttempts !== undefined ? { maxAttempts: queueOpts.maxAttempts } : {}),
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
    // P2-3(sol 第二轮返修):op 终态回调 — appendChatMessage success/terminal 时清 unsynced sidecar
    //   (消"成功不清 outcome.revision!==undefined 才 onSuccess / terminal 留假 pending → 永久 union");
    //   非终态(transient-retry/401/retained)writeRetryQueue 不 fire onOutcome,sidecar 保持 pending。
    //   dynamic import 破 persistBoot↔chatPersistSync 静态环(chatPersistSync 静态 import persistBoot);
    //   drain await 本回调(清位在 drain 返回前落地,测试可 drain 后立即断言 marker,无竞态)。
    onOutcome: async (op) => {
      if (op.kind !== 'appendChatMessage') return
      const msgId = (op.message as { id?: string }).id
      if (!msgId) return
      const { clearUnsyncedMarker } = await import('../store/chatPersistSync')
      clearUnsyncedMarker(op.canvasId, msgId)
    },
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
    // A2-S3 block 8:启动 scene 切换 re-hydrate 订阅(切到新 server 画布 → fetchCanvas 补 content;
    // 去重 + in-flight 防并发)。local 在 bootPersistWiring 第一行 return 短路,永不调此。
    await startSceneHydrationSubscription()
  } else {
    // shadow:IDB 已 rehydrate(读源),此处 compare + 双写队列(mutation enqueue 同时写 BFF)
    await shadowCompareWithServer()
    await startPersistWriteQueue(opts)
    // A2-S3 block 8:shadow 模式同样订阅 scene 切换 re-hydrate(lead 要求 persist=server|shadow 均触发)。
    await startSceneHydrationSubscription()
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
