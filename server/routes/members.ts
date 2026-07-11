// server/routes/members.ts
// T1.4 /api/projects/:id/members — 项目成员资格管理(owner 邀请 editor/viewer)。
// 权威:docs/decisions/permission-schema.md §3(派生 owner + explicit editor/viewer)+ §13.5"仅 owner 可邀请"。
//
// 路由(挂 /api/projects):
//   GET    /:id/members           — 列成员(read;owner+成员可见,合成 owner 派生行)
//   POST   /:id/members            — 邀请/改 role(manage;仅 owner;role ∈ editor/viewer,拒 owner)
//   PATCH  /:id/members/:userId    — 改 role(manage;仅 owner)
//   DELETE /:id/members/:userId    — 移除成员(manage;仅 owner)
//
// wire shape(server-local,boundary 3 不入 shared 契约):{ id, projectId, userId, role, createdAt, updatedAt }。
// 越权语义(同 persist 路由):非成员/无分享 → 404 unknown-project;成员越权 → 403 forbidden。

import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveProjectAccess, denyProjectResponse } from '../lib/projectAuthz'
import { isProjectRole } from '../lib/permissions'
import type { PermissionBackend, ProjectMember } from '../lib/permissions'
import type { PersistBackend } from '../persist/backend'
import { newRequestId, logRequest } from '../lib/request'
import { readJsonBodyWithFingerprint, bodyError } from '../lib/persistHttp'

export type MemberRole = 'editor' | 'viewer' // wire:不收 owner(owner 派生)
export type MemberResponse = {
  id: string
  projectId: string
  userId: string
  role: 'owner' | 'editor' | 'viewer'
  createdAt: string
  updatedAt: string
}

const toMemberResponse = (m: ProjectMember): MemberResponse => ({
  id: m.id,
  projectId: m.projectId,
  userId: m.userId,
  role: m.role,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
})

const decodeMemberBody = (raw: unknown): { ok: true; userId: string; role: MemberRole } | { ok: false; status: 400; body: unknown } => {
  const o = (raw ?? {}) as { userId?: unknown; role?: unknown }
  if (typeof o.userId !== 'string' || !o.userId.trim()) {
    return { ok: false, status: 400, body: { error: 'bad-request', message: 'userId is required' } }
  }
  if (!isProjectRole(o.role)) {
    return { ok: false, status: 400, body: { error: 'bad-request', message: 'role must be owner|editor|viewer' } }
  }
  if (o.role === 'owner') {
    return { ok: false, status: 400, body: { error: 'bad-request', message: 'cannot invite owner (owner is derived from project.ownerId)' } }
  }
  return { ok: true, userId: o.userId.trim(), role: o.role as MemberRole }
}

export const createMembersRoutes = ({ backend, permissions }: { backend: PersistBackend; permissions: PermissionBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  // GET /:id/members — 列成员(read;owner + 成员可见;合成 owner 派生行 §3)。
  route.get('/:id/members', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'read')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    const members = await permissions.listMembers(id, authz.ownerId)
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ members: members.map(toMemberResponse) }, 200)
  })

  // POST /:id/members — 邀请/改 role(manage;仅 owner;§13.5 第一版关死转授权)。
  route.post('/:id/members', async (c) => {
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
    const decoded = decodeMemberBody(raw)
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, 400)
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'manage')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    const result = await permissions.upsertMember(id, decoded.userId, decoded.role)
    if (!result.ok) {
      // is-owner:试图显式加 owner 行(派生,§3 拒)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'is-owner' })
      return c.json({ error: 'bad-request', message: 'cannot invite owner' }, 400)
    }
    const status = result.created ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toMemberResponse(result.member), status)
  })

  // PATCH /:id/members/:userId — 改 role(manage;仅 owner)。
  route.patch('/:id/members/:userId', async (c) => {
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
    const decoded = decodeMemberBody(raw)
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, 400)
    }
    // path :userId 须与 body userId 一致(防歧义)
    const pathUserId = c.req.param('userId')
    if (pathUserId !== decoded.userId) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'user-mismatch' })
      return c.json({ error: 'bad-request', message: 'userId in path must match body' }, 400)
    }
    const id = c.req.param('id')
    const authz = await resolveProjectAccess(c, backend, permissions, id, 'manage')
    if (!authz.ok) return denyProjectResponse(c, requestId, t0, authz)
    // upsertMember 已存在 → 改 role(符合 PATCH 语义);不存在 → 创建(幂等 upsert)
    const result = await permissions.upsertMember(id, decoded.userId, decoded.role)
    if (!result.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'is-owner' })
      return c.json({ error: 'bad-request', message: 'cannot set owner role' }, 400)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toMemberResponse(result.member), 200)
  })

  // DELETE /:id/members/:userId — 移除成员(manage;仅 owner;硬删行,member 不软删)。
  route.delete('/:id/members/:userId', async (c) => {
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
    const userId = c.req.param('userId')
    const result = await permissions.removeMember(id, userId)
    if (!result.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown-member' })
      return c.json({ error: 'unknown-member' }, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
