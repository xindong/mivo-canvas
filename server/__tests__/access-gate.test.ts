// @vitest-environment node
// server/__tests__/access-gate.test.ts
// feat/auth-feishu-login (F7): gate scope narrowed to AI/生图/资产-class APIs.
//   - public  : GET /, /healthz, /api/auth/* (whitelist), canvas-local/static/SPA
//   - guarded : /api/mivo/{generate,edit,enhance,tasks}/* + /api/keys/* (E2)
//   - accept  : mivo_auth JWT cookie (primary) OR MIVO_BFF_TOKEN schemes (compat)
//   - no-op   : neither JWT_SECRET nor MIVO_BFF_TOKEN set (local dev default)
//
// Drives the real BFF (app + @hono/node-server). For "allowed" cases we only
// assert the gate did NOT return 401 (downstream handler status is irrelevant
// to the gate contract — e.g. GET /api/mivo/generate → 405 from generateHandler).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { app } from '../app'

const TOKEN = 'test-bff-token-xyz'

let bffServer: Server
let bffBase = ''
let savedToken: string | undefined
let savedJwtSecret: string | undefined

const startServer = (): Promise<void> =>
  new Promise((resolve) => {
    bffServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      bffBase = `http://${info.address}:${info.port}`
      resolve()
    }) as unknown as Server
  })

const req = async (
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> => {
  const res = await fetch(bffBase + path, init)
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body, headers: res.headers }
}

const basicAuth = (username: string, password: string): string =>
  'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')

beforeAll(async () => {
  savedToken = process.env.MIVO_BFF_TOKEN
  savedJwtSecret = process.env.JWT_SECRET
  await startServer()
})

afterAll(async () => {
  if (savedToken === undefined) delete process.env.MIVO_BFF_TOKEN
  else process.env.MIVO_BFF_TOKEN = savedToken
  if (savedJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = savedJwtSecret
  await new Promise<void>((r) => bffServer.close(() => r()))
})

// Gate reads env fresh per request; pin per test so ordering stays deterministic.
beforeEach(() => {
  process.env.MIVO_BFF_TOKEN = TOKEN
  delete process.env.JWT_SECRET
})
afterEach(() => {
  delete process.env.MIVO_BFF_TOKEN
  delete process.env.JWT_SECRET
})

describe('Access gate — public paths (F7 scope narrowing)', () => {
  it('GET / (SPA shell) is public — no creds, not 401', async () => {
    const r = await req('/')
    expect(r.status).not.toBe(401)
  })

  it('/healthz is whitelisted — no creds, not 401', async () => {
    const r = await req('/healthz')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ status: 'ok' })
  })

  it('/api/auth/* is whitelisted (gate passes through; route owns its own 401/503)', async () => {
    // /api/auth/login-url with no JWT_SECRET → route returns 503, NOT gate 401.
    const r = await req('/api/auth/login-url')
    expect(r.status).not.toBe(401)
  })
})

describe('Access gate — protected paths (MIVO_BFF_TOKEN compat channel)', () => {
  // A representative protected path. generateHandler enforces POST-only, so GET
  // with valid creds → 405 (gate passed); without creds → 401 (gate rejected).
  const PROTECTED = '/api/mivo/generate'

  it('no credentials → 401 with WWW-Authenticate: Basic header', async () => {
    const r = await req(PROTECTED)
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'unauthorized' })
    expect(r.headers.get('www-authenticate')).toMatch(/^Basic\b/i)
  })

  it('Authorization: Bearer <token> is allowed (not 401)', async () => {
    const r = await req(PROTECTED, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(r.status).not.toBe(401)
    expect(r.body).not.toEqual({ error: 'unauthorized' })
  })

  it('Authorization: Basic <anyuser:token> is allowed (issue #136 branch)', async () => {
    const r = await req(PROTECTED, { headers: { authorization: basicAuth('anyuser', TOKEN) } })
    expect(r.status).not.toBe(401)
    expect(r.body).not.toEqual({ error: 'unauthorized' })
  })

  it('X-Mivo-Bff-Token: <token> is allowed', async () => {
    const r = await req(PROTECTED, { headers: { 'x-mivo-bff-token': TOKEN } })
    expect(r.status).not.toBe(401)
  })

  it('Basic Auth with wrong password → 401', async () => {
    const r = await req(PROTECTED, { headers: { authorization: basicAuth('anyuser', 'wrong') } })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toMatch(/^Basic\b/i)
  })

  it('Bearer with wrong token → 401', async () => {
    const r = await req(PROTECTED, { headers: { authorization: 'Bearer wrong-token' } })
    expect(r.status).toBe(401)
  })

  it('malformed Basic (no colon / bad base64) → 401, never 500', async () => {
    const r1 = await req(PROTECTED, { headers: { authorization: 'Basic !!!notbase64!!!' } })
    expect(r1.status).toBe(401)
    const r2 = await req(PROTECTED, {
      headers: { authorization: 'Basic ' + Buffer.from('nocolonhere').toString('base64') },
    })
    expect(r2.status).toBe(401)
  })

  it('/api/mivo/tasks/* is protected (prefix match)', async () => {
    const r = await req('/api/mivo/tasks/some-id')
    expect(r.status).toBe(401)
  })

  it('/api/keys/* is protected (E2 seam)', async () => {
    const r = await req('/api/keys/test')
    expect(r.status).toBe(401)
  })
})

describe('Access gate — no-op when unconfigured (local dev parity)', () => {
  const PROTECTED = '/api/mivo/generate'
  beforeEach(() => {
    delete process.env.MIVO_BFF_TOKEN
    delete process.env.JWT_SECRET
  })

  it('no MIVO_BFF_TOKEN and no JWT_SECRET → protected path not 401 (no-op)', async () => {
    const r = await req(PROTECTED)
    expect(r.status).not.toBe(401)
  })
})
