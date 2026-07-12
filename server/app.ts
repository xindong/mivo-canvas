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
import { computeReadiness } from './lib/readiness'
import type { AppEnv } from './lib/types'
import { ssoAuthErrorHandler, createSsoStrictProofGate, hasSubresourceId } from './lib/owner'
import { generateHandler } from './routes/generate'
import { editHandler } from './routes/edit'
import { enhanceHandler } from './routes/enhance'
import { describeRegionHandler } from './routes/describeRegion'
import { composeMaskEditHandler } from './routes/composeMaskEdit'
import { authRoute } from './routes/auth'
import { debugLogsRoute } from './routes/debug-logs'
import { createLocalAssetsRoutes } from './routes/local-assets'
import { createAssetRoutes } from './routes/assets'
import { createAssetStore, createFsAssetBackend, resolveAssetStoreDir, type AssetStore } from './lib/assetStore'
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

// T1.3 + T1.4: shared persist/permission backends。默认 memory(生产零变化);MIVO_PERSIST_BACKEND=pg →
// PgPersistBackend + PgPermissionBackend(动态加载,避免 memory 路径加载 kysely)。
// **F2 返修**:persist + permission **共享同一个 pg Pool**(单预算 = maxConnections,非各自 max 叠加;
// 旧实现两 backend 各 max=10 → 实际预算 20,超 PG 配额风险 + permission pool 无 connectionTimeoutMillis)。
// 两 backend 连同一 DB;migrations 各自跑(kysely_migration 追踪表幂等)。Pool 生命周期归 app——
// backends 的 destroy() 在 shared 时不销毁 pool(app 退出即释放)。
// PG 启用但缺 MIVO_PG_PASSWORD → resolvePersistBackendConfig 抛错(fail visibly,不静默降级 memory)。
let sharedPersistBackend: PersistBackend
let sharedPermissionBackend: PermissionBackend
if (persistBackendConfig.kind === 'pg' && persistBackendConfig.pg) {
  const { PgPersistBackend } = await import('./persist/pgBackend')
  const { PgPermissionBackend } = await import('./persist/pgPermissionBackend')
  const { Pool } = await import('pg')
  const conn = persistBackendConfig.pg
  // F2:共享 Pool——单预算 + connectionTimeoutMillis(两 backend 都受排队超时保护)。
  const sharedPool = new Pool({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    max: conn.maxConnections,
    idleTimeoutMillis: conn.idleTimeoutMs,
    connectionTimeoutMillis: conn.connectionTimeoutMs ?? 5000,
  })
  sharedPersistBackend = new PgPersistBackend(conn, sharedPool)
  sharedPermissionBackend = new PgPermissionBackend(conn, sharedPool)
} else {
  sharedPersistBackend = createPersistBackend()
  sharedPermissionBackend = createPermissionBackend()
}
export { sharedPersistBackend }
export { sharedPermissionBackend }

export const app = new Hono<AppEnv>()

// Liveness probe.
// G1-a R2 F3:暴露 persist readiness(backend kind + durable 标志)。不泄密(backend kind 非敏感)。
// 客户端 bootPersistWiring 在 server 模式据此 fail-closed:memory 后端不发业务写、不删 durable 记录
// (防 pm2 重启后“成功保存”假象);pg ready 才 hydrate + start queue;readiness 失败同样 fail-closed。
const persistDurable = persistBackendConfig.kind === 'pg'
app.get('/healthz', (c) =>
  c.json({ status: 'ok', persist: { backend: persistBackendConfig.kind, durable: persistDurable } }),
)

// P0.3 Readiness probe(区别于 /healthz 的 liveness):/healthz 只表"进程活",
// /readyz 表"依赖此刻可用"——PG persist + permission 连接(SELECT 1)+ asset dir 可写。任一 fail → 503
// (部署/网关据此摘流量,不把请求打到半挂的 BFF)。pm2/deploy 可探测;响应体带各 check 诊断 reason。
// F2 返修:同时探活 permission DB(此前只 ping persist,permission pool 耗尽/DB 挂不被发现)。
// persist + permission 共享同一 pg Pool(F2);memory 恒 ok。assetDir 仅 asset service 启用时探写(service 关=skipped)。
// F7 返修:503 响应体只回稳定 reason code(不暴露绝对路径/原始 Error);细节进 pm2 err.log(见 readiness.ts)。
app.get('/readyz', async (c) => {
  const report = await computeReadiness({
    persist: sharedPersistBackend,
    persistKind: persistBackendConfig.kind === 'pg' ? 'pg' : 'memory',
    permission: sharedPermissionBackend,
    permissionKind: persistBackendConfig.kind === 'pg' ? 'pg' : 'memory',
    assetDir: resolveAssetStoreDir(),
    assetEnabled: featureFlags.assetServiceEnabled,
  })
  return c.json(report, report.status === 'ok' ? 200 : 503)
})

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
// default 500 path unchanged → production zero change). F5 返修:non-SsoAuthError 分支
// 精确复刻 Hono 默认(HTTPException.getResponse + console.error + 500 文本),不吞普通错误。
//
// 覆盖面(F6 返修,见 docs/runbook/g21-strict-sso-runbook.md §route security matrix):
// - owner-scoped 持久化路由(projects/canvas/userState/assets/tasks/members/shareLinks)
//   → 走 resolveActor,strict 下缺 proof → 401;
// - debug-logs(POST 写 JSONL / GET 读报表)是 **system-scoped 遥测**,不经 resolveActor,
//   不被本 boundary 门控——独立防护(origin allowlist + per-IP rate limit + body cap +
//   GET view-token / public fail-closed)在 strict 下继续生效;debugLogsRoute 不抛 SsoAuthError;
// - stateless /api 路由(generate/edit/keys)不调 resolveActor → 不抛 → 不受影响。
app.onError(ssoAuthErrorHandler)

// G2.1 R2-2/R3-F2:strict proof 前置中间件(工厂)。owner-scoped 路由(projects/canvas/userState/tasks/members/
// shareLinks 子资源)在 strict + 无有效 share token 时,于任何 body 解析/DB lookup 前统一验 proof → 401。
// R3-F2:token presence 不再豁免——按 route 能力收窄(shareCapable)+ token 经 resolveShareLinkByToken
// 全局验有效性(active 才豁免;garbage/revoked/expired 不豁免,存在≠proof)。tasks/user-state 永不豁免;
// projects root(无 :id)永不豁免(hasSubresourceId=false);projects/canvas :id 子资源 + canvas 全部支持
// (canvas POST / 的 projectId 在 body,gate 全局验 token,route authz 验 token↔project)。
// dev mode 豁免;legacy(non-strict)no-op(生产零变化)。assets 路由 R3-F2 在 route 内 resolveAssetOwner
// 移到所有 validation 前(无需本中间件)。详见 owner.ts createSsoStrictProofGate。
app.use('/api/projects/*', createSsoStrictProofGate({ permissions: sharedPermissionBackend, shareCapable: hasSubresourceId }))
app.use('/api/canvas/*', createSsoStrictProofGate({ permissions: sharedPermissionBackend, shareCapable: true }))
app.use('/api/user-state/*', createSsoStrictProofGate({ permissions: sharedPermissionBackend, shareCapable: false }))
app.use('/api/mivo/tasks/*', createSsoStrictProofGate({ permissions: sharedPermissionBackend, shareCapable: false }))

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
// G2.1 R2-1:sharedAssetStore built once here (when service enabled) so the startup
// owner-migration gate (index.ts) can scan the assets domain for legacy-form ownerFp
// (AssetRecord.ownerFp + references[].ownerFp + .uploaders). Service off → null →
// index.ts passes a no-op detector (0 legacy; BFF manages no asset data).
let sharedAssetStore: AssetStore | null = null
if (featureFlags.assetServiceEnabled) {
  sharedAssetStore = createAssetStore(createFsAssetBackend(resolveAssetStoreDir()))
  app.route('/api', createAssetRoutes({ store: sharedAssetStore }))
} else {
  // Flag off → 404 for the asset endpoints (no SPA index.html for an API path).
  const assetDisabled = (c: Context<AppEnv>) => c.notFound()
  app.all('/api/assets', assetDisabled)
  app.all('/api/assets/*', assetDisabled)
}
export { sharedAssetStore }
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
