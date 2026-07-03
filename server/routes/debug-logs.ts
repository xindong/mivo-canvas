import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import {
  appendRemoteDebugRecords,
  filterRemoteDebugRecords,
  normalizeRemoteDebugPayload,
  readRemoteDebugDates,
  readRemoteDebugRecords,
  remoteDebugRequestMeta,
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

const isOriginAllowed = (
  origin: string | undefined,
  allowed: { explicit: boolean; set: Set<string> },
): boolean => {
  if (!origin) return true // non-browser / same-origin request carries no Origin
  if (allowed.explicit) return allowed.set.has(origin)
  return LOCALHOST_ORIGIN.test(origin)
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
const rateBuckets = new Map<string, { count: number; windowStart: number }>()
const rateLimitExceeded = (ip: string, perMin: number): boolean => {
  if (perMin <= 0) return false
  const now = Date.now()
  const bucket = rateBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now })
    return false
  }
  bucket.count += 1
  return bucket.count > perMin
}

// Test hook: clear the rate-limit state between tests.
export const __resetDebugLogsRateLimit = (): void => {
  rateBuckets.clear()
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
  // D7: origin allowlist
  if (!isOriginAllowed(c.req.header('origin'), getAllowedOrigins())) {
    return c.json({ ok: false, error: 'Origin not allowed' }, 403)
  }
  // D7: rate limit (per IP from X-Forwarded-For, fallback 'unknown')
  const ip = (c.req.header('x-forwarded-for') ?? 'unknown').split(',')[0].trim()
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
