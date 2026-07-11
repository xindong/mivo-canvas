// server/lib/decodeGate.ts
// P1: global sharp decode concurrency gate. Bounds the number of concurrent image
// decodes in the BFF process to protect against OOM under a flood of large-image
// uploads. A sharp decode expands a small compressed upload to a huge uncompressed
// buffer (a 144M-pixel image is ~430 MB of RGB); N concurrent decodes can exhaust
// process RSS. A permit is acquired in the POST handler BEFORE the request body is
// read and released in finally — so the whole body-read + decode pipeline is bounded.
//
// A bounded wait queue rejects overflow immediately with 429 (Retry-After) — a slow
// decode can't pile up an unbounded queue of request bodies each holding memory. Env-
// tunable: MIVO_ASSET_DECODE_CONCURRENCY (default 2), MIVO_ASSET_DECODE_QUEUE_CAP
// (default 8). The gate is process-global (one BFF = one gate); tests reset it between
// cases via resetDecodeGate.

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// Like num() but 0 is a valid value (queueCap=0 means fail-fast: no queueing, overflow
// rejects immediately). Negative / non-numeric still falls back.
const numAllowZero = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** Max concurrent sharp decodes (permits). Default 2; env MIVO_ASSET_DECODE_CONCURRENCY. */
export const decodeConcurrency = (): number => Math.max(1, num(process.env.MIVO_ASSET_DECODE_CONCURRENCY, 2))

/** Max requests waiting for a permit. Over cap → 429 immediately. Default 8; 0 = fail-fast. */
export const decodeQueueCap = (): number => Math.max(0, numAllowZero(process.env.MIVO_ASSET_DECODE_QUEUE_CAP, 8))

/**
 * Thrown when the wait queue is full — the caller is over capacity and should shed load
 * with 429 (Retry-After) rather than queueing another body. NOT a decode failure.
 */
export class DecodeBusyError extends Error {
  constructor() {
    super('asset decode concurrency limit reached')
    this.name = 'DecodeBusyError'
  }
}

/** A held decode permit. release() returns it to the pool (idempotent). */
export type DecodePermit = { release: () => void }

// Module-global gate state. active = permits currently held; waiters = pending
// acquire() calls in FIFO order. acquire is synchronous up to the point a permit is
// unavailable (the active check + increment, or the waiters.push), so two concurrent
// acquire() calls cannot both observe the same `active < concurrency` window.
let active = 0
type Waiter = { resolve: (p: DecodePermit) => void; reject: (e: Error) => void }
const waiters: Waiter[] = []

const makePermit = (): DecodePermit => {
  let released = false
  return {
    release: () => {
      if (released) return // idempotent — a double release can't leak two permits
      released = true
      releaseDecodePermit()
    },
  }
}

// Release one permit: if a waiter exists, hand the permit directly to it (active stays
// — one out, one in); else decrement active. Handoff (not re-acquire) preserves FIFO
// fairness and keeps `active` an accurate count of held permits.
const releaseDecodePermit = (): void => {
  const next = waiters.shift()
  if (next) {
    next.resolve(makePermit())
  } else {
    active--
  }
}

/**
 * Acquire a decode permit before reading the request body. Resolves once a permit is
 * held; rejects with DecodeBusyError immediately if the wait queue is full (load shed
 * → 429). The caller MUST release() in finally.
 */
export const acquireDecodePermit = async (): Promise<DecodePermit> => {
  if (active < decodeConcurrency()) {
    active++
    return makePermit()
  }
  if (waiters.length >= decodeQueueCap()) {
    throw new DecodeBusyError()
  }
  return new Promise<DecodePermit>((resolve, reject) => {
    waiters.push({ resolve, reject })
  })
}

/** Test/diagnostic: current gate occupancy (not for production decisions). */
export const decodeGateStats = (): { active: number; waiting: number; concurrency: number; queueCap: number } => ({
  active,
  waiting: waiters.length,
  concurrency: decodeConcurrency(),
  queueCap: decodeQueueCap(),
})

/**
 * Test-only: reset the module-global gate to a clean state. Pending waiters are
 * rejected with DecodeBusyError so their awaited promises settle (no test hangs on a
 * permit that will never come). Never call from production code.
 */
export const resetDecodeGate = (): void => {
  active = 0
  const drained = waiters.splice(0, waiters.length)
  for (const w of drained) {
    w.reject(new DecodeBusyError())
  }
}
