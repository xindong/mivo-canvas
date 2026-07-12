import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Hono } from 'hono'
import { debugLogsRoute, __resetDebugLogsRateLimit, __debugLogsBucketCount, __seedDebugLogsBucket } from './debug-logs'
import { remoteDebugLogDir, remoteDebugFilePath } from '../lib/debug-records'
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

// ── G2.1 R2-4:debug-logs 防滥用(rate key 可信来源 + bucket 淘汰 + quota/retention + 生产 Origin 硬前置)──
// 返修前漏洞(F6 第二轮):rate key 取客户端可控 XFF 首项(rate=1 时轮换 XFF 三连 200 绕过);无 Origin
// 无条件放行 + localhost 兜底(生产未配 allowlist 时任意 Origin/无 Origin 放行);rateBuckets 无淘汰
// (内存无限增长);JSONL 无 quota/retention(磁盘耗尽)。R2-4 修复 + 负例锁定防回归。
describe('debug-logs route — R2-4: rate key 可信来源 + bucket 淘汰 + quota/retention + 生产 Origin 硬前置', () => {
  const R24_ENV = [
    'MIVO_DEBUG_TRUST_XFF', 'MIVO_DEBUG_DISK_QUOTA_MB', 'MIVO_DEBUG_RETENTION_DAYS',
    'MIVO_DEBUG_RATE_MAX_BUCKETS', 'NODE_ENV', 'MIVO_PUBLIC',
    'MIVO_DEBUG_ALLOWED_ORIGINS', 'MIVO_DEBUG_POST_RATE_LIMIT',
  ]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const n of R24_ENV) saved[n] = process.env[n]
    delete process.env.MIVO_DEBUG_TRUST_XFF
    delete process.env.MIVO_DEBUG_DISK_QUOTA_MB
    delete process.env.MIVO_DEBUG_RETENTION_DAYS
    delete process.env.MIVO_DEBUG_RATE_MAX_BUCKETS
    delete process.env.NODE_ENV
    delete process.env.MIVO_PUBLIC
    delete process.env.MIVO_DEBUG_ALLOWED_ORIGINS
    delete process.env.MIVO_DEBUG_POST_RATE_LIMIT
    __resetDebugLogsRateLimit()
  })
  afterEach(() => {
    for (const n of R24_ENV) {
      if (saved[n] === undefined) delete process.env[n]
      else process.env[n] = saved[n]
    }
    __resetDebugLogsRateLimit()
  })

  // ── R2-4-1:rate key 默认不信任 XFF(用 socket remote addr;in-process 无 socket → 'unknown' 同 bucket)──
  it('默认不信任 XFF:rate=1 + 轮换 XFF 三连 → r1=200, r2/r3=429(XFF 轮换不绕过;remote addr 同 bucket)', async () => {
    process.env.MIVO_DEBUG_POST_RATE_LIMIT = '1'
    const r1 = await postEntry({ 'x-forwarded-for': '1.1.1.1' })
    const r2 = await postEntry({ 'x-forwarded-for': '2.2.2.2' })
    const r3 = await postEntry({ 'x-forwarded-for': '3.3.3.3' })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(429) // 返修前三连 200(XFF 轮换绕过 rate);修复后同 'unknown' bucket → 429
    expect(r3.status).toBe(429)
  })

  it('MIVO_DEBUG_TRUST_XFF=1(opt-in):rate=1 + 不同 XFF → 各 200(网关已清洗 XFF,信任首项 → 不同 bucket)', async () => {
    process.env.MIVO_DEBUG_POST_RATE_LIMIT = '1'
    process.env.MIVO_DEBUG_TRUST_XFF = '1'
    const r1 = await postEntry({ 'x-forwarded-for': '1.1.1.1' })
    const r2 = await postEntry({ 'x-forwarded-for': '2.2.2.2' })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200) // opt-in 信任 XFF 首项 → 不同 bucket → 各 200(网关清洗后可接受)
  })

  // ── R2-4-2:bucket 淘汰(防内存无限增长;返修前无淘汰)──
  it('bucket 淘汰:超 MAX_BUCKETS 时 lazy sweep 窗外 stale 项(bounded memory)', async () => {
    process.env.MIVO_DEBUG_RATE_MAX_BUCKETS = '3'
    const stale = Date.now() - 120_000 // 2 分钟前(RATE_LIMIT_WINDOW_MS=60s,窗外)
    for (let i = 0; i < 4; i++) __seedDebugLogsBucket(`stale-${i}`, stale)
    expect(__debugLogsBucketCount()).toBe(4)
    await postEntry() // 触发 rateLimitExceeded → size>MAX → sweep stale
    expect(__debugLogsBucketCount()).toBe(1) // 4 stale 全窗外被删;新增 'unknown' bucket
  })

  it('bucket 淘汰只删窗外 stale,保留窗内项(未过期不淘汰)', async () => {
    process.env.MIVO_DEBUG_RATE_MAX_BUCKETS = '3'
    __seedDebugLogsBucket('fresh-1', Date.now()) // 窗内
    const stale = Date.now() - 120_000
    __seedDebugLogsBucket('stale-1', stale)
    __seedDebugLogsBucket('stale-2', stale)
    __seedDebugLogsBucket('stale-3', stale)
    await postEntry() // size=4>3 → sweep:删 3 stale,保留 fresh-1;set 'unknown' → 2
    expect(__debugLogsBucketCount()).toBe(2) // fresh-1(窗内保留)+ unknown(新)
  })

  // ── R2-4-3:磁盘 quota 超限 → 413(返修前无 quota,磁盘可被耗尽)──
  it('磁盘 quota 超限(append 前 size>=quota)→ 413 DebugLogQuotaExceededError', async () => {
    process.env.MIVO_DEBUG_DISK_QUOTA_MB = '1' // quota=1MB
    await mkdir(remoteDebugLogDir(), { recursive: true })
    await writeFile(remoteDebugFilePath(), Buffer.alloc(2 * 1024 * 1024, 0x61)) // 2MB > 1MB quota
    const res = await postEntry()
    expect(res.status).toBe(413)
    expect((await json(res)).error).toBe('Debug log disk quota exceeded')
  })

  it('磁盘 quota 未超 → 200(quota 不阻断正常 append)', async () => {
    process.env.MIVO_DEBUG_DISK_QUOTA_MB = '100' // 100MB,远大于单次 append
    const res = await postEntry()
    expect(res.status).toBe(200)
  })

  // ── R2-4-4:retention sweep 过期 .jsonl(返修前无 retention,JSONL 无限堆积)──
  it('retention sweep:append 前删除过期 .jsonl(早于 today - retentionDays)', async () => {
    process.env.MIVO_DEBUG_RETENTION_DAYS = '7'
    await mkdir(remoteDebugLogDir(), { recursive: true })
    const oldDateStr = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await writeFile(remoteDebugFilePath(oldDateStr), 'old-data')
    const res = await postEntry() // append 触发 sweep
    expect(res.status).toBe(200)
    const files = await readdir(remoteDebugLogDir())
    expect(files).not.toContain(`${oldDateStr}.jsonl`) // 过期文件被删
  })

  it('retention 不删窗内文件(retentionDays 内保留)', async () => {
    process.env.MIVO_DEBUG_RETENTION_DAYS = '7'
    await mkdir(remoteDebugLogDir(), { recursive: true })
    const recentDateStr = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await writeFile(remoteDebugFilePath(recentDateStr), 'recent-data')
    await postEntry()
    const files = await readdir(remoteDebugLogDir())
    expect(files).toContain(`${recentDateStr}.jsonl`) // 窗内保留
  })

  // ── R2-4-5:生产 Origin 硬前置(返修前"无 Origin 无条件放行"+"localhost 兜底"让生产放行)──
  it('生产(MIVO_PUBLIC=1)+ 无 allowlist → POST 拒(无 localhost 兜底;返修前 localhost 兜底放行)', async () => {
    process.env.MIVO_PUBLIC = '1'
    const res = await postEntry() // 无 allowlist,无 Origin
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Origin not allowed')
  })

  it('生产 + 有 allowlist + 无 Origin → 拒(浏览器必带 Origin;返修前无 Origin 无条件放行)', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.MIVO_DEBUG_ALLOWED_ORIGINS = 'https://app.example'
    const res = await postEntry() // 无 Origin
    expect(res.status).toBe(403)
  })

  it('生产 + 有 allowlist + 匹配 Origin → 200', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.MIVO_DEBUG_ALLOWED_ORIGINS = 'https://app.example'
    const res = await postEntry({ origin: 'https://app.example' })
    expect(res.status).toBe(200)
  })

  it('生产 + 有 allowlist + 不匹配 Origin → 拒', async () => {
    process.env.MIVO_PUBLIC = '1'
    process.env.MIVO_DEBUG_ALLOWED_ORIGINS = 'https://app.example'
    const res = await postEntry({ origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  it('生产(NODE_ENV=production)+ localhost Origin + 无 allowlist → 拒(isProdBoundary 另一分支)', async () => {
    process.env.NODE_ENV = 'production'
    const res = await postEntry({ origin: 'http://localhost:5173' }) // localhost 非生产放行,生产无 allowlist 拒
    expect(res.status).toBe(403)
  })

  // 非生产 dev compat 保留(零变化硬约束)
  it('非生产 + 无 Origin → 200(dev compat,零变化)', async () => {
    const res = await postEntry()
    expect(res.status).toBe(200)
  })

  it('非生产 + localhost Origin(无 allowlist)→ 200(localhost 兜底保留)', async () => {
    const res = await postEntry({ origin: 'http://localhost:5173' })
    expect(res.status).toBe(200)
  })
})
