// scripts/e2e/prod-auth-assertions.mjs
// SSO 网关方案(feat/auth-sso)下的 HTTP-可验安全属性。
//
// 设计前提:app 无自身 auth gate(身份由公司统一 SSO 网关 auth.dsworks.cn 提供,
// 不在本仓改动范围)。旧 BFF token gate 已删,因此:
//   - 不再断言"裸 /api/mivo/* → 401"(app gate 已按设计删,裸请求本就该到 handler);
//   - 不再断言"带 MIVO_BFF_TOKEN → 200 链"(token gate 已删)。
// 改为断言新模型下仍 HTTP-可验的真实属性:
//   - public 模式(MIVO_PUBLIC=1)下 dev 桩硬关 → GET /api/auth/me 返 401(即便误设
//     MIVO_DEV_AUTH_STUB=1 也仍关,这是 SSO 模型下"身份只由网关提供"的可验属性);
//   - public 模式 feature flag 收紧:local-assets/eagle 默认 404、debug-logs GET 403;
//   - local 模式(非 public + MIVO_DEV_AUTH_STUB=1)下 dev 桩开 → GET /api/auth/me
//     返 200 + 网关契约 shape(测 P1-b opt-in 真生效)。

// public 模式(MIVO_PUBLIC=1)下,dev 桩必须硬关 + feature flag 收紧。
// authedFetch:仅用于"带 debug view token 读 debug-logs"等非鉴权场景;BFF 无 gate,
// 请求是否携带 token 不影响 /api/mivo/* 的可达性(本断言不依赖任何 app-level gate)。
export const assertPublicModeSecurity = async ({ baseUrl, authedFetch }) => {
  // P1-b: public 模式 dev 桩硬关 → /api/auth/me 401(身份只由网关提供)
  const meRes = await fetch(`${baseUrl}/api/auth/me`)
  if (meRes.status !== 401) {
    throw new Error(`prod security: /api/auth/me should 401 in public mode (dev stub forced off), got ${meRes.status}`)
  }
  const meBody = await meRes.json()
  if (meBody?.detail !== 'Not authenticated') {
    throw new Error(`prod security: /api/auth/me 401 body should be {detail:"Not authenticated"}, got ${JSON.stringify(meBody)}`)
  }

  // public 模式 feature flag 收紧
  const localAssetsDisabled = await authedFetch(`${baseUrl}/api/mivo/local-assets`)
  if (localAssetsDisabled.status !== 404) {
    throw new Error(`prod security: local-assets should default 404 in public mode, got ${localAssetsDisabled.status}`)
  }

  const eagleDisabled = await authedFetch(`${baseUrl}/api/mivo/eagle/status`)
  if (eagleDisabled.status !== 404) {
    throw new Error(`prod security: eagle should default 404 in public mode, got ${eagleDisabled.status}`)
  }

  const debugViewDenied = await authedFetch(`${baseUrl}/api/mivo/debug-logs`)
  if (debugViewDenied.status !== 403) {
    throw new Error(`prod security: debug GET without debug token should 403, got ${debugViewDenied.status}`)
  }
}

// local 模式(非 public + MIVO_DEV_AUTH_STUB=1)下,dev 桩必须开 → /api/auth/me 200
// 且字段对齐网关契约(测 P1-b opt-in 真生效,不是把检查阉空)。
export const assertLocalDevStubActive = async ({ baseUrl }) => {
  const meRes = await fetch(`${baseUrl}/api/auth/me`)
  if (meRes.status !== 200) {
    throw new Error(`local dev stub: /api/auth/me should 200 when MIVO_DEV_AUTH_STUB=1 && non-public, got ${meRes.status}`)
  }
  const meBody = await meRes.json()
  if (!meBody?.authenticated || meBody?.username !== 'dev@local') {
    throw new Error(`local dev stub: /api/auth/me 200 body should be {authenticated:true, username:"dev@local",...}, got ${JSON.stringify(meBody)}`)
  }
}
