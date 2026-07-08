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
import { app } from './app'
import { resolveFeatureFlags } from './lib/env'
import { isDevStubActive } from './lib/auth-stub'

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

serve({ fetch: app.fetch, hostname: HOSTNAME, port: PORT }, (info) => {
  const bound = `${info.address}:${info.port}`
  const mode = PUBLIC_MODE ? 'public 0.0.0.0 (behind SSO gateway)' : 'local 127.0.0.1'
  const assets = featureFlags.localAssetsEnabled ? 'on' : 'off'
  const eagle = featureFlags.eagleProxyEnabled ? 'on' : 'off'
  const stub = stubOn ? 'on (dev stub /api/auth/me)' : 'off'
  console.log(
    `[mivo-bff] listening on http://${bound} [${mode}] auth-dev-stub=${stub} local-assets=${assets} eagle=${eagle}`,
  )
})
