import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  acquireDecodePermit,
  resetDecodeGate,
  decodeGateStats,
  DecodeBusyError,
  type DecodePermit,
} from './decodeGate'

// A controllable latch for deterministic gate timing — no setTimeout flakes. Holders
// await `promise` until the test calls `resolve()`.
const latch = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const setEnv = (concurrency: number, queueCap: number): void => {
  process.env.MIVO_ASSET_DECODE_CONCURRENCY = String(concurrency)
  process.env.MIVO_ASSET_DECODE_QUEUE_CAP = String(queueCap)
}

describe('decodeGate — global sharp decode concurrency (P1)', () => {
  let savedConcurrency: string | undefined
  let savedQueueCap: string | undefined

  beforeEach(() => {
    savedConcurrency = process.env.MIVO_ASSET_DECODE_CONCURRENCY
    savedQueueCap = process.env.MIVO_ASSET_DECODE_QUEUE_CAP
    resetDecodeGate()
  })

  afterEach(() => {
    resetDecodeGate()
    if (savedConcurrency === undefined) delete process.env.MIVO_ASSET_DECODE_CONCURRENCY
    else process.env.MIVO_ASSET_DECODE_CONCURRENCY = savedConcurrency
    if (savedQueueCap === undefined) delete process.env.MIVO_ASSET_DECODE_QUEUE_CAP
    else process.env.MIVO_ASSET_DECODE_QUEUE_CAP = savedQueueCap
  })

  it('acquires up to `concurrency` permits concurrently (defaults: 2 / queue 8)', async () => {
    delete process.env.MIVO_ASSET_DECODE_CONCURRENCY
    delete process.env.MIVO_ASSET_DECODE_QUEUE_CAP
    expect(decodeGateStats().concurrency).toBe(2)
    expect(decodeGateStats().queueCap).toBe(8)
    const a = await acquireDecodePermit()
    const b = await acquireDecodePermit()
    expect(decodeGateStats().active).toBe(2)
    expect(decodeGateStats().waiting).toBe(0)
    a.release()
    b.release()
    expect(decodeGateStats().active).toBe(0)
  })

  it('an acquire beyond concurrency queues; release hands the permit off FIFO (active stays)', async () => {
    setEnv(2, 8)
    const a = await acquireDecodePermit() // active=1
    const b = await acquireDecodePermit() // active=2
    expect(decodeGateStats().active).toBe(2)
    // 3rd acquire: active == concurrency → queues (not rejected)
    const third = acquireDecodePermit()
    expect(decodeGateStats().waiting).toBe(1)
    expect(decodeGateStats().active).toBe(2) // third has NOT acquired
    // release a → handoff: third resolves, active unchanged (2), waiting → 0
    a.release()
    const c: DecodePermit = await third
    expect(decodeGateStats().active).toBe(2)
    expect(decodeGateStats().waiting).toBe(0)
    b.release()
    c.release()
    expect(decodeGateStats().active).toBe(0)
  })

  it('over the queue cap → throws DecodeBusyError immediately (the 429 path), without enqueueing', async () => {
    setEnv(1, 2) // 1 permit, room for 2 waiters
    const a = await acquireDecodePermit() // active=1 (full)
    const w1 = acquireDecodePermit() // queued (waiting=1)
    const w2 = acquireDecodePermit() // queued (waiting=2, cap reached)
    expect(decodeGateStats().waiting).toBe(2)
    // 3rd waiter → over cap → DecodeBusyError (NOT enqueued)
    await expect(acquireDecodePermit()).rejects.toBeInstanceOf(DecodeBusyError)
    expect(decodeGateStats().waiting).toBe(2) // rejected one did not enqueue
    // drain the queue so no permit leaks across tests
    a.release()
    const p1 = await w1
    p1.release()
    const p2 = await w2
    p2.release()
    expect(decodeGateStats().active).toBe(0)
    expect(decodeGateStats().waiting).toBe(0)
  })

  it('permit.release() is idempotent — a double release never leaks a 2nd permit', async () => {
    setEnv(2, 8)
    const a = await acquireDecodePermit()
    a.release()
    a.release() // must NOT decrement active again
    a.release()
    expect(decodeGateStats().active).toBe(0)
    const b = await acquireDecodePermit()
    expect(decodeGateStats().active).toBe(1)
    b.release()
  })

  it('queueCap=0 → any overflow rejects immediately (no queueing at all)', async () => {
    setEnv(1, 0)
    const a = await acquireDecodePermit()
    await expect(acquireDecodePermit()).rejects.toBeInstanceOf(DecodeBusyError)
    expect(decodeGateStats().waiting).toBe(0)
    a.release()
  })

  it('parallel acquires never exceed `concurrency` held — RSS does not scale with N (OOM guard)', async () => {
    // The core guard: at most `concurrency` permits are held simultaneously, so the
    // concurrent sharp-decode buffers (and thus process RSS) are bounded by
    // `concurrency`, NOT by the number of in-flight requests.
    setEnv(2, 64)
    let held = 0
    let maxHeld = 0
    const block = latch() // every holder parks here until the test releases it
    const workers = Array.from({ length: 16 }, async () => {
      const permit = await acquireDecodePermit()
      held++
      maxHeld = Math.max(maxHeld, held)
      try {
        await block.promise
      } finally {
        held--
        permit.release()
      }
    })
    // Let microtasks drain so 2 holders reach `block` and the other 14 queue.
    await new Promise((r) => setTimeout(r, 20))
    expect(maxHeld).toBe(2) // never more than `concurrency` simultaneously held
    expect(decodeGateStats().active).toBe(2)
    expect(decodeGateStats().waiting).toBe(14)
    block.resolve()
    await Promise.all(workers)
    expect(maxHeld).toBe(2) // invariant held across the whole drain
    expect(decodeGateStats().active).toBe(0)
    expect(decodeGateStats().waiting).toBe(0)
  })
})
