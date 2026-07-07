// server/platform/state.test.ts
// P0 invariant: different mivo_ keys must NOT share a platform session token.
// The pre-auth global singleton let user A's token leak into user B's request on a
// shared BFF process; the per-key-fingerprint bucketing fixes that. These tests
// prove the isolation + single-flight + reset hooks. single-flight and 401 retry
// are also covered end-to-end by __tests__/p1c.test.ts (real BFF + mock server);
// this file covers the per-key dimension that p1c (single ctx 'mivo_test') does not.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PlatformCtx } from '../lib/config'
import {
  __bucketCountForTest,
  __getCachedTokenForTest,
  fingerprintOf,
  mivoPlatformEnsureToken,
  mivoPlatformFetch,
  resetPlatformState,
  resetPlatformStateForKey,
} from './state'

const mkCtx = (platformKey: string): PlatformCtx => ({
  platformKey,
  platformEndpoint: 'http://platform.test.local',
})

describe('platform state — per-key-fingerprint bucketing (P0)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetPlatformState()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fingerprintOf: 16 hex chars, differs per key', () => {
    const a = mkCtx('mivo_keyA_seed')
    const b = mkCtx('mivo_keyB_seed')
    expect(fingerprintOf(a)).toHaveLength(16)
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b))
  })

  it('different keys resolve to different tokens and do NOT cross-contaminate', async () => {
    // Token endpoint returns a session derived from the request body's `sub`
    // (the platformKey), so key A → token-A, key B → token-B.
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { sub: string }
      return new Response(JSON.stringify({ session: `token-${body.sub.slice(-1)}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const ctxA = mkCtx('mivo_A')
    const ctxB = mkCtx('mivo_B')
    const tokenA = await mivoPlatformEnsureToken(ctxA)
    const tokenB = await mivoPlatformEnsureToken(ctxB)
    expect(tokenA).toBe('token-A')
    expect(tokenB).toBe('token-B')
    // After B resolves, A's cached token must still be A — B's resolution did not
    // overwrite A's bucket. This is the P0 invariant the pre-auth singleton broke.
    expect(__getCachedTokenForTest(ctxA)).toBe('token-A')
    expect(__getCachedTokenForTest(ctxB)).toBe('token-B')
  })

  it('same key single-flight: concurrent ensureToken → exactly one fetch', async () => {
    let calls = 0
    fetchSpy.mockImplementation(async () => {
      calls++
      return new Response(JSON.stringify({ session: 'token-shared' }), { status: 200 })
    })
    const ctx = mkCtx('mivo_single')
    const [a, b] = await Promise.all([mivoPlatformEnsureToken(ctx), mivoPlatformEnsureToken(ctx)])
    expect(a).toBe('token-shared')
    expect(b).toBe('token-shared')
    expect(calls).toBe(1)
  })

  it('cached token is reused on a second ensureToken (no new fetch)', async () => {
    let calls = 0
    fetchSpy.mockImplementation(async () => {
      calls++
      return new Response(JSON.stringify({ session: 'token-cached' }), { status: 200 })
    })
    const ctx = mkCtx('mivo_cache')
    await mivoPlatformEnsureToken(ctx)
    await mivoPlatformEnsureToken(ctx)
    expect(calls).toBe(1)
  })

  it('resetPlatformStateForKey clears only the named key', async () => {
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { sub: string }
      return new Response(JSON.stringify({ session: `tok-${body.sub}` }), { status: 200 })
    })
    const ctxA = mkCtx('mivo_A')
    const ctxB = mkCtx('mivo_B')
    await mivoPlatformEnsureToken(ctxA)
    await mivoPlatformEnsureToken(ctxB)
    resetPlatformStateForKey(ctxA)
    expect(__getCachedTokenForTest(ctxA)).toBeNull()
    expect(__getCachedTokenForTest(ctxB)).toBe('tok-mivo_B')
  })

  it('resetPlatformState clears all buckets', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ session: 'tok' }), { status: 200 }))
    const ctx = mkCtx('mivo_reset_all')
    await mivoPlatformEnsureToken(ctx)
    expect(__getCachedTokenForTest(ctx)).toBe('tok')
    resetPlatformState()
    expect(__getCachedTokenForTest(ctx)).toBeNull()
  })

  it('mivoPlatformFetch refreshes token on 401 and retries once (per-key)', async () => {
    let tokenCalls = 0
    let dataCalls = 0
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/v1/state/token')) {
        tokenCalls++
        return new Response(JSON.stringify({ session: `tok-${tokenCalls}` }), { status: 200 })
      }
      dataCalls++
      return dataCalls === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const ctx = mkCtx('mivo_retry')
    const res = await mivoPlatformFetch('http://platform.test.local/data', { method: 'GET' }, ctx)
    expect(res.status).toBe(200)
    expect(tokenCalls).toBe(2) // initial + refresh after 401
    expect(dataCalls).toBe(2) // first 401 + retry after refresh
  })
})

// F3: two concurrent 401s on the same key must share ONE refresh (single-flight),
// not each fire their own. The old null+null-then-ensure pattern let two 401s
// triple the upstream token calls (initial + 2 refreshes); the ??= reuse + stale-
// token guard caps it at initial + 1 shared refresh.
describe('platform state — 401 concurrent single-flight (F3)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetPlatformState()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('two concurrent 401s share ONE refresh (tokenCalls=2, not 3)', async () => {
    let tokenCalls = 0
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/state/token')) {
        tokenCalls++
        // slow refresh so both 401s overlap and race for the refresh promise
        await new Promise((r) => setTimeout(r, 5))
        return new Response(JSON.stringify({ session: `tok-${tokenCalls}` }), { status: 200 })
      }
      const auth = ((init?.headers as Record<string, string> | undefined)?.Authorization) ?? ''
      // tok-1 is stale → 401; tok-2 is fresh → 200. Token-based (not call-count)
      // so the second caller's initial fetch with tok-1 also 401s deterministically
      // and the retry with tok-2 succeeds.
      if (auth.includes('tok-1')) return new Response('unauthorized', { status: 401 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const ctx = mkCtx('mivo_concurrent_401')
    const [r1, r2] = await Promise.all([
      mivoPlatformFetch('http://platform.test.local/data', { method: 'GET' }, ctx),
      mivoPlatformFetch('http://platform.test.local/data', { method: 'GET' }, ctx),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // initial token (1) + ONE shared refresh (1) = 2. Old bug fired 2 refreshes (3).
    expect(tokenCalls).toBe(2)
  })
})

// F4: bucket count must be bounded — a shared BFF process cannot grow memory
// without limit if many distinct keys hit it. The LRU cap evicts the oldest.
describe('platform state — bucket LRU cap (F4)', () => {
  beforeEach(() => {
    resetPlatformState()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('bucket count never exceeds 256 under a flood of distinct keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ session: 'tok' }), { status: 200 }))
    const N = 400
    for (let i = 0; i < N; i++) {
      await mivoPlatformEnsureToken(mkCtx(`mivo_key_${i}`))
    }
    expect(__bucketCountForTest()).toBeLessThanOrEqual(256)
  })

  it('LRU refresh keeps a re-accessed key resident while newer ones evict', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ session: 'tok' }), { status: 200 }))
    const keepKey = mkCtx('mivo_keep')
    await mivoPlatformEnsureToken(keepKey)
    for (let i = 0; i < 300; i++) {
      await mivoPlatformEnsureToken(mkCtx(`mivo_flood_${i}`))
      if (i % 50 === 0) await mivoPlatformEnsureToken(keepKey) // touch LRU position
    }
    // keepKey survived eviction because each touch moved it to the tail.
    expect(__getCachedTokenForTest(keepKey)).toBe('tok')
  })

  // F4 REOPEN: evicting an in-flight bucket orphans its refresh promise and forces
  // a second upstream token fetch when the same key is requested again. Eviction
  // must skip active buckets; if all are active, allow the count to exceed the cap.
  it('LRU eviction skips in-flight buckets (active key not re-fetched)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    let activeTokenCalls = 0
    const release: { fn: (() => void) | null } = { fn: null }
    const activeHang = new Promise<void>((resolve) => {
      // Wrap resolve so release.fn is a clean () => void; the holder object keeps
      // TS from narrowing the field to null across the closure assignment (a `let`
      // assigned only inside a closure gets narrowed to its initial null outside).
      release.fn = () => resolve()
    })
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { sub: string }
      if (body.sub === 'mivo_active') {
        activeTokenCalls++
        await activeHang
        return new Response(JSON.stringify({ session: 'active-tok' }), { status: 200 })
      }
      return new Response(JSON.stringify({ session: 'flood-tok' }), { status: 200 })
    })

    const ctxActive = mkCtx('mivo_active')
    // Start the active refresh (hangs) so its bucket is in-flight.
    const activePromise = mivoPlatformEnsureToken(ctxActive)
    await new Promise((r) => setTimeout(r, 5))

    // Flood past the cap; the active bucket must survive eviction.
    for (let i = 0; i < 260; i++) {
      await mivoPlatformEnsureToken(mkCtx(`mivo_flood_${i}`))
    }

    // Requesting active again must reuse the in-flight promise → no new fetch.
    const activeAgain = mivoPlatformEnsureToken(ctxActive)
    await new Promise((r) => setTimeout(r, 5))
    expect(activeTokenCalls).toBe(1)

    // Release the hang so the test can clean up.
    release.fn?.()
    await Promise.all([activePromise, activeAgain])
  })

  it('all-active flood: count may exceed cap (no active bucket evicted)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const resolvers: Array<() => void> = []
    fetchSpy.mockImplementation(async () => {
      return new Promise<Response>((resolve) => {
        resolvers.push(() => resolve(new Response(JSON.stringify({ session: 'tok' }), { status: 200 })))
      })
    })

    const N = 260
    const promises: Array<Promise<string>> = []
    for (let i = 0; i < N; i++) {
      promises.push(mivoPlatformEnsureToken(mkCtx(`mivo_active_${i}`)))
    }
    await new Promise((r) => setTimeout(r, 5))

    // Every bucket is in-flight → none can be evicted → count exceeds the cap.
    expect(__bucketCountForTest()).toBe(N)

    // Release all hangs to clean up.
    for (const release of resolvers) release()
    await Promise.all(promises)
  })

  // Convergence: an all-active spike (count > MAX) must NOT freeze the count at
  // the peak. Once the in-flight promises settle the buckets become evictable, so
  // the next distinct-key miss must evict enough inactive buckets to bring the
  // count back to ≤ MAX_BUCKETS. The old single-eviction-per-miss logic deleted 1
  // and added 1, freezing the count at 260 forever (persistent memory leak).
  it('all-active spike converges back to cap after promises settle', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const resolvers: Array<() => void> = []
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { sub: string }
      // spike keys hang (in-flight); the post-spike miss resolves immediately so
      // the test doesn't have to release it separately.
      if (body.sub.startsWith('mivo_spike_')) {
        return new Promise<Response>((resolve) => {
          resolvers.push(() => resolve(new Response(JSON.stringify({ session: 'tok' }), { status: 200 })))
        })
      }
      return new Response(JSON.stringify({ session: 'tok' }), { status: 200 })
    })

    // 260 in-flight buckets — exceeds the cap while all active (no eviction).
    const N = 260
    const promises: Array<Promise<string>> = []
    for (let i = 0; i < N; i++) {
      promises.push(mivoPlatformEnsureToken(mkCtx(`mivo_spike_${i}`)))
    }
    await new Promise((r) => setTimeout(r, 5))
    expect(__bucketCountForTest()).toBe(N)

    // Settle every promise → buckets become inactive (tokenPromise cleared).
    for (const release of resolvers) release()
    await Promise.all(promises)
    await new Promise((r) => setTimeout(r, 5))

    // One more distinct-key miss must converge the count back to ≤ MAX_BUCKETS.
    await mivoPlatformEnsureToken(mkCtx('mivo_post_spike'))
    expect(__bucketCountForTest()).toBeLessThanOrEqual(256)
  })
})
