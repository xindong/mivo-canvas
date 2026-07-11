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
import { Hono, type Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveFeatureFlags } from './lib/env'
import type { AppEnv } from './lib/types'
import { ssoAuthErrorHandler } from './lib/owner'
import { generateHandler } from './routes/generate'
import { editHandler } from './routes/edit'
import { enhanceHandler } from './routes/enhance'
import { describeRegionHandler } from './routes/describeRegion'
import { composeMaskEditHandler } from './routes/composeMaskEdit'
import { authRoute } from './routes/auth'
import { debugLogsRoute } from './routes/debug-logs'
import { createLocalAssetsRoutes } from './routes/local-assets'
import { createAssetRoutes } from './routes/assets'
import { createEagleRoutes } from './routes/eagle'
import { createPinterestRoutes } from './routes/pinterest'
import { createProxyImageRoutes } from './routes/proxy-image'
import { keysRoute } from './routes/keys'
import { tasksRoute } from './routes/tasks'
import { createProjectsRoutes } from './routes/projects'
import { createCanvasRoutes } from './routes/canvas'
import { createUserStateRoutes } from './routes/userState'
import { createMembersRoutes } from './routes/members'
import { createShareLinksRoutes, createShareAccessRoutes } from './routes/shareLinks'
import { createPersistBackend, type PersistBackend } from './persist/backend'
import { resolvePersistBackendConfig } from './persist/pgConfig'
import { createPermissionBackend, type PermissionBackend } from './lib/permissions'

const featureFlags = resolveFeatureFlags()

// T1.3: shared data-persistence backend. 默认 memory(生产零变化);MIVO_PERSIST_BACKEND=pg →
// PgPersistBackend(灰度启用,Kysely+PG16,信封列+jsonb;swap 不改路由/契约,见 docs/decisions/pg-backend-schema.md)。
// PG 启用但缺 MIVO_PG_PASSWORD → resolvePersistBackendConfig 抛错(fail visibly,不静默降级)。
// **动态 import PgPersistBackend**(Greptile P1:默认 memory 路径不加载 kysely——kysely engines node>=22,
// 动态加载使 memory 路径不依赖 kysely,部署 node<22 不影响默认路径)。
// Exported so tests driving the real `app` can __reset() between cases (同 __resetTaskRegistry)。
const persistBackendConfig = resolvePersistBackendConfig()
let sharedPersistBackend: PersistBackend
if (persistBackendConfig.kind === 'pg' && persistBackendConfig.pg) {
  // 仅 PG 启用时动态加载(避免 memory 路径加载 kysely)。
  const { PgPersistBackend } = await import('./persist/pgBackend')
  sharedPersistBackend = new PgPersistBackend(persistBackendConfig.pg)
} else {
  sharedPersistBackend = createPersistBackend()
}
export { sharedPersistBackend }

// T1.4: shared permission backend (project_members + share_links)。组合注入:权限后端选择随
// MIVO_PERSIST_BACKEND 同开关(pg → PgPermissionBackend 动态加载;默认 memory 生产零变化)。
// PG 启用时与 PgPersistBackend 共存(两者连同一 DB;各自跑 migrations,kysely_migration 追踪表幂等)。
// Exported so tests can __reset() between cases (同 sharedPersistBackend)。
let sharedPermissionBackend: PermissionBackend
if (persistBackendConfig.kind === 'pg' && persistBackendConfig.pg) {
  const { PgPermissionBackend } = await import('./persist/pgPermissionBackend')
  sharedPermissionBackend = new PgPermissionBackend(persistBackendConfig.pg)
} else {
  sharedPermissionBackend = createPermissionBackend()
}
export { sharedPermissionBackend }

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

// G2.1 (cutover §5): SSO auth error boundary (top-level onError). Catches
// SsoAuthError thrown by resolveActor / resolveTaskOwner / resolveAssetOwner inside
// any sub-app handler in strict mode (MIVO_SSO_STRICT=1: missing/wrong gateway
// secret·header → 401, NO fingerprint fallback) and returns 401. Inert in non-strict
// mode (default off → resolveActor never throws SsoAuthError → falls through to the
// default 500 path unchanged → production zero change). Covers all /api persistence
// routes (projects/canvas/userState/assets/tasks/members/shareLinks); stateless /api
// routes (generate/edit/keys) don't call resolveActor → never throw → unaffected.
app.onError(ssoAuthErrorHandler)

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
// T1.5: content-addressed asset store (POST /api/assets, GET /api/assets/:id).
// P1.4: mounted ONLY when MIVO_ENABLE_ASSET_SERVICE=1 (default off). The asset
// store writes user blobs to disk (root via MIVO_ASSET_STORE_DIR, default
// ~/.mivo-canvas/assets — outside the repo), so it requires explicit opt-in even
// on a local bind. Flag off → /api/assets 404 (both POST and GET; the explicit
// 404 stubs below keep a GET to the API path from falling through to the SPA
// fallback, which would otherwise serve index.html). Client gate ?assets=server
// controls usage; this flag controls whether the BFF serves at all. Storage
// backend is swappable for PG (T1.1); MIME allowlist (P1.3) + per-owner quota
// (P1.4) + owner-scoped GET (P2.5) live in the route.
if (featureFlags.assetServiceEnabled) {
  app.route('/api', createAssetRoutes())
} else {
  // Flag off → 404 for the asset endpoints (no SPA index.html for an API path).
  const assetDisabled = (c: Context<AppEnv>) => c.notFound()
  app.all('/api/assets', assetDisabled)
  app.all('/api/assets/*', assetDisabled)
}
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

// T1.3: data-persistence endpoints (stateful, owner-scoped). NOT under /api/mivo/*
// (those are stateless image-capability proxies). Mounted before serveStatic + SPA
// fallback so /api/* matches before the SPA history fallback. Owner scope via
// resolveOwner (FX-2 mivo-key fingerprint; §13.5 target = maker user id). Contract:
// docs/decisions/api-surface.md.
// T1.4: routes 接 sharedPermissionBackend(memberRole + sharePermission + per-action 矩阵);
// members / share-links 子资源同挂 /api/projects;公开分享入口挂 /api/share(无鉴权,token 驱动)。
app.route('/api/projects', createProjectsRoutes({ backend: sharedPersistBackend, permissions: sharedPermissionBackend }))
app.route('/api/projects', createMembersRoutes({ backend: sharedPersistBackend, permissions: sharedPermissionBackend }))
app.route('/api/projects', createShareLinksRoutes({ backend: sharedPersistBackend, permissions: sharedPermissionBackend }))
app.route('/api/canvas', createCanvasRoutes({ backend: sharedPersistBackend, permissions: sharedPermissionBackend }))
app.route('/api/user-state', createUserStateRoutes({ backend: sharedPersistBackend }))
// T1.4: 公开分享访问入口(GET /api/share/:token;无鉴权,token 驱动;revoked→410,unknown→404)。
app.route('/api/share', createShareAccessRoutes({ backend: sharedPersistBackend, permissions: sharedPermissionBackend }))

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
