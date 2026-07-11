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

import type { Context } from 'hono'
import { fingerprintOfPlatformKey, resolvePlatformCtx } from './keys'

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

/** x-mivo-auth-user 是否可信(opt-in,默认关防伪造)。 */
export const isSsoHeaderTrusted = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.MIVO_TRUST_SSO_HEADER === '1'

/**
 * 启动时校验 SSO 身份配置(Greptile security 第二轮 finding 2:防静默回退共享指纹)。
 * 生产(NODE_ENV=production)下:SSO 开但缺网关密钥 → 警告(可伪造);SSO 未开 → 警告
 * (persist 走指纹,若 MIVO_PLATFORM_KEY 共享则多用户同 actor,不安全)。仅警告不硬失败
 * (保单用户/合法指纹模式部署可用);ops 据警告修正。返回告警列表(供 index.ts 启动日志)。
 */
export const validateSsoConfig = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const warnings: string[] = []
  if (env.NODE_ENV !== 'production') return warnings
  if (isSsoHeaderTrusted(env)) {
    if (!env.MIVO_GATEWAY_SECRET) {
      warnings.push('MIVO_TRUST_SSO_HEADER=1 but MIVO_GATEWAY_SECRET unset: x-mivo-auth-user is forgeable (no gateway proof). Set MIVO_GATEWAY_SECRET + have the gateway inject x-mivo-gateway-secret.')
    }
  } else {
    warnings.push('MIVO_TRUST_SSO_HEADER!=1 in production: /api/{projects,canvas,user-state} resolve identity via mivo-key fingerprint; if MIVO_PLATFORM_KEY is shared/absent, all users resolve to the same actor (data cross-access). Enable SSO + MIVO_GATEWAY_SECRET behind the gateway.')
  }
  return warnings
}

/**
 * 网关共享密钥是否通过(Greptile security 第三轮修复:生产缺密钥不得信任 SSO header)。
 * - 配置了 MIVO_GATEWAY_SECRET → 要求 x-mivo-gateway-secret 匹配(网关注入,客户端不可构造)。
 * - 未配置密钥 → 仅非生产(dev/test)放行(无网关本地 dev);**生产缺密钥 → 不通过**(防伪造)。
 * @param env env(MIVO_GATEWAY_SECRET / NODE_ENV)
 * @param headerSecret 请求 x-mivo-gateway-secret header 值
 */
export const ssoHeaderSecretOk = (env: NodeJS.ProcessEnv, headerSecret: string | undefined): boolean => {
  const gatewaySecret = env.MIVO_GATEWAY_SECRET
  if (gatewaySecret) return headerSecret?.trim() === gatewaySecret // 配置:须匹配
  return env.NODE_ENV !== 'production' // 未配置:仅非生产放行;生产缺密钥 → false(不信任 SSO header)
}

/**
 * Actor user id for the /api/{canvas,projects,user-state} endpoints (返修 #1 + T1.4 DP-4).
 * T1.4:仅当 `MIVO_TRUST_SSO_HEADER=1`(网关后 opt-in)且网关密钥通过时读 `x-mivo-auth-user`。
 * 生产缺 MIVO_GATEWAY_SECRET → 密钥不通过 → 不信任 SSO header(防伪造,Greptile 第三轮)。
 * 否则(默认关 / dev / legacy / 无网关)→ fallback mivo_ 平台 key 指纹(T1.3 owner===actor 自归属 parity)。
 * 空 key(无 header + 无 env)→ 稳定 fallback 指纹(dev/legacy parity,同 tasks-per-user.test)。
 */
export const resolveActor = (c: Context): string => {
  if (isSsoHeaderTrusted() && ssoHeaderSecretOk(process.env, c.req.header(GATEWAY_SECRET_HEADER))) {
    const ssoUser = c.req.header(SSO_TRUSTED_USER_HEADER)?.trim()
    if (ssoUser) return ssoUser // T1.4 carrier = maker user id (username,DP-4 一致)
    // secret 通过但无 SSO header → fallback 指纹(网关未注入身份)
  }
  return fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey) // T1.3 fallback
}

/**
 * 兼容别名:T1.3 seam owner===actor,resourceOwnerId === resolveActor(c)。
 * T1.4 member/share 落地后,route 改用 resolveActor + authz seam,此别名仅过渡。
 */
export const resolveOwner = resolveActor
