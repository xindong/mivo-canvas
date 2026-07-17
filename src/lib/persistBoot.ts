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
import {
  createWriteQueue,
  getPendingCreateResourceIds,
  getPendingDeleteResourceIds,
  type WriteOp,
  type WriteQueue,
} from './writeRetryQueue'
import { hydrateUserStateMap } from './serverPersistHydrate'
import { storeCanvasCursor, __resetCanvasCursorStore } from './snapshotCursorStore'
import { getPersistUserId } from './persistUserId'
// Phase 1 项4(2026-07-16 复活加固):持久 tombstone 集 —— DELETE 离队(重试耗尽 terminal / 队列溢出驱逐)后
//   pending-delete 差集过滤失效,tombstone 接力挡复活。写入点在 store delete action(见 projectsSlice/
//   documentSlice);本模块负责 hydrate 过滤读取 + onOutcome DELETE success 清除 + enqueuePersistWrite create 撤销。
import {
  revokeDeletionTombstone,
  revokeCanvasTombstonesForProjectStrict,
  getCanvasTombstoneIdsForProject,
  getPendingProjectDeletionRollbackIds,
  markProjectDeletionRollbackPending,
  clearDeletionTombstone,
  clearDeletionTombstoneStrict,
  getDeletionTombstones,
} from './deletionTombstones'
import { fromRecord, edgeFromRecord } from '../kernel/mapping'
import type { NodeRecord, EdgeRecord } from '../kernel/records'
import { debugLogger } from '../store/debugLogStore'
import { resolveActiveCanvasAfterArchive } from '../store/archiveSurvivor'
import { toastFeedback } from '../store/toastStore'
import { createFetchServerPersistAdapter, defaultFetch, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'
import type { ChatMessage } from '../store/chatStore'
import type { CanvasDocument } from '../types/mivoCanvas'
import type { Revision, UserStateEntry, RecordEntry } from '../../shared/persist-contract.ts'
// P1(2026-07-16 demo-seed-migration-skip):demo seed 真相源 —— demoScenes 是纯数据(只 import lib/model/types,
// 不引 store),静态 import 无环(防环注释只禁 canvasStore)。用于派生 DEMO_PROJECT_ID_SET 跳过 demo 上迁。
import { DEMO_PROJECT_IDS, DEMO_SCENE_ID_SET } from '../store/demoScenes'

const SOURCE = 'Persist Boot'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// P1(2026-07-16 demo-seed-migration-skip):demo seed 的 project id 集合(从 DEMO_PROJECT_IDS 派生,不手写第二份清单)。
//   D2 上迁跳过 demo —— demo id 全局稳定(project-demo-concept-battlepass 等),per-user owner 下跨 owner 碰撞
//   409 project-exists / 404 unknown-project(首建用户独占 demo id,其余用户每次打开刷 ERROR);且 demo 是种子非
//   用户数据,不该 per-user 上迁。本地 union 仍保留 demo 可见(侧栏种子项目不丢),仅跳过 createProject/createCanvas op 收集。
const DEMO_PROJECT_ID_SET: ReadonlySet<string> = new Set<string>(Object.values(DEMO_PROJECT_IDS))

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

// ── D2 migration-on-boot(2026-07-15):存量本地(IDB)数据 → server 一次性上迁 ──────────────
//
// 真因(lead 已在服务器坐实):生产前端此前跑在 local 持久化模式(persistMode 默认 local,构建时从未
// 设 VITE_MIVO_PERSIST),后端 PG 空库 0 写入;local 模式删项目时画板按设计回落 standalone,表象即
// "删除的项目/画布复活"。真解 = 生产构建默认切 server 持久化(D1:.env.production)+ 存量本地数据
// 一次性上迁(本块)+ 顺手修 #254 遗留的 DELETE in-flight + restoreProject 边缘(D3)。
//
// 时序硬约束:bootPersistWiring server 分支是 `hydrateFromServer → startPersistWriteQueue`(hydrate 在
// 前,队列 singleton 未启动),而 enqueuePersistWrite 首行 `if (!writeQueue) return undefined`(no-op)。
// 故 hydrate 内**不能**直接 enqueue。解:hydrate 检测迁移条件(**marker 未种** + 本地有 local-only)→
// 按资源差集(candidates = 本地 id 不在服务端列表)把 createProject/createCanvas op 收集进
// pendingServerMigrationOps;bootPersistWiring 在 startPersistWriteQueue 之后调 flushServerMigration
// (此时 queue 已启动 → 真 enqueue,combineOps 去重 + idempotencyKey minting 全生效)→ eager drain →
// **drain 后逐 candidate 验证可恢复性——全部可恢复才种 marker(F1;详见 flushServerMigration)**。
//
// onConflict re-hydrate(mid-session)永不命中迁移分支:409 蕴含 marker 已 set(boot flush 后)→
// `!marker` false → 走 else(现行为 replace + pending-create 并集 + union-merge + #254 C 过滤)。迁移只在 boot(marker 未种)触发。
//
// 幂等:marker(localStorage 按 userId 分区)跨 boot 防重迁;combineOps 同 resourceKey 去重防同 boot 内
// 重复 enqueue;差集过滤(已在服务端的 id 不入队)。**F1 marker-seed 时机(2026-07-15 r3 返修,Greptile
// 线程4)**:marker 不在 enqueue 落 IDB 后即种,而在 drain 后验证全部 candidate 可恢复(on server 或 pending
// in durable queue)才种。terminal 残根(部分 create 4xx rejected)→ 不种 marker,下次 boot 差集重收集 +
// combineOps 与 IDB 仍 pending 的首次记录去重(无重复 server 写)+ terminal 记录已离队 → 天然重试。即便
// drain 后、种 marker 前崩 → marker 仍未种 + 本地 union 仍在(不丢),下次 boot 再收集,安全。
//
// **差集迁移 vs 旧版「server 空才迁」(Greptile 线程1 数据丢失修复)**:旧版迁移只在 `projects.length===0`
// 触发,多设备用户第二台浏览器首启时服务端已非空 → else 整替换 store.projects → 本地独有(legacy local 模式)
// 项目消失 + zustand persist 回写 = 永久丢失。新版迁移开关从「server 空」改为「marker 未种」:`!marker` 时
// 无论 server 空或非空,setState = C 过滤后服务端列表 ∪ candidates(local-only 保留可见,正在上迁)+ 为
// candidates 收集 create op。已知有界局限(代码注释 + PR body):某浏览器首启若发生在「用户已在别处删除某项目」
// 之后,差集迁移会把该项目重新建回(复活)——窗口仅每浏览器首启一次,与「永久丢数据」相比取复活(可再删,可恢复);
// marker 种下后不再发生。marker set → 现行为(server 真值 replace + C 过滤 + **F2 pending-create 并集保护**;
// 线程1 场景在 marker 后收敛)。**F2(线程4)**:marker 已种但 creates 仍 pending 于队列时刷新,纯 replace 会丢
// pending creates + persist 回写永久丢失;修:replace 并集本地 pending-create projects(canvas union-merge 已保留 local-only,不动)。
const pendingServerMigrationOps: WriteOp[] = []

// P1-1(2026-07-16 demo-seed-migration-skip):hydrate 收集健康标志——listProjects+listCanvas 均未抛才 true。
//   纯 demo 工作区(候选全被 DEMO_PROJECT_ID_SET 滤除)→ 0 op → flush 需种 marker 收敛(否则每 boot 重收集/
//   过滤/log 刷屏;demo 不上迁但 marker 必种示"迁移完成=无需迁")。但 hydrate 收集失败(list 抛,退化 local/demo)
//   → 不知有无 local-only 候选 → 不种(失败路径语义不变:下次 boot 重试,不盲种致用户数据永久滞留 local)。
//   hydrat 内 reset=true,step1/step2 catch 置 false;flush 0-op 分支消费。onConflict re-hydrate 也置位但
//   boot 已过不消费(boot 单次 await hydrateFromServer 后即读,无并发)。
let migrationCollectionOk = false

/** marker 物理 key(按 userId 分区;anonymous namespace 与 authenticated 互不可见,同 persistUserId)。 */
const migrationMarkerKey = (userId: string): string => `mivo:server-migration:${userId}`

/** 本 userId 是否已种过迁移 marker(跨 boot 防重迁)。localStorage 不可用(SSR/纯 Node)→ false(不迁)。 */
const isServerMigrationMarkerSet = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(migrationMarkerKey(getPersistUserId())) !== null
  } catch {
    return false
  }
}

/** 种 marker(迁移 op enqueue 落地后调;localStorage 不可用 → warn,不影响 IDB 已落地的 op)。 */
const seedServerMigrationMarker = (): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(migrationMarkerKey(getPersistUserId()), 'done')
  } catch (error) {
    debugLogger.warn(SOURCE, `migration marker seed failed (localStorage): ${msg(error)}`)
  }
}

/** 测试/HMR 清理:清所有 userId 的迁移 marker(防跨测试泄漏;localStorage 不可用 → no-op)。 */
const clearAllServerMigrationMarkers = (): void => {
  try {
    if (typeof localStorage === 'undefined') return
    const prefix = 'mivo:server-migration:'
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {
    /* ignore — best-effort cleanup */
  }
}

/**
 * D2:flush hydrate 收集的迁移 op(bootPersistWiring 在 startPersistWriteQueue 之后调)。
 * queue singleton 此时已启动 → enqueuePersistWrite 真 enqueue(combineOps 去重 + overflow +
 * idempotencyKey 全生效);eager drain 让上迁即时发出(不等 5s timer)。失败 fail-visible:enqueue
 * 失败经 enqueuePersistWrite 内 debugLogger.error;drain 终态失败(rejected/terminal)经 writeRetryQueue
 * drain switch debugLogger.error + recordTerminal 留账(docs/development-logging.md,不静默)。
 * 成功/跳过路径亦打 log(D4)。
 *
 * **F1 marker-seed 时机(2026-07-15 r3 返修,Greptile 线程4 数据丢失残根)**:marker 不再在 enqueue
 * 落 IDB 后即种,而是 **drain 完成后逐 candidate 做可恢复性验证——全部可恢复才种**。否则若部分
 * create 终态失败(如 p2 4xx rejected,p1 成功),enqueue 后即种 marker → 下次 boot server 非空 +
 * marker 已种 → 走 replace 分支丢 p2 + zustand persist 回写永久丢失。修:drain 后重新拉取
 * adapter.listProjects/listCanvas + getPendingCreateResourceIds,对每个 candidate id 判定——
 * 在服务端(drain 成功)或仍在队列 pending(durable,后续 timer drain)均算"可恢复";既不在服务端
 * 也不在队列 = 终态失败 → 本轮**不种 marker**(下次 boot 差集重收集,combineOps 与残留记录去重,
 * 天然重试)+ debugLogger.error 出声(D4)。全部可恢复 → 种 marker。
 *
 * 注:即使 drain 后、种 marker 前崩 → marker 仍未种 + 本地 union 仍在(不丢);下次 boot 再收集时
 * combineOps 与 IDB 仍 pending 的首次记录去重(无重复 server 写);首次记录已 drain 成功 → server 非空
 * → 下次 boot 不进迁移分支。安全(与旧版 enqueue-后-即种 相同的崩溃安全,但堵住了 terminal 残根)。
 *
 * @param adapter 与 hydrate 同源 adapter(bootPersistWiring 传入,不另起获取通道);测试注入 fake。
 * @param collectionOk 本次 boot 的收集健康结果(bootPersistWiring 显式快照传入;不复读 module-global
 *   migrationCollectionOk 做判定源——避免 onConflict rehydrate 在 drain 期间覆写本次 boot 结果)。两个 marker
 *   seed 点(0-op 与 >0-op allRecoverable)统一要求 collectionOk===true 才种(详见函数体 P1 r5 段)。
 */
const flushServerMigration = async (
  adapter: ReturnType<typeof getServerPersistAdapter> = getServerPersistAdapter(),
  // P1 r5(2026-07-16 二轮终审 P1):本次 boot 收集健康快照,由 bootPersistWiring 显式传入(不复读 module-global
  //   migrationCollectionOk 做判定源——避免 onConflict rehydrate 在 drain 期间覆写本次 boot 结果)。两个 marker
  //   seed 点(0-op 与 >0-op allRecoverable)统一要求 collectionOk===true 才种:收集不健康(step1/step2 任一
  //   list 抛 → 部分 candidate 未收集)即便已收集的 candidate 全 drain 成功也不种 marker,否则下次 boot marker
  //   已种跳迁移 → 未收集侧永久滞留 local(真实数据丢失)。已收集的 partial ops 照常 enqueue/drain(数据能上
  //   多少上多少);marker 不种 → 下次 boot 重收集,combineOps 去重无重复 server 写,补齐漏掉侧 + collectionOk=true
  //   后才种。测试入口 __flushServerMigrationForTest 不传时默认取当前 global(测试无 onConflict mid-flush 覆写,安全)。
  collectionOk: boolean = migrationCollectionOk,
): Promise<void> => {
  const ops = pendingServerMigrationOps.splice(0)
  if (ops.length === 0) {
    // P1-1(2026-07-16 demo-seed-migration-skip):0 op = pure demo(候选全被 DEMO_PROJECT_ID_SET 滤除)/
    //   全量已在服务端(差集空)。收集成功(listProjects+listCanvas 未抛,collectionOk)→ 种 marker 收敛
    //   ("无需迁移=迁移完成"),否则每 boot 重收集/过滤/log 刷屏(demo marker 每 boot 为 null → 重复收集)。
    //   收集失败(任一 list 抛,hydrat 退化 local/demo)→ collectionOk=false → 不种(失败路径语义不变:
    //   不知有无 local-only 候选,不盲种致用户数据永久滞留 local;下次 boot 重试)。marker 已种 → 跳过(幂等)。
    if (collectionOk && !isServerMigrationMarkerSet()) {
      seedServerMigrationMarker()
      debugLogger.log(
        SOURCE,
        `server migration-on-boot: 0 candidate (pure demo or all already on server); marker seeded (collection ok — no re-collect next boot)`,
      )
    } else if (!collectionOk) {
      // P1 r5:0 op 但收集不健康(某 list 抛)→ 不种 marker(下次 boot 重收集;本轮无 partial op 可 drain)。
      debugLogger.log(
        SOURCE,
        `server migration-on-boot: 0 candidate but collection was partial (a hydrate list step threw); marker NOT seeded (next boot re-collects)`,
      )
    }
    return
  }
  // F1:capture candidate ids for post-drain recoverability verification(marker-seed 前置数据)。
  const projectCandidates: string[] = []
  const canvasCandidates: string[] = []
  for (const op of ops) {
    if (op.kind === 'createProject') {
      const id = (op as { id?: string }).id
      if (id) projectCandidates.push(id)
    } else if (op.kind === 'createCanvas') {
      canvasCandidates.push(op.canvasId)
    }
  }
  let enqueued = 0
  for (const op of ops) {
    const p = enqueuePersistWrite(op, { migration: true })
    if (p === undefined) {
      // queue 未启动(不应发生 — bootPersistWiring 刚 startPersistWriteQueue)→ fail-visible。
      debugLogger.error(
        SOURCE,
        `migration enqueue no-op (queue undefined) for ${op.kind} ${op.kind === 'createProject' ? (op as { id?: string }).id ?? (op as { name: string }).name : (op as { canvasId: string }).canvasId}; op NOT uploaded`,
      )
      continue
    }
    try {
      await p // 等 IDB putWrite 落地(durable)
      enqueued++
    } catch {
      // enqueuePersistWrite 内已 debugLogger.error 吞 + 记;此处不重记(避免双 log)
    }
  }
  debugLogger.log(
    SOURCE,
    `server migration-on-boot: ${enqueued}/${ops.length} op(s) enqueued; draining eagerly before marker verification`,
  )
  // eager drain:让迁移 op 即时发出(不等 5s timer);drain 终态失败由 drain switch fail-visible。
  try {
    await drainPersistQueue()
  } catch (error) {
    debugLogger.warn(SOURCE, `migration eager drain failed: ${msg(error)} (ops remain in IDB queue; next timer drain will retry)`)
  }
  // F1:post-drain 可恢复性验证——全部 candidate 可恢复(on server 或 pending in durable queue)才种 marker。
  //   terminal 残根(如 4xx rejected)→ 既不在服务端也不在队列 → 不种 marker + error 出声;下次 boot 差集
  //   重收集 + combineOps 去重 + terminal 记录已离队 → 天然重试(不重复 server 写)。堵"enqueue 后即种
  //   marker → 下次 boot replace 丢 terminal-failed local + persist 回写永久丢失"残根。
  let allRecoverable: boolean
  try {
    allRecoverable = await verifyMigrationCandidatesRecoverable(adapter, projectCandidates, canvasCandidates)
  } catch (error) {
    // 验证拉取失败(如 adapter 瞬时不可用)→ fail-closed:不种 marker,下次 boot 重验(ops 已 durable 入队,
    //   不丢;下次 boot 差集重收集时 on-server 的 id 不再候选,无重复 server 写)。
    debugLogger.warn(SOURCE, `migration recoverability verification failed: ${msg(error)}; marker NOT seeded (fail-closed; next boot re-verifies)`)
    allRecoverable = false
  }
  if (allRecoverable && collectionOk) {
    seedServerMigrationMarker()
    debugLogger.log(
      SOURCE,
      `server migration-on-boot: all ${projectCandidates.length + canvasCandidates.length} candidate(s) recoverable (on server or pending in durable queue); collection ok; marker seeded`,
    )
  } else if (allRecoverable && !collectionOk) {
    // P1 r5(2026-07-16 二轮终审 P1):收集不健康(step1/step2 任一 list 抛 → 部分 candidate 未收集)→ 即便
    //   已收集的 candidate 全 drain 成功(allRecoverable)也不种 marker。修前 >0-op 分支只看 allRecoverable →
    //   种 marker → 下次 boot marker 已种跳迁移 → 未收集侧(如 step2 抛致 canvas 未收集)永久滞留 local
    //   (真实数据丢失)。已收集的 partial ops 照常 drain(数据能上多少上多少);marker 不种 → 下次 boot 重收集,
    //   combineOps 去重无重复 server 写,补齐漏掉侧 + collectionOk=true 后才种。
    debugLogger.log(
      SOURCE,
      `server migration-on-boot: ${projectCandidates.length + canvasCandidates.length} candidate(s) recoverable but collection was partial (a hydrate list step threw — some candidates not collected); marker NOT seeded (next boot re-collects the missing side; partial ops already drained)`,
    )
  }
  // 其余(allRecoverable===false):marker deliberately NOT seeded this round(verifyMigrationCandidatesRecoverable
  //   已 per-failure error 留痕;下次 boot 差集重收集 + 天然重试)。
}

/**
 * F1:drain 后逐 candidate 验证可恢复性。candidate 可恢复 = 在服务端(drain 成功)或仍在 durable 队列
 * pending(后续 timer drain 重试)。既不在服务端也不在队列 = 终态失败(rejected/terminal 已 recordTerminal
 * 离队)。terminal-failed candidate → 返 false + debugLogger.error(D4,不静默)。空 candidate(无迁移 op)
 * → true(marker 正常种)。
 */
const verifyMigrationCandidatesRecoverable = async (
  adapter: ReturnType<typeof getServerPersistAdapter>,
  projectCandidates: string[],
  canvasCandidates: string[],
): Promise<boolean> => {
  if (projectCandidates.length === 0 && canvasCandidates.length === 0) return true
  const [{ projects }, { canvases }, pendingProjectCreates, pendingCanvasCreates] = await Promise.all([
    adapter.listProjects(),
    adapter.listCanvas(),
    getPendingCreateResourceIds('createProject'),
    getPendingCreateResourceIds('createCanvas'),
  ])
  const serverProjectIds = new Set(projects.map((p) => p.id))
  const serverCanvasIds = new Set(canvases.map((c) => c.id))
  let failed = 0
  // P1-4(2026-07-16 demo-seed-migration-skip,lead P3 收窄裁定):此处 ERROR 保留不降级——P3 的 WARN+不
  //   toast 仅适用于 queue 层([migration] op terminal,writeRetryQueue drain switch 的 termLog);本 verifier
  //   只会见到真实 uuid 候选的迁移失败(D2 收集层已用 DEMO_PROJECT_ID_SET 滤除 demo seed,纯 demo 不产生
  //   candidate → 永不进此 verifier)。真实候选 terminal 失败 = "用户数据没上 server"的正当 fail-visible,
  //   ERROR 出声 + 不种 marker 下次 boot 重试,不降级(否则静默丢用户数据)。既有 SC-J 测试(本路径)保持。
  for (const id of projectCandidates) {
    if (serverProjectIds.has(id)) continue // drain 成功 → 在服务端
    if (pendingProjectCreates.has(id)) continue // 仍 pending in durable queue → 后续 timer drain
    failed++
    debugLogger.error(
      SOURCE,
      `migration candidate createProject ${id} terminally failed (neither on server nor pending in durable queue); marker NOT seeded this boot — next boot will re-collect and retry`,
    )
  }
  for (const id of canvasCandidates) {
    if (serverCanvasIds.has(id)) continue
    if (pendingCanvasCreates.has(id)) continue
    failed++
    debugLogger.error(
      SOURCE,
      `migration candidate createCanvas ${id} terminally failed (neither on server nor pending in durable queue); marker NOT seeded this boot — next boot will re-collect and retry`,
    )
  }
  return failed === 0
}

/** 测试用:驱动迁移 flush(等价 bootPersistWiring 在 startPersistWriteQueue 后调 flush;adapter 同源注入)。 */
export const __flushServerMigrationForTest = flushServerMigration

/**
 * G1-a P1-1:非画布域 mutation enqueue 出口。store mutation(set 后)调此。
 * - local(默认):writeQueue undefined → 立即 return(零副作用,表征测试不红)。
 * - server/shadow:enqueue 到 writeRetryQueue(IDB 持久化意图 + timer drain → executor → BFF)。
 *   网络失败记录留存 + 退避重试;断网恢复后 drain。
 * fire-and-forget(mutations 不 await);返回 promise 供测试 flush/drain;enqueue 失败 debugLogger.error(不静默)。
 */
export const enqueuePersistWrite = (op: WriteOp, opts?: { migration?: boolean }): Promise<void> | undefined => {
  if (!writeQueue) return undefined // local inert OR queue 未启动
  // Phase 1 项4(复活加固):createProject/createCanvas 是 restore 路径(restoreProject / 同 id createCanvas)的
  //   tombstone 撤销点 —— 删除→立即恢复的资源必须撤销 tombstone,否则恢复的资源被 hydrate 永久隐藏(比复活
  //   更糟)。revoke 在此单点覆盖所有 create 路径(restoreProject / renameCanvas-no-metaRevision / moveCanvas-no-
  //   metaRevision / duplicateCanvas);全新 id 无 tombstone → revoke 幂等 no-op silent(不 log,防刷屏)。migration
  //   op 跳过(D2 上迁候选为 local-only,从未删除,无 tombstone;省 N 次 IDB delete 噪声)。fire-and-forget
  //   (不 await,不阻断 enqueue);失败 best-effort warn,不阻断业务。local 模式上方 return 已短路,永不达此。
  if (!opts?.migration) {
    if (op.kind === 'createProject' && op.id !== undefined) {
      void revokeDeletionTombstone('project', op.id).catch((e) =>
        debugLogger.warn(SOURCE, `tombstone revoke failed (createProject ${op.id}): ${msg(e)}`),
      )
    } else if (op.kind === 'createCanvas') {
      void revokeDeletionTombstone('canvas', op.canvasId).catch((e) =>
        debugLogger.warn(SOURCE, `tombstone revoke failed (createCanvas ${op.canvasId}): ${msg(e)}`),
      )
    }
  }
  const p = writeQueue.enqueue(op, opts).then(
    () => {},
    (error) => {
      // P3:migration enqueue 失败也属后台 seed 迁移噪声,降 WARN;真实用户 mutation enqueue 失败保持 ERROR。
      const log = opts?.migration
        ? (m: string) => debugLogger.warn(SOURCE, `[migration] ${m}`)
        : (m: string) => debugLogger.error(SOURCE, m)
      log(`enqueue failed (${op.kind}): ${msg(error)}; local set 已生效,服务端可能滞后(队列恢复后补发)`)
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
  // D2:清迁移收集状态 + 所有 userId marker(逐 test 隔离;防跨 test marker 泄漏致下一 test 误跳迁移)。
  pendingServerMigrationOps.length = 0
  migrationCollectionOk = false
  clearAllServerMigrationMarkers()
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
  // P1 附带降噪:demo scene 的 chat 不走 server hydrate —— demo canvas 不上迁(P1),server 上无该 owner 的
  //   demo canvas,listChatMessages 必 404 → 每 boot WARN 刷屏。demo chat 是种子(本地 IDB 有),跳过 server
  //   hydrate 留本地即可(与 local 模式一致,无丢失)。覆盖所有调用点(block 4 active hydrate + backfillChatAfterDrain)。
  //   P1-3:用完整 DemoSceneId 集合(DEMO_SCENE_ID_SET,6 个 scene)做真相源,非 DEMO_SCENE_PROJECT_MAP
  //   (仅 4 个挂项目的 grouped scene)——否则 standalone 的 task-states/empty 漏判 → 每 boot 打 server 404。
  if (DEMO_SCENE_ID_SET.has(sceneId)) {
    debugLogger.log(SOURCE, `hydrate chat for scene ${sceneId} skipped (demo scene — not migrated to server, chat stays local seed)`)
    return
  }
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
  // A2-S3 block 8:hydrate 写了 canvases[sceneId].nodes/edges,顶层 state.nodes/edges 须同步
  // (否则 loadScene 在 fetch 完成前拍的空 document 留顶层,用户看到空画布;docNodesLength>0
  // 但 topLevelNodesLength=0)。refresh 复用 loadScene 拍平逻辑只刷 nodes/edges(不碰 selection/
  // history/activeTool/viewport);race(active ≠ sceneId,fetch 完成时已切走)由 refresh 内 gate
  // 拦(不动顶层,内容留 canvases[sceneId] 切回 loadScene 自然拍平)。
  useCanvasStore.getState().refreshActiveCanvasContent(sceneId)
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

  // active-child rollback 的 durable retry marker 必须先于普通 tombstone 过滤处理。成功后清 project/
  // cascade canvas tombstone,让本轮常规 hydrate 继续以 server 真值收敛；失败保留 marker,下次 hydrate 再试。
  const rollbackProjectIds = await getPendingProjectDeletionRollbackIds()
  for (const projectId of rollbackProjectIds) {
    try {
      const result = await reconcileActiveChildDeleteRejection(projectId, adapter)
      // project tombstone/rollbackPending 是最后的 durable commit token：child 全部严格清理成功后才消费。
      await revokeCanvasTombstonesForProjectStrict(projectId)
      await clearDeletionTombstoneStrict('project', projectId)
      debugLogger.warn(
        SOURCE,
        result.kind === 'authoritatively-deleted'
          ? `hydrate retried active-child rollback for ${projectId}: project and children authoritatively absent, marker cleared`
          : `hydrate retried active-child rollback for ${projectId}: authoritative reconcile restored local state, marker cleared`,
      )
    } catch (error) {
      debugLogger.warn(SOURCE, `hydrate retried active-child rollback for ${projectId}: still failed, marker retained: ${msg(error)}`)
    }
  }

  // D2 migration-on-boot:迁移 marker(按 userId 分区;boot 防重迁)。onConflict re-hydrate 时
  //   marker 已 set(boot flush 后)→ 跳迁移;且 onConflict 蕴含 server 非空 → 迁移分支(server 空)
  //   本就不命中。一次 hydrate 调用内 step1/step2 共用此快照(不重复读 localStorage)。
  const migrationMarkerSet = isServerMigrationMarkerSet()
  // P1-1:乐观置 true;step1/step2 的 list 调用任一抛 → 对应 catch 置 false(收集不健康 → flush 0-op 不盲种 marker)。
  migrationCollectionOk = true

  // 1. project 全量(非画布域,完全在 G1-a 范围)——按 marker 决定 union 差集迁移 or 服务端真值 replace。
  //    P1 bug fix(delete-resurrection)C:差集过滤 pending-delete project id —— DELETE 还在
  //    writeRetryQueue 未 drain 时服务端仍 LIVE,直接 replace/union 会把已删 project 灌回本地(复活)。
  //    读 IDB pending deleteProject id 集合(boot hydrate 前 queue 未 start 也可读 IDB 真值;onConflict
  //    re-hydrate 复用同一过滤),从服务端结果摘除,永不灌回"本地已排队删、尚未 drain"的记录。
  //
  //    D2 差集迁移(Greptile 线程1 数据丢失修复):`!marker` 时 candidates = 本地 id 不在服务端列表(差集;
  //    服务端空→差集=全量本地,与旧版一致)。setState = C 过滤后服务端列表 ∪ candidates(local-only 保留
  //    可见,正在上迁——旧版服务端非空时整替换丢 local-only → zustand persist 回写永久丢失,此为该 bug 的修);
  //    为 candidates 收集 createProject op(已在服务端的 id 不重复入队 SC-G)。**keep-local 与 enqueue 解耦**:
  //    即便迁移 terminal 失败,本地 union 仍在(不丢);marker flush 后种。不复活:server 模式删项目时 store
  //    已乐观移除,本地 candidates 均为 live,不经 pending-delete 过滤(同旧版迁移分支)。
  //    marker set → 现行为(server 真值 replace + C 过滤 + **F2 pending-create 并集保护**;线程1 场景在 marker 后收敛 SC-H)。
  //    **F2(2026-07-15 r3 返修,Greptile 线程4)**:marker 已种但 creates 仍 pending 于队列时刷新页面,纯 replace
  //    会丢 local-only pending creates + zustand persist 回写永久丢失。修:replace 时并集本地 pending-create
  //    projects(对称于 C pending-delete 过滤;canvas 侧 union-merge 本就保留 local-only,无需动)。
  //    "keep-local 解耦不丢"在 marker-set 分支的适用范围 = 仅 pending-create 集合(!marker 分支 = 全 local-only 差集)。
  try {
    const [{ projects }, pendingDeleteProjectIds, pendingCreateProjectIds, tombstoneProjectIds] = await Promise.all([
      // CR-8(Phase 2 归档跨设备 hydrate):includeArchived=true 拉含归档项(active+archived),否则"另一设备已归档"
      //   的 project 不在 server 列表(默认 active-only 过滤)→ 本地 active 副本经 union 保留 → 跨设备归档不生效。
      //   拉全量后 filteredProjects(server 真值含 status:archived)经 union 替换本地 → server 归档态覆盖本地 active。
      adapter.listProjects({ includeArchived: true }),
      getPendingDeleteResourceIds('deleteProject'),
      getPendingCreateResourceIds('createProject'),
      getDeletionTombstones('project'),
    ])
    // C 差集过滤 pending-delete(DELETE 未 drain 服务端仍 LIVE,不灌回 = 反复活)+ Phase 1 项4 tombstone 并集过滤
    //   (DELETE 离队——重试耗尽 terminal / 队列溢出驱逐——后 pending-delete 失效,tombstone 接力挡复活;
    //   tombstone 写入点在 store delete action,与队列记录生死解耦,覆盖溢出驱逐路径)。两者取并集过滤。
    const filteredProjects = (pendingDeleteProjectIds.size === 0 && tombstoneProjectIds.size === 0)
      ? projects
      : projects.filter((p) => !pendingDeleteProjectIds.has(p.id) && !tombstoneProjectIds.has(p.id))
    const localProjects = useCanvasStore.getState().projects
    if (!migrationMarkerSet) {
      // 首启 marker 未种:差集迁移。candidates = 本地 id 不在服务端列表(服务端空→全量本地,与旧版一致)。
      const serverProjectIds = new Set(projects.map((p) => p.id))
      const candidates = localProjects.filter((p) => !serverProjectIds.has(p.id))
      // 服务端非空:setState = C 过滤后服务端列表 ∪ candidates(local-only 保留,正在上迁)。
      //   服务端空:filteredProjects=[] ∪ candidates(=全量本地)→ 保留本地(与旧版 keep-local 一致),
      //   跳过 setState 避免无谓 persist 回写(op 已下方收集)。
      if (projects.length > 0) {
        useCanvasStore.setState({ projects: [...filteredProjects, ...candidates] })
      }
      // P1:demo seed project 不上迁 —— demo id 全局稳定,跨 owner 碰撞 409 project-exists(首建用户独占),
      //   且 demo 是种子非用户数据。union 仍保留 demo 本地可见(侧栏种子项目不丢),仅跳过 createProject op 收集。
      let skippedDemoProjects = 0
      for (const p of candidates) {
        if (DEMO_PROJECT_ID_SET.has(p.id)) { skippedDemoProjects++; continue }
        pendingServerMigrationOps.push({ kind: 'createProject', name: p.name, id: p.id })
      }
      const demoProjNote = skippedDemoProjects > 0 ? `; ${skippedDemoProjects} demo seed project(s) skipped (not migrated — global id collides cross-owner 409; kept local)` : ''
      debugLogger.log(
        SOURCE,
        `server hydrate: ${filteredProjects.length} server project(s)${candidates.length > 0 ? ` + ${candidates.length} local-only candidate(s) kept (union; createProject ops collected for migration-on-boot${demoProjNote})` : ' (replaced local)'}${projects.length === 0 && localProjects.length > 0 ? ' [server empty, local retained]' : ''}`,
      )
    } else {
      // marker 已种 → 现行为(服务端真值 replace + C 过滤)+ F2 pending-create 并集保护。
      if (projects.length === 0 && localProjects.length > 0) {
        // server 空 + 本地有(marker set = 曾迁移;creates 在 IDB queue pending 或 terminal 失败)→ 保留本地,
        //   不 re-enqueue(marker)。pending creates 经 queue timer drain;terminal 失败 fail-visible(D4)。
        debugLogger.log(
          SOURCE,
          `server hydrate: server empty + ${localProjects.length} local project(s) but migration marker set → keep local, skip re-enqueue (prior migration pending/failed; queue drains pending)`,
        )
      } else {
        // F2:replace = C 过滤后服务端列表 ∪ 本地 pending-create projects(防 marker 已种 + creates 仍 pending
        //   时刷新丢;已在服务端的 id 不重复加,防 double)。
        // Phase 1 项1(2026-07-16 丢项目制造者修复,CR-1):replace 时额外并集本地仍存在的 DEMO_PROJECT_ID_SET
        //   项目(对称于 :700-706 !marker 分支的 demo 保护)。根因:demo seed 的 createProject op 在 !marker
        //   分支 :704 被 skip(不上迁),故 demo 既不在服务端 filteredProjects 也不在 localPendingCreates →
        //   marker-set replace 把 demo 从 store.projects 丢弃 → zustand persist 回写 → 下次 boot demo 项目消失
        //   + 其画布成 orphan projectId(项2 已停清,但 demo 项目本身丢了)。并集保留 demo(侧栏种子项目不丢),
        //   去重(不与 filteredProjects/localPendingCreates 的 id 重复,防 double)。保持 F2 pending-create 并集
        //   与 C pending-delete 过滤不回退。
        const filteredIds = new Set(filteredProjects.map((p) => p.id))
        const localPendingCreates = pendingCreateProjectIds.size === 0
          ? []
          : localProjects.filter((p) => pendingCreateProjectIds.has(p.id) && !filteredIds.has(p.id))
        const retainedIds = new Set<string>([...filteredIds, ...localPendingCreates.map((p) => p.id)])
        // Phase 1 Fix 2(双审对称缺口,2026-07-16):retainedDemoProjects 须排除 tombstone/pending-delete(对称于上游
        //   filteredProjects 排除两者),防极窄边缘(localStorage 丢失重灌 demo seed + IDB tombstone 存活)下
        //   复活已删 demo 项目。tombstoneProjectIds/pendingDeleteProjectIds 在 step1 作用域内(上方 Promise.all)。
        const retainedDemoProjects = localProjects.filter(
          (p) =>
            DEMO_PROJECT_ID_SET.has(p.id) &&
            !retainedIds.has(p.id) &&
            !tombstoneProjectIds.has(p.id) &&
            !pendingDeleteProjectIds.has(p.id),
        )
        useCanvasStore.setState({ projects: [...filteredProjects, ...localPendingCreates, ...retainedDemoProjects] })
        const droppedProjects = projects.length - filteredProjects.length
        debugLogger.log(
          SOURCE,
          `server hydrate: ${filteredProjects.length} project(s) from BFF (replaced local${droppedProjects > 0 ? `; ${droppedProjects} filtered as pending-delete not-yet-drained (anti-resurrection)` : ''}${localPendingCreates.length > 0 ? `; ${localPendingCreates.length} local pending-create(s) retained (anti-drop F2)` : ''}${retainedDemoProjects.length > 0 ? `; ${retainedDemoProjects.length} demo seed project(s) retained (anti-drop 项1 — not migrated, kept local)` : ''})`,
        )
      }
    }
  } catch (error) {
    migrationCollectionOk = false // P1-1:listProjects 抛 → 收集不健康 → flush 0-op 不盲种 marker(下次 boot 重试)
    debugLogger.error(SOURCE, `listProjects hydrate failed: ${msg(error)} (degrade to local/demo state)`)
  }

  // 2. canvas meta 列表 → 合并进 store.canvases(R2 F2:不再 only-log)。全量 content hydrate
  //    (fetchCanvas + RecordEntry→NodeRecord)属 G1-c defer —— 此处只 merge meta(title/projectId/
  //    metaRevision/contentVersion/updatedAt),本地 content(nodes/edges/tasks)保留;服务端有但本地
  //    无的 canvas 插入 meta-stub(content 空,G1-c 补 content);本地有但服务端无的保留(pending create /
  //    demo,G1-c reconcile)。active sceneId 的 meta 刷新但其 flattened nodes/edges 不动(content 不变)。
  try {
    const [{ canvases }, pendingDeleteCanvasIds, tombstoneCanvasIds] = await Promise.all([
      // CR-8:includeArchived=true 拉含归档画布(同 step1 project);下方 union-merge 用 server meta.status
      //   reconcile 本地 status(server 归档态覆盖本地 active → 跨设备归档生效)。
      adapter.listCanvas(undefined, { includeArchived: true }),
      getPendingDeleteResourceIds('deleteCanvas'),
      getDeletionTombstones('canvas'),
    ])
    // P1 bug fix(delete-resurrection)C + Phase 1 项4:差集过滤 pending-delete canvas id(DELETE 未 drain 服务端
    //   仍 LIVE,union-merge 会灌回 = 复活)+ tombstone 并集过滤(同 step1 project;canvas 侧复活同理,
    //   tombstone 接力挡离队后的复活)。摘除后再 merge(同 step1 project)。
    const serverCanvases = (pendingDeleteCanvasIds.size === 0 && tombstoneCanvasIds.size === 0)
      ? canvases
      : canvases.filter((m) => !pendingDeleteCanvasIds.has(m.id) && !tombstoneCanvasIds.has(m.id))
    const localCanvases = useCanvasStore.getState().canvases
    const localCanvasEntries = Object.entries(localCanvases)
    // D2 差集迁移:`!marker` 时为 local-only candidates(本地有 projectId 且 id 不在服务端列表)收集 createCanvas
    //   meta op。union-merge(下方)本就保留 local-only canvas(content 不丢),store 侧无额外动;此块只补 op 收集。
    //   **修线程1 canvas 侧:服务端非空 + 无 marker 时旧版只 union-merge 保留 local-only 但漏迁(永不 enqueue 上传)
    //   → 本修复补差集 op(已在服务端的 id 不重复入队 SC-G)。** 服务端空:差集=全量本地(与旧版一致);
    //   无 projectId 跳过计数(demo,不可迁,createCanvas op projectId 必填),与旧版一致。
    //   **content gap(V1)**:createCanvas op 只带 meta(canvasId/projectId/title),不带 nodes/edges。
    //   画布 content 写走 upsertNode/upsertEdge(画布域),G1-a executor 返 unsupported-retained(deferred
    //   等 G1-c);migrateLegacyOp 把 upsertNode 映 legacy-envelope 但受 LEGACY_DRAIN gate(默认关)→ gate-blocked
    //   留存不 drain。故 V1 无现成可 drain 的 content 上迁通道 → content 不迁,保留本地(union-merge 仍保留
    //   本地 content;不静默丢,在此明示)。G1-c 接线后补 content 上迁。
    //   sourceTemplateId 是客户端 DemoSceneId 域(hydrate 不从服务端 string 覆盖),迁移 op 不带它(无 loss:
    //   本地保留,服务端无该字段不影响)。
    let migrationCanvasCandidates = 0
    let gapNoProject = 0
    let skippedDemoCanvases = 0
    // Phase 1 项3(2026-07-16 orphan-parent 跳收集,CR-2,与项2 停清 projectId 配套):停清后(项2),
    //   projectId 指向"不在服务端列表且不在本地 candidates 集"项目的画布,会在下方被收集成 createCanvas op
    //   → 服务端无此 project → 404 unknown-project terminal → F1(:280-311)永不种 marker → 每 boot 重收集 +
    //   ERROR 死循环。下方在 demo 判断后、push op 前加 parent 可迁性判定,parent 不可迁 → 跳过 + 此计数。
    let skippedOrphanParent = 0
    if (!migrationMarkerSet && localCanvasEntries.length > 0) {
      const serverCanvasIds = new Set(canvases.map((m) => m.id))
      // parent 可迁集 = store.projects 的 id(step1 setState 后 = 服务端 live ∼ local candidates,即"迁移后将
      //   存在于服务端的项目集";服务端 live 已含于 filteredProjects,local candidates 正在上迁)。parent 不在此
      //   集 = 既不在服务端也不在本地候选 → 不可迁,其画布跳过(不 push 注定 404 的 createCanvas op)。
      //   注:step1 的 `projects` 来自项目侧 try 块,跨 try 作用域不可直访;此处用 store 真值更稳妥且 step1
      //   setState 已同步生效(zustand set 同步)。step1 抛(部分收集)→ store.projects=本地全量(降级假设:
      //   全 local 视作候选),marker 不种(collectionOk=false)→ 下次 boot 重收集,404 风险为既有 partial 边缘,
      //   非本改引入。
      const migratableParentIds = new Set(useCanvasStore.getState().projects.map((p) => p.id))
      for (const [id, doc] of localCanvasEntries) {
        if (serverCanvasIds.has(id)) continue // 已在服务端,不重复入队(SC-G)
        if (!doc.projectId) {
          // demo/无 projectId canvas 无法 createCanvas(op projectId 必填)→ 跳过,fail-visible 计数。
          gapNoProject++
          continue
        }
        // P1:demo scene canvas(其 projectId 属 demo project)不上迁 —— server 上无该 owner 的 demo canvas,
        //   createCanvas 会撞 404 unknown-project(非 member);demo 是种子,本地保留即可。
        if (DEMO_PROJECT_ID_SET.has(doc.projectId)) { skippedDemoCanvases++; continue }
        // Phase 1 项3:parent 不可迁(不在服务端列表且不在本地候选集)→ 跳过,fail-visible 计数(同
        //   gapNoProject/skippedDemoCanvases 模式),不 push 注定 404 unknown-project 的 createCanvas op。
        //   画布留本地(union-merge :840-843 保留 local-only),marker 不被它拖住(F1 正常种)。
        if (!migratableParentIds.has(doc.projectId)) {
          skippedOrphanParent++
          continue
        }
        pendingServerMigrationOps.push({
          kind: 'createCanvas',
          canvasId: id,
          projectId: doc.projectId,
          title: doc.title,
        })
        migrationCanvasCandidates++
      }
      if (migrationCanvasCandidates > 0 || gapNoProject > 0 || skippedDemoCanvases > 0 || skippedOrphanParent > 0) {
        debugLogger.log(
          SOURCE,
          `server hydrate: ${localCanvasEntries.length} local canvas(s) → migration-on-boot (createCanvas meta ops collected for ${migrationCanvasCandidates} local-only candidate(s)${gapNoProject > 0 ? `; ${gapNoProject} skipped (no projectId — demo, not migrable)` : ''}${skippedDemoCanvases > 0 ? `; ${skippedDemoCanvases} demo seed canvas(s) skipped (not migrated — would 404 unknown-project cross-owner; kept local)` : ''}${skippedOrphanParent > 0 ? `; ${skippedOrphanParent} orphan-parent canvas(s) skipped (projectId not migratable — not on server nor local candidate; would 404 unknown-project terminal + ERROR loop; kept local)` : ''}; content(nodes/edges) NOT migrated — V1 meta-only gap, retained local — see report)`,
        )
      }
    }
    // union-merge:server canonical 刷 meta + 保留 local-only content(R-7 同语义,store 侧本就保留 local-only)。
    //   服务端空 + 本地有 + `!marker`:merged=本地(无 meta 可刷)→ 跳过 setState(与旧版一致,避免无谓 persist
    //   回写;迁移 op 已上方收集)。其余(含 marker set、服务端非空、服务端空+本地空):走 union-merge setState。
    //   marker set 时曾迁移 creates 仍 pending/terminal → 走 union-merge 保留本地(此分支只挡 `!marker` 首启)。
    if (canvases.length === 0 && localCanvasEntries.length > 0 && !migrationMarkerSet) {
      // server 空 + 本地有 + 首启:保留本地(union 结果=本地,无 meta 可刷),跳过 setState。op 已上方收集。
    } else {
      const serverById = new Map(serverCanvases.map((m) => [m.id, m] as const))
      useCanvasStore.setState((s) => {
        const local = s.canvases
        const merged: Record<string, CanvasDocument> = {}
        for (const meta of serverCanvases) {
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
              // CR-8(Phase 2 归档):status 以 server 为准 reconcile(server archived→archived / 缺省→active),
              //   跨设备归档生效。archivedByCascade 是客户端本地字段(wire 不暴露),保留本地既有值(...existing 带)。
              status: meta.status,
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
              // CR-8:status 以 server 为准(meta.status);新建 stub 无 archivedByCascade(缺省 undefined=非级联归档)。
              status: meta.status,
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
      const droppedCanvases = canvases.length - serverCanvases.length
      debugLogger.log(
        SOURCE,
        `server hydrate: ${serverCanvases.length} canvas meta(s) merged into store.canvases (content hydrate deferred to G1-c; local-only canvases retained${droppedCanvases > 0 ? `; ${droppedCanvases} filtered as pending-delete not-yet-drained (anti-resurrection)` : ''})`,
      )
      const hydratedState = useCanvasStore.getState()
      const resolution = resolveActiveCanvasAfterArchive(hydratedState.canvases, hydratedState.sceneId)
      if (resolution.kind === 'blocked') {
        debugLogger.warn(
          SOURCE,
          `server hydrate: scene ${hydratedState.sceneId} is missing/archived and no active canvas survivor exists; keeping scene unchanged`,
        )
      } else if (resolution.kind === 'switch') {
        const survivor = hydratedState.canvases[resolution.sceneId]!
        useCanvasStore.setState({
          sceneId: resolution.sceneId,
          nodes: survivor.nodes,
          edges: survivor.edges || [],
          tasks: survivor.tasks,
          selectedNodeId: survivor.selectedNodeId,
          selectedNodeIds: survivor.selectedNodeIds || [],
          activeTool: 'select',
          historyPast: [],
          historyFuture: [],
        })
        debugLogger.log(
          SOURCE,
          `server hydrate: reconciled missing/archived scene ${hydratedState.sceneId} → active survivor ${resolution.sceneId}`,
        )
      }
    }
  } catch (error) {
    migrationCollectionOk = false // P1-1:listCanvas 抛 → 收集不健康 → flush 0-op 不盲种 marker(下次 boot 重试)
    debugLogger.warn(SOURCE, `listCanvas hydrate failed: ${msg(error)}`)
  }

  // 2.5 A2-S3 item 4:active canvas 正文拉取 + bundle cursor 构建(content hydrate;现 meta 已 merge,补 content)。
  //    fetchCanvas(active)→ 应用 nodes/edges(R-7 union)+ 构建 bundle cursor(Block 7 edit/delete 用)。走
  //    hydrateCanvasContentIfMissing(去重包装):boot active scene 记入 hydratedSceneIds,切走再切回不双拉。
  //    切 scene re-hydrate 由 block 8 订阅(startSceneHydrationSubscription)处理,此处只 hydrate boot active。
  //    mode gate:仅 server 执行。shadow 恒不 populate canvas content(IDB 读源契约:A3 灰度观察窗前提;
  //    onConflict 路径 writeQueue 在 server/shadow 两分支都调,shadow 下撞 409 经 onConflict →
  //    hydrateFromServer 到此,无 gate 即 populate canvas content 违反 ff91846 不变量 → 故 shadow 跳过)。
  //    local 永不调(bootPersistWiring 第一行 return;onConflict 也不触达——local queue 未启动)。
  //    server onConflict 补 content 保留(权威源正确行为)。失败降级 warn 不阻断。
  try {
    const sceneId = useCanvasStore.getState().sceneId
    if (sceneId && getPersistMode() === 'server') {
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
  // Phase 2 归档:archive/unarchive 同样 bump server revision(status 变更 bump revision/metaRevision),
  //   回灌 fresh base 防下次 strict update(PATCH/PUT rename/move)用陈旧 base → 428/409。status 已由 store action
  //   乐观更新,此处只 reconcile revision(不重复设 status,server 已权威;hydrate 下次亦 reconcile)。
  if (
    op.kind === 'createProject' ||
    op.kind === 'updateProject' ||
    op.kind === 'archiveProject' ||
    op.kind === 'unarchiveProject'
  ) {
    const id = op.kind === 'createProject' ? (op.id ?? null) : op.projectId
    if (!id) return
    if (!state.projects.some((p) => p.id === id)) return
    useCanvasStore.setState((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, revision: rev } : p)),
    }))
  } else if (
    op.kind === 'createCanvas' ||
    op.kind === 'updateCanvas' ||
    op.kind === 'archiveCanvas' ||
    op.kind === 'unarchiveCanvas'
  ) {
    if (!state.canvases[op.canvasId]) return
    useCanvasStore.setState((s) => ({
      canvases: { ...s.canvases, [op.canvasId]: { ...s.canvases[op.canvasId]!, metaRevision: rev } },
    }))
  }
}

/**
 * P1-3(返修):unarchiveProject drain success 后,reconcile 子画布 status 用 server 权威(不猜 archivedByCascade)。
 * 跨设备 hydrate 时 client archivedByCascade=undefined(wire 不回传 provenance)→ 乐观 unarchiveProject 只恢复
 * archivedByCascade===true 的子画布 → undefined 的全留 archived → client 持久错误态(project active 但
 * cascade-archived 子画布仍 archived,用户看到空项目)。缺 provenance 不猜 → 拉 includeArchived canvas meta
 * 用 server status reconcile:server unarchiveProjectTree 已恢复 cascade 子画布(active)、保留 direct(archived)。
 * best-effort:reconcile 失败不阻断 onOutcome(下轮 hydrate 会再 reconcile)。
 *
 * P2 锁测(返修):导出 + 接受注入 adapter(默认 getServerPersistAdapter())——对齐全文件其余 hydrate 函数的注入
 *   模式,使 fresh-device reconcile 可单测(fake adapter.listCanvas 返 cascade→active/direct→archived,断言 reconcile
 *   后 client status 对齐 server)。生产 onOutcome 调用点(行 1212)不传 adapter → 走默认 singleton,行为不变。
 */
export const reconcileProjectCanvasStatus = async (
  projectId: string,
  adapter?: ReturnType<typeof getServerPersistAdapter>,
): Promise<void> => {
  try {
    const a = adapter ?? getServerPersistAdapter()
    const { canvases } = await a.listCanvas(projectId, { includeArchived: true })
    const { useCanvasStore } = await import('../store/canvasStore')
    // P2-1(二审 TOCTOU):reconcile GET 在途时用户再 archiveProject → store project 翻 archived(乐观,archiveProject
    //   action 同步 set)。若仍应用 reconcile(用旧 GET 把 child 覆回 active)会撤销新 archive 意图。守卫:应用前
    //   校验 project 仍 active;否则跳过(stale GET 丢弃,下轮 hydrate 用新 server 真值 reconcile)。
    //   "archive intent" 经 store project.status 捕获(archiveProject action 同步置 archived,无需跨模块 epoch)。
    const state0 = useCanvasStore.getState()
    const project0 = state0.projects.find((p) => p.id === projectId)
    if (project0 && (project0.status ?? 'active') !== 'active') {
      debugLogger.log(
        SOURCE,
        `unarchiveProject ${projectId} reconcile skipped (P2-1 TOCTOU): project status=${project0.status ?? 'active'} (re-archived during GET; stale GET discarded, next hydrate reconciles)`,
      )
      return
    }
    useCanvasStore.setState((s) => {
      let reconciled = 0
      const next = { ...s.canvases }
      for (const meta of canvases) {
        const existing = next[meta.id]
        if (!existing) continue // 本地无此 canvas(未 hydrate content)→ 不动(下轮 hydrate 补)
        // 归一比较(?? 'active')避免 active(explicit)↔ undefined(active) 的无谓 churn;不一致才覆写为 wire 值。
        if ((existing.status ?? 'active') !== (meta.status ?? 'active')) {
          next[meta.id] = { ...existing, status: meta.status }
          reconciled++
        }
      }
      if (reconciled > 0) {
        debugLogger.log(SOURCE, `unarchiveProject ${projectId} reconcile: ${reconciled} canvas(es) status synced from server (P1-3, don't guess archivedByCascade)`)
      }
      return { canvases: next }
    })
  } catch (error) {
    debugLogger.warn(SOURCE, `unarchiveProject ${projectId} reconcile failed (P1-3, best-effort; next hydrate will reconcile): ${msg(error)}`)
  }
}

/**
 * active-child 拒绝后的严格权威回灌。project 与该 project 的 canvas GET 必须同时成功才写 store；
 * 与通用 hydrate 不同,本 helper 不吞错,调用方据此决定是否清 tombstone/展示成功文案。
 */
type ActiveChildDeleteReconcileResult =
  | { kind: 'restored' }
  | { kind: 'authoritatively-deleted' }

const reconcileActiveChildDeleteRejection = async (
  projectId: string,
  adapter: ReturnType<typeof getServerPersistAdapter>,
): Promise<ActiveChildDeleteReconcileResult> => {
  const [{ projects }, { canvases }] = await Promise.all([
    adapter.listProjects({ includeArchived: true }),
    adapter.listCanvas(projectId, { includeArchived: true }),
  ])
  const project = projects.find((candidate) => candidate.id === projectId)
  // listCanvas(projectId) 的 wire contract 已 project-scoped；仍在消费端防御过滤，避免畸形 adapter
  // 把其他项目 child 误算成 pX 的 live child，阻止 authoritatively-deleted 收敛。
  const projectCanvases = canvases.filter((candidate) => candidate.projectId === projectId)
  if (!project) {
    // 两个权威 GET 均成功且 project/children 同时为空，说明项目已被其他设备合法彻底删除
    // （或当前 actor 已不再可见）。此时本地乐观删除态就是正确终态，调用方可安全消费
    // rollback marker + project/cascade tombstone。project 缺失但仍有 child 则是不一致快照，
    // 必须保留 marker 等下轮重试，不能把潜在 live orphan 当成已删除。
    if (projectCanvases.length === 0) return { kind: 'authoritatively-deleted' }
    throw new Error(`active-child reconcile missing project ${projectId} with ${projectCanvases.length} live child canvas(es)`)
  }

  const { useCanvasStore } = await import('../store/canvasStore')
  useCanvasStore.setState((state) => {
    const nextProjects = state.projects.some((candidate) => candidate.id === projectId)
      ? state.projects.map((candidate) => candidate.id === projectId ? project : candidate)
      : [...state.projects, project]
    const nextCanvases = { ...state.canvases }
    for (const meta of projectCanvases) {
      const existing = nextCanvases[meta.id]
      nextCanvases[meta.id] = existing
        ? {
            ...existing,
            title: meta.title,
            projectId: meta.projectId,
            metaRevision: meta.metaRevision,
            contentVersion: meta.contentVersion,
            updatedAt: meta.updatedAt,
            status: meta.status,
          }
        : {
            title: meta.title,
            projectId: meta.projectId,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            metaRevision: meta.metaRevision,
            contentVersion: meta.contentVersion,
            status: meta.status,
            nodes: [],
            edges: [],
            tasks: [],
          }
    }
    return { projects: nextProjects, canvases: nextCanvases }
  })
  return { kind: 'restored' }
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
        `conflict on ${op.kind} (server rev ${currentRevision}); re-hydrating from server for recoverable rebase (server: full incl canvas content; shadow: non-canvas only, canvas content gated out by step 2.5 mode gate)`,
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
    //   drain await 本回调(writeRetryQueue drain `await onOutcome`)→ 清位/摘除在 drain 返回前落地,
    //   测试可 drain 后立即断言 marker/store,无竞态(注:WriteQueueOptions docstring "返回 Promise drain
    //   不 await"系 stale,实际 drain await onOutcome,见 writeRetryQueue drain 实现)。
    // P1 bug fix(delete-resurrection)B:deleteProject/deleteCanvas 终态 success → 从 store 摘除该 id,
    //   兜底 hydrate 曾先灌回的情况(C 差集过滤堵 hydrate 窗口;B 堵 drain 后残留——C 未过滤时
    //   (如 hydrate 先于 putWrite 落地的竞态)灌回的记录由 B 在 drain 成功时摘除)。只在
    //   outcome.status==='success' 摘除(含 404-idempotent-success):失败 terminal/rejected 不摘
    //   (server 仍有,下次 hydrate 自然保留;C 差集随记录离队失效,不冲突)。local 模式 onOutcome
    //   永不调(队列未启动)。applyServerRevision(onSuccess)对 delete 提前 return(revision undefined),
    //   故 delete 终态只经此 onOutcome 摘除(非 applyServerRevision 死代码分支)。
    // D3 edge fix(2026-07-15,#254 backlog):DELETE in-flight 时用户立即 restoreProject → enqueue
    //   createProject(同 id,在 in-flight delete 不能 combineOps 合并 → 两记录共存)。旧 DELETE drain
    //   success 后 B 按 id 无条件摘除会误删刚恢复的项目,且 applyServerRevision(createProject)只更新
    //   existing project → 项目永久消失(直到下次 hydrate)。修:B 摘除前查队列是否有同 id 的 pending
    //   createProject(restore)/createCanvas,有则跳过摘除(恢复 op 待 drain 重建,store 保留)。getPendingCreateResourceIds
    //   读 IDB 非终态记录(此时本 delete 记录已 deleteWrite 离队,不在集内 → 不误判)。无 restore 时
    //   createProject 不在集 → B 照常摘除(#254 SC-3 原行为不回归)。
    onOutcome: async (op, outcome) => {
      if (
        op.kind === 'deleteProject' &&
        outcome.status === 'rejected' &&
        typeof outcome.body === 'object' &&
        outcome.body !== null &&
        (outcome.body as { error?: unknown }).error === 'active-child'
      ) {
        // 跨设备 active-child:本地乐观 delete 已写 project + cascade child tombstone,但 server 409 零写。
        // rollback marker 必须先于取消级联 canvas DELETE 落盘，确保取消队列后仍有 durable retry
        // credential。无论 marker 是否成功，级联 DELETE 都必须取消：server 已用 active child 拒绝项目
        // 删除，放行 child DELETE 会反过来销毁保护该项目的数据。
        const cascadeCanvasIds = await getCanvasTombstoneIdsForProject(op.projectId)
        try {
          await markProjectDeletionRollbackPending(op.projectId)
        } catch (error) {
          await writeQueue?.cancelDeleteCanvases(cascadeCanvasIds, op.projectId)
          // 已知降级窗口：marker IDB 写失败后没有 durable retry credential，只能立即做一次严格权威
          // reconcile。若网络也同时失败，保留 tombstone + ERROR fail-visible；待 IDB 恢复后由后续
          // 409 或手动刷新收敛，不能假装该双故障窗口已经闭合。
          try {
            const result = await reconcileActiveChildDeleteRejection(op.projectId, createFetchServerPersistAdapter(opts))
            await revokeCanvasTombstonesForProjectStrict(op.projectId)
            await clearDeletionTombstoneStrict('project', op.projectId)
            if (result.kind === 'restored') {
              toastFeedback.warn('项目内还有活跃画布(可能来自其他设备),已恢复显示;请先归档或移动再彻底删除。')
              debugLogger.warn(
                SOURCE,
                `deleteProject ${op.projectId} rejected active-child → rollbackPending durable write failed, but immediate authoritative reconcile restored local state and tombstones were revoked: ${msg(error)}`,
              )
            } else {
              debugLogger.warn(
                SOURCE,
                `deleteProject ${op.projectId} rejected active-child → rollbackPending durable write failed, but immediate authoritative reads found project+children absent and tombstones were revoked: ${msg(error)}`,
              )
            }
          } catch (reconcileError) {
            toastFeedback.warn('项目删除被阻止,但重试状态保存和服务器恢复均失败;已拦截画布删除并保留删除标记,请刷新后重试。')
            debugLogger.error(
              SOURCE,
              `deleteProject ${op.projectId} rejected active-child → degraded dual failure: rollbackPending durable write failed (${msg(error)}), immediate authoritative reconcile or strict tombstone consumption also failed (${msg(reconcileError)}); child DELETEs cancelled and tombstones retained without durable retry marker`,
              reconcileError,
            )
          }
          return
        }
        await writeQueue?.cancelDeleteCanvases(cascadeCanvasIds, op.projectId)
        try {
          const result = await reconcileActiveChildDeleteRejection(op.projectId, createFetchServerPersistAdapter(opts))
          await revokeCanvasTombstonesForProjectStrict(op.projectId)
          await clearDeletionTombstoneStrict('project', op.projectId)
          if (result.kind === 'restored') {
            toastFeedback.warn('项目内还有活跃画布(可能来自其他设备),已恢复显示;请先归档或移动再彻底删除。')
            debugLogger.warn(
              SOURCE,
              `deleteProject ${op.projectId} rejected active-child → authoritative project+canvas reconciled, then tombstones revoked`,
            )
          } else {
            debugLogger.warn(
              SOURCE,
              `deleteProject ${op.projectId} rejected active-child but subsequent authoritative reads found project+children absent → local deletion retained, tombstones revoked`,
            )
          }
        } catch (error) {
          toastFeedback.warn('项目删除被阻止,但服务器状态恢复失败;已保留重试状态,请稍后重试。')
          debugLogger.warn(
            SOURCE,
            `deleteProject ${op.projectId} rejected active-child → authoritative reconcile failed; tombstones retained for retry: ${msg(error)}`,
          )
        }
        return
      }
      if (op.kind === 'deleteProject' && outcome.status === 'success') {
        // Phase 1 项4:DELETE 终态 success(含 404-idempotent)→ 服务端已软删 → 不再 LIVE → 无复活风险 →
        //   tombstone 完成使命可清。restore 路径(restoreProject enqueue createProject)已 revoke,此处 clear 幂等
        //   no-op。terminal 失败(rejected/dead-letter)不走此分支 → tombstone 保留(服务端仍 LIVE,继续挡复活)。
        await clearDeletionTombstone('project', op.projectId)
        const restoreIds = await getPendingCreateResourceIds('createProject')
        if (restoreIds.has(op.projectId)) {
          debugLogger.log(
            SOURCE,
            `deleteProject ${op.projectId} drained success but a pending createProject(restore) exists → skip store removal (anti-resurrection B D3 restore-safe)`,
          )
          return
        }
        const { useCanvasStore } = await import('../store/canvasStore')
        useCanvasStore.setState((s) => ({ projects: s.projects.filter((p) => p.id !== op.projectId) }))
        debugLogger.log(SOURCE, `deleteProject ${op.projectId} drained success → removed from store (anti-resurrection fallback B)`)
        return
      }
      if (op.kind === 'deleteCanvas' && outcome.status === 'success') {
        // Phase 1 项4:DELETE 终态 success(含 404-idempotent)→ 服务端已软删 → tombstone 可清(同 deleteProject)。
        await clearDeletionTombstone('canvas', op.canvasId)
        const restoreIds = await getPendingCreateResourceIds('createCanvas')
        if (restoreIds.has(op.canvasId)) {
          debugLogger.log(
            SOURCE,
            `deleteCanvas ${op.canvasId} drained success but a pending createCanvas(restore) exists → skip store removal (anti-resurrection B D3 restore-safe)`,
          )
          return
        }
        const { useCanvasStore } = await import('../store/canvasStore')
        useCanvasStore.setState((s) => {
          if (!s.canvases[op.canvasId]) return {}
          const next = { ...s.canvases }
          delete next[op.canvasId]
          return { canvases: next }
        })
        debugLogger.log(SOURCE, `deleteCanvas ${op.canvasId} drained success → removed from store (anti-resurrection fallback B)`)
        return
      }
      if (op.kind === 'unarchiveProject' && outcome.status === 'success') {
        // P1-3(返修):unarchiveProject drain success → reconcile 子画布 status 用 server 权威(不猜 archivedByCascade)。
        //   跨设备 hydrate archivedByCascade=undefined → 乐观只恢复 ===true → cascade 子画布卡 archived(空项目)。
        //   server unarchiveProjectTree 已恢复 cascade;拉 includeArchived meta reconcile:cascade→active,direct→archived。
        await reconcileProjectCanvasStatus(op.projectId)
        return
      }
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
    // F1:与 hydrate 同源 adapter(单获取通道;flush 在 drain 后需重拉 listProjects/listCanvas 做可恢复性
    //   验证,复用此 adapter,不另起第二条获取通道;getServerPersistAdapter 返单例)。
    const adapter = getServerPersistAdapter()
    await hydrateFromServer(adapter, opts)
    // P1 r6(2026-07-16 三轮终审 P1):显式快照本次 boot 的收集结果,**必须在 startPersistWriteQueue 之前**取。
    //   start() 立即 drain 历史队列,409 onConflict 会 fire `void hydrateFromServer()`(rehydrate)——它在 list 完成
    //   前**乐观置 migrationCollectionOk=true**(行 661)。若 flush 在 start 之后复读 module-global,会读到被
    //   rehydrate 覆写的 true → partial-collection 原 boot(step2 listCanvas 抛 → 真值=false)仍误种 marker
    //   → 下次 boot marker 已种跳迁移 → 未收集侧(canvas)永久滞留 local(真实数据丢失)。故快照取在 start 之前,
    //   把本次 boot 真值传入 flush,不跨 startPersistWriteQueue 这道 await 读 global(rehydrate 的覆写发生在
    //   该 await 期间,快照先于覆写,免疫)。local 在 bootPersistWiring 第一行 return 短路,永不达此。
    const collectionOkSnapshot = migrationCollectionOk
    await startPersistWriteQueue(opts)
    // D2:flush hydrate 收集的迁移 op(server 空 + 本地存量 → createProject/createCanvas 上迁)。
    //   必须在 startPersistWriteQueue 之后(queue singleton 已启动 → enqueuePersistWrite 真 enqueue)。
    //   P1-1:无条件调(不再 pending>0 门)——纯 demo / 全量已在服务端时 0 op,flush 内种 marker 收敛
    //   (否则每 boot 重收集/过滤/log 刷屏;详见 flushServerMigration 0-op 分支)。F1:非空 op flush 在 drain
    //   后验证可恢复性——全可恢复 + 收集健康才种 marker(堵 terminal 残根 + P1 r5 partial-collection 误种)。
    //   collectionOk 用上方快照(本次 boot 真值),不复读 module-global(防 start drain 内 onConflict rehydrate 覆写)。
    await flushServerMigration(adapter, collectionOkSnapshot)
    // A2-S3 block 8:启动 scene 切换 re-hydrate 订阅(切到新 server 画布 → fetchCanvas 补 content;
    // 去重 + in-flight 防并发)。local 在 bootPersistWiring 第一行 return 短路,永不调此。
    await startSceneHydrationSubscription()
  } else {
    // shadow:IDB 已 rehydrate(读源),此处 compare + 双写队列(mutation enqueue 同时写 BFF)。
    // shadow 恒不 populate canvas content(IDB 读源契约:A3 灰度观察窗 mismatch 归因干净;server 与
    //   IDB 不一致时 populate 会让用户可见内容漂移,违反 shadow 零变化承诺)。故切 scene re-hydrate
    //   仅 server 模式(block 8),shadow 不订阅 scene 切换。
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
