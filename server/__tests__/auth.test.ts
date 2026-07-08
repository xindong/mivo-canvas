// @vitest-environment node
// server/__tests__/auth.test.ts
// feat/auth-feishu-login (E1) — covers the four required unit/integration areas:
//   1. jwt 验证           — verifyAccessToken (valid / tampered / wrong-secret / expired / missing-sub)
//   2. gate JWT cookie    — protected path accepts mivo_auth cookie (first-class citizen)
//   3. callback state 校验 — /api/auth/callback state mismatch → auth_error; valid → sets cookie + 302
//   4. dev-login DEV 门控  — disabled → 404; enabled (+mock maker) → 200 + cookie
//
// Drives the real BFF app + a mock maker Hono server (so we don't depend on a
// live maker/feishu). JWTs are signed with the shared TEST secret via jose,
// mirroring maker's signAccessToken({sub, device}) HS256 shape.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Buffer } from 'node:buffer'
import { app } from '../app'
import { verifyAccessToken } from '../lib/jwt'
import { isProtectedPath, isGateWhitelisted } from '../lib/authGate'

// Shared HS256 secret (base64), mirrors maker config.ts base64→Uint8Array decode.
const TEST_JWT_SECRET_RAW = Buffer.from('mivo-test-jwt-secret-32-bytes-long').toString('base64')
const TEST_JWT_SECRET_BYTES = new Uint8Array(Buffer.from(TEST_JWT_SECRET_RAW, 'base64'))

const signJwt = async (sub: string, device = 'mivo-web-test', expSecs = 3600): Promise<string> =>
  new SignJWT({ device })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${expSecs}s`)
    .sign(TEST_JWT_SECRET_BYTES)

// ── Mock maker server ──────────────────────────────────────────────────────
const mockMaker = new Hono()
const TEST_USER = { id: 'user-1', name: 'Test User', avatar: 'https://x/avatar.png' }

mockMaker.post('/api/auth/login', async (c) => {
  const body = (await c.req.json()) as { clientType?: string; redirectUri?: string; deviceId?: string }
  // feat/web-client-auth contract: web must send clientType + redirectUri.
  if (body.clientType !== 'web' || !body.redirectUri) {
    return c.json({ error: 'maker: web requires clientType+redirectUri' }, 400)
  }
  const accessToken = await signJwt(body.deviceId || 'mivo-web-test')
  return c.json({ accessToken, refreshToken: 'rt', user: TEST_USER, feishuAccessToken: 'f', feishuRefreshToken: 'f', feishuExpiresIn: 86400, grantedScopes: [], migration: { status: 'none' } })
})
mockMaker.post('/api/auth/dev-login', async (c) => {
  const body = (await c.req.json()) as { deviceId?: string }
  const accessToken = await signJwt(body.deviceId || 'mivo-web-dev')
  return c.json({ accessToken, refreshToken: 'rt', user: TEST_USER, feishuAccessToken: 'f', feishuRefreshToken: 'f', feishuExpiresIn: 86400, grantedScopes: [], migration: { status: 'none' } })
})
mockMaker.get('/api/user/me', async (c) => {
  const auth = c.req.header('authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ user: TEST_USER })
})
mockMaker.post('/api/auth/logout', (c) => c.json({ success: true }))

let makerServer: Server
let makerBase = ''
let bffServer: Server
let bffBase = ''

const startMockMaker = (): Promise<void> =>
  new Promise((resolve) => {
    makerServer = serve({ fetch: mockMaker.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      makerBase = `http://${info.address}:${info.port}`
      resolve()
    }) as unknown as Server
  })

const startBff = (): Promise<void> =>
  new Promise((resolve) => {
    bffServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      bffBase = `http://${info.address}:${info.port}`
      resolve()
    }) as unknown as Server
  })

const req = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers; location: string | null }> => {
  // redirect:'manual' so 302s from /api/auth/callback are observable (default fetch
  // would follow → SPA fallback → 404 build_not_found, masking the redirect).
  const res = await fetch(bffBase + path, { redirect: 'manual', ...init })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body, headers: res.headers, location: res.headers.get('location') }
}

// Capture Set-Cookie values for a given name (manual cookie jar — fetch has none).
const cookiesFrom = (res: { headers: Headers }, name: string): string | null => {
  const setCookies = res.headers.getSetCookie?.() ?? []
  for (const sc of setCookies) {
    const prefix = `${name}=`
    if (sc.startsWith(prefix)) {
      const rest = sc.slice(prefix.length)
      return rest.split(';')[0] || null
    }
  }
  return null
}

let savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  savedEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    MAKER_SERVER_URL: process.env.MAKER_SERVER_URL,
    MIVO_FEISHU_APP_ID: process.env.MIVO_FEISHU_APP_ID,
    MIVO_OAUTH_REDIRECT_URI: process.env.MIVO_OAUTH_REDIRECT_URI,
    MIVO_DEV_AUTH_ENABLED: process.env.MIVO_DEV_AUTH_ENABLED,
    MIVO_COOKIE_SECURE: process.env.MIVO_COOKIE_SECURE,
    MIVO_PUBLIC: process.env.MIVO_PUBLIC,
    NODE_ENV: process.env.NODE_ENV,
  }
  await startMockMaker()
  await startBff()
})
afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await new Promise<void>((r) => makerServer.close(() => r()))
  await new Promise<void>((r) => bffServer.close(() => r()))
})

beforeEach(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET_RAW
  process.env.MAKER_SERVER_URL = makerBase
  process.env.MIVO_FEISHU_APP_ID = 'feishu-app-id-test'
  process.env.MIVO_OAUTH_REDIRECT_URI = `${bffBase}/api/auth/callback`
  process.env.MIVO_COOKIE_SECURE = '0'
  delete process.env.MIVO_DEV_AUTH_ENABLED
  delete process.env.MIVO_PUBLIC
  delete process.env.NODE_ENV
})
afterEach(() => {
  delete process.env.JWT_SECRET
  delete process.env.MAKER_SERVER_URL
  delete process.env.MIVO_FEISHU_APP_ID
  delete process.env.MIVO_OAUTH_REDIRECT_URI
  delete process.env.MIVO_COOKIE_SECURE
  delete process.env.MIVO_DEV_AUTH_ENABLED
  delete process.env.MIVO_PUBLIC
  delete process.env.NODE_ENV
})

// ── 1. jwt 验证 (verifyAccessToken) ─────────────────────────────────────────
describe('verifyAccessToken (HS256, shared secret)', () => {
  it('valid JWT → { sub, device, exp }', async () => {
    const token = await signJwt('user-1', 'dev-1', 3600)
    const payload = await verifyAccessToken(token, TEST_JWT_SECRET_BYTES)
    expect(payload).not.toBeNull()
    expect(payload?.sub).toBe('user-1')
    expect(payload?.device).toBe('dev-1')
    expect(typeof payload?.exp).toBe('number')
  })

  it('tampered JWT → null', async () => {
    const token = await signJwt('user-1')
    const tampered = token.slice(0, -4) + 'aaaa'
    expect(await verifyAccessToken(tampered, TEST_JWT_SECRET_BYTES)).toBeNull()
  })

  it('JWT signed with a different secret → null', async () => {
    const otherSecret = new Uint8Array(Buffer.from('wrong-secret-aaaaaaaaaaaaaaaa', 'base64'))
    const token = await new SignJWT({ device: 'd' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setIssuedAt().setExpirationTime('1h').sign(otherSecret)
    expect(await verifyAccessToken(token, TEST_JWT_SECRET_BYTES)).toBeNull()
  })

  it('expired JWT → null', async () => {
    const token = await signJwt('user-1', 'dev-1', -10)
    expect(await verifyAccessToken(token, TEST_JWT_SECRET_BYTES)).toBeNull()
  })

  it('garbage string → null (never throws)', async () => {
    expect(await verifyAccessToken('not-a-jwt', TEST_JWT_SECRET_BYTES)).toBeNull()
    expect(await verifyAccessToken('', TEST_JWT_SECRET_BYTES)).toBeNull()
  })
})

// ── gate helpers (isProtectedPath / isGateWhitelisted) ──────────────────────
describe('authGate helpers', () => {
  it('isProtectedPath default-denies /api/mivo/* and /api/keys/* (A-2)', () => {
    // AI/生图
    expect(isProtectedPath('/api/mivo/generate')).toBe(true)
    expect(isProtectedPath('/api/mivo/edit')).toBe(true)
    expect(isProtectedPath('/api/mivo/enhance')).toBe(true)
    expect(isProtectedPath('/api/mivo/tasks')).toBe(true)
    expect(isProtectedPath('/api/mivo/tasks/abc-123')).toBe(true)
    // 资产类(A-2 补保护)
    expect(isProtectedPath('/api/mivo/local-assets')).toBe(true)
    expect(isProtectedPath('/api/mivo/local-assets/x.png')).toBe(true)
    expect(isProtectedPath('/api/mivo/eagle/status')).toBe(true)
    expect(isProtectedPath('/api/mivo/proxy-image')).toBe(true)
    // look-alike under /api/mivo/ 也默认保护(不再靠段边界放过)
    expect(isProtectedPath('/api/mivo/generatefoo')).toBe(true)
    // keys (E2)
    expect(isProtectedPath('/api/keys')).toBe(true)
    expect(isProtectedPath('/api/keys/test')).toBe(true)
  })
  it('isProtectedPath exempts /api/mivo/debug-logs (own auth) + public paths', () => {
    expect(isProtectedPath('/api/mivo/debug-logs')).toBe(false)
    expect(isProtectedPath('/api/mivo/debug-logs/2026-07-07')).toBe(false)
    expect(isProtectedPath('/')).toBe(false)
    expect(isProtectedPath('/healthz')).toBe(false)
    expect(isProtectedPath('/api/auth/callback')).toBe(false)
    expect(isProtectedPath('/api/mivofoo')).toBe(false) // 段边界:/api/mivofoo 不在 /api/mivo 段下
  })
  it('isGateWhitelisted matches /healthz and /api/auth/*', () => {
    expect(isGateWhitelisted('/healthz')).toBe(true)
    expect(isGateWhitelisted('/api/auth/login-url')).toBe(true)
    expect(isGateWhitelisted('/api/auth/callback')).toBe(true)
    expect(isGateWhitelisted('/api/mivo/generate')).toBe(false)
  })
})

// ── 2. gate JWT cookie (first-class citizen) ────────────────────────────────
describe('Access gate — JWT cookie (primary credential)', () => {
  it('protected path with valid mivo_auth cookie → not 401', async () => {
    const token = await signJwt('user-1')
    const r = await req('/api/mivo/generate', { headers: { cookie: `mivo_auth=${token}` } })
    expect(r.status).not.toBe(401)
  })
  it('protected path with expired mivo_auth cookie and no BFF token → 401', async () => {
    const token = await signJwt('user-1', 'd', -10)
    const r = await req('/api/mivo/generate', { headers: { cookie: `mivo_auth=${token}` } })
    expect(r.status).toBe(401)
  })
  it('protected path with no cookie and no BFF token → 401 (JWT-only mode)', async () => {
    const r = await req('/api/mivo/generate')
    expect(r.status).toBe(401)
    // JWT-only mode does NOT emit WWW-Authenticate: Basic (no BFF token configured).
    expect(r.headers.get('www-authenticate')).toBeNull()
  })
})

// ── 3. /api/auth/me (200 探测语义:未登录答 null,不是 401/503) ───────────────
describe('GET /api/auth/me', () => {
  it('no cookie → 200 {authenticated:false, user:null}', async () => {
    const r = await req('/api/auth/me')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ authenticated: false, user: null })
  })
  it('valid cookie → 200 {authenticated:true, user} (proxies maker /api/user/me)', async () => {
    const token = await signJwt('user-1')
    const r = await req('/api/auth/me', { headers: { cookie: `mivo_auth=${token}` } })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ authenticated: true, user: TEST_USER })
  })
  it('expired cookie → 200 {authenticated:false, user:null} (local verify, no maker call)', async () => {
    const token = await signJwt('user-1', 'd', -10)
    const r = await req('/api/auth/me', { headers: { cookie: `mivo_auth=${token}` } })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ authenticated: false, user: null })
  })
  it('garbage cookie → 200 {authenticated:false, user:null} (invalid treated as not logged in)', async () => {
    const r = await req('/api/auth/me', { headers: { cookie: 'mivo_auth=not-a-jwt' } })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ authenticated: false, user: null })
  })
})

// ── 4. /api/auth/callback state validation ──────────────────────────────────
describe('GET /api/auth/callback — state validation', () => {
  it('missing code/state → 302 with auth_error', async () => {
    const r = await req('/api/auth/callback')
    expect(r.status).toBe(302)
    expect(r.location).toMatch(/auth_error=/)
  })

  it('state mismatch (cookie state ≠ query state) → 302 auth_error=state_mismatch', async () => {
    // 1. prime oauth state cookie via /login-url
    const loginRes = await req('/api/auth/login-url')
    expect(loginRes.status).toBe(200)
    const oauthCookie = cookiesFrom(loginRes, 'mivo_oauth')
    expect(oauthCookie).not.toBeNull()
    // 2. callback with a WRONG state
    const r = await req(`/api/auth/callback?code=mock-code&state=wrong-state`, {
      headers: { cookie: `mivo_oauth=${oauthCookie}` },
    })
    expect(r.status).toBe(302)
    expect(r.location).toMatch(/state_mismatch/)
  })

  it('no oauth cookie → 302 auth_error=state_cookie_missing', async () => {
    const r = await req('/api/auth/callback?code=mock-code&state=anything')
    expect(r.status).toBe(302)
    expect(r.location).toMatch(/state_cookie_missing/)
  })

  it('valid state → 302 to returnTo, sets mivo_auth cookie', async () => {
    // 1. prime oauth state cookie + capture the state we put in authorize URL
    const loginRes = await req('/api/auth/login-url?returnTo=/canvas-x')
    expect(loginRes.status).toBe(200)
    const oauthCookie = cookiesFrom(loginRes, 'mivo_oauth')
    const authorizeUrl = (loginRes.body as { authorizeUrl: string }).authorizeUrl
    const state = new URL(authorizeUrl).searchParams.get('state')
    expect(state).not.toBeNull()
    // 2. callback with matching state + code
    const r = await req(`/api/auth/callback?code=mock-code&state=${state}`, {
      headers: { cookie: `mivo_oauth=${oauthCookie}` },
    })
    expect(r.status).toBe(302)
    expect(r.location).toBe('/canvas-x')
    // 3. mivo_auth cookie set
    const authCookie = cookiesFrom(r, 'mivo_auth')
    expect(authCookie).not.toBeNull()
    // 4. that cookie works against /me (200 {authenticated:true, user})
    const meRes = await req('/api/auth/me', { headers: { cookie: `mivo_auth=${authCookie}` } })
    expect(meRes.status).toBe(200)
    expect(meRes.body).toEqual({ authenticated: true, user: TEST_USER })
  })
})

// ── 5. /api/auth/dev-login DEV gating ───────────────────────────────────────
describe('POST /api/auth/dev-login — DEV gating', () => {
  it('disabled (MIVO_DEV_AUTH_ENABLED unset) → 404', async () => {
    delete process.env.MIVO_DEV_AUTH_ENABLED
    const r = await req('/api/auth/dev-login', { method: 'POST' })
    expect(r.status).toBe(404)
  })
  it('enabled + mock maker → 200 + sets mivo_auth cookie', async () => {
    process.env.MIVO_DEV_AUTH_ENABLED = '1'
    const r = await req('/api/auth/dev-login', { method: 'POST' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(TEST_USER)
    const authCookie = cookiesFrom(r, 'mivo_auth')
    expect(authCookie).not.toBeNull()
  })
})

// ── 6. /api/auth/login-url ──────────────────────────────────────────────────
describe('GET /api/auth/login-url', () => {
  it('valid config → 200 {authorizeUrl} with PKCE + state', async () => {
    const r = await req('/api/auth/login-url')
    expect(r.status).toBe(200)
    const url = new URL((r.body as { authorizeUrl: string }).authorizeUrl)
    expect(url.pathname).toBe('/open-apis/authen/v1/authorize')
    expect(url.searchParams.get('client_id')).toBe('feishu-app-id-test')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(0)
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(0)
    expect(url.searchParams.get('redirect_uri')).toBe(`${bffBase}/api/auth/callback`)
    // oauth state cookie set
    expect(cookiesFrom(r, 'mivo_oauth')).not.toBeNull()
  })
  it('missing MAKER_SERVER_URL → 200 {authorizeUrl:null, error} (not 503, no console noise)', async () => {
    delete process.env.MAKER_SERVER_URL
    const r = await req('/api/auth/login-url')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ authorizeUrl: null, error: 'auth_not_configured' })
  })
})
