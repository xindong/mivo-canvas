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
// TTL semantics (V02): terminal tasks (done/partial/failed/canceled) are stamped
// with `terminalAt` and evicted by a module-level sweeper once they are older
// than TERMINAL_TTL_MS (10 min); their idempotencyIndex entries are dropped in
// lockstep. A swept task GETs as 404 'unknown-task' — the same path as a freshly
// restarted process, so clients already tolerate it. The sweeper runs every
// SWEEP_INTERVAL_MS (60s) and is .unref()'d so it never blocks process exit.

import { randomUUID } from 'node:crypto'

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
    if (record.idempotencyKey && idempotencyIndex.get(record.idempotencyKey) === id) {
      idempotencyIndex.delete(record.idempotencyKey)
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
export const createTask = (
  kind: TaskKind,
  model: string,
  requestId: string,
  idempotencyKey?: string,
  meta?: { batchId?: string; count?: number },
): CreateTaskResult => {
  if (idempotencyKey) {
    const existingId = idempotencyIndex.get(idempotencyKey)
    if (existingId) {
      const existing = tasks.get(existingId)
      if (existing) return { record: existing, created: false }
      // Index entry without a record (shouldn't happen in-process); fall through to create.
      idempotencyIndex.delete(idempotencyKey)
    }
  }
  const id = newTaskId()
  const record: TaskRecord = {
    id,
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
  if (idempotencyKey) idempotencyIndex.set(idempotencyKey, id)
  ensureSweeper()
  return { record, created: true }
}

export const getTask = (id: string): TaskRecord | undefined => tasks.get(id)

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
