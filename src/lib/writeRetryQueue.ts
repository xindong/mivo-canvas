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
const DB_VERSION = 1
const STORE_NAME = 'writes'

const DEFAULT_MAX_QUEUE = 256
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_DELAY = 1000
const DEFAULT_MAX_DELAY = 60_000
const DEFAULT_DRAIN_INTERVAL = 5000

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
 * G1-a R4 F2 (零项目 New Canvas 修复):drain 排序的依赖感知 tie-breaker。
 *
 * canvas 写(createCanvas / updateCanvas)携带 `projectId` 作外键——服务端要求 project 先建好
 * (POST /api/canvas 缺 project → 404 unknown-project → rejected terminal,见 server/routes/canvas.ts)。
 * 零项目账号 New Canvas 的同步路径(documentSlice.createCanvas → get().createProject → 两次 enqueue)
 * 把 createProject 与 createCanvas 在**同一毫秒**入队到不同 resource-key 链:纯 timestamp 排序对二者
 * 返回 0,顺序退化为 IDB `getAll()` 的 key(id UUID)序——非确定且可能 canvas 在前,drain 先发 canvas
 * → 404 terminal → 画布记录被删,刷新后永久丢失(R4 复现)。
 *
 * tie-breaker:同 nextAttemptAt + 同 createdAt 时,canvas 类写(rank 1)排在 project 类写(rank 0)之后,
 * 保证 project prerequisite 先 drain。**最小闭环**,不引入通用 DAG / parent-lookup(只覆盖"同毫秒多资源链
 * project→canvas FK"这一类;跨毫秒时 createProject 同步先于 createCanvas 入队,timestamp 主键已保证顺序)。
 * 其余 op kind 无 project-FK 依赖 → rank 0(与 createProject 同层,顺序退化为既有稳定排序,零回归)。
 */
const dependencyRank = (op: WriteOp): number => {
  switch (op.kind) {
    case 'createCanvas':
    case 'updateCanvas':
      return 1
    default:
      return 0
  }
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
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
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
): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const request = run(tx.objectStore(STORE_NAME))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        tx.oncomplete = () => resolve(result)
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
        // 主键 nextAttemptAt(退避到期先发)+ 次键 createdAt(同 nextAttemptAt 时先入队先发)
        // + tie-breaker dependencyRank:同毫秒时 project 类写先于 canvas 类写(防零项目 New Canvas
        // 因 IDB key 序非确定致 canvas 先 drain → 404 terminal 丢失;见 dependencyRank 注释)。
        .sort(
          (a, b) =>
            a.nextAttemptAt - b.nextAttemptAt ||
            a.createdAt - b.createdAt ||
            dependencyRank(a.op) - dependencyRank(b.op),
        )

      for (const rec of due) {
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
            await deleteWrite(rec.id)
            terminals++
            break
          case 'too-large':
            debugLogger.error(
              SOURCE,
              `write ${rec.id} rejected as too large (limit ${outcome.limit}); not retrying same payload`,
            )
            toastFeedback.error('这条改动内容过大,无法保存。')
            await deleteWrite(rec.id)
            terminals++
            break
          case 'reuse-conflict':
            debugLogger.error(
              SOURCE,
              `write ${rec.id} idempotency-key reuse conflict (key ${outcome.key})`,
            )
            toastFeedback.error('保存失败,请重试该改动。')
            await deleteWrite(rec.id)
            terminals++
            break
          case 'rejected':
            debugLogger.error(
              SOURCE,
              `write ${rec.id} rejected by server: ${JSON.stringify(outcome.body).slice(0, 200)}`,
            )
            toastFeedback.error('这条改动无法保存,可能内容有误。')
            await deleteWrite(rec.id)
            terminals++
            break
          case 'terminal':
            debugLogger.error(SOURCE, `write ${rec.id} terminal failure: ${outcome.message}`)
            toastFeedback.error('保存失败,请重试。')
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

export const __dumpWritesForTest = getAllWrites

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
  // Drop the cached connection so the next op reopens against the (now-cleared) store.
  dbPromise = undefined
  await clearIdbStore()
  // Reset the IDB-degradation toast debounce so each test starts with a fresh first-failure
  // toast window (P1-2). clearIdbStore is test-internal and uses plain debugLogger.warn (not
  // warnIdbDegradation), so it never sets the flag — a prior test's data-path failure may have.
  idbDegradationWarned = false
}
