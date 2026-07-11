import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __dumpWritesForTest,
  __resetWriteQueueDb,
  classifyHttpStatus,
  createWriteQueue,
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
