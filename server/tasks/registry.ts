// server/tasks/registry.ts
// P2-C1a: single-process in-memory task registry. State machine
// pending → running → done | failed | canceled. Persistence is P4.
//
// Cancel propagates: cancelTask() aborts the task's AbortController, which the
// runner passes to runMivoPlatformImageJob / fetchUpstreamWithTimeout as the
// upstream signal — platform poll loop breaks, llm-proxy fetch aborts. A canceled
// task never commits a result (completeTask/failTask short-circuit on 'canceled').
//
// Restart semantics: the registry is process-memory; a restart empties it. GET on
// an unknown taskId returns 404 {error:'unknown-task'} — clients must NOT commit
// results for tasks they can no longer see (per §7 C1).
//
// Owner scope (FX-2): the registry is partitioned per user by a fingerprint of the
// caller's mivo_ platform key (see server/lib/keys.ts). A task is only visible to
// requests carrying the same fingerprint — a cross-user GET/DELETE returns the
// same 404 'unknown-task' as a swept/restarted task, so existence is not leaked.
// Idempotency keys are scoped per owner too (no cross-user collision).
//
// TTL semantics (V02): terminal tasks (done/partial/failed/canceled) are stamped
// with `terminalAt` and evicted by a module-level sweeper once they are older
// than TERMINAL_TTL_MS (10 min); their idempotencyIndex entries are dropped in
// lockstep. A swept task GETs as 404 'unknown-task' — the same path as a freshly
// restarted process, so clients already tolerate it. The sweeper runs every
// SWEEP_INTERVAL_MS (60s) and is .unref()'d so it never blocks process exit.

import { randomUUID } from 'node:crypto'
import { fingerprintOfPlatformKey } from '../lib/keys'

export type TaskStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed' | 'canceled'
// P2-C2: 'variations' is a batch of N parallel edits sharing one source image;
// its result carries per-variation images (with variationIndex) + a failures[]
// list for the subset that didn't settle successfully (status='partial').
export type TaskKind = 'generate' | 'edit' | 'variations'
export type TaskFailure = { variationIndex: number; error: string }
export type TaskResultImage = { b64: string; variationIndex?: number }
export type TaskResult = { images: TaskResultImage[] }

export type TaskRecord = {
  id: string
  // FX-2: per-user owner fingerprint (sha256 of the caller's mivo_ key). A task is
  // only visible to requests with the same fingerprint (getTaskForOwner); a
  // cross-user GET/DELETE returns 404 'unknown-task' (no existence leak).
  ownerFp: string
  kind: TaskKind
  status: TaskStatus
  progress: number // 0-100, monotonic (never decreases)
  stage: string // 'pending' | 'submit' | 'poll' | 'download' | 'request' | 'done' | 'failed' | 'canceled'
  requestId: string
  model: string
  result?: TaskResult
  // P2-C2: variations-only fields. failures[] lists the variation indices that
  // didn't settle successfully (status='partial'); batchId groups the N parallel
  // edits for client-side display; count is the requested variation count (the
  // success subset length = result.images.length, may be < count on partial).
  failures?: TaskFailure[]
  batchId?: string
  count?: number
  error?: string
  idempotencyKey?: string
  createdAt: number
  // V02: wall-clock ms when the task entered a terminal state. Undefined for
  // pending/running. The sweeper reads this to evict stale terminal records
  // (whose result.images base64 would otherwise leak until process restart).
  terminalAt?: number
  controller: AbortController
}

// Public view (no AbortController) returned by GET /tasks/:id.
export type TaskView = {
  id: string
  kind: TaskKind
  status: TaskStatus
  progress: number
  stage: string
  requestId: string
  model: string
  result?: TaskResult
  failures?: TaskFailure[]
  batchId?: string
  count?: number
  error?: string
}

const tasks = new Map<string, TaskRecord>()
const idempotencyIndex = new Map<string, string>()

// Composite idempotency index key: scoped per owner so user B reusing user A's
// Idempotency-Key does NOT resolve to A's task (cross-user collision → wrong
// taskId / billing leak). Paired with the sweeper's symmetric drop below.
// 分隔符用 NUL('\u0000') 而非 ':' —— ownerFp(16hex)虽不含 ':',但 idempotencyKey 为调用方
// 自由字符串可能含 ':',':' 分隔下会与 ownerFp 段歧义;NUL 保证 split 还原恰好 2 段,无歧义。
// 安全:InMemory Map key,不落 PG/IDB。导出供测试解耦字面格式(A8②-2)。
export const idemIndexKey = (ownerFp: string, idempotencyKey: string): string => `${ownerFp}\u0000${idempotencyKey}`

const isTerminal = (s: TaskStatus): boolean => s === 'done' || s === 'partial' || s === 'failed' || s === 'canceled'

// V02: terminal-task TTL + sweeper. Terminal records hold result.images base64
// (a single 2K image is 10MB+); without eviction they leak until the process
// restarts. The sweeper deletes records whose terminalAt is older than the TTL
// and drops their idempotencyIndex entries in lockstep. Started lazily on the
// first createTask() so test suites using vi.useFakeTimers() can drive the
// interval deterministically instead of fighting a real timer from import time.
const TERMINAL_TTL_MS = 10 * 60_000
const SWEEP_INTERVAL_MS = 60_000

// Test-visible sweep body. Production callers reach it via the interval.
export const __sweepTerminalTasks = (): void => {
  const now = Date.now()
  for (const [id, record] of tasks) {
    if (record.terminalAt === undefined) continue
    if (now - record.terminalAt <= TERMINAL_TTL_MS) continue
    tasks.delete(id)
    // Defensive: only drop the index entry if it still points at this task
    // (symmetric with createTask's "index entry without a record" lazy-cleanup).
    if (record.idempotencyKey && idempotencyIndex.get(idemIndexKey(record.ownerFp, record.idempotencyKey)) === id) {
      idempotencyIndex.delete(idemIndexKey(record.ownerFp, record.idempotencyKey))
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
const ensureSweeper = (): void => {
  if (sweepTimer !== null) return
  const timer = setInterval(__sweepTerminalTasks, SWEEP_INTERVAL_MS)
  timer.unref()
  sweepTimer = timer
}

export const newTaskId = (): string => randomUUID()

// P1 fix (rev-behavior): createTask returns {record, created} so the caller can
// gate runner startup on `created`. Without this, a repeat submission with the same
// Idempotency-Key returned the existing record BUT the route still unconditionally
// launched a second runner — duplicate upstream calls (billing) + a double-runner
// race on the same task record. Now: `created=false` ⇒ the route returns the
// existing taskId (and for variations, the existing batchId/count) WITHOUT
// re-running anything, matching the tasks-async.md "同 key → 同 taskId,不重新跑"
// contract.
export type CreateTaskResult = { record: TaskRecord; created: boolean }

// Create a task. If idempotencyKey was seen (and the task still exists), return
// the existing record (same taskId, created=false → caller MUST NOT re-run).
// Restart-eviction is implicit: the index is in-memory, so a restarted process
// has no entry → a repeat submission creates a new task (created=true).
// P2-C2: `meta` carries variations-only fields (batchId, count) that the runner
// and toView surface to the client. Other kinds ignore it.
// FX-2: `ownerKey` is the resolved mivo_ platform key for the caller (header
// X-Mivo-Api-Key, or the env fallback when absent — resolved by the route via
// resolvePlatformCtx). It is fingerprinted (sha256, first 16 hex — see
// server/lib/keys.ts) so the raw key never lands in the registry, memory
// snapshots, or logs. Cross-user access GETs the same 404 'unknown-task' as a
// swept/restarted task (getTaskForOwner) — existence is not leaked. Idempotency
// is scoped per owner: two users reusing the same Idempotency-Key create two
// distinct tasks (no cross-user collision).
export const createTask = (
  kind: TaskKind,
  model: string,
  requestId: string,
  ownerKey: string,
  idempotencyKey?: string,
  meta?: { batchId?: string; count?: number },
): CreateTaskResult => {
  const ownerFp = fingerprintOfPlatformKey(ownerKey)
  if (idempotencyKey) {
    const existingId = idempotencyIndex.get(idemIndexKey(ownerFp, idempotencyKey))
    if (existingId) {
      const existing = tasks.get(existingId)
      if (existing) return { record: existing, created: false }
      // Index entry without a record (shouldn't happen in-process); fall through to create.
      idempotencyIndex.delete(idemIndexKey(ownerFp, idempotencyKey))
    }
  }
  const id = newTaskId()
  const record: TaskRecord = {
    id,
    ownerFp,
    kind,
    status: 'pending',
    progress: 0,
    stage: 'pending',
    requestId,
    model,
    createdAt: Date.now(),
    controller: new AbortController(),
    idempotencyKey,
  }
  if (meta?.batchId) record.batchId = meta.batchId
  if (meta?.count !== undefined) record.count = meta.count
  tasks.set(id, record)
  if (idempotencyKey) idempotencyIndex.set(idemIndexKey(ownerFp, idempotencyKey), id)
  ensureSweeper()
  return { record, created: true }
}

export const getTask = (id: string): TaskRecord | undefined => tasks.get(id)

// FX-2: owner-scoped read for the route boundary (GET/DELETE /tasks/:id). Returns
// undefined when the task does not exist OR is owned by a different user — the
// route maps both to the same 404 'unknown-task', so a cross-user probe cannot
// tell "exists, not yours" from "never existed". The runner uses the unscoped
// getTask() above (server-internal, already past the auth boundary).
export const getTaskForOwner = (id: string, ownerKey: string): TaskRecord | undefined => {
  const r = tasks.get(id)
  if (!r) return undefined
  if (r.ownerFp !== fingerprintOfPlatformKey(ownerKey)) return undefined
  return r
}

// Cancel: set canceled + abort upstream. No-op if already terminal. Cancel wins
// over a concurrent complete/fail (those check 'canceled' before committing).
export const cancelTask = (id: string): boolean => {
  const r = tasks.get(id)
  if (!r) return false
  if (isTerminal(r.status)) return true
  r.status = 'canceled'
  r.stage = 'canceled'
  r.terminalAt = Date.now()
  r.controller.abort()
  return true
}

// Progress must be monotonic. Terminal tasks ignore progress updates (a canceled
// task must not show 95% then 100% from a stale in-flight callback).
export const updateProgress = (id: string, stage: string, progress: number): void => {
  const r = tasks.get(id)
  if (!r) return
  if (isTerminal(r.status)) return
  if (r.status === 'pending') r.status = 'running'
  if (progress > r.progress) r.progress = progress
  r.stage = stage
}

export const completeTask = (id: string, result: TaskResult): void => {
  const r = tasks.get(id)
  if (!r) return
  if (r.status === 'canceled') return // never commit after cancel
  r.status = 'done'
  r.stage = 'done'
  r.terminalAt = Date.now()
  r.progress = 100
  r.result = result
}

// P2-C2: partial completion — a variations batch where some (not all) edits
// settled successfully. Commits the success subset as result.images (with
// variationIndex) + failures[] for the rest. Like completeTask, never commits
// after cancel. progress=100 (terminal). The client resolves the success subset
// (does NOT reject on partial — only all-fail rejects).
export const completePartialTask = (id: string, result: TaskResult, failures: TaskFailure[]): void => {
  const r = tasks.get(id)
  if (!r) return
  if (r.status === 'canceled') return // never commit after cancel
  r.status = 'partial'
  r.stage = 'done'
  r.terminalAt = Date.now()
  r.progress = 100
  r.result = result
  r.failures = failures
}

export const failTask = (id: string, error: string): void => {
  const r = tasks.get(id)
  if (!r) return
  if (r.status === 'canceled') return // cancel wins over failure
  r.status = 'failed'
  r.stage = 'failed'
  r.terminalAt = Date.now()
  r.error = error
}

export const toView = (r: TaskRecord): TaskView => {
  const view: TaskView = {
    id: r.id,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    stage: r.stage,
    requestId: r.requestId,
    model: r.model,
  }
  if (r.result) view.result = r.result
  if (r.failures) view.failures = r.failures
  if (r.batchId) view.batchId = r.batchId
  if (r.count !== undefined) view.count = r.count
  if (r.error) view.error = r.error
  return view
}

// Test-only: clear the registry (and stop the sweeper) between tests.
export const __resetTaskRegistry = (): void => {
  tasks.clear()
  idempotencyIndex.clear()
  if (sweepTimer !== null) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
