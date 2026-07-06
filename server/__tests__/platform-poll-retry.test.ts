// @vitest-environment node
// server/__tests__/platform-poll-retry.test.ts
// V03: poll-loop transient-5xx retry. Mocks mivoPlatformFetch directly (no live
// HTTP) because the shared mockUpstream fixture has no 5xx-poll mode and extending
// it is out of this fix's scope (server/routes + shared helpers are locked by the
// __captures__ dev-middleware diff=0 contract). These unit tests exercise the
// poll loop's streak logic in isolation.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mivoPlatformPollJob } from '../platform/job'
import type { PlatformCtx } from '../lib/config'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))

vi.mock('../platform/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/state')>()
  return { ...actual, mivoPlatformFetch: mockFetch }
})

const fakeCtx = { platformEndpoint: 'http://mock', platformKey: 'k' } as unknown as PlatformCtx
const DEADLINE_MS = 5_000

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('mivoPlatformPollJob transient 5xx retry (V03)', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    process.env.MIVO_PLATFORM_POLL_INTERVAL_MS = '10'
    process.env.MIVO_PLATFORM_POLL_DEADLINE_MS = String(DEADLINE_MS)
  })

  it('recovers after 2 consecutive 5xx then completes', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonRes({ content: { status: 'completed', images: ['/img'] } }))

    const result = await mivoPlatformPollJob(fakeCtx, 'job-1', undefined, undefined, DEADLINE_MS)
    expect(result.status).toBe('completed')
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('throws after 3 consecutive 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))

    await expect(mivoPlatformPollJob(fakeCtx, 'job-1', undefined, undefined, DEADLINE_MS)).rejects.toThrow(
      /platform poll 503/,
    )
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('4xx is permanent — throws immediately, no retry', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(mivoPlatformPollJob(fakeCtx, 'job-1', undefined, undefined, DEADLINE_MS)).rejects.toThrow(
      /platform poll 404/,
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('a fetch reject (e.g. V05 per-request timeout) counts as one transient failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Image API request timed out'))
      .mockResolvedValueOnce(jsonRes({ content: { status: 'completed', images: ['/img'] } }))

    const result = await mivoPlatformPollJob(fakeCtx, 'job-1', undefined, undefined, DEADLINE_MS)
    expect(result.status).toBe('completed')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('aborts immediately when the signal is already aborted (no fetch)', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await mivoPlatformPollJob(fakeCtx, 'job-1', ac.signal, undefined, DEADLINE_MS)
    expect(result.status).toBe('aborted')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('a 2xx after failures resets the streak — 2×5xx, 2xx-pending, 5xx, then success', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 })) // cf=1
      .mockResolvedValueOnce(new Response(null, { status: 503 })) // cf=2
      .mockResolvedValueOnce(jsonRes({ content: { status: 'pending' } })) // 2xx → reset cf=0
      .mockResolvedValueOnce(new Response(null, { status: 503 })) // cf=1 again (not 3)
      .mockResolvedValueOnce(jsonRes({ content: { status: 'completed', images: ['/img'] } }))

    const result = await mivoPlatformPollJob(fakeCtx, 'job-1', undefined, undefined, DEADLINE_MS)
    expect(result.status).toBe('completed')
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  it('V-20: a pending poll resolves abort within one tick (not the full interval)', async () => {
    // Long interval so a bare setTimeout would block long enough to distinguish
    // "abort-aware" from "not abort-aware". The old pending-path wait was a plain
    // setTimeout(platformPollIntervalMs) — under the old code this test would time
    // out near 2000ms; under V-20 it resolves on abort within a tick.
    process.env.MIVO_PLATFORM_POLL_INTERVAL_MS = '2000'
    mockFetch.mockResolvedValueOnce(jsonRes({ content: { status: 'pending' } }))

    const ac = new AbortController()
    const t0 = Date.now()
    const promise = mivoPlatformPollJob(fakeCtx, 'job-1', ac.signal, undefined, DEADLINE_MS)
    // Let the pending response process, then abort on the next tick.
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    const result = await promise
    const elapsed = Date.now() - t0

    expect(result.status).toBe('aborted')
    // Abort-aware wait returns within one tick — well under the 2000ms interval.
    expect(elapsed).toBeLessThan(500)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('V-20/fix1: pending round does not leak abort listeners (add == remove)', async () => {
    // The pending-path waitForPollInterval used to only clean up on the abort
    // branch; the normal timer-resolve path left a stale abort listener behind.
    // Over a long pending streak that accumulates (~96/240s task). This spy test
    // asserts every registered 'abort' listener is removed on the happy path.
    process.env.MIVO_PLATFORM_POLL_INTERVAL_MS = '10'
    const ac = new AbortController()
    const addSpy = vi.spyOn(ac.signal, 'addEventListener')
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
    mockFetch
      .mockResolvedValueOnce(jsonRes({ content: { status: 'pending' } })) // timer-resolve path
      .mockResolvedValueOnce(jsonRes({ content: { status: 'completed', images: ['/img'] } }))

    const result = await mivoPlatformPollJob(fakeCtx, 'job-1', ac.signal, undefined, DEADLINE_MS)
    expect(result.status).toBe('completed')

    const adds = addSpy.mock.calls.filter((c) => c[0] === 'abort').length
    const removes = removeSpy.mock.calls.filter((c) => c[0] === 'abort').length
    // A listener was registered during the pending wait (proves the path ran).
    expect(adds).toBeGreaterThan(0)
    // No leak: every registered 'abort' listener was removed on the timer path.
    expect(adds).toBe(removes)
  })
})
