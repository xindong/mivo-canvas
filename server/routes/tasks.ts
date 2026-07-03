// server/routes/tasks.ts
// P2-C1a: async task endpoints. These are ADDITIVE (new capability, not part of
// the dev-middleware diff baseline — see server/contracts/tasks-async.md).
//
//   POST   /api/mivo/tasks/generate  → 202 {taskId}   (same body as /generate)
//   POST   /api/mivo/tasks/edit      → 202 {taskId}   (same body as /edit)
//   GET    /api/mivo/tasks/:id       → 200 {status,progress,stage,result?,error?} | 404
//   DELETE /api/mivo/tasks/:id       → 200 {id,status:'canceled'} | 404
//
// The POST handlers parse + validate exactly like the sync /generate /edit routes
// (prompt required, image required), create a task in the registry, then kick off
// the runner WITHOUT awaiting and return {taskId} immediately. Idempotency-Key
// header dedupes within the process lifetime.

import { Hono } from 'hono'
import type { HttpBindings } from '@hono/node-server'
import { defaultMivoImageModel } from '../lib/config'
import {
  firstMultipartField,
  logRequest,
  multipartFiles,
  newRequestId,
  parseMultipartBody,
  readJsonBody,
} from '../lib/request'
import { RequestBodyTooLargeError } from '../lib/upstream'
import { cancelTask, createTask, failTask, getTask, toView } from '../tasks/registry'
import { runEditTask, runGenerateTask } from '../tasks/runner'

export const tasksRoute = new Hono<{ Bindings: HttpBindings }>()

type GenerateBody = { prompt?: unknown; imgRatio?: unknown; quality?: unknown; model?: unknown; n?: unknown }

tasksRoute.post('/generate', async (c) => {
  const requestId = newRequestId()
  c.header('X-Request-Id', requestId)
  const t0 = Date.now()
  let body: GenerateBody
  try {
    body = await readJsonBody<GenerateBody>(c)
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
    return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
  }
  const prompt = String(body.prompt || '').trim()
  if (!prompt) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
    return c.json({ error: 'prompt is required' }, 400)
  }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultMivoImageModel
  const idempotencyKey = c.req.header('idempotency-key') || undefined
  const record = createTask('generate', model, requestId, idempotencyKey)
  // Fire-and-forget: the runner records progress/result into the registry. The
  // .catch is a safety net only — the runner catches internally.
  void runGenerateTask(record.id, { prompt, imgRatio: body.imgRatio, quality: body.quality, model: body.model, n: body.n }).catch((err) => {
    failTask(record.id, err instanceof Error ? err.message : 'runner crashed')
  })
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 202, latencyMs: Date.now() - t0, upstream: 'task' })
  return c.json({ taskId: record.id }, 202)
})

tasksRoute.post('/edit', async (c) => {
  const requestId = newRequestId()
  c.header('X-Request-Id', requestId)
  const t0 = Date.now()
  let parsed: { fields: Map<string, string[]>; files: Map<string, File[]> }
  try {
    parsed = await parseMultipartBody(c)
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
    return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
  }
  const { fields, files } = parsed
  const image = multipartFiles(files, 'image')[0]
  if (!image) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
    return c.json({ error: 'image is required' }, 400)
  }
  const prompt = firstMultipartField(fields, 'prompt').trim()
  if (!prompt) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
    return c.json({ error: 'prompt is required' }, 400)
  }
  const modelField = firstMultipartField(fields, 'model').trim() || defaultMivoImageModel
  const mask = multipartFiles(files, 'mask')[0]
  const references = [...multipartFiles(files, 'reference[]'), ...multipartFiles(files, 'reference')]
  const idempotencyKey = c.req.header('idempotency-key') || undefined
  const record = createTask('edit', modelField, requestId, idempotencyKey)
  void runEditTask(record.id, {
    image,
    prompt,
    imgRatio: firstMultipartField(fields, 'imgRatio'),
    quality: firstMultipartField(fields, 'quality'),
    model: modelField,
    mask,
    references,
  }).catch((err) => {
    failTask(record.id, err instanceof Error ? err.message : 'runner crashed')
  })
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 202, latencyMs: Date.now() - t0, upstream: 'task' })
  return c.json({ taskId: record.id }, 202)
})

tasksRoute.get('/:id', (c) => {
  const id = c.req.param('id')
  const record = getTask(id)
  if (!record) return c.json({ error: 'unknown-task' }, 404)
  return c.json(toView(record), 200)
})

tasksRoute.delete('/:id', (c) => {
  const id = c.req.param('id')
  const record = getTask(id)
  if (!record) return c.json({ error: 'unknown-task' }, 404)
  cancelTask(id)
  return c.json({ id, status: 'canceled' }, 200)
})
