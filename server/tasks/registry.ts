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

import { randomUUID } from 'node:crypto'

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'
export type TaskKind = 'generate' | 'edit'
export type TaskResult = { images: Array<{ b64: string }> }

export type TaskRecord = {
  id: string
  kind: TaskKind
  status: TaskStatus
  progress: number // 0-100, monotonic (never decreases)
  stage: string // 'pending' | 'submit' | 'poll' | 'download' | 'request' | 'done' | 'failed' | 'canceled'
  requestId: string
  model: string
  result?: TaskResult
  error?: string
  idempotencyKey?: string
  createdAt: number
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
  error?: string
}

const tasks = new Map<string, TaskRecord>()
const idempotencyIndex = new Map<string, string>()

const isTerminal = (s: TaskStatus): boolean => s === 'done' || s === 'failed' || s === 'canceled'

export const newTaskId = (): string => randomUUID()

// Create a task. If idempotencyKey was seen (and the task still exists), return
// the existing record (same taskId). Restart-eviction is implicit: the index is
// in-memory, so a restarted process has no entry → a repeat submission creates a
// new task (the lead's "重启后失效视为新任务").
export const createTask = (
  kind: TaskKind,
  model: string,
  requestId: string,
  idempotencyKey?: string,
): TaskRecord => {
  if (idempotencyKey) {
    const existingId = idempotencyIndex.get(idempotencyKey)
    if (existingId) {
      const existing = tasks.get(existingId)
      if (existing) return existing
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
  tasks.set(id, record)
  if (idempotencyKey) idempotencyIndex.set(idempotencyKey, id)
  return record
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
  r.progress = 100
  r.result = result
}

export const failTask = (id: string, error: string): void => {
  const r = tasks.get(id)
  if (!r) return
  if (r.status === 'canceled') return // cancel wins over failure
  r.status = 'failed'
  r.stage = 'failed'
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
  if (r.error) view.error = r.error
  return view
}

// Test-only: clear the registry between tests.
export const __resetTaskRegistry = (): void => {
  tasks.clear()
  idempotencyIndex.clear()
}
