// server/lib/owner.ts
// T1.3 数据持久化端点(/api/{canvas,projects,user-state})的身份解析。
// 权威:docs/decisions/api-surface.md §1(返修版)。
//
// 返修 #1:拆 actorUserId(调用方)与 resourceOwnerId(record.envelope.ownerId)。
// - `resolveActor(c)`:调用方身份(FX-2 mivo-key 指纹;§13.5 目标 = maker user id)。
// - resourceOwnerId:资源归属,从 record.envelope.ownerId 读(backend 返回)。
// - 授权 seam(lib/authz.ts)校验 actor 是否可访问 resource(T1.3:owner===actor;T1.4 扩 member/share)。
//
// 鉴权对齐现有(FX-2 tasks registry per-user 隔离先例):actor = 调用方 mivo_ 平台 key
// (X-Mivo-Api-Key header → env MIVO_PLATFORM_KEY fallback)的指纹(sha256 前 16 hex,
// 见 server/lib/keys.ts fingerprintOfPlatformKey)。raw key 永不落库/进内存快照/日志。
// 跨 owner 访问一律 404(无存在泄漏),同 getTaskForOwner。
//
// 过渡 seam(§1):§13.5 目标 actor = 已认证 maker user id(网关 /api/auth/me.username)。
// T1.4 落地(DP-4 已核验一致):resolveActor 切到读网关注入的可信身份 header `x-mivo-auth-user`
// (值 = SSO username = maker user id);wire 契约(信封/scope/revision-409/cascade)全不变,只改本实现内部。
// 缺失 header(无网关 / dev)→ fallback mivo-key 指纹(T1.3 dev/legacy parity,保 #194 契约测试 +
// t1.3-wiring 烟测全绿:owner===actor 自归属 + 跨 owner 404 语义不变)。生产网关必须注入 + strip 客户端伪造
// (见 dp4-identity-alignment.md §4 部署依赖 R-1)。
//
// DP-7 合规:raw mivo key 永不作为 user-state 数据落库(DP-7);fallback 路径只用其指纹作 owner
// 分片键(keys.ts 注释明示"per-user partition/routing key,never stored")。T1.4 生产路径 actor=username,
// 指纹仅 dev/legacy fallback。两把 key 原文仍在前端 strictIdbStateStorage(DP-7 专用语义边界)。
//
// ── G2.1 严格 SSO(cutover 计划 §5;2026-07-12)──────────────────────────────────
// 痛点:legacy resolveActor 在 SSO 信任失败时**静默回退 mivo-key 指纹**——生产仅 warning。
// 若 MIVO_PLATFORM_KEY 是共享/缺失,多用户解析到同一指纹 → 同一 actor → 跨用户数据互访(共享分片)。
// 严格模式开关 `MIVO_SSO_STRICT=1`(默认关,生产零变化);切换日翻开。
//
// 开关语义:
// - `MIVO_SSO_STRICT=1`(默认关):严格模式。缺/错 secret·header → **401,不回退指纹**。
//   SSO header `x-mivo-auth-user` 仅网关注入;client 不得携带——服务端靠网关共享密钥
//   `x-mivo-gateway-secret` 证明网关注入(无密钥/不匹配 → 401,即"拒绝 client 侧同名 header")。
//   严格模式下 resolveActor **无任何指纹回退路径**(见下方 strict 分支:仅返回 SSO user / dev actor /
//   抛 SsoAuthError;fingerprintOfPlatformKey 仅在 legacy 分支出现)。
// - `MIVO_DEV_MODE=1`(显式 dev mode;且 NODE_ENV≠production 才生效):严格模式下的本地开发通道。
//   信任 `x-mivo-auth-user` 而无需网关密钥(本地无网关);缺失则用稳定 dev actor。**不是靠 fallback**——
//   是显式 env 开关,生产下 isDevMode 恒 false(防误开 → 走严格生产路径 → 401,绝不冒充)。
// - 默认关(MIVO_SSO_STRICT 未设):legacy 行为完全不变(isSsoHeaderTrusted + ssoHeaderSecretOk → SSO user;
//   否则指纹 fallback)。现有测试零红。
//
// 持久化路由(projects/canvas/userState/assets/tasks/members/shareLinks)在严格模式下全部走 SSO actor:
// - projects/canvas/userState/members/shareLinks 直接调 resolveActor(c) → strict 分支自动生效。
// - tasks/assets 历史上绕过 resolveActor 直接用指纹;G2.1 改走 resolveTaskOwner/resolveAssetOwner
//   (mode-aware:strict 走 resolveActor,non-strict 保持原 raw-key/指纹 行为零变化)。
// 401 由 ssoAuthBoundary 中间件捕获 SsoAuthError 统一返回(app.ts + persistTestApp 挂载)。

import type { Context, ErrorHandler } from 'hono'
import { fingerprintOfPlatformKey, resolvePlatformCtx } from './keys'
import type { AppEnv } from './types'

/**
 * 网关注入的可信身份 header(DP-4 §4)。值 = SSO `username`(maker user id)。
 * 生产 nginx `auth_request` 通过后注入 + strip 客户端自带(防伪造);缺失 → fingerprint fallback。
 *
 * **服务器侧防伪造(Greptile security 修复)**:此 header **仅在显式 opt-in**
 * (`MIVO_TRUST_SSO_HEADER=1`)时才信任。默认关 → fallback 指纹(若 BFF 被绕过网关直连,
 * 攻击者无法靠伪造 `x-mivo-auth-user` 冒充他人 owner)。生产部署:ops 在网关之后设此 flag +
 * 网关 strip 客户端同名 header(对齐 auth-stub.ts 三重保险模式)。见 DP-4 §4/R-1。
 *
 * **网关共享密钥(Greptile security 第二轮修复)**:即便 opt-in 开,客户端仍可发同名 header
 * 冒充。故当 `MIVO_GATEWAY_SECRET` 配置时,BFF 额外要求 `x-mivo-gateway-secret` header 与之
 * 匹配(网关注入,客户端不可构造)才信任 `x-mivo-auth-user`。密钥不匹配 → 不信任 SSO header
 * (回退指纹,但**不冒充 victim**)。dev/test 不设 secret → 信任 header(本地无网关)。
 */
export const SSO_TRUSTED_USER_HEADER = 'x-mivo-auth-user'
export const GATEWAY_SECRET_HEADER = 'x-mivo-gateway-secret'

/** 严格 SSO 模式开关(cutover §5 G2.1;默认关,生产零变化)。 */
export const isSsoStrict = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.MIVO_SSO_STRICT === '1'

/**
 * 显式 dev mode(G2.1)。仅 `MIVO_DEV_MODE=1` **且 NODE_ENV≠production** 时为 true。
 * 生产下恒 false(防误开 → 严格生产路径 → 401,绝不冒充)。dev mode 是显式 env 开关,不是 fallback。
 */
export const isDevMode = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.MIVO_DEV_MODE === '1' && env.NODE_ENV !== 'production'

/** dev mode 下无 `x-mivo-auth-user` header 时使用的稳定 actor(本地 dev parity)。 */
export const DEV_ACTOR_ID = 'mivo-dev-actor'

/**
 * 严格模式下 SSO 鉴权失败(缺/错 secret·header)时抛出;由 ssoAuthBoundary 中间件捕获 → 401。
 * legacy(non-strict)模式下 resolveActor 永不抛此错(回退指纹)。
 */
export class SsoAuthError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`SSO auth required: ${reason}`)
    this.name = 'SsoAuthError'
    this.reason = reason
  }
}

/** x-mivo-auth-user 是否可信(opt-in,默认关防伪造;legacy 路径用)。 */
export const isSsoHeaderTrusted = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.MIVO_TRUST_SSO_HEADER === '1'

/**
 * 启动时校验 SSO 身份配置(Greptile security 第二轮 finding 2:防静默回退共享指纹)。
 * 生产(NODE_ENV=production)下:SSO 开但缺网关密钥 → 警告(可伪造);SSO 未开 → 警告
 * (persist 走指纹,若 MIVO_PLATFORM_KEY 共享则多用户同 actor,不安全)。仅警告不硬失败
 * (保单用户/合法指纹模式部署可用);ops 据警告修正。返回告警列表(供 index.ts 启动日志)。
 *
 * G2.1:增严格模式告警——生产下 MIVO_SSO_STRICT=1 但缺 MIVO_GATEWAY_SECRET → 所有持久化
 * 请求 401(运行时 fail-closed);MIVO_DEV_MODE=1 在生产 → 告警(isDevMode 已恒 false,但仍提示 ops 误配)。
 */
export const validateSsoConfig = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const warnings: string[] = []
  if (env.NODE_ENV !== 'production') return warnings
  if (env.MIVO_DEV_MODE === '1') {
    warnings.push('MIVO_DEV_MODE=1 in production: dev mode is force-disabled in production (isDevMode=false); remove this flag to avoid confusion. Strict path will 401 on missing gateway proof.')
  }
  if (isSsoStrict(env)) {
    if (!env.MIVO_GATEWAY_SECRET) {
      warnings.push('MIVO_SSO_STRICT=1 but MIVO_GATEWAY_SECRET unset: every persistence request will 401 (fail-closed). Set MIVO_GATEWAY_SECRET + have the gateway inject x-mivo-gateway-secret.')
    }
    return warnings
  }
  if (isSsoHeaderTrusted(env)) {
    if (!env.MIVO_GATEWAY_SECRET) {
      warnings.push('MIVO_TRUST_SSO_HEADER=1 but MIVO_GATEWAY_SECRET unset: x-mivo-auth-user is forgeable (no gateway proof). Set MIVO_GATEWAY_SECRET + have the gateway inject x-mivo-gateway-secret.')
    }
  } else {
    warnings.push('MIVO_SSO_STRICT!=1 and MIVO_TRUST_SSO_HEADER!=1 in production: /api/{projects,canvas,user-state} resolve identity via mivo-key fingerprint; if MIVO_PLATFORM_KEY is shared/absent, all users resolve to the same actor (data cross-access). Enable MIVO_SSO_STRICT=1 + MIVO_GATEWAY_SECRET behind the gateway.')
  }
  return warnings
}

/**
 * 网关共享密钥是否通过(T1.4 终审 P1-2 fail-closed:无密钥 → 任何模式都不得信任 SSO header)。
 * - 配置了 MIVO_GATEWAY_SECRET → 要求 x-mivo-gateway-secret 匹配(网关注入,客户端不可构造)。
 * - **未配置密钥 → 一律 false(含 dev/test)**:不靠部署约定堵伪造,服务器侧 fail-closed。
 *   dev/test 测成员角色:显式设 MIVO_GATEWAY_SECRET + 请求带 x-mivo-gateway-secret(见测试)。
 *   生产:网关注入密钥 + strip 客户端同名 header(部署依赖 R-1;本 PR 服务器侧 fail-closed)。
 * @param env env(MIVO_GATEWAY_SECRET)
 * @param headerSecret 请求 x-mivo-gateway-secret header 值
 */
export const ssoHeaderSecretOk = (env: NodeJS.ProcessEnv, headerSecret: string | undefined): boolean => {
  const gatewaySecret = env.MIVO_GATEWAY_SECRET
  if (!gatewaySecret) return false // fail-closed:无密钥 → 永不信任(防伪造身份头,任何模式)
  return headerSecret?.trim() === gatewaySecret // 配置:须匹配
}

/**
 * Actor user id for the /api/{canvas,projects,user-state} endpoints (返修 #1 + T1.4 DP-4 + G2.1 严格 SSO)。
 *
 * **严格模式(MIVO_SSO_STRICT=1)**:
 * - dev mode(MIVO_DEV_MODE=1 且非生产):信任 `x-mivo-auth-user`(本地无网关,无需密钥);
 *   缺失 → DEV_ACTOR_ID 稳定 dev actor。显式 env 开关,非 fallback。
 * - 生产严格:要求网关密钥通过(ssoHeaderSecretOk)且 `x-mivo-auth-user` 存在;缺/错任一 → 抛 SsoAuthError
 *   (→ ssoAuthBoundary 401)。**无指纹回退**(strict 分支不调用 fingerprintOfPlatformKey)。
 *
 * **legacy(默认关 → 生产零变化)**:仅当 `MIVO_TRUST_SSO_HEADER=1`(网关后 opt-in)且网关密钥通过时
 * 读 `x-mivo-auth-user`;否则 fallback mivo_ 平台 key 指纹(T1.3 owner===actor 自归属 parity)。
 * 空 key(无 header + 无 env)→ 稳定 fallback 指纹(dev/legacy parity,同 tasks-per-user.test)。
 */
export const resolveActor = (c: Context): string => {
  const env = process.env
  if (isSsoStrict(env)) {
    if (isDevMode(env)) {
      // 显式 dev mode:本地无网关,信任 x-mivo-auth-user(无需密钥);缺失 → 稳定 dev actor
      return c.req.header(SSO_TRUSTED_USER_HEADER)?.trim() || DEV_ACTOR_ID
    }
    // 严格生产:网关密钥必须通过(防 client 伪造 x-mivo-auth-user);不通过 → 401,不回退指纹
    if (!ssoHeaderSecretOk(env, c.req.header(GATEWAY_SECRET_HEADER))) {
      throw new SsoAuthError('missing or mismatched gateway secret (x-mivo-gateway-secret)')
    }
    const ssoUser = c.req.header(SSO_TRUSTED_USER_HEADER)?.trim()
    if (!ssoUser) throw new SsoAuthError('missing trusted SSO user header (x-mivo-auth-user)')
    return ssoUser // 严格模式 carrier = SSO username(maker user id,DP-4 一致)
  }
  // legacy(默认关):SSO opt-in + 密钥通过 → SSO user;否则指纹 fallback(零变化)
  if (isSsoHeaderTrusted(env) && ssoHeaderSecretOk(env, c.req.header(GATEWAY_SECRET_HEADER))) {
    const ssoUser = c.req.header(SSO_TRUSTED_USER_HEADER)?.trim()
    if (ssoUser) return ssoUser // T1.4 carrier = maker user id (username,DP-4 一致)
    // secret 通过但无 SSO header → fallback 指纹(网关未注入身份)
  }
  return fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey) // T1.3 fallback(仅 legacy 分支)
}

/**
 * 兼容别名:T1.3 seam owner===actor,resourceOwnerId === resolveActor(c)。
 * T1.4 member/share 落地后,route 改用 resolveActor + authz seam,此别名仅过渡。
 */
export const resolveOwner = resolveActor

/**
 * Task registry 的 owner key(FX-2 per-user 隔离;registry 内部 fingerprint 入库)。
 * - 严格模式:resolveActor(c)——SSO user(缺/错 proof 抛 SsoAuthError → 401);registry 对其再指纹
 *   得稳定 per-user 分片(非密 actor 被哈希无安全损害)。无 mivo-key 指纹回退 → 无共享分片。
 * - legacy(默认关):raw mivo 平台 key(registry 指纹 → ownerFp;**当前行为零变化**,tasks 测试全绿)。
 *   注:runner 的 platformKey(LLM 调用用)仍由 route 直接读 header/route 传入,与此 owner 解耦。
 */
export const resolveTaskOwner = (c: Context): string =>
  isSsoStrict() ? resolveActor(c) : resolvePlatformCtx(c).platformKey

/**
 * Asset store 的 owner(P2.5 owner-scoped;值直接作 store key,不再二次指纹)。
 * - 严格模式:resolveActor(c)——SSO user(缺/错 proof 抛 SsoAuthError → 401)。
 * - legacy(默认关):mivo-key 指纹(**当前行为零变化**)。
 */
export const resolveAssetOwner = (c: Context): string =>
  isSsoStrict() ? resolveActor(c) : fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)

/**
 * 顶层 onError 处理器:严格模式下 SsoAuthError(由 sub-app 内 resolveActor 等抛出)→ 401。
 * 这是可靠 catch 点——`app.route(path, subApp)` 下 sub-app handler 抛错由顶层 onError 统一处理
 * (父级 `app.use` 的 try/catch 跨 sub-app 不可靠)。非 SsoAuthError 回退 Hono 默认 500(行为不变)。
 * 挂载于 `app.onError(ssoAuthErrorHandler)`(app.ts + persistTestApp)。
 */
export const ssoAuthErrorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof SsoAuthError) {
    return c.json({ error: 'unauthorized', message: err.reason }, 401)
  }
  // 非 SSO 错误:回退 Hono 默认 500(不改变现有非严格模式行为)
  return c.text('Internal Server Error', 500)
}
