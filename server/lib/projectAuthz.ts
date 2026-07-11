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
import type { PersistBackend } from '../persist/backend'
import type { PermissionBackend } from './permissions'
import { canAccessProject, denyStatus, type AuthzAction, type AuthzInfo } from './authz'
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
 * 先 getProjectOwner(全局归属);再 share-token 或 actor+member 解析 AuthzInfo;canAccessProject 判。
 */
export const resolveProjectAccess = async (
  c: Context<AppEnv>,
  backend: PersistBackend,
  permissions: PermissionBackend,
  id: string,
  action: AuthzAction,
): Promise<ProjectAccessResult> => {
  const owner = backend.getProjectOwner(id)
  if (!owner) return { ok: false, status: 404, body: { error: 'unknown-project' } satisfies UnknownResourceBody }
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
