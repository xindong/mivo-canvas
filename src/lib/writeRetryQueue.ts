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
import { isUserStateKeyForbidden } from '../../shared/persist-contract.ts'
import { getPersistUserId } from './persistUserId'
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
  | 'putUserState'
  | 'deleteUserState'
  | 'createProject'

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
  | { kind: 'putUserState'; key: string; value: unknown; baseRevision?: Revision }
  | { kind: 'deleteUserState'; key: string }
  | { kind: 'createProject'; name: string; id?: string }

// ── Persisted record + state machine ──

export type WriteStatus =
  | 'pending' // waiting to drain (nextAttemptAt <= now)
  | 'in-flight' // executor currently running
  | 'paused-401' // got 401; queue paused; kept for re-login replay
// Terminal statuses are deleted immediately after surfacing (not stored long-term):
// success / conflict / too-large / rejected / reuse-conflict / dead-letter.

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
  | { status: 'success' }
  | { status: 'conflict'; currentRevision: Revision }
  | { status: 'too-large'; limit: number }
  | { status: 'unauthorized' }
  | { status: 'reuse-conflict'; key: string }
  | { status: 'rejected'; body: unknown }
  | { status: 'transient'; message: string }
  | { status: 'terminal'; message: string }

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
    case 'appendChatMessage':
      return null
  }
}

export const isDeleteKind = (kind: WriteOpKind): boolean =>
  kind === 'deleteNode' || kind === 'deleteEdge' || kind === 'deleteAnchor' || kind === 'deleteUserState'

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
    return await runTx<QueuedWrite[]>('readonly', (store) => store.getAll() as IDBRequest<QueuedWrite[]>)
  } catch (error) {
    debugLogger.warn(SOURCE, `getAll failed; using in-memory fallback: ${msg(error)}`)
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
  } catch (error) {
    // Never silently lose a queued write — fall back to memory so it still drains this
    // session. The warn makes the degradation visible (logging invariant).
    debugLogger.warn(SOURCE, `put failed for ${record.id}; using in-memory fallback: ${msg(error)}`)
    memStore.set(record.id, record)
  }
}

const deleteWrite = async (id: string): Promise<void> => {
  if (!isIdbAvailable()) {
    memStore.delete(id)
    return
  }
  try {
    await runTx<undefined>('readwrite', (store) => store.delete(id) as IDBRequest<undefined>)
  } catch (error) {
    debugLogger.warn(SOURCE, `delete failed for ${id}: ${msg(error)}`)
    memStore.delete(id)
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
  const now = opts.clock ?? (() => Date.now())
  const rand = opts.random ?? (() => Math.random())

  let paused = false
  let draining = false
  let timer: ReturnType<typeof setInterval> | undefined
  let onlineHandler: (() => void) | undefined
  let visibilityHandler: (() => void) | undefined

  const enqueue = async (op: WriteOp): Promise<string> => {
    // DP-7: the two device-local API keys (gateway-key/mivo-key) and secret-like
    // user-state keys must NEVER enter the queue payload. Reject at the gate — never
    // persist, never send. The contract exports isUserStateKeyForbidden for exactly this.
    if (
      (op.kind === 'putUserState' || op.kind === 'deleteUserState') &&
      isUserStateKeyForbidden(op.key)
    ) {
      debugLogger.error(SOURCE, `refused to queue ${op.kind} with forbidden key (DP-7): ${op.key}`)
      toastFeedback.error('该设置项不能同步,已阻止。')
      throw new Error(`DP-7 forbidden user-state key: ${op.key}`)
    }

    const userId = getPersistUserId()
    const resourceKey = computeResourceKey(op)
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
        existing.op = op
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
      const due = all
        .filter(
          (r) =>
            r.userId === userId &&
            (r.status === 'pending' || r.status === 'paused-401') &&
            r.nextAttemptAt <= ts,
        )
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)

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
    // Drain immediately — records may have persisted from a prior session (cross-session
    // durable recovery: page reloaded, IDB still holds the queue, this session picks up).
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

export const __resetWriteQueueDb = async (): Promise<void> => {
  memStore.clear()
  // Drop the cached connection so the next op reopens against the (now-cleared) store.
  dbPromise = undefined
  await clearIdbStore()
}
