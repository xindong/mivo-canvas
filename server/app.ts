// server/app.ts
// Hono app: /healthz, access gate, P1-c routes (generate/edit/enhance),
// serveStatic(dist), SPA fallback. server/index.ts imports `app` and calls serve().
// Tests import `app` and drive it through a real @hono/node-server serve() so
// c.env.incoming/outgoing (HttpBindings) are populated exactly as in production.
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveFeatureFlags } from './lib/env'
import type { AppEnv } from './lib/types'
import { generateHandler } from './routes/generate'
import { editHandler } from './routes/edit'
import { enhanceHandler } from './routes/enhance'
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

// Access gate. No-op when MIVO_BFF_TOKEN is unset; otherwise every non-/healthz
// request must carry one of three credentials, any of which matches the token:
//   - Authorization: Bearer <token>           (programmatic clients)
//   - Authorization: Basic <base64("user:token")>  (browser address bar / native login prompt — issue #136)
//   - X-Mivo-Bff-Token: <token>               (programmatic clients)
// Browsers cannot attach custom headers to a plain GET /, so without the Basic
// branch the gate 401s the very first page load. On 401 we emit
// WWW-Authenticate: Basic so the browser pops its native login dialog. 401
// responses are sanitized (no token echo / stack).
app.use('*', async (c, next) => {
  const bffToken = process.env.MIVO_BFF_TOKEN?.trim() ?? ''
  if (!bffToken) return next()
  if (c.req.path === '/healthz') return next()
  const bearer = extractBearerToken(c.req.header('authorization'))
  const custom = c.req.header('x-mivo-bff-token')?.trim() ?? ''
  const authorized =
    (bearer.length > 0 && tokenEquals(bearer, bffToken)) ||
    (custom.length > 0 && tokenEquals(custom, bffToken))
  if (!authorized) {
    c.header('WWW-Authenticate', 'Basic realm="mivo-canvas"')
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

// P1-c generate/edit/enhance routes. app.all lets each handler enforce POST-only
// (non-POST → 405 {error:'Method not allowed'}), matching dev middleware semantics
// exactly (dev checks request.method !== 'POST' inside each handler).
app.all('/api/mivo/generate', generateHandler)
app.all('/api/mivo/edit', editHandler)
app.all('/api/mivo/enhance', enhanceHandler)
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
