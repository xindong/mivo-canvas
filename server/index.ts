// server/index.ts
// BFF entrypoint. Constructs nothing — the app lives in ./app (imported by tests
// too). This file owns startup-only concerns: bind address + serve().
// Run with `npm run start:server` (tsx server/index.ts).
//
// Auth: SSO 网关方案 —— 生产由公司统一 SSO 网关(auth.dsworks.cn)全包认证,app 无
// auth gate,运行在网关之后。BFF 不被绕过直连的保证由 ops/网络层负责(网关前置 +
// 网络隔离),不在本仓代码层处理。本地 dev 用 routes/auth.ts 的 dev 桩 /api/auth/me
// 进已登录态(opt-in,见 lib/auth-stub.ts)。
import { serve } from '@hono/node-server'
import { app, sharedPersistBackend, sharedPermissionBackend, sharedAssetStore } from './app'
import { resolveFeatureFlags } from './lib/env'
import { isDevStubActive } from './lib/auth-stub'
import { validateSsoConfig, assertStrictOwnerMigrationComplete, legacyOwnerDetector } from './lib/owner'

const PORT = Number(process.env.MIVO_PORT) || 8080
const PUBLIC_MODE = process.env.MIVO_PUBLIC === '1'
const HOSTNAME = PUBLIC_MODE ? '0.0.0.0' : '127.0.0.1'

const featureFlags = resolveFeatureFlags()
const stubOn = isDevStubActive()

// SSO scheme: app has no auth gate. MIVO_PUBLIC=1 binds 0.0.0.0 — only safe
// behind the SSO gateway; warn (not exit) if binding public, since the gateway
// is the auth (the old JWT_SECRET/MIVO_BFF_TOKEN startup guard is gone with the
// OAuth machinery). "不被绕过直连"由 ops/网络层保证,不在本仓处理。
if (PUBLIC_MODE) {
  console.warn(
    '[mivo-bff] WARN: MIVO_PUBLIC=1 — app has no auth gate. Ensure the SSO gateway (auth.dsworks.cn) is in front; otherwise the BFF is open.',
  )
}

// T1.4: SSO 身份配置校验(Greptile security:防静默回退共享指纹 / 可伪造身份头)。仅生产告警。
for (const w of validateSsoConfig()) {
  console.warn(`[mivo-bff] WARN: ${w}`)
}

// T1.3: PG backend 启用时,serve 前预热 persist 全局唯一索引缓存 + 权限层 migrations;
// memory backend 的 ready 立即 resolve(no-op,生产零变化)。PG 连接失败 → 启动停(fail visibly)。
const start = async (): Promise<void> => {
  await Promise.all([sharedPersistBackend.ready, sharedPermissionBackend.ready])
  // G2.1 F1/R2-1:strict 启动 owner-migration 三域 gate——MIVO_SSO_STRICT=1 但 persist/permissions/
  // assets 任一域仍存在 legacy 形态 owner 数据(ownerId=指纹,sha256[:16] hex)→ 拒绝启动(fail fast,
  // exit 1)。机器判定,非文字约定:ops 翻 strict 前必须先跑 G2.2 迁移(跨三域指纹→username),否则
  // legacy 数据对 SSO 用户不可见。返修前 gate 只收 persist → persist=0 但 permission/asset 全 legacy
  // 时放行(R2-1 漏检洞);现三域同判,任一 detector 缺失(PG G2.2 前未实现)→ fail-closed 拒启动。
  // 非 strict → no-op(生产零变化)。asset service 未启用 → sharedAssetStore=null → 占位 detector(0 legacy)。
  await assertStrictOwnerMigrationComplete(process.env, [
    legacyOwnerDetector('persist', sharedPersistBackend),
    legacyOwnerDetector('permissions', sharedPermissionBackend),
    sharedAssetStore
      ? legacyOwnerDetector('assets', sharedAssetStore)
      : { domain: 'assets', countLegacyFormOwners: () => Promise.resolve(0) },
  ])
  serve({ fetch: app.fetch, hostname: HOSTNAME, port: PORT }, (info) => {
    const bound = `${info.address}:${info.port}`
    const mode = PUBLIC_MODE ? 'public 0.0.0.0 (behind SSO gateway)' : 'local 127.0.0.1'
    const assets = featureFlags.localAssetsEnabled ? 'on' : 'off'
    const eagle = featureFlags.eagleProxyEnabled ? 'on' : 'off'
    const stub = stubOn ? 'on (dev stub /api/auth/me)' : 'off'
    const persist = sharedPersistBackend.constructor.name === 'PgPersistBackend' ? 'pg' : 'memory'
    console.log(
      `[mivo-bff] listening on http://${bound} [${mode}] auth-dev-stub=${stub} local-assets=${assets} eagle=${eagle} persist=${persist}`,
    )
  })
}

start().catch((err) => {
  console.error('[mivo-bff] startup failed:', err)
  process.exit(1)
})
