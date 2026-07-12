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
// - `MIVO_DEV_MODE=1`(显式 dev mode;**三重保险**:MIVO_DEV_MODE opt-in + MIVO_PUBLIC=1 恒 false
//   + NODE_ENV 正向枚举仅 development/test 放行,F2 返修):严格模式下的本地开发通道。
//   信任 `x-mivo-auth-user` 而无需网关密钥(本地无网关);缺失则用稳定 dev actor。**不是靠 fallback**——
//   是显式 env 开关,生产/public/staging/空 NODE_ENV 下 isDevMode 恒 false(防误开 → 走严格生产路径 → 401,绝不冒充)。
// - 默认关(MIVO_SSO_STRICT 未设):legacy 行为完全不变(isSsoHeaderTrusted + ssoHeaderSecretOk → SSO user;
//   否则指纹 fallback)。现有测试零红。
//
// 持久化路由(projects/canvas/userState/assets/tasks/members/shareLinks)在严格模式下全部走 SSO actor:
// - projects/canvas/userState/members/shareLinks 直接调 resolveActor(c) → strict 分支自动生效。
// - tasks/assets 历史上绕过 resolveActor 直接用指纹;G2.1 改走 resolveTaskOwner/resolveAssetOwner
//   (mode-aware:strict 走 resolveActor,non-strict 保持原 raw-key/指纹 行为零变化)。
// 401 由 ssoAuthBoundary 中间件捕获 SsoAuthError 统一返回(app.ts + persistTestApp 挂载)。

import type { Context, ErrorHandler, MiddlewareHandler } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { fingerprintOfPlatformKey, resolvePlatformCtx } from './keys'
import type { PersistBackend } from '../persist/backend'
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
 * 显式 dev mode(G2.1)。**三重保险**(返修 F2:mirror auth-stub.ts:21-25 + NODE_ENV 正向枚举):
 *  1. `MIVO_DEV_MODE !== '1'` → false(显式 opt-in,默认关);
 *  2. `MIVO_PUBLIC === '1'` → false(public/生产部署恒关,身份只由网关提供——堵 F2 复现洞:
 *     原 `NODE_ENV !== 'production'` 负向判定让 staging/空值+dev+public 绕过,任意 x-mivo-auth-user 冒充);
 *  3. `NODE_ENV` 正向枚举:**仅** `development` / `test` 放行,staging/production/空值/其他一律 false
 *     (负向 `!== 'production'` 把 staging 当 dev → 不安全;正向枚举才严)。
 * 生产下恒 false(防误开 → 严格生产路径 → 401,绝不冒充)。dev mode 是显式 env 开关,不是 fallback。
 */
export const isDevMode = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (env.MIVO_DEV_MODE !== '1') return false // ① opt-in(默认关)
  if (env.MIVO_PUBLIC === '1') return false // ② public/生产部署恒关(mirror auth-stub.ts:24)
  const nodeEnv = env.NODE_ENV
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return false // ③ 正向枚举(仅 dev/test)
  return true
}

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
 * 生产边界(NODE_ENV=production **或** MIVO_PUBLIC=1,F2 返修:public 即生产边界,不能只看
 * NODE_ENV——否则 MIVO_PUBLIC=1 + dev flag 的 misconfig 静默)下:SSO 开但缺网关密钥 → 警告(可伪造);
 * SSO 未开 → 警告(persist 走指纹,若 MIVO_PLATFORM_KEY 共享则多用户同 actor,不安全)。仅警告不硬失败
 * (保单用户/合法指纹模式部署可用);ops 据警告修正。返回告警列表(供 index.ts 启动日志)。
 *
 * G2.1:增严格模式告警——生产边界下 MIVO_SSO_STRICT=1 但缺 MIVO_GATEWAY_SECRET → 所有持久化
 * 请求 401(运行时 fail-closed);MIVO_DEV_MODE=1 在生产边界 → 告警(isDevMode 已恒 false,但仍提示 ops 误配)。
 */
export const validateSsoConfig = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const warnings: string[] = []
  // F2 返修:MIVO_PUBLIC=1 同样是生产边界(public 部署身份只由网关提供),不能只凭 NODE_ENV 判定。
  const isProdBoundary = env.NODE_ENV === 'production' || env.MIVO_PUBLIC === '1'
  if (!isProdBoundary) return warnings
  if (env.MIVO_DEV_MODE === '1') {
    warnings.push('MIVO_DEV_MODE=1 at production boundary (NODE_ENV=production or MIVO_PUBLIC=1): dev mode is force-disabled (isDevMode=false under MIVO_PUBLIC=1 / non-dev-test NODE_ENV); remove this flag to avoid confusion. Strict path will 401 on missing gateway proof.')
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
    warnings.push('MIVO_SSO_STRICT!=1 and MIVO_TRUST_SSO_HEADER!=1 at production boundary: /api/{projects,canvas,user-state} resolve identity via mivo-key fingerprint; if MIVO_PLATFORM_KEY is shared/absent, all users resolve to the same actor (data cross-access). Enable MIVO_SSO_STRICT=1 + MIVO_GATEWAY_SECRET behind the gateway.')
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
  // F4 返修:恒时比较——两侧先 SHA-256 digest(均固定 32 字节,消除长度泄漏与早返回),
  // 再 crypto.timingSafeEqual。不再直接 `===`(原 `headerSecret?.trim() === gatewaySecret`
  // 非恒时:长度不匹配即时返回 + 逐字节短路,泄漏 secret 长度/前缀)。等长 digest → 纯恒时。
  const gatewayDigest = createHash('sha256').update(gatewaySecret).digest()
  const headerDigest = createHash('sha256').update(headerSecret?.trim() ?? '').digest()
  return timingSafeEqual(gatewayDigest, headerDigest)
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
 * G2.1 R2-2:strict 模式 proof 前置中间件。owner-scoped 路由(projects/canvas/userState/tasks/members/
 * shareLinks)在 strict + 无 share token 时,于**任何 body 解析/DB lookup 前**统一验 proof(gateway
 * secret + SSO header),缺/错 → 抛 SsoAuthError(→ ssoAuthErrorHandler 401)。token-scoped(share token
 * 在)显式豁免(route authz 验 token,公开分享访问无需 gateway proof);dev mode 豁免(信任
 * x-mivo-auth-user 无需 proof,route 仍调 resolveActor)。legacy(non-strict)→ no-op(生产零变化)。
 *
 * **消除存在性 oracle**(R2-2):返修前 GET /api/projects/:id strict+无 proof 下 已存=401(authz 抛
 * SsoAuthError)、未知=404(getProjectOwner 缺失先返)→ 泄漏存在。前置后 known/missing 一律 401
 * (DB lookup 不被未鉴权请求触达)。**未鉴权不消耗昂贵解析**:tasks multipart/mask + projects JSON body
 * 在 401 前不解析(返修前非法 body POST=400、tasks multipart 先于 401 处理)。
 *
 * 挂载点:owner-scoped 路由前(app.ts + persistTestApp)。**不挂**:/api/share(token-scoped 公开)、
 * /api/mivo/debug-logs(system-scoped 遥测,独立防护)、stateless /api/mivo/{generate,edit,enhance,...}。
 * assets 路由已在 route 内 resolveAssetOwner 早于 body 解析(无需本中间件)。
 */
export const ssoStrictProofGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isSsoStrict(process.env)) return next() // legacy: no-op,零变化(不读 header 不解析 body)
  // token-scoped 豁免:share token 在 → route authz 验 token(公开分享访问,无需 gateway proof)
  const shareToken =
    c.req.header('x-mivo-share-token')?.trim() ||
    c.req.query('share')?.toString() ||
    undefined
  if (shareToken) return next()
  // strict + 无 share token:proof 前置(在 body 解析 / DB lookup 前)
  if (isDevMode(process.env)) return next() // dev mode:信任 x-mivo-auth-user 无需 proof;route 仍调 resolveActor
  if (!ssoHeaderSecretOk(process.env, c.req.header(GATEWAY_SECRET_HEADER))) {
    throw new SsoAuthError('missing or mismatched gateway secret (x-mivo-gateway-secret)')
  }
  const ssoUser = c.req.header(SSO_TRUSTED_USER_HEADER)?.trim()
  if (!ssoUser) throw new SsoAuthError('missing trusted SSO user header (x-mivo-auth-user)')
  return next() // proof ok;route 继续(resolveActor 再派生,廉价;双校验不增攻击面)
}

// ── G2.1 F1/R2-1:owner 键空间跃迁防护(strict 禁先于 G2.2,三域 gate)──────────────────────
// 痛点(F1 复现):strict 切换让 resolveActor 返回 SSO username(无指纹回退),所有 legacy 形态
// (ownerId=指纹,sha256[:16] hex)的存量数据对 SSO 用户不可见(alice 列表空)。翻 strict 前必须先跑
// G2.2 迁移(指纹→username),否则数据"消失"。本 gate 是**机器判定**(非文字约定):启动时检测
// legacy 形态 owner 数据>0 且 strict=1 → 拒绝启动(exit 1)。G2.2 未实装:迁移函数打桩(throw);
// gate 机制本身真实(三域 memory backend 实扫,可测)。
//
// R2-1(第二轮返修,P1):返修前 gate 只收 PersistBackend → persist=0 但 permission/asset 全 legacy
// 时放行(share_links.created_by + AssetRecord.ownerFp/references/uploaders 漏检)。G2.2 若只补 PG persist
// detector 即可绕过其余两域。修法:gate 收三 detector(persist + permissions + assets),任一 detector
// 缺失 → fail-closed 拒启动,任一域 legacy>0 → 拒启动。InMemory persist/permissions/assets detector 可测;
// PG 三域 detector 随 G2.2 落地(未实现 → strict 启动 fail-closed,安全)。
//
// 覆盖面(三域,对齐 owner inventory 全清单):
//  - persist(PersistBackend):persist_records/projects/canvases/idempotency_index 的 ownerId(memory 实扫
//    byOwner 外层 key;PG detector 随 G2.2);
//  - permissions(PermissionBackend):share_links.created_by(InMemory 扫 links;PG 随 G2.2);
//  - assets(AssetStore):AssetRecord.ownerFp + references[].ownerFp + .uploaders(InMemory/fs 扫 listRecords
//    + listUploaders;PG 随 G2.2)。asset service 未启用(MIVO_ENABLE_ASSET_SERVICE=0)时 index.ts 传
//    countLegacyFormOwners=()=>0 的占位 detector(service off → BFF 不管理 asset 数据 → 0 legacy)。

/**
 * legacy owner 形态 = mivo-key 指纹(sha256[:16] hex,见 keys.ts `fingerprintOfPlatformKey`)。
 * SSO username 为 email-style(含 `@`,如 `zhuzan@xd.com`);DEV_ACTOR_ID=`mivo-dev-actor`——均不匹配
 * 此 16-hex 正则,故可机械区分 legacy 形态与新形态。
 */
export const LEGACY_FINGERPRINT_REGEX = /^[0-9a-f]{16}$/
export const isLegacyFormOwner = (ownerId: string): boolean => LEGACY_FINGERPRINT_REGEX.test(ownerId)

/**
 * G2.1 R2-1 三域 gate 的 detector seam。每个域(persist/permissions/assets)的 backend 实现可选
 * `countLegacyFormOwners`(memory 实扫可测;PG 随 G2.2)。gate 收 detector 列表,逐个判定:
 * 缺失方法 → fail-closed;legacy 行数>0 → 拒启动。`domain` 仅用于报错指明哪个域。
 */
export type LegacyOwnerDetector = {
  /** 域名(persist/permissions/assets),仅报错指明;不参与判定逻辑。 */
  readonly domain: string
  /**
   * 统计本域 ownerId 为 legacy 形态(指纹,16-hex)的 owner 数。**可选**:memory 实现可测;
   * PG detector 随 G2.2 落地,未实现时 gate fail-closed 拒启动(无法机械判定迁移完成)。
   */
  countLegacyFormOwners?(): Promise<number>
}

/**
 * 把实现了 `countLegacyFormOwners` 的 backend 包成 `LegacyOwnerDetector`(bind 到实例,
 * 防方法丢失 `this`)。backend 未实现该方法 → detector.countLegacyFormOwners = undefined
 * → gate fail-closed(对齐 PG G2.2 前未实现场景)。
 */
export const legacyOwnerDetector = (
  domain: string,
  backend: { countLegacyFormOwners?(): Promise<number> },
): LegacyOwnerDetector => ({
  domain,
  countLegacyFormOwners:
    typeof backend.countLegacyFormOwners === 'function'
      ? backend.countLegacyFormOwners.bind(backend)
      : undefined,
})

/**
 * G2.1 F1/R2-1 启动 gate:strict 模式下,若三域(persist + permissions + assets)任一仍存在
 * legacy 形态 owner 数据 → **拒绝启动**(fail fast,exit 1 via index.ts start().catch)。
 * 机器判定,非文字约定:ops 翻 MIVO_SSO_STRICT=1 前必须先跑 G2.2 迁移(跨三域重键 owner)。
 *
 * - 非 strict → no-op(生产零变化;legacy 路径不触发本 gate,现有行为完全不变)。
 * - strict + 任一 detector 缺失 `countLegacyFormOwners`(如 PG,G2.2 前未补)→ fail-closed 拒启动
 *   (无法机械判定迁移完成前不得翻 strict;三域 PG detector 随 G2.2 落地)。
 * - strict + 全 detector 实现 + 任一域 legacy 行数>0 → 拒启动(报具体域 + 计数 + 迁移指引)。
 * - strict + 全 detector 实现 + 三域 0 legacy 行 → 通过(迁移完成或无存量)。
 *
 * 挂载点:`server/index.ts` `await Promise.all([sharedPersistBackend.ready, ...])` 之后、serve 之前。
 * 导出供 gate 测试直驱(`sso-strict.route.test.ts` §R2-1)。
 */
export const assertStrictOwnerMigrationComplete = async (
  env: NodeJS.ProcessEnv = process.env,
  detectors: LegacyOwnerDetector[],
): Promise<void> => {
  if (!isSsoStrict(env)) return // 非 strict:no-op(生产零变化)
  for (const d of detectors) {
    if (typeof d.countLegacyFormOwners !== 'function') {
      // fail-closed:该域 backend 不支持 legacy 检测 → 无法机械判定迁移完成 → strict 拒启动。
      throw new Error(
        `[mivo-bff] MIVO_SSO_STRICT=1 but ${d.domain} backend does not implement countLegacyFormOwners (PG ${d.domain} detector lands with G2.2). Cannot machine-verify ${d.domain} owner migration complete; refusing to start (fail-closed). Run G2.2 owner migration (fingerprint→username) across persist/permissions/assets and land all three backend detectors before flipping strict.`,
      )
    }
    const legacyCount = await d.countLegacyFormOwners()
    if (legacyCount > 0) {
      throw new Error(
        `[mivo-bff] MIVO_SSO_STRICT=1 but ${d.domain} backend has ${legacyCount} legacy-form owner record(s) (ownerId=fingerprint, sha256[:16] hex). Strict mode resolves actor=SSO username with NO fingerprint fallback → all legacy owner data becomes invisible. Run G2.2 owner migration (fingerprint→username mapping) across persist/permissions/assets before flipping MIVO_SSO_STRICT=1. Refusing to start (fail-closed).`,
      )
    }
  }
}

/**
 * G2.2 owner 迁移(STUB / 打桩 seam):把 legacy 指纹 ownerId 重映射为 SSO username 形态。
 * **G2.1 不实装**(G2.2 scope);提供具名 seam 供 gate 测试打桩 + G2.2 固定调用点。真实 G2.2 实现需
 * fingerprint→username 映射(需原 mivo_ key 或预建映射表)+ 跨三 backend(persist/permissions/assets)重键
 * owner。G2.2 落地前调用本函数抛错(startup gate 已在启动期拦截 strict,本 stub 不会被生产路径触达)。
 */
export const migrateLegacyOwnersToUsernameForm = async (
  backend: PersistBackend,
  resolveFingerprintToUsername: (fingerprint: string) => string | undefined,
): Promise<{ migrated: number; unmapped: number }> => {
  // stub seam:params 命名锁定 G2.2 契约(backend + 指纹→username resolver);G2.2 实装前不读取,
  // 此处 void 标记 used 以过 lint,真实实现时移除。startup gate 已在启动期拦截 strict,本 stub 不被生产路径触达。
  void backend
  void resolveFingerprintToUsername
  throw new Error(
    'migrateLegacyOwnersToUsernameForm: not implemented (G2.2 scope). The startup gate (assertStrictOwnerMigrationComplete) is real and enforced at startup; the migration itself lands with G2.2.',
  )
}

/**
 * 顶层 onError 处理器:严格模式下 SsoAuthError(由 sub-app 内 resolveActor 等抛出)→ 401。
 * 这是可靠 catch 点——`app.route(path, subApp)` 下 sub-app handler 抛错由顶层 onError 统一处理
 * (父级 `app.use` 的 try/catch 跨 sub-app 不可靠)。非 SsoAuthError 回退 Hono 默认 500(行为不变)。
 * 挂载于 `app.onError(ssoAuthErrorHandler)`(app.ts + persistTestApp)。
 */
export const ssoAuthErrorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof SsoAuthError) {
    // c.json 走 c.newResponse → 保 pre-error c.header()(R2-3 parity)。401 JSON 契约
    // `{error:'unauthorized', message:reason}` 锁定于 sso-strict.route.test ② + sso-error-parity。
    return c.json({ error: 'unauthorized', message: err.reason }, 401)
  }
  // R2-3(F5 第二轮返修):精确复刻 Hono 默认 onError 语义(Option A 精确复刻,finding 允许)。
  // origin/main 无 onError → Hono 默认对非 SsoAuthError:
  //  ① `"getResponse" in err` duck-type → `c.newResponse(err.getResponse().body, res)`(保 pre-error c.header());
  //  ② 否则 → console.error(err) + 500 'Internal Server Error'。
  // 返修前现实现(首版)用 `instanceof HTTPException` + 直接 `err.getResponse()`,两洞:
  //  - instanceof 漏 structural HTTPResponseError(有 getResponse 但非 HTTPException 子类)→ 误入 500 分支;
  //  - 直接 `err.getResponse()` 不走 c.newResponse → 丢 pre-error c.header() 上下文(R2-3 parity 测试复现)。
  // 改 duck-type + c.newResponse 后:HTTPException / structural 一律经 c.newResponse 保 pre-error header;
  // 普通 Error 仍 console.error + 500(不吞,F5 复现的 consoleErrors 1→0 修复保持)。
  // sso-error-parity.test.ts 锁定:普通 Error / HTTPException / structural × 默认 vs custom 全 parity,Hono 升级漂移报警。
  if (err != null && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => Response }).getResponse()
    return c.newResponse(res.body, res)
  }
  console.error(err) // mirror Hono 默认:普通错误日志(修复 F5 复现的 consoleErrors 1→0)
  return c.text('Internal Server Error', 500) // 同 Hono 默认 500 文本
}
