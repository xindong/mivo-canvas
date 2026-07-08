// review-probe: lead-requested attack test for X-Mivo-Api-Key + X-Gateway-Key header fallback.
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { platformCtxFromKey, resolvePlatformCtx, resolveGatewayKey, rejectInvalidGatewayKey } from './keys'

const ORIGINAL_ENV = {
  MIVO_PLATFORM_KEY: process.env.MIVO_PLATFORM_KEY,
  MIVO_PLATFORM_ENDPOINT: process.env.MIVO_PLATFORM_ENDPOINT,
  MIVO_LLM_API_KEY: process.env.MIVO_LLM_API_KEY,
  MIVO_IMAGE_API_KEY: process.env.MIVO_IMAGE_API_KEY,
}

const restoreEnv = () => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
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

describe('review-probe: X-Gateway-Key resolution', () => {
  afterEach(() => {
    restoreEnv()
  })

  it('missing or blank header falls back to env MIVO_LLM_API_KEY', async () => {
    process.env.MIVO_LLM_API_KEY = 'sk-env-fallback-review-probe'
    delete process.env.MIVO_IMAGE_API_KEY

    const app = new Hono()
    app.get('/probe', (c) => c.json({ key: resolveGatewayKey(c) }))

    const missing = await app.request('/probe')
    await expect(missing.json()).resolves.toEqual({ key: 'sk-env-fallback-review-probe' })

    const blank = await app.request('/probe', { headers: { 'x-gateway-key': '   ' } })
    await expect(blank.json()).resolves.toEqual({ key: 'sk-env-fallback-review-probe' })
  })

  it('non-empty sk- header takes precedence over env', async () => {
    process.env.MIVO_LLM_API_KEY = 'sk-env-should-not-win'
    delete process.env.MIVO_IMAGE_API_KEY

    const app = new Hono()
    app.get('/probe', (c) => c.json({ key: resolveGatewayKey(c) }))

    const res = await app.request('/probe', { headers: { 'x-gateway-key': ' sk-header-review-probe ' } })
    await expect(res.json()).resolves.toEqual({ key: 'sk-header-review-probe' })
  })

  it('present-but-invalid (non-sk- / with-space) → 400, does NOT fall back to env', async () => {
    process.env.MIVO_LLM_API_KEY = 'sk-env-should-not-leak'
    delete process.env.MIVO_IMAGE_API_KEY

    const app = new Hono()
    app.get('/probe', (c) => {
      const rejected = rejectInvalidGatewayKey(c)
      if (rejected) return rejected
      return c.json({ key: resolveGatewayKey(c) })
    })

    // 非 sk- 前缀 → 400
    const noPrefix = await app.request('/probe', { headers: { 'x-gateway-key': 'not-sk-format' } })
    expect(noPrefix.status).toBe(400)

    // 含空格 → 400(防 Bearer ByteString 异常被误报网络失败)
    const withSpace = await app.request('/probe', { headers: { 'x-gateway-key': 'sk- has space' } })
    expect(withSpace.status).toBe(400)

    // 验证 invalid 不 fallback env:response body 不含 env key
    const body = await noPrefix.json()
    expect(JSON.stringify(body)).not.toContain('sk-env-should-not-leak')
    // 注:非 ASCII(如中文)header 值在 Hono request 层就被 ByteString 拒(走不到 handler),
    // 故此处不测;GATEWAY_KEY_REGEX 的非 ASCII 拒绝是 defense-in-depth。
  })

  it('valid sk- header passes validation + resolves to header', async () => {
    process.env.MIVO_LLM_API_KEY = 'sk-env-fallback'
    delete process.env.MIVO_IMAGE_API_KEY

    const app = new Hono()
    app.get('/probe', (c) => {
      const rejected = rejectInvalidGatewayKey(c)
      if (rejected) return rejected
      return c.json({ key: resolveGatewayKey(c) })
    })

    const res = await app.request('/probe', { headers: { 'x-gateway-key': 'sk-FAKEKEY-gwtest' } })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ key: 'sk-FAKEKEY-gwtest' })
  })
})
