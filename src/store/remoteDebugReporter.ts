// remoteDebugReporter — FX-7 transport hardening (A6 · D-4 delete-track hard prereq).
//
// Goal: when the BFF jitters (503 / net glitch / pm2 restart), a remote debug batch
// must NOT be silently swallowed. Failed batches land in a durable IndexedDB outbox
// (survives refresh), replay with exponential backoff, and after exhausting retries
// the drop is counted (persisted, queryable) — never a silent loss. This is the
// observation base for A3 persist gray window (dead-letter/conflict terminal stats
// must be durably auditable, "record-then-delete" was not).
//
// Boundary (lead A6 task pack):
//  - Does NOT change WHAT is reported (warning/error only, same payload shape, same
//    /api/mivo/debug-logs endpoint). Only adds durable retry + drop accounting.
//  - IDB layer mirrors writeRetryQueue's degradation pattern: IDB unavailable (private
//    mode) → in-memory fallback (survives a pm2-restart window, not a reload) + one
//    user-visible warn toast so a refresh-may-lose-diagnostics state is never silent.
//
// Logging invariant (docs/development-logging.md): success / skip / drop paths all
// surface via debugLogger. The drop count is queryable via getRemoteDebugDropCount()
// and surfaced in the Debug Log panel (ProjectSidebar).
//
// Module cycle note: debugLogStore imports reportRemoteDebugEntry from here. The cycle
// is benign — neither module calls the other at module-eval time (debugLogger methods
// run later, by which point ESM live bindings are populated). Same pattern as
// writeRetryQueue importing debugLogger from ../store/debugLogStore.

import { useDebugLogStore, type DebugLogLevel } from './debugLogStore'
import { toastFeedback } from './toastStore'

type ReportableDebugLogLevel = Extract<DebugLogLevel, 'warning' | 'error'>

export type RemoteDebugQueuedEntry = {
  level: DebugLogLevel
  source: string
  message: string
  timestamp: number
}

export type RemoteDebugClientInfo = {
  clientId: string
  sessionId: string
  appVersion: string
  pagePath: string
  userAgent: string
  language: string
  timezone: string
  screen: {
    width: number
    height: number
    pixelRatio: number
  }
}

export type RemoteDebugPayload = RemoteDebugClientInfo & {
  entries: Array<RemoteDebugQueuedEntry & { level: ReportableDebugLogLevel }>
}

type ClientInfoOptions = {
  storage: Storage
  createId: () => string
  sessionId: string
  locationPath: string
  userAgent: string
  language: string
  timezone: string
  screen: RemoteDebugClientInfo['screen']
  appVersion?: string
}

const SOURCE = 'Remote Debug'

// FX-7: surface outbox / drop / degradation events to the LOCAL Debug Log panel only.
// We deliberately bypass debugLogger.warn/error here because those re-enqueue the
// entry for remote reporting (debugLogStore.debugLogger.warn → reportRemoteDebugEntry),
// which would create a feedback loop: a failed flush logs a warning, that warning gets
// queued for remote upload, the next flush tries to send it, fails, logs another
// warning, … Writing directly to the Debug Log store breaks the loop while keeping the
// operator-visible audit trail in the panel (the drop count is the authoritative metric
// for A3 observation; these local log lines are the human-readable companion).
const logLocal = (level: DebugLogLevel, message: string): void => {
  useDebugLogStore.getState().addEntry({ level, source: SOURCE, message })
}

const clientIdStorageKey = 'mivo.remoteDebug.clientId'
const batchDelayMs = 2000
const maxBatchSize = 10
const defaultEndpoint = '/api/mivo/debug-logs'

// FX-7 retry constants (exponential backoff with jitter, mirroring writeRetryQueue).
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_BASE_DELAY = 1000
const DEFAULT_MAX_DELAY = 60_000
// Cap the durable outbox so a permanently-down collector cannot grow IDB unbounded.
// Oldest pending batch is evicted (non-silent) on overflow — same posture as
// writeRetryQueue's overflow path.
const DEFAULT_MAX_OUTBOX = 64

let sessionId = ''
let flushTimer: ReturnType<typeof setTimeout> | undefined
let outboxTimer: ReturnType<typeof setTimeout> | undefined
let queue: RemoteDebugQueuedEntry[] = []
let installed = false

// ── Test-injectable seams (default to real globals; tests override via hooks) ──
type TestHooks = {
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
  buildClientInfo?: () => RemoteDebugClientInfo
  // Force-enable reporting in non-browser test envs (node/vitest has no `window`, so
  // remoteDebugEnabled() would otherwise false-negative and the flush/outbox paths
  // would be no-ops). Undefined → fall back to the real browser gate.
  enabled?: boolean
}

let testFetch: typeof fetch | undefined
let testNow: (() => number) | undefined
let testRandom: (() => number) | undefined
let testBuildClientInfo: (() => RemoteDebugClientInfo) | undefined
let testEnabled: boolean | undefined

const resolveFetch = (): typeof fetch => testFetch ?? globalThis.fetch
const now = (): number => (testNow ?? Date.now)()
const random = (): number => (testRandom ?? Math.random)()

const createId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `debug-${now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const readTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  } catch {
    return 'unknown'
  }
}

const readSessionId = () => {
  if (!sessionId) sessionId = createId()
  return sessionId
}

export const shouldReportRemoteDebugLevel = (level: DebugLogLevel): level is ReportableDebugLogLevel =>
  level === 'warning' || level === 'error'

export const resolveRemoteDebugEndpoint = (configuredEndpoint = import.meta.env.VITE_MIVO_DEBUG_ENDPOINT || '') =>
  configuredEndpoint.trim() || defaultEndpoint

export const createRemoteDebugClientInfo = ({
  storage,
  createId: createClientId,
  sessionId: nextSessionId,
  locationPath,
  userAgent,
  language,
  timezone,
  screen,
  appVersion = import.meta.env.VITE_MIVO_VERSION || '0.0.0',
}: ClientInfoOptions): RemoteDebugClientInfo => {
  const existingClientId = storage.getItem(clientIdStorageKey)
  const clientId = existingClientId || createClientId()

  if (!existingClientId) storage.setItem(clientIdStorageKey, clientId)

  return {
    clientId,
    sessionId: nextSessionId,
    appVersion,
    pagePath: locationPath,
    userAgent,
    language,
    timezone,
    screen,
  }
}

const createBrowserClientInfo = (): RemoteDebugClientInfo => {
  const builder = testBuildClientInfo ?? (() =>
    createRemoteDebugClientInfo({
      storage: window.localStorage,
      createId,
      sessionId: readSessionId(),
      locationPath: `${window.location.pathname}${window.location.search}`,
      userAgent: navigator.userAgent,
      language: navigator.language || 'unknown',
      timezone: readTimezone(),
      screen: {
        width: window.screen?.width || window.innerWidth || 0,
        height: window.screen?.height || window.innerHeight || 0,
        pixelRatio: window.devicePixelRatio || 1,
      },
    })
  )
  return builder()
}

export const buildRemoteDebugPayload = (
  entries: RemoteDebugQueuedEntry[],
  clientInfo: RemoteDebugClientInfo,
): RemoteDebugPayload => ({
  ...clientInfo,
  entries: entries.filter((entry): entry is RemoteDebugQueuedEntry & { level: ReportableDebugLogLevel } =>
    shouldReportRemoteDebugLevel(entry.level),
  ),
})

const remoteDebugEnabled = () =>
  testEnabled ?? (typeof window !== 'undefined' && import.meta.env.VITE_MIVO_REMOTE_DEBUG !== '0')

const sendPayload = async (payload: RemoteDebugPayload) => {
  if (!payload.entries.length) return

  const fetchImpl = resolveFetch()
  const response = await fetchImpl(resolveRemoteDebugEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: JSON.stringify(payload).length < 60_000,
  })
  // FX-7: a non-2xx (BFF 5xx during jitter, 4xx collector rejection) is a retryable
  // failure — the batch did not land. Throwing here routes it to the durable outbox
  // (flushRemoteDebugEntries catch) so it is retried with backoff rather than silently
  // swallowed. A persistently-rejected batch exhausts retries → drop count (non-silent).
  if (!response.ok) {
    throw new Error(`debug-logs HTTP ${response.status}`)
  }
}

// ── Durable IDB outbox + drop count (mirrors writeRetryQueue degradation pattern) ──
//
// Separate DB from mivo-write-queue + mivo-canvas-persist so diagnostic retry state
// never couples with persist state. IDB unavailable (private mode) → in-memory Map
// (survives a pm2-restart window, not a reload) + one warn toast (debounced).

const DB_NAME = 'mivo-remote-debug'
const DB_VERSION = 1
const OUTBOX_STORE = 'outbox'
const META_STORE = 'meta'
const DROP_COUNT_KEY = 'dropCount'

export type RemoteDebugOutboxRecord = {
  id: string
  payload: RemoteDebugPayload
  attempts: number
  nextAttemptAt: number
  lastError?: string
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | undefined
const outboxMem = new Map<string, RemoteDebugOutboxRecord>()
let dropCountMem = 0
let idbDegradationWarned = false

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const isIdbAvailable = (): boolean => typeof indexedDB !== 'undefined' && indexedDB !== null

const warnIdbDegradation = (context: string, error: unknown): void => {
  logLocal('warning', `${context}; using in-memory fallback: ${msg(error)}`)
  if (!idbDegradationWarned) {
    idbDegradationWarned = true
    toastFeedback.warn('远程诊断仅内存暂存,刷新页面可能丢失未上报的诊断记录。')
  }
}

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  // A failed open must not poison subsequent calls — drop the cached promise so the
  // next op retries from scratch (mirrors writeRetryQueue's openDb).
  dbPromise.catch(() => {
    dbPromise = undefined
  })
  return dbPromise
}

const runTx = <T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
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

const getAllOutbox = async (): Promise<RemoteDebugOutboxRecord[]> => {
  if (!isIdbAvailable()) return Array.from(outboxMem.values())
  try {
    const idbRecords = await runTx<RemoteDebugOutboxRecord[]>(
      OUTBOX_STORE,
      'readonly',
      (store) => store.getAll() as IDBRequest<RemoteDebugOutboxRecord[]>,
    )
    // Union with memStore so a record that fell back to memStore when an IDB tx failed
    // is not invisible to a plain IDB read (writeRetryQueue's Greptile P1 #3 union).
    const idbIds = new Set(idbRecords.map((r) => r.id))
    const memOnly = Array.from(outboxMem.values()).filter((r) => !idbIds.has(r.id))
    return [...idbRecords, ...memOnly]
  } catch (error) {
    warnIdbDegradation('outbox getAll failed', error)
    return Array.from(outboxMem.values())
  }
}

const putOutbox = async (record: RemoteDebugOutboxRecord): Promise<void> => {
  if (!isIdbAvailable()) {
    outboxMem.set(record.id, record)
    return
  }
  try {
    await runTx<IDBValidKey>(OUTBOX_STORE, 'readwrite', (store) => store.put(record))
    // IDB now has it — drop any stale memStore fallback so the next getAll sees one copy.
    outboxMem.delete(record.id)
  } catch (error) {
    // Never silently lose a failed batch — fall back to memory so it still drains this
    // session. warnIdbDegradation makes the degradation visible + toasts once.
    warnIdbDegradation(`outbox put failed for ${record.id}`, error)
    outboxMem.set(record.id, record)
  }
}

const deleteOutbox = async (id: string): Promise<void> => {
  // Always clean the memStore fallback (the record may live there if a prior put failed).
  outboxMem.delete(id)
  if (!isIdbAvailable()) return
  try {
    await runTx<undefined>(OUTBOX_STORE, 'readwrite', (store) => store.delete(id) as IDBRequest<undefined>)
  } catch (error) {
    // delete failures don't retain data in memory and stay warn-only (no toast).
    logLocal('warning', `outbox delete failed for ${id}: ${msg(error)}`)
  }
}

const readDropCount = async (): Promise<number> => {
  if (!isIdbAvailable()) return dropCountMem
  try {
    const entry = await runTx<{ key: string; value: number } | undefined>(
      META_STORE,
      'readonly',
      (store) => store.get(DROP_COUNT_KEY) as IDBRequest<{ key: string; value: number } | undefined>,
    )
    const idbCount = entry?.value ?? 0
    // Mirror the larger of IDB / mem so a mem-only fallback drop is not lost when IDB
    // recovers mid-session (writeRetryQueue's union discipline, Greptile P1 #3).
    return Math.max(idbCount, dropCountMem)
  } catch (error) {
    warnIdbDegradation('dropCount read failed', error)
    return dropCountMem
  }
}

const incrementDropCount = async (by = 1): Promise<number> => {
  const current = await readDropCount()
  const next = current + by
  if (!isIdbAvailable()) {
    dropCountMem = next
    return next
  }
  try {
    await runTx<IDBValidKey>(META_STORE, 'readwrite', (store) =>
      store.put({ key: DROP_COUNT_KEY, value: next }),
    )
    dropCountMem = next
    return next
  } catch (error) {
    warnIdbDegradation('dropCount increment failed', error)
    dropCountMem = next
    return next
  }
}

// ── Retry backoff (exponential + jitter, mirroring writeRetryQueue.backoffDelay) ──

const backoffDelay = (attempts: number, base: number, max: number, rand: () => number): number => {
  const exp = base * Math.pow(2, attempts - 1)
  const capped = Math.min(exp, max)
  return Math.floor(capped * (0.5 + rand() * 0.5))
}

const earliestNextAttempt = (records: RemoteDebugOutboxRecord[]): number | null => {
  let earliest: number | null = null
  for (const r of records) {
    if (earliest === null || r.nextAttemptAt < earliest) earliest = r.nextAttemptAt
  }
  return earliest
}

const scheduleOutboxDrain = (): void => {
  if (typeof globalThis.setTimeout !== 'function') return
  // Schedule a retry for the earliest-due outbox record. Coalesce into one timer;
  // recompute on each fire so fresh failures push the next attempt out.
  void getAllOutbox().then((records) => {
    if (!records.length) return
    const earliest = earliestNextAttempt(records)
    if (earliest === null) return
    const delay = Math.max(0, earliest - now())
    if (outboxTimer !== undefined) globalThis.clearTimeout(outboxTimer)
    outboxTimer = globalThis.setTimeout(() => {
      outboxTimer = undefined
      void drainRemoteDebugOutbox()
    }, delay)
  })
}

/**
 * FX-7 durable outbox drain: replay failed batches whose backoff window has elapsed.
 * Success → delete from outbox. Failure → bump attempts + backoff; after maxRetries
 * the batch is dropped BUT the drop is counted (persisted, queryable) + surfaced via
 * debugLogger.error — never a silent loss. Returns a summary for tests + A3 observation.
 *
 * Concurrency: single-threaded via the module-level `draining` guard (like
 * writeRetryQueue). A re-entrant call while a drain is mid-flight is a no-op.
 */
let draining = false

export type RemoteDebugDrainResult = {
  processed: number
  sent: number
  dropped: number
  retained: number
}

export const drainRemoteDebugOutbox = async (): Promise<RemoteDebugDrainResult> => {
  if (draining) return { processed: 0, sent: 0, dropped: 0, retained: 0 }
  draining = true
  let processed = 0
  let sent = 0
  let dropped = 0
  let retained = 0
  try {
    const ts = now()
    const records = await getAllOutbox()
    const due = records
      .filter((r) => r.nextAttemptAt <= ts)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)

    for (const record of due) {
      processed++
      try {
        await sendPayload(record.payload)
        await deleteOutbox(record.id)
        sent++
        logLocal('log', `outbox batch ${record.id} delivered after ${record.attempts + 1} attempt(s); removed from outbox`)
      } catch (error) {
        const attempts = record.attempts + 1
        const message = msg(error)
        if (attempts >= DEFAULT_MAX_RETRIES) {
          // Drop — but count it (non-silent). The drop count is the audit trail; the
          // batch itself is removed so a permanently-down collector cannot grow IDB.
          const totalDropped = await incrementDropCount(1)
          await deleteOutbox(record.id)
          dropped++
          logLocal(
            'error',
            `outbox batch ${record.id} dropped after ${attempts} attempts (total dropped: ${totalDropped}): ${message}`,
          )
        } else {
          const delay = backoffDelay(attempts, DEFAULT_BASE_DELAY, DEFAULT_MAX_DELAY, random)
          record.attempts = attempts
          record.nextAttemptAt = now() + delay
          record.lastError = message
          await putOutbox(record)
          retained++
          logLocal(
            'warning',
            `outbox batch ${record.id} transient failure (attempt ${attempts}); retry in ${delay}ms: ${message}`,
          )
        }
      }
    }
    // Re-arm the timer for any retained (later-due) records.
    scheduleOutboxDrain()
  } finally {
    draining = false
  }
  return { processed, sent, dropped, retained }
}

/**
 * Query the persisted drop count (survives refresh). Surfaced in the Debug Log panel
 * header (ProjectSidebar) so operators can see unrecoverable diagnostic losses during
 * the A3 gray observation window without scraping logs.
 */
export const getRemoteDebugDropCount = async (): Promise<number> => readDropCount()

/**
 * Query the current durable outbox depth (batches pending retry). For A3 observation
 * (pending outbox should stay bounded; a climbing count signals a down collector).
 */
export const getRemoteDebugOutboxCount = async (): Promise<number> => (await getAllOutbox()).length

// ── Public flush + report ──

const persistFailedBatch = async (batch: RemoteDebugQueuedEntry[], error: unknown): Promise<void> => {
  const payload = buildRemoteDebugPayload(batch, createBrowserClientInfo())
  if (!payload.entries.length) return // nothing reportable in the batch — don't queue empties

  const existing = await getAllOutbox()
  // Overflow guard: cap the durable outbox so a permanently-down collector cannot grow
  // IDB unbounded. Evict the oldest pending batch (non-silent) when at capacity.
  if (existing.length >= DEFAULT_MAX_OUTBOX) {
    const oldest = existing.slice().sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0]
    if (oldest) {
      await deleteOutbox(oldest.id)
      const totalDropped = await incrementDropCount(1)
      logLocal(
        'error',
        `outbox overflow (${existing.length}/${DEFAULT_MAX_OUTBOX}); evicted oldest batch ${oldest.id} (total dropped: ${totalDropped})`,
      )
    }
  }

  const createdAt = now()
  const record: RemoteDebugOutboxRecord = {
    id: createId(),
    payload,
    attempts: 0,
    nextAttemptAt: createdAt + backoffDelay(1, DEFAULT_BASE_DELAY, DEFAULT_MAX_DELAY, random),
    lastError: msg(error),
    createdAt,
  }
  await putOutbox(record)
  logLocal(
    'warning',
    `failed to report ${payload.entries.length} diagnostic entr${payload.entries.length === 1 ? 'y' : 'ies'}; batch ${record.id} persisted to durable outbox (retry in ${record.nextAttemptAt - createdAt}ms): ${record.lastError}`,
  )
  scheduleOutboxDrain()
}

export const flushRemoteDebugEntries = async () => {
  if (!remoteDebugEnabled() || !queue.length) {
    // Even with an empty fresh queue, try to replay any durable outbox left by a prior
    // refresh — a page load is the natural recovery moment for a previously-down BFF.
    if (remoteDebugEnabled()) void drainRemoteDebugOutbox()
    return
  }

  const batch = queue
  queue = []
  if (flushTimer !== undefined) {
    globalThis.clearTimeout(flushTimer)
    flushTimer = undefined
  }

  try {
    await sendPayload(buildRemoteDebugPayload(batch, createBrowserClientInfo()))
    // Success — the server is up; opportunistically replay any durable outbox so a
    // prior-jitter batch is not stuck waiting for its backoff timer.
    void drainRemoteDebugOutbox()
  } catch (error) {
    // FX-7: failed batches are NO LONGER silently swallowed — persist to the durable
    // outbox and retry with backoff. Remote diagnostics must never interrupt the user's
    // canvas workflow, so persistence itself must not throw out of flush.
    await persistFailedBatch(batch, error)
  }
}

export const reportRemoteDebugEntry = (entry: RemoteDebugQueuedEntry) => {
  if (!remoteDebugEnabled() || !shouldReportRemoteDebugLevel(entry.level)) return

  queue.push(entry)
  if (queue.length >= maxBatchSize) {
    void flushRemoteDebugEntries()
    return
  }

  if (flushTimer === undefined && typeof globalThis.setTimeout === 'function') {
    flushTimer = globalThis.setTimeout(() => {
      flushTimer = undefined
      void flushRemoteDebugEntries()
    }, batchDelayMs)
  }
}

export const installRemoteDebugReporter = () => {
  if (!remoteDebugEnabled() || installed) return
  installed = true

  // Replay any durable outbox left by a prior session (cross-refresh recovery: a batch
  // that failed before the refresh survives in IDB and replays here).
  void drainRemoteDebugOutbox()

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flushRemoteDebugEntries()
    })
    // The browser coming back online is the strongest signal that a previously-down BFF
    // may be reachable — drain immediately rather than waiting for the backoff timer.
    window.addEventListener('online', () => {
      void drainRemoteDebugOutbox()
    })
  }
}

// ── Test-only hooks (mirrors writeRetryQueue's __resetWriteQueueDb pattern) ──

export const __setRemoteDebugTestHooks = (hooks: TestHooks): void => {
  if (hooks.fetchImpl !== undefined) testFetch = hooks.fetchImpl
  if (hooks.now !== undefined) testNow = hooks.now
  if (hooks.random !== undefined) testRandom = hooks.random
  if (hooks.buildClientInfo !== undefined) testBuildClientInfo = hooks.buildClientInfo
  if (hooks.enabled !== undefined) testEnabled = hooks.enabled
}

const clearOutboxStore = async (): Promise<void> => {
  if (!isIdbAvailable()) return
  try {
    await runTx<undefined>(OUTBOX_STORE, 'readwrite', (store) => store.clear() as IDBRequest<undefined>)
    await runTx<undefined>(META_STORE, 'readwrite', (store) => store.clear() as IDBRequest<undefined>)
  } catch (error) {
    // Best-effort clear during test reset; do not throw.
    logLocal('warning', `outbox clear failed during reset: ${msg(error)}`)
  }
}

/**
 * Reset all module state + durable IDB between tests. Mirrors writeRetryQueue's
 * __resetWriteQueueDb: clears queue/timers/outbox/dropCount + drops the cached DB
 * connection so the next op reopens against the cleared store.
 */
export const __resetRemoteDebugStateForTest = async (): Promise<void> => {
  queue = []
  sessionId = ''
  installed = false
  if (flushTimer !== undefined) {
    globalThis.clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (outboxTimer !== undefined) {
    globalThis.clearTimeout(outboxTimer)
    outboxTimer = undefined
  }
  draining = false
  outboxMem.clear()
  dropCountMem = 0
  idbDegradationWarned = false
  // Clear test hooks so a prior test's injection (fetch/clock/random/clientInfo/enabled)
  // does not leak into the next test's module-level singleton.
  testFetch = undefined
  testNow = undefined
  testRandom = undefined
  testBuildClientInfo = undefined
  testEnabled = undefined
  dbPromise = undefined
  await clearOutboxStore()
}
