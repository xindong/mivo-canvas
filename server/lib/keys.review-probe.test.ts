// review-probe: lead-requested attack test for X-Mivo-Api-Key header fallback.
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { platformCtxFromKey, resolvePlatformCtx } from './keys'

const ORIGINAL_ENV = {
  MIVO_PLATFORM_KEY: process.env.MIVO_PLATFORM_KEY,
  MIVO_PLATFORM_ENDPOINT: process.env.MIVO_PLATFORM_ENDPOINT,
}

const restoreEnv = () => {
  if (ORIGINAL_ENV.MIVO_PLATFORM_KEY === undefined) delete process.env.MIVO_PLATFORM_KEY
  else process.env.MIVO_PLATFORM_KEY = ORIGINAL_ENV.MIVO_PLATFORM_KEY
  if (ORIGINAL_ENV.MIVO_PLATFORM_ENDPOINT === undefined) delete process.env.MIVO_PLATFORM_ENDPOINT
  else process.env.MIVO_PLATFORM_ENDPOINT = ORIGINAL_ENV.MIVO_PLATFORM_ENDPOINT
}

describe('review-probe: X-Mivo-Api-Key resolution', () => {
  afterEach(() => {
    restoreEnv()
  })

  it('missing or blank header falls back to env platform key', async () => {
    process.env.MIVO_PLATFORM_KEY = 'mivo_env_fallback_review_probe'
    process.env.MIVO_PLATFORM_ENDPOINT = 'https://platform.review-probe.local/'

    const app = new Hono()
    app.get('/probe', (c) => c.json(resolvePlatformCtx(c)))

    const missing = await app.request('/probe')
    await expect(missing.json()).resolves.toEqual({
      platformKey: 'mivo_env_fallback_review_probe',
      platformEndpoint: 'https://platform.review-probe.local',
    })

    const blank = await app.request('/probe', { headers: { 'x-mivo-api-key': '   ' } })
    await expect(blank.json()).resolves.toEqual({
      platformKey: 'mivo_env_fallback_review_probe',
      platformEndpoint: 'https://platform.review-probe.local',
    })

    expect(platformCtxFromKey(undefined).platformKey).toBe('mivo_env_fallback_review_probe')
    expect(platformCtxFromKey('   ').platformKey).toBe('mivo_env_fallback_review_probe')
  })

  it('non-empty header takes precedence over env platform key', async () => {
    process.env.MIVO_PLATFORM_KEY = 'mivo_env_should_not_win'
    process.env.MIVO_PLATFORM_ENDPOINT = 'https://platform.review-probe.local'

    const app = new Hono()
    app.get('/probe', (c) => c.json(resolvePlatformCtx(c)))

    const res = await app.request('/probe', { headers: { 'x-mivo-api-key': ' mivo_header_review_probe ' } })
    await expect(res.json()).resolves.toEqual({
      platformKey: 'mivo_header_review_probe',
      platformEndpoint: 'https://platform.review-probe.local',
    })

    expect(platformCtxFromKey(' mivo_runner_review_probe ').platformKey).toBe('mivo_runner_review_probe')
  })
})
