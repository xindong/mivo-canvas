// server/routes/projects.ts
// T1.3 前置:/api/projects — 项目 CRUD(document 域)+ deleteProject 级联软删画布(DP-3)。
// 权威:docs/decisions/api-surface.md §4.1。
// 契约:additive(不属 dev middleware 平移面),同 tasks-async.md 定位;不进 __captures__ 基线,
// 验收由 routes/projects.route.test.ts(内存 backend)覆盖。
//
// 鉴权:resolveOwner(c)(FX-2 指纹;§13.5 目标 maker user id)+ rejectInvalidMivoApiKey(F4 边界)。
// payload 透明:Project 信封 payload = {name};id/ownerId/timestamps/revision/isDeleted 在信封列。
//
// PG swap:backend 注入点(createPersistBackend → PgPersistBackend),路由 handler 零改动(§6)。

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveOwner } from '../lib/owner'
import { newRequestId, logRequest, readJsonBody } from '../lib/request'
import { RequestBodyTooLargeError } from '../lib/upstream'
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

/** Canvas 信封 payload(级联查询用:projectId 在 payload)。 */
type CanvasPayload = { projectId: string; title?: string }

const isProjectPayload = (p: unknown): p is ProjectPayload =>
  typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string'

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

  // GET /api/projects — owner 全部未软删项目。
  route.get('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const owner = resolveOwner(c)
    const { records } = await backend.listByOwner(owner, 'project')
    const body: ListProjectsResponse = { projects: records.map(toProject) }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // POST /api/projects — 幂等创建(同 id+owner 已存在→200 既有;id 缺失→服务端生成 UUID)。
  route.post('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    let body: CreateProjectRequest
    try {
      body = await readJsonBody<CreateProjectRequest>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'name is required' }, 400)
    }
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID()
    const owner = resolveOwner(c)
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    const result = await backend.ensureCreate(owner, 'project', id, { name } satisfies ProjectPayload, {
      scope: 'document',
      idempotencyKey,
    })
    // project-exists(跨 owner 同 id 冲突):owner 分片下 id 唯一;同 owner 的同 id 走 existing/restored。
    // 跨 owner 同 id 在分片表里是不同主键(附录 A PK=owner_id+type+id),不冲突——但内存实现
    // bucket 隔离也如此。故此处无 project-exists 分支(id owner-scoped 唯一)。
    const status = result.kind === 'created' ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toProject(result.record), status)
  })

  // GET /api/projects/:id — owner-scoped;跨 owner/不存在/已软删 → 404(无存在泄漏,§1)。
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
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'project', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      const err: UnknownResourceBody = { error: 'unknown-project' }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json(err, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toProject(got.record), 200)
  })

  // PATCH /api/projects/:id — rename(revision-checked)。不存在/已软删 → 404;stale → 409。
  route.patch('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    let body: { name?: unknown; revision?: number }
    try {
      body = await readJsonBody<{ name?: unknown; revision?: number }>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    const id = c.req.param('id')
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'project', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const existingName = isProjectPayload(got.record.payload) ? got.record.payload.name : ''
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existingName
    const ifMatch = c.req.header('if-match')
    const revision = body.revision !== undefined ? body.revision : ifMatch !== undefined ? Number(ifMatch) : undefined
    const result = await backend.upsert(owner, 'project', id, { name } satisfies ProjectPayload, {
      revision,
      scope: 'document',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toProject(result.record), 200)
  })

  // DELETE /api/projects/:id — 软删 project + 级联软删其画布(DP-3,含画布的 chat 子树)。
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
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'project', id)
    if (got.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    // 级联:owner 的所有 canvas,filter payload.projectId === id(DP-5 projectId 在 payload,
    // 内存实现 list+filter;PG 实现可加 jsonb 表达式索引,impl 细节非契约变更)。
    const { records: canvases } = await backend.listByOwner(owner, 'canvas', { includeDeleted: false })
    for (const cv of canvases) {
      const cp = cv.payload as CanvasPayload
      if (cp.projectId !== id) continue
      await backend.cascadeSoftDeleteByCanvas(owner, cv.id) // nodes/edges/anchors/chat by canvas_id
      await backend.softDelete(owner, 'canvas', cv.id)      // canvas meta(canvas_id=null)
    }
    await backend.softDelete(owner, 'project', id)
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
