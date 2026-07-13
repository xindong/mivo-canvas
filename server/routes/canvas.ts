// server/routes/canvas.ts
// T1.3 前置:/api/canvas — 画布 record(document 域:canvas meta + node/edge/anchor 子 record)
// + 节点级 PATCH(FX-4,1MB/413,revision 409)+ chat 子资源(DP-6)+ 返修 N1-N10。
// T1.4 扩展:authzCanvas 接 PermissionBackend(按 canvas 的 project 查 memberRole + sharePermission +
// per-action 矩阵);DELETE 改 manage(owner-only);GET / 合并 owned + shared-project canvases。
// 权威:docs/decisions/api-surface.md §4.2(返修版二)+ docs/decisions/permission-schema.md §2(矩阵)。
//
// 返修要点(N1-N10):
//  - N1:PATCH child payload 经 shared validateChildPayload(逐 type 白名单)+ GET 回读 envelope revision 回填。
//  - N2:POST canvas 'restored' → backend restoreCanvasTree(原子恢复 canvas meta + chat-collection);chat route 校验 collection live。
//  - N3:chat POST 用 ensureCreateChild(canvas_id 校验 existing/idem-replay/cross-canvas 全验)。
//  - N4:同 idem key 不同 fingerprint → 422 reuse-conflict。
//  - N5:If-Match 严格(parseIfMatch;malformed → 400 bad-request,missing → 428,value → base)。
//  - N7:authz seam 真接线——authzCanvas(canAccessCanvas,action-aware)所有 route + move 双端(project source+target)。
//  - N8:reorder orderedIds 全等+唯一;If-Match contentVersion 冲突 409;bump contentVersion+timestamps。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import { canAccessCanvas, canAccessProject, denyStatus, type AuthzAction, type AuthzInfo } from '../lib/authz'
import { resolveProjectAccess, denyProjectResponse, shareTokenOf } from '../lib/projectAuthz'
import type { PermissionBackend } from '../lib/permissions'
import { newRequestId, logRequest } from '../lib/request'
import {
  bodyError,
  decodeCreateCanvas,
  decodeUpsertRequest,
  parseIfMatch,
  preconditionRequired,
  readJsonBodyWithFingerprint,
  reuseConflict,
  validateChildPayload,
} from '../lib/persistHttp'
import { encodeBase, decodeBase } from '../lib/baseCursor'
import { validateDomainOps, validateCreateBody, validateLegacyReplaceRequest, DomainOpError, type DomainOp, type LegacyReplaceRequest } from '../lib/domainOp'
import { legacyDrainGate } from '../lib/legacyDrainGate'
import type {
  CanvasMeta,
  ConflictBody,
  CreateCanvasRequest,
  GetCanvasResponse,
  ListCanvasResponse,
  ListChatMessagesResponse,
  RecordEntry,
  RequireLoginBody,
  ReuseConflictBody,
  UnknownResourceBody,
  UpsertResponse,
} from '../../shared/persist-contract.ts'
import type { PersistBackend, PersistRecord } from '../persist/backend'

/** CanvasMeta 信封 payload(DP-5 + 返修 #5:contentVersion backend 维护;#8 sourceTemplateId/projectId 域字段)。 */
type CanvasPayload = { projectId: string; title?: string; sourceTemplateId?: string; contentVersion?: number }

const isCanvasPayload = (p: unknown): p is CanvasPayload =>
  typeof p === 'object' && p !== null && typeof (p as { projectId?: unknown }).projectId === 'string'

/** 返修 #5/#8/#11:response encoder(satisfies CanvasMeta,metaRevision/contentVersion 分名)。 */
const toCanvasMeta = (r: PersistRecord): CanvasMeta => {
  const cp = isCanvasPayload(r.payload) ? r.payload : { projectId: '' }
  return {
    id: r.id,
    projectId: cp.projectId,
    title: cp.title ?? '',
    sourceTemplateId: cp.sourceTemplateId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    metaRevision: r.revision,
    contentVersion: cp.contentVersion ?? 0,
  }
}

const toEntry = (r: PersistRecord): RecordEntry => ({
  id: r.id,
  revision: r.revision,
  orderKey: r.orderKey,
  payload: r.payload,
})

const badMivo = (c: Context<AppEnv>, requestId: string, t0: number): Response => {
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
  return c.json({ error: 'bad-mivo-key' }, 400)
}

/** N5:malformed If-Match → 400 bad-request body。 */
const badIfMatch = (id: string) => ({ error: 'bad-request' as const, message: 'If-Match must be a non-negative decimal safe integer', id })

export const createCanvasRoutes = ({ backend, permissions }: { backend: PersistBackend; permissions: PermissionBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  /**
   * T1.4 授权 seam——canvas 先 getCanvasOwner 全局归属,再 fetch meta 取 projectId(成员资格按 project 查),
   * 按 share-token 或 actor+member 解析 AuthzInfo;canAccessCanvas(角色矩阵)判。
   * 派生 owner:canvas.ownerId === project.ownerId,actor===ownerId → owner(§3;T1.3 owner===actor 自归属)。
   * 非成员/无分享 → 404 unknown-canvas(无泄漏);成员/分享越权 → 403;revoked share → 410。
   * 授权后返 record(route 免二次 get)。
   */
  const authzCanvas = async (
    c: Context<AppEnv>,
    canvasId: string,
    action: AuthzAction,
  ): Promise<
    | { ok: true; ownerId: string; projectId: string; record: PersistRecord; actor: string | null }
    | { ok: false; status: number; body: unknown }
  > => {
    const owner = backend.getCanvasOwner(canvasId)
    if (!owner) return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
    const got = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (got.kind === 'missing') {
      return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
    }
    // soft-deleted canvas:read/write/move → 404(已不可见);manage(delete)→ 放行(idempotent delete 已删→204,§2)
    if (got.record.isDeleted && action !== 'manage') {
      return { ok: false, status: 404, body: { error: 'unknown-canvas' } satisfies UnknownResourceBody }
    }
    const projectId = isCanvasPayload(got.record.payload) ? got.record.payload.projectId : ''
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
    // DP-6R:返 actor(share-token 路径=null / 匿名访客);chat 路由据此判 401 require-login + 用 actor 作 chat-message 存储 owner。
    return { ok: true, ownerId: owner.ownerId, projectId, record: got.record, actor: info.actor }
  }

  /** authzCanvas deny → Response(统一日志)。 */
  const denyCanvas = (c: Context<AppEnv>, requestId: string, t0: number, r: { ok: false; status: number; body: unknown }): Response => {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: r.status, latencyMs: Date.now() - t0, note: r.status === 403 ? 'forbidden' : r.status === 410 ? 'gone' : 'unknown-canvas' })
    return c.json(r.body as Record<string, unknown>, r.status as 400 | 403 | 404 | 410)
  }

  /**
   * DP-6R:匿名 share-link 访客(actor=null / 无稳定 identity)chat 读写 → 401 require-login。
   * 画布按链接角色可访问,但 chat per-user 需稳定 identity;无 identity 不可写 chat collection,引导客户端登录。
   * 复用 authzCanvas(actor 字段)判定;chat CRUD 路由在 authz ok 后先检此。
   */
  const requireLogin = (c: Context<AppEnv>, requestId: string, t0: number): Response => {
    const body = { error: 'require-login' } satisfies RequireLoginBody
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 401, latencyMs: Date.now() - t0, note: 'require-login' })
    return c.json(body, 401)
  }

  /** 返修 N2:chat route 校验 collection live(canvas 未软删 + chat-collection record 未软删)。 */
  const collectionLive = async (ownerId: string, canvasId: string): Promise<boolean> => {
    const coll = await backend.get(ownerId, 'chat-collection', canvasId)
    return coll.kind === 'found' && !coll.record.isDeleted
  }

  // ── 返修 #8:canvas 枚举(按 project/owner)──
  route.get('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const projectId = c.req.query('projectId')?.toString()
    let records: PersistRecord[]
    if (projectId) {
      // T1.4:projectId 给定 → project read-authz(owner/member/share);授权后以 projectOwner 查 canvas。
      const projectOwner = backend.getProjectOwner(projectId)
      if (!projectOwner) {
        records = []
      } else {
        const shareToken = shareTokenOf(c)
        let info: AuthzInfo
        if (shareToken) {
          const share = await permissions.resolveShareLink(shareToken, projectId)
          // 未知/不属此 project 的 token → 当无访问(空 list,无泄漏);revoked/expired 也空
          info = share && share.kind === 'active'
            ? { actor: null, ownerId: projectOwner.ownerId, sharePermission: share.permission }
            : { actor: null, ownerId: projectOwner.ownerId }
        } else {
          const actor = resolveActor(c)
          const memberRole = await permissions.resolveMemberRole(projectId, actor, projectOwner.ownerId)
          info = { actor, ownerId: projectOwner.ownerId, memberRole }
        }
        records = canAccessProject(info, 'read') === 'allow'
          ? (await backend.listCanvasByProject(projectOwner.ownerId, projectId)).records
          : []
      }
    } else {
      // T1.4:无 projectId → owned canvases + shared-project canvases(§13.5 被分享后可见)
      const actor = resolveActor(c)
      const owned = await backend.listByOwner(actor, 'canvas')
      records = owned.records
      const shared = await permissions.listSharedProjects(actor)
      for (const { projectId: pid } of shared) {
        const po = backend.getProjectOwner(pid)
        if (!po) continue
        const r = await backend.listCanvasByProject(po.ownerId, pid)
        records = records.concat(r.records)
      }
    }
    const body: ListCanvasResponse = { canvases: records.map(toCanvasMeta) }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // GET /api/canvas/:id — 全量(meta + nodes/edges/anchors,跨设备原样在)。T1.4 authz(member/share read)。
  route.get('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const id = c.req.param('id')
    const authz = await authzCanvas(c, id, 'read')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    const [nodes, edges, anchors] = await Promise.all([
      backend.listByCanvas(authz.ownerId, id, 'node'),
      backend.listByCanvas(authz.ownerId, id, 'edge'),
      backend.listByCanvas(authz.ownerId, id, 'anchor'),
    ])
    const body: GetCanvasResponse = {
      ...toCanvasMeta(authz.record),
      nodes: nodes.records.map(toEntry),
      edges: edges.records.map(toEntry),
      anchors: anchors.records.map(toEntry),
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // POST /api/canvas — 幂等创建(projectId 须属本 owner,否则 404 unknown-project)+ 建 chat-collection record。
  route.post('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let decoded
    try {
      const { body: raw, fingerprint } = await readJsonBodyWithFingerprint<unknown>(c)
      decoded = decodeCreateCanvas(raw, fingerprint)
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: decoded.status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, decoded.status as 400 | 413)
    }
    const reqBody: CreateCanvasRequest = decoded.value
    // T1.4:project write-authz(委托 resolveProjectAccess,统一 actor + share-token 路径;editor+/share-edit 可建 canvas,
    // viewer → 403,非成员 → 404 unknown-project)。Greptile 修复:分享链接 edit 也能建 canvas(复用同一授权路径)。
    const projectAuthz = await resolveProjectAccess(c, backend, permissions, reqBody.projectId, 'write')
    if (!projectAuthz.ok) return denyProjectResponse(c, requestId, t0, projectAuthz)
    const id = reqBody.id && reqBody.id.trim() ? reqBody.id.trim() : randomUUID()
    const cp: CanvasPayload = { projectId: reqBody.projectId, title: reqBody.title, sourceTemplateId: reqBody.sourceTemplateId }
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    // F1:单一原子原语 createCanvasWithCollection(canvas meta + chat-collection 同一操作,防 ensureCreate(canvas)→
    // 独立 ensureCreate(chat-collection) 两段间的 TOCTOU——中间并发 DELETE project 会产生软删树下 live orphan collection)。
    // T1.4:canvas ownerId = projectOwner(非 actor);成员/分享链接建的画布仍属 project owner,owner 派生统一。
    const result = await backend.createCanvasWithCollection(projectAuthz.ownerId, id, cp, {
      method: 'POST',
      resourceKind: 'canvas',
      idempotencyKey,
      bodyFingerprint: decoded.fingerprint,
    })
    // N4:同 idem key 不同 body → 422 reuse-conflict。
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(idempotencyKey ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    // F4:canvas 跨 owner 同 id → 409 canvas-exists(全局唯一,与 project 同模式)。
    if (result.kind === 'exists-other-owner') {
      const err = { error: 'canvas-exists' as const, id }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'canvas-exists' })
      return c.json(err, 409)
    }
    // F1:父 project 软删/不存在 → 404 unknown-project(软删 parent 下禁独立 child create/restore,只许 POST project 整树恢复)。
    if (result.kind === 'parent-not-live') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'parent-not-live' })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    // created(canvas+collection 原子建)/restored(restoreCanvasTree 原子恢复 collection)/existing —— collection 全 live。
    const status = result.kind === 'created' ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toCanvasMeta(result.record), status)
  })

  // PUT /api/canvas/:id — doc-level meta 更新(revision-checked,#4 428;#8 move=projectId 可改;N7 move 双端 authz)。
  route.put('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let decoded
    try {
      const { body: raw, fingerprint } = await readJsonBodyWithFingerprint<unknown>(c)
      decoded = decodeUpsertRequest(raw, fingerprint)
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: decoded.status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, decoded.status as 400 | 413)
    }
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const authz = await authzCanvas(c, id, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    const existing = isCanvasPayload(authz.record.payload) ? authz.record.payload : { projectId: '' }
    const incoming = (decoded.value.payload ?? {}) as Partial<CanvasPayload>
    // 返修 #8/N7 move:projectId 可改(若提供且属本 owner;move 双端 authz:source canvas + target project)。
    let projectId = existing.projectId ?? ''
    if (typeof incoming.projectId === 'string' && incoming.projectId && incoming.projectId !== projectId) {
      // Greptile 第三轮修复:move 在 source 端须 'move'(owner-only),不能降级为 'write'(否则 editor/share-edit 可把他人画布移到自己项目)。
      const sourceMove = await authzCanvas(c, id, 'move')
      if (!sourceMove.ok) return denyCanvas(c, requestId, t0, sourceMove)
      const targetOwner = backend.getProjectOwner(incoming.projectId)
      // T1.4:move target project authz('move';仅 owner,§2 矩阵);非成员 → 404,成员越权 → 403。
      if (!targetOwner) {
        logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown-project' })
        return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
      }
      const targetMemberRole = await permissions.resolveMemberRole(incoming.projectId, actor, targetOwner.ownerId)
      const targetInfo: AuthzInfo = { actor, ownerId: targetOwner.ownerId, memberRole: targetMemberRole }
      if (canAccessProject(targetInfo, 'move') === 'deny') {
        const status = denyStatus(targetInfo) === 403 ? 403 : 404
        logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: status === 403 ? 'forbidden' : 'unknown-project' })
        return c.json(status === 403 ? { error: 'forbidden' } : { error: 'unknown-project' } satisfies UnknownResourceBody, status as 403 | 404)
      }
      projectId = incoming.projectId
    }
    const cp: CanvasPayload = {
      projectId,
      title: typeof incoming.title === 'string' ? incoming.title : existing.title,
      sourceTemplateId: typeof incoming.sourceTemplateId === 'string' ? incoming.sourceTemplateId : existing.sourceTemplateId,
    }
    // N5:If-Match 严格(parseIfMatch;invalid → 400,missing → 428 via backend,value → base)。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(id), 400)
    }
    const base = parsed.kind === 'value' ? parsed.revision : undefined
    const result = await backend.upsert(authz.ownerId, 'canvas', id, cp, {
      base,
      scope: 'document',
      method: 'PUT',
      resourceKind: 'canvas',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    // F1:move 目标 project 软删/不存在 → 404 unknown-project(防 move 到软删 project)。
    if (result.kind === 'parent-not-live') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'parent-not-live' })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    // F3 防御:upsert missing 跨 owner 同 id → 409 canvas-exists(route 层 authz+预检已阻,backend 防御性)。
    if (result.kind === 'exists-other-owner') {
      const err = { error: 'canvas-exists' as const, id }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'canvas-exists' })
      return c.json(err, 409)
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
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toCanvasMeta(result.record), 200)
  })

  // DELETE /api/canvas/:id — T1.4:action=manage(owner-only,FX-7 §5.12);softDeleteCanvasTree 原子。
  route.delete('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const id = c.req.param('id')
    const authz = await authzCanvas(c, id, 'manage')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    if (!authz.record.isDeleted) {
      await backend.softDeleteCanvasTree(authz.ownerId, id)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  // ── 返修 N8:重排子资源顺序(orderedIds 全等+唯一;If-Match contentVersion 冲突 409)──
  route.post('/:id/reorder', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let body: { type?: unknown; orderedIds?: unknown }
    try {
      body = await readJsonBodyWithFingerprint<{ type?: unknown; orderedIds?: unknown }>(c).then((r) => r.body)
    } catch (error) {
      const { status, body: errBody } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(errBody, status as 400 | 413)
    }
    const type = body.type
    const orderedIds = Array.isArray(body.orderedIds) ? (body.orderedIds as unknown[]).filter((x): x is string => typeof x === 'string') : null
    const validType = type === 'node' || type === 'edge' || type === 'anchor' || type === 'chat-message'
    if (!validType || !orderedIds) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'bad-request', message: 'type and orderedIds are required' }, 400)
    }
    const id = c.req.param('id')
    const authz = await authzCanvas(c, id, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    // DP-6R:chat-message reorder per-actor——匿名访客 → 401 require-login;存储 owner=actor(node/edge/anchor 仍 canvas owner)。
    let reorderOwner: string
    if (type === 'chat-message') {
      if (authz.actor === null) return requireLogin(c, requestId, t0)
      reorderOwner = authz.actor
    } else {
      reorderOwner = authz.ownerId
    }
    // N5/F5:If-Match base 必填——invalid → 400;missing → 428(precondition-required);stale → 409(两并发一成一 409)。
    // DP-6R P1-2:type=chat-message 时 base = per-actor×canvas orderRevision(非共享 cv);node/edge/anchor base = 共享 contentVersion。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(id), 400)
    }
    if (parsed.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(id), 428)
    }
    const base = parsed.revision
    const result = await backend.reorderChildren(reorderOwner, id, type, orderedIds, { base })
    if (result.kind === 'bad') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: `reorder-${result.reason}` })
      return c.json({ error: 'bad-request', message: `orderedIds ${result.reason}` }, 400)
    }
    if (result.kind === 'conflict') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'reorder-conflict' })
      return c.json({ error: 'revision-conflict', id, currentRevision: result.currentContentVersion } satisfies ConflictBody, 409)
    }
    if (result.kind !== 'ok') {
      // precondition-required(reorder If-Match 可选,目前 backend 不触发;防御 428)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(id), 428)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ reordered: result.reordered, contentVersion: result.contentVersion }, 200)
  })

  // ── A2-S2 §14.3:legacy drain envelope(PATCH /:id/nodes/:nodeId 复用 decoder wire;FX-5 队列迁移 drain-only 兼容通道)──
  // 蓝本:src/kernel/__spike__/n20-truth-source.spike.test.ts CutoverHarness L2273-2403(语义蓝本,生产化到 route)。
  // 顺序:validate wire(400)→ authzCanvas('write')(403/404)→ null-actor 401(requireLogin,同 child-write 约定)→
  //   LEGACY_DRAIN gate(关→400)→ scope(env.canvasId/nodeId 匹配 path,防同 nodeId 跨 canvas 重放→400)→
  //   touchWindow(envelope 到达重计 quiet-window)→ backend.legacyReplaceDrain 四态→ 映射 200/409/404/422。
  // retirement 是进程内观测(canRetire 的 pendingGauge 由 ops 从队列实况推导;route 只 touchWindow+incrementDrainCount)。
  const legacyDrainEnvelope = async (
    c: Context<AppEnv>,
    childId: string,
    raw: unknown,
    fingerprint: string,
    requestId: string,
    t0: number,
  ): Promise<Response> => {
    let env: LegacyReplaceRequest
    try {
      env = validateLegacyReplaceRequest(raw)
    } catch (e) {
      const msg = e instanceof DomainOpError ? e.violation : 'invalid legacy envelope'
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'payload-rejected' })
      return c.json({ error: 'bad-request', message: msg }, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    // ④ LEGACY_DRAIN gate(env 默认关;关 → envelope 400 payload-rejected,§14.3 受控迁移协议例外,非双协议窗口)
    if (!legacyDrainGate.isOpen()) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'legacy-drain-gate-closed' })
      return c.json({ error: 'bad-request', message: 'legacy drain gate closed' }, 400)
    }
    // ① scope 校验(env.canvasId+env.nodeId 必须匹配 path canvas+node;防同 nodeId 跨 canvas 重放)
    if (env.canvasId !== canvasId || env.nodeId !== childId) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'legacy-drain-scope-mismatch' })
      return c.json({ error: 'bad-request', message: 'envelope canvasId/nodeId must match path' }, 400)
    }
    // ④ v8 quiet-window:任一 envelope 到达(经 authz+gate+scope)→ 重新计时(envelope 增量 +1;retirement 须重等完整窗口)
    legacyDrainGate.touchWindow()
    const result = await backend.legacyReplaceDrain(authz.ownerId, canvasId, 'node', childId, { payload: env.payload, baseRevision: env.baseRevision }, {
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      method: 'PATCH',
      resourceKind: 'node',
      bodyFingerprint: fingerprint,
      actor: authz.actor,
    })
    if (result.kind === 'replaced') {
      legacyDrainGate.incrementDrainCount()
      const res: UpsertResponse = { id: result.record.id, revision: result.record.revision, seq: result.seq }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0, note: 'legacy-drain-replaced' })
      return c.json(res, 200)
    }
    if (result.kind === 'stale-conflict') {
      // ② 【lead 拍板】stale base → 409 terminal conflict dead-letter(不盲 replace;队列残留是离线期改动,覆盖是数据破坏)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'legacy-stale-conflict' })
      return c.json({ error: 'legacy-stale-conflict', id: childId, currentRevision: result.currentRevision }, 409)
    }
    if (result.kind === 'cross-canvas') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'cross-canvas' })
      return c.json({ error: 'unknown-node' } satisfies UnknownResourceBody, 404)
    }
    // reuse-conflict:同 idem key 不同 fingerprint → 422
    const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
    return c.json(err, 422)
  }

  // ── A2-S2 节点级 PATCH DomainOp path(§10.1/§14.1;edit 永不 409,同 fieldKeyOf path stale 才 overwritten)──
  const patchDomainChild = async (
    c: Context<AppEnv>,
    type: 'node' | 'edge' | 'anchor',
    childId: string,
  ): Promise<Response> => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let raw: unknown, fingerprint: string
    try {
      const r = await readJsonBodyWithFingerprint<unknown>(c)
      raw = r.body; fingerprint = r.fingerprint
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    // A2-S2 §14.3:legacy-replace 信封(nodes only)→ legacy drain 通道;edges/anchors 信封落 validateDomainOps → 400(非 DomainOp)。
    if (type === 'node' && typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'legacy-replace') {
      return legacyDrainEnvelope(c, childId, raw, fingerprint, requestId, t0)
    }
    // body = DomainOp | DomainOp[](batch 同 record 原子,§10.2);stale-client 旧 body → validateDomainOps throw → 400 payload-rejected(§1.2)。
    let ops: DomainOp[]
    try {
      ops = validateDomainOps(raw)
    } catch (e) {
      const msg = e instanceof DomainOpError ? `${e.violation}${e.field ? ` (${e.field})` : ''}` : 'invalid domain op body'
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'payload-rejected' })
      return c.json({ error: 'bad-request', message: msg }, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    // §14.1:If-Match = opaque BaseCursor(decodeBase 验签+scope;missing → 428;malformed/unsigned/scope-mismatch → 400)。
    const ifMatch = c.req.header('if-match')
    if (!ifMatch) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(childId), 428)
    }
    const decodedBase = decodeBase(ifMatch, canvasId, childId)
    if (!decodedBase) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-base-cursor' })
      return c.json({ error: 'bad-request', message: 'If-Match must be a valid signed BaseCursor for this canvas/record' }, 400)
    }
    const result = await backend.applyDomainOps(authz.ownerId, canvasId, type, childId, ops, {
      baseRevision: decodedBase.revision,
      baseFieldClocks: decodedBase.fieldClocks,
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      method: 'PATCH',
      resourceKind: type,
      bodyFingerprint: fingerprint,
      actor: authz.actor,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'cross-canvas' || result.kind === 'not-found') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: result.kind })
      return c.json({ error: `unknown-${type}` } satisfies UnknownResourceBody, 404)
    }
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(childId), 428)
    }
    // accepted:edit 永不 409(§14.1);overwritten notices 先落 debug 面(§14.1 "通知前写者语义先落 debug 面";SSE 推送后续阶段)。
    for (const o of result.overwritten) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: 0, note: `overwritten field=${o.fieldKey} byActor=${o.byActor} historicalValue=${JSON.stringify(o.historicalValue)}` })
    }
    const base = encodeBase(canvasId, childId, result.record.revision, result.fieldClocks)
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision, seq: result.seq, base }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  }

  // ── A2-S2 POST create client-id path(§10.2;CreateBody 零 privileged,dup → 409)──
  const createDomainChild = async (
    c: Context<AppEnv>,
    type: 'node' | 'edge' | 'anchor',
    childId: string,
  ): Promise<Response> => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let raw: unknown, fingerprint: string
    try {
      const r = await readJsonBodyWithFingerprint<unknown>(c)
      raw = r.body; fingerprint = r.fingerprint
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    let createBody
    try {
      createBody = validateCreateBody(raw)
    } catch (e) {
      const msg = e instanceof DomainOpError ? `${e.violation}${e.field ? ` (${e.field})` : ''}` : 'invalid create body'
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'payload-rejected' })
      return c.json({ error: 'bad-request', message: msg }, 400)
    }
    // payload 白名单校验(复用 N1/N10 validateChildPayload;id 来自 path,不校验 payload.id)。
    const check = validateChildPayload(type, createBody.payload, childId)
    if (!check.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'payload-rejected' })
      return c.json(check.body, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    const result = await backend.createChild(authz.ownerId, canvasId, type, childId, check.payload, {
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      method: 'POST',
      resourceKind: type,
      bodyFingerprint: fingerprint,
      actor: authz.actor,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'cross-canvas') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'cross-canvas' })
      return c.json({ error: `unknown-${type}` } satisfies UnknownResourceBody, 404)
    }
    if (result.kind === 'dup-conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: childId, currentRevision: result.existingRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'create-dup' })
      return c.json(err, 409)
    }
    // created:create 不伪造 base(§14.1);签发新 base(空 fieldClocks)。
    const base = encodeBase(canvasId, childId, result.record.revision, result.fieldClocks)
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision, seq: result.seq, base }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 201, latencyMs: Date.now() - t0 })
    return c.json(res, 201)
  }

  // ── A2-S2 DELETE node-delete-cascade(§10.4/§10.7;fresh base → 200, stale → 409 race)──
  const deleteChildCascadeHandler = async (
    c: Context<AppEnv>,
    type: 'node' | 'edge' | 'anchor',
    childId: string,
  ): Promise<Response> => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    // §14.1:If-Match = BaseCursor(missing → 428;malformed/scope → 400)。
    const ifMatch = c.req.header('if-match')
    if (!ifMatch) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(childId), 428)
    }
    const decodedBase = decodeBase(ifMatch, canvasId, childId)
    if (!decodedBase) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-base-cursor' })
      return c.json({ error: 'bad-request', message: 'If-Match must be a valid signed BaseCursor for this canvas/record' }, 400)
    }
    const result = await backend.deleteChildCascade(authz.ownerId, canvasId, type, childId, {
      baseRevision: decodedBase.revision,
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      method: 'DELETE',
      resourceKind: type,
      bodyFingerprint: undefined,
      actor: authz.actor,
    })
    if (result.kind === 'cross-canvas') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'cross-canvas' })
      return c.json({ error: `unknown-${type}` } satisfies UnknownResourceBody, 404)
    }
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(childId), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: childId, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'delete-race' })
      return c.json(err, 409)
    }
    if (result.kind === 'not-found') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown' })
      return c.json({ error: `unknown-${type}` } satisfies UnknownResourceBody, 404)
    }
    // deleted / idempotent:返 seq cursor(§10.7 accepted 必携 cursor;幂等已删不 404)。
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0, note: result.kind })
    return c.json({ id: childId, seq: result.seq }, 200)
  }

  route.patch('/:id/nodes/:nodeId', (c) => patchDomainChild(c, 'node', c.req.param('nodeId') ?? ''))
  route.patch('/:id/edges/:edgeId', (c) => patchDomainChild(c, 'edge', c.req.param('edgeId') ?? ''))
  route.patch('/:id/anchors/:anchorId', (c) => patchDomainChild(c, 'anchor', c.req.param('anchorId') ?? ''))
  // A2-S2(§10.2):POST create client-id path(CreateBody 零 privileged;dup → 409)。
  route.post('/:id/nodes/:nodeId', (c) => createDomainChild(c, 'node', c.req.param('nodeId') ?? ''))
  route.post('/:id/edges/:edgeId', (c) => createDomainChild(c, 'edge', c.req.param('edgeId') ?? ''))
  route.post('/:id/anchors/:anchorId', (c) => createDomainChild(c, 'anchor', c.req.param('anchorId') ?? ''))

  // A2-S2(§10.4/§10.7):DELETE node-delete-cascade(fresh base → 200 + seq cursor;stale → 409 race)。
  route.delete('/:id/nodes/:nodeId', (c) => deleteChildCascadeHandler(c, 'node', c.req.param('nodeId') ?? ''))
  route.delete('/:id/edges/:edgeId', (c) => deleteChildCascadeHandler(c, 'edge', c.req.param('edgeId') ?? ''))
  route.delete('/:id/anchors/:anchorId', (c) => deleteChildCascadeHandler(c, 'anchor', c.req.param('anchorId') ?? ''))

  // ── chat 子资源(DP-6 + N2/N3)──

  // GET /api/canvas/:id/chat — per-actor messages collection(DP-6R:只返 actor 自己的消息;ORDER BY orderKey #6)。
  route.get('/:id/chat', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const authz = await authzCanvas(c, canvasId, 'read')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    // DP-6R:chat per-user。匿名 share-link 访客(actor=null)→ 401 require-login;否则只读 actor 自己的 collection。
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    // DP-6R P1-2(返修 R2-P1-2):原子读 (messages, orderRevision) 对——同快照,消除 listByCanvas +
    // getChatOrderRevision 两 await 间隙的 torn pair(旧 messages + 新 rev → client 下次 reorder 用新 base
    // 配旧顺序被误接受,绕过乐观锁)。memory 同步临界区;PG 单事务 REPEATABLE READ 一致 snapshot。
    const { records, orderRevision } = await backend.listChatWithOrderRevision(authz.actor, canvasId)
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ messages: records.map(toEntry), orderRevision } satisfies ListChatMessagesResponse, 200)
  })

  // POST /api/canvas/:id/chat — append message(N3 ensureCreateChild canvas_id 校验;返修 #10 幂等复合 key + N4 reuse-conflict + N2 collection live)。
  route.post('/:id/chat', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let body: { message?: unknown }
    let fingerprint: string
    try {
      const r = await readJsonBodyWithFingerprint<{ message?: unknown }>(c)
      body = r.body
      fingerprint = r.fingerprint
    } catch (error) {
      const { status, body: errBody } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(errBody, status as 400 | 413)
    }
    if (body.message == null) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'bad-request', message: 'message is required' }, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    // DP-6R:chat per-user。匿名访客(actor=null)→ 401 require-login(无稳定 identity 不可写 chat collection)。
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    // N2:chat route 校验 collection live(未软删,canvas owner 名下 per-canvas)——collection 软删 → unknown-collection 404。
    if (!(await collectionLive(authz.ownerId, canvasId))) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown-collection' })
      return c.json({ error: 'unknown-collection' } satisfies UnknownResourceBody, 404)
    }
    const msg = body.message as { id?: string } | null
    const id = msg && typeof msg.id === 'string' && msg.id ? msg.id : randomUUID()
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    // N3:ensureCreateChild(canvas_id 校验 existing/idem-replay/cross-canvas 全验)。DP-6R:存储 owner=actor(per-actor 私有)。
    const result = await backend.ensureCreateChild(authz.actor, canvasId, 'chat-message', id, body.message, {
      method: 'POST',
      resourceKind: 'chat-message',
      idempotencyKey,
      bodyFingerprint: fingerprint,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(idempotencyKey ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'cross-canvas') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'cross-canvas' })
      return c.json({ error: 'unknown-message' } satisfies UnknownResourceBody, 404)
    }
    const status = result.kind === 'created' ? 201 : 200
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(res, status)
  })

  // PATCH /api/canvas/:id/chat/:msgId — message update(revision-checked;返修 #3/#4 + N5/N4/N7)。
  route.patch('/:id/chat/:msgId', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let decoded
    try {
      const { body: raw, fingerprint } = await readJsonBodyWithFingerprint<unknown>(c)
      decoded = decodeUpsertRequest(raw, fingerprint)
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: decoded.status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, decoded.status as 400 | 413)
    }
    const canvasId = c.req.param('id')
    const msgId = c.req.param('msgId')
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    // DP-6R:chat per-user。匿名访客 → 401 require-login;P2-1:PATCH strict-update——actor bucket 无此 msgId/已删 → 404 unknown-message,
    // 不借 PATCH create 己方副本(POST 是唯一 create 入口);非己 msgId 不触他人。
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    // N5:If-Match 严格(invalid → 400,missing → 428,value → base)。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(msgId), 400)
    }
    const base = parsed.kind === 'value' ? parsed.revision : undefined
    // DP-6R:存储 owner=actor(per-actor 私有);strictUpdate:true → 不许借 PATCH create。
    const result = await backend.upsertChild(authz.actor, canvasId, 'chat-message', msgId, decoded.value.payload, {
      base,
      method: 'PATCH',
      resourceKind: 'chat-message',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
      strictUpdate: true,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'cross-canvas' || result.kind === 'not-found') {
      // P2-1:非己/不存在 msgId(strict-update not-found)或跨 canvas(cross-canvas)→ 404 unknown-message,不新增 actor 副本。
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: result.kind === 'not-found' ? 'unknown-message' : 'cross-canvas' })
      return c.json({ error: 'unknown-message' } satisfies UnknownResourceBody, 404)
    }
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(msgId), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: msgId, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  })

  // DELETE /api/canvas/:id/chat/:msgId — 返修 #2:硬删 message(物理移除,不软删)。
  route.delete('/:id/chat/:msgId', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id')
    const msgId = c.req.param('msgId')
    const authz = await authzCanvas(c, canvasId, 'write')
    if (!authz.ok) return denyCanvas(c, requestId, t0, authz)
    // DP-6R:chat per-user。匿名访客 → 401 require-login;硬删只触 actor 自己的 collection(非己 msgId → 404 unknown-message,不触他人)。
    if (authz.actor === null) return requireLogin(c, requestId, t0)
    const { deleted } = await backend.hardDeleteChild(authz.actor, canvasId, 'chat-message', msgId)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-message' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
