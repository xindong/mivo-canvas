// @vitest-environment node
// server/__tests__/access-gate.test.ts
// Access gate (issue #136): when MIVO_BFF_TOKEN is set, the gate must accept
// HTTP Basic Auth (browser-native login prompt) in addition to the existing
// Bearer + X-Mivo-Bff-Token header paths, and return WWW-Authenticate: Basic on
// 401 so browsers pop the native login dialog for GET / (which cannot attach
// custom headers). Drives the real BFF (app + @hono/node-server); no mock
// upstream is needed because the gate runs before any route handler — for the
// "allowed" cases we only assert the gate did NOT return 401 (the downstream
// serveStatic/SPA-fallback response is irrelevant to the gate contract).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { app } from '../app'

const TOKEN = 'test-bff-token-xyz'

let bffServer: Server
let bffBase = ''
let savedToken: string | undefined

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
  process.env.MIVO_BFF_TOKEN = TOKEN
  await startServer()
})

afterAll(async () => {
  if (savedToken === undefined) delete process.env.MIVO_BFF_TOKEN
  else process.env.MIVO_BFF_TOKEN = savedToken
  await new Promise<void>((r) => bffServer.close(() => r()))
})

// The gate reads MIVO_BFF_TOKEN fresh on every request; pin it per test so
// ordering against other suites sharing the worker cannot drift the value.
beforeEach(() => {
  process.env.MIVO_BFF_TOKEN = TOKEN
})

describe('Access gate — Basic Auth branch (issue #136)', () => {
  it('Basic Auth with correct password (=token) is allowed (not 401)', async () => {
    const r = await req('/', { headers: { authorization: basicAuth('anyuser', TOKEN) } })
    expect(r.status).not.toBe(401)
    expect(r.body).not.toEqual({ error: 'unauthorized' })
  })

  it('Basic Auth with wrong password → 401 with WWW-Authenticate: Basic header', async () => {
    const r = await req('/', { headers: { authorization: basicAuth('anyuser', 'wrong-pass') } })
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'unauthorized' })
    expect(r.headers.get('www-authenticate')).toMatch(/^Basic\b/i)
  })

  it('malformed / no-colon / empty Basic value → 401, never 500', async () => {
    // Invalid base64 characters — Node decodes leniently (never throws), no
    // colon in the result → 401.
    const r1 = await req('/', { headers: { authorization: 'Basic !!!notbase64!!!' } })
    expect(r1.status).toBe(401)
    // Decodes to bytes without a colon → 401.
    const r2 = await req('/', {
      headers: { authorization: 'Basic ' + Buffer.from('nocolonhere').toString('base64') },
    })
    expect(r2.status).toBe(401)
    // Empty Basic payload → 401.
    const r3 = await req('/', { headers: { authorization: 'Basic ' } })
    expect(r3.status).toBe(401)
    // Garbage that is technically valid base64 but decodes to non-UTF8 with no
    // colon → still 401, not 500.
    const r4 = await req('/', { headers: { authorization: 'Basic %%%' } })
    expect(r4.status).toBe(401)
  })

  it('Authorization: Bearer <token> still allowed (regression guard)', async () => {
    const r = await req('/', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(r.status).not.toBe(401)
    expect(r.body).not.toEqual({ error: 'unauthorized' })
  })

  it('X-Mivo-Bff-Token: <token> still allowed (regression guard)', async () => {
    const r = await req('/', { headers: { 'x-mivo-bff-token': TOKEN } })
    expect(r.status).not.toBe(401)
    expect(r.body).not.toEqual({ error: 'unauthorized' })
  })

  it('no credentials → 401 with WWW-Authenticate: Basic header', async () => {
    const r = await req('/')
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'unauthorized' })
    expect(r.headers.get('www-authenticate')).toMatch(/^Basic\b/i)
  })
})
