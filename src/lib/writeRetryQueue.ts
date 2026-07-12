// writeRetryQueue — FX-5 client durable write-retry queue (architecture migration P1 §4).
//
// Goal: writes that hit a pm2-restart / network-jitter window must not be lost. This
// queue holds them in IndexedDB (partitioned by userId, FX-6 namespace seam) and
// replays them through an injectable executor once the server is reachable again.
//
// Boundary (lead FX-5 task pack):
//  - ONLY client code. Does NOT touch server/ or the #194 contract types — consumes
//    them (NodePayload/EdgePayload/AnchorPayload/Revision/isUserStateKeyForbidden).
//  - Does NOT wire into the live app: ServerPersistAdapter is currently `unwired`
//    (all methods reject, src/lib/serverPersistAdapter.ts). The real fetch path is
//    T1.3 PG worker's job. This module is inert until T1.3 calls createWriteQueue(
//    { executor }).start(). It never imports the unwired adapter → zero side-effects.
//  - uploadAsset is NOT queued (content-addressed + refcounted; T1.5 #195 owns its
//    own retry; binary blobs are heavy in IDB — documented in the design doc).
//
// Design doc: docs/plan/fx5-write-retry-queue-design.md.
// Contract: shared/persist-contract.ts (#194, merged to main).
//
// Logging invariant (docs/development-logging.md): every terminal / overflow / 401 /
// dead-letter path surfaces via debugLogger (warn/error) + toastFeedback (info/warn/
// error). Never silently drop a write. Terminal records are deleted after surfacing
// (debugLogStore is the audit trail; IDB must not grow unbounded).

import type { AnchorPayload, EdgePayload, NodePayload, Revision } from '../../shared/persist-contract.ts'
import {
  isUserStateKeyForbidden,
  scanForSensitiveFields,
  scanUserStateKeyForCredential,
} from '../../shared/persist-contract.ts'
import { ANONYMOUS_USER_ID, getPersistUserId } from './persistUserId'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'

const SOURCE = 'Write Retry Queue'

const DB_NAME = 'mivo-write-queue'
// DB_VERSION 2 (FX-7 / A6): adds the `terminals` store — a durable ledger of
// dead-letter / conflict / rejected terminal outcomes (op summary + error code +
// time) for the A3 persist gray observation window — AND the `meta` store for the
// non-retreatable per-status cumulative counters (P1-4). v1→v2 is additive: an
// existing v1 DB triggers onupgradeneeded which creates both new stores; existing
// `writes` records are untouched. Retry / backoff / terminal-decision semantics are
// NOT changed — the ledger + counters are append-only alongside the existing
// delete-after-surface.
const DB_VERSION = 2
const STORE_NAME = 'writes'
const TERMINALS_STORE = 'terminals'
// P1-4: `meta` store holds the non-retreatable per-status cumulative terminal
// counters (key 'terminalCounters') + the A3 baseline snapshot (key
// 'terminalCountersBaseline'). keyPath `key`.
const META_STORE = 'meta'

// FX-7 / A6: cap the durable terminal ledger so a misbehaving executor cannot grow
// IDB unbounded. The ledger is an observation/audit trail (A3 gray window stats);
// old entries age out by timestamp. Mirrors the "IDB must not grow unbounded" posture
// documented for the writes store. (P1-4: evicting a ledger entry does NOT decrement
// the cumulative counters — counters are the non-retreatable A3 metric.) Mutable so
// tests can shrink it without recording >256 outcomes; reset in __resetWriteQueueDb.
const DEFAULT_MAX_TERMINALS = 256
let maxTerminals = DEFAULT_MAX_TERMINALS

// P1-3: how long to wait for a blocked v1→v2 upgrade before degrading to the
// in-memory path. Another tab holding an older-version connection without an
// onversionchange handler would otherwise block open(v2) forever; this timeout
// turns that into a reject → warnIdbDegradation → memStore (visible, not hung).
let idbBlockTimeoutMs = 3000

// P1-3 (second-round): once a blocked open times out, the IDBOpenDBRequest is NOT
// cancelable — it stays queued in the browser's IDB engine. A SECOND open(v2) called
// while the first is stuck would queue BEHIND it, never receive onblocked, and have
// no timeout of its own → permanent hang (sol verified with a real v1 connection).
// So after a blocked-timeout we enter a module-level blocked state: subsequent
// openDb calls immediately reject → memStore WITHOUT creating a new open. If the
// stuck request's onsuccess fires late (the blocker released), we close the
// connection + clear the blocked state so the NEXT openDb does a fresh, clean open.
let blockedState: 'open' | 'blocked' = 'open'

// P1-A (third-round): a generation token identifying which openDb request "owns" the
// blocked state. onsuccess/onerror only clear the blocked state if their owning
// request's token still matches the current token — prevents a later request's late
// handler from mis-clearing state set by an earlier request. Minted on each fresh open.
let blockedRequestToken = 0

// P1-A (third-round) test-only: counts how many times the onerror branch cleared the
// blocked state. Lets the upgrade-error test assert the onerror path specifically fired
// (vs the late-onsuccess path) — guards against false-green if fake-indexeddb routes an
// upgrade-abort to onsuccess instead of onerror. Reset in __resetWriteQueueDb.
let onerrorBlockedClearCount = 0

// P1-A (third-round) test-only: hook invoked inside onupgradeneeded with the version-
// change transaction, so a test can call tx.abort() to make the upgrade terminate with
// an error (request.onerror) and verify the blocked state is cleared (next openDb
// recovers IDB). Production never sets this. Reset in __resetWriteQueueDb.
let openDbUpgradeAbortHook: ((tx: IDBTransaction) => void) | undefined

// P1-3: the DB name is mutable so the real-connection tests can use an isolated DB
// (avoiding cross-test version-number pollution on the shared mivo-write-queue DB).
// Production always uses DB_NAME. Reset in __resetWriteQueueDb.
let dbName = DB_NAME

// P1-4 (second-round): test-only fault injector for the atomic terminal tx. When set,
// recordTerminal's run callback invokes it with the tx so a test can call tx.abort()
// to verify the atomic property (neither ledger entry nor counter lands on abort).
// Production never sets this. Reset in __resetWriteQueueDb.
// P2-C (third-round): now phase-keyed ('record' | 'cap') so the cap tx can be fault-
// injected too (lead residual: cap tx abort was untested).
let terminalFaultInjector: ((phase: 'record' | 'cap', tx: IDBTransaction) => void) | undefined

const DEFAULT_MAX_QUEUE = 256
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_DELAY = 1000
const DEFAULT_MAX_DELAY = 60_000
const DEFAULT_DRAIN_INTERVAL = 5000

// P1-4: non-retreatable per-status cumulative terminal counters. Each field is
// monotonic — incremented in recordTerminal, NEVER decremented (not even when the
// ledger evicts an entry). A3 observation-window stats use these, NOT the bounded
// snapshot (getWriteQueueTerminals), because a real dead-letter can be evicted from
// the 256-entry ledger and a snapshot filter would then falsely read 0 (false-green).
// `evicted` tracks how many ledger entries aged out (so A3 can reconcile snapshot
// depth vs. cumulative totals). Keys mirror TerminalLedgerStatus exactly.
type TerminalCounterShape = {
  conflict: number
  'too-large': number
  'reuse-conflict': number
  rejected: number
  terminal: number
  'dead-letter': number
  evicted: number
}
const ZERO_COUNTERS: TerminalCounterShape = {
  conflict: 0,
  'too-large': 0,
  'reuse-conflict': 0,
  rejected: 0,
  terminal: 0,
  'dead-letter': 0,
  evicted: 0,
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── Write-op descriptor (discriminated union over ServerPersistAdapter write methods) ──

export type WriteOpKind =
  | 'upsertNode'
  | 'upsertEdge'
  | 'upsertAnchor'
  | 'deleteNode'
  | 'deleteEdge'
  | 'deleteAnchor'
  | 'reorderChildren'
  | 'appendChatMessage'
  | 'updateChatMessage'
  | 'deleteChatMessage'
  | 'putUserState'
  | 'deleteUserState'
  | 'createProject'
  | 'updateProject'
  | 'deleteProject'
  | 'createCanvas'
  | 'updateCanvas'
  | 'deleteCanvas'
  | 'attachAsset'
  | 'detachAsset'

export type WriteOp =
  | { kind: 'upsertNode'; canvasId: string; nodeId: string; payload: NodePayload; baseRevision?: Revision }
  | { kind: 'upsertEdge'; canvasId: string; edgeId: string; payload: EdgePayload; baseRevision?: Revision }
  | { kind: 'upsertAnchor'; canvasId: string; anchorId: string; payload: AnchorPayload; baseRevision?: Revision }
  | { kind: 'deleteNode'; canvasId: string; nodeId: string }
  | { kind: 'deleteEdge'; canvasId: string; edgeId: string }
  | { kind: 'deleteAnchor'; canvasId: string; anchorId: string }
  | {
      kind: 'reorderChildren'
      canvasId: string
      type: 'node' | 'edge' | 'anchor' | 'chat-message'
      orderedIds: string[]
      baseContentVersion: Revision
    }
  | { kind: 'appendChatMessage'; canvasId: string; message: unknown }
  | { kind: 'updateChatMessage'; canvasId: string; msgId: string; payload: unknown; baseRevision?: Revision }
  | { kind: 'deleteChatMessage'; canvasId: string; msgId: string }
  | { kind: 'putUserState'; key: string; value: unknown; baseRevision?: Revision }
  | { kind: 'deleteUserState'; key: string }
  | { kind: 'createProject'; name: string; id?: string }
  | { kind: 'updateProject'; projectId: string; name: string; baseRevision?: Revision }
  | { kind: 'deleteProject'; projectId: string }
  | { kind: 'createCanvas'; canvasId: string; projectId: string; title?: string; sourceTemplateId?: string }
  | { kind: 'updateCanvas'; canvasId: string; projectId: string; title?: string; sourceTemplateId?: string; baseRevision?: Revision }
  | { kind: 'deleteCanvas'; canvasId: string }
  | { kind: 'attachAsset'; assetId: string; nodeId: string }
  | { kind: 'detachAsset'; assetId: string; nodeId: string }

// ── G1-a P1-3:类型拆分——非画布域 op(G1-a executor 只接受这些)──────────────────
// 画布域写(node/edge/anchor/reorder)不属 G1-a executor 范围(G1-c 挂 N2-0)。chat 已接(DP-6R P1-1 划归
// G1-a,appendChatMessage/updateChatMessage/deleteChatMessage 归入 wired 集合)。已持久化的未支持 op
// (canvas 域写)用 deferred 状态保留(不发请求不删除),等 G1-c 升级 executor 后 drain。
// NonCanvasWriteOp 让 executor switch 穷尽非画布域 kind;canvas 域写经 isNonCanvasWriteOp 守卫返
// unsupported-retained(drain 不 deleteWrite,标 deferred 留存)。
/** G1-a 接线 executor 支持的 op 子集(非画布域:project / canvas-meta / user-state / asset / chat)。 */
export type NonCanvasWriteOp =
  | { kind: 'putUserState'; key: string; value: unknown; baseRevision?: Revision }
  | { kind: 'deleteUserState'; key: string }
  | { kind: 'createProject'; name: string; id?: string }
  | { kind: 'updateProject'; projectId: string; name: string; baseRevision?: Revision }
  | { kind: 'deleteProject'; projectId: string }
  | { kind: 'createCanvas'; canvasId: string; projectId: string; title?: string; sourceTemplateId?: string }
  | { kind: 'updateCanvas'; canvasId: string; projectId: string; title?: string; sourceTemplateId?: string; baseRevision?: Revision }
  | { kind: 'deleteCanvas'; canvasId: string }
  | { kind: 'attachAsset'; assetId: string; nodeId: string }
  | { kind: 'detachAsset'; assetId: string; nodeId: string }
  | { kind: 'appendChatMessage'; canvasId: string; message: unknown }
  | { kind: 'updateChatMessage'; canvasId: string; msgId: string; payload: unknown; baseRevision?: Revision }
  | { kind: 'deleteChatMessage'; canvasId: string; msgId: string }

/** 非画布域 op kind 集合(G1-a executor 支持范围,含 chat)。 */
const NON_CANVAS_KINDS: ReadonlySet<WriteOpKind> = new Set<WriteOpKind>([
  'putUserState',
  'deleteUserState',
  'createProject',
  'updateProject',
  'deleteProject',
  'createCanvas',
  'updateCanvas',
  'deleteCanvas',
  'attachAsset',
  'detachAsset',
  'appendChatMessage',
  'updateChatMessage',
  'deleteChatMessage',
])

/**
 * G1-a P1-3 type guard:op 是否在 G1-a executor 支持的非画布域范围。
 * - true → executor 处理(发请求)。
 * - false → canvas/chat op,executor 返 unsupported-retained(drain 标 deferred 留存,不删)。
 * 返回 `op is NonCanvasWriteOp` 让 executor 的 switch 在 true 分支穷尽 NonCanvasWriteOp kind。
 */
export const isNonCanvasWriteOp = (op: WriteOp): op is NonCanvasWriteOp =>
  NON_CANVAS_KINDS.has(op.kind)

// ── Persisted record + state machine ──

export type WriteStatus =
  | 'pending' // waiting to drain (nextAttemptAt <= now)
  | 'in-flight' // executor currently running
  | 'paused-401' // got 401; queue paused; kept for re-login replay
  | 'deferred' // G1-a P1-3:unsupported op(canvas/chat)留存,等 executor 升级(G1-c/DP-6R)再 drain
// Terminal statuses are deleted immediately after surfacing (not stored long-term):
// success / conflict / too-large / rejected / reuse-conflict / dead-letter.
// `deferred` is NOT terminal — the record is retained (not deleted) so G1-c/DP-6R can upgrade + replay.

export type QueuedWrite = {
  id: string
  idempotencyKey: string
  userId: string
  op: WriteOp
  resourceKey: string | null
  createdAt: number
  attempts: number
  nextAttemptAt: number
  status: WriteStatus
  lastError?: string
  lastAttemptAt?: number
}

// ── Executor seam (T1.3 plugs the real fetch here) + outcome classification ──

export type WriteOutcome =
  | { status: 'success'; revision?: Revision }
  | { status: 'conflict'; currentRevision: Revision }
  | { status: 'too-large'; limit: number }
  | { status: 'unauthorized' }
  | { status: 'reuse-conflict'; key: string }
  | { status: 'rejected'; body: unknown }
  | { status: 'transient'; message: string }
  | { status: 'terminal'; message: string }
  | { status: 'unsupported-retained'; message: string }

export type WriteExecutor = (op: WriteOp, idempotencyKey: string) => Promise<WriteOutcome>

/**
 * Map an HTTP response (status + parsed body) to a WriteOutcome. T1.3's real executor
 * uses this after fetch(); tests bypass it by returning outcomes directly. The
 * `isDelete` flag makes 404 on a delete idempotent-successful (already-gone resource).
 * 409 revision-conflict → conflict (do NOT blindly retry; surface currentRevision for
 * the app's rebase). 409 project/canvas-exists → rejected terminal (can't confirm it's
 * this session's lost response vs. another tenant's resource; safe terminal, not a
 * silent success). 5xx/408/429 → transient (retry with backoff). 401 → unauthorized
 * (queue pauses; data retained).
 */
export const classifyHttpStatus = (
  status: number,
  body: unknown,
  opts: { isDelete: boolean },
): WriteOutcome => {
  if (status >= 200 && status < 300) return { status: 'success' }
  if (status === 401) return { status: 'unauthorized' }
  if (status === 409) {
    const b = body as { error?: string; currentRevision?: Revision }
    if (b?.error === 'revision-conflict' && typeof b.currentRevision === 'number')
      return { status: 'conflict', currentRevision: b.currentRevision }
    return { status: 'rejected', body }
  }
  if (status === 413) {
    const b = body as { limit?: number }
    return { status: 'too-large', limit: typeof b?.limit === 'number' ? b.limit : 0 }
  }
  if (status === 422) {
    const b = body as { key?: string }
    return { status: 'reuse-conflict', key: typeof b?.key === 'string' ? b.key : '' }
  }
  if (status === 404) return opts.isDelete ? { status: 'success' } : { status: 'rejected', body }
  if (status === 400 || status === 403 || status === 428 || status === 405) return { status: 'rejected', body }
  if (status >= 500 || status === 408 || status === 429) return { status: 'transient', message: `http_${status}` }
  return { status: 'terminal', message: `http_${status}` }
}

// ── Helpers ──

const computeResourceKey = (op: WriteOp): string | null => {
  switch (op.kind) {
    case 'upsertNode':
    case 'deleteNode':
      return `node:${op.canvasId}:${op.nodeId}`
    case 'upsertEdge':
    case 'deleteEdge':
      return `edge:${op.canvasId}:${op.edgeId}`
    case 'upsertAnchor':
    case 'deleteAnchor':
      return `anchor:${op.canvasId}:${op.anchorId}`
    case 'reorderChildren':
      return `reorder:${op.canvasId}:${op.type}`
    case 'putUserState':
    case 'deleteUserState':
      return `userstate:${op.key}`
    case 'createProject':
      return op.id ? `project:${op.id}` : `project:name:${op.name}`
    case 'updateProject':
    case 'deleteProject':
      return `project:${op.projectId}`
    case 'createCanvas':
    case 'updateCanvas':
    case 'deleteCanvas':
      return `canvas:${op.canvasId}`
    case 'attachAsset':
      return `asset-attach:${op.assetId}:${op.nodeId}`
    case 'detachAsset':
      return `asset-detach:${op.assetId}:${op.nodeId}`
    case 'appendChatMessage':
      // 每条 chat 消息独立 op(message payload 内含唯一 id,但 op 层不 narrow),不 coalesce;
      // 快速连发多条消息各自独立入队(符合 chat 语义——不同消息不该合并)。
      return null
    case 'updateChatMessage':
    case 'deleteChatMessage':
      return `chat-msg:${op.canvasId}:${op.msgId}`
  }
}

export const isDeleteKind = (kind: WriteOpKind): boolean =>
  kind === 'deleteNode' ||
  kind === 'deleteEdge' ||
  kind === 'deleteAnchor' ||
  kind === 'deleteUserState' ||
  kind === 'deleteProject' ||
  kind === 'deleteCanvas' ||
  kind === 'detachAsset' || // 404(missing asset/ref)→ 幂等 success(detach intent 已满足);403 owner-mismatch → rejected
  kind === 'deleteChatMessage' // 404(已删 / 跨 actor)→ 幂等 success

/**
 * G1-a R7-1:drain 排序的稳定拓扑排序(替换 R6-1 的标量 dependencyRank)。
 *
 * 背景:R6-1 的条件 dependencyRank 虽只在批内存在 FK parent 时给 child 升 rank,但仍用单一标量 rank
 * 对整批分层排序。混合批中一旦 chat 因批内 canvas 升到 rank 2,所有 rank 0 的无关记录(如 unrelated
 * createProject)都会跨过 chat——即使前两条真实 FK 边已天然有序、第三条与两者无 FK,正确的 surgical
 * 序应完全不变。返修声明"只重排实际 FK 边"不成立。R7 verdict 用 fresh 真 Hono 反例证:IDB 原序
 * canvas→chat→unrelated project 被改成 canvas→unrelated project→chat。
 *
 * 修法(lead 指定):以原 IDB 序(主键 nextAttemptAt/createdAt + stable sort 保留入队序)为优先级的稳定
 * 拓扑排序。先按主键稳定排序得"原序",再在原序上建批内真实 FK 边,Kahn 算法就绪集(入度 0)每次取原序
 * 最靠前者(最小堆按 ordered index 升序)。无边记录入度 0 → 完全保持原序;有边记录只在 parent 必须
 * 先 drain 时后置。O((n+e) log n),n 为单用户同毫秒 due 批规模(个位到几十),性能无虞。
 *
 * 批内真实 FK 边(G1-a 已接线的非画布域 FK 链,project→canvas→chat):
 *  - createProject(id) → createCanvas/updateCanvas(projectId=id):canvas 写携带 projectId 外键,服务端
 *    要求 project 先建好(POST /api/canvas 缺 project → 404 unknown-project;见 server/routes/canvas.ts
 *    + canvas.route.test.ts unknown-project 404)。R4 F2 覆盖 project→canvas 同毫秒 FK 链。
 *  - createCanvas(id) → appendChatMessage/updateChatMessage/deleteChatMessage(canvasId=id):chat 写依赖
 *    canvas 已建(POST /api/canvas/:id/chat → authzCanvas → canvas 未建 → 404 unknown-canvas → terminal;
 *    见 canvas.ts authzCanvas + canvas.route.test.ts POST chat 404)。R5-1:同毫秒 createCanvas +
 *    appendChatMessage(用户新建画布后立即发消息)若 chat 先 drain → 404 unknown-canvas → terminal
 *    删 chat record → 消息永久丢失。拓扑边强制 canvas 先 drain。
 *  传递成链:真实三链 project→canvas→chat(parent 均在批内)因边传递约束 → 拓扑序强制 project→canvas→chat。
 *
 * 性质对比(为何拓扑排序 surgical,而标量 rank 不是):
 *  - 无 FK 竞争对(chat 依赖的 canvas 已 preseed + 无关 createProject):无边 → 入度 0 → 原序保持
 *    (R6-1 两记录守卫:chat→project 保持原序)。
 *  - 混合批(canvas→chat 真实边已天然有序 + 无关 project 在后):canvas→chat 边存在但原序已 canvas
 *    在 chat 前,边不改变其相对位置;无关 project 无边不跨过 chat(R7-1 修:canvas→chat→unrelated project)。
 *  - backoff 跨桶:若 parent.nextAttemptAt > child.nextAttemptAt(parent 失败 backoff 推迟),拓扑边仍
 *    强制 parent 先 drain——FK 边优先于时间主键,防 child 先 drain 撞未建 parent 404 terminal。
 *
 * 第四层依赖面(future seam,当前不加码,书面确认):
 *  - updateChatMessage / deleteChatMessage 语义上依赖 appendChatMessage 已先成功(否则 PATCH/DELETE 一个
 *    未建 msgId → 404 unknown-message;delete 404 幂等 success 无险,update 404 → terminal)。**当前
 *    chatPersistSync 只导出 enqueueChatAppend,无生产 enqueueChatUpdate/Delete caller**(独立 grep 已核验),
 *    故 append→update 同毫秒风险是 future seam,G1-a 范围书面确认即可,不另建边。
 *  - node/edge/anchor/reorder/attachAsset 依赖 canvas 与 node 生命周期,但当前 executor 对 canvas 域写返
 *    unsupported-retained(deferred 留存,不发请求不删,无 404 terminal 险)。**G1-c 接线升级 executor 时
 *    必须重审依赖排序/恢复策略**(node→edge/anchor、asset-attach 依赖 live node 等),不要继续靠枚举边;
 *    本函数只覆盖 G1-a 已接线的非画布域 FK 链(project→canvas→chat),G1-c 扩展时另行升级。
 *
 * 跨毫秒时父资源同步先于子资源入队,timestamp 主键已保证顺序 —— 拓扑边仅在 same-ms tie 或 backoff
 * 跨桶(parent 被 backoff 推迟到 child 之后)时生效;主键不同且无 backoff 跨桶时 stable sort 已分桶,
 * 拓扑边不跨桶。
 */
const stableTopologicalSort = (due: QueuedWrite[]): QueuedWrite[] => {
  // 原序:主键 nextAttemptAt(退避到期先发)+ 次键 createdAt(同 nextAttemptAt 时先入队先发)。
  // stable sort 保留 IDB getAll 入队序作隐式第三 tie-break(同主键时不动相对位置)。
  const ordered = due
    .slice()
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)

  // 建批内 parent-create 索引:project id / canvas id → 该 create 在 ordered 中的 index(首个)。
  // 同 id 取首个保证确定性(create+create 同 id 生产流不发生;combineOps 已把 create+update 合并保留
  // create kind,批内不并存同 id 的 createProject/createCanvas)。
  const projectCreateIndex = new Map<string, number>()
  const canvasCreateIndex = new Map<string, number>()
  for (let i = 0; i < ordered.length; i++) {
    const op = ordered[i]!.op
    if (op.kind === 'createProject' && op.id !== undefined) {
      if (!projectCreateIndex.has(op.id)) projectCreateIndex.set(op.id, i)
    } else if (op.kind === 'createCanvas') {
      if (!canvasCreateIndex.has(op.canvasId)) canvasCreateIndex.set(op.canvasId, i)
    }
  }

  // 建边(parent create → child op 引用该 parent id 且 parent 在批内)。边方向:parent 先 → child 后。
  // adj[parentIdx] = [childIdx, ...]; indegree[childIdx]++。
  const n = ordered.length
  const adj: number[][] = Array.from({ length: n }, () => [])
  const indegree = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const op = ordered[i]!.op
    // canvas 写引用 project id(createCanvas/updateCanvas 依赖批内 createProject(id=op.projectId))。
    // deleteCanvas 不带 projectId(create+delete 同 id 已被 combineOps 抵消,批内不并存)。
    if (op.kind === 'createCanvas' || op.kind === 'updateCanvas') {
      const pIdx = projectCreateIndex.get(op.projectId)
      if (pIdx !== undefined && pIdx !== i) {
        adj[pIdx]!.push(i)
        indegree[i]!++
      }
    }
    // chat 写引用 canvas id(append/update/deleteChatMessage 依赖批内 createCanvas(id=op.canvasId))。
    if (
      op.kind === 'appendChatMessage' ||
      op.kind === 'updateChatMessage' ||
      op.kind === 'deleteChatMessage'
    ) {
      const cIdx = canvasCreateIndex.get(op.canvasId)
      if (cIdx !== undefined && cIdx !== i) {
        adj[cIdx]!.push(i)
        indegree[i]!++
      }
    }
  }

  // Kahn 拓扑排序:就绪集(入度 0)用最小堆按原序(ordered index 升序)做 tie-break —— 每次取原序最靠前者。
  // 无边记录入度 0 一开始就在堆里,按原序逐个弹出 → 完全保持原序;有边记录等 parent 弹出后入度归零才入堆。
  const heap: number[] = []
  const heapPush = (idx: number): void => {
    heap.push(idx)
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (heap[p]! <= heap[c]!) break
      ;[heap[p]!, heap[c]!] = [heap[c]!, heap[p]!]
      c = p
    }
  }
  const heapPop = (): number => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let p = 0
      const len = heap.length
      for (;;) {
        const l = 2 * p + 1
        const r = l + 1
        let smallest = p
        if (l < len && heap[l]! < heap[smallest]!) smallest = l
        if (r < len && heap[r]! < heap[smallest]!) smallest = r
        if (smallest === p) break
        ;[heap[smallest]!, heap[p]!] = [heap[p]!, heap[smallest]!]
        p = smallest
      }
    }
    return top
  }
  for (let i = 0; i < n; i++) if (indegree[i] === 0) heapPush(i)

  const sorted: QueuedWrite[] = []
  const placed = new Array<boolean>(n).fill(false)
  while (heap.length > 0) {
    const idx = heapPop()
    if (placed[idx]) continue
    placed[idx] = true
    sorted.push(ordered[idx]!)
    for (const childIdx of adj[idx]!) {
      if (--indegree[childIdx]! === 0) heapPush(childIdx)
    }
  }
  // 环保护:FK 边 create→child 单调,不应成环。若因异常数据成环(理论不应发生),剩余按原序追加,
  // 防 Kahn 死锁导致记录永不 drain(永驻 IDB)。debugLogger.warn 可见,不静默(fail visibly)。
  if (sorted.length < n) {
    debugLogger.warn(
      SOURCE,
      `topo sort detected possible cycle (${n - sorted.length} records unplaced); appending remainder in original order`,
    )
    for (let i = 0; i < n; i++) {
      if (!placed[i]) sorted.push(ordered[i]!)
    }
  }
  return sorted
}

/**
 * G1-a R2 F1:同资源 op 组合规则(在 drain 前的 enqueue coalesce 用)。返回合并后的 op,
 * 或 'cancel' 表示净消(删 pending 记录,不发任何请求)。
 *
 * 旧实现 `existing.op = op` 无差别替换 kind:pending create 被随后的 update 原地替换成 update,
 * drain 只发 PATCH/PUT,服务端从未收到 POST(create 丢失)——新建后快速重命名会 404。
 *
 * 组合规则:
 *  - create+update → 合并为 create 的最终 body(保留 create kind;drop baseRevision,create 无 base)。
 *  - create+delete → 净消(资源从未服务端创建,delete 无意义)。
 *  - 其余(update+update / update+delete / delete+delete / delete+update)→ last-wins(incoming)。
 *    create+create 同 id 正常 store 流不会发生(createProject 每次新 mint id);若发生也 last-wins。
 */
const combineOps = (existing: WriteOp, incoming: WriteOp): WriteOp | 'cancel' => {
  const ek = existing.kind
  const ik = incoming.kind
  // create+update → 保留 create kind,合并到最终 body(防 create 被 update 替换致服务端从未 POST)
  if (ek === 'createProject' && ik === 'updateProject') {
    return { kind: 'createProject', name: incoming.name, id: existing.id ?? incoming.projectId }
  }
  if (ek === 'createCanvas' && ik === 'updateCanvas') {
    // R3 F1:field-wise merge — 保留 create 独有/未改字段( notably sourceTemplateId)。
    // 生产 rename(只带 title)/move(只带 projectId)的 update 不带 sourceTemplateId,
    // 旧实现只用 incoming 重建 create 致 sourceTemplateId 被静默丢弃。现按字段级合并:
    // incoming 显式携带 → 用 incoming(可改);incoming 未带 → 保留 existing(不丢 create 独有字段)。
    return {
      kind: 'createCanvas',
      canvasId: existing.canvasId,
      projectId: incoming.projectId,
      ...(incoming.title !== undefined
        ? { title: incoming.title }
        : existing.title !== undefined
          ? { title: existing.title }
          : {}),
      ...(incoming.sourceTemplateId !== undefined
        ? { sourceTemplateId: incoming.sourceTemplateId }
        : existing.sourceTemplateId !== undefined
          ? { sourceTemplateId: existing.sourceTemplateId }
          : {}),
    }
  }
  // create+delete → 净消(资源从未服务端创建,delete 无意义)
  if (ek === 'createProject' && ik === 'deleteProject') return 'cancel'
  if (ek === 'createCanvas' && ik === 'deleteCanvas') return 'cancel'
  // 其余组合:last-wins(update+update / update+delete / delete+delete / delete+update / create+create)
  return incoming
}

/** Exponential backoff with jitter: min(base * 2^(attempts-1), max) * (0.5..1.0). */
const backoffDelay = (attempts: number, base: number, max: number, rand: () => number): number => {
  const exp = base * Math.pow(2, attempts - 1)
  const capped = Math.min(exp, max)
  return Math.floor(capped * (0.5 + rand() * 0.5))
}

const hasRandomUUID = (): boolean =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'

const newId = (): string =>
  hasRandomUUID() ? crypto.randomUUID() : `wq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const newKey = (): string =>
  hasRandomUUID()
    ? `mivo-${crypto.randomUUID()}`
    : `mivo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`

// ── IDB layer (separate DB from mivo-canvas-persist to avoid FX-6/T1.3 coupling) ──
// IDB unavailable (private mode) → degrade to an in-memory Map. That still survives a
// pm2-restart window (page stays open) but not a page reload; debugLogger.warn on fallback.

let dbPromise: Promise<IDBDatabase> | undefined
const memStore = new Map<string, QueuedWrite>()
// FX-7 / A6: terminal ledger in-memory fallback (mirrors memStore discipline — used
// only when IDB is unavailable; survives a pm2-restart window, not a reload).
const terminalMem = new Map<string, TerminalLedgerEntry>()
// P1-B (third+fourth-round): per-status cumulative counters split into two in-memory
// buckets. `terminalCountersMem` = PENDING delta (increments not yet claimed by an
// in-flight tx, not yet in IDB). `inFlightCountersMem` = claimed by an in-flight tx (the
// tx will write idbCurrent + capturedPending + increment; on commit the claim clears, on
// abort it refunds to pending). read = idbCurrent + pending + inFlight (conservative add,
// no max). The two-bucket claim model (round 4) fixes the concurrent-capture bug: a tx
// claims its portion SYNCHRONOUSLY (JS single-threaded → atomic claim) before the IDB tx
// queues, so a second concurrent tx claims only what's left — no double-flush of the
// same pending delta (sol: pending=3 + 2 concurrent record → durable=8 with the
// snapshot model; expected 5).
let terminalCountersMem: TerminalCounterShape = { ...ZERO_COUNTERS }
let inFlightCountersMem: TerminalCounterShape = { ...ZERO_COUNTERS }
let terminalCountersBaselineMem: { counters: TerminalCounterShape; ts: number } | null = null

const isIdbAvailable = (): boolean => typeof indexedDB !== 'undefined' && indexedDB !== null

// IDB open/transaction failure → fall back to memStore (survives a pm2-restart window, not a
// reload). The FIRST such failure surfaces one user-visible warning toast so the user knows a
// refresh may lose unsaved writes; subsequent same-kind failures stay debugLogger-only
// (debounced via idbDegradationWarned) so the toast never spams (P1-2). Only the data-preserving
// get/put paths fire this — delete/clear failures don't retain data in memory and stay warn-only.
let idbDegradationWarned = false
const warnIdbDegradation = (context: string, error: unknown): void => {
  debugLogger.warn(SOURCE, `${context}; using in-memory fallback: ${msg(error)}`)
  if (!idbDegradationWarned) {
    idbDegradationWarned = true
    toastFeedback.warn('本地保存仅内存暂存,刷新页面可能丢失未保存的改动。')
  }
}

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  // P1-3 (second-round): if a prior open was blocked + timed out, the stuck
  // IDBOpenDBRequest is still queued in the IDB engine (not cancelable). A new
  // open(v2) here would queue BEHIND it, never receive onblocked, and have no
  // timeout → permanent hang (sol verified with a real v1 connection). So while in
  // the blocked state, immediately reject → caller degrades to memStore. NEVER
  // queue a second open under the same blocker.
  if (blockedState === 'blocked') {
    return Promise.reject(
      new Error('IDB blocked: a prior upgrade is stuck; using in-memory fallback'),
    )
  }
  // P1-A: mint a generation token for THIS request. onsuccess/onerror only clear the
  // blocked state if their owning token still matches — a later request's late handler
  // cannot mis-clear state set by an earlier request.
  const myToken = ++blockedRequestToken
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION)
    // P1-3: if another tab/connection holds an older version and does not cooperate-
    // close, the upgrade is blocked. Without an onblocked handler + timeout the open
    // request stays pending forever → every IDB operation hangs and the degradation
    // catch never fires. Start a timeout on blocked; if it elapses, enter the
    // module-level blocked state (so subsequent ops reject → memStore without a new
    // open) and reject so the caller degrades.
    let blockedTimer: ReturnType<typeof setTimeout> | undefined
    request.onblocked = () => {
      if (blockedTimer === undefined) {
        blockedTimer = setTimeout(() => {
          // Enter blocked state — subsequent openDb calls immediately reject (memStore).
          // The stuck request stays queued; if its onsuccess/onerror fires late (blocker
          // released / upgrade aborts) the handlers below clear this state (P1-A: only if
          // this request still owns the token) so the NEXT openDb does a fresh, clean open.
          blockedState = 'blocked'
          reject(new Error('IDB open blocked: another connection holds an older version'))
        }, idbBlockTimeoutMs)
      }
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(TERMINALS_STORE)) {
        db.createObjectStore(TERMINALS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
      // P1-A test-only: let a test abort the version-change tx so the open request
      // terminates with an error (onerror) → verifies the blocked state is cleared.
      if (openDbUpgradeAbortHook && request.transaction) {
        openDbUpgradeAbortHook(request.transaction)
      }
    }
    request.onsuccess = () => {
      if (blockedTimer !== undefined) clearTimeout(blockedTimer)
      const db = request.result
      // P1-3: cooperative close — if another tab tries to upgrade this DB, close our
      // connection so its onupgradeneeded can fire (otherwise we'd block it).
      db.onversionchange = () => {
        db.close()
      }
      if (blockedState === 'blocked' && myToken === blockedRequestToken) {
        // LATE success: the stuck upgrade actually completed (blocker released) AFTER
        // we already timed out + rejected the original openDb promise + entered the
        // blocked state. We cannot re-resolve that promise. Close this connection +
        // clear the blocked state so the NEXT openDb does a fresh, clean open. Token
        // check ensures a stale request cannot clobber a newer request's state.
        db.close()
        blockedState = 'open'
        return
      }
      resolve(db)
    }
    request.onerror = () => {
      if (blockedTimer !== undefined) clearTimeout(blockedTimer)
      // P1-A: if THIS request owned the blocked state (timed out + entered blocked) and
      // the pending upgrade then terminated with an error/abort (not success), clear the
      // blocked state — the request is no longer pending, so a fresh open is safe. Without
      // this, the module would permanently reject → memStore until reload, contradicting
      // the "failed open → next call retries" contract. Token check prevents a later
      // request's onerror from mis-clearing an earlier request's state.
      if (blockedState === 'blocked' && myToken === blockedRequestToken) {
        blockedState = 'open'
        onerrorBlockedClearCount++
      }
      reject(request.error)
    }
  })
  // A failed open (blocked / version conflict) must not poison subsequent calls —
  // drop the cached promise so the next operation retries from scratch.
  dbPromise.catch(() => {
    dbPromise = undefined
  })
  return dbPromise
}

const runTx = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  // FX-7 / A6: optional store name so the terminal ledger (TERMINALS_STORE) can share
  // the same transaction helper. Defaults to the writes store — all pre-FX-7 callers
  // are unchanged (backward-compatible 2-arg calls).
  storeName: string = STORE_NAME,
): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const request = run(tx.objectStore(storeName))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
      }),
  )

/**
 * P1-4: multi-store readwrite tx. Used to commit the terminal ledger entry + the
 * per-status counter RMW (and the cap-delete + evicted-counter RMW) in ONE atomic
 * transaction spanning TERMINALS_STORE + META_STORE. A crash/abort mid-tx rolls
 * BOTH back — no "ledger committed / counter unchanged" window that a later cap
 * eviction could turn into an A3 false-green. IDB tx serialization also solves
 * cross-tab concurrent RMW lost-update. The run callback may chain requests via
 * onsuccess (get→put); the tx stays open until the last scheduled request settles,
 * then tx.oncomplete resolves. The tx is passed to run so tests can fault-inject
 * tx.abort() (production never aborts).
 */
const runMultiStoreTx = (
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => void,
): Promise<void> =>
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeNames, mode)
        const stores: Record<string, IDBObjectStore> = {}
        for (const name of storeNames) stores[name] = tx.objectStore(name)
        try {
          run(stores, tx)
        } catch (error) {
          // A synchronous throw in run (e.g. test fault-injector) → abort + reject so
          // any partially-scheduled requests roll back.
          try {
            tx.abort()
          } catch {
            /* ignore — already aborting */
          }
          reject(error)
          return
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
      }),
  )

const getAllWrites = async (): Promise<QueuedWrite[]> => {
  if (!isIdbAvailable()) return Array.from(memStore.values())
  try {
    const idbRecords = await runTx<QueuedWrite[]>('readonly', (store) => store.getAll() as IDBRequest<QueuedWrite[]>)
    // Union with memStore: a record that fell back to memStore when an IDB tx failed is
    // invisible to a plain IDB read otherwise — that would lose the write the moment IDB
    // recovers (Greptile P1 #3). memStore records not in IDB are appended (dedup by id).
    const idbIds = new Set(idbRecords.map((r) => r.id))
    const memOnly = Array.from(memStore.values()).filter((r) => !idbIds.has(r.id))
    return [...idbRecords, ...memOnly]
  } catch (error) {
    warnIdbDegradation('getAll failed', error)
    return Array.from(memStore.values())
  }
}

const putWrite = async (record: QueuedWrite): Promise<void> => {
  if (!isIdbAvailable()) {
    memStore.set(record.id, record)
    return
  }
  try {
    await runTx<IDBValidKey>('readwrite', (store) => store.put(record))
    // IDB now has it — drop any stale memStore fallback so the next getAll sees one copy
    // in IDB (the record has migrated back to durable storage).
    memStore.delete(record.id)
  } catch (error) {
    // Never silently lose a queued write — fall back to memory so it still drains this
    // session. warnIdbDegradation makes the degradation visible + toasts once (logging
    // invariant, P1-2). getAllWrites unions memStore so the record stays visible to
    // drain even after IDB recovers.
    warnIdbDegradation(`put failed for ${record.id}`, error)
    memStore.set(record.id, record)
  }
}

const deleteWrite = async (id: string): Promise<void> => {
  // Always clean the memStore fallback (the record may live there if a prior put failed).
  memStore.delete(id)
  if (!isIdbAvailable()) return
  try {
    await runTx<undefined>('readwrite', (store) => store.delete(id) as IDBRequest<undefined>)
  } catch (error) {
    debugLogger.warn(SOURCE, `delete failed for ${id}: ${msg(error)}`)
  }
}

// ── FX-7 / A6: durable terminal ledger (dead-letter / conflict / rejected outcomes) ──
//
// Boundary (lead A6 task pack, decision 3): "只加账本不改重试语义" — this ledger is
// append-only alongside the existing delete-after-surface. It does NOT change retry /
// backoff / terminal-decision logic. Each terminal-failure branch calls recordTerminal
// BEFORE deleteWrite so the outcome (op summary + error code + time + attempts) is
// durably auditable for the A3 persist gray observation window ("dead-letter=0" /
// "unexplained conflict=0" quantitative stats). The ledger is bounded (cap evicts the
// oldest by timestamp) so IDB does not grow unbounded (same posture as the writes store).
//
// Status is the machine-readable error code; success is NOT ledgered (success is not a
// failure terminal). Ledger writes are best-effort — a ledger put failure must not block
// the terminal outcome (it still surfaces via debugLogger/toast above).

export type TerminalLedgerStatus =
  | 'conflict'
  | 'too-large'
  | 'reuse-conflict'
  | 'rejected'
  | 'terminal'
  | 'dead-letter'

export type TerminalLedgerEntry = {
  id: string
  recordId: string
  userId: string
  opKind: WriteOpKind
  resourceKey: string | null
  status: TerminalLedgerStatus
  message: string
  attempts: number
  timestamp: number
}

const readAllTerminals = async (): Promise<TerminalLedgerEntry[]> => {
  if (!isIdbAvailable()) return Array.from(terminalMem.values())
  try {
    const idbRecords = await runTx<TerminalLedgerEntry[]>(
      'readonly',
      (store) => store.getAll() as IDBRequest<TerminalLedgerEntry[]>,
      TERMINALS_STORE,
    )
    // Union with terminalMem so a ledger entry that fell back to memStore when an IDB
    // tx failed is not invisible to a plain IDB read (same union as getAllWrites).
    const idbIds = new Set(idbRecords.map((r) => r.id))
    const memOnly = Array.from(terminalMem.values()).filter((r) => !idbIds.has(r.id))
    return [...idbRecords, ...memOnly]
  } catch (error) {
    warnIdbDegradation('terminal getAll failed', error)
    return Array.from(terminalMem.values())
  }
}

// P1-B mem-path counter helpers (IDB unavailable OR atomic-tx-abort fallback). These
// mutate terminalCountersMem (the PENDING delta bucket) directly; readTerminalCounters
// returns idbCurrent + pending + inFlight (conservative add).
const bumpTerminalCounterMem = (status: TerminalLedgerStatus, by = 1): TerminalCounterShape => {
  const next = {
    ...terminalCountersMem,
    [status]: (terminalCountersMem[status] ?? 0) + by,
  } as TerminalCounterShape
  terminalCountersMem = next
  return next
}
const bumpEvictedMem = (by: number): TerminalCounterShape => {
  if (by <= 0) return terminalCountersMem
  const next = { ...terminalCountersMem, evicted: terminalCountersMem.evicted + by }
  terminalCountersMem = next
  return next
}

// P1-B (fourth-round) claim model: claim/release/refund the pending delta around an
// atomic tx. The claim is SYNCHRONOUS (JS single-threaded → atomic) + happens BEFORE the
// IDB tx queues, so two concurrent txs cannot capture the same pending delta. The second
// concurrent tx claims only what's left (0 or new increments that arrived after the first
// claim) — no double-flush.
//
// claim: move the entire pending delta into inFlight (returns the claimed snapshot).
// release (commit): the claim landed in IDB → drop it from inFlight (do NOT refund).
// refund (abort / no-op): the claim did NOT land → move it back to pending.
const claimPendingDelta = (): TerminalCounterShape => {
  const captured = { ...terminalCountersMem }
  terminalCountersMem = { ...ZERO_COUNTERS }
  inFlightCountersMem = addCounters(inFlightCountersMem, captured)
  return captured
}
const releaseClaim = (captured: TerminalCounterShape): void => {
  inFlightCountersMem = subtractCounters(inFlightCountersMem, captured)
}
const refundClaim = (captured: TerminalCounterShape): void => {
  terminalCountersMem = addCounters(terminalCountersMem, captured)
  inFlightCountersMem = subtractCounters(inFlightCountersMem, captured)
}

// P1-4 (second-round): enforceTerminalCap is now ATOMIC — the cap deletes + the evicted-
// counter RMW land in ONE tx (TERMINALS + META). Crash/abort mid-tx → neither the
// deletes nor the evicted increment land (no "evicted ledger / counter unchanged"
// window). IDB tx serialization solves cross-tab concurrent RMW lost-update.
// P1-B (third-round): delta model — capturedPending (snapshot of mem pending delta at
// tx start) is ADDED to idbCurrent + the evicted increment in the same put; after commit
// it is subtracted from the mem pending delta (preserving concurrent new increments).
// P2-C (third-round): the cap tx is fault-injectable via terminalFaultInjector('cap', tx).
const enforceTerminalCap = async (): Promise<void> => {
  if (!isIdbAvailable()) {
    let evictedMem = 0
    while (terminalMem.size > maxTerminals) {
      const oldest = Array.from(terminalMem.values()).sort((a, b) => a.timestamp - b.timestamp)[0]
      if (!oldest) break
      terminalMem.delete(oldest.id)
      evictedMem++
    }
    // P1-4: evicting a ledger entry bumps the `evicted` counter (monotonic, non-retreatable).
    if (evictedMem > 0) bumpEvictedMem(evictedMem)
    return
  }
  // P1-B (fourth-round): CLAIM the pending delta synchronously (JS single-threaded →
  // atomic) BEFORE the IDB tx queues. A concurrent tx that runs while this one is in
  // flight claims only what's left (0 or new increments) — no double-flush of the same
  // pending delta. Commit → release the claim; abort/no-eviction → refund it.
  const capturedPending = claimPendingDelta()
  try {
    let nextCounters: TerminalCounterShape | undefined
    let flushed = false
    await runMultiStoreTx([TERMINALS_STORE, META_STORE], 'readwrite', (stores, tx) => {
      const getAllReq = stores[TERMINALS_STORE]!.getAll() as IDBRequest<TerminalLedgerEntry[]>
      getAllReq.onsuccess = () => {
        const all = getAllReq.result
        if (all.length <= maxTerminals) return
        const excess = all.length - maxTerminals
        const oldest = all
          .slice()
          .sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1))
          .slice(0, excess)
        for (const entry of oldest) stores[TERMINALS_STORE]!.delete(entry.id)
        // evicted counter RMW in the SAME tx. Delta model: idbCurrent + capturedPending +
        // evicted increment — conservative (no max undercount).
        const counterReq = stores[META_STORE]!.get(TERMINAL_COUNTERS_KEY) as IDBRequest<
          { key: string; value: TerminalCounterShape } | undefined
        >
        counterReq.onsuccess = () => {
          const idbCurrent = counterReq.result?.value ?? { ...ZERO_COUNTERS }
          const base = addCounters(idbCurrent, capturedPending)
          nextCounters = { ...base, evicted: base.evicted + excess }
          flushed = true
          stores[META_STORE]!.put({ key: TERMINAL_COUNTERS_KEY, value: nextCounters })
          // P2-C: fault-inject the cap tx AFTER the deletes + counter put are scheduled so
          // a test can assert neither lands on abort (atomic rollback).
          terminalFaultInjector?.('cap', tx)
        }
      }
    })
    if (flushed) {
      // Commit → the claim landed in IDB → drop it from inFlight (do NOT refund).
      releaseClaim(capturedPending)
    } else {
      // No eviction (early return) → the claim did not land → refund to pending.
      refundClaim(capturedPending)
    }
  } catch (error) {
    // Abort → the claim did not land → refund to pending.
    refundClaim(capturedPending)
    debugLogger.warn(SOURCE, `terminal cap enforcement failed: ${msg(error)}`)
    // Mem fallback: leave the ledger over-cap (best-effort); the next enforceTerminalCap
    // retries. Do NOT bump evicted here — nothing was durably evicted (tx aborted).
  }
}

// P1-4 (second-round): recordTerminal is now ATOMIC — the ledger entry put + the
// per-status counter RMW land in ONE tx (TERMINALS + META). Crash/abort mid-tx →
// neither lands (no "ledger committed / counter unchanged" window that a later cap
// eviction could turn into an A3 false-green). IDB tx serialization solves cross-tab
// concurrent RMW lost-update. deleteWrite (in the drain) runs AFTER this returns, so
// the write record is removed only once the terminal ledger + counter are durably
// committed (or explicitly mem-degraded below).
const recordTerminal = async (
  rec: QueuedWrite,
  status: TerminalLedgerStatus,
  message: string,
): Promise<void> => {
  const entry: TerminalLedgerEntry = {
    id: newId(),
    recordId: rec.id,
    userId: rec.userId,
    opKind: rec.op.kind,
    resourceKey: rec.resourceKey,
    status,
    message,
    // attempts counts prior transient failures; +1 = the attempt that terminated
    // (mirrors the drain's dead-letter log "after N attempts").
    attempts: rec.attempts + 1,
    timestamp: Date.now(),
  }
  if (!isIdbAvailable()) {
    terminalMem.set(entry.id, entry)
    bumpTerminalCounterMem(status)
    await enforceTerminalCap() // mem cap + mem evicted
    return
  }
  // P1-B (fourth-round): CLAIM the pending delta synchronously (JS single-threaded →
  // atomic) BEFORE the IDB tx queues. A concurrent recordTerminal that runs while this
  // one is in flight claims only what's left — no double-flush of the same pending delta
  // (sol: pending=3 + 2 concurrent record → durable=8 with the snapshot model; expected 5).
  const capturedPending = claimPendingDelta()
  try {
    let flushed = false
    await runMultiStoreTx([TERMINALS_STORE, META_STORE], 'readwrite', (stores, tx) => {
      stores[TERMINALS_STORE]!.put(entry)
      const counterReq = stores[META_STORE]!.get(TERMINAL_COUNTERS_KEY) as IDBRequest<
        { key: string; value: TerminalCounterShape } | undefined
      >
      counterReq.onsuccess = () => {
        const idbCurrent = counterReq.result?.value ?? { ...ZERO_COUNTERS }
        // Delta model: idbCurrent + capturedPending (this tx's claim) + this increment.
        // Conservative — no max undercount (the round-2 max model lost updates across tabs).
        const base = addCounters(idbCurrent, capturedPending)
        const next = { ...base, [status]: base[status] + 1 } as TerminalCounterShape
        flushed = true
        stores[META_STORE]!.put({ key: TERMINAL_COUNTERS_KEY, value: next })
      }
      // P2-C: fault-inject the record tx (phase 'record') so a test can abort + assert
      // neither entry nor counter lands (atomic property). Cap tx uses phase 'cap'.
      terminalFaultInjector?.('record', tx)
    })
    terminalMem.delete(entry.id)
    if (flushed) {
      // Commit → the claim + this increment landed in IDB → drop the claim from inFlight.
      // (This increment was never in mem pending — it went directly into the tx's put.)
      releaseClaim(capturedPending)
    } else {
      // No counter put scheduled (shouldn't happen for recordTerminal, but be safe) → refund.
      refundClaim(capturedPending)
    }
    // ATOMIC cap (delete excess + evicted increment) after the entry+counter commit.
    await enforceTerminalCap()
  } catch (error) {
    // Abort → the claim did NOT land → refund it to pending, then add this increment to
    // pending (it didn't land either). Explicit mem degradation (lead P1-4 ③): never block
    // the terminal outcome; readTerminalCounters = idbCurrent + pending + inFlight.
    refundClaim(capturedPending)
    warnIdbDegradation(`terminal atomic put failed for ${rec.id}`, error)
    terminalMem.set(entry.id, entry)
    bumpTerminalCounterMem(status)
    await enforceTerminalCap() // mem cap (best-effort; IDB tx aborted so nothing durable)
  }
}

// ── P1-4: non-retreatable per-status cumulative counters (IDB meta store) ──
//
// A3 observation-window judgment MUST use these counters, NOT the bounded snapshot
// (getWriteQueueTerminals): the snapshot caps at `maxTerminals` and evicts the oldest
// by timestamp, so a real dead-letter can age out and a snapshot filter would falsely
// read 0 (false-green). The counters are monotonic — incremented in recordTerminal,
// NEVER decremented (eviction bumps `evicted` instead). Local diagnostic base only;
// the A3 aggregation export (cross-tab/cross-session rollup) is a follow-up.

const TERMINAL_COUNTERS_KEY = 'terminalCounters'
const TERMINAL_COUNTERS_BASELINE_KEY = 'terminalCountersBaseline'

// P1-B (third-round): delta model. terminalCountersMem is now the PENDING DELTA —
// increments that have not yet landed in IDB (failed-tx mem fallback), NOT an absolute
// counter. The durable total lives in IDB; reads return idbCurrent + pendingDelta.
// This replaces the round-2 `mergeCounters` (per-field max) which was NOT conservative:
// tab1 mem=3 (IDB down) + tab2 IDB=2 → max=3, but the true total is 5 → permanent
// undercount, contradicting the "A3 MUST-use these counters" claim. The delta model is
// conservative: pending delta is always ADDED to the durable IDB total, never max'd.
const addCounters = (a: TerminalCounterShape, b: TerminalCounterShape): TerminalCounterShape => ({
  conflict: a.conflict + b.conflict,
  'too-large': a['too-large'] + b['too-large'],
  'reuse-conflict': a['reuse-conflict'] + b['reuse-conflict'],
  rejected: a.rejected + b.rejected,
  terminal: a.terminal + b.terminal,
  'dead-letter': a['dead-letter'] + b['dead-letter'],
  evicted: a.evicted + b.evicted,
})

// Per-field subtract with floor at 0 (a pending delta can never go negative; the
// captured-delta flush subtracts only what was captured, preserving concurrent new
// increments that arrived during the tx).
const subtractCounters = (a: TerminalCounterShape, b: TerminalCounterShape): TerminalCounterShape => ({
  conflict: Math.max(0, a.conflict - b.conflict),
  'too-large': Math.max(0, a['too-large'] - b['too-large']),
  'reuse-conflict': Math.max(0, a['reuse-conflict'] - b['reuse-conflict']),
  rejected: Math.max(0, a.rejected - b.rejected),
  terminal: Math.max(0, a.terminal - b.terminal),
  'dead-letter': Math.max(0, a['dead-letter'] - b['dead-letter']),
  evicted: Math.max(0, a.evicted - b.evicted),
})

const readTerminalCounters = async (): Promise<TerminalCounterShape> => {
  if (!isIdbAvailable()) {
    // IDB unreadable: pending + inFlight (inFlight is still un-landed since the tx that
    // claimed it has not committed — readable as a degraded absolute count).
    return addCounters(terminalCountersMem, inFlightCountersMem)
  }
  try {
    const entry = await runTx<{ key: string; value: TerminalCounterShape } | undefined>(
      'readonly',
      (store) => store.get(TERMINAL_COUNTERS_KEY) as IDBRequest<{ key: string; value: TerminalCounterShape } | undefined>,
      META_STORE,
    )
    const idbCounters = entry?.value ?? { ...ZERO_COUNTERS }
    // Delta model (claim): durable IDB total + pending (unclaimed) + inFlight (claimed,
    // not yet committed). Conservative add — no max undercount.
    return addCounters(addCounters(idbCounters, terminalCountersMem), inFlightCountersMem)
  } catch (error) {
    warnIdbDegradation('terminal counters read failed', error)
    return addCounters(terminalCountersMem, inFlightCountersMem)
  }
}

const readTerminalBaseline = async (): Promise<{ counters: TerminalCounterShape; ts: number } | null> => {
  if (!isIdbAvailable()) return terminalCountersBaselineMem
  try {
    const entry = await runTx<{ key: string; value: { counters: TerminalCounterShape; ts: number } } | undefined>(
      'readonly',
      (store) =>
        store.get(TERMINAL_COUNTERS_BASELINE_KEY) as IDBRequest<
          { key: string; value: { counters: TerminalCounterShape; ts: number } } | undefined
        >,
      META_STORE,
    )
    return entry?.value ?? terminalCountersBaselineMem
  } catch (error) {
    warnIdbDegradation('terminal baseline read failed', error)
    return terminalCountersBaselineMem
  }
}

/**
 * FX-7 / A6: query the durable terminal ledger (dead-letter / conflict / rejected
 * outcomes with op summary + error code + time). For the A3 persist gray observation
 * window quantitative stats ("dead-letter=0", "unexplained conflict=0"). Each entry's
 * `status` is the machine-readable error code; `message` carries the detail.
 *
 * NOTE: this is a BOUNDED snapshot (caps at `maxTerminals`, oldest evicted by
 * timestamp). For A3 green/red judgment use getWriteQueueTerminalCounters() instead —
 * the counters are non-retreatable (evict does not decrement) so a real dead-letter
 * that aged out of this snapshot cannot cause a false-green.
 */
export const getWriteQueueTerminals = async (): Promise<TerminalLedgerEntry[]> => readAllTerminals()

export type TerminalCountersResult = {
  /** Cumulative, non-retreatable per-status counts (evict does NOT decrement these). */
  counters: TerminalCounterShape
  /** Snapshot at the last resetTerminalCountersBaseline() call (null until reset). */
  baseline: TerminalCounterShape | null
  /** Epoch ms when the baseline was set (null until reset). */
  baselineTs: number | null
}

/**
 * FX-7 / A6 P1-4: query the non-retreatable per-status cumulative terminal counters +
 * the A3 baseline. A3 observation-window judgment uses the DELTA (counters - baseline)
 * — e.g. `counters['dead-letter'] - (baseline?.['dead-letter'] ?? 0) === 0` for green —
 * NOT the bounded snapshot (getWriteQueueTerminals), which can false-green after eviction.
 *
 * Local diagnostic base only; the A3 cross-tab/cross-session aggregation export is a
 * follow-up. The `evicted` field reconciles snapshot depth vs. cumulative totals.
 */
export const getWriteQueueTerminalCounters = async (): Promise<TerminalCountersResult> => {
  const [counters, baseline] = await Promise.all([readTerminalCounters(), readTerminalBaseline()])
  return {
    counters,
    baseline: baseline?.counters ?? null,
    baselineTs: baseline?.ts ?? null,
  }
}

/**
 * FX-7 / A6 P1-4: snapshot the current cumulative counters as the A3 observation-window
 * baseline. Subsequent getWriteQueueTerminalCounters() calls return the baseline so A3
 * logic can compute the delta (new terminals since the window opened). The counters
 * themselves are NEVER reset/decremented — only the baseline reference moves.
 */
export const resetTerminalCountersBaseline = async (): Promise<void> => {
  const counters = await readTerminalCounters()
  const baseline = { counters, ts: Date.now() }
  if (!isIdbAvailable()) {
    terminalCountersBaselineMem = baseline
    return
  }
  try {
    await runTx<IDBValidKey>(
      'readwrite',
      (store) => store.put({ key: TERMINAL_COUNTERS_BASELINE_KEY, value: baseline }),
      META_STORE,
    )
    terminalCountersBaselineMem = baseline
  } catch (error) {
    warnIdbDegradation('terminal baseline write failed', error)
    terminalCountersBaselineMem = baseline
  }
}

// ── Public API ──

export type DrainResult = {
  processed: number
  successes: number
  failures: number
  terminals: number
  paused: boolean
}

export type WriteQueueOptions = {
  executor: WriteExecutor
  maxQueuePerUser?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  drainIntervalMs?: number
  onConflict?: (op: WriteOp, currentRevision: Revision) => void
  /**
   * G1-a R2 F1:成功写回灌。drain 收到 success outcome 时调用,让调用方把服务端返回的新
   * revision/metaRevision 写回 store,下一次 strict update(PATCH/PUT 带 If-Match)用 fresh base
   * 而非陈旧值(否则 create 成功后 rename 仍带旧/缺 base → 428,或第二次 rename → 409)。
   * outcome.revision 为服务端响应携带的 revision(Project.revision / CanvasMeta.metaRevision);
   * 无 revision 的 op(delete/user-state/asset/chat envelope)revision 为 undefined,调用方据此跳过。
   * 返回 Promise 时 drain 会 await(确保回灌在 drain 返回前落地,测试/后续 strict update 可见)。
   */
  onSuccess?: (op: WriteOp, outcome: { revision?: Revision }) => void | Promise<void>
  /** Inject for deterministic tests. Default: Date.now. */
  clock?: () => number
  /** Inject for deterministic jitter. Default: Math.random. */
  random?: () => number
}

export type WriteQueue = {
  enqueue: (op: WriteOp) => Promise<string>
  drain: () => Promise<DrainResult>
  resume: () => Promise<void>
  pause: () => void
  start: () => Promise<void>
  stop: () => void
  isPaused: () => boolean
  pendingCount: () => Promise<number>
}

/**
 * Create a durable write-retry queue. Inert until `start()` is called (or `drain()` is
 * invoked manually). T1.3 wires a real `executor` (dispatch by op.kind → real fetch +
 * idempotency-key header + classifyHttpStatus); until then this module is only exercised
 * by its own unit tests with a mock executor.
 */
export const createWriteQueue = (opts: WriteQueueOptions): WriteQueue => {
  const executor = opts.executor
  const maxQueue = opts.maxQueuePerUser ?? DEFAULT_MAX_QUEUE
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY
  const drainInterval = opts.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL
  const onConflict = opts.onConflict
  const onSuccess = opts.onSuccess
  const now = opts.clock ?? (() => Date.now())
  const rand = opts.random ?? (() => Math.random())

  let paused = false
  let draining = false
  let timer: ReturnType<typeof setInterval> | undefined
  let onlineHandler: (() => void) | undefined
  let visibilityHandler: (() => void) | undefined

  // G1-a R2 F1:per-resourceKey 串行链。back-to-back enqueue 到同 key 必须看到彼此的 putWrite
  // 才能 coalesce;否则两个同步 fire 的 enqueue 竞态(第一个 IDB put 未落,第二个 getAllWrites
  // 看不到 → 各建独立记录 → create 被当作独立 PATCH/PUT 发出,create 丢失)。链串行化同 key 入队;
  // 跨 key 仍并发。slot 用 always-resolved 包装防 rejected 污染链 / unhandled rejection;settled 后
  // 若无更新 enqueue 接管则 prune(Map 不随 distinct key 无界增长)。
  const enqueueChain = new Map<string, Promise<unknown>>()

  const doEnqueue = async (op: WriteOp, resourceKey: string | null): Promise<string> => {
    const userId = getPersistUserId()
    const ts = now()
    const all = await getAllWrites()

    // Coalesce: a newer edit to the same resource supersedes a still-pending op. Keeps
    // the queue from growing on rapid repeated edits to one node. in-flight ops are NOT
    // coalesced (their outcome is already in motion; a new pending record is created and
    // drains after). A new idempotencyKey is minted because the body changed — reusing
    // the old key with a different body would 422 (idempotency-key-reuse) at the server.
    if (resourceKey !== null) {
      const existing = all.find(
        (r) =>
          r.resourceKey === resourceKey &&
          r.userId === userId &&
          (r.status === 'pending' || r.status === 'paused-401'),
      )
      if (existing) {
        // G1-a R2 F1:kind-aware 组合(create+update 合并保留 create / create+delete 净消),
        // 不再无差别 `existing.op = op`(会把 pending create 替换成 update 致服务端从未 POST)。
        const combined = combineOps(existing.op, op)
        if (combined === 'cancel') {
          await deleteWrite(existing.id)
          debugLogger.log(
            SOURCE,
            `coalesced write ${resourceKey} (create+delete net-cancel; removed pending ${existing.id})`,
          )
          return existing.id
        }
        existing.op = combined
        existing.idempotencyKey = newKey()
        existing.attempts = 0
        existing.nextAttemptAt = ts
        existing.lastError = undefined
        existing.lastAttemptAt = undefined
        await putWrite(existing)
        debugLogger.log(SOURCE, `coalesced write ${resourceKey} (superseded pending ${existing.id})`)
        return existing.id
      }
    }

    // Overflow: enforce a per-user active ceiling. Eviction is never silent — the user
    // is told their oldest pending change was dropped. If everything is in-flight (can't
    // evict) the new write is refused with an error toast (not silently dropped).
    const active = all.filter(
      (r) =>
        r.userId === userId && (r.status === 'pending' || r.status === 'in-flight' || r.status === 'paused-401'),
    )
    if (active.length >= maxQueue) {
      const pending = active
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      const oldest = pending[0]
      if (oldest) {
        await deleteWrite(oldest.id)
        debugLogger.warn(
          SOURCE,
          `queue overflow (${active.length}/${maxQueue}); evicted oldest pending ${oldest.resourceKey ?? oldest.id}`,
        )
        toastFeedback.warn('本地保存队列已满,最早的一条改动被丢弃。')
      } else {
        debugLogger.error(
          SOURCE,
          `queue full (${active.length}/${maxQueue}, all in-flight); refused new write`,
        )
        toastFeedback.error('保存队列繁忙,请稍后重试。')
        throw new Error('write queue full')
      }
    }

    const record: QueuedWrite = {
      id: newId(),
      idempotencyKey: newKey(),
      userId,
      op,
      resourceKey,
      createdAt: ts,
      attempts: 0,
      nextAttemptAt: ts,
      status: 'pending',
    }
    await putWrite(record)
    debugLogger.log(SOURCE, `queued write ${record.id} (${op.kind}) for user ${userId}`)
    // Drain is NOT auto-triggered here: enqueue is pure persist + return. Drain runs via
    // start()'s timer / online event / explicit queue.drain() call. This keeps enqueue
    // deterministic (no background drain racing the caller). T1.3 may call queue.drain()
    // right after enqueue for eager send when the server is up; start()'s immediate
    // drain + periodic timer cover the pm2-restart recovery window.
    return record.id
  }

  const enqueue = (op: WriteOp): Promise<string> => {
    // DP-7: the two device-local API keys (gateway-key/mivo-key) and secret-like
    // user-state keys/values must NEVER enter the queue payload. Reject at the gate —
    // never persist, never send. Reuse ALL three #194 contract scanners (no bespoke
    // scanner) so the prior isUserStateKeyForbidden-alone gaps are closed:
    //  - camelCase field names (gatewayKey/mivoKey) as the user-state key or nested in the
    //    value — isUserStateKeyForbidden only knew hyphenated gateway-key/mivo-key + the
    //    secret/token/password/apikey substrings, so key='gatewayKey' / value={mivoKey:...}
    //    both bypassed it (P1-1).
    //  - credential-value segments inside a colon-separated key (mivo_xxx / sk-xxx),
    //    including URL-encoded / double-encoded variants — scanUserStateKeyForCredential.
    //  - any sensitive field path nested arbitrarily deep in the value (camelCase,
    //    hyphenated, prefixed, encoded) — scanForSensitiveFields, invoked with the key
    //    wrapped as a synthetic field name so the key itself is matched against
    //    SENSITIVE_FIELD_PATTERN (catches gatewayKey/mivoKey/secret/...) and op.value is
    //    recursed in the same pass.
    if (op.kind === 'putUserState' || op.kind === 'deleteUserState') {
      const value = op.kind === 'putUserState' ? op.value : undefined
      const keySegHit = scanUserStateKeyForCredential(op.key)
      const fieldHit = scanForSensitiveFields({ [op.key]: value })
      if (isUserStateKeyForbidden(op.key) || keySegHit !== null || fieldHit !== null) {
        const reason =
          keySegHit !== null
            ? `forbidden credential segment in key: ${keySegHit}`
            : fieldHit !== null
              ? `forbidden field path: ${fieldHit}`
              : `forbidden user-state key: ${op.key}`
        debugLogger.error(SOURCE, `refused to queue ${op.kind} (DP-7): ${reason}`)
        toastFeedback.error('该设置项含敏感信息,不能同步,已阻止。')
        return Promise.reject(new Error(`DP-7 forbidden user-state payload: ${reason}`))
      }
    }

    const resourceKey = computeResourceKey(op)
    const run = (): Promise<string> => doEnqueue(op, resourceKey)
    // chat messages(resourceKey=null)不串行(每条独立 op,不 coalesce),直接 run。
    if (resourceKey === null) return run()
    // G1-a R2 F1:同 key 串行 —— 后一个 enqueue 等前一个 putWrite 完成再 getAllWrites,保证 coalesce。
    const prev = enqueueChain.get(resourceKey) ?? Promise.resolve()
    const real = prev.then(run, run)
    // slot 用 always-resolved 包装:real 若 reject(DP-7 / queue full)不污染后续链、不触发 unhandled rejection。
    const slot: Promise<unknown> = real.then(
      () => undefined,
      () => undefined,
    )
    enqueueChain.set(resourceKey, slot)
    // settled 后若本 slot 仍是最新(无更新 enqueue 接管)则 prune,防 Map 随 distinct key 无界增长。
    slot.then(() => {
      if (enqueueChain.get(resourceKey) === slot) enqueueChain.delete(resourceKey)
    })
    return real
  }

  const drain = async (): Promise<DrainResult> => {
    if (paused) return { processed: 0, successes: 0, failures: 0, terminals: 0, paused: true }
    if (draining) return { processed: 0, successes: 0, failures: 0, terminals: 0, paused: false }
    draining = true
    let processed = 0
    let successes = 0
    let failures = 0
    let terminals = 0
    try {
      const userId = getPersistUserId()
      const ts = now()
      const all = await getAllWrites()

      // Recovery pass — runs on a fresh drain (draining was false, so no other drain in
      // this session is mid-flight). Two crash-recovery concerns (Greptile P1 #1 + #4):
      //  (a) in-flight records left by a prior session that died during `await executor`
      //      would be orphaned forever (drain only picks pending/paused-401). Reset them
      //      to pending so they replay — the idempotency key is preserved, so the server
      //      dedupes if the crashed write actually landed (200 existing).
      //  (b) anonymous-tagged records from a pre-auth session: after login, drain filters
      //      by the real userId so anonymous records would orphan. Claim them for the now-
      //      authenticated user (mirrors FX-6 first-user-claims-legacy). Idempotent: after
      //      re-tag they're the user's, not anonymous, so the next drain finds none.
      let recovered = 0
      for (const r of all) {
        let changed = false
        if (r.userId === ANONYMOUS_USER_ID && userId !== ANONYMOUS_USER_ID) {
          r.userId = userId
          changed = true
        }
        if (r.status === 'in-flight' && r.userId === userId) {
          r.status = 'pending'
          r.nextAttemptAt = ts
          r.lastError = 'recovered in-flight'
          changed = true
        }
        if (changed) {
          await putWrite(r)
          recovered++
        }
      }
      if (recovered > 0)
        debugLogger.log(SOURCE, `recovered ${recovered} record(s) from a prior session`)

      const due = all
        .filter(
          (r) =>
            r.userId === userId &&
            (r.status === 'pending' || r.status === 'paused-401') &&
            r.nextAttemptAt <= ts,
        )

      // R7-1:稳定拓扑排序(替换 R6-1 的标量 dependencyRank)。只沿真实 FK 边约束顺序,其余一律保持
      // 原序——防混合批中无关记录跨过有 FK 边的记录(见 stableTopologicalSort 注释)。
      const sortedDue = stableTopologicalSort(due)

      for (const rec of sortedDue) {
        if (paused) break // a prior op in this cycle got 401 → stop
        rec.status = 'in-flight'
        rec.lastAttemptAt = ts
        await putWrite(rec)

        let outcome: WriteOutcome
        try {
          outcome = await executor(rec.op, rec.idempotencyKey)
        } catch (error) {
          // An executor must return outcomes, not throw. If it does, treat as transient
          // (retry with backoff) rather than crashing the drain loop.
          outcome = { status: 'transient', message: `executor threw: ${msg(error)}` }
        }
        processed++

        switch (outcome.status) {
          case 'success':
            // P2-1: success path must surface via debugLogger (development-logging
            // invariant — successful state changes are log-level, never silent). The
            // record is removed from the queue only after the executor confirms the write
            // landed; rec.attempts counts prior transient failures (0 on a clean send).
            debugLogger.log(
              SOURCE,
              `write ${rec.id} (${rec.resourceKey ?? rec.op.kind}) succeeded after ${rec.attempts + 1} attempt(s); removed from queue`,
            )
            // G1-a R2 F1:把服务端返回的新 revision 回灌调用方(store),下一次 strict update 用 fresh base。
            if (outcome.revision !== undefined) {
              try {
                await onSuccess?.(rec.op, { revision: outcome.revision })
              } catch (cbErr) {
                debugLogger.warn(SOURCE, `onSuccess callback threw: ${msg(cbErr)}`)
              }
            }
            await deleteWrite(rec.id)
            successes++
            break
          case 'conflict':
            // 409 revision conflict — do NOT blindly retry (it would 409 again on the
            // stale base). Surface + fire onConflict for the app's rebase, then terminal.
            debugLogger.warn(
              SOURCE,
              `write ${rec.id} (${rec.resourceKey ?? rec.op.kind}) conflicted with server revision ${outcome.currentRevision}`,
            )
            toastFeedback.warn('你的部分改动与服务器版本冲突,请刷新画布。')
            try {
              onConflict?.(rec.op, outcome.currentRevision)
            } catch (cbErr) {
              debugLogger.warn(SOURCE, `onConflict callback threw: ${msg(cbErr)}`)
            }
            // FX-7 / A6: durable terminal ledger (audit trail for A3 gray window stats).
            // Must precede deleteWrite so the entry is durable before the record is removed.
            await recordTerminal(rec, 'conflict', `server revision ${outcome.currentRevision}`)
            await deleteWrite(rec.id)
            terminals++
            break
          case 'too-large':
            debugLogger.error(
              SOURCE,
              `write ${rec.id} rejected as too large (limit ${outcome.limit}); not retrying same payload`,
            )
            toastFeedback.error('这条改动内容过大,无法保存。')
            await recordTerminal(rec, 'too-large', `limit ${outcome.limit}`)
            await deleteWrite(rec.id)
            terminals++
            break
          case 'reuse-conflict':
            debugLogger.error(
              SOURCE,
              `write ${rec.id} idempotency-key reuse conflict (key ${outcome.key})`,
            )
            toastFeedback.error('保存失败,请重试该改动。')
            await recordTerminal(rec, 'reuse-conflict', `key ${outcome.key}`)
            await deleteWrite(rec.id)
            terminals++
            break
          case 'rejected':
            debugLogger.error(
              SOURCE,
              `write ${rec.id} rejected by server: ${JSON.stringify(outcome.body).slice(0, 200)}`,
            )
            toastFeedback.error('这条改动无法保存,可能内容有误。')
            await recordTerminal(rec, 'rejected', JSON.stringify(outcome.body).slice(0, 200))
            await deleteWrite(rec.id)
            terminals++
            break
          case 'terminal':
            debugLogger.error(SOURCE, `write ${rec.id} terminal failure: ${outcome.message}`)
            toastFeedback.error('保存失败,请重试。')
            await recordTerminal(rec, 'terminal', outcome.message)
            await deleteWrite(rec.id)
            terminals++
            break
          case 'transient': {
            const attempts = rec.attempts + 1
            if (attempts >= maxAttempts) {
              debugLogger.error(
                SOURCE,
                `write ${rec.id} dead-lettered after ${attempts} attempts: ${outcome.message}`,
              )
              toastFeedback.error('多次重试失败,部分改动未能保存。')
              await recordTerminal(rec, 'dead-letter', `after ${attempts} attempts: ${outcome.message}`)
              await deleteWrite(rec.id)
              terminals++
            } else {
              const delay = backoffDelay(attempts, baseDelay, maxDelay, rand)
              rec.attempts = attempts
              rec.nextAttemptAt = now() + delay
              rec.status = 'pending'
              rec.lastError = outcome.message
              await putWrite(rec)
              debugLogger.warn(
                SOURCE,
                `write ${rec.id} transient failure (attempt ${attempts}); retry in ${delay}ms: ${outcome.message}`,
              )
              failures++
            }
            break
          }
          case 'unauthorized':
            // 401 — pause the whole queue. The op + all pending stay in IDB (don't
            // clear); resume() after re-auth drains them. Per lead decision.
            rec.status = 'paused-401'
            rec.lastError = 'unauthorized'
            await putWrite(rec)
            paused = true
            debugLogger.warn(
              SOURCE,
              `write ${rec.id} got 401; queue paused (data retained for re-login replay)`,
            )
            toastFeedback.info('登录已过期,重新登录后将自动重试未保存的改动。')
            break
          case 'unsupported-retained': {
            // G1-a P1-3:canvas/chat op 当前 executor 不支持(G1-c 挂 N2-0 / DP-6R 另一 worker)。
            // 绝不 deleteWrite(否则 G1-c/DP-6R 上线前遗留的 durable 记录被不可恢复删除);
            // 标 deferred 留存 —— 不发请求(deferred 不在 due 过滤的 pending|paused-401 内,下次 drain 不再取出),
            // 等 executor 升级后由 G1-c/DP-6R 显式 flip deferred→pending 再 drain。
            rec.status = 'deferred'
            rec.lastError = outcome.message
            await putWrite(rec)
            debugLogger.log(
              SOURCE,
              `write ${rec.id} (${rec.resourceKey ?? rec.op.kind}) deferred — unsupported op retained for executor upgrade: ${outcome.message}`,
            )
            break
          }
        }
        if (paused) break
      }
    } finally {
      draining = false
    }
    return { processed, successes, failures, terminals, paused }
  }

  const resume = async (): Promise<void> => {
    if (!paused) return
    paused = false
    debugLogger.log(SOURCE, 'queue resumed (auth restored); draining pending writes')
    await drain()
  }

  const pause = (): void => {
    if (paused) return
    paused = true
    debugLogger.log(SOURCE, 'queue paused')
  }

  const start = async (): Promise<void> => {
    if (timer !== undefined) return
    const trigger = () => {
      void drain()
    }
    timer = setInterval(trigger, drainInterval)
    if (typeof window !== 'undefined') {
      onlineHandler = trigger
      window.addEventListener('online', trigger)
      visibilityHandler = () => {
        if (document.visibilityState === 'visible') trigger()
      }
      document.addEventListener('visibilitychange', visibilityHandler)
    }
    // Restore the paused state if leftover paused-401 records exist from a prior session
    // (Greptile P1 #2). `paused` is in-memory and resets to false on each new instance, so
    // without this a reload would replay paused-401 records (each getting 401 again) before
    // the auth layer calls resume(). Restore the pause; resume() (after successful re-auth)
    // clears it and drains. The auth layer MUST call resume() once /api/auth/me confirms
    // the session is valid (documented in the design doc).
    const userId = getPersistUserId()
    const all = await getAllWrites()
    if (all.some((r) => r.userId === userId && r.status === 'paused-401')) {
      paused = true
      debugLogger.log(SOURCE, 'restored paused state (leftover 401 records from prior session)')
    }
    // Drain immediately — records may have persisted from a prior session (cross-session
    // durable recovery: page reloaded, IDB still holds the queue, this session picks up).
    // If paused was restored above, drain returns early (paused-401 not re-sent).
    await drain()
  }

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', onlineHandler)
      onlineHandler = undefined
    }
    if (visibilityHandler && typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = undefined
    }
  }

  const isPaused = (): boolean => paused

  const pendingCount = async (): Promise<number> => {
    const userId = getPersistUserId()
    const all = await getAllWrites()
    return all.filter(
      (r) =>
        r.userId === userId && (r.status === 'pending' || r.status === 'paused-401' || r.status === 'in-flight'),
    ).length
  }

  return { enqueue, drain, resume, pause, start, stop, isPaused, pendingCount }
}

// ── Test-only: dump all records via the module's own IDB layer + reset between tests ──
// __dumpWritesForTest reuses getAllWrites (no separate connection — avoids races).
// __resetWriteQueueDb uses store.clear() (not deleteDatabase) — deleting the whole DB
// under fake-indexeddb races open/close and can leave a blocked versionchange that
// never resolves, poisoning every subsequent test's beforeEach.

const clearIdbStore = async (): Promise<void> => {
  if (!isIdbAvailable()) return
  try {
    await runTx<undefined>('readwrite', (store) => store.clear() as IDBRequest<undefined>)
  } catch (error) {
    debugLogger.warn(SOURCE, `clear failed during reset: ${msg(error)}`)
  }
}

// FX-7 / A6: clear the terminal ledger store between tests (mirrors clearIdbStore).
const clearTerminalsStore = async (): Promise<void> => {
  if (!isIdbAvailable()) return
  try {
    await runTx<undefined>(
      'readwrite',
      (store) => store.clear() as IDBRequest<undefined>,
      TERMINALS_STORE,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `terminal clear failed during reset: ${msg(error)}`)
  }
}

// P1-4: clear the meta store (terminal counters + baseline) between tests.
const clearMetaStore = async (): Promise<void> => {
  if (!isIdbAvailable()) return
  try {
    await runTx<undefined>(
      'readwrite',
      (store) => store.clear() as IDBRequest<undefined>,
      META_STORE,
    )
  } catch (error) {
    debugLogger.warn(SOURCE, `meta clear failed during reset: ${msg(error)}`)
  }
}

export const __dumpWritesForTest = getAllWrites

/**
 * FX-7 / A6 test-only: dump the terminal ledger (dead-letter / conflict / rejected
 * entries with op summary + error code + time). Mirrors __dumpWritesForTest for the
 * ledger store; production code uses getWriteQueueTerminals() (same data, public API).
 */
export const __dumpTerminalsForTest = readAllTerminals

/** P1-4 test-only: dump the terminal counters (cumulative + baseline). */
export const __dumpTerminalCountersForTest = getWriteQueueTerminalCounters

/**
 * P1-3 test-only: shrink the blocked-upgrade timeout so a blocked-open test doesn't
 * wait the full 3s. Reset to default in __resetWriteQueueDb.
 */
export const __setIdbBlockTimeoutForTest = (ms: number): void => {
  idbBlockTimeoutMs = ms
}

/**
 * P1-4 test-only: shrink the terminal ledger cap so the eviction test doesn't have to
 * record >256 outcomes. Reset to default in __resetWriteQueueDb.
 */
export const __setMaxTerminalsForTest = (n: number): void => {
  maxTerminals = n
}

/**
 * P1-3 test-only: drop the cached IDB connection WITHOUT running store-clear ops.
 * Used by the blocked-upgrade test: a stubbed indexedDB.open that fires onblocked
 * would make __resetWriteQueueDb's clearXStore calls each wait out the full block
 * timeout (3× = 9s → test timeout), and __resetWriteQueueDb would also reset
 * idbBlockTimeoutMs. This hook just clears dbPromise so the next op reopens against
 * the (stubbed) open — the store-clear is already handled by beforeEach.
 */
export const __clearWriteQueueDbConnectionForTest = (): void => {
  dbPromise = undefined
}

/**
 * P1-3 (second-round) test-only: use an isolated DB name for the real-connection
 * blocked-upgrade tests, so a held v1 connection + module open(v2) doesn't collide
 * with the shared mivo-write-queue DB's cross-test version state. Resets the cached
 * connection so the next op reopens against the new name. Reset to DB_NAME in
 * __resetWriteQueueDb.
 */
export const __setWriteQueueDbNameForTest = (name: string): void => {
  dbName = name
  dbPromise = undefined
  blockedState = 'open'
}

/**
 * P1-4 (second-round) / P2-C (third-round) test-only: phase-keyed fault injector for the
 * atomic terminal tx. The test passes a callback invoked with the phase ('record' = the
 * entry+counter tx; 'cap' = the delete+evicted tx) + the IDBTransaction; calling
 * tx.abort() verifies the atomic property — on abort NEITHER side lands in IDB (no
 * partial commit). Production never sets this. Reset to undefined in __resetWriteQueueDb.
 */
export const __setTerminalFaultInjectorForTest = (
  fn: ((phase: 'record' | 'cap', tx: IDBTransaction) => void) | undefined,
): void => {
  terminalFaultInjector = fn
}

/**
 * P1-A (third-round) test-only: hook invoked inside onupgradeneeded with the version-
 * change transaction; a test calls tx.abort() to make the upgrade terminate with an
 * error (request.onerror) and verify the blocked state is cleared (next openDb recovers
 * IDB). Production never sets this. Reset to undefined in __resetWriteQueueDb.
 */
export const __setOpenDbUpgradeAbortHookForTest = (
  fn: ((tx: IDBTransaction) => void) | undefined,
): void => {
  openDbUpgradeAbortHook = fn
}

/**
 * P1-A test-only: observe the module-level blocked state. Used by the upgrade-error test
 * to vi.waitFor the blocked state to clear after a stuck upgrade's onerror fires (the
 * P1-A fix clears blockedState on request error/abort so the next openDb recovers IDB).
 */
export const __isWriteQueueBlockedForTest = (): boolean => blockedState === 'blocked'

/**
 * P1-A test-only: number of times the onerror branch cleared the blocked state. The
 * upgrade-error test asserts this is > 0 to prove the onerror path fired (not just the
 * late-onsuccess path).
 */
export const __onErrorBlockedClearCountForTest = (): number => onerrorBlockedClearCount

/**
 * P1-4 test-only: direct access to recordTerminal for the concurrency test (fire two
 * recordTerminal calls in parallel and assert the atomic txs serialize → ledger=2 +
 * counter delta=2, no lost update). Production code calls recordTerminal via the drain.
 */
export const __recordTerminalForTest = (
  rec: QueuedWrite,
  status: TerminalLedgerStatus,
  message: string,
): Promise<void> => recordTerminal(rec, status, message)

/**
 * P1-4 test-only: dump ONLY the IDB terminal ledger (no mem union). Used by the fault-
 * inject test to assert that an aborted tx left no entry in IDB (the union with mem
 * would show the mem-fallback entry, masking the atomic property).
 */
export const __dumpIdbTerminalsForTest = async (): Promise<TerminalLedgerEntry[]> => {
  if (!isIdbAvailable()) return []
  try {
    return await runTx<TerminalLedgerEntry[]>(
      'readonly',
      (store) => store.getAll() as IDBRequest<TerminalLedgerEntry[]>,
      TERMINALS_STORE,
    )
  } catch {
    return []
  }
}

/**
 * P1-4 test-only: read ONLY the IDB terminal counters (no mem union). Used by the
 * fault-inject test to assert the IDB counter is unchanged on an aborted tx.
 */
export const __readIdbTerminalCountersForTest = async (): Promise<TerminalCounterShape> => {
  if (!isIdbAvailable()) return { ...ZERO_COUNTERS }
  try {
    const entry = await runTx<{ key: string; value: TerminalCounterShape } | undefined>(
      'readonly',
      (store) => store.get(TERMINAL_COUNTERS_KEY) as IDBRequest<{ key: string; value: TerminalCounterShape } | undefined>,
      META_STORE,
    )
    return entry?.value ?? { ...ZERO_COUNTERS }
  } catch {
    return { ...ZERO_COUNTERS }
  }
}

/**
 * G1-a R4 F2 test-only:直接 putWrite 一批构造好的记录(含受控 id / createdAt / nextAttemptAt),
 * 让单测能精确复现"同毫秒多资源链 + 逆境 IDB key 顺序"——enqueue 路径用随机 UUID 不便控制 key 序。
 * 与 __dumpWritesForTest / __resetWriteQueueDb 同为 test-only accessor;生产代码不调用。
 */
export const __seedWritesForTest = async (records: QueuedWrite[]): Promise<void> => {
  for (const record of records) {
    await putWrite(record)
  }
}

export const __resetWriteQueueDb = async (): Promise<void> => {
  memStore.clear()
  // FX-7 / A6: clear the terminal ledger + its memStore fallback too.
  terminalMem.clear()
  // P1-4: clear the counter mem fallbacks + restore defaults.
  terminalCountersMem = { ...ZERO_COUNTERS }
  inFlightCountersMem = { ...ZERO_COUNTERS }
  terminalCountersBaselineMem = null
  maxTerminals = DEFAULT_MAX_TERMINALS
  idbBlockTimeoutMs = 3000
  // P1-3 (second-round): clear the blocked-state + fault injector + DB name so a prior
  // test's isolated DB / blocked state / fault injection never leaks into the next.
  blockedState = 'open'
  dbName = DB_NAME
  terminalFaultInjector = undefined
  // P1-A (third-round): reset the request token + upgrade-abort hook so a prior test's
  // blocked-owner token / upgrade-abort injection never leaks.
  blockedRequestToken = 0
  onerrorBlockedClearCount = 0
  openDbUpgradeAbortHook = undefined
  // Drop the cached connection so the next op reopens against the (now-cleared) store.
  dbPromise = undefined
  await clearIdbStore()
  await clearTerminalsStore()
  await clearMetaStore()
  // Reset the IDB-degradation toast debounce so each test starts with a fresh first-failure
  // toast window (P1-2). clearIdbStore is test-internal and uses plain debugLogger.warn (not
  // warnIdbDegradation), so it never sets the flag — a prior test's data-path failure may have.
  idbDegradationWarned = false
}
