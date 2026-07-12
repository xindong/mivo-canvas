import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import {
  appendRemoteDebugRecords,
  filterRemoteDebugRecords,
  normalizeRemoteDebugPayload,
  readRemoteDebugDates,
  readRemoteDebugRecords,
  remoteDebugRequestMeta,
  DebugLogQuotaExceededError,
  type RemoteDebugPayload,
} from '../lib/debug-records'

// /api/mivo/debug-logs — BFF route (P1-c Task A).
//
// Contract truth source: server/contracts/debug-logs.json. Behavior is field-
// equivalent to the dev middleware (vite.config.ts L419-L457) EXCEPT for the
// intended changes D1/D7/D8 (each has a test in debug-logs.route.test.ts):
//   D1 — POST body over limit returns a clean 413 (no request.destroy → no
//        ECONNRESET). The dev middleware tore down the socket mid-body.
//   D7 — POST adds an origin allowlist (MIVO_DEBUG_ALLOWED_ORIGINS, default
//        localhost) + an in-memory per-IP rate limit (MIVO_DEBUG_POST_RATE_LIMIT,
//        default 60/min) + the 1MB body limit.
//   D8 — GET is fail-closed in public mode: MIVO_PUBLIC=1 with no
//        MIVO_DEBUG_VIEW_TOKEN configured → GET always 403. Local mode keeps
//        dev compat (no token configured → open).
// All other shapes (200 {ok,accepted}, 403 token text, 405, filter params,
// default 7-day window, limit cap 1000) are migrated as-is for diff=0.
//
// Env is read per-request (like the dev middleware) so tests can vary it
// without module reset.

const MAX_BODY_BYTES = 1024 * 1024
const RATE_LIMIT_WINDOW_MS = 60_000
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

const getViewToken = (): string => process.env.MIVO_DEBUG_VIEW_TOKEN?.trim() ?? ''
const isPublicMode = (): boolean => process.env.MIVO_PUBLIC === '1'
// R2-4:生产边界 = MIVO_PUBLIC=1 或 NODE_ENV=production(mirror owner.ts validateSsoConfig)。
// 生产下 debug-logs POST Origin 硬前置(必须显式配 MIVO_DEBUG_ALLOWED_ORIGINS,无 localhost 兜底)。
const isProdBoundary = (): boolean =>
  process.env.MIVO_PUBLIC === '1' || process.env.NODE_ENV === 'production'

const getRateLimitPerMin = (): number => {
  const raw = process.env.MIVO_DEBUG_POST_RATE_LIMIT
  if (raw === undefined || raw === '') return 60
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 60
}

const getAllowedOrigins = (): { explicit: boolean; set: Set<string> } => {
  const raw = process.env.MIVO_DEBUG_ALLOWED_ORIGINS?.trim() ?? ''
  if (!raw) return { explicit: false, set: new Set() }
  const set = new Set(
    raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
  return { explicit: true, set }
}

// Constant-time string compare. Length mismatch returns early; acceptable for a
// shared-secret view gate (real authn lands in P4 via mivoserver).
const tokenEquals = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

// R3-F4(lead 裁定 e2e 红修复):同源判定 — Origin 的 host:port 与请求 Host 头一致即同源。
// 用 new URL(origin).host(默认端口 80/443 省略,与 Host 头约定一致)对比 c.req 的 Host 头。
// TLS 终止于网关时:浏览器 Origin=https://host,网关注入 Host=host(无端口)→ 仍匹配(默认端口归一)。
// 缺 Host 头(in-process 无 socket 等)→ 非同源 → 落跨域 allowlist(不冒充同源)。
const isSameOrigin = (origin: string, hostHeader: string | undefined): boolean => {
  if (!hostHeader) return false
  try {
    return new URL(origin).host === hostHeader
  } catch {
    return false
  }
}

const isOriginAllowed = (
  origin: string | undefined,
  allowed: { explicit: boolean; set: Set<string> },
  hostHeader: string | undefined,
): boolean => {
  // R2-4:生产硬前置 — 生产边界(MIVO_PUBLIC=1 或 NODE_ENV=production)。
  // R3-F4(lead 裁定):同源(Origin 与 Host 同源)默认放行(浏览器同源 POST 不需显式 allowlist);
  //   跨域才需 MIVO_DEBUG_ALLOWED_ORIGINS 显式配置;无 Origin 维持 fail-closed(浏览器 POST 必带 Origin;
  //   非浏览器生产不应打 debug POST)。返修前(R2-4)"无 allowlist 一律拒(含同源)"把同源浏览器 POST 也拒了
  //   → 客户端 debugLogger(remoteDebugReporter POST /api/mivo/debug-logs)写入全 403 → prod e2e
  //   debug/canvas-interactions/mask/mask-reflow 四场景红(console "Failed to load resource: 403")。
  if (isProdBoundary()) {
    if (!origin) return false // fail-closed:无 Origin 拒(浏览器 POST 必带 Origin;非浏览器生产不应打 debug POST)
    if (isSameOrigin(origin, hostHeader)) return true // 同源:默认放行(lead 裁定)
    if (allowed.explicit) return allowed.set.has(origin) // 跨域:需显式 allowlist
    return false // 跨域无 allowlist:拒
  }
  // 非生产:dev compat(无 Origin 放行 + localhost 兜底,原行为不变)
  if (!origin) return true // non-browser / same-origin request carries no Origin
  if (allowed.explicit) return allowed.set.has(origin)
  return LOCALHOST_ORIGIN.test(origin)
}

/**
 * R2-4:rate key 用可信来源(非客户端可控)。返修前取 XFF 首项 → 攻击者轮换 XFF 三连 200(rate=1 时绕过)。
 * - MIVO_DEBUG_TRUST_XFF=1 opt-in(网关清洗 XFF 后 ops 开 + 写入网关验收清单 §真实网关验收)→ 信任 XFF 首项;
 * - 默认关 → 用 socket remote addr(@hono/node-server c.env.incoming.socket.remoteAddress,非客户端可控),
 *   测试无 socket → 'unknown'。直连攻击者无法轮换 remote addr → rate 真实受限(网关后共享网关 IP,可接受)。
 *
 * R3-F3:返修前读 `incoming.remoteAddress`(@hono/node-server HttpBindings 无此属性,生产恒 undefined →
 * 全落 'unknown' 同 bucket → 60/min 后全局误限流)。正确路径是 `incoming.socket.remoteAddress`
 * (IncomingMessage.socket 是 net.Socket,remoteAddress 即客户端源 IP)。
 */
const getRateKey = (c: { req: { header: (n: string) => string | undefined } }, env: unknown): string => {
  if (process.env.MIVO_DEBUG_TRUST_XFF === '1') {
    const xff = c.req.header('x-forwarded-for') ?? 'unknown'
    return xff.split(',')[0].trim() || 'unknown'
  }
  const remote = (
    env as { incoming?: { socket?: { remoteAddress?: string } } } | null | undefined
  )?.incoming?.socket?.remoteAddress
  return remote || 'unknown'
}

const hasViewAccess = (
  headerToken: string | undefined,
  queryToken: string | undefined,
  viewToken: string,
  publicMode: boolean,
): boolean => {
  // D8: fail-closed in public mode without a configured view token.
  if (publicMode && !viewToken) return false
  // Local dev compat: no token configured → open (matches dev middleware).
  if (!viewToken) return true
  if (headerToken && tokenEquals(headerToken, viewToken)) return true
  if (queryToken && tokenEquals(queryToken, viewToken)) return true
  return false
}

// In-memory per-IP rate limit (D7). Single-process; resets if the BFF restarts.
// Acceptable for an internal anti-abuse gate; real rate limiting is P4.
// R2-4/R3-F3: bucket 淘汰。返修前 `size > max` 时扫窗外 stale(全 fresh 时无界增长;且 size==max 仍插入
// → max+1)。R3-F3 改:达上限且将插新 bucket → 先 lazy sweep 窗外 stale,仍超 → 确定性淘汰 oldest,
// 保证 size<=max。仅"插新 bucket"时淘汰(避免误删既有 ip 的 fresh bucket)。
const getMaxBuckets = (): number => {
  const raw = process.env.MIVO_DEBUG_RATE_MAX_BUCKETS
  if (raw === undefined || raw === '') return 4096
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4096
}
const rateBuckets = new Map<string, { count: number; windowStart: number }>()
const rateLimitExceeded = (ip: string, perMin: number): boolean => {
  if (perMin <= 0) return false
  const now = Date.now()
  const max = getMaxBuckets()
  const existing = rateBuckets.get(ip)
  const windowExpired = !existing || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS
  // R3-F3:将插新 bucket(window 过期/不存在)且达上限 → 确定性淘汰(保证 size<=max,无界增长堵住)。
  if (windowExpired && rateBuckets.size >= max) {
    // 先 lazy sweep 窗外 stale(bounded memory;合法回收过期 bucket)。
    for (const [k, b] of rateBuckets) {
      if (now - b.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k)
    }
    // 仍超(stale 不够删 / 全 fresh)→ 确定性淘汰 oldest(windowStart 最小),LRU-ish 保 size<=max。
    if (rateBuckets.size >= max) {
      let oldestKey: string | null = null
      let oldestStart = Number.POSITIVE_INFINITY
      for (const [k, b] of rateBuckets) {
        if (b.windowStart < oldestStart) {
          oldestStart = b.windowStart
          oldestKey = k
        }
      }
      if (oldestKey !== null) rateBuckets.delete(oldestKey)
    }
  }
  if (!existing || windowExpired) {
    rateBuckets.set(ip, { count: 1, windowStart: now })
    return false
  }
  existing.count += 1
  return existing.count > perMin
}

// Test hook: clear the rate-limit state between tests.
export const __resetDebugLogsRateLimit = (): void => {
  rateBuckets.clear()
}
// R2-4 test hook: bucket 数(测 lazy eviction bounded memory)。
export const __debugLogsBucketCount = (): number => rateBuckets.size
// R3-F3 test hook:bucket keys(测真实 socket remoteAddress → key='127.0.0.1' 非 'unknown')。
export const __debugLogsBucketKeys = (): string[] => [...rateBuckets.keys()]
// R2-4 test hook: 直接 seed 一个 bucket(测 eviction sweep 前的 stale 状态)。
export const __seedDebugLogsBucket = (key: string, windowStart: number, count = 1): void => {
  rateBuckets.set(key, { count, windowStart })
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large')
    this.name = 'RequestBodyTooLargeError'
  }
}

// D1: read the body with a hard byte ceiling. Content-Length fast path returns
// 413 without touching the body; the streaming path cancels the reader cleanly
// on overflow so the client receives a proper 413 response (no socket destroy).
const readJsonBody = async (req: Request): Promise<unknown> => {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) {
    throw new BodyTooLargeError()
  }
  const reader = req.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

export const debugLogsRoute = new Hono()

debugLogsRoute.post('/debug-logs', async (c) => {
  // D7: origin allowlist (R3-F4: 同源默认放行, 跨域需 allowlist)
  if (!isOriginAllowed(c.req.header('origin'), getAllowedOrigins(), c.req.header('host'))) {
    return c.json({ ok: false, error: 'Origin not allowed' }, 403)
  }
  // D7: rate limit (R2-4: rate key 用可信来源 — 默认 socket remote addr,不取客户端可控 XFF)
  const ip = getRateKey(c, c.env)
  if (rateLimitExceeded(ip, getRateLimitPerMin())) {
    return c.json({ ok: false, error: 'Too many requests' }, 429)
  }

  try {
    const payload = (await readJsonBody(c.req.raw)) as RemoteDebugPayload
    const meta = remoteDebugRequestMeta({ header: (n) => c.req.header(n) ?? undefined })
    const records = normalizeRemoteDebugPayload(payload, meta)
    await appendRemoteDebugRecords(records)
    return c.json({ ok: true, accepted: records.length })
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return c.json({ ok: false, error: 'Request body is too large' }, 413)
    }
    // R2-4:磁盘 quota 超限 → 413(对齐 body cap 语义;appendRemoteDebugRecords 抛 DebugLogQuotaExceededError)
    if (error instanceof DebugLogQuotaExceededError) {
      return c.json({ ok: false, error: 'Debug log disk quota exceeded' }, 413)
    }
    const message = error instanceof Error ? error.message : 'Unable to store debug logs'
    return c.json({ ok: false, error: message }, 400)
  }
})

debugLogsRoute.get('/debug-logs', async (c) => {
  if (!hasViewAccess(c.req.header('x-mivo-debug-token'), c.req.query('token'), getViewToken(), isPublicMode())) {
    return c.json({ ok: false, error: 'Debug report token required' }, 403)
  }

  const availableDates = await readRemoteDebugDates()
  const requestedDate = c.req.query('date') || ''
  // V01: validate the date query before it reaches the file-path layer.
  // readRemoteDebugRecords → remoteDebugFilePath does resolve(logDir, `${date}.jsonl`),
  // so an unchecked `../../../etc/passwd` style value would traverse out of the
  // log dir. Lock to YYYY-MM-DD; reject anything else with 400.
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return c.json({ ok: false, error: 'Invalid date format (expected YYYY-MM-DD)' }, 400)
  }
  const dates = requestedDate ? [requestedDate] : availableDates.slice(0, 7)
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000)
  const records = filterRemoteDebugRecords(await readRemoteDebugRecords(dates), {
    level: c.req.query('level') || undefined,
    clientId: c.req.query('clientId') || undefined,
    sessionId: c.req.query('sessionId') || undefined,
    query: c.req.query('q') || undefined,
  })
    .sort((left, right) => Date.parse(right.receivedAt || '') - Date.parse(left.receivedAt || ''))
    .slice(0, limit)

  return c.json({ ok: true, dates: availableDates, records })
})

// Non-POST/GET → 405 (matches dev middleware L456).
debugLogsRoute.all('/debug-logs', (c) => c.json({ ok: false, error: 'Method not allowed' }, 405))
