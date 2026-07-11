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
// SSO→project_members 层(T1.4)落地时,换本实现读网关注入的可信身份;wire 契约
// (信封/scope/revision-409/cascade)全不变,只改 resolveActor 内部。
//
// DP-7 合规:raw mivo key 永不作为 user-state 数据落库(DP-7);此处只用其指纹作 owner
// 分片键(keys.ts 注释明示"per-user partition/routing key,never stored")。两把 key
// 原文仍在前端 strictIdbStateStorage(DP-7 专用语义边界)。

import type { Context } from 'hono'
import { fingerprintOfPlatformKey, resolvePlatformCtx } from './keys'

/**
 * Actor user id for the /api/{canvas,projects,user-state} endpoints (返修 #1).
 * = 调用方 mivo_ 平台 key 指纹(FX-2;§13.5 目标 = maker user id)。
 * 空 key(无 header + 无 env)→ 稳定 fallback 指纹(dev/legacy parity,同 tasks-per-user.test)。
 */
export const resolveActor = (c: Context): string =>
  fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)

/**
 * 兼容别名:T1.3 seam owner===actor,resourceOwnerId === resolveActor(c)。
 * T1.4 member/share 落地后,route 改用 resolveActor + authz seam,此别名仅过渡。
 */
export const resolveOwner = resolveActor
