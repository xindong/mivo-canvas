// server/routes/projects.ts
// T1.3 前置:/api/projects — 项目 CRUD(document 域)+ deleteProject 原子级联软删(返修 #2/#7)。
// 权威:docs/decisions/api-surface.md §4.1(返修版)。
// 契约:additive;验收由 routes/projects.route.test.ts(内存 backend)覆盖。
//
// 返修要点:
//  - #1 owner/resourceOwner:resolveActor + authz seam(canAccessProject);project id 全局唯一
//    (跨 owner 同 id → 409 project-exists);未授权统一 404。
//  - #2/#7 DELETE 改 softDeleteProjectTree(backend 单原子:project + 其 canvas meta + chat-collection)。
//  - #4 If-Match 严格优先,existing 缺 base → 428;#5 wire 不带 revision。
//  - #10 幂等 key 作用域 owner+method+resourceKind+key + fingerprint。
//  - #11 request codec;#12 统一 413;#13 N/A(project payload={name},无镜像字段)。

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import { canAccessProject } from '../lib/authz'
import { newRequestId, logRequest } from '../lib/request'
import {
  baseFromIfMatch,
  bodyError,
  decodeCreateProject,
  preconditionRequired,
  readJsonBodyWithFingerprint,
} from '../lib/persistHttp'
import type {
  ConflictBody,
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  UnknownResourceBody,
} from '../../shared/persist-contract.ts'
import type { PersistBackend, PersistRecord } from '../persist/backend'

/** Project 信封 payload(DP-5:name 是唯一域字段;其余在信封列)。 */
type ProjectPayload = { name: string }

const isProjectPayload = (p: unknown): p is ProjectPayload =>
  typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string'

/** 返修 #11:response encoder(satisfies shared Project 类型,compile-time interlock)。 */
const toProject = (r: PersistRecord): Project => ({
  id: r.id,
  name: isProjectPayload(r.payload) ? r.payload.name : '',
  ownerId: r.ownerId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  revision: r.revision,
  isDeleted: r.isDeleted,
})

export const createProjectsRoutes = ({ backend }: { backend: PersistBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  /** 返修 #1:授权 seam——project id 全局唯一,未授权/不存在统一 404(无泄漏)。 */
  const authzProject = (actor: string, id: string): { ownerId: string } | null => {
    const owner = backend.getProjectOwner(id)
    if (!owner || canAccessProject(actor, owner.ownerId) === 'deny') return null
    return owner
  }

  // GET /api/projects — owner 全部未软删项目(T1.3 seam:owner===actor)。
  route.get('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const actor = resolveActor(c)
    const { records } = await backend.listByOwner(actor, 'project')
    const body: ListProjectsResponse = { projects: records.map(toProject) }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // POST /api/projects — 幂等创建(返修 #1:全局唯一 id;返修 #10 幂等复合 key)。
  route.post('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    let decoded
    try {
      const { body: raw, fingerprint } = await readJsonBodyWithFingerprint<unknown>(c)
      decoded = decodeCreateProject(raw, fingerprint)
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: decoded.status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, decoded.status as 400 | 413)
    }
    const reqBody: CreateProjectRequest = decoded.value
    const id = reqBody.id && reqBody.id.trim() ? reqBody.id.trim() : randomUUID()
    const actor = resolveActor(c)
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    const result = await backend.ensureCreate(actor, 'project', id, { name: reqBody.name } satisfies ProjectPayload, {
      scope: 'document',
      method: 'POST',
      resourceKind: 'project',
      idempotencyKey,
      bodyFingerprint: decoded.fingerprint,
    })
    // 返修 #1:跨 owner 同 id → 409 project-exists(全局唯一)。
    if (result.kind === 'exists-other-owner') {
      const err = { error: 'project-exists' as const, id }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'project-exists' })
      return c.json(err, 409)
    }
    const status = result.kind === 'created' ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toProject(result.record), status)
  })

  // GET /api/projects/:id — 返修 #1 授权 seam;跨 owner/不存在/已软删 → 404(无泄漏)。
  route.get('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const owner = authzProject(actor, id)
    if (!owner) {
      const err: UnknownResourceBody = { error: 'unknown-project' }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json(err, 404)
    }
    const got = await backend.get(actor, 'project', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      const err: UnknownResourceBody = { error: 'unknown-project' }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json(err, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toProject(got.record), 200)
  })

  // PATCH /api/projects/:id — rename(revision-checked)。返修 #4:缺 base → 428。
  route.patch('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const owner = authzProject(actor, id)
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    let raw: unknown
    try {
      raw = await readJsonBodyWithFingerprint<{ name?: unknown }>(c).then((r) => r.body)
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    const b = (raw ?? {}) as { name?: unknown }
    const got = await backend.get(actor, 'project', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const existingName = isProjectPayload(got.record.payload) ? got.record.payload.name : ''
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : existingName
    const base = baseFromIfMatch(c.req.header('if-match'))
    const result = await backend.upsert(actor, 'project', id, { name } satisfies ProjectPayload, {
      base,
      scope: 'document',
      method: 'PATCH',
      resourceKind: 'project',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(id), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toProject(result.record), 200)
  })

  // DELETE /api/projects/:id — 返修 #2/#7:softDeleteProjectTree 原子级联(project + canvas meta + chat-collection)。
  // idempotent:删已软删 → 204;不存在 → 404。
  route.delete('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const owner = authzProject(actor, id)
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const got = await backend.get(actor, 'project', id)
    if (got.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    if (!got.record.isDeleted) {
      await backend.softDeleteProjectTree(actor, id)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
