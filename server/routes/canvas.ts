// server/routes/canvas.ts
// T1.3 前置:/api/canvas — 画布 record(document 域:canvas meta + node/edge/anchor 子 record)
// + 节点级 PATCH(FX-4,1MB/413,revision 409)+ chat 子资源(DP-6,per-canvas collection)。
// 权威:docs/decisions/api-surface.md §4.2。
// 契约:additive(不属 dev middleware 平移面);验收由 routes/canvas.route.test.ts(内存 backend)覆盖。
//
// 信封 payload 透明:CanvasMeta payload = {projectId, title};node/edge/anchor/chat-message
// payload = 不透明 record 体(服务端不解析,DP-5)。per-record revision 在信封列(canonical)。
//
// 鉴权:resolveOwner(c) + rejectInvalidMivoApiKey(F4 边界);跨 owner/不存在 → 404(无泄漏)。
// PG swap:backend 注入点,handler 零改动(§6)。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveOwner } from '../lib/owner'
import { newRequestId, logRequest, readJsonBody } from '../lib/request'
import { RequestBodyTooLargeError } from '../lib/upstream'
import type {
  CanvasMeta,
  ConflictBody,
  CreateCanvasRequest,
  GetCanvasResponse,
  RecordEntry,
  UnknownResourceBody,
  UpsertRequest,
  UpsertResponse,
} from '../../shared/persist-contract.ts'
import type { PersistBackend, PersistRecord } from '../persist/backend'

/** CanvasMeta 信封 payload(DP-5:projectId/title 是域字段;id/ownerId/timestamps/revision 在信封列)。 */
type CanvasPayload = { projectId: string; title?: string }

const isCanvasPayload = (p: unknown): p is CanvasPayload =>
  typeof p === 'object' && p !== null && typeof (p as { projectId?: unknown }).projectId === 'string'

const toCanvasMeta = (r: PersistRecord): CanvasMeta => {
  const cp = isCanvasPayload(r.payload) ? r.payload : { projectId: '' }
  return {
    id: r.id,
    projectId: cp.projectId,
    title: cp.title ?? '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    revision: r.revision,
  }
}

const toEntry = (r: PersistRecord): RecordEntry => ({
  id: r.id,
  revision: r.revision,
  payload: r.payload,
})

const badMivo = (c: Context<AppEnv>, requestId: string, t0: number): Response => {
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
  return c.json({ error: 'bad-mivo-key' }, 400)
}

export const createCanvasRoutes = ({ backend }: { backend: PersistBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  // ── 画布 record 级 ──

  // GET /api/canvas/:id — 全量(meta + nodes/edges/anchors,跨设备原样在)。
  route.get('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const id = c.req.param('id')
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'canvas', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const [nodes, edges, anchors] = await Promise.all([
      backend.listByCanvas(owner, id, 'node'),
      backend.listByCanvas(owner, id, 'edge'),
      backend.listByCanvas(owner, id, 'anchor'),
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

  // POST /api/canvas — 幂等创建(projectId 须属本 owner,否则 404 unknown-project)。
  route.post('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let body: CreateCanvasRequest
    try {
      body = await readJsonBody<CreateCanvasRequest>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    if (!projectId) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'projectId is required' }, 400)
    }
    const owner = resolveOwner(c)
    const project = await backend.get(owner, 'project', projectId)
    if (project.kind === 'missing' || project.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-project' } satisfies UnknownResourceBody, 404)
    }
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID()
    const title = typeof body.title === 'string' ? body.title : ''
    const result = await backend.ensureCreate(owner, 'canvas', id, { projectId, title } satisfies CanvasPayload, {
      scope: 'document',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    const status = result.kind === 'created' ? 201 : 200
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(toCanvasMeta(result.record), status)
  })

  // PUT /api/canvas/:id — doc-level meta 更新(revision-checked)。
  route.put('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let body: { title?: unknown; revision?: number }
    try {
      body = await readJsonBody<{ title?: unknown; revision?: number }>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    const id = c.req.param('id')
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'canvas', id)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const existing = isCanvasPayload(got.record.payload) ? got.record.payload : { projectId: '' }
    const title = typeof body.title === 'string' ? body.title : existing.title ?? ''
    const ifMatch = c.req.header('if-match')
    const revision = body.revision !== undefined ? body.revision : ifMatch !== undefined ? Number(ifMatch) : undefined
    const result = await backend.upsert(owner, 'canvas', id, { projectId: existing.projectId, title } satisfies CanvasPayload, {
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
    return c.json(toCanvasMeta(result.record), 200)
  })

  // DELETE /api/canvas/:id — 软删 canvas + 级联软删其 chat collection(DP-3/DP-6)+ nodes/edges/anchors。
  route.delete('/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const id = c.req.param('id')
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'canvas', id)
    if (got.kind === 'missing') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    if (!got.record.isDeleted) {
      await backend.cascadeSoftDeleteByCanvas(owner, id) // nodes/edges/anchors/chat by canvas_id
      await backend.softDelete(owner, 'canvas', id)      // canvas meta
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  // ── 节点级 PATCH(FX-4):node/edge/anchor ──
  // 通用:canvas 须存在未删(else 404);record upsert(missing→create,existing→rev-check)。
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
    let body: UpsertRequest<unknown>
    try {
      body = await readJsonBody<UpsertRequest<unknown>>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    if (body.payload == null || typeof body.payload !== 'object') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'payload is required' }, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const owner = resolveOwner(c)
    const canvas = await backend.get(owner, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const ifMatch = c.req.header('if-match')
    const revision = body.revision !== undefined ? body.revision : ifMatch !== undefined ? Number(ifMatch) : undefined
    const result = await backend.upsert(owner, type, childId, body.payload, {
      revision,
      canvasId,
      scope: 'document',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: childId, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    // 用 result.record.id(非 URL childId):idempotency 回放时 index 指向首条 record,返既有 id+revision
    // 才是"既有结果"(同 key 同 owner → 同 result);非回放时 record.id === childId,无差异。
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  }

  route.patch('/:id/nodes/:nodeId', (c) => patchChild(c, 'node', c.req.param('nodeId') ?? ''))
  route.patch('/:id/edges/:edgeId', (c) => patchChild(c, 'edge', c.req.param('edgeId') ?? ''))
  route.patch('/:id/anchors/:anchorId', (c) => patchChild(c, 'anchor', c.req.param('anchorId') ?? ''))

  // DELETE child record(软删单 node/edge/anchor)。canvas 须存在未删。
  route.delete('/:id/nodes/:nodeId', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id')
    const childId = c.req.param('nodeId')
    const owner = resolveOwner(c)
    const canvas = await backend.get(owner, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.softDelete(owner, 'node', childId)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-node' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  // ── chat 子资源(DP-6)──

  // GET /api/canvas/:id/chat — per-canvas messages collection(跨设备原样在)。
  route.get('/:id/chat', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id') ?? ''
    const owner = resolveOwner(c)
    const canvas = await backend.get(owner, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { records } = await backend.listByCanvas(owner, canvasId, 'chat-message')
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json({ messages: records.map(toEntry) }, 200)
  })

  // POST /api/canvas/:id/chat — append message(idempotent on message.id)。
  route.post('/:id/chat', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let body: { message?: unknown; id?: string }
    try {
      body = await readJsonBody<{ message?: unknown; id?: string }>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    if (body.message == null) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'message is required' }, 400)
    }
    const canvasId = c.req.param('id') ?? ''
    const owner = resolveOwner(c)
    const canvas = await backend.get(owner, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    // message id:客户端 ChatMessage.id 优先,缺失→服务端生成(对齐 POST projects/canvas 幂等)。
    const msg = body.message as { id?: string } | null
    const id = (msg && typeof msg.id === 'string' && msg.id) ? msg.id : randomUUID()
    const result = await backend.ensureCreate(owner, 'chat-message', id, body.message, {
      canvasId,
      scope: 'document',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    const status = result.kind === 'created' ? 201 : 200
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0 })
    return c.json(res, status)
  })

  // PATCH /api/canvas/:id/chat/:msgId — message update(revision-checked)。
  route.patch('/:id/chat/:msgId', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    let body: UpsertRequest<unknown>
    try {
      body = await readJsonBody<UpsertRequest<unknown>>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    if (body.payload == null) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
      return c.json({ error: 'payload is required' }, 400)
    }
    const canvasId = c.req.param('id')
    const msgId = c.req.param('msgId')
    const owner = resolveOwner(c)
    const canvas = await backend.get(owner, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const ifMatch = c.req.header('if-match')
    const revision = body.revision !== undefined ? body.revision : ifMatch !== undefined ? Number(ifMatch) : undefined
    const result = await backend.upsert(owner, 'chat-message', msgId, body.payload, {
      revision,
      canvasId,
      scope: 'document',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: msgId, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  })

  // DELETE /api/canvas/:id/chat/:msgId — 软删 message。
  route.delete('/:id/chat/:msgId', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return badMivo(c, requestId, t0)
    const canvasId = c.req.param('id')
    const msgId = c.req.param('msgId')
    const owner = resolveOwner(c)
    const canvas = await backend.get(owner, 'canvas', canvasId)
    if (canvas.kind === 'missing' || canvas.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-canvas' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.softDelete(owner, 'chat-message', msgId)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-message' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
