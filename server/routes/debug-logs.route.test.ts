import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Hono } from 'hono'
import { debugLogsRoute, __resetDebugLogsRateLimit } from './debug-logs'
import { ssoAuthErrorHandler } from '../lib/owner'
import type { AppEnv } from '../lib/types'

// In-process route tests via Hono's app.request() (no server, no ECONNRESET).
// Covers the migrated shapes + the D1/D7/D8 intended changes.

const TOKEN = ['test', 'token'].join('-')
let logDir: string
const savedEnv: Record<string, string | undefined> = {}

const saveEnv = (names: string[]) => {
  for (const n of names) savedEnv[n] = process.env[n]
}
const restoreEnv = (names: string[]) => {
  for (const n of names) {
    if (savedEnv[n] === undefined) delete process.env[n]
    else process.env[n] = savedEnv[n]
  }
}
const ENV_NAMES = ['MIVO_DEBUG_LOG_DIR', 'MIVO_DEBUG_VIEW_TOKEN', 'MIVO_PUBLIC', 'MIVO_DEBUG_ALLOWED_ORIGINS', 'MIVO_DEBUG_POST_RATE_LIMIT']

beforeEach(async () => {
  saveEnv(ENV_NAMES)
  logDir = await mkdtemp(join(tmpdir(), 'mivo-debug-route-'))
  process.env.MIVO_DEBUG_LOG_DIR = logDir
  delete process.env.MIVO_DEBUG_VIEW_TOKEN
  delete process.env.MIVO_PUBLIC
  delete process.env.MIVO_DEBUG_ALLOWED_ORIGINS
  delete process.env.MIVO_DEBUG_POST_RATE_LIMIT
  __resetDebugLogsRateLimit()
})

afterEach(async () => {
  restoreEnv(ENV_NAMES)
  if (logDir) await rm(logDir, { recursive: true, force: true })
  __resetDebugLogsRateLimit()
})

type JsonBody = { ok?: boolean; accepted?: number; error?: string; dates?: unknown[]; records?: unknown[] }
const json = async (res: Response): Promise<JsonBody> => (await res.json()) as JsonBody
const jsonBody = (obj: unknown): string => JSON.stringify(obj)

const request = (method: string, body?: string | Buffer | Uint8Array, headers: Record<string, string> = {}) =>
  debugLogsRoute.request('/debug-logs', { method, headers, body })

const postEntry = (extraHeaders: Record<string, string> = {}) =>
  request('POST', jsonBody({ entries: [{ level: 'warning', source: 'S', message: 'm', timestamp: 1 }] }), { 'content-type': 'application/json', ...extraHeaders })

describe('debug-logs route — migrated shapes (diff=0 vs dev baseline)', () => {
  it('POST valid payload → 200 {ok,accepted}', async () => {
    const res = await postEntry()
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, accepted: 1 })
  })

  it('POST filters to warning/error (log dropped, accepted=2)', async () => {
    const res = await request('POST', jsonBody({ entries: [{ level: 'log', source: 'A', message: 'drop', timestamp: 1 }, { level: 'warning', source: 'B', message: 'keep', timestamp: 2 }, { level: 'error', source: 'C', message: 'keep', timestamp: 3 }] }), { 'content-type': 'application/json' })
    expect(res.status).toBe(200)
    expect((await json(res)).accepted).toBe(2)
  })

  it('POST invalid JSON → 400 {ok:false,error}', async () => {
    const res = await request('POST', '{not json', { 'content-type': 'application/json' })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
  })

  it('GET without token in local mode (no token configured) → 200 open', async () => {
    await postEntry()
    const res = await request('GET')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.dates)).toBe(true)
    expect(Array.isArray(body.records)).toBe(true)
  })

  it('GET with token configured but no token sent → 403', async () => {
    process.env.MIVO_DEBUG_VIEW_TOKEN = TOKEN
    const res = await request('GET')
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({ ok: false, error: 'Debug report token required' })
  })

  it('GET with token via header → 200', async () => {
    process.env.MIVO_DEBUG_VIEW_TOKEN = TOKEN
    await request('POST', jsonBody({ entries: [{ level: 'error', source: 'S', message: 'm', timestamp: 1 }] }), { 'content-type': 'application/json' })
    const res = await request('GET', undefined, { 'x-mivo-debug-token': TOKEN })
    expect(res.status).toBe(200)
  })

  it('GET with token via query → 200', async () => {
    process.env.MIVO_DEBUG_VIEW_TOKEN = TOKEN
    await request('POST', jsonBody({ entries: [{ level: 'error', source: 'S', message: 'm', timestamp: 1 }] }), { 'content-type': 'application/json' })
    const res = await debugLogsRoute.request(`/debug-logs?token=${encodeURIComponent(TOKEN)}`, { method: 'GET' })
    expect(res.status).toBe(200)
  })

  it('PUT → 405 {ok:false,error:"Method not allowed"}', async () => {
    const res = await request('PUT')
    expect(res.status).toBe(405)
    expect(await json(res)).toEqual({ ok: false, error: 'Method not allowed' })
  })
})

describe('debug-logs route — D1: clean 413 (no ECONNRESET)', () => {
  it('POST body >1MB (Content-Length fast path) → 413', async () => {
    const big = Buffer.alloc(1.1 * 1024 * 1024, 0x61)
    const res = await request('POST', big, { 'content-type': 'application/json', 'content-length': String(big.length) })
    expect(res.status).toBe(413)
    expect(await json(res)).toEqual({ ok: false, error: 'Request body is too large' })
  })

  it('POST streaming body >1MB (no Content-Length) → 413', async () => {
    const big = Buffer.alloc(1.1 * 1024 * 1024, 0x61)
    const res = await request('POST', big, { 'content-type': 'application/json' })
    expect(res.status).toBe(413)
    expect((await json(res)).error).toBe('Request body is too large')
  })
})

describe('debug-logs route — D7: origin allowlist + rate limit', () => {
  it('POST with disallowed Origin → 403', async () => {
    const res = await postEntry({ origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Origin not allowed')
  })

  it('POST with localhost Origin (default allowlist) → 200', async () => {
    const res = await postEntry({ origin: 'http://localhost:5173' })
    expect(res.status).toBe(200)
  })

  it('POST with explicit allowed origin → 200; localhost now excluded → 403', async () => {
    process.env.MIVO_DEBUG_ALLOWED_ORIGINS = 'https://app.example,http://app2.example'
    const ok = await postEntry({ origin: 'https://app.example' })
    expect(ok.status).toBe(200)
    __resetDebugLogsRateLimit()
    const bad = await postEntry({ origin: 'http://localhost:5173' })
    expect(bad.status).toBe(403)
  })

  it('POST rate limit exceeded → 429', async () => {
    process.env.MIVO_DEBUG_POST_RATE_LIMIT = '2'
    const r1 = await postEntry()
    const r2 = await postEntry()
    const r3 = await postEntry()
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(429)
    expect((await json(r3)).error).toBe('Too many requests')
  })

  it('POST rate limit disabled (0) → never 429', async () => {
    process.env.MIVO_DEBUG_POST_RATE_LIMIT = '0'
    for (let i = 0; i < 5; i++) {
      const res = await postEntry()
      expect(res.status).toBe(200)
    }
  })
})

describe('debug-logs route — D8: fail-closed in public mode', () => {
  it('public mode + no view token configured → GET 403 even with a token sent', async () => {
    process.env.MIVO_PUBLIC = '1'
    const res = await request('GET', undefined, { 'x-mivo-debug-token': 'anything' })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Debug report token required')
  })

  it('public mode + view token configured → GET requires the token (header)', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.MIVO_DEBUG_VIEW_TOKEN = TOKEN
    await request('POST', jsonBody({ entries: [{ level: 'error', source: 'S', message: 'm', timestamp: 1 }] }), { 'content-type': 'application/json', 'x-mivo-debug-token': TOKEN })
    const noToken = await request('GET')
    expect(noToken.status).toBe(403)
    const withToken = await request('GET', undefined, { 'x-mivo-debug-token': TOKEN })
    expect(withToken.status).toBe(200)
  })
})

describe('debug-logs route — G2.1 F6: strict SSO 下 system-scoped(不被 SSO 门控,独立防护仍生效)', () => {
  // F6:debug-logs 是 system-scoped 遥测,不经 resolveActor,不被 ssoAuthBoundary 门控。
  // 镜像 app.ts(顶层 onError(ssoAuthErrorHandler) + 挂 debugLogsRoute under /api/mivo)+ strict env:
  // POST 无 gateway proof 仍 200(非 401)→ 证明它不在 owner-scoped SSO 门内;独立防护(origin/rate/public)
  // strict 下继续生效(403,非 401)。选型 + matrix 见 docs/runbook/g21-strict-sso-runbook.md §route security matrix。
  const SSO_ENV = ['MIVO_SSO_STRICT', 'MIVO_GATEWAY_SECRET']
  let strictApp: Hono<AppEnv>
  beforeEach(() => {
    saveEnv(SSO_ENV)
    strictApp = new Hono<AppEnv>()
    strictApp.onError(ssoAuthErrorHandler)
    strictApp.route('/api/mivo', debugLogsRoute)
    process.env.MIVO_SSO_STRICT = '1'
    process.env.MIVO_GATEWAY_SECRET = 'gw-strict-secret'
    __resetDebugLogsRateLimit()
  })
  afterEach(() => {
    restoreEnv(SSO_ENV)
    __resetDebugLogsRateLimit()
  })

  it('strict + 无 gateway proof + POST debug-logs → 200(非 401;system-scoped,不经 resolveActor)', async () => {
    const res = await strictApp.request('/api/mivo/debug-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ entries: [{ level: 'warning', source: 'S', message: 'm', timestamp: 1 }] }),
    })
    expect(res.status).toBe(200)
    expect((await json(res)).accepted).toBe(1)
  })

  it('strict + 无 gateway proof + GET debug-logs(local 无 token)→ 200(system-scoped,非 401)', async () => {
    await strictApp.request('/api/mivo/debug-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ entries: [{ level: 'error', source: 'S', message: 'm', timestamp: 1 }] }),
    })
    const res = await strictApp.request('/api/mivo/debug-logs', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
  })

  it('strict + 独立防护仍生效:disallowed Origin → 403(非 401;system-scoped 独立防护)', async () => {
    const res = await strictApp.request('/api/mivo/debug-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: jsonBody({ entries: [{ level: 'warning', source: 'S', message: 'm', timestamp: 1 }] }),
    })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Origin not allowed')
  })

  it('strict + public + 无 view token → GET 403(D8 public fail-closed,非 SSO 401)', async () => {
    process.env.MIVO_PUBLIC = '1'
    const res = await strictApp.request('/api/mivo/debug-logs', { method: 'GET' })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Debug report token required')
  })
})
