// server/app.ts
// Hono app: /healthz, access gate, P1-c routes (generate/edit/enhance),
// serveStatic(dist), SPA fallback. server/index.ts imports `app` and calls serve().
// Tests import `app` and drive it through a real @hono/node-server serve() so
// c.env.incoming/outgoing (HttpBindings) are populated exactly as in production.
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveFeatureFlags } from './lib/env'
import { getAuthConfig } from './lib/authConfig'
import { verifyAccessToken } from './lib/jwt'
import { isProtectedPath, isGateWhitelisted, AUTH_COOKIE_NAME } from './lib/authGate'
import type { AppEnv } from './lib/types'
import { generateHandler } from './routes/generate'
import { editHandler } from './routes/edit'
import { enhanceHandler } from './routes/enhance'
import { describeRegionHandler } from './routes/describeRegion'
import { composeMaskEditHandler } from './routes/composeMaskEdit'
import { authRoute } from './routes/auth'
import { debugLogsRoute } from './routes/debug-logs'
import { createLocalAssetsRoutes } from './routes/local-assets'
import { createEagleRoutes } from './routes/eagle'
import { createPinterestRoutes } from './routes/pinterest'
import { createProxyImageRoutes } from './routes/proxy-image'
import { keysRoute } from './routes/keys'
import { tasksRoute } from './routes/tasks'

const tokenEquals = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

// Extract a candidate token from the Authorization header. Supports two schemes:
//   - `Bearer <token>`            → returns the raw token
//   - `Basic <base64("user:pw")>` → returns the password (everything after the
//     first colon; the username is ignored, so a team member can type any name
//     plus the BFF token as the password)
// Returns '' for an absent header, an unrecognized scheme, malformed base64, or
// a decoded value with no colon — the gate then treats the request as unauthorized.
// Splits on the FIRST colon only so a token containing colons still compares equal.
const extractBearerToken = (authHeader: string | undefined): string => {
  const raw = authHeader?.trim() ?? ''
  if (!raw) return ''
  if (/^Basic\s+/i.test(raw)) {
    const encoded = raw.replace(/^Basic\s+/i, '').trim()
    if (!encoded) return ''
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8')
      const colonIdx = decoded.indexOf(':')
      if (colonIdx === -1) return ''
      return decoded.slice(colonIdx + 1)
    } catch {
      return ''
    }
  }
  if (/^Bearer\s+/i.test(raw)) {
    return raw.replace(/^Bearer\s+/i, '').trim()
  }
  // Unknown / unsupported scheme — ignore the header entirely.
  return ''
}

const featureFlags = resolveFeatureFlags()

export const app = new Hono<AppEnv>()

// Liveness probe — exempt from the access gate.
app.get('/healthz', (c) => c.json({ status: 'ok' }))

// Access gate (F7 · feat/auth-feishu-login, A-1/A-2 hardening). JWT cookie is
// the first-class credential; the original MIVO_BFF_TOKEN three schemes (Bearer
// / Basic / X-Mivo-Bff-Token) are retained as a compat / emergency channel.
//
//   - allow  : /healthz, /api/auth/* (whitelist), and any non-protected path
//   - guard  : default-deny /api/mivo/* + /api/keys/* (A-2: covers local-assets
//              / eagle / proxy-image too); exception /api/mivo/debug-logs (own auth)
//   - accept : valid mivo_auth cookie JWT (primary) OR MIVO_BFF_TOKEN scheme
//   - reject : 401 (frontend toasts "请登录" via mivoTaskClient 401 handler)
//   - A-1    : JWT_SECRET set but invalid base64 / decodes empty → fail-closed
//              401 on protected paths (startup also exits; this is defense-in-depth
//              for env mutated after start, e.g. tests). 一律 401, 不 fallback BFF token.
//   - no-op  : neither JWT_SECRET nor MIVO_BFF_TOKEN configured (local dev default)
app.use('*', async (c, next) => {
  const path = c.req.path
  if (isGateWhitelisted(path)) return next()

  const bffToken = process.env.MIVO_BFF_TOKEN?.trim() ?? ''
  const authCfg = getAuthConfig()
  const jwtSecret = authCfg.jwtSecretBytes

  // Public paths (canvas shell / static / SPA / debug-logs exception) always pass,
  // regardless of auth config state — app is usable without login.
  if (!isProtectedPath(path)) return next()

  // A-1: misconfigured JWT_SECRET (raw set but invalid) → fail-closed 401.
  // Supersedes the no-op + BFF-token fallback: a broken secret must never silently
  // open the gate. (Startup also aborts on this; gate is defense-in-depth.)
  if (authCfg.jwtSecretMisconfigured) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  // Neither configured (raw empty AND no BFF token) → no-op (local-dev parity).
  if (!jwtSecret && !bffToken) return next()

  // 1) JWT cookie — first-class citizen (A2: maker-issued HS256, shared JWT_SECRET).
  if (jwtSecret) {
    const token = getCookie(c, AUTH_COOKIE_NAME)
    if (token) {
      const payload = await verifyAccessToken(token, jwtSecret)
      if (payload) return next()
    }
  }

  // 2) MIVO_BFF_TOKEN compat/emergency channel (Bearer / Basic / X-Mivo-Bff-Token).
  if (bffToken) {
    const bearer = extractBearerToken(c.req.header('authorization'))
    const custom = c.req.header('x-mivo-bff-token')?.trim() ?? ''
    if ((bearer.length > 0 && tokenEquals(bearer, bffToken)) ||
        (custom.length > 0 && tokenEquals(custom, bffToken))) {
      return next()
    }
    c.header('WWW-Authenticate', 'Basic realm="mivo-canvas"')
    return c.json({ error: 'unauthorized' }, 401)
  }

  // JWT-only mode, no valid cookie → 401 (frontend shows login prompt).
  return c.json({ error: 'unauthorized' }, 401)
})

// Auth routes (login-url / callback / me / logout / dev-login). Whitelisted by
// the gate above (isGateWhitelisted matches /api/auth/*). E2 will mount
// /api/keys separately near the mivo routes — keep this mount isolated to
// minimise the app.ts route-mount merge seam.
app.route('/api/auth', authRoute)

// P1-c generate/edit/enhance routes. app.all lets each handler enforce POST-only
// (non-POST → 405 {error:'Method not allowed'}), matching dev middleware semantics
// exactly (dev checks request.method !== 'POST' inside each handler).
app.all('/api/mivo/generate', generateHandler)
app.all('/api/mivo/edit', editHandler)
app.all('/api/mivo/enhance', enhanceHandler)
app.all('/api/mivo/describe-region', describeRegionHandler)
app.all('/api/mivo/compose-mask-edit', composeMaskEditHandler)
app.route('/api/mivo', debugLogsRoute)
app.route('/api/mivo', createLocalAssetsRoutes({ enabled: featureFlags.localAssetsEnabled }))
app.route('/api/mivo', createEagleRoutes({ enabled: featureFlags.eagleProxyEnabled }))
app.route('/api/mivo', createPinterestRoutes())
// W3: CORS proxy for external images (readCanvasImageBlob fallback). SSRF-hardened.
app.route('/api/mivo', createProxyImageRoutes())

// P2-C1a: async task endpoints (additive — not in dev diff baseline).
// POST /tasks/generate|edit → 202 {taskId}; GET/DELETE /tasks/:id.
app.route('/api/mivo/tasks', tasksRoute)

// E2: gateway key probe — BFF proxies GET llm-proxy /v1/models so the browser
// never exposes the sk- key to CORS or upstream logs. Stateless (no DB); still
// protected by the access gate above (not in the /api/auth/* whitelist).
app.route('/api/keys', keysRoute)

// Same-origin static hosting of dist/ (Vite build output). serveStatic only
// accepts a root relative to cwd and calls next() on miss, letting the SPA
// fallback below serve index.html for client-side routes. Built-in traversal guard.
app.use('/*', serveStatic({ root: './dist' }))

// SPA history fallback: non-file GET → index.html.
app.get('*', async (c) => {
  try {
    const html = await readFile(resolve(process.cwd(), 'dist', 'index.html'))
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(html)
  } catch {
    return c.json(
      {
        error: 'build_not_found',
        message: 'dist/index.html is missing. Run `npm run build` before starting the BFF.',
      },
      404,
    )
  }
})
