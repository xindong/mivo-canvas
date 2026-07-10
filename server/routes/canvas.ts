// server/routes/canvas.ts
// T1.3 前置:/api/canvas — 画布 record(document 域:canvas meta + node/edge/anchor 子 record)
// + 节点级 PATCH(FX-4,1MB/413,revision 409)+ chat 子资源(DP-6)+ 返修 13 条。
// 权威:docs/decisions/api-surface.md §4.2(返修版)。
//
// 返修要点(逐条):
//  - #1 owner seam:resolveActor + per-owner get(=owner===actor;T1.4 扩 member/share);未授权 404。
//  - #2 软删粒度:DELETE canvas → softDeleteCanvasTree(标 canvas meta + chat-collection);node/edge/anchor/chat-message
//    DELETE → hardDeleteChild(物理移除,不软删单条)。
//  - #3 子资源归属:upsertChild/hardDeleteChild WHERE owner+canvasId+type+id;canvas_id 不可变;跨 canvas → 404。
//  - #4 If-Match 严格优先,existing 缺 base → 428;#5 wire 不带 revision;fresh create max(0,base)。
//  - #5 metaRevision(envelope.revision)与 contentVersion(meta payload.contentVersion)分名;payload.id 与 path 一致。
//  - #6 orderKey:listByCanvas ORDER BY orderKey;POST /:id/reorder 持久化重排。
//  - #7 softDeleteCanvasTree/restoreCanvasTree 原子(backend 单函数)。
//  - #8 GET /(枚举 by project);edge/anchor DELETE;CanvasMeta 补 sourceTemplateId/createdAt/move(projectId 可改)。
//  - #10 幂等 owner+method+resourceKind+key+fingerprint。
//  - #11 request codec;#12 统一 413;#13 validateChildPayload(node/edge/anchor 白名单)。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import { newRequestId, logRequest } from '../lib/request'
import {
  baseFromIfMatch,
  bodyError,
  decodeCreateCanvas,
  decodeUpsertRequest,
  preconditionRequired,
  readJsonBodyWithFingerprint,
  validateChildPayload,
} from '../lib/persistHttp'
import type {
  CanvasMeta,
  ConflictBody,
  CreateCanvasRequest,
  GetCanvasResponse,
  ListCanvasResponse,
  RecordEntry,
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

export const createCanvasRoutes = ({ backend }: { backend: PersistBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

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
    const got = await backend.get(actor, 'canvas', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const [nodes, edges, anchors] = await Promise.all([
      backend.listByCanvas(actor, id, 'node'),
      backend.listByCanvas(actor, id, 'edge'),
      backend.listByCanvas(actor, id, 'anchor'),
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
    const project = await backend.get(actor, 'project', reqBody.projectId)
    if (project.kind === 'missing' || project.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const id = reqBody.id && reqBody.id.trim() ? reqBody.id.trim() : randomUUID()
    const cp: CanvasPayload = { projectId: reqBody.projectId, title: reqBody.title, sourceTemplateId: reqBody.sourceTemplateId }
    const idempotencyKey = c.req.header('idempotency-key') || undefined
    const result = await backend.ensureCreate(actor, 'canvas', id, cp, {
      scope: 'document',
      method: 'POST',
      resourceKind: 'canvas',
      idempotencyKey,
      bodyFingerprint: decoded.fingerprint,
    })
    // 返修 #2:canvas 创建时一并建 chat-collection record(collection 级软删标记点)。
    if (result.kind === 'created') {
      await backend.ensureCreate(actor, 'chat-collection', id, {}, {
        canvasId: id,
        scope: 'document',
        method: 'POST',
        resourceKind: 'chat-collection',
        bodyFingerprint: decoded.fingerprint,
      })
    }
    const status = result.kind === 'created' ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toCanvasMeta(result.record), status)
  })

  // PUT /api/canvas/:id — doc-level meta 更新(revision-checked,#4 428;#8 move=projectId 可改)。
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
    const got = await backend.get(actor, 'canvas', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const existing = isCanvasPayload(got.record.payload) ? got.record.payload : { projectId: '' }
    const incoming = (decoded.value.payload ?? {}) as Partial<CanvasPayload>
    // 返修 #8 move:projectId 可改(若提供且属本 owner);title/sourceTemplateId 可改。
    let projectId = existing.projectId ?? ''
    if (typeof incoming.projectId === 'string' && incoming.projectId && incoming.projectId !== projectId) {
      const p = await backend.get(actor, 'project', incoming.projectId)
      if (p.kind === 'missing' || p.record.isDeleted) {
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
    const base = baseFromIfMatch(c.req.header('if-match'))
    const result = await backend.upsert(actor, 'canvas', id, cp, {
      base,
      scope: 'document',
      method: 'PUT',
      resourceKind: 'canvas',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
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
    const got = await backend.get(actor, 'canvas', id)
    if (got.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    if (!got.record.isDeleted) {
      await backend.softDeleteCanvasTree(actor, id)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  // ── 返修 #6:重排子资源顺序(持久化 orderKey)──
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
    if (type !== 'node' && type !== 'edge' && type !== 'anchor' && type !== 'chat-message' || !orderedIds) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'bad-request', message: 'type and orderedIds are required' }, 400)
    }
    const id = c.req.param('id')
    const actor = resolveActor(c)
    const canvas = await backend.get(actor, 'canvas', id)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { reordered } = await backend.reorderChildren(actor, id, type, orderedIds)
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ reordered }, 200)
  })

  // ── 节点级 PATCH(FX-4 + 返修 #3/#4/#5/#13):node/edge/anchor ──
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
    // 返修 #13:node/edge/anchor payload 白名单 runtime 校验(拒 mirror/status/tasks + id 一致性 #5)。
    const check = validateChildPayload(decoded.value.payload, childId)
    if (!check.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'payload-rejected' })
      return c.json(check.body, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const actor = resolveActor(c)
    const canvas = await backend.get(actor, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const base = baseFromIfMatch(c.req.header('if-match'))
    const result = await backend.upsertChild(actor, canvasId, type, childId, check.payload, {
      base,
      method: 'PATCH',
      resourceKind: type,
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
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

  // 返修 #2/#8:DELETE child record(node/edge/anchor 真硬删)。canvas 须存在未删。
  const deleteChild = async (c: Context<AppEnv>, type: 'node' | 'edge' | 'anchor'): Promise<Response> => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const childId = c.req.param('nodeId') ?? c.req.param('edgeId') ?? c.req.param('anchorId') ?? ''
    const actor = resolveActor(c)
    const canvas = await backend.get(actor, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.hardDeleteChild(actor, canvasId, type, childId)
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

  // ── chat 子资源(DP-6)──

  // GET /api/canvas/:id/chat — per-canvas messages collection(跨设备原样在;ORDER BY orderKey #6)。
  route.get('/:id/chat', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const actor = resolveActor(c)
    const canvas = await backend.get(actor, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { records } = await backend.listByCanvas(actor, canvasId, 'chat-message')
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ messages: records.map(toEntry) }, 200)
  })

  // POST /api/canvas/:id/chat — append message(idempotent on message.id;返修 #10 幂等复合 key)。
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
    const canvas = await backend.get(actor, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const msg = body.message as { id?: string } | null
    const id = msg && typeof msg.id === 'string' && msg.id ? msg.id : randomUUID()
    const result = await backend.ensureCreate(actor, 'chat-message', id, body.message, {
      canvasId,
      scope: 'document',
      method: 'POST',
      resourceKind: 'chat-message',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: fingerprint,
    })
    const status = result.kind === 'created' ? 201 : 200
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(res, status)
  })

  // PATCH /api/canvas/:id/chat/:msgId — message update(revision-checked;返修 #3/#4)。
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
    const canvas = await backend.get(actor, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const base = baseFromIfMatch(c.req.header('if-match'))
    const result = await backend.upsertChild(actor, canvasId, 'chat-message', msgId, decoded.value.payload, {
      base,
      method: 'PATCH',
      resourceKind: 'chat-message',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
    })
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
    const canvas = await backend.get(actor, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.hardDeleteChild(actor, canvasId, 'chat-message', msgId)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-message' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
