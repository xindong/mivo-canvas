// server/routes/canvas.ts
// T1.3 前置:/api/canvas — 画布 record(document 域:canvas meta + node/edge/anchor 子 record)
// + 节点级 PATCH(FX-4,1MB/413,revision 409)+ chat 子资源(DP-6)+ 返修 N1-N10。
// 权威:docs/decisions/api-surface.md §4.2(返修版二)。
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
import { canAccessCanvas, canAccessProject } from '../lib/authz'
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
import type {
  CanvasMeta,
  ConflictBody,
  CreateCanvasRequest,
  GetCanvasResponse,
  ListCanvasResponse,
  RecordEntry,
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

export const createCanvasRoutes = ({ backend }: { backend: PersistBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  /**
   * 返修 N7:canvas 授权 seam——backend 先 resolve resourceOwner(getCanvasOwner 全局),action-aware
   * canAccessCanvas 判;授权后以 resourceOwner 查询。未授权/不存在统一 404(无存在泄漏)。
   */
  const authzCanvas = (
    actor: string,
    canvasId: string,
    action: 'read' | 'write' | 'move' = 'read',
  ): { ownerId: string } | null => {
    const owner = backend.getCanvasOwner(canvasId)
    if (!owner || canAccessCanvas(actor, owner.ownerId, action) === 'deny') return null
    return owner
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
    const actor = resolveActor(c)
    const projectId = c.req.query('projectId')
    const { records } = projectId
      ? await backend.listCanvasByProject(actor, projectId)
      : await backend.listByOwner(actor, 'canvas')
    const body: ListCanvasResponse = { canvases: records.map(toCanvasMeta) }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // GET /api/canvas/:id — 全量(meta + nodes/edges/anchors,跨设备原样在)。
  route.get('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, id, 'read')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const got = await backend.get(owner.ownerId, 'canvas', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const [nodes, edges, anchors] = await Promise.all([
      backend.listByCanvas(owner.ownerId, id, 'node'),
      backend.listByCanvas(owner.ownerId, id, 'edge'),
      backend.listByCanvas(owner.ownerId, id, 'anchor'),
    ])
    const body: GetCanvasResponse = {
      ...toCanvasMeta(got.record),
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
    const actor = resolveActor(c)
    // N7:project authz(getProjectOwner + canAccessProject;未授权/不存在 → 404 unknown-project)。
    const projectOwner = backend.getProjectOwner(reqBody.projectId)
    if (!projectOwner || canAccessProject(actor, projectOwner.ownerId, 'write') === 'deny') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const id = reqBody.id && reqBody.id.trim() ? reqBody.id.trim() : randomUUID()
    const cp: CanvasPayload = { projectId: reqBody.projectId, title: reqBody.title, sourceTemplateId: reqBody.sourceTemplateId }
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    // F1:单一原子原语 createCanvasWithCollection(canvas meta + chat-collection 同一操作,防 ensureCreate(canvas)→
    // 独立 ensureCreate(chat-collection) 两段间的 TOCTOU——中间并发 DELETE project 会产生软删树下 live orphan collection)。
    const result = await backend.createCanvasWithCollection(actor, id, cp, {
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
    const owner = authzCanvas(actor, id, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const got = await backend.get(owner.ownerId, 'canvas', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const existing = isCanvasPayload(got.record.payload) ? got.record.payload : { projectId: '' }
    const incoming = (decoded.value.payload ?? {}) as Partial<CanvasPayload>
    // 返修 #8/N7 move:projectId 可改(若提供且属本 owner;move 双端 authz:source canvas + target project)。
    let projectId = existing.projectId ?? ''
    if (typeof incoming.projectId === 'string' && incoming.projectId && incoming.projectId !== projectId) {
      const targetOwner = backend.getProjectOwner(incoming.projectId)
      if (!targetOwner || canAccessProject(actor, targetOwner.ownerId, 'move') === 'deny') {
        logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
        return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
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
    const result = await backend.upsert(owner.ownerId, 'canvas', id, cp, {
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

  // DELETE /api/canvas/:id — 返修 #2/#7:softDeleteCanvasTree 原子(标 canvas meta + chat-collection;children 保持活记录)。
  route.delete('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, id, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const got = await backend.get(owner.ownerId, 'canvas', id)
    if (got.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    if (!got.record.isDeleted) {
      await backend.softDeleteCanvasTree(owner.ownerId, id)
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
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, id, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', id)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    // N5/F5:If-Match(contentVersion base)**必填**——invalid → 400;missing → 428(precondition-required);stale → 409(N8 两并发一成一 409)。
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
    const result = await backend.reorderChildren(owner.ownerId, id, type, orderedIds, { base })
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

  // ── 节点级 PATCH(FX-4 + 返修 #3/#4/#5/#13 + N1/N5/N7):node/edge/anchor ──
  const patchChild = async (
    c: Context<AppEnv>,
    type: 'node' | 'edge' | 'anchor',
    childId: string,
  ): Promise<Response> => {
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
    // 返修 N1/N10:逐 type payload 白名单 runtime 校验(必填/类型/拒 unknown/非 string id/mirror/forbidden)。
    const check = validateChildPayload(type, decoded.value.payload, childId)
    if (!check.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'payload-rejected' })
      return c.json(check.body, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, canvasId, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    // N5:If-Match 严格(parseIfMatch;invalid → 400,missing → 428 via backend,value → base)。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(childId), 400)
    }
    const base = parsed.kind === 'value' ? parsed.revision : undefined
    const result = await backend.upsertChild(owner.ownerId, canvasId, type, childId, check.payload, {
      base,
      method: 'PATCH',
      resourceKind: type,
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
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
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(childId), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: childId, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  }

  route.patch('/:id/nodes/:nodeId', (c) => patchChild(c, 'node', c.req.param('nodeId') ?? ''))
  route.patch('/:id/edges/:edgeId', (c) => patchChild(c, 'edge', c.req.param('edgeId') ?? ''))
  route.patch('/:id/anchors/:anchorId', (c) => patchChild(c, 'anchor', c.req.param('anchorId') ?? ''))

  // 返修 #2/#8:DELETE child record(node/edge/anchor 真硬删)。canvas 须存在未删 + N7 authz。
  const deleteChild = async (c: Context<AppEnv>, type: 'node' | 'edge' | 'anchor'): Promise<Response> => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const childId = c.req.param('nodeId') ?? c.req.param('edgeId') ?? c.req.param('anchorId') ?? ''
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, canvasId, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.hardDeleteChild(owner.ownerId, canvasId, type, childId)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: `unknown-${type}` } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  }

  route.delete('/:id/nodes/:nodeId', (c) => deleteChild(c, 'node'))
  route.delete('/:id/edges/:edgeId', (c) => deleteChild(c, 'edge'))
  route.delete('/:id/anchors/:anchorId', (c) => deleteChild(c, 'anchor'))

  // ── chat 子资源(DP-6 + N2/N3)──

  // GET /api/canvas/:id/chat — per-canvas messages collection(跨设备原样在;ORDER BY orderKey #6)。
  route.get('/:id/chat', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, canvasId, 'read')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { records } = await backend.listByCanvas(owner.ownerId, canvasId, 'chat-message')
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ messages: records.map(toEntry) }, 200)
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
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, canvasId, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    // N2:chat route 校验 collection live(未软删)——collection 软删 → unknown-collection 404。
    if (!(await collectionLive(owner.ownerId, canvasId))) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'unknown-collection' })
      return c.json({ error: 'unknown-collection' } satisfies UnknownResourceBody, 404)
    }
    const msg = body.message as { id?: string } | null
    const id = msg && typeof msg.id === 'string' && msg.id ? msg.id : randomUUID()
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    // N3:ensureCreateChild(canvas_id 校验 existing/idem-replay/cross-canvas 全验)。
    const result = await backend.ensureCreateChild(owner.ownerId, canvasId, 'chat-message', id, body.message, {
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
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, canvasId, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    // N5:If-Match 严格(invalid → 400,missing → 428,value → base)。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(msgId), 400)
    }
    const base = parsed.kind === 'value' ? parsed.revision : undefined
    const result = await backend.upsertChild(owner.ownerId, canvasId, 'chat-message', msgId, decoded.value.payload, {
      base,
      method: 'PATCH',
      resourceKind: 'chat-message',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'cross-canvas') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
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
    const actor = resolveActor(c)
    const owner = authzCanvas(actor, canvasId, 'write')
    if (!owner) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const canvas = await backend.get(owner.ownerId, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.hardDeleteChild(owner.ownerId, canvasId, 'chat-message', msgId)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-message' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
