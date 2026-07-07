// @vitest-environment node
// Review probes for feat/auth-feishu-login (A-1/A-2/A-3 hardening). These tests
// intentionally exercise attack-shaped cases: invalid JWT_SECRET, asset routes
// under default-deny, dev-login production double-lock, OAuth state tamper.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { startupAuthError } from '../lib/authConfig'

const VALID_JWT_SECRET_RAW = Buffer.from('review-probe-shared-secret-32-bytes').toString('base64')

const savedEnv: Record<string, string | undefined> = {
  JWT_SECRET: process.env.JWT_SECRET,
  MIVO_BFF_TOKEN: process.env.MIVO_BFF_TOKEN,
  MIVO_PUBLIC: process.env.MIVO_PUBLIC,
  MIVO_ENABLE_LOCAL_ASSETS: process.env.MIVO_ENABLE_LOCAL_ASSETS,
  MAKER_SERVER_URL: process.env.MAKER_SERVER_URL,
  MIVO_FEISHU_APP_ID: process.env.MIVO_FEISHU_APP_ID,
  MIVO_OAUTH_REDIRECT_URI: process.env.MIVO_OAUTH_REDIRECT_URI,
  MIVO_COOKIE_SECURE: process.env.MIVO_COOKIE_SECURE,
  MIVO_DEV_AUTH_ENABLED: process.env.MIVO_DEV_AUTH_ENABLED,
  NODE_ENV: process.env.NODE_ENV,
}

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const loadFreshApp = async () => {
  vi.resetModules()
  return (await import('../app')).app
}

const cookieValue = (res: Response, name: string): string | null => {
  const setCookies = res.headers.getSetCookie?.() ?? []
  for (const entry of setCookies) {
    if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1).split(';')[0] || null
  }
  const single = res.headers.get('set-cookie')
  if (single?.startsWith(`${name}=`)) return single.slice(name.length + 1).split(';')[0] || null
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// A-1: invalid JWT_SECRET must not silently no-op the gate (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════
describe('A-1 review probe: invalid JWT_SECRET fail-closed', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.MIVO_BFF_TOKEN
    process.env.MIVO_COOKIE_SECURE = '0'
    delete process.env.NODE_ENV
  })
  afterEach(() => {
    restoreEnv()
    vi.resetModules()
  })

  it('startup rejects JWT_SECRET that is invalid base64 (e.g. "!!!!")', () => {
    process.env.JWT_SECRET = '!!!!'
    expect(startupAuthError()).toMatch(/FATAL.*JWT_SECRET/)
  })

  it('startup rejects JWT_SECRET that decodes to empty bytes (e.g. all padding "====")', () => {
    process.env.JWT_SECRET = '===='
    expect(startupAuthError()).toMatch(/FATAL.*JWT_SECRET/)
  })

  it('startup accepts a valid base64 JWT_SECRET', () => {
    process.env.JWT_SECRET = VALID_JWT_SECRET_RAW
    expect(startupAuthError()).toBeNull()
  })

  it('startup rejects MIVO_PUBLIC=1 with no gate credential', () => {
    process.env.MIVO_PUBLIC = '1'
    delete process.env.JWT_SECRET
    delete process.env.MIVO_BFF_TOKEN
    expect(startupAuthError()).toMatch(/FATAL.*MIVO_PUBLIC/)
  })

  it('startup allows local dev (no MIVO_PUBLIC, no credentials)', () => {
    delete process.env.JWT_SECRET
    delete process.env.MIVO_BFF_TOKEN
    delete process.env.MIVO_PUBLIC
    expect(startupAuthError()).toBeNull()
  })

  it('gate returns 401 (not 405) for protected route when JWT_SECRET is invalid base64', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.JWT_SECRET = '!!!!'
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/generate')
    expect(res.status).toBe(401)
  })

  it('gate returns 401 when JWT_SECRET decodes to empty bytes', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.JWT_SECRET = '===='
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/generate')
    expect(res.status).toBe(401)
  })

  it('misconfigured JWT_SECRET 401s even when MIVO_BFF_TOKEN is also set (fail-closed, no fallback)', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.JWT_SECRET = '!!!!'
    process.env.MIVO_BFF_TOKEN = 'some-bff-token'
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/generate', {
      headers: { authorization: 'Bearer some-bff-token' },
    })
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A-2: default-deny /api/mivo/* — asset routes (local-assets/eagle/proxy-image)
// are now protected; /api/mivo/debug-logs exempted (own auth).
// ═══════════════════════════════════════════════════════════════════════════
describe('A-2 review probe: asset routes protected, debug-logs exempt', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.MIVO_BFF_TOKEN
    process.env.JWT_SECRET = VALID_JWT_SECRET_RAW
    process.env.MIVO_PUBLIC = '1'
    process.env.MIVO_COOKIE_SECURE = '0'
    delete process.env.NODE_ENV
  })
  afterEach(() => {
    restoreEnv()
    vi.resetModules()
  })

  it('local-assets route is protected (401 unauth, even when feature enabled)', async () => {
    process.env.MIVO_ENABLE_LOCAL_ASSETS = '1'
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/local-assets')
    expect(res.status).toBe(401)
  })

  it('eagle route is protected (401 unauth)', async () => {
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/eagle/status')
    expect(res.status).toBe(401)
  })

  it('proxy-image route is protected (401 unauth)', async () => {
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/proxy-image')
    expect(res.status).toBe(401)
  })

  it('debug-logs is exempt from the main gate (own auth applies: public-mode 403)', async () => {
    // MIVO_PUBLIC=1 + no MIVO_DEBUG_VIEW_TOKEN → debug-logs own D8 gate returns 403.
    // 403 (not 401) proves the main gate let it through to its own auth.
    delete process.env.MIVO_DEBUG_VIEW_TOKEN
    const app = await loadFreshApp()
    const res = await app.request('/api/mivo/debug-logs')
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A-3: dev-login production double-lock (MIVO_PUBLIC=1 OR NODE_ENV=production → 404
// regardless of MIVO_DEV_AUTH_ENABLED)
// ═══════════════════════════════════════════════════════════════════════════
describe('A-3 review probe: dev-login production double-lock', () => {
  beforeEach(() => {
    restoreEnv()
    process.env.JWT_SECRET = VALID_JWT_SECRET_RAW
    process.env.MIVO_COOKIE_SECURE = '0'
    process.env.MIVO_DEV_AUTH_ENABLED = '1' // enabled, but production must still 404
  })
  afterEach(() => {
    restoreEnv()
    vi.resetModules()
  })

  it('MIVO_PUBLIC=1 → dev-login 404 even with MIVO_DEV_AUTH_ENABLED=1', async () => {
    process.env.MIVO_PUBLIC = '1'
    delete process.env.NODE_ENV
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/dev-login', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('NODE_ENV=production → dev-login 404 even with MIVO_DEV_AUTH_ENABLED=1', async () => {
    delete process.env.MIVO_PUBLIC
    process.env.NODE_ENV = 'production'
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/dev-login', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OAuth state cookie tamper resistance (unchanged by A-*; kept green)
// ═══════════════════════════════════════════════════════════════════════════
describe('review probe: OAuth state cookie tamper resistance', () => {
  beforeEach(() => {
    restoreEnv()
    process.env.JWT_SECRET = VALID_JWT_SECRET_RAW
    process.env.MAKER_SERVER_URL = 'http://127.0.0.1:1'
    process.env.MIVO_FEISHU_APP_ID = 'cli_review_probe'
    process.env.MIVO_COOKIE_SECURE = '0'
    delete process.env.NODE_ENV
    delete process.env.MIVO_PUBLIC
  })
  afterEach(() => {
    restoreEnv()
    vi.resetModules()
  })

  it('tampered signed mivo_oauth cookie is rejected before maker /login is called', async () => {
    const app = await loadFreshApp()
    const loginRes = await app.request('/api/auth/login-url')
    expect(loginRes.status).toBe(200)
    const body = (await loginRes.json()) as { authorizeUrl: string }
    const state = new URL(body.authorizeUrl).searchParams.get('state')
    const oauthCookie = cookieValue(loginRes, 'mivo_oauth')
    expect(state).toBeTruthy()
    expect(oauthCookie).toBeTruthy()
    const tampered = `${oauthCookie!.slice(0, -1)}${oauthCookie!.endsWith('a') ? 'b' : 'a'}`

    const res = await app.request(`/api/auth/callback?code=mock-code&state=${state}`, {
      headers: { cookie: `mivo_oauth=${tampered}` },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('state_cookie_missing')
    expect(cookieValue(res, 'mivo_auth')).toBeNull()
  })
})
