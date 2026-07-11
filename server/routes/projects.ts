// server/routes/projects.ts
// T1.3 前置:/api/projects — 项目 CRUD(document 域)+ deleteProject 原子级联软删(返修 #2/#7 + N1-N10)。
// T1.4 扩展:authz seam 接 PermissionBackend(memberRole + sharePermission + per-action 角色矩阵);
//   GET / 合并 owned + shared(§13.5"被分享后项目出现在对方列表");DELETE 改 manage(owner-only,FX-7 §5.12)。
// 权威:docs/decisions/api-surface.md §4.1(返修版二)+ docs/decisions/permission-schema.md §2(矩阵)。
//
// 返修要点(N1-N10):
//  - #1/N7 owner/resourceOwner:resolveActor + authz seam(canAccessProject,action-aware);project id 全局唯一
//    (跨 owner 同 id → 409 project-exists);未授权统一 404;授权后以 resourceOwner 查询。
//  - #2/#7/N2 DELETE 改 softDeleteProjectTree(backend 单原子:project + 其 canvas meta + chat-collection);
//    POST 命中 deleted → ensureCreate→restoreProjectTree 原子恢复整树。
//  - #4/N5 If-Match 严格(parseIfMatch;invalid → 400,missing → 428,value → base);#5 wire 不带 revision。
//  - #10/N4 幂等 key 作用域 owner+method+resourceKind+key + fingerprint;同 key 不同 body → 422 reuse-conflict。
//  - #11/N1 request codec;#12 统一 413;#13 N/A(project payload={name},无镜像字段)。
//
// T1.4 越权语义(boundary 3:不改 #194 wire 契约):非成员/无分享 → 404 unknown-project(无泄漏,与 #194 一致);
// 成员/分享越权 → 403 forbidden(server-local body,不入 shared 契约,DP-4 R-4);revoked share → 410 gone(FX-7 §5.9)。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import type { AuthzAction } from '../lib/authz'
import { resolveProjectAccess, denyProjectResponse } from '../lib/projectAuthz'
import type { PermissionBackend } from '../lib/permissions'
import { newRequestId, logRequest, logCompensation } from '../lib/request'
import {
  bodyError,
  decodeCreateProject,
  parseIfMatch,
  preconditionRequired,
  readJsonBodyWithFingerprint,
  reuseConflict,
} from '../lib/persistHttp'
import type {
  ConflictBody,
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  ReuseConflictBody,
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

/** N5:malformed If-Match → 400 bad-request body。 */
const badIfMatch = (id: string) => ({ error: 'bad-request' as const, message: 'If-Match must be a non-negative decimal safe integer', id })

export const createProjectsRoutes = ({ backend, permissions }: { backend: PersistBackend; permissions: PermissionBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  /** T1.4 授权 seam(委托 lib/projectAuthz;非成员 → 404,成员越权 → 403,revoked share → 410,deleted project → 404 除 allowDeleted)。 */
  const authzProject = (c: Context<AppEnv>, id: string, action: AuthzAction, opts?: { allowDeleted?: boolean }) =>
    resolveProjectAccess(c, backend, permissions, id, action, opts)
  const denyProject = (c: Context<AppEnv>, requestId: string, t0: number, r: { ok: false; status: number; body: unknown }): Response =>
    denyProjectResponse(c, requestId, t0, r)

  // GET /api/projects — owned + shared(§13.5"被分享后项目出现在对方列表")。share-token 不适用 list(list 是 actor-scoped)。
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
    const owned = await backend.listByOwner(actor, 'project')
    const projects: Project[] = owned.records.map(toProject)
    // T1.4:合并 shared(editor/viewer 成员资格可见的项目;§13.5)
    const shared = await permissions.listSharedProjects(actor)
    for (const { projectId } of shared) {
      const owner = backend.getProjectOwner(projectId)
      if (!owner) continue
      const got = await backend.get(owner.ownerId, 'project', projectId)
      if (got.kind === 'found' && !got.record.isDeleted) projects.push(toProject(got.record))
    }
    const body: ListProjectsResponse = { projects }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // POST /api/projects — 幂等创建(返修 #1:全局唯一 id;返修 #10 幂等复合 key;N4 reuse-conflict;N2 命中 deleted 原子恢复整树)。
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
    // N4:同 idem key 不同 body → 422 reuse-conflict。
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(idempotencyKey ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    // 返修 #1:跨 owner 同 id → 409 project-exists(全局唯一)。
    if (result.kind === 'exists-other-owner') {
      const err = { error: 'project-exists' as const, id }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'project-exists' })
      return c.json(err, 409)
    }
    // F1 防御:project 无父 project,parent-not-live 不可达;类型收窄(不返 200 假成功)。
    if (result.kind === 'parent-not-live') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'parent-not-live' })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    // FX-7 §7 + P-6 saga:project 软删后重建(restore)→ un-revoke 其 share_links。restore 是两步写(persist 恢复
    // + permission unRevoke)的第二步;失败留 pending 意图,幂等重入(existing)时 attemptCompensation 收敛,
    // 不因幂等直接跳过(旧 bug:POST 幂等成功后不再触发补偿 → 链接永久 revoked)。
    if (result.kind === 'restored') {
      await permissions.recordCompensation(id, 'restore')
    }
    if (result.kind === 'restored' || result.kind === 'existing') {
      const comp = await permissions.attemptCompensation(id, 'restore')
      if (comp.kind === 'failed') {
        logCompensation({ requestId, projectId: id, op: 'restore', outcome: 'failed', error: comp.error, attempts: comp.attempts })
      } else if (comp.kind === 'completed') {
        logCompensation({ requestId, projectId: id, op: 'restore', outcome: 'completed', attempts: comp.attempts, count: comp.count })
      }
    }
    const status = result.kind === 'created' ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toProject(result.record), status)
  })

  // GET /api/projects/:id — T1.4 authz seam(read;share-token view/edit 读;跨 owner/不存在/已软删 → 404 无泄漏)。
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
    const authz = await authzProject(c, id, 'read')
    if (!authz.ok) return denyProject(c, requestId, t0, authz)
    const got = await backend.get(authz.ownerId, 'project', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toProject(got.record), 200)
  })

  // PATCH /api/projects/:id — rename(revision-checked)。返修 #4/N5:缺 base → 428;invalid → 400;N4 reuse-conflict。
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
    const authz = await authzProject(c, id, 'write')
    if (!authz.ok) return denyProject(c, requestId, t0, authz)
    let raw: unknown
    let fingerprint: string
    try {
      // F2:捕获 fingerprint 传入 upsert(防同 idem key 不同 body 返 200——N4 reuse-conflict 依赖 bodyFingerprint)。
      const r = await readJsonBodyWithFingerprint<{ name?: unknown }>(c)
      raw = r.body
      fingerprint = r.fingerprint
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    const b = (raw ?? {}) as { name?: unknown }
    const got = await backend.get(authz.ownerId, 'project', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const existingName = isProjectPayload(got.record.payload) ? got.record.payload.name : ''
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : existingName
    // N5:If-Match 严格(parseIfMatch;invalid → 400,missing → 428 via backend,value → base)。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(id), 400)
    }
    const base = parsed.kind === 'value' ? parsed.revision : undefined
    const result = await backend.upsert(authz.ownerId, 'project', id, { name } satisfies ProjectPayload, {
      base,
      scope: 'document',
      method: 'PATCH',
      resourceKind: 'project',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: fingerprint, // F2:同 idem key 同 body 200 不 bump / 不同 body 422
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(id), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    // F3 防御:upsert missing 跨 owner 同 id → 409 project-exists(route 层 authz+预检已阻,backend 防御性)。
    if (result.kind === 'exists-other-owner') {
      const err = { error: 'project-exists' as const, id }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'project-exists' })
      return c.json(err, 409)
    }
    // F1 防御:project PATCH 无父 project,parent-not-live 不可达;类型收窄。
    if (result.kind === 'parent-not-live') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'parent-not-live' })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toProject(result.record), 200)
  })

  // DELETE /api/projects/:id — 返修 #2/#7:softDeleteProjectTree 原子级联(project + canvas meta + chat-collection)。
  // T1.4:action=manage(owner-only,FX-7 §5.12:editor deleteProject → 403)。idempotent:删已软删 → 204;不存在 → 404。
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
    // P1-3:DELETE 幂等(删已删 → 204)须访问已删 project → allowDeleted=true;其他子资源用默认(不允许)。
    const authz = await authzProject(c, id, 'manage', { allowDeleted: true })
    if (!authz.ok) return denyProject(c, requestId, t0, authz)
    const got = await backend.get(authz.ownerId, 'project', id)
    if (got.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    if (!got.record.isDeleted) {
      await backend.softDeleteProjectTree(authz.ownerId, id)
      // P-6 saga:softDelete 成功后才记 delete 补偿意图(softDelete 抛错则不到此,无需补偿)。
      await permissions.recordCompensation(id, 'delete')
    }
    // P-6:always attempt delete compensation(fresh:recorded above + attempts;reentry already-deleted:retries pending)。
    // 旧代码:revoke 在 if 块内,reentry(已删)跳过 → revoke 失败永不重试(链接永久 active)。现 attemptCompensation 收敛。
    const delComp = await permissions.attemptCompensation(id, 'delete')
    if (delComp.kind === 'failed') {
      logCompensation({ requestId, projectId: id, op: 'delete', outcome: 'failed', error: delComp.error, attempts: delComp.attempts })
    } else if (delComp.kind === 'completed') {
      logCompensation({ requestId, projectId: id, op: 'delete', outcome: 'completed', attempts: delComp.attempts, count: delComp.count })
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
