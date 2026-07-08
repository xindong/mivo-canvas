// @vitest-environment node
// review-probe: attack checks for the SSO auth dev stub and ungated BFF routes
// (P1-b dev stub opt-in).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_NAMES = [
  'NODE_ENV',
  'MIVO_DEV_AUTH_STUB',
  'MIVO_PUBLIC',
  'MIVO_LLM_API_KEY',
  'MIVO_IMAGE_API_KEY',
] as const

const savedEnv: Record<(typeof ENV_NAMES)[number], string | undefined> = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof ENV_NAMES)[number], string | undefined>

const restoreEnv = () => {
  for (const name of ENV_NAMES) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

const clearProbeEnv = () => {
  for (const name of ENV_NAMES) delete process.env[name]
}

const loadFreshApp = async () => {
  vi.resetModules()
  return (await import('../app')).app
}

describe('review-probe: SSO dev stub and ungated BFF surface', () => {
  beforeEach(() => {
    restoreEnv()
    clearProbeEnv()
  })

  afterEach(() => {
    restoreEnv()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('NODE_ENV=production hard-disables /api/auth/me dev stub even when MIVO_DEV_AUTH_STUB=1', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MIVO_DEV_AUTH_STUB = '1'

    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ detail: 'Not authenticated' })
  })

  it('P1-b: MIVO_PUBLIC=1 forces dev stub off → /api/auth/me 401 even with MIVO_DEV_AUTH_STUB=1', async () => {
    // public deployments must get identity only from the SSO gateway.
    process.env.MIVO_PUBLIC = '1'
    process.env.MIVO_DEV_AUTH_STUB = '1'

    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ detail: 'Not authenticated' })
  })

  it('P1-b: dev stub off by default (no MIVO_DEV_AUTH_STUB) → 401 (防生产忘设 NODE_ENV 返假登录)', async () => {
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ detail: 'Not authenticated' })
  })

  it('documents no app-layer auth gate by design: direct /api/mivo/enhance reaches handler without SSO credentials', async () => {
    // SSO scheme: the BFF has no app-level auth gate by design — authentication is
    // the company SSO gateway (auth.dsworks.cn) in front of the BFF, enforced by
    // ops/network layer (not in this repo's scope). In-process app.request()
    // bypasses the network, so the handler is reachable here; in production the
    // gateway walls unauthenticated requests (302 → login) before they reach the
    // BFF, and the BFF port is not directly reachable outside the gateway path.
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/enhance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'review probe' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enhanced: false, degradedReason: 'no-key' })
  })

  it('invalid X-Gateway-Key is rejected before env fallback and does not leak either key', async () => {
    process.env.MIVO_LLM_API_KEY = 'sk-env-secret-review-probe'
    const badHeader = 'not-sk-secret-review-probe'
    const app = await loadFreshApp()

    const res = await app.request('/api/mivo/enhance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gateway-key': badHeader },
      body: JSON.stringify({ prompt: 'review probe' }),
    })
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(text).not.toContain(process.env.MIVO_LLM_API_KEY)
    expect(text).not.toContain(badHeader)
  })

  it('overlong X-Gateway-Key is rejected before upstream use', async () => {
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/enhance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gateway-key': `sk-${'a'.repeat(200)}` },
      body: JSON.stringify({ prompt: 'review probe' }),
    })

    expect(res.status).toBe(400)
  })
})
