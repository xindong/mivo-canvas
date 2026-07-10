// server/lib/owner.ts
// T1.3 数据持久化端点(/api/{canvas,projects,user-state})的 owner 解析。
// 权威:docs/decisions/api-surface.md §1。
//
// 鉴权对齐现有(FX-2 tasks registry per-user 隔离先例):owner = 调用方 mivo_ 平台 key
// (X-Mivo-Api-Key header → env MIVO_PLATFORM_KEY fallback)的指纹(sha256 前 16 hex,
// 见 server/lib/keys.ts fingerprintOfPlatformKey)。raw key 永不落库/进内存快照/日志。
// 跨 owner 访问一律 404(无存在泄漏),同 getTaskForOwner。
//
// 过渡 seam(§1):§13.5 目标 owner = 已认证 maker user id(网关 /api/auth/me.username)。
// SSO→project_members 层(T1.4)落地时,换本实现读网关注入的可信身份;wire 契约
// (信封/scope/revision-409/cascade)全不变,只改 resolveOwner 内部。
//
// DP-7 合规:raw mivo key 永不作为 user-state 数据落库(DP-7);此处只用其指纹作 owner
// 分片键(keys.ts 注释明示"per-user partition/routing key,never stored")。两把 key
// 原文仍在前端 strictIdbStateStorage(DP-7 专用语义边界)。

import type { Context } from 'hono'
import { fingerprintOfPlatformKey, resolvePlatformCtx } from './keys'

/**
 * Data-owner id for the /api/{canvas,projects,user-state} endpoints.
 * Mirrors FX-2: fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey).
 * Empty key (no header + no env) → stable fallback fingerprint (dev/legacy parity,
 * same as tasks-per-user.test "no key + empty env" case).
 */
export const resolveOwner = (c: Context): string =>
  fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)
