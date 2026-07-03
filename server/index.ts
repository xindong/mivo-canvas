import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AppEnv } from './lib/types'
import { resolveFeatureFlags } from './lib/env'
import { requestIdMiddleware } from './lib/request-id'
import { createLocalAssetsRoutes } from './routes/local-assets'
import { createEagleRoutes } from './routes/eagle'
import { createPinterestRoutes } from './routes/pinterest'

// P1-a BFF skeleton + P1-c asset-group routes (local-assets / eagle / pinterest).
// Endpoint migration (P1-c) populates server/routes; this file wires them in.
// Generate-group (generate/edit/enhance) and debug-logs land in separate P1-c PRs.

const DIST_DIR = resolve(process.cwd(), 'dist')
const INDEX_HTML = resolve(DIST_DIR, 'index.html')

const PORT = Number(process.env.MIVO_PORT) || 8080
const PUBLIC_MODE = process.env.MIVO_PUBLIC === '1'
const BFF_TOKEN = process.env.MIVO_BFF_TOKEN?.trim() ?? ''
const HOSTNAME = PUBLIC_MODE ? '0.0.0.0' : '127.0.0.1'

// SC1.4 production safety model: local-assets and eagle/* default ON in local
// mode, OFF in public mode (MIVO_PUBLIC=1). Explicit MIVO_ENABLE_* overrides.
const featureFlags = resolveFeatureFlags()

// Production safety guard: binding on 0.0.0.0 without an access gate would
// expose the BFF (and the dist assets / future endpoints) to the public
// network. Refuse to start in that configuration.
if (PUBLIC_MODE && !BFF_TOKEN) {
  console.error(
    '[mivo-bff] FATAL: MIVO_PUBLIC=1 requires MIVO_BFF_TOKEN to be set. ' +
      'Refusing to bind on 0.0.0.0 without an access gate. ' +
      'Either set MIVO_BFF_TOKEN, or unset MIVO_PUBLIC to stay on 127.0.0.1.'
  )
  process.exit(1)
}

// Constant-time string compare to avoid a trivially exploitable token oracle.
// Length mismatch returns early; for a shared-secret gate this is acceptable
// (real authn/authz lands in P1-c via mivoserver).
const tokenEquals = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

const app = new Hono<AppEnv>()

// Per-request correlation id (header + log line). Registered before the access
// gate so every request — including 401s — gets an id. Logs only method/path/
// status/latency; never API keys, image blobs, or full prompts (roadmap §6.2).
app.use('*', requestIdMiddleware)

// Liveness probe. Exempt from the access gate so health checks work without
// authentication (load balancers, Docker HEALTHCHECK, curl /healthz).
app.get('/healthz', (c) => c.json({ status: 'ok' }))

// Access gate skeleton. No-op when MIVO_BFF_TOKEN is unset (dev/local).
// When set, every non-/healthz request must carry the token either as
// `Authorization: Bearer <token>` or `X-Mivo-Bff-Token: <token>`.
// 401 responses are sanitized — no token echo, no stack, no hint.
app.use('*', async (c, next) => {
  if (!BFF_TOKEN) return next()
  if (c.req.path === '/healthz') return next()
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? ''
  const custom = c.req.header('x-mivo-bff-token')?.trim() ?? ''
  const presented = bearer || custom
  if (!presented || !tokenEquals(presented, BFF_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

// ── P1-c asset-group routes ──────────────────────────────────────────────────
// Mounted under /api/mivo. local-assets and eagle/* are SC1.4-gated (default
// OFF in public mode, ON in local mode, explicit env overrides). pinterest is
// a public placeholder (no host-file access) and always on.
app.route('/api/mivo', createLocalAssetsRoutes({ enabled: featureFlags.localAssetsEnabled }))
app.route('/api/mivo', createEagleRoutes({ enabled: featureFlags.eagleProxyEnabled }))
app.route('/api/mivo', createPinterestRoutes())

// Same-origin static hosting of the Vite build output (dist/).
// serveStatic only accepts a root relative to cwd and calls next() when a
// file is missing, which lets the SPA fallback below serve index.html for
// client-side routes. Built-in path-traversal guard blocks `..` / `//`.
app.use('/*', serveStatic({ root: './dist' }))

// SPA history fallback: any non-file GET returns index.html so client-side
// routes (e.g. /debug-reports) resolve on a static BFF topology.
app.get('*', async (c) => {
  try {
    const html = await readFile(INDEX_HTML)
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(html)
  } catch {
    return c.json(
      {
        error: 'build_not_found',
        message: 'dist/index.html is missing. Run `npm run build` before starting the BFF.',
      },
      404
    )
  }
})

serve({ fetch: app.fetch, hostname: HOSTNAME, port: PORT }, (info) => {
  const bound = `${info.address}:${info.port}`
  const mode = PUBLIC_MODE ? 'public 0.0.0.0' : 'local 127.0.0.1'
  const gate = BFF_TOKEN ? 'token-gated' : 'open (no MIVO_BFF_TOKEN)'
  const assets = featureFlags.localAssetsEnabled ? 'on' : 'off'
  const eagle = featureFlags.eagleProxyEnabled ? 'on' : 'off'
  console.log(
    `[mivo-bff] listening on http://${bound} [${mode}, ${gate}] local-assets=${assets} eagle=${eagle}`
  )
})
