// server/routes/shareLinks.ts
// T1.4 分享链接:project-scoped 管理(/api/projects/:id/share-links)+ 公开访问入口(/api/share/:token)。
// 权威:docs/decisions/permission-schema.md §1.2/§4 + §13.5(链接 permission=view/edit,≤ editor,不授 owner)
// + docs/decisions/soft-delete-semantics.md §5.9(revoke → 410 gone;un-revoke 30 天内)。
//
// project-scoped(manage;仅 owner):
//   GET    /:id/share-links                  — 列链接(含 revoked)
//   POST   /:id/share-links                   — 建链接 {permission: view|edit} → 返 token(密码学随机)
//   DELETE /:id/share-links/:linkId           — revoke(revoked_at;FX-7 软删)
//   POST   /:id/share-links/:linkId/restore   — un-revoke(清 revoked_at,30 天内,FX-7 §5.9)
//
// 公开(无鉴权,token 驱动):
//   GET    /api/share/:token                   — 返 project + canvases(read);revoked → 410;unknown → 404
//
// wire shape(server-local,boundary 3 不入 shared 契约)。写访问走带 x-mivo-share-token 的 /api/projects|canvas 路由。

import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import { resolveProjectAccess, denyProjectResponse } from '../lib/projectAuthz'
import { isSharePermission } from '../lib/permissions'
import type { PermissionBackend, ShareLink } from '../lib/permissions'
import type { PersistBackend, PersistRecord } from '../persist/backend'
import { newRequestId, logRequest } from '../lib/request'
import { readJsonBodyWithFingerprint, bodyError } from '../lib/persistHttp'

export type ShareLinkResponse = {
  id: string
  token: string
  projectId: string
  permission: 'view' | 'edit'
  createdBy: string
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  expiresAt: string | null
}

const toShareLinkResponse = (l: ShareLink): ShareLinkResponse => ({
  id: l.id,
  token: l.token,
  projectId: l.projectId,
  permission: l.permission,
  createdBy: l.createdBy,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
  revokedAt: l.revokedAt,
  expiresAt: l.expiresAt,
})

const decodeShareLinkBody = (raw: unknown): { ok: true; permission: 'view' | 'edit' } | { ok: false; status: 400; body: unknown } => {
  const o = (raw ?? {}) as { permission?: unknown }
  if (!isSharePermission(o.permission)) {
    return { ok: false, status: 400, body: { error: 'bad-request', message: 'permission must be view|edit' } }
  }
  return { ok: true, permission: o.permission }
}

/** 局部 project serializer(公开 share 视图复用;不依赖 projects.ts 内部 encoder)。 */
const toProjectMeta = (r: PersistRecord) => {
  const p = (r.payload ?? {}) as { name?: unknown }
  return {
    id: r.id,
    name: typeof p.name === 'string' ? p.name : '',
    ownerId: r.ownerId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    revision: r.revision,
    isDeleted: r.isDeleted,
  }
}
/** 局部 canvas meta serializer(公开 share 视图)。 */
const toCanvasMeta = (r: PersistRecord) => {
  const p = (r.payload ?? {}) as { projectId?: string; title?: string; contentVersion?: number }
  return {
    id: r.id,
    projectId: p.projectId ?? '',
    title: p.title ?? '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    contentVersion: p.contentVersion ?? 0,
  }
}

// ── project-scoped 管理路由(挂 /api/projects)──
export const createShareLinksRoutes = ({ backend, permissions }: { backend: PersistBackend; permissions: PermissionBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  // GET /:id/share-links — 列链接(manage;仅 owner)。
  route.get('/:id/share-links', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'manage')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    const links = await permissions.listShareLinks(id)
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ shareLinks: links.map(toShareLinkResponse) }, 200)
  })

  // POST /:id/share-links — 建链接(manage;仅 owner;token 密码学随机不可枚举)。
  route.post('/:id/share-links', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    let raw: unknown
    try {
      raw = (await readJsonBodyWithFingerprint<unknown>(c)).body
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    const decoded = decodeShareLinkBody(raw)
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, 400)
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'manage')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    const actor = resolveActor(c)
    const link = await permissions.createShareLink(id, decoded.permission, actor)
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 201, latencyMs: Date.now() - t0 })
    return c.json(toShareLinkResponse(link), 201)
  })

  // DELETE /:id/share-links/:linkId — revoke(manage;仅 owner;FX-7 §5.9 revoke→410)。
  route.delete('/:id/share-links/:linkId', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'manage')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    const linkId = c.req.param('linkId')
    const result = await permissions.revokeShareLink(linkId)
    if (!result.ok) {
      const status = result.reason === 'already-revoked' ? 409 : 404
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: result.reason })
      return c.json({ error: result.reason === 'already-revoked' ? 'already-revoked' : 'unknown-share-link' }, status)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0, note: 'revoked' })
    return c.json(toShareLinkResponse(result.link), 200)
  })

  // POST /:id/share-links/:linkId/restore — un-revoke(manage;仅 owner;30 天内,FX-7 §5.9)。
  route.post('/:id/share-links/:linkId/restore', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'manage')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    const linkId = c.req.param('linkId')
    const result = await permissions.unRevokeShareLink(linkId)
    if (!result.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown-share-link' })
      return c.json({ error: 'unknown-share-link' }, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0, note: 'restored' })
    return c.json(toShareLinkResponse(result.link), 200)
  })

  return route
}

// ── 公开访问路由(挂 /api/share;无鉴权,token 驱动)──
export const createShareAccessRoutes = ({ backend, permissions }: { backend: PersistBackend; permissions: PermissionBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  // GET /api/share/:token — 公开入口;resolve token → project + canvases(read);revoked→410,unknown→404。
  route.get('/:token', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const token = c.req.param('token') ?? ''
    const link = await permissions.resolveShareLinkByToken(token)
    if (!link) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown-share-token' })
      return c.json({ error: 'unknown-share-token' }, 404) // 无存在泄漏
    }
    if (link.kind === 'revoked') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 410, latencyMs: Date.now() - t0, note: 'gone' })
      return c.json({ error: 'gone', reason: 'revoked' }, 410) // FX-7 §5.9
    }
    if (link.kind === 'expired') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 410, latencyMs: Date.now() - t0, note: 'gone' })
      return c.json({ error: 'gone', reason: 'expired' }, 410)
    }
    // active:返 project + canvases(read)
    const projectOwner = backend.getProjectOwner(link.projectId)
    if (!projectOwner) {
      // project 已 purge/不存在 → 410(链接活但资源没了)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 410, latencyMs: Date.now() - t0, note: 'gone' })
      return c.json({ error: 'gone', reason: 'project-deleted' }, 410)
    }
    const got = await backend.get(projectOwner.ownerId, 'project', link.projectId)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 410, latencyMs: Date.now() - t0, note: 'gone' })
      return c.json({ error: 'gone', reason: 'project-deleted' }, 410)
    }
    const canvases = (await backend.listCanvasByProject(projectOwner.ownerId, link.projectId)).records
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({
      project: toProjectMeta(got.record),
      canvases: canvases.map(toCanvasMeta),
      permission: link.permission,
    }, 200)
  })

  return route
}
