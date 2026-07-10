// server/app.ts
// Hono app: /healthz, P1-c routes (generate/edit/enhance/describe-region/compose-mask-edit),
// serveStatic(dist), SPA fallback. server/index.ts imports `app` and calls serve().
// Tests import `app` and drive it through a real @hono/node-server serve() so
// c.env.incoming/outgoing (HttpBindings) are populated exactly as in production.
//
// Auth: SSO 网关方案(feat/auth-sso)—— 生产由 nginx 网关(auth.dsworks.cn)全包认证,
// app 无 auth gate。/api/auth/me 由网关提供(生产)或 dev 桩(本地,见 routes/auth.ts)。
// per-user key(X-Mivo-Api-Key)注入在各 route 内(rejectInvalidMivoApiKey/resolvePlatformCtx),
// 与 auth gate 无关,保留。
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveFeatureFlags } from './lib/env'
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

const featureFlags = resolveFeatureFlags()

export const app = new Hono<AppEnv>()

// Liveness probe.
app.get('/healthz', (c) => c.json({ status: 'ok' }))

// visual-diff token probe (env-gated): only when MIVO_VD_TOKEN is set, return it at
// /__vd_probe so scripts/visual-diff.mjs can confirm THIS BFF process is responding
// (not a stale one holding the port — strictPort makes the new BFF exit on EADDRINUSE,
// but an old process could still serve 200). Normal dev/prod has no token → falls through
// to serveStatic/SPA. Mounted before /api routes & SPA fallback so it matches first.
const vdProbeToken = process.env.MIVO_VD_TOKEN
if (vdProbeToken) {
  app.get('/__vd_probe', (c) => c.text(vdProbeToken))
}

// Auth routes — dev stub /api/auth/me only. Production /api/auth/me is provided by
// the SSO gateway (nginx intercepts); this mount is for local dev / e2e.
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
// never exposes the sk- key to CORS or upstream logs. Stateless (no DB).
// (SSO scheme: no app-level gate; production protected by the gateway.)
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
