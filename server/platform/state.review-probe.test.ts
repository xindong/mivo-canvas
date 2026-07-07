// review-probe: lead-requested attack test for per-key concurrent token isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformCtx } from '../lib/config'
import {
  __getCachedTokenForTest,
  mivoPlatformEnsureToken,
  resetPlatformState,
} from './state'

const mkCtx = (platformKey: string): PlatformCtx => ({
  platformKey,
  platformEndpoint: 'http://platform.review-probe.local',
})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('review-probe: platform state concurrent key isolation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetPlatformState()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('two different mivo keys requested concurrently resolve and cache independent tokens', async () => {
    const seenSubs: string[] = []
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { sub: string }
      seenSubs.push(body.sub)
      if (body.sub.endsWith('A')) await delay(10)
      return new Response(JSON.stringify({ session: `session-for-${body.sub}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const ctxA = mkCtx('mivo_review_probe_A')
    const ctxB = mkCtx('mivo_review_probe_B')
    const [tokenA, tokenB] = await Promise.all([
      mivoPlatformEnsureToken(ctxA),
      mivoPlatformEnsureToken(ctxB),
    ])

    expect(tokenA).toBe('session-for-mivo_review_probe_A')
    expect(tokenB).toBe('session-for-mivo_review_probe_B')
    expect(__getCachedTokenForTest(ctxA)).toBe('session-for-mivo_review_probe_A')
    expect(__getCachedTokenForTest(ctxB)).toBe('session-for-mivo_review_probe_B')
    expect(seenSubs.sort()).toEqual(['mivo_review_probe_A', 'mivo_review_probe_B'])
  })
})
