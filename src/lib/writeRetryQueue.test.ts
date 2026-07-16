import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __bumpPendingCountersForTest,
  __dumpIdbTerminalsForTest,
  __dumpTerminalsForTest,
  __dumpWritesForTest,
  __enforceTerminalCapForTest,
  __isWriteQueueBlockedForTest,
  __onErrorBlockedClearCountForTest,
  __readIdbTerminalCountersForTest,
  __recordTerminalForTest,
  __resetWriteQueueDb,
  __seedWritesForTest,
  __setIdbBlockTimeoutForTest,
  __setMaxTerminalsForTest,
  __setClaimBarrierHookForTest,
  __setOpenDbUpgradeAbortHookForTest,
  __setTerminalFaultInjectorForTest,
  __setWriteQueueDbNameForTest,
  classifyHttpStatus,
  createWriteQueue,
  getPendingCreateResourceIds,
  getPendingDeleteResourceIds,
  getWriteQueueTerminalCounters,
  resetTerminalCountersBaseline,
  type TerminalCounterShape,
  type QueuedWrite,
  type WriteExecutor,
  type WriteOp,
  type WriteOutcome,
} from './writeRetryQueue'
import type { NodePayload, Revision } from '../../shared/persist-contract.ts'
import { __resetPersistUserId, setPersistUserId } from './persistUserId'
import { toastFeedback } from '../store/toastStore'
import { debugLogger } from '../store/debugLogStore'

// ---- spies (call-through; assert counts only) ----
const toastWarn = vi.spyOn(toastFeedback, 'warn')
const toastError = vi.spyOn(toastFeedback, 'error')
const toastInfo = vi.spyOn(toastFeedback, 'info')
const warnLog = vi.spyOn(debugLogger, 'warn')
const errorLog = vi.spyOn(debugLogger, 'error')
const logLog = vi.spyOn(debugLogger, 'log')

// ---- controllable deterministic clock ----
let clockMs = 1_000
const tick = (ms: number) => {
  clockMs += ms
}

// ---- op fixtures (payloads are opaque to the queue; minimal shape + cast) ----
const minimalNode = (canvasId: string, nodeId: string, baseRevision?: Revision): WriteOp => ({
  kind: 'upsertNode',
  canvasId,
  nodeId,
  payload: {
    type: 'image',
    title: 'n',
    transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
    fills: [],
    strokes: [],
    effects: [],
    relations: {},
  } as unknown as NodePayload,
  baseRevision,
})
const deleteNodeOp = (canvasId: string, nodeId: string): WriteOp => ({ kind: 'deleteNode', canvasId, nodeId })
const putUserStateOp = (key: string, value: unknown, baseRevision?: Revision): WriteOp => ({
  kind: 'putUserState',
  key,
  value,
  baseRevision,
})
const deleteUserStateOp = (key: string): WriteOp => ({ kind: 'deleteUserState', key })
const appendChatOp = (canvasId: string, message: unknown): WriteOp => ({ kind: 'appendChatMessage', canvasId, message })

// P1-4 r2: construct a controlled QueuedWrite for __recordTerminalForTest (the enqueue
// path mints random UUIDs; the concurrency test needs deterministic, distinct records).
const makeMinimalQueuedWrite = (id: string, nodeId: string): QueuedWrite => ({
  id,
  idempotencyKey: `mivo-${id}`,
  userId: 'userA',
  op: minimalNode('c1', nodeId),
  resourceKey: `node:c1:${nodeId}`,
  createdAt: 1000,
  attempts: 1,
  nextAttemptAt: 1000,
  status: 'pending',
})

// ---- executor that serves a sequence of outcomes (clamped to last) ----
const seqExecutor = (outcomes: WriteOutcome[]) => {
  const calls: { op: WriteOp; key: string }[] = []
  let i = 0
  const fn = vi.fn(async (op: WriteOp, key: string): Promise<WriteOutcome> => {
    calls.push({ op, key })
    const o = outcomes[Math.min(i, outcomes.length - 1)]
    i++
    return o
  })
  return { fn, calls }
}

const makeQueue = (
  executor: WriteExecutor,
  opts: {
    maxQueuePerUser?: number
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    drainIntervalMs?: number
    onConflict?: (op: WriteOp, rev: Revision) => void
  } = {},
) =>
  createWriteQueue({
    executor,
    clock: () => clockMs,
    random: () => 0.5, // deterministic jitter → 0.75 of capped delay
    ...opts,
  })

beforeEach(() => {
  vi.clearAllMocks()
  clockMs = 1_000
  setPersistUserId('userA')
  return __resetWriteQueueDb()
})

afterEach(async () => {
  await __resetWriteQueueDb()
  __resetPersistUserId()
})

// ── classifyHttpStatus (pure function) ──

describe('classifyHttpStatus', () => {
  const c = (status: number, body: unknown, isDelete: boolean) => classifyHttpStatus(status, body, { isDelete })

  it('2xx → success', () => {
    expect(c(200, null, false)).toEqual({ status: 'success' })
    expect(c(201, null, false)).toEqual({ status: 'success' })
  })
  it('401 → unauthorized', () => {
    expect(c(401, null, false)).toEqual({ status: 'unauthorized' })
  })
  it('409 revision-conflict → conflict with currentRevision (not a blind retry)', () => {
    expect(c(409, { error: 'revision-conflict', id: 'n1', currentRevision: 7 }, false)).toEqual({
      status: 'conflict',
      currentRevision: 7,
    })
  })
  it('409 project-exists / canvas-exists → rejected terminal (no silent success)', () => {
    expect(c(409, { error: 'project-exists', id: 'p1' }, false).status).toBe('rejected')
    expect(c(409, { error: 'canvas-exists', id: 'c1' }, false).status).toBe('rejected')
  })
  it('413 → too-large with limit (0 when missing)', () => {
    expect(c(413, { error: 'request-body-too-large', limit: 1048576 }, false)).toEqual({
      status: 'too-large',
      limit: 1048576,
    })
    expect(c(413, { error: 'request-body-too-large' }, false)).toEqual({ status: 'too-large', limit: 0 })
  })
  it('422 → reuse-conflict with key', () => {
    expect(c(422, { error: 'idempotency-key-reuse', key: 'k1' }, false)).toEqual({
      status: 'reuse-conflict',
      key: 'k1',
    })
  })
  it('404 → success on delete (idempotent), rejected on non-delete', () => {
    expect(c(404, { error: 'unknown-node' }, true)).toEqual({ status: 'success' })
    expect(c(404, { error: 'unknown-node' }, false).status).toBe('rejected')
  })
  it('400/403/428/405 → rejected', () => {
    expect(c(400, { error: 'bad-request' }, false).status).toBe('rejected')
    expect(c(403, { error: 'forbidden' }, false).status).toBe('rejected')
    expect(c(428, { error: 'precondition-required', id: 'n1' }, false).status).toBe('rejected')
    expect(c(405, { error: 'method-not-allowed' }, false).status).toBe('rejected')
  })
  it('5xx/408/429 → transient (retry)', () => {
    expect(c(500, null, false)).toEqual({ status: 'transient', message: 'http_500' })
    expect(c(503, null, false).status).toBe('transient')
    expect(c(408, null, false).status).toBe('transient')
    expect(c(429, null, false).status).toBe('transient')
  })
  it('other → terminal', () => {
    expect(c(418, null, false)).toEqual({ status: 'terminal', message: 'http_418' })
  })
})

// ── enqueue + drain core ──

describe('FX-5 enqueue + drain', () => {
  it('drains a pending write to success and removes it', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1', 5))
    const r = await q.drain()
    expect(r).toEqual({ processed: 1, successes: 1, failures: 0, terminals: 0, paused: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].op.kind).toBe('upsertNode')
    expect(await q.pendingCount()).toBe(0)
  })

  it('does not drain ops whose nextAttemptAt is in the future', async () => {
    const { fn, calls } = seqExecutor([{ status: 'transient', message: 'http_503' }, { status: 'success' }])
    const q = makeQueue(fn, { baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    // first drain: transient → backoff (attempts=1; nextAttemptAt = 1000 + 1000*0.75 = 1750)
    let r = await q.drain()
    expect(r.failures).toBe(1)
    expect(calls).toHaveLength(1)
    // clock still 1000 < 1750 → not due
    r = await q.drain()
    expect(r.processed).toBe(0)
    expect(calls).toHaveLength(1)
    // advance past backoff window
    tick(800) // 1800 > 1750
    r = await q.drain()
    expect(r.successes).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('logs the success path via debugLogger (development-logging invariant, P2-1)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1', 5))
    await q.drain()
    // success branch must emit a debugLogger.log entry (not just silently delete the record)
    expect(logLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('succeeded'))
  })
})

// ── replay idempotency ──

describe('FX-5 replay idempotency', () => {
  it('retries a transient failure with the SAME idempotency key (server dedupes)', async () => {
    const { fn, calls } = seqExecutor([{ status: 'transient', message: 'http_503' }, { status: 'success' }])
    const q = makeQueue(fn, { baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.drain() // transient
    tick(1000) // past backoff
    await q.drain() // success
    expect(calls).toHaveLength(2)
    // The same persisted key is reused on replay → no duplicate server side-effect.
    expect(calls[0].key).toBe(calls[1].key)
    expect(calls[0].key).toMatch(/^mivo-/)
  })

  it('a lost response after the side effect is not re-applied on replay (queue→executor→backend idempotent, P2-2)', async () => {
    // Stateful fake backend simulating server-side idempotency-key dedup. First call applies
    // the side effect (bumps revision), records the key, then "loses the response" (transient)
    // → the queue replays with the SAME idempotency key → the backend dedupes (key already
    // seen) → returns success WITHOUT re-applying the side effect. Proves the
    // queue→executor→backend combo is idempotent, not merely that the key string is stable.
    const appliedKeys = new Set<string>()
    const calls: { op: WriteOp; key: string }[] = []
    let sideEffects = 0
    let revisionBumps = 0
    const fn = vi.fn(async (op: WriteOp, key: string): Promise<WriteOutcome> => {
      calls.push({ op, key })
      if (appliedKeys.has(key)) return { status: 'success' } // dedup: no re-apply
      appliedKeys.add(key)
      sideEffects++
      revisionBumps++
      return { status: 'transient', message: 'response lost after apply' }
    })
    const q = makeQueue(fn, { baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    // attempt 1: side effect applied, response lost → transient → backoff
    expect((await q.drain()).failures).toBe(1)
    expect(sideEffects).toBe(1)
    expect(revisionBumps).toBe(1)
    tick(1000) // past backoff
    const r = await q.drain()
    expect(r.successes).toBe(1)
    // executor called twice, but the side effect was applied ONCE (backend deduped via key)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sideEffects).toBe(1)
    expect(revisionBumps).toBe(1)
    // same idempotency key reused across both calls (queue never minted a new one on retry)
    expect(calls[0].key).toBe(calls[1].key)
    expect(calls[0].key).toMatch(/^mivo-/)
  })
})

// ── error-code branches (real write-path: mock executor returns the outcome,
//    assertions land on queue state + side effects) ──

describe('FX-5 error branches', () => {
  it('409 conflict → terminal conflict, fires onConflict with currentRevision, deletes', async () => {
    const onConflict = vi.fn()
    const { fn } = seqExecutor([{ status: 'conflict', currentRevision: 9 }])
    const q = makeQueue(fn, { onConflict })
    await q.enqueue(minimalNode('c1', 'n1', 5))
    const r = await q.drain()
    expect(r).toEqual({ processed: 1, successes: 0, failures: 0, terminals: 1, paused: false })
    expect(onConflict).toHaveBeenCalledTimes(1)
    const [op, rev] = onConflict.mock.calls[0]
    expect(op.kind).toBe('upsertNode')
    expect(rev).toBe(9)
    expect(toastWarn).toHaveBeenCalledTimes(1)
    expect(warnLog).toHaveBeenCalled()
    expect(await q.pendingCount()).toBe(0)
  })

  it('413 too-large → terminal, does not retry same payload', async () => {
    const { fn, calls } = seqExecutor([{ status: 'too-large', limit: 1048576 }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    const r = await q.drain()
    expect(r.terminals).toBe(1)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalled()
    tick(10_000)
    await q.drain() // not retried (record gone)
    expect(calls).toHaveLength(1)
    expect(await q.pendingCount()).toBe(0)
  })

  it('422 reuse-conflict → terminal', async () => {
    const { fn } = seqExecutor([{ status: 'reuse-conflict', key: 'k1' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    const r = await q.drain()
    expect(r.terminals).toBe(1)
    expect(errorLog).toHaveBeenCalled()
    expect(await q.pendingCount()).toBe(0)
  })

  it('400 rejected → terminal', async () => {
    const { fn } = seqExecutor([{ status: 'rejected', body: { error: 'bad-request' } }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    const r = await q.drain()
    expect(r.terminals).toBe(1)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(await q.pendingCount()).toBe(0)
  })

  it('404 on a delete → success (idempotent); on non-delete → rejected', async () => {
    // delete of already-gone resource → executor returns success (classifyHttpStatus
    // maps 404+isDelete to success)
    const d = seqExecutor([{ status: 'success' }])
    const dq = makeQueue(d.fn)
    await dq.enqueue(deleteNodeOp('c1', 'gone'))
    expect((await dq.drain()).successes).toBe(1)
    // non-delete 404 → rejected terminal
    const u = seqExecutor([{ status: 'rejected', body: { error: 'unknown-node' } }])
    const uq = makeQueue(u.fn)
    await uq.enqueue(minimalNode('c1', 'missing'))
    expect((await uq.drain()).terminals).toBe(1)
  })

  it('terminal outcome → terminal, not retried', async () => {
    const { fn, calls } = seqExecutor([{ status: 'terminal', message: 'http_418' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    const r = await q.drain()
    expect(r.terminals).toBe(1)
    tick(10_000)
    await q.drain()
    expect(calls).toHaveLength(1)
  })

  it('5xx transient retries with exponential backoff then succeeds', async () => {
    const { fn, calls } = seqExecutor([
      { status: 'transient', message: 'http_503' },
      { status: 'transient', message: 'http_503' },
      { status: 'success' },
    ])
    const q = makeQueue(fn, { baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    // attempt 1 (clock=1000): transient → backoff 1000*0.75=750 → nextAttemptAt=1750
    expect((await q.drain()).failures).toBe(1) // failures is per-drain, not cumulative
    expect(calls).toHaveLength(1)
    tick(800) // clock=1800 > 1750
    // attempt 2: transient → attempts=2 → backoff min(1000*2^1,60k)*0.75=1500 → nextAttemptAt=3300
    expect((await q.drain()).failures).toBe(1)
    expect(calls).toHaveLength(2)
    tick(1600) // clock=3400 > 3300
    // attempt 3: success
    expect((await q.drain()).successes).toBe(1)
    expect(calls).toHaveLength(3)
    expect(await q.pendingCount()).toBe(0)
  })

  it('dead-letters after maxAttempts transient failures', async () => {
    const { fn, calls } = seqExecutor([{ status: 'transient', message: 'http_503' }])
    const q = makeQueue(fn, { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    // attempt 1: attempts=1 (<2) → backoff 750 → nextAttemptAt 1750
    expect((await q.drain()).failures).toBe(1)
    tick(800) // 1800
    // attempt 2: attempts=2 (>=2) → dead-letter
    const r = await q.drain()
    expect(r.terminals).toBe(1)
    expect(toastError).toHaveBeenCalled()
    expect(errorLog).toHaveBeenCalled()
    expect(await q.pendingCount()).toBe(0)
    tick(10_000)
    await q.drain()
    expect(calls).toHaveLength(2)
  })

  it('401 pauses the queue, keeps data, stops the drain, resumes on re-auth', async () => {
    const { fn, calls } = seqExecutor([
      { status: 'unauthorized' },
      { status: 'success' },
      { status: 'success' },
    ])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.enqueue(minimalNode('c1', 'n2'))
    const r = await q.drain()
    // first op got 401 → paused, second op NOT attempted this cycle
    expect(r.paused).toBe(true)
    expect(r.processed).toBe(1)
    expect(calls).toHaveLength(1)
    expect(q.isPaused()).toBe(true)
    expect(await q.pendingCount()).toBe(2) // BOTH kept (data not cleared)
    expect(toastInfo).toHaveBeenCalledTimes(1)
    // further drain is a no-op while paused
    expect((await q.drain()).processed).toBe(0)
    // resume → drains both pending ops (executor returns success for calls 2+3)
    await q.resume()
    expect(q.isPaused()).toBe(false)
    expect(calls).toHaveLength(3)
    expect(await q.pendingCount()).toBe(0)
  })
})

// ── coalescing ──

describe('FX-5 coalescing', () => {
  it('supersedes a pending op for the same resource (one record, new idempotency key)', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1', 1))
    const firstKey = (await __dumpWritesForTest())[0].idempotencyKey
    // second enqueue to the SAME resource supersedes (coalesces), not adds
    await q.enqueue(minimalNode('c1', 'n1', 2))
    const records = await __dumpWritesForTest()
    expect(records).toHaveLength(1)
    expect(records[0].idempotencyKey).not.toBe(firstKey) // minted a new key (new body)
    // draining sends the superseding payload
    await q.drain()
    expect(calls).toHaveLength(1)
    expect((calls[0].op as { baseRevision?: Revision }).baseRevision).toBe(2)
  })

  it('does not coalesce appendChatMessage (each message is distinct)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(appendChatOp('c1', { text: 'm1' }))
    await q.enqueue(appendChatOp('c1', { text: 'm2' }))
    expect((await __dumpWritesForTest()).length).toBe(2)
    await q.drain()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('delete supersedes a pending upsert for the same resource', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.enqueue(deleteNodeOp('c1', 'n1')) // same resourceKey → coalesce
    expect((await __dumpWritesForTest()).length).toBe(1)
    await q.drain()
    expect(calls[0].op.kind).toBe('deleteNode')
  })

  it('does not coalesce an in-flight op (avoids stale outcome)', async () => {
    // The executor hangs ONLY on the first call (op1 in-flight); subsequent calls return
    // success so the second drain (op2) completes — otherwise the 2nd drain would hang
    // forever on a fresh unresolved promise.
    let resolve1: ((o: WriteOutcome) => void) | undefined
    let execCalled = false
    let callCount = 0
    const fn = vi.fn(async (): Promise<WriteOutcome> => {
      callCount++
      if (callCount === 1) {
        execCalled = true
        return new Promise<WriteOutcome>((r) => {
          resolve1 = r
        })
      }
      return { status: 'success' }
    })
    const q = makeQueue(fn, { maxQueuePerUser: 10 })
    try {
      await q.enqueue(minimalNode('c1', 'n1', 1))
      const drainP = q.drain() // op1 → in-flight, hangs at the executor
      await vi.waitFor(() => expect(execCalled).toBe(true))
      // op2 enqueues while op1 in-flight: NOT coalesced (in-flight excluded) → new record
      await q.enqueue(minimalNode('c1', 'n1', 2))
      expect((await __dumpWritesForTest()).length).toBe(2)
      resolve1?.({ status: 'success' })
      await drainP
      await q.drain() // op2 now drains (2nd executor call → success)
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      // Always settle the hanging executor so no dangling in-flight drain remains.
      resolve1?.({ status: 'success' })
    }
  })
})

// ── G1-a R3 F1: createCanvas+updateCanvas coalesce must preserve create-only fields ──
// R3 verdict: combineOps(createCanvas, updateCanvas) rebuilt the create from incoming
// update fields only, dropping existing.sourceTemplateId when the production rename/move
// update does not carry it. Production renameCanvas/moveCanvasToProject updates omit
// sourceTemplateId, so a template-backed create followed by a pre-drain rename lost the
// template id silently. These tests pin the field-wise merge contract.

describe('G1-a R3 F1: createCanvas+updateCanvas coalesce preserves sourceTemplateId', () => {
  const createCanvasOp = (canvasId: string, projectId: string, title: string, sourceTemplateId: string): WriteOp => ({
    kind: 'createCanvas',
    canvasId,
    projectId,
    title,
    sourceTemplateId,
  })
  // Production rename: carries new title + required projectId, omits sourceTemplateId.
  const renameCanvasOp = (canvasId: string, projectId: string, title: string): WriteOp => ({
    kind: 'updateCanvas',
    canvasId,
    projectId,
    title,
  })
  // Production move: carries new projectId, omits title + sourceTemplateId.
  const moveCanvasOp = (canvasId: string, projectId: string): WriteOp => ({
    kind: 'updateCanvas',
    canvasId,
    projectId,
  })

  it('rename before drain preserves existing sourceTemplateId (not dropped by coalesce)', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(createCanvasOp('c1', 'p1', 'orig', 'template-keep-me'))
    await q.enqueue(renameCanvasOp('c1', 'p1', 'renamed')) // same canvas → coalesce
    expect((await __dumpWritesForTest()).length).toBe(1) // coalesced to one record
    await q.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0].op.kind).toBe('createCanvas')
    // RED assertion: sourceTemplateId must survive the coalesce (current code drops it).
    expect((calls[0].op as { sourceTemplateId?: string }).sourceTemplateId).toBe('template-keep-me')
    // the rename took effect on title
    expect((calls[0].op as { title?: string }).title).toBe('renamed')
    expect((calls[0].op as { projectId: string }).projectId).toBe('p1')
  })

  it('move before drain preserves existing sourceTemplateId and title', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(createCanvasOp('c2', 'p1', 'orig', 'template-keep-me'))
    await q.enqueue(moveCanvasOp('c2', 'p2')) // move to p2, no title, no sourceTemplateId
    expect((await __dumpWritesForTest()).length).toBe(1)
    await q.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0].op.kind).toBe('createCanvas')
    expect((calls[0].op as { sourceTemplateId?: string }).sourceTemplateId).toBe('template-keep-me')
    expect((calls[0].op as { title?: string }).title).toBe('orig') // preserved (move carried no title)
    expect((calls[0].op as { projectId: string }).projectId).toBe('p2') // move took effect
  })

  it('explicit sourceTemplateId in update still overrides existing (not sticky)', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(createCanvasOp('c3', 'p1', 'orig', 'template-old'))
    await q.enqueue({
      kind: 'updateCanvas',
      canvasId: 'c3',
      projectId: 'p1',
      title: 'renamed',
      sourceTemplateId: 'template-new',
    })
    await q.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0].op.kind).toBe('createCanvas')
    // incoming sourceTemplateId wins over existing (field-wise merge, not sticky-keep)
    expect((calls[0].op as { sourceTemplateId?: string }).sourceTemplateId).toBe('template-new')
  })
})

// ── overflow ──

describe('FX-5 overflow', () => {
  it('evicts the oldest pending write (non-silent) when at capacity', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn, { maxQueuePerUser: 2 })
    const id1 = await q.enqueue(minimalNode('c1', 'n1'))
    tick(1) // distinct createdAt so the "oldest" is deterministic (getAll order is unspecified)
    await q.enqueue(minimalNode('c1', 'n2'))
    tick(1)
    // 3rd enqueue → active=2 >= 2 → evict oldest pending (id1)
    await q.enqueue(minimalNode('c1', 'n3'))
    expect(toastWarn).toHaveBeenCalledTimes(1)
    expect(warnLog).toHaveBeenCalled()
    expect(await q.pendingCount()).toBe(2)
    const ids = (await __dumpWritesForTest()).map((r) => r.id)
    expect(ids).not.toContain(id1)
  })

  it('refuses enqueue when full and all in-flight (no silent drop)', async () => {
    let resolve1: ((o: WriteOutcome) => void) | undefined
    const fn = vi.fn(async (): Promise<WriteOutcome> => {
      return new Promise<WriteOutcome>((r) => {
        resolve1 = r
      })
    })
    const q = makeQueue(fn, { maxQueuePerUser: 1 })
    try {
      await q.enqueue(minimalNode('c1', 'n1'))
      const drainP = q.drain() // op1 in-flight, hangs
      await vi.waitFor(() => expect(fn).toHaveBeenCalled())
      await expect(q.enqueue(minimalNode('c1', 'n2'))).rejects.toThrow('write queue full')
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(errorLog).toHaveBeenCalled()
      resolve1?.({ status: 'success' })
      await drainP
    } finally {
      resolve1?.({ status: 'success' })
    }
  })
})

// ── per-userId partitioning ──

describe('FX-5 per-userId partitioning', () => {
  it('only drains the current user’s writes', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'nA'))
    setPersistUserId('userB')
    await q.enqueue(minimalNode('c1', 'nB'))
    // draining as B → only nB
    expect((await q.drain()).successes).toBe(1)
    expect(calls).toHaveLength(1)
    expect((calls[0].op as { nodeId: string }).nodeId).toBe('nB')
    // switch to A → A’s write still pending, drains now
    setPersistUserId('userA')
    expect((await q.drain()).successes).toBe(1)
    expect(calls).toHaveLength(2)
    expect((calls[1].op as { nodeId: string }).nodeId).toBe('nA')
  })
})

// ── cross-session durable recovery ──

describe('FX-5 cross-session durable recovery', () => {
  it('persists to IDB; a new queue instance in a later session drains it', async () => {
    // session 1: enqueue but never drain (server was down — page closed before retry)
    const { fn: fn1 } = seqExecutor([{ status: 'success' }])
    const q1 = makeQueue(fn1)
    await q1.enqueue(minimalNode('c1', 'n1', 5))
    q1.stop()
    expect((await __dumpWritesForTest()).length).toBe(1) // durable in IDB
    // session 2: fresh queue instance (same DB); drains the persisted op
    const { fn: fn2, calls: calls2 } = seqExecutor([{ status: 'success' }])
    const q2 = makeQueue(fn2)
    const r = await q2.drain()
    expect(r.successes).toBe(1)
    expect(calls2).toHaveLength(1)
    expect((calls2[0].op as { nodeId: string }).nodeId).toBe('n1')
    expect(await q2.pendingCount()).toBe(0)
  })
})

// ── DP-7: two keys never enter the queue payload ──

describe('FX-5 DP-7 guard', () => {
  it('refuses to queue putUserState with mivo-key (never persisted)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('mivo-key', 'super-secret'))).rejects.toThrow('DP-7')
    expect(errorLog).toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })
  it('refuses gateway-key (and deleteUserState of a forbidden key)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('gateway-key', 'x'))).rejects.toThrow('DP-7')
    await expect(q.enqueue(deleteUserStateOp('gateway-key'))).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })
  it('still queues an allowed user-state key', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(putUserStateOp('canvas:c1:selection', ['n1', 'n2']))
    expect((await __dumpWritesForTest()).length).toBe(1)
    await q.drain()
    expect(fn).toHaveBeenCalled()
  })
})

// ── IDB unavailable → in-memory fallback (degraded but not silent) ──

describe('FX-5 IDB-unavailable degradation', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', undefined)
    return __resetWriteQueueDb()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    return __resetWriteQueueDb()
  })

  it('enqueues + drains via in-memory store when IDB is absent', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    expect(await q.pendingCount()).toBe(1)
    const r = await q.drain()
    expect(r.successes).toBe(1)
    expect(calls).toHaveLength(1)
    expect(await q.pendingCount()).toBe(0)
  })

  it('still coalesces in-memory', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.enqueue(minimalNode('c1', 'n1')) // coalesce → 1 record
    expect(await q.pendingCount()).toBe(1)
  })
})

// ── start / stop lifecycle ──

describe('FX-5 start/stop lifecycle', () => {
  it('start() drains immediately; stop() halts periodic drain', async () => {
    // Use a huge interval so the periodic timer never fires during the test (we assert
    // the immediate drain + that stop() clears the timer). The online/visibility + timer
    // paths are exercised in the browser (node has no window/document).
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn, { drainIntervalMs: 5_000_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.start() // immediate drain
    expect(calls).toHaveLength(1)
    q.stop()
    // after stop, a new enqueue does not auto-drain (no timer firing)
    await q.enqueue(minimalNode('c1', 'n2'))
    expect(calls).toHaveLength(1)
  })
})

// ── crash/reload recovery (Greptile P1 fixes) ──

describe('FX-5 crash/reload recovery', () => {
  it('recovers an in-flight record left by a crashed prior session (replays it)', async () => {
    // session 1: enqueue op1, drain with a hanging executor → op1 stuck in-flight, then
    // the session "crashes" (the executor is never resolved, the drain is abandoned).
    let resolve1: ((o: WriteOutcome) => void) | undefined
    let called1 = false
    const exec1 = vi.fn(async (): Promise<WriteOutcome> => {
      called1 = true
      return new Promise<WriteOutcome>((r) => {
        resolve1 = r
      })
    })
    const q1 = makeQueue(exec1)
    await q1.enqueue(minimalNode('c1', 'n1'))
    const d1 = q1.drain() // op1 → in-flight, hangs at the executor
    await vi.waitFor(() => expect(called1).toBe(true))
    // session 2: fresh instance + success executor → drain recovers the in-flight record
    const exec2 = seqExecutor([{ status: 'success' }])
    const q2 = makeQueue(exec2.fn)
    const r = await q2.drain()
    expect(r.successes).toBe(1) // recovered in-flight → re-executed → success
    expect(exec2.calls).toHaveLength(1)
    expect(await q2.pendingCount()).toBe(0)
    // settle the abandoned session-1 drain (its deleteWrite is now a no-op since q2 deleted)
    resolve1?.({ status: 'success' })
    await d1.catch(() => undefined)
  })

  it('restores paused state on start() when leftover paused-401 records exist', async () => {
    // session 1: op1 → 401 → paused-401 + paused=true. Instance dropped (reload).
    const exec1 = seqExecutor([{ status: 'unauthorized' }, { status: 'success' }])
    const q1 = makeQueue(exec1.fn)
    await q1.enqueue(minimalNode('c1', 'n1'))
    await q1.drain()
    expect(q1.isPaused()).toBe(true)
    // session 2: fresh instance → start() must restore paused (paused-401 record exists),
    // NOT replay it into another 401.
    const exec2 = seqExecutor([{ status: 'success' }])
    const q2 = makeQueue(exec2.fn)
    await q2.start()
    expect(q2.isPaused()).toBe(true)
    expect(exec2.calls).toHaveLength(0) // paused → no drain (no redundant 401)
    // resume() (auth layer, after re-login) → drains
    await q2.resume()
    expect(q2.isPaused()).toBe(false)
    expect(exec2.calls).toHaveLength(1)
    expect(await q2.pendingCount()).toBe(0)
  })

  it('a memStore-fallback record stays visible after IDB recovers (no silent loss)', async () => {
    // IDB unavailable → enqueue falls back to memStore
    vi.stubGlobal('indexedDB', undefined)
    const exec = seqExecutor([{ status: 'success' }])
    const q = makeQueue(exec.fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    expect(await q.pendingCount()).toBe(1)
    // IDB "recovers" — getAllWrites unions memStore, so the record is still visible
    vi.unstubAllGlobals()
    expect(await q.pendingCount()).toBe(1)
    const r = await q.drain()
    expect(r.successes).toBe(1) // drain saw the memStore record → executed → success
    expect(exec.calls).toHaveLength(1)
    expect(await q.pendingCount()).toBe(0)
  })

  it('claims anonymous-tagged records for the authenticated user on drain (no orphans)', async () => {
    // pre-auth: enqueue as anonymous
    setPersistUserId('anonymous')
    const exec = seqExecutor([{ status: 'success' }])
    const q = makeQueue(exec.fn)
    await q.enqueue(minimalNode('c1', 'n1')) // tagged 'anonymous'
    expect((await __dumpWritesForTest())[0].userId).toBe('anonymous')
    // login → drain migrates anonymous → real user + processes
    setPersistUserId('userA')
    const r = await q.drain()
    expect(r.successes).toBe(1) // migrated + executed (not orphaned)
    expect(exec.calls).toHaveLength(1)
    expect(await q.pendingCount()).toBe(0)
  })
})

// ── DP-7 adversarial: camelCase field names, nested value, key-segment + encoding variants ──
// Each case asserts the op was REJECTED at the gate AND nothing landed in IDB/memStore —
// not merely that enqueue threw. The original bypass (P1-1) let the two keys serialize into
// IDB as plaintext because isUserStateKeyForbidden alone missed camelCase field names,
// nested value credential fields, and key-segment/encoding variants.

describe('FX-5 DP-7 adversarial (camelCase / nested / encoded — never persisted)', () => {
  it('refuses key= gatewayKey (camelCase) and leaves IDB empty', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('gatewayKey', 'SENTINEL'))).rejects.toThrow('DP-7')
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalled()
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses key= mivoKey (camelCase) and leaves IDB empty', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('mivoKey', 'SENTINEL'))).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses a nested credential field in the value (mivoKey deep in op.value)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(
      q.enqueue(putUserStateOp('settings', { profile: { mivoKey: 'SENTINEL' } })),
    ).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses a nested gatewayKey field in the value', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(
      q.enqueue(putUserStateOp('settings', { gatewayKey: 'SENTINEL' })),
    ).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses a credential-value segment inside a colon key (mivo_ prefix, no sensitive substring)', async () => {
    // mivo_abc123 is a credential-format value (mivo_ prefix) but contains no
    // secret/token/password/apikey substring → the old isUserStateKeyForbidden missed it;
    // scanUserStateKeyForCredential catches it via the mivo_/sk- prefix.
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('canvas:mivo_abc123:selection', {}))).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses a URL-encoded credential segment in the key (%6divo_abc123 → mivo_abc123)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('canvas:%6divo_abc123:selection', {}))).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses a double-URL-encoded credential segment (%256divo_abc123 → mivo_abc123)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('canvas:%256divo_abc123:selection', {}))).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('refuses a URL-encoded sensitive field name in the value (%61piKey → apiKey)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await expect(q.enqueue(putUserStateOp('settings', { '%61piKey': 'SENTINEL' }))).rejects.toThrow('DP-7')
    expect(await __dumpWritesForTest()).toHaveLength(0)
  })

  it('still allows a benign nested value under a benign key (no false positive)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(putUserStateOp('settings', { theme: 'dark', layout: { mode: 'grid' } }))
    expect((await __dumpWritesForTest()).length).toBe(1)
    await q.drain()
    expect(fn).toHaveBeenCalled()
  })
})

// ── IDB open/transaction failure → debounced degradation toast + memStore retention (P1-2) ──

describe('FX-5 IDB-failure degradation (toast + memStore fallback)', () => {
  // Each test stubs its own failing indexedDB; afterEach restores + resets.
  afterEach(() => {
    vi.unstubAllGlobals()
    return __resetWriteQueueDb()
  })

  // indexedDB present but open() throws synchronously → openDb rejects → get/put fall back
  const stubIdbOpenThrows = () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('idb open boom')
      },
    })
  }

  // indexedDB opens OK but db.transaction() throws → runTx rejects → get/put fall back
  const stubIdbTxThrows = () => {
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        throw new Error('idb tx boom')
      },
      close: () => {},
    }
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: {
          onupgradeneeded: ((e: { target: unknown }) => void) | null
          onsuccess: ((e: { target: unknown }) => void) | null
          onerror: ((e: { target: unknown }) => void) | null
          result: unknown
        } = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined }
        queueMicrotask(() => {
          req.result = fakeDb
          req.onsuccess?.({ target: req })
        })
        return req
      },
    })
  }

  it('IDB open() failure → one warn toast + record retained in memStore', async () => {
    stubIdbOpenThrows()
    await __resetWriteQueueDb() // drop the real-db dbPromise cached by the outer beforeEach so openDb reopens against the throwing stub
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1')) // getAll + put both hit IDB failure → memStore
    expect(toastWarn).toHaveBeenCalledTimes(1)
    expect(toastWarn).toHaveBeenCalledWith('本地保存仅内存暂存,刷新页面可能丢失未保存的改动。')
    expect(warnLog).toHaveBeenCalled()
    expect(await q.pendingCount()).toBe(1) // record survived in memStore
    expect((await __dumpWritesForTest()).length).toBe(1)
  })

  it('IDB transaction failure → one warn toast + record retained in memStore', async () => {
    stubIdbTxThrows()
    await __resetWriteQueueDb() // drop cached real-db dbPromise so runTx reopens against the tx-throwing stub
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    expect(toastWarn).toHaveBeenCalledTimes(1)
    expect(warnLog).toHaveBeenCalled()
    expect(await q.pendingCount()).toBe(1)
    expect((await __dumpWritesForTest()).length).toBe(1)
  })

  it('debounces the toast across multiple failing writes (no spam)', async () => {
    stubIdbOpenThrows()
    await __resetWriteQueueDb()
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.enqueue(minimalNode('c1', 'n2')) // different resourceKey → not coalesced
    expect(toastWarn).toHaveBeenCalledTimes(1) // second failure did not re-toast
    expect(await q.pendingCount()).toBe(2) // both records retained in memStore
  })
})

// ── G1-a R4 F2:零项目 New Canvas 同毫秒 project/canvas FK 排序(drain tie-breaker)──
//
// 复现 R4 P1 阻断项:零项目账号 New Canvas 同步路径(createCanvas → createProject → 两次 enqueue
// 到不同 resource-key 链)把 createProject 与 createCanvas 在**同一毫秒**入队。IDB getAll() 按 key(id)
// 序返回——非确定,可能 canvas 在前。drain 纯 timestamp 排序对同毫秒返回 0,顺序退化为 IDB key 序;
// 若 canvas 先 drain,真 Hono POST /api/canvas 缺 parent project → 404 unknown-project(见
// server/routes/canvas.ts:286-289 + server/routes/canvas.route.test.ts:26-29)→ classifyHttpStatus(404,
// isDelete=false) → rejected terminal → 记录被删 → 刷新后画布永久丢失。
//
// 修:drain 排序补 dependencyRank tie-breaker(同毫秒 project 类 rank0 先于 canvas 类 rank1)。
// 本测试用 __seedWritesForTest 直接构造受控 id 的记录精确复现"逆境 IDB key 顺序"(canvas id 字典序
// 在前),用 FK-enforcing mock executor 忠实建模真 Hono 404→rejected-terminal 分类(parent 未建则
// canvas rejected),断言 drain 重排后 project 先发、双 success、零 terminal。
//
// 注:src/lib ↔ server 跨 tsconfig 项目边界(TS2591,有意为之——见 chatWiring.integration.test.ts:13-14),
// 故 client 侧 drain 排序修复的 committed 红→绿测试在此文件用 FK-mock executor 覆盖;真 Hono 的
// 404 unknown-project → terminal 行为由 server/routes/canvas.route.test.ts:26-29 独立覆盖,真 Hono
// project+canvas 成功落库由 persistWiring.integration.test.ts 覆盖——两端合起来证 client 排序 + 真 route
// FK 行为。
describe('G1-a R4 F2 — 同毫秒 createProject/createCanvas 的 drain 依赖排序(tie-breaker)', () => {
  // FK-enforcing mock executor:忠实建模真 Hono(project 未建则 canvas POST → 404 unknown-project →
  // classifyHttpStatus(404,isDelete=false) → rejected terminal)。createProject 先建 parent → success;
  // createCanvas 若 parent 已建 → success,否则 → rejected(terminal,记录被删,复现画布丢失)。
  const fkExecutor = () => {
    const calls: { op: WriteOp; key: string }[] = []
    const createdProjects = new Set<string>()
    const fn = vi.fn(async (op: WriteOp, key: string): Promise<WriteOutcome> => {
      calls.push({ op, key })
      if (op.kind === 'createProject') {
        createdProjects.add(op.id ?? '')
        return { status: 'success', revision: 0 }
      }
      if (op.kind === 'createCanvas') {
        if (createdProjects.has(op.projectId)) return { status: 'success', revision: 0 }
        return { status: 'rejected', body: { error: 'unknown-project' } }
      }
      return { status: 'success' }
    })
    return { fn, calls, createdProjects }
  }

  // 同毫秒(createdAt=nextAttemptAt=1000,= makeQueue clockMs)的 project/canvas 记录,canvas 归 p1。
  const makeRecords = (projectRecordId: string, canvasRecordId: string): { project: QueuedWrite; canvas: QueuedWrite } => ({
    project: {
      id: projectRecordId,
      idempotencyKey: 'mivo-proj-test',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Default Project', id: 'p1' },
      resourceKey: 'project:p1',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    },
    canvas: {
      id: canvasRecordId,
      idempotencyKey: 'mivo-canvas-test',
      userId: 'userA',
      op: { kind: 'createCanvas', canvasId: 'c1', projectId: 'p1', title: 'Untitled Canvas' },
      resourceKey: 'canvas:c1',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    },
  })

  it('逆境 IDB key 序(canvas id 字典序在前)+ 同毫秒 → drain 重排 project 先发,双 success 零 terminal', async () => {
    const { fn, calls, createdProjects } = fkExecutor()
    const q = makeQueue(fn)
    const { project, canvas } = makeRecords('zz-project-record', 'aa-canvas-record')
    await __seedWritesForTest([project, canvas])

    // 确认逆境 setup:IDB getAll 按 key(id)序返回 canvas 在前(字典序 aa < zz)。
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-canvas-record', 'zz-project-record'])

    const r = await q.drain()
    // R4 修复断言:project 必须先 drain(tie-breaker 重排),canvas 归属的 p1 已建 → canvas success。
    expect(calls).toHaveLength(2)
    expect(calls[0]!.op.kind).toBe('createProject') // 修复前此处为 'createCanvas'(canvas 先发 → 404 terminal)
    expect(calls[1]!.op.kind).toBe('createCanvas')
    expect(calls[1]!.op.kind === 'createCanvas' && (calls[1]!.op as { projectId: string }).projectId).toBe('p1')
    expect(r).toEqual({ processed: 2, successes: 2, failures: 0, terminals: 0, paused: false })
    expect(createdProjects.has('p1')).toBe(true) // project 真落"库"(mock)
    expect(await q.pendingCount()).toBe(0) // 双 success 后队列清空
  })

  it('非逆境 IDB key 序(project id 在前)→ 仍 project 先发、双 success 零 terminal(回归守卫)', async () => {
    const { fn, calls } = fkExecutor()
    const q = makeQueue(fn)
    const { project, canvas } = makeRecords('aa-project-record', 'zz-canvas-record')
    await __seedWritesForTest([project, canvas])

    // 非逆境:IDB getAll 返回 project 在前(字典序 aa < zz)。此顺序即使无 tie-breaker 也 project 先发,
    // 修复不应改变它——回归守卫,确保 tie-breaker 只在 tie 时生效、不误伤非逆境路径。
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-project-record', 'zz-canvas-record'])

    const r = await q.drain()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.op.kind).toBe('createProject')
    expect(calls[1]!.op.kind).toBe('createCanvas')
    expect(r).toEqual({ processed: 2, successes: 2, failures: 0, terminals: 0, paused: false })
    expect(await q.pendingCount()).toBe(0)
  })

  it('updateCanvas(move 到同毫秒新建的 project)也排在该 createProject 之后(rank1 vs rank0)', async () => {
    // 覆盖"同毫秒多资源链 project→canvas FK"一类的另一形态:updateCanvas(move)改 projectId 指向同批
    // 新建的 project。move PUT 的 payload.projectId 同样要求 parent project 先建好,否则 404 terminal。
    // tie-breaker 把 createProject(rank0)排到 updateCanvas(rank1)前。
    const { fn, calls } = fkExecutor()
    const q = makeQueue(fn)
    const project: QueuedWrite = {
      id: 'zz-move-project',
      idempotencyKey: 'mivo-proj-move',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Target Project', id: 'p-target' },
      resourceKey: 'project:p-target',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const move: QueuedWrite = {
      id: 'aa-move-canvas',
      idempotencyKey: 'mivo-move-test',
      userId: 'userA',
      op: { kind: 'updateCanvas', canvasId: 'c-existing', projectId: 'p-target', title: 'Moved' },
      resourceKey: 'canvas:c-existing',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    await __seedWritesForTest([project, move])
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-move-canvas', 'zz-move-project']) // 逆境:update 在前

    const r = await q.drain()
    expect(calls[0]!.op.kind).toBe('createProject') // 修复前:update 先发 → 移到未建 project → 404 terminal
    expect(calls[1]!.op.kind).toBe('updateCanvas')
    expect(r).toEqual({ processed: 2, successes: 2, failures: 0, terminals: 0, paused: false })
  })
})

// ── G1-a R5 F1:同毫秒 createCanvas/appendChatMessage 的 drain 依赖排序(三层 rank)──
//
// 复现 R5-1 P1 阻断项:用户新建画布后立即发消息(chatStore.sendMessage → enqueueChatAppend)把
// createCanvas 与 appendChatMessage 在**同一毫秒**入队到不同 resource-key 链(canvas:<id> vs chat
// resourceKey=null)。IDB getAll() 按 key(id)序返回——非确定,可能 chat 在前。R4 修前 rank 只有
// project(0)/canvas(1) 两层,appendChatMessage 落 rank 0,同毫秒 tie 时 rank 0 的 chat 排在 rank 1 的
// canvas **之前** drain → 真 Hono POST /api/canvas/:id/chat 经 authzCanvas(canvas.ts:107)发现 canvas 未建
// → 404 unknown-canvas → classifyHttpStatus(404,isDelete=false) → rejected terminal → chat record 被删
// → 随后 canvas 创建成功也不重放 → 消息永久丢失(R5-1 复现:1 success / 1 terminal,GET chat 空)。
//
// 修:dependencyRank 三层化(project 0 → canvas 1 → canvas-dependent chat 写 2)。tie-breaker 同毫秒时把
// chat(rank 2)排到 canvas(rank 1)之后,保证 canvas prerequisite 先 drain。
// 本测试用 __seedWritesForTest 构造受控 id 的记录精确复现"逆境 IDB key 顺序"(chat id 字典序在前),
// 用 FK-enforcing mock executor 忠实建模真 Hono 三层 FK 链(project 未建 canvas 404 unknown-project;
// canvas 未建 chat 404 unknown-canvas → rejected terminal),断言 drain 重排后 project→canvas→chat、
// 3 success / 0 terminal。
//
// 注:src/lib ↔ server 跨 tsconfig 项目边界(TS2591,有意为之——见 chatWiring.integration.test.ts:13-14)
// 使 client drain 直连真 Hono 的一体化闭环测试不可行;故 client 排序修复的 committed 红→绿测试在此文件
// 用 FK-mock executor 覆盖,真 Hono 的 404 unknown-canvas → terminal 行为由 server/routes/canvas.route.test.ts
// POST chat 404 覆盖,真 Hono project+canvas+chat 成功落库 + reload hydrate 由 persistWiring /
// chatWiring integration 覆盖——两端合起来证 client 排序 + 真 route FK 行为。一体化真 Hono 闭环由
// 临时 probe(不 commit)在本轮独立验证(见 REPORT-G1A-FIX-R5-DONE.md)。
describe('G1-a R5 F1 — 同毫秒 createCanvas/appendChatMessage 的 drain 依赖排序(三层 rank)', () => {
  // FK-enforcing mock executor:忠实建模真 Hono 三层 FK 链。
  //  - createProject → success(记 createdProjects)。
  //  - createCanvas → parent project 已建 → success(记 createdCanvases);否则 404 unknown-project → rejected terminal。
  //  - appendChatMessage → canvas 已建 → success;否则 404 unknown-canvas → rejected terminal(复现 R5-1 消息丢失)。
  // preseed 选项模拟"父资源在先前 drain/hydrate 已建好"的场景(二链最小对用)。
  const fkChatExecutor = (opts: { preseedProjects?: string[]; preseedCanvases?: string[] } = {}) => {
    const calls: { op: WriteOp; key: string }[] = []
    const createdProjects = new Set<string>(opts.preseedProjects ?? [])
    const createdCanvases = new Set<string>(opts.preseedCanvases ?? [])
    const fn = vi.fn(async (op: WriteOp, key: string): Promise<WriteOutcome> => {
      calls.push({ op, key })
      if (op.kind === 'createProject') {
        createdProjects.add(op.id ?? '')
        return { status: 'success', revision: 0 }
      }
      if (op.kind === 'createCanvas') {
        if (createdProjects.has(op.projectId)) {
          createdCanvases.add(op.canvasId)
          return { status: 'success', revision: 0 }
        }
        return { status: 'rejected', body: { error: 'unknown-project' } }
      }
      if (op.kind === 'appendChatMessage') {
        if (createdCanvases.has(op.canvasId)) return { status: 'success' }
        return { status: 'rejected', body: { error: 'unknown-canvas' } }
      }
      return { status: 'success' }
    })
    return { fn, calls, createdProjects, createdCanvases }
  }

  // 同毫秒(createdAt=nextAttemptAt=1000 = makeQueue clockMs)的 project/canvas/chat 三链记录,canvas 归 p1,
  // chat 归 c1。chat 的 resourceKey=null(每条消息独立 op,不 coalesce)。
  const makeTripleRecords = (
    projectRecordId: string,
    canvasRecordId: string,
    chatRecordId: string,
  ): { project: QueuedWrite; canvas: QueuedWrite; chat: QueuedWrite } => ({
    project: {
      id: projectRecordId,
      idempotencyKey: 'mivo-proj-r5',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Default Project', id: 'p1' },
      resourceKey: 'project:p1',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    },
    canvas: {
      id: canvasRecordId,
      idempotencyKey: 'mivo-canvas-r5',
      userId: 'userA',
      op: { kind: 'createCanvas', canvasId: 'c1', projectId: 'p1', title: 'Untitled Canvas' },
      resourceKey: 'canvas:c1',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    },
    chat: {
      id: chatRecordId,
      idempotencyKey: 'mivo-chat-r5',
      userId: 'userA',
      op: { kind: 'appendChatMessage', canvasId: 'c1', message: { id: 'm1', role: 'user', text: 'first' } },
      resourceKey: null,
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    },
  })

  it('逆境 IDB key 序(chat id 在前)+ 同毫秒三链 → drain 重排 project→canvas→chat,3 success 零 terminal', async () => {
    const { fn, calls, createdCanvases } = fkChatExecutor()
    const q = makeQueue(fn)
    const { project, canvas, chat } = makeTripleRecords('zz-project-record', 'mm-canvas-record', 'aa-chat-record')
    await __seedWritesForTest([project, canvas, chat])

    // 确认逆境 setup:IDB getAll 按 key(id)序返回 chat 在前(aa < mm < zz)。
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-chat-record', 'mm-canvas-record', 'zz-project-record'])

    const r = await q.drain()
    // R5-1 修复断言:三层 rank 重排 project(0)→canvas(1)→chat(2),chat 不先 drain。
    // 修复前(两层 rank,chat=0):chat 先 drain → 404 unknown-canvas → terminal,消息永久丢失。
    expect(calls).toHaveLength(3)
    expect(calls[0]!.op.kind).toBe('createProject')
    expect(calls[1]!.op.kind).toBe('createCanvas')
    expect(calls[2]!.op.kind).toBe('appendChatMessage')
    expect(r).toEqual({ processed: 3, successes: 3, failures: 0, terminals: 0, paused: false })
    expect(createdCanvases.has('c1')).toBe(true) // canvas 真落"库"(mock)→ chat 才 success
    expect(await q.pendingCount()).toBe(0) // 三 success 后队列清空
  })

  it('逆境 IDB key 序(chat 在前)+ 同毫秒 canvas→chat 二链(R5-1 最小对)→ drain 重排 canvas→chat,2 success 零 terminal', async () => {
    // R5-1 复现的最小对:parent project 已在先前 drain/hydrate 建好(mock preseed p1),本轮同毫秒
    // createCanvas + appendChatMessage 跨 resource-key(chat resourceKey=null)。逆境 chat id 在前 →
    // 修复前(两层 rank,chat=0)chat 先 drain → 404 unknown-canvas → terminal 删 chat(消息永久丢失);
    // 修复后(三层 rank,chat=2)canvas 先建 → chat success。
    const { fn, calls } = fkChatExecutor({ preseedProjects: ['p1'] })
    const q = makeQueue(fn)
    const canvas: QueuedWrite = {
      id: 'zz-canvas-pair',
      idempotencyKey: 'mivo-canvas-pair',
      userId: 'userA',
      op: { kind: 'createCanvas', canvasId: 'c-chat', projectId: 'p1', title: 'Untitled Canvas' },
      resourceKey: 'canvas:c-chat',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const chat: QueuedWrite = {
      id: 'aa-chat-pair',
      idempotencyKey: 'mivo-chat-pair',
      userId: 'userA',
      op: { kind: 'appendChatMessage', canvasId: 'c-chat', message: { id: 'm1', role: 'user', text: 'first' } },
      resourceKey: null,
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    await __seedWritesForTest([canvas, chat])
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-chat-pair', 'zz-canvas-pair']) // 逆境:chat 在前

    const r = await q.drain()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.op.kind).toBe('createCanvas') // 修复前:chat 先发 → 404 unknown-canvas → terminal
    expect(calls[1]!.op.kind).toBe('appendChatMessage')
    expect(r).toEqual({ processed: 2, successes: 2, failures: 0, terminals: 0, paused: false })
    expect(await q.pendingCount()).toBe(0)
  })

  it('手术刀守卫(R6-1):无 FK 竞争保持 IDB 原序 chat→project,依赖感知 rank 不改序', async () => {
    // 回归守卫(R6-1):同毫秒 createProject(p-guard) + appendChatMessage(canvasId=c-pre),但 chat 依赖的
    // canvas c-pre 已在先前 drain 建好(mock preseed)——chat 与 createProject 无 FK 竞争(chat 不引用
    // p-guard,project 不是 chat 的批内 parent)。依赖感知 rank 下两者 rank 均 0 → 保持 IDB 原序
    // chat→project。旧全局 kind rank(chat=2)无条件把 project 排前改序(红);新实现只在批内存在真实
    // FK parent 时才后置,无 FK 对保持原序(绿)。精确断言 calls 顺序,禁止 .sort() 抹序。
    const { fn, calls } = fkChatExecutor({ preseedCanvases: ['c-pre'] })
    const q = makeQueue(fn)
    const project: QueuedWrite = {
      id: 'zz-proj-guard',
      idempotencyKey: 'mivo-proj-guard',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Guard Project', id: 'p-guard' },
      resourceKey: 'project:p-guard',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const chat: QueuedWrite = {
      id: 'aa-chat-guard',
      idempotencyKey: 'mivo-chat-guard',
      userId: 'userA',
      op: { kind: 'appendChatMessage', canvasId: 'c-pre', message: { id: 'm1', role: 'user', text: 'hi' } },
      resourceKey: null,
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    await __seedWritesForTest([project, chat])
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-chat-guard', 'zz-proj-guard']) // IDB 序 chat 在前

    const r = await q.drain()
    // R6-1:无 FK 竞争——chat 依赖的 canvas c-pre 已 preseed(不在批内 pendingCanvasCreateIds),
    // chat 与同毫秒 createProject(p-guard)互不引用 → 两者 rank 均 0,stable sort 保持 IDB 入队原序
    // chat→project。旧全局 kind rank 会把 project(0) 排到 chat(2) 前改序(红);依赖感知 rank 不改序(绿)。
    expect(calls).toHaveLength(2)
    expect(calls[0]!.op.kind).toBe('appendChatMessage') // 保持 IDB 原序:chat 在前
    expect(calls[1]!.op.kind).toBe('createProject')
    expect(r).toEqual({ processed: 2, successes: 2, failures: 0, terminals: 0, paused: false })
    expect(await q.pendingCount()).toBe(0)
  })
})

// ── G1-a R7-1:稳定拓扑排序——只沿真实 FK 边约束顺序,其余一律保持原序 ──
//
// 复现 R7-1 P2 阻断项:R6-1 的条件 dependencyRank 虽只在批内存在 FK parent 时给 child 升 rank,但仍用
// 单一标量 rank 对整批分层排序。混合批中一旦 chat 因批内 canvas 升到 rank 2,所有 rank 0 的无关记录
// (如 unrelated createProject)都会跨过 chat——即使前两条真实 FK 边已天然有序、第三条与两者无 FK,
// 正确的 surgical 序应完全不变。返修声明"只重排实际 FK 边"不成立。
//
// 修法(lead 指定):稳定拓扑排序——以原 IDB 序(主键 nextAttemptAt/createdAt/入队序)为优先级,Kahn 算法
// 就绪集(入度 0)每次取原序最靠前者。只建批内真实 FK 边:
//  - createProject(id) → createCanvas/updateCanvas(projectId=id)(批内)
//  - createCanvas(id) → appendChatMessage/updateChatMessage/deleteChatMessage(canvasId=id)(批内)
//  传递成链。无边记录入度 0 → 完全保持原序;有边记录只在 parent 必须先 drain 时后置。
//
// 红→绿:10143c2 的条件 rank 对混合批守卫红(canvas→unrelated project→chat)、对双链守卫红(精确序不同);
// 拓扑排序两者皆绿。
describe('G1-a R7-1 — 稳定拓扑排序(Kahn + 原序 tie-break,只沿真实 FK 边)', () => {
  // 复用 R5 的 fkChatExecutor(建模三层 FK 链 + preseed 选项;此处块内重定义,与 R5 隔离)。
  const fkChatExecutor = (opts: { preseedProjects?: string[]; preseedCanvases?: string[] } = {}) => {
    const calls: { op: WriteOp; key: string }[] = []
    const createdProjects = new Set<string>(opts.preseedProjects ?? [])
    const createdCanvases = new Set<string>(opts.preseedCanvases ?? [])
    const fn = vi.fn(async (op: WriteOp, key: string): Promise<WriteOutcome> => {
      calls.push({ op, key })
      if (op.kind === 'createProject') {
        createdProjects.add(op.id ?? '')
        return { status: 'success', revision: 0 }
      }
      if (op.kind === 'createCanvas') {
        if (createdProjects.has(op.projectId)) {
          createdCanvases.add(op.canvasId)
          return { status: 'success', revision: 0 }
        }
        return { status: 'rejected', body: { error: 'unknown-project' } }
      }
      if (op.kind === 'appendChatMessage') {
        if (createdCanvases.has(op.canvasId)) return { status: 'success' }
        return { status: 'rejected', body: { error: 'unknown-canvas' } }
      }
      return { status: 'success' }
    })
    return { fn, calls, createdProjects, createdCanvases }
  }

  it('混合批守卫:canvas→chat 真实边已天然有序 + 无关 project 在后 → 保持 canvas→chat→unrelated project 3/0', async () => {
    // R7-1 反例:project p-mixed 已 preseed(canvas 的 project 在先前 drain 建好);同毫秒 IDB 原序严格为
    // createCanvas(aa,c-mixed) → appendChatMessage(bb,c-mixed) → unrelated createProject(zz,p-unrelated-mixed)。
    // 前两条真实 FK 边(canvas→chat)已天然有序,第三条与两者无 FK。正确 surgical 稳定序应完全不变。
    // 10143c2 条件 rank:chat 升 rank 2 → 无关 project(rank 0)跨过 chat → canvas→project→chat(RED);
    // 拓扑排序:canvas→chat 边存在但原序已 canvas 在 chat 前不改变其相对位置;无关 project 无边不跨过 →
    // canvas→chat→project(GREEN)。精确断言禁 .sort() 抹序。
    const { fn, calls } = fkChatExecutor({ preseedProjects: ['p-mixed'] })
    const q = makeQueue(fn)
    const canvas: QueuedWrite = {
      id: 'aa-canvas-mixed',
      idempotencyKey: 'mivo-canvas-mixed',
      userId: 'userA',
      op: { kind: 'createCanvas', canvasId: 'c-mixed', projectId: 'p-mixed', title: 'Mixed Canvas' },
      resourceKey: 'canvas:c-mixed',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const chat: QueuedWrite = {
      id: 'mm-chat-mixed',
      idempotencyKey: 'mivo-chat-mixed',
      userId: 'userA',
      op: { kind: 'appendChatMessage', canvasId: 'c-mixed', message: { id: 'm1', role: 'user', text: 'hi' } },
      resourceKey: null,
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const unrelatedProject: QueuedWrite = {
      id: 'zz-project-mixed',
      idempotencyKey: 'mivo-proj-mixed',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Unrelated Project', id: 'p-unrelated-mixed' },
      resourceKey: 'project:p-unrelated-mixed',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    await __seedWritesForTest([canvas, chat, unrelatedProject])
    // 确认 setup:IDB getAll 按 key(id)序返回 canvas→chat→project(aa < mm < zz)。
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-canvas-mixed', 'mm-chat-mixed', 'zz-project-mixed'])

    const r = await q.drain()
    // R7-1 修复断言:无关 project 不跨过 chat,保持原序 canvas→chat→unrelated project。
    // 10143c2 此处为 canvas→unrelated project→chat(RED:calls[1] 是 createProject 而非 appendChatMessage)。
    expect(calls).toHaveLength(3)
    expect(calls[0]!.op.kind).toBe('createCanvas')
    expect(calls[1]!.op.kind).toBe('appendChatMessage')
    expect(calls[2]!.op.kind).toBe('createProject')
    expect(r).toEqual({ processed: 3, successes: 3, failures: 0, terminals: 0, paused: false })
    expect(await q.pendingCount()).toBe(0)
  })

  it('双链交错守卫:c-a→p-a、c-b→p-b 交叉 → 拓扑 tie-break 给 p-a→c-a→p-b→c-b 4/0(不是 rank 分层序)', async () => {
    // 双链交错:同毫秒 IDB 原序 c-a, c-b, p-a, p-b(canvas 在前 project 在后),c-a→p-a、c-b→p-b 顺序映射。
    // 10143c2 条件 rank:两 canvas 均 rank 1、两 project 均 rank 0 → rank 内保持原序 → p-a→p-b→c-a→c-b
    //   (RED:精确序与拓扑 tie-break 不同;两者都合法拓扑,但 rank 分层把所有 project 前置、所有 canvas 后置)。
    // 拓扑排序:就绪集{p-a,p-b}取原序最小 p-a(idx2) → c-a 就绪(idx0<3)取 c-a → p-b → c-b →
    //   p-a→c-a→p-b→c-b(GREEN)。断言精确序锁定"就绪即取原序最小"的 tie-break 语义,防退回 rank 分层。
    const { fn, calls } = fkChatExecutor()
    const q = makeQueue(fn)
    const canvasA: QueuedWrite = {
      id: 'aa-canvas-a',
      idempotencyKey: 'mivo-canvas-a',
      userId: 'userA',
      op: { kind: 'createCanvas', canvasId: 'c-a', projectId: 'p-a', title: 'Canvas A' },
      resourceKey: 'canvas:c-a',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const canvasB: QueuedWrite = {
      id: 'bb-canvas-b',
      idempotencyKey: 'mivo-canvas-b',
      userId: 'userA',
      op: { kind: 'createCanvas', canvasId: 'c-b', projectId: 'p-b', title: 'Canvas B' },
      resourceKey: 'canvas:c-b',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const projectA: QueuedWrite = {
      id: 'cc-project-a',
      idempotencyKey: 'mivo-proj-a',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Project A', id: 'p-a' },
      resourceKey: 'project:p-a',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    const projectB: QueuedWrite = {
      id: 'dd-project-b',
      idempotencyKey: 'mivo-proj-b',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Project B', id: 'p-b' },
      resourceKey: 'project:p-b',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
    }
    await __seedWritesForTest([canvasA, canvasB, projectA, projectB])
    const dumped = await __dumpWritesForTest()
    expect(dumped.map((r) => r.id)).toEqual(['aa-canvas-a', 'bb-canvas-b', 'cc-project-a', 'dd-project-b'])

    const r = await q.drain()
    // 拓扑 tie-break 断言:每个 project 先于其 canvas,且原序 tie-break 给 p-a→c-a→p-b→c-b。
    // 10143c2 条件 rank 给 p-a→p-b→c-a→c-b(RED:calls[1] 是 createProject 而非 createCanvas)。
    expect(calls).toHaveLength(4)
    expect(calls[0]!.op.kind).toBe('createProject')
    expect((calls[0]!.op as { id?: string }).id).toBe('p-a')
    expect(calls[1]!.op.kind).toBe('createCanvas')
    expect((calls[1]!.op as { canvasId: string }).canvasId).toBe('c-a')
    expect(calls[2]!.op.kind).toBe('createProject')
    expect((calls[2]!.op as { id?: string }).id).toBe('p-b')
    expect(calls[3]!.op.kind).toBe('createCanvas')
    expect((calls[3]!.op as { canvasId: string }).canvasId).toBe('c-b')
    expect(r).toEqual({ processed: 4, successes: 4, failures: 0, terminals: 0, paused: false })
    expect(await q.pendingCount()).toBe(0)
  })
})

// ── FX-7 / A6: durable terminal ledger (dead-letter / conflict / rejected outcomes) ──
//
// 决策 3(lead A6 task pack):writeRetryQueue 的 dead-letter/conflict 终态处理(现状"记录后立即
// 删除")增加持久化终态账本(IDB,含 op 摘要/错误码/时间),供 A3 灰度观察窗定量统计
// "dead-letter=0" / "不可解释 conflict=0"。**只加账本不改重试语义** —— 账本是 append-only,
// 与现有 delete-after-surface 并行;retry/backoff/terminal-decision 逻辑不动。
//
// 账本查询入口(生产/A3 观察):
//   import { getWriteQueueTerminals } from './writeRetryQueue'
//   const terminals = await getWriteQueueTerminals()   // [{status, opKind, resourceKey, message, attempts, timestamp, ...}]
// 测试入口:__dumpTerminalsForTest()(同数据,test-only 镜像)。

describe('FX-7 / A6 — durable terminal ledger (append-only; retry semantics unchanged)', () => {
  it('SC3: a dead-letter outcome is recorded in the durable ledger with its error code + op summary', async () => {
    const { fn } = seqExecutor([{ status: 'transient', message: 'http_503' }])
    const q = makeQueue(fn, { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    // attempt 1: attempts 0→1 (<2) → backoff
    expect((await q.drain()).failures).toBe(1)
    tick(800) // past backoff
    // attempt 2: attempts 1→2 (>=2) → dead-letter (terminal)
    const r = await q.drain()
    expect(r.terminals).toBe(1)

    // The durable terminal ledger has the dead-letter entry, queryable with the error code.
    const ledger = await __dumpTerminalsForTest()
    expect(ledger).toHaveLength(1)
    const entry = ledger[0]!
    expect(entry.status).toBe('dead-letter') // error code
    expect(entry.opKind).toBe('upsertNode') // op summary
    expect(entry.message).toContain('http_503') // error detail
    expect(entry.message).toContain('after 2 attempts')
    expect(entry.attempts).toBe(2) // attempts at termination
    expect(entry.resourceKey).toBe('node:c1:n1') // resource summary
  })

  it('conflict + rejected + terminal outcomes are all ledgered (A3 audit coverage)', async () => {
    // conflict (409 revision-conflict)
    const cq = makeQueue(seqExecutor([{ status: 'conflict', currentRevision: 9 }]).fn, { onConflict: vi.fn() })
    await cq.enqueue(minimalNode('c1', 'n1', 5))
    await cq.drain()
    // rejected (4xx)
    const rq = makeQueue(seqExecutor([{ status: 'rejected', body: { error: 'bad-request' } }]).fn)
    await rq.enqueue(minimalNode('c2', 'n2'))
    await rq.drain()
    // plain terminal (non-classifiable HTTP)
    const tq = makeQueue(seqExecutor([{ status: 'terminal', message: 'http_418' }]).fn)
    await tq.enqueue(minimalNode('c3', 'n3'))
    await tq.drain()

    const ledger = await __dumpTerminalsForTest()
    const statuses = ledger.map((e) => e.status).sort()
    expect(statuses).toEqual(['conflict', 'rejected', 'terminal'])
    // each entry carries its error-code detail in `message`
    const byStatus = new Map(ledger.map((e) => [e.status, e]))
    expect(byStatus.get('conflict')!.message).toContain('9')
    expect(byStatus.get('rejected')!.message).toContain('bad-request')
    expect(byStatus.get('terminal')!.message).toContain('http_418')
  })

  it('success outcomes are NOT ledgered (success is not a failure terminal)', async () => {
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.drain()
    expect((await __dumpTerminalsForTest()).length).toBe(0)
  })

  it('ledger does not change retry semantics: a transient op still retries with backoff then succeeds', async () => {
    // The ledger is append-only alongside delete-after-surface; it must not alter the
    // retry/backoff/terminal-decision flow. A transient op retries and succeeds on the
    // second attempt — the ledger stays empty until a real terminal outcome.
    const { fn, calls } = seqExecutor([
      { status: 'transient', message: 'http_503' },
      { status: 'success' },
    ])
    const q = makeQueue(fn, { baseDelayMs: 1000, maxDelayMs: 60_000 })
    await q.enqueue(minimalNode('c1', 'n1'))
    expect((await q.drain()).failures).toBe(1)
    tick(1000) // past backoff
    expect((await q.drain()).successes).toBe(1)
    expect(calls).toHaveLength(2)
    // No terminal ledger entry — success is not a failure terminal.
    expect((await __dumpTerminalsForTest()).length).toBe(0)
  })
})

// ── P1-3: writeRetryQueue openDb upgrade blocking + cooperative close ──
//
// 复现 P1-3 阻断项:openDb v1→v2 无 onblocked 处理 + 已开连接无 versionchange 协作关闭。
// 旧 tab 持 v1 连接(无 onversionchange)时新 tab open(2) 永久 pending,所有 IDB 操作卡死,
// 且不触发降级 catch → 全部静默挂死。
//
// 修(lead 指定):openDb 加 onblocked → 定时超时降级内存 + onsuccess 后 db.onversionchange 主动 close。
// 测试用 stub 控制 onblocked/versionchange 事件(确定性,避免跨测试 DB 版本号交叉污染)。

// ── P1-3 (second-round): openDb upgrade blocking + cooperative close ──
//
// sol 实测证伪了第一轮的 stub 测试(只 fire 事件,没建真实 v1 连接 → 假绿):blocked 后
// 第二个 open 排在第一个 pending upgrade 后面,不收 onblocked、无自己的 timeout → 永久挂。
// 修:blocked timeout 后进模块级 blocked 状态,后续 openDb 立即 reject→memStore,不再新建 open;
// 晚到 onsuccess → close+清状态恢复。同一 blocker 下绝不排队第二个 open。
//
// 验收测试**必须真实连接,不许事件 stub**(lead 红线):fake-indexeddb 真实建 v1 连接持有。

describe('FX-7 / A6 P1-3 (r2) — real-connection upgrade blocking + cooperative close', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    return __resetWriteQueueDb()
  })

  it('① a real held v1 connection blocks the v2 upgrade → enqueue/pendingCount degrade to mem WITHOUT hanging (Promise.race 1s)', async () => {
    const testDb = 'mivo-write-queue-p13-blocked'
    __setWriteQueueDbNameForTest(testDb)
    __setIdbBlockTimeoutForTest(30)
    // Open a real v1 connection and HOLD it (no onversionchange handler → won't cooperate-close).
    const v1Open = indexedDB.open(testDb, 1)
    v1Open.onupgradeneeded = () => {
      const db = v1Open.result
      if (!db.objectStoreNames.contains('writes')) db.createObjectStore('writes', { keyPath: 'id' })
    }
    const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
      v1Open.onsuccess = () => resolve(v1Open.result)
      v1Open.onerror = () => reject(v1Open.error)
    })
    // NOTE: no v1Db.onversionchange → this connection won't close → blocks the module's open(v2).

    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    // enqueue must NOT hang — it degrades to memStore via the blocked-timeout → blocked-state path.
    // The second openDb (putWrite) immediately rejects (blockedState='blocked') — no second open queued.
    const HUNG = Symbol('hung')
    const outcome = await Promise.race([
      q.enqueue(minimalNode('c1', 'n1')).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 1000)),
    ])
    expect(outcome).toBe('ok') // did NOT hang (would be HUNG if the second open queued behind the stuck upgrade)
    expect(await q.pendingCount()).toBe(1) // memStore has the record (IDB blocked → degraded)
    expect(warnLog).toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('using in-memory fallback'))
    v1Db.close() // cleanup: release the blocker so afterEach/afterAll can reopen
  })

  it('② after closing the v1 blocker, the late onsuccess does not leak + subsequent ops recover IDB', async () => {
    const testDb = 'mivo-write-queue-p13-recover'
    __setWriteQueueDbNameForTest(testDb)
    __setIdbBlockTimeoutForTest(30)
    const v1Open = indexedDB.open(testDb, 1)
    v1Open.onupgradeneeded = () => {
      const db = v1Open.result
      if (!db.objectStoreNames.contains('writes')) db.createObjectStore('writes', { keyPath: 'id' })
    }
    const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
      v1Open.onsuccess = () => resolve(v1Open.result)
      v1Open.onerror = () => reject(v1Open.error)
    })

    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1')) // blocked → memStore (blockedState='blocked')
    expect(await q.pendingCount()).toBe(1)
    expect(warnLog).toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('using in-memory fallback'))

    // Close the blocker → the stuck v2 request resumes → late onsuccess fires → handler
    // closes the connection + clears blockedState (no leak). Wait for the DB to reach v2.
    v1Db.close()
    await vi.waitFor(
      async () => {
        // A fresh open(v2) should succeed (not block) once the late onsuccess completed.
        const probe = indexedDB.open(testDb, 2)
        await new Promise<void>((resolve, reject) => {
          probe.onsuccess = () => {
            probe.result.close()
            resolve()
          }
          probe.onblocked = () => reject(new Error('still blocked — late onsuccess did not fire'))
          probe.onerror = () => reject(probe.error)
        })
      },
      { timeout: 1000, interval: 10 },
    )

    // Subsequent module op recovers IDB (fresh open succeeds; no degradation warn).
    warnLog.mockClear()
    await q.enqueue(minimalNode('c1', 'n2'))
    expect(warnLog).not.toHaveBeenCalledWith(
      'Write Retry Queue',
      expect.stringContaining('using in-memory fallback'),
    )
    expect((await __dumpWritesForTest()).length).toBeGreaterThanOrEqual(1)
  })

  it('③ a real v2 connection cooperatively closes on a v3 upgrade (onversionchange)', async () => {
    const testDb = 'mivo-write-queue-p13-coop'
    __setWriteQueueDbNameForTest(testDb)
    __setIdbBlockTimeoutForTest(30)
    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    // Module opens v2 (fresh DB → onupgradeneeded creates writes/terminals/meta) + caches the
    // connection with db.onversionchange → close.
    await q.pendingCount()

    // Another "tab" requests a v3 upgrade. The module's v2 connection should get versionchange
    // → close (cooperative) so the v3 upgrade proceeds (not blocked).
    const v3Open = indexedDB.open(testDb, 3)
    let v3Result: 'success' | 'blocked' | null = null
    await new Promise<void>((resolve) => {
      v3Open.onsuccess = () => {
        v3Result = 'success'
        v3Open.result.close()
        resolve()
      }
      v3Open.onblocked = () => {
        v3Result = 'blocked' // module's v2 did NOT cooperate-close
        resolve()
      }
      v3Open.onerror = () => {
        v3Result = 'blocked'
        resolve()
      }
    })
    expect(v3Result).toBe('success') // cooperative close → v3 succeeded, not blocked
  })

  it('④ (P1-A) a stuck upgrade that errors/aborts clears the blocked state → next fresh open recovers IDB', async () => {
    const testDb = 'mivo-write-queue-p13-abort'
    __setWriteQueueDbNameForTest(testDb)
    __setIdbBlockTimeoutForTest(30)
    // Hold a real v1 connection (no onversionchange → blocks the module's open(v2)).
    const v1Open = indexedDB.open(testDb, 1)
    v1Open.onupgradeneeded = () => {
      const db = v1Open.result
      if (!db.objectStoreNames.contains('writes')) db.createObjectStore('writes', { keyPath: 'id' })
    }
    const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
      v1Open.onsuccess = () => resolve(v1Open.result)
      v1Open.onerror = () => reject(v1Open.error)
    })

    const { fn } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    // Module open(v2) → blocked → timeout → blockedState='blocked' (enqueue degrades to mem).
    await q.enqueue(minimalNode('c1', 'n1'))
    expect(await q.pendingCount()).toBe(1) // memStore
    expect(__isWriteQueueBlockedForTest()).toBe(true)

    // Set the upgrade to abort when it resumes (after v1 closes) → version-change tx aborts
    // → the open request errors (onerror). P1-A: onerror clears blockedState.
    __setOpenDbUpgradeAbortHookForTest((tx) => {
      tx.abort()
    })
    v1Db.close() // release the blocker → stuck v2 resumes → onupgradeneeded → abort → onerror
    await vi.waitFor(() => expect(__isWriteQueueBlockedForTest()).toBe(false), {
      timeout: 1000,
      interval: 10,
    })
    // P1-A: the onerror branch fired + cleared the blocked state (not the late-onsuccess
    // path). This is the specific fix for the "late error permanently locks blocked" bug.
    expect(__onErrorBlockedClearCountForTest()).toBeGreaterThan(0)
    // blockedState cleared by P1-A (onerror). Clear the hook so the recovery open is NOT aborted.
    __setOpenDbUpgradeAbortHookForTest(undefined)
    // Next module op recovers IDB (fresh open succeeds; no degradation warn).
    warnLog.mockClear()
    await q.enqueue(minimalNode('c1', 'n2'))
    expect(warnLog).not.toHaveBeenCalledWith(
      'Write Retry Queue',
      expect.stringContaining('using in-memory fallback'),
    )
  })
})

// ── P1-4: non-retreatable per-status cumulative terminal counters (A3 false-green) ──
//
// 复现 P1-4 阻断项:getWriteQueueTerminals 只本机 256 条快照,cap 静默 evict 最老 → 真实
// dead-letter 可被淘汰后 filter 得 0,A3 硬 SC 假绿。
//
// 修(lead 指定):持久化不可回退的 per-status 累计计数器(IDB meta,recordTerminal 时递增,
// evict 不减)+ ledger-eviction 计数;查询面 getWriteQueueTerminalCounters()(含 baseline 语义,
// resetTerminalCountersBaseline())。A3 判定以 counters(不可回退)为准而非快照 filter。

describe('FX-7 / A6 P1-4 — non-retreatable terminal counters (A3 uses counters, not snapshot)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clockMs = 1_000
    setPersistUserId('userA')
    return __resetWriteQueueDb()
  })
  afterEach(async () => {
    await __resetWriteQueueDb()
    __resetPersistUserId()
  })

  it('per-status counters are cumulative + non-retreatable (survive ledger eviction)', async () => {
    // Shrink the cap so we record 7 dead-letters with 2 evictions (fast, no 256-record run).
    __setMaxTerminalsForTest(5)
    const { fn } = seqExecutor([{ status: 'transient', message: 'http_503' }])
    const q = makeQueue(fn, { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000 })
    for (let i = 0; i < 7; i++) {
      await q.enqueue(minimalNode('c1', `n${i}`))
      await q.drain() // attempt 1: transient → backoff
      tick(10_000) // past backoff
      await q.drain() // attempt 2: dead-letter
    }

    // Snapshot is capped (5) — 2 entries were evicted.
    const ledger = await __dumpTerminalsForTest()
    expect(ledger.length).toBeLessThanOrEqual(5)

    // The non-retreatable counter reflects ALL 7 dead-letters (evict does NOT decrement).
    const { counters } = await getWriteQueueTerminalCounters()
    expect(counters['dead-letter']).toBe(7)
    expect(counters.evicted).toBeGreaterThanOrEqual(2) // eviction count tracked

    // The snapshot filter would FALSELY read 0 for an evicted dead-letter — counters do not.
    const ledgerDeadLetters = ledger.filter((e) => e.status === 'dead-letter').length
    expect(counters['dead-letter']).toBeGreaterThan(ledgerDeadLetters) // counters > snapshot
  })

  it('baseline semantics: A3 delta = counters - baseline (not snapshot filter)', async () => {
    __setMaxTerminalsForTest(5)
    const { fn } = seqExecutor([{ status: 'transient', message: 'http_503' }])
    const q = makeQueue(fn, { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000 })
    // Pre-baseline: 3 dead-letters.
    for (let i = 0; i < 3; i++) {
      await q.enqueue(minimalNode('c1', `n${i}`))
      await q.drain()
      tick(10_000)
      await q.drain()
    }
    // A3 observation window opens — snapshot the baseline.
    await resetTerminalCountersBaseline()
    const before = await getWriteQueueTerminalCounters()
    expect(before.baseline).not.toBeNull()
    expect(before.baseline?.['dead-letter']).toBe(3)
    expect(before.baselineTs).not.toBeNull()

    // During the window: 1 new dead-letter.
    await q.enqueue(minimalNode('c1', 'window'))
    await q.drain()
    tick(10_000)
    await q.drain()

    const after = await getWriteQueueTerminalCounters()
    expect(after.counters['dead-letter']).toBe(4) // cumulative
    // A3 green/red judgment = delta (counters - baseline), NOT snapshot filter.
    const deadLetterSince = after.counters['dead-letter'] - (after.baseline?.['dead-letter'] ?? 0)
    expect(deadLetterSince).toBe(1) // 1 new dead-letter in the window → NOT green (would be 0 for green)
  })

  it('conflict + rejected outcomes bump their respective counters (per-status, not just dead-letter)', async () => {
    const cq = makeQueue(seqExecutor([{ status: 'conflict', currentRevision: 9 }]).fn, { onConflict: vi.fn() })
    await cq.enqueue(minimalNode('c1', 'n1', 5))
    await cq.drain()
    const rq = makeQueue(seqExecutor([{ status: 'rejected', body: { error: 'bad' } }]).fn)
    await rq.enqueue(minimalNode('c2', 'n2'))
    await rq.drain()
    const { counters } = await getWriteQueueTerminalCounters()
    expect(counters.conflict).toBe(1)
    expect(counters.rejected).toBe(1)
    expect(counters['dead-letter']).toBe(0)
  })

  // ── P1-4 (second-round): atomic terminal tx (entry + counter in ONE tx) ──
  // sol 实测证伪了第一轮(三个独立 tx → 崩溃窗口 + 跨 tab lost update)。

  it('① fault-inject tx abort → NEITHER ledger entry NOR counter lands in IDB (atomic; no partial commit)', async () => {
    __setMaxTerminalsForTest(256) // no cap eviction — isolate the entry+counter atomicity
    // Fault-inject: abort the recordTerminal atomic tx (phase 'record') so neither the
    // entry put nor the counter RMW commits (tx rolls back atomically).
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })

    const { fn } = seqExecutor([{ status: 'terminal', message: 'http_418' }])
    const q = makeQueue(fn)
    await q.enqueue(minimalNode('c1', 'n1'))
    await q.drain() // terminal outcome → recordTerminal → tx aborts → mem fallback

    // IDB ledger does NOT contain the aborted entry (atomic rollback). The union with mem
    // would show the mem-fallback entry — so assert on the IDB-only view.
    const idbLedger = await __dumpIdbTerminalsForTest()
    expect(idbLedger.find((e) => e.status === 'terminal')).toBeUndefined()
    // IDB counter is UNCHANGED (no increment — the tx that would bump it aborted).
    const idbCounters = await __readIdbTerminalCountersForTest()
    expect(idbCounters.terminal).toBe(0)
    // No "ledger committed / counter unchanged" partial state can exist (both or neither).
  })

  it('② two concurrent recordTerminal calls → ledger=2 + counter delta=2 (no cross-tab lost update)', async () => {
    __setMaxTerminalsForTest(256)
    const baseCounters = await getWriteQueueTerminalCounters()
    const baselineDeadLetter = baseCounters.counters['dead-letter']

    // Fire two recordTerminal calls in parallel (simulates cross-tab concurrent terminals).
    // With atomic txs, IDB serializes the two TERMINALS+META txs → both land + counter=+2
    // (no RMW lost update; the non-atomic version would read 0/put 1 twice → counter=+1).
    const rec1 = makeMinimalQueuedWrite('rec1', 'n1')
    const rec2 = makeMinimalQueuedWrite('rec2', 'n2')
    await Promise.all([
      __recordTerminalForTest(rec1, 'dead-letter', 'm1'),
      __recordTerminalForTest(rec2, 'dead-letter', 'm2'),
    ])

    const ledger = await __dumpTerminalsForTest()
    expect(ledger.filter((e) => e.status === 'dead-letter').length).toBe(2)
    const after = await getWriteQueueTerminalCounters()
    expect(after.counters['dead-letter'] - baselineDeadLetter).toBe(2)
  })

  it('③ 7 terminals with cap=5 → ledger caps at 5 (evicted=2) but cumulative counter stays 7 (non-retreatable)', async () => {
    __setMaxTerminalsForTest(5)
    const { fn } = seqExecutor([{ status: 'transient', message: 'http_503' }])
    const q = makeQueue(fn, { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000 })
    for (let i = 0; i < 7; i++) {
      await q.enqueue(minimalNode('c1', `n${i}`))
      await q.drain()
      tick(10_000)
      await q.drain()
    }
    // Atomic cap tx: delete + evicted increment in one tx → evicted=2, no partial state.
    const { counters } = await getWriteQueueTerminalCounters()
    expect(counters['dead-letter']).toBe(7) // cumulative, non-retreatable (evict does NOT decrement)
    expect(counters.evicted).toBe(2)
    const ledger = await __dumpTerminalsForTest()
    expect(ledger.length).toBeLessThanOrEqual(5) // snapshot capped
  })

  // ── P1-B (third-round): delta model — durable IDB total + local pending delta ──
  // sol 反例:round-2 的 mergeCounters(max) 不守恒——tab1 mem=3(IDB 失败)+ tab2 IDB=2 → max=3,
  // 真值 5 永久少计,矛盾于"A3 MUST-use 这些 counter 防假绿"。delta 模型:mem 只记 pending delta,
  // IDB 恢复时在原子 tx 内 idbCurrent + capturedPending + currentIncrement,commit 后扣 captured delta。

  it('④ (P1-B) IDB=2 + mem pending delta=3 → recover → 6 (delta model; NOT max=3 or 4)', async () => {
    __setMaxTerminalsForTest(256) // no cap — isolate the counter delta model
    // 2 successful recordTerminals → IDB counter = 2 (dead-letter), pending delta = 0.
    await __recordTerminalForTest(makeMinimalQueuedWrite('r1', 'n1'), 'dead-letter', 'm1')
    await __recordTerminalForTest(makeMinimalQueuedWrite('r2', 'n2'), 'dead-letter', 'm2')
    let idb = await __readIdbTerminalCountersForTest()
    expect(idb['dead-letter']).toBe(2)

    // 3 fault-aborted recordTerminals → pending delta = 3 (mem fallback), IDB stays 2.
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })
    await __recordTerminalForTest(makeMinimalQueuedWrite('r3', 'n3'), 'dead-letter', 'm3')
    await __recordTerminalForTest(makeMinimalQueuedWrite('r4', 'n4'), 'dead-letter', 'm4')
    await __recordTerminalForTest(makeMinimalQueuedWrite('r5', 'n5'), 'dead-letter', 'm5')
    __setTerminalFaultInjectorForTest(undefined)
    idb = await __readIdbTerminalCountersForTest()
    expect(idb['dead-letter']).toBe(2) // IDB unchanged (aborts rolled back)
    // read = idbCurrent(2) + pendingDelta(3) = 5 (delta model; max model would give max(2,3)=3).
    const before = await getWriteQueueTerminalCounters()
    expect(before.counters['dead-letter']).toBe(5)

    // Recovery: 1 successful recordTerminal → flushes pending delta into IDB.
    // next = idbCurrent(2) + capturedPending(3) + currentIncrement(1) = 6; pending delta → 0.
    await __recordTerminalForTest(makeMinimalQueuedWrite('r6', 'n6'), 'dead-letter', 'm6')
    const after = await getWriteQueueTerminalCounters()
    expect(after.counters['dead-letter']).toBe(6) // NOT 3 (max) or 4 — delta model is conservative
    idb = await __readIdbTerminalCountersForTest()
    expect(idb['dead-letter']).toBe(6) // durable IDB total now 6
  })

  // ── P2-C (third-round): cap tx fault injection (round-2 only injected the record tx) ──

  it('⑤ (P2-C) cap tx abort → ledger NOT deleted + evicted NOT incremented; clear fault → re-run lands both', async () => {
    __setMaxTerminalsForTest(3)
    // Seed 3 terminals (at cap, no eviction yet).
    await __recordTerminalForTest(makeMinimalQueuedWrite('c1', 'n1'), 'dead-letter', 'm1')
    await __recordTerminalForTest(makeMinimalQueuedWrite('c2', 'n2'), 'dead-letter', 'm2')
    await __recordTerminalForTest(makeMinimalQueuedWrite('c3', 'n3'), 'dead-letter', 'm3')
    expect((await __dumpIdbTerminalsForTest()).length).toBe(3)
    expect((await __readIdbTerminalCountersForTest()).evicted).toBe(0)

    // Inject: abort the cap tx (phase 'cap') AFTER deletes + counter put are scheduled.
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'cap') tx.abort()
    })
    // A 4th recordTerminal: entry+counter tx commits (4th entry), THEN enforceTerminalCap
    // runs → cap tx (4 > 3, excess=1, schedules delete + evicted++) → abort → rolls back.
    await __recordTerminalForTest(makeMinimalQueuedWrite('c4', 'n4'), 'dead-letter', 'm4')
    // Atomic rollback: ledger still has 4 (no delete), evicted still 0 (no increment).
    expect((await __dumpIdbTerminalsForTest()).length).toBe(4) // NOT deleted
    expect((await __readIdbTerminalCountersForTest()).evicted).toBe(0) // NOT incremented

    // Clear the fault → re-run cap (via another recordTerminal) → deletes + evicted land.
    __setTerminalFaultInjectorForTest(undefined)
    await __recordTerminalForTest(makeMinimalQueuedWrite('c5', 'n5'), 'dead-letter', 'm5')
    // Now 5 entries, cap=3 → evicted=2 (oldest 2 deleted), ledger caps at 3.
    expect((await __dumpIdbTerminalsForTest()).length).toBe(3)
    expect((await __readIdbTerminalCountersForTest()).evicted).toBe(2)
  })

  // ── P1-B (fourth-round): claim model — pending delta split into pending + inFlight ──
  // sol 反例:capture 发生在 IDB tx 排队之前 → 两并发 record capture 同一份 pending=3,各自 tx
  // 都加进 durable → 重复(durable=8,期望 5)。claim 模型:tx 开始时同步(JS 单线程原子)把
  // pendingDelta 移入 inFlightDelta;commit 清 claim;abort 退回;read = idbCurrent + pending + inFlight。

  it('⑥ (P1-B r4) pending=3 + two concurrent successful record → durable + read = 5 (NOT 8; no double-flush)', async () => {
    __setMaxTerminalsForTest(256) // no cap — isolate the claim-model concurrency
    // Seed pending=3 via 3 fault-aborted recordTerminals (each aborts → refund + bump → pending grows).
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })
    await __recordTerminalForTest(makeMinimalQueuedWrite('p1', 'p1'), 'dead-letter', 'm1')
    await __recordTerminalForTest(makeMinimalQueuedWrite('p2', 'p2'), 'dead-letter', 'm2')
    await __recordTerminalForTest(makeMinimalQueuedWrite('p3', 'p3'), 'dead-letter', 'm3')
    __setTerminalFaultInjectorForTest(undefined)
    // 3 aborts → pending delta = 3, IDB durable = 0.
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(0)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(3) // read = idbCurrent(0) + pending(3)

    // Two CONCURRENT successful recordTerminals. Without the claim model, both capture
    // pending=3 → each tx adds 3+1 → durable=8 (sol-verified bug). With the claim model:
    // tx1 claims pending(3) synchronously → tx2 claims pending(0) (only what's left).
    await Promise.all([
      __recordTerminalForTest(makeMinimalQueuedWrite('r1', 'r1'), 'dead-letter', 'm4'),
      __recordTerminalForTest(makeMinimalQueuedWrite('r2', 'r2'), 'dead-letter', 'm5'),
    ])
    // Durable = 3 (pending) + 2 (one increment per record) = 5. Order-independent: each tx
    // adds its OWN claim + increment, so IDB tx interleaving cannot inflate the total.
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(5) // NOT 8
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(5) // read = 5
  })

  it('⑦ (P1-B r4) two concurrent records with no pre-existing pending → durable + read = 2 (record+cap txs do not double-flush)', async () => {
    __setMaxTerminalsForTest(256) // no eviction — isolate record+cap counter concurrency
    // Two concurrent records (each runs a record tx THEN a cap tx). The 2 record txs + 2
    // cap txs interleave; the claim model ensures each claims only its own portion.
    await Promise.all([
      __recordTerminalForTest(makeMinimalQueuedWrite('a1', 'a1'), 'conflict', 'm1'),
      __recordTerminalForTest(makeMinimalQueuedWrite('a2', 'a2'), 'conflict', 'm2'),
    ])
    expect((await __readIdbTerminalCountersForTest()).conflict).toBe(2) // NOT inflated
    expect((await getWriteQueueTerminalCounters()).counters.conflict).toBe(2)
  })

  it("⑧ (P1-B r4) a new pending increment arriving AFTER a tx claim is NOT mis-subtracted by releaseClaim", async () => {
    __setMaxTerminalsForTest(256)
    // Seed pending=2 (2 fault-aborts).
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })
    await __recordTerminalForTest(makeMinimalQueuedWrite('q1', 'q1'), 'dead-letter', 'm1')
    await __recordTerminalForTest(makeMinimalQueuedWrite('q2', 'q2'), 'dead-letter', 'm2')
    // pending=2, IDB=0.
    // A successful record claims pending=2 → its releaseClaim will subtract ONLY 2.
    __setTerminalFaultInjectorForTest(undefined)
    await __recordTerminalForTest(makeMinimalQueuedWrite('s1', 's1'), 'dead-letter', 'm3')
    // IDB = 0 + 2 (claim) + 1 (increment) = 3; pending → 0 (releaseClaim subtracted 2).
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(3)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(3)
    // NOW a new pending increment arrives (a fault-abort) AFTER the success committed.
    // Its +1 goes to pending; the prior success's releaseClaim already ran (subtracted 2)
    // and must NOT touch this new +1.
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })
    await __recordTerminalForTest(makeMinimalQueuedWrite('a1', 'a1'), 'dead-letter', 'm4')
    __setTerminalFaultInjectorForTest(undefined)
    // IDB still 3; pending=1 (the abort's +1). read = 3 + 1 = 4 (the new delta preserved).
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(3)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(4)
  })

  it('⑨ (P1-B r4) an aborted tx refunds its claim → pending is restored (no lost delta)', async () => {
    __setMaxTerminalsForTest(256)
    // Seed pending=2 (2 fault-aborts).
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })
    await __recordTerminalForTest(makeMinimalQueuedWrite('r1', 'r1'), 'dead-letter', 'm1')
    await __recordTerminalForTest(makeMinimalQueuedWrite('r2', 'r2'), 'dead-letter', 'm2')
    // pending=2, IDB=0.
    // A 3rd fault-abort: claims pending=2 → aborts → refundClaim(2) + bump(1) → pending=3.
    // The claim is refunded (pending restored + the abort's own +1 added).
    await __recordTerminalForTest(makeMinimalQueuedWrite('r3', 'r3'), 'dead-letter', 'm3')
    __setTerminalFaultInjectorForTest(undefined)
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(0) // IDB unchanged (3 aborts)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(3) // pending=3 (refunded)
    // A subsequent success flushes ALL 3 pending into IDB (+1) → durable=4.
    await __recordTerminalForTest(makeMinimalQueuedWrite('ok', 'ok'), 'dead-letter', 'm4')
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(4) // 3 (refunded pending) + 1
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(4)
  })

  // ── Round-5 (P1-B r4 residual): after-claim / before-tx-complete barrier ──
  // sol 五审 residual: test ⑧ injects the new pending AFTER releaseClaim already ran, so a
  // "releaseClaim subtracts captured from pending" regression floors at 0 (pending was 0 by
  // then) and only the inFlight leak signals it. This group holds the FIRST tx mid-claim
  // (after claimPendingDelta, before the IDB tx queues) via an injectable barrier promise,
  // injects a new pending delta WHILE the claim is in flight, then releases the first tx +
  // starts a second. The second must claim ONLY the new delta (1); a wrong releaseClaim
  // would subtract the first claim's captured(3) from the live pending(1) → floor to 0 →
  // the second claims 0 → durable LOSES the injected delta (idb=5 not 6) AND read INFLATES
  // via the inFlight leak (8 not 6). Both the durable-loss and read-inflation assertions
  // go red under the wrong model (correctness-gate verified: see send_to_lead report).

  it('⑩ (P1-B r4) mid-flight pending injected after claim / before commit → second tx claims only the new delta (no loss, no dup)', async () => {
    __setMaxTerminalsForTest(256) // no eviction — isolate the claim-barrier concurrency
    // Seed pending=3 via 3 fault-aborted recordTerminals (each aborts → refund + bump →
    // pending grows by 1). Barrier hook is NOT installed yet → seeding claims do not block.
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'record') tx.abort()
    })
    await __recordTerminalForTest(makeMinimalQueuedWrite('p1', 'p1'), 'dead-letter', 'm1')
    await __recordTerminalForTest(makeMinimalQueuedWrite('p2', 'p2'), 'dead-letter', 'm2')
    await __recordTerminalForTest(makeMinimalQueuedWrite('p3', 'p3'), 'dead-letter', 'm3')
    __setTerminalFaultInjectorForTest(undefined)
    // 3 aborts → pending delta = 3, IDB durable = 0.
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(0)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(3) // read = idbCurrent(0) + pending(3)

    // Barrier hook: block the FIRST record-phase claim; log every record-phase claim so the
    // test can assert the two claims are exactly 3 and 1. Cap-phase claims (no eviction under
    // cap=256) are ignored. The first call awaits an injectable promise; later calls no-op.
    const recordClaims: TerminalCounterShape[] = []
    let resolveBarrier!: () => void
    const barrierPromise = new Promise<void>((resolve) => {
      resolveBarrier = resolve
    })
    let firstRecordClaim = true
    __setClaimBarrierHookForTest(async (phase, captured) => {
      if (phase !== 'record') return
      recordClaims.push({ ...captured })
      if (firstRecordClaim) {
        firstRecordClaim = false
        await barrierPromise // hold the first tx mid-claim (after-claim / before-tx)
      }
    })

    // Fire the FIRST successful recordTerminal (do not await). It claims pending=3
    // synchronously (captured={dl:3} → pending 3→0, inFlight 0→3), then hits the barrier and
    // parks — the IDB tx is NOT yet queued, the claim is in flight.
    const firstP = __recordTerminalForTest(
      makeMinimalQueuedWrite('r1', 'r1'),
      'dead-letter',
      'm4',
    )
    // The claim is synchronous → recordClaims already holds {dl:3}; read = 0 + 0 + 3 (inFlight).
    expect(recordClaims).toHaveLength(1)
    expect(recordClaims[0]?.['dead-letter']).toBe(3)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(3)

    // INJECT a new pending=1 WHILE the first tx is parked mid-claim (before its tx queues).
    // Simulates a concurrent tab's mem-fallback increment; does NOT itself fire a claim.
    __bumpPendingCountersForTest('dead-letter', 1)
    // read = idbCurrent(0) + pending(1) + inFlight(3) = 4.
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(4)

    // Release the first tx AND start the second. The second claims ONLY the new delta(1) —
    // the first's claim(3) already moved to inFlight, so pending held only the injected 1.
    resolveBarrier()
    const secondP = __recordTerminalForTest(
      makeMinimalQueuedWrite('r2', 'r2'),
      'dead-letter',
      'm5',
    )
    await Promise.all([firstP, secondP])

    // Two record-phase claims observed: first=3 (seeded pending), second=1 (injected delta).
    // A wrong releaseClaim (subtract from pending) would zero the live pending(1) before the
    // second claim → second claims 0, not 1.
    expect(recordClaims).toHaveLength(2)
    expect(recordClaims[0]?.['dead-letter']).toBe(3)
    expect(recordClaims[1]?.['dead-letter']).toBe(1)

    // Durable = 3 (first claim) + 1 (second claim) + 2 (each record's own increment) = 6.
    // A wrong releaseClaim → durable=5 (lost the injected delta) AND read=8 (inFlight leak).
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(6)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(6)
  })

  // ── Round-5 (P1-B r4 residual): cap tx claims a NON-zero pending delta ──
  // sol 五审 residual: tests ⑤/⑦ only exercise the cap tx when pending=0 (claim=0), so a
  // cap-commit that leaks the non-zero claim via a wrong releaseClaim, or a cap-abort that
  // fails to refund the non-zero claim, would not surface. ⑪ seeds a non-zero pending delta
  // + an over-cap ledger so the cap tx claims the pending delta and lands it in the SAME
  // atomic tx as the evicted increment (each exactly once); ⑫ aborts that cap tx and asserts
  // the non-zero claim refunds to pending, then a re-run lands each exactly once (no re-flush,
  // no loss).

  it('⑪ (P1-B r4) cap tx with non-zero pending → pending delta + evicted land in ONE atomic tx, each exactly once', async () => {
    __setMaxTerminalsForTest(256) // no eviction while seeding — build the over-cap ledger cleanly
    // Seed 5 dead-letter terminals → IDB dl=5, evicted=0, ledger=5.
    for (let i = 1; i <= 5; i++) {
      await __recordTerminalForTest(makeMinimalQueuedWrite(`k${i}`, `k${i}`), 'dead-letter', `m${i}`)
    }
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(5)
    expect((await __readIdbTerminalCountersForTest()).evicted).toBe(0)
    expect((await __dumpIdbTerminalsForTest()).length).toBe(5)

    // Pre-create a non-zero pending delta (2) WITHOUT going through claim/tx (simulates a
    // concurrent tab's mem-fallback increments not yet claimed into an IDB tx).
    __bumpPendingCountersForTest('dead-letter', 2)
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(7) // read = idb(5) + pending(2)

    // NOW drop the cap below the ledger size (5 > 3) so enforceTerminalCap evicts.
    __setMaxTerminalsForTest(3)
    // Cap tx: claim=2 (pending 2→0, inFlight 0→2); getAll → 5, excess=2, delete 2 oldest;
    // counter put = idbCurrent(5) + capturedPending(2) + evicted(+2) → dl=7, evicted=2.
    // Commit → releaseClaim(2): inFlight 2→0. BOTH the pending delta and the evicted
    // increment land in the SAME atomic tx, each exactly once.
    await __enforceTerminalCapForTest()

    const idb = await __readIdbTerminalCountersForTest()
    expect(idb['dead-letter']).toBe(7) // 5 (durable) + 2 (pending delta landed once)
    expect(idb.evicted).toBe(2) // excess=2, landed once
    expect((await __dumpIdbTerminalsForTest()).length).toBe(3) // ledger capped at 3
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(7) // read = 7 + 0 + 0
    expect((await getWriteQueueTerminalCounters()).counters.evicted).toBe(2)

    // Idempotency: a SECOND cap call (no new pending, ledger already at cap) is a no-op —
    // claim=0, getAll=3 <= 3 → no eviction → flushed=false → refund(0). Nothing re-flushes.
    await __enforceTerminalCapForTest()
    const idb2 = await __readIdbTerminalCountersForTest()
    expect(idb2['dead-letter']).toBe(7) // unchanged — pending delta did NOT land a second time
    expect(idb2.evicted).toBe(2) // unchanged — evicted did NOT increment a second time
  })

  it('⑫ (P1-B r4) cap tx abort with non-zero claim → refund to pending; subsequent success lands each exactly once (no loss, no dup)', async () => {
    __setMaxTerminalsForTest(256) // no eviction while seeding
    for (let i = 1; i <= 5; i++) {
      await __recordTerminalForTest(makeMinimalQueuedWrite(`a${i}`, `a${i}`), 'dead-letter', `m${i}`)
    }
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(5)
    // Pre-create a non-zero pending delta (2) + drop the cap below the ledger (5 > 3).
    __bumpPendingCountersForTest('dead-letter', 2)
    __setMaxTerminalsForTest(3)

    // Inject: abort the cap tx (phase 'cap') AFTER deletes + counter put are scheduled. The
    // cap claim(2) → inFlight; the tx aborts → atomic rollback (neither deletes nor the
    // counter put land) AND refundClaim(2) restores the pending delta.
    __setTerminalFaultInjectorForTest((phase, tx) => {
      if (phase === 'cap') tx.abort()
    })
    await __enforceTerminalCapForTest()
    // Atomic rollback: ledger still 5 (no delete), idb dl still 5 (counter put rolled back),
    // evicted still 0. BUT the non-zero claim(2) was refunded → pending restored to 2.
    expect((await __dumpIdbTerminalsForTest()).length).toBe(5) // NOT deleted
    expect((await __readIdbTerminalCountersForTest())['dead-letter']).toBe(5) // NOT incremented
    expect((await __readIdbTerminalCountersForTest()).evicted).toBe(0) // NOT incremented
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(7) // read = idb(5) + pending(2) refunded
    expect((await getWriteQueueTerminalCounters()).counters.evicted).toBe(0) // inFlight=0 (refunded)

    // Clear the fault → re-run cap. The refunded pending(2) is re-claimed and lands ONCE.
    __setTerminalFaultInjectorForTest(undefined)
    await __enforceTerminalCapForTest()
    // excess=2 (5 > 3) → delete 2 oldest + counter put = idbCurrent(5) + capturedPending(2) +
    // evicted(+2) → dl=7, evicted=2. The pending delta landed exactly once (NOT twice — the
    // abort rolled back the first attempt; only the success flushed it).
    const idb = await __readIdbTerminalCountersForTest()
    expect(idb['dead-letter']).toBe(7) // 5 + 2 (pending landed once, not twice)
    expect(idb.evicted).toBe(2) // landed once
    expect((await __dumpIdbTerminalsForTest()).length).toBe(3) // ledger capped at 3
    expect((await getWriteQueueTerminalCounters()).counters['dead-letter']).toBe(7) // read = 7 + 0 + 0
    expect((await getWriteQueueTerminalCounters()).counters.evicted).toBe(2)
  })
})

describe('F2: attach/detach resourceKey 含 canvasId(跨 canvas 不 coalesce)', () => {
  // Block 3 seam 加 canvasId 后,resourceKey = asset-attach:${assetId}:${canvasId}:${nodeId}。
  // 跨 canvas 同 asset/node 的两条 op 资源键不同 → 不合并,两条均 pending + drain。
  // 修前 key 漏 canvasId 会把两条合并成一条,前一条静默丢 → refcount 少 1 → 误 purge。
  const attachAssetOp = (canvasId: string, assetId: string, nodeId: string): WriteOp => ({ kind: 'attachAsset', canvasId, assetId, nodeId })

  it('跨 canvas 同 asset/node 两条 attachAsset → pendingCount=2,drain 两条均发', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }, { status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(attachAssetOp('canvas-a', 'asset-1', 'node-1'))
    await q.enqueue(attachAssetOp('canvas-b', 'asset-1', 'node-1'))
    expect(await q.pendingCount()).toBe(2)
    const r = await q.drain()
    expect(r.processed).toBe(2)
    expect(r.successes).toBe(2)
    expect(calls.length).toBe(2)
    // drain 顺序不保证(nextAttemptAt/createdAt tie 时 stable sort 可能乱),用 canvasId 集合比对。
    const canvasIds = calls.map((c) => (c.op as { canvasId: string }).canvasId).sort()
    expect(canvasIds).toEqual(['canvas-a', 'canvas-b'])
  })

  it('同 canvas 同 asset/node 两条 attachAsset → 资源键相同,coalesce 合并,pendingCount=1,drain 一条', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue(attachAssetOp('canvas-a', 'asset-1', 'node-1'))
    await q.enqueue(attachAssetOp('canvas-a', 'asset-1', 'node-1'))
    expect(await q.pendingCount()).toBe(1)
    await q.drain()
    expect(calls.length).toBe(1)
  })

  it('detach 同形:跨 canvas 不合并,两条均 drain', async () => {
    const { fn, calls } = seqExecutor([{ status: 'success' }, { status: 'success' }])
    const q = makeQueue(fn)
    await q.enqueue({ kind: 'detachAsset', canvasId: 'canvas-a', assetId: 'asset-1', nodeId: 'node-1' })
    await q.enqueue({ kind: 'detachAsset', canvasId: 'canvas-b', assetId: 'asset-1', nodeId: 'node-1' })
    expect(await q.pendingCount()).toBe(2)
    await q.drain()
    expect(calls.length).toBe(2)
  })
})

// ── D2/Greptile 线程3:pending-create/delete helper 按 userId 过滤(lead SC-I)──────────
// 验收:
//  SC-I: getPendingDeleteResourceIds / getPendingCreateResourceIds 都按 r.userId === getPersistUserId()
//        过滤 —— userA 的 pending 记录不影响 userB 的差集/摘除判定(共享 IDB store,无串号)。
describe('D2 helper userId scoping (lead SC-I) — getPending{Create,Delete}ResourceIds', () => {
  // 两用户各一条 pending-delete + pending-create(restore),共 4 条,共享同一 IDB store。
  const seedBothUsers = (): Promise<unknown> =>
    __seedWritesForTest([
      { id: 'a-del', idempotencyKey: 'k-a-del', userId: 'userA', op: { kind: 'deleteProject', projectId: 'pA' }, resourceKey: 'project:pA', createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' },
      { id: 'a-cre', idempotencyKey: 'k-a-cre', userId: 'userA', op: { kind: 'createProject', id: 'cA', name: 'CA' }, resourceKey: 'project:cA', createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' },
      { id: 'b-del', idempotencyKey: 'k-b-del', userId: 'userB', op: { kind: 'deleteProject', projectId: 'pB' }, resourceKey: 'project:pB', createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' },
      { id: 'b-cre', idempotencyKey: 'k-b-cre', userId: 'userB', op: { kind: 'createProject', id: 'cB', name: 'CB' }, resourceKey: 'project:cB', createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' },
    ])

  it('SC-I: userA 视角只读 userA 的 pending-delete/create(userB 记录不串号)', async () => {
    await seedBothUsers()
    setPersistUserId('userA')
    expect([...(await getPendingDeleteResourceIds('deleteProject'))]).toEqual(['pA'])
    expect([...(await getPendingCreateResourceIds('createProject'))]).toEqual(['cA'])
    // userB 的 pB/cB 不在 userA 视角(无过滤则会串号:返回 [pA,pB]/[cA,cB])
    expect([...(await getPendingDeleteResourceIds('deleteProject'))]).not.toContain('pB')
    expect([...(await getPendingCreateResourceIds('createProject'))]).not.toContain('cB')
  })

  it('SC-I: 切到 userB 视角只读 userB 的(隔离独立;不互相污染)', async () => {
    await seedBothUsers()
    setPersistUserId('userB')
    expect([...(await getPendingDeleteResourceIds('deleteProject'))]).toEqual(['pB'])
    expect([...(await getPendingCreateResourceIds('createProject'))]).toEqual(['cB'])
    // 换 user 后 userA 的记录不再可见
    expect([...(await getPendingDeleteResourceIds('deleteProject'))]).not.toContain('pA')
    expect([...(await getPendingCreateResourceIds('createProject'))]).not.toContain('cA')
  })

  it('SC-I: deleteCanvas/createCanvas 同款 userId 过滤(非 project 变体也隔离)', async () => {
    await __seedWritesForTest([
      { id: 'a-cdel', idempotencyKey: 'k-a-cdel', userId: 'userA', op: { kind: 'deleteCanvas', canvasId: 'cvA' }, resourceKey: 'canvas:cvA', createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' },
      { id: 'b-ccre', idempotencyKey: 'k-b-ccre', userId: 'userB', op: { kind: 'createCanvas', canvasId: 'cvB', projectId: 'pB', title: 'CVB' }, resourceKey: 'canvas:cvB', createdAt: 0, attempts: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' },
    ])
    setPersistUserId('userA')
    expect([...(await getPendingDeleteResourceIds('deleteCanvas'))]).toEqual(['cvA'])
    // userB 的 createCanvas(cvB) 不在 userA 的 createCanvas 视角
    expect([...(await getPendingCreateResourceIds('createCanvas'))]).toEqual([])
    setPersistUserId('userB')
    expect([...(await getPendingCreateResourceIds('createCanvas'))]).toEqual(['cvB'])
    // userA 的 deleteCanvas(cvA) 不在 userB 的 deleteCanvas 视角
    expect([...(await getPendingDeleteResourceIds('deleteCanvas'))]).toEqual([])
  })
})

// ── F2 (T2.2 Block 2 review):持久 seq 作 drain 第三排序键,防 reload 逆序留 stale asset ref ──
// 审官复现:attach/detach 不同 resourceKey(asset-attach: vs asset-detach:,见 computeResourceKey)→ 跨 key 并发;
// 同毫秒 drain 排序 createdAt 相同后靠 IDB getAll 隐式序(store keyPath='id'=UUID,reload 后 getAll 按 UUID 主键
// 随机序)→ "先 attach B 后 detach B" 执行成 [detach,attach] → B ref 永久残留。修法:QueuedWrite.seq 持久单调
// (入队时 max(已存 seq)+1),drain 排序第三键,替代隐式 getAll 序。旧 record 缺 seq → ?? 0(fail-safe,不 NaN)。
describe('F2 (T2.2 Block 2 review) — seq 防逆序 stale asset ref', () => {
  const attachBOp: WriteOp = { kind: 'attachAsset', canvasId: 'c1', assetId: 'B', nodeId: 'n1' }
  const detachBOp: WriteOp = { kind: 'detachAsset', canvasId: 'c1', assetId: 'B', nodeId: 'n1' }
  const detachAOp: WriteOp = { kind: 'detachAsset', canvasId: 'c1', assetId: 'A', nodeId: 'n1' }

  // asset resourceKey(与生产 computeResourceKey 对齐,seed 用;sort 不依赖 resourceKey,但保持真实形态)
  const assetResourceKey = (op: WriteOp): string => {
    if (op.kind === 'attachAsset') return `asset-attach:${op.assetId}:${op.canvasId}:${op.nodeId}`
    if (op.kind === 'detachAsset') return `asset-detach:${op.assetId}:${op.canvasId}:${op.nodeId}`
    return `unknown:${op.kind}`
  }

  // 受控 seed:id 逆序于 seq(zzz*=seq1 但 id 排后,aaa*=seq2 但 id 排前)→ getAll 按 id 主键返回逆序 enqueue,
  // 模拟 reload 后 IDB getAll 随机序。无 seq 会稳定排序保留此逆序 → [detach,attach] 留 stale;有 seq 修正。
  const seedAssetRecord = (id: string, op: WriteOp, seq: number): QueuedWrite => ({
    id,
    idempotencyKey: `mivo-${id}`,
    userId: 'userA',
    op,
    resourceKey: assetResourceKey(op),
    createdAt: 1_000,
    attempts: 0,
    nextAttemptAt: 1_000,
    status: 'pending',
    seq,
  })

  // executor:记录调用序 + 维护 assetId refcount(attach +1 / detach -1);attach-then-detach → net 0(无 stale)
  const refTrackingExecutor = () => {
    const calls: WriteOp[] = []
    const refs = new Map<string, number>()
    const fn = vi.fn(async (op: WriteOp): Promise<WriteOutcome> => {
      calls.push(op)
      if (op.kind === 'attachAsset') refs.set(op.assetId, (refs.get(op.assetId) ?? 0) + 1)
      else if (op.kind === 'detachAsset') refs.set(op.assetId, (refs.get(op.assetId) ?? 0) - 1)
      return { status: 'success' }
    })
    return { fn, calls, refs }
  }

  // F2-1:attach B→detach B(id 逆序,同毫秒,seq 1/2)→ executor 按 [attach, detach] 序;B refcount=0(无 stale)
  it('F2-1 attach B→detach B(reverse-id, same-ms):seq 使 executor 按 [attach, detach] 序;B refcount=0(逆序则 =1 stale)', async () => {
    const exec = refTrackingExecutor()
    await __seedWritesForTest([
      seedAssetRecord('zzz-attach', attachBOp, 1), // id 'zzz' 排后,但 seq=1 应先
      seedAssetRecord('aaa-detach', detachBOp, 2), // id 'aaa' 排前(getAll 先返),但 seq=2 应后
    ])
    const q = makeQueue(exec.fn)
    const r = await q.drain()
    expect(r.processed).toBe(2)
    expect(exec.calls.map((o) => o.kind)).toEqual(['attachAsset', 'detachAsset'])
    expect(exec.refs.get('B') ?? 0).toBe(0) // attach 后 detach → net 0;逆序 [detach,attach] 则 B=1 stale
  })

  // F2-2:detach A→attach B(id 逆序,同毫秒,seq 1/2)→ executor 按 [detach A, attach B] 序
  it('F2-2 detach A→attach B(reverse-id, same-ms):seq 使 executor 按 [detach A, attach B] 序', async () => {
    const exec = refTrackingExecutor()
    await __seedWritesForTest([
      seedAssetRecord('zzz-detachA', detachAOp, 1),
      seedAssetRecord('aaa-attachB', attachBOp, 2),
    ])
    const q = makeQueue(exec.fn)
    await q.drain()
    expect(exec.calls.map((o) => o.kind)).toEqual(['detachAsset', 'attachAsset'])
  })

  // F2-3:reload — real enqueue attach B→detach B(同毫秒,doEnqueue 戳 seq 1/2)→ 新 queue 读同 IDB drain 仍 [attach, detach]
  it('F2-3 reload:real enqueue attach B→detach B(同 ms)→ 新 queue drain 仍 [attach, detach] + B refcount=0', async () => {
    const exec1 = refTrackingExecutor()
    const q1 = makeQueue(exec1.fn)
    await q1.enqueue(attachBOp) // doEnqueue 戳 seq=1(空 IDB → max 0 +1)
    await q1.enqueue(detachBOp) // doEnqueue 戳 seq=2(getAll 见 attach seq1 → +1);不同 resourceKey 不 coalesce
    expect(exec1.calls).toHaveLength(0) // q1 inert 未 drain
    // reload = 新 queue 读同 IDB(q1 未 drain,记录持久化)
    const exec2 = refTrackingExecutor()
    const q2 = makeQueue(exec2.fn)
    const r = await q2.drain()
    expect(r.processed).toBe(2)
    expect(exec2.calls.map((o) => o.kind)).toEqual(['attachAsset', 'detachAsset'])
    expect(exec2.refs.get('B') ?? 0).toBe(0)
  })

  // F2-4 migration:旧 record 无 seq(undefined)+ 新 seq record,id 逆序,同毫秒 → 旧(??0=0)先于新,不 NaN 排序
  it('F2-4 migration:旧 record 无 seq + 新 seq record(reverse-id, same-ms)→ ??0 兜底,旧先于新,不 NaN', async () => {
    const exec = refTrackingExecutor()
    const legacyRecord: QueuedWrite = {
      id: 'zzz-legacy', // id 排后,但无 seq(??0=0)应先
      idempotencyKey: 'mivo-legacy',
      userId: 'userA',
      op: attachBOp,
      resourceKey: assetResourceKey(attachBOp),
      createdAt: 1_000,
      attempts: 0,
      nextAttemptAt: 1_000,
      status: 'pending',
      // 故意无 seq 字段(模拟旧 IDB 记录,migration-on-read)
    }
    const newRecord = seedAssetRecord('aaa-new', detachBOp, 5) // id 排前(getAll 先返),seq=5 应后
    await __seedWritesForTest([legacyRecord, newRecord])
    const q = makeQueue(exec.fn)
    await q.drain()
    // 旧(seq ??0=0)先于新(seq=5);attach B 先 detach B 后 → B refcount=0;无 NaN 排序
    expect(exec.calls.map((o) => o.kind)).toEqual(['attachAsset', 'detachAsset'])
    expect(exec.refs.get('B') ?? 0).toBe(0)
  })

  // F2-bis(T2.2 Block 2 三轮复审):seq 全局原子分配(IDB META counter 同事务 increment+put,runMultiStoreTx)。
  // 审官复现:F2 的 max+1 读非锁定快照,Promise.all 跨 key 并发 enqueue 派生重复 seq(seq=1/1)→ 逆序执行。
  // nextSeq 的 readwrite tx 序列化(META_STORE)→ 并发 enqueue 得唯一严格递增 seq(per-resourceKey coalesce 不动)。
  // reload 后按意图序由 F2-3 顺序 enqueue 覆盖;逆序由 F2-1 reverse-id 覆盖;"移除 seq 排序即失败"反证 = F2-1。
  it('F2-bis Promise.all 跨 key 并发 enqueue(同毫秒)→ seq 全异严格递增(原子 nextSeq,无 max+1 的 1/1 重复)', async () => {
    const exec = refTrackingExecutor()
    const q = makeQueue(exec.fn)
    // 3 跨 key(不同 assetId → asset-attach:A/B/C 不同 resourceKey)同毫秒并发 enqueue
    await Promise.all([
      q.enqueue({ kind: 'attachAsset', canvasId: 'c1', assetId: 'A', nodeId: 'n1' }),
      q.enqueue({ kind: 'attachAsset', canvasId: 'c1', assetId: 'B', nodeId: 'n1' }),
      q.enqueue({ kind: 'attachAsset', canvasId: 'c1', assetId: 'C', nodeId: 'n1' }),
    ])
    const all = await __dumpWritesForTest()
    const seqs = all.map((r) => r.seq ?? 0).sort((a, b) => a - b)
    expect(seqs).toHaveLength(3)
    expect(new Set(seqs).size).toBe(3) // 全异(原子 nextSeq;max+1 会给 1/1/1 重复)
    expect(seqs[1]! > seqs[0]!).toBe(true) // 严格递增
    expect(seqs[2]! > seqs[1]!).toBe(true)
  })

  // F3-ter(T2.2 Block 2 五轮):seq 降级高水位对齐——IDB tx 故障期 fallback seq 仍 > 进程内已分配 durable seq,
  //   防 fallback 回退到 < durable → 与 durable 撞号/逆序 → [detach,attach] 误排 → B ref 永久残留。
  //   审官复现:durable seq=1,2(IDB 成功)→ META tx 注错 → 旧 fallback 给 seqMemCounter++=1 < 2(旧 seqMemCounter
  //   不在 IDB 成功时 bump)→ 与 seq=1 撞号且逆序。F3-ter:seqHighWater 在 IDB 成功时同步 bump(=2),fallback
  //   取 seqHighWater+1=3 > 2;IDB 恢复后首次成功 reconciliation:max(cur+1, seqHighWater+1) 防 stale cur 撞号。
  //   stubIdbTxThrows 在 IDB-failure describe 内(本 describe 不可见),故 inline 同形 tx-throwing stub。
  it('F3-ter durable seq=1,2 → IDB tx 注错 → fallback seq=seqHighWater+1=3(>2 不撞号)→ 恢复 reconciliation seq=4(>3)', async () => {
    const stubIdbTxThrowsLocal = () => {
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        transaction: () => { throw new Error('idb tx boom') },
        close: () => {},
      }
      vi.stubGlobal('indexedDB', {
        open: () => {
          const req: { onupgradeneeded: ((e: { target: unknown }) => void) | null; onsuccess: ((e: { target: unknown }) => void) | null; onerror: ((e: { target: unknown }) => void) | null; result: unknown } = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined }
          queueMicrotask(() => { req.result = fakeDb; req.onsuccess?.({ target: req }) })
          return req
        },
      })
    }
    const exec = refTrackingExecutor()
    const q = makeQueue(exec.fn)
    // ① 两次 enqueue(IDB 正常)→ durable seq=1,2;seqHighWater 同步 bump 到 2(旧 seqMemCounter 不 bump)
    await q.enqueue(attachBOp)
    await q.enqueue(detachBOp)
    const durable = (await __dumpWritesForTest()).map((r) => r.seq ?? 0).sort((a, b) => a - b)
    expect(durable).toEqual([1, 2])
    // ② 注错 IDB tx + drop dbPromise(__setWriteQueueDbNameForTest 只 drop dbPromise,不清 store、不重置 seqHighWater=2)
    stubIdbTxThrowsLocal()
    __setWriteQueueDbNameForTest('f3ter-fault')
    // ③ 新 enqueue → nextSeq IDB tx throws → fallback seq=seqHighWater+1=3(旧代码给 1 < 2,撞号逆序)
    await q.enqueue(attachBOp)
    const faultSeqs = (await __dumpWritesForTest()).map((r) => r.seq ?? 0)
    expect(faultSeqs).toContain(3) // fallback seq=3
    expect(Math.max(...faultSeqs)).toBe(3) // > durable 2(seqHighWater+1,不撞号逆序)
    // ④ 恢复:unstub indexedDB + 切新空 DB(cur=0)→ 下次 nextSeq reconciliation:max(cur+1=1, seqHighWater+1=4)=4 > fallback 3
    vi.unstubAllGlobals()
    __setWriteQueueDbNameForTest('f3ter-recover')
    await q.enqueue(detachBOp)
    const recoverSeqs = (await __dumpWritesForTest()).map((r) => r.seq ?? 0).sort((a, b) => a - b)
    expect(recoverSeqs).toContain(4) // recovery seq=4(reconciliation 防 stale cur 撞号)
    expect(Math.max(...recoverSeqs)).toBe(4) // > fallback 3
  })
})

// ── P3 (2026-07-16 demo-seed-migration-skip):migration-on-boot op terminal 日志降 WARN + 不弹 toast;
//    真实用户写保持 ERROR 不变;既有 migration record drain terminal 后出队清空(最多再刷一轮) ──
describe('P3 (demo-seed-migration-skip) — migration op terminal 降 WARN + 既有队列自清', () => {
  it('migration createProject drain 404 rejected → warn 带 [migration] 标识 + 不弹 toast + terminal 出队;非 migration 同场景 → error + toast(行为不变)', async () => {
    // migration record(flushServerMigration 经 enqueuePersistWrite(op, {migration:true}) 入队)
    const execMig = vi.fn(async (): Promise<WriteOutcome> => ({
      status: 'rejected',
      body: { error: 'unknown-project' },
    }))
    const qMig = makeQueue(execMig)
    await qMig.enqueue({ kind: 'createProject', name: 'P', id: 'p1' }, { migration: true })
    expect((await __dumpWritesForTest())).toHaveLength(1)
    const r = await qMig.drain()
    expect(r.terminals).toBe(1)
    // migration → termLog 走 warn([migration] 标识),不 error,不 toast
    expect(warnLog).toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('[migration]'))
    expect(warnLog).toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('rejected by server'))
    expect(errorLog).not.toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('rejected by server'))
    expect(toastError).not.toHaveBeenCalled()
    // 出队行为不变:terminal reject → recordTerminal + deleteWrite → 队列空
    expect((await __dumpWritesForTest())).toHaveLength(0)

    // 对照:非 migration(用户 mutation)同 op 同 404 → error + toast(行为不变)
    const execUser = vi.fn(async (): Promise<WriteOutcome> => ({ status: 'rejected', body: { error: 'unknown-project' } }))
    const qUser = makeQueue(execUser)
    await qUser.enqueue({ kind: 'createProject', name: 'P', id: 'p2' }) // 不带 migration
    const r2 = await qUser.drain()
    expect(r2.terminals).toBe(1)
    expect(errorLog).toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('rejected by server'))
    expect(toastError).toHaveBeenCalled()
  })

  it('既有 migration record drain terminal 后出队清空(P1 停重收集来源后不再新增 → 最多再刷一轮)', async () => {
    // 模拟上次 boot 排入、尚未 drain 的 migration createProject record(若上次崩在 drain 前)。
    // P1 后 flushServerMigration 不再 enqueue demo op → 此类存量记录 drain 一次即清,不再新增。
    const exec = vi.fn(async (): Promise<WriteOutcome> => ({ status: 'rejected', body: { error: 'project-exists' } }))
    const q = makeQueue(exec)
    await __seedWritesForTest([{
      id: 'pending-migration-demo',
      idempotencyKey: 'k-demo',
      userId: 'userA',
      op: { kind: 'createProject', name: 'Concept Battlepass', id: 'project-demo-concept-battlepass' },
      resourceKey: 'project:project-demo-concept-battlepass',
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 1000,
      status: 'pending',
      migration: true,
    }])
    expect((await __dumpWritesForTest())).toHaveLength(1)
    const r = await q.drain()
    expect(r.terminals).toBe(1)
    // terminal reject → deleteWrite 出队 → 队列清空(下次 boot P1 不再重收集 demo → 不再入队)
    expect((await __dumpWritesForTest())).toHaveLength(0)
    // migration → warn 不 error(降噪生效)
    expect(errorLog).not.toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('rejected by server'))
    expect(warnLog).toHaveBeenCalledWith('Write Retry Queue', expect.stringContaining('[migration]'))
  })
})
