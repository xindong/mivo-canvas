// server/lib/projectAuthz.ts
// T1.4 共享 project 访问解析器——projects / members / shareLinks 三路由共用,避免 authz 逻辑重复。
// 权威:docs/decisions/permission-schema.md §2(矩阵)+ docs/decisions/dp4-identity-alignment.md(身份载体)。
//
// 语义(同 routes/projects.ts authzProject):
//  - 非成员/无分享 → 404 unknown-project(无存在泄漏,与 #194 一致)
//  - 成员/分享越权 → 403 forbidden(server-local body,DP-4 R-4)
//  - revoked share → 410 gone(FX-7 §5.9);expired share → 410

import type { Context } from 'hono'
import type { AppEnv } from './types'
import type { PersistBackend, PersistRecord } from '../persist/backend'
import type { PermissionBackend } from './permissions'
import { canAccessProject, canAccessCanvas, denyStatus, type AuthzAction, type AuthzInfo } from './authz'
import { resolveActor } from './owner'
import { logRequest } from './request'
import type { UnknownResourceBody } from '../../shared/persist-contract.ts'

/** 分享 token header / query(§4 token 信任;routes 共用)。 */
export const shareTokenOf = (c: Context<AppEnv>): string | undefined =>
  c.req.header('x-mivo-share-token')?.trim() || c.req.query('share')?.toString() || undefined

export type ProjectAccessResult =
  | { ok: true; ownerId: string }
  | { ok: false; status: number; body: unknown }

/**
 * 解析 actor 对 project 的访问(action-aware 角色矩阵)。
 * 先 getProjectOwner(全局归属);**P1-3:再 fetch project record 判 live(deleted → 404,子资源不可见)**,
 * 除 allowDeleted 例外(DELETE project 幂等:删已删 → 204,不拒);再 share-token 或 actor+member 解析 AuthzInfo;canAccessProject 判。
 */
export const resolveProjectAccess = async (
  c: Context<AppEnv>,
  backend: PersistBackend,
  permissions: PermissionBackend,
  id: string,
  action: AuthzAction,
  opts: { allowDeleted?: boolean } = {},
): Promise<ProjectAccessResult> => {
  const owner = backend.getProjectOwner(id)
  if (!owner) return { ok: false, status: 404, body: { error: 'unknown-project' } satisfies UnknownResourceBody }
  // P1-3:deleted/missing project → 子资源(members/share-links)不可见 → 404(无泄漏);
  // allowDeleted 例外:DELETE project 幂等(删已删 → 204)需访问已删 project,故不拒。
  if (!opts.allowDeleted) {
    const proj = await backend.get(owner.ownerId, 'project', id)
    if (proj.kind === 'missing' || proj.record.isDeleted) {
      return { ok: false, status: 404, body: { error: 'unknown-project' } satisfies UnknownResourceBody }
    }
  }
  const shareToken = shareTokenOf(c)
  if (shareToken) {
    const share = await permissions.resolveShareLink(shareToken, id)
    if (!share) return { ok: false, status: 404, body: { error: 'unknown-project' } satisfies UnknownResourceBody }
    if (share.kind === 'revoked') return { ok: false, status: 410, body: { error: 'gone' } }
    if (share.kind === 'expired') return { ok: false, status: 410, body: { error: 'gone', reason: 'expired' } }
    const info: AuthzInfo = { actor: null, ownerId: owner.ownerId, sharePermission: share.permission }
    if (canAccessProject(info, action) === 'deny') {
      return { ok: false, status: 403, body: { error: 'forbidden' } }
    }
    return { ok: true, ownerId: owner.ownerId }
  }
  const actor = resolveActor(c)
  const memberRole = await permissions.resolveMemberRole(id, actor, owner.ownerId)
  const info: AuthzInfo = { actor, ownerId: owner.ownerId, memberRole }
  if (canAccessProject(info, action) === 'deny') {
    const status = denyStatus(info) === 403 ? 403 : 404
    const body = status === 403 ? { error: 'forbidden' } : { error: 'unknown-project' } satisfies UnknownResourceBody
    return { ok: false, status, body }
  }
  return { ok: true, ownerId: owner.ownerId }
}

/** deny → Response(统一日志;projects/members/shareLinks 共用)。 */
export const denyProjectResponse = (
  c: Context<AppEnv>,
  requestId: string,
  t0: number,
  r: { ok: false; status: number; body: unknown },
): Response => {
  const note = r.status === 403 ? 'forbidden' : r.status === 410 ? 'gone' : 'unknown-project'
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: r.status, latencyMs: Date.now() - t0, note })
  return c.json(r.body as Record<string, unknown>, r.status as 400 | 403 | 404 | 410)
}

// ── G2.2(decision 1/2):canvas 访问解析器——asset attach/detach 路由复用(避免在 route 内重写 authzCanvas)──
// 语义同 routes/canvas.ts authzCanvas:非成员/无分享 → 404 unknown-canvas(无泄漏);成员/分享越权 → 403;
// revoked share → 410;expired → 410。派生 owner:canvas.ownerId === project.ownerId,actor===ownerId → owner。
// 提取为模块级函数以便 asset 路由(无 authzCanvas 闭包)复用;canvas.ts authzCanvas 保留(其 route 内闭包,行为一致)。

/** canvas meta payload 的 projectId 域字段(canvas.ts isCanvasPayload 的镜像;projectAuthz 不耦合 canvas route)。 */
const canvasProjectIdOf = (record: PersistRecord): string => {
  const p = typeof record.payload === 'object' && record.payload !== null
    ? (record.payload as { projectId?: unknown })
    : null
  return typeof p?.projectId === 'string' ? p.projectId : ''
}

export type CanvasAccessResult =
  | { ok: true; ownerId: string; projectId: string; actor: string | null }
  | { ok: false; status: number; body: unknown }

/**
 * 解析 actor 对 canvas 的访问(action-aware 角色矩阵)。asset attach/detach 路由用:
 *  - attach gate ①:action='write'(actor 须对目标 canvas 有 edit 权)。
 *  - detach:action='write'(actor 须对引用所在 canvas 有 edit 权,decision 2)。
 * 先 getCanvasOwner 全局归属;再 fetch canvas meta 判 live(deleted → 404);取 projectId;
 * 按 share-token 或 actor+member 解析 AuthzInfo;canAccessCanvas 判。返 actor(share-token 路径=null)。
 */
export const resolveCanvasAccess = async (
  c: Context<AppEnv>,
  backend: PersistBackend,
  permissions: PermissionBackend,
  canvasId: string,
  action: AuthzAction,
): Promise<CanvasAccessResult> => {
  const owner = backend.getCanvasOwner(canvasId)
  if (!owner) return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
  const got = await backend.get(owner.ownerId, 'canvas', canvasId)
  if (got.kind === 'missing') {
    return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
  }
  // soft-deleted canvas:read/write → 404(已不可见);asset attach/detach 不可对软删画布操作。
  if (got.record.isDeleted) {
    return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
  }
  const projectId = canvasProjectIdOf(got.record)
  const shareToken = shareTokenOf(c)
  let info: AuthzInfo
  if (shareToken) {
    const share = projectId ? await permissions.resolveShareLink(shareToken, projectId) : undefined
    if (!share) return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
    if (share.kind === 'revoked') return { ok: false, status: 410, body: { error: 'gone' } }
    if (share.kind === 'expired') return { ok: false, status: 410, body: { error: 'gone', reason: 'expired' } }
    info = { actor: null, ownerId: owner.ownerId, sharePermission: share.permission }
  } else {
    const actor = resolveActor(c)
    const memberRole = projectId ? await permissions.resolveMemberRole(projectId, actor, owner.ownerId) : undefined
    info = { actor, ownerId: owner.ownerId, memberRole }
  }
  if (canAccessCanvas(info, action) === 'deny') {
    const status = denyStatus(info) === 403 ? 403 : 404
    const body = status === 403 ? { error: 'forbidden' } : { error: 'unknown-canvas' } satisfies UnknownResourceBody
    return { ok: false, status, body }
  }
  return { ok: true, ownerId: owner.ownerId, projectId, actor: info.actor }
}

/**
 * G2.2 decision 1 gate ②:actor-based canvas 访问判定(不经 share token,不走 c)。
 * 用于 attach gate ② 的"经某个已引用该 asset 的画布获得 view entitlement"传递性检查:
 * 遍历 asset references[].canvasId,若 actor 对其中任一画布有 view(read)权 → 视为有 view entitlement。
 * 不考虑 share token(share token 是 per-request 的目标画布凭证,不能用于其他画布的传递性 view)。
 * canvas 不存在/软删/非成员 → false(不泄漏存在)。
 */
export const actorHasCanvasAccess = async (
  backend: PersistBackend,
  permissions: PermissionBackend,
  canvasId: string,
  action: AuthzAction,
  actor: string,
): Promise<boolean> => {
  const owner = backend.getCanvasOwner(canvasId)
  if (!owner) return false
  const got = await backend.get(owner.ownerId, 'canvas', canvasId)
  if (got.kind === 'missing' || got.record.isDeleted) return false
  const projectId = canvasProjectIdOf(got.record)
  if (!projectId) return false
  // 派生 owner:actor===canvas owner → owner 角色矩阵。
  if (actor === owner.ownerId) return canAccessCanvas({ actor, ownerId: owner.ownerId }, action) === 'allow'
  const memberRole = await permissions.resolveMemberRole(projectId, actor, owner.ownerId)
  return canAccessCanvas({ actor, ownerId: owner.ownerId, memberRole }, action) === 'allow'
}
