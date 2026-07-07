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
import { generateAreaMaskPng, type MaskSize, type NormalizedMaskBounds } from '../lib/maskPng'
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
import { runEditTask, runGenerateTask, runVariationsTask, type VariationParam } from '../tasks/runner'

export const tasksRoute = new Hono<{ Bindings: HttpBindings }>()

// P2-C2: cap on the variations array length (contract: "up to MAX_VARIATIONS 默认 4").
// Matches the default MIVO_VARIATIONS_CONCURRENCY so a full 4-variation batch is
// single-batch; >4 batches. Hardcoded for now — raise via env if a caller needs more.
const MAX_VARIATIONS = 4

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
  const { record, created } = createTask('generate', model, requestId, idempotencyKey)
  // P1 fix (rev-behavior): only launch the runner on first creation. A repeat
  // submission with the same Idempotency-Key returns the existing task
  // (created=false) — re-running would duplicate upstream calls (billing) + race
  // on the same record. The existing taskId is returned unchanged.
  if (created) {
    // Fire-and-forget: the runner records progress/result into the registry. The
    // .catch is a safety net only — the runner catches internally.
    void runGenerateTask(record.id, { prompt, imgRatio: body.imgRatio, quality: body.quality, model: body.model, n: body.n }).catch((err) => {
      failTask(record.id, err instanceof Error ? err.message : 'runner crashed')
    })
  }
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
  const uploadedMask = multipartFiles(files, 'mask')[0]
  const references = [...multipartFiles(files, 'reference[]'), ...multipartFiles(files, 'reference')]
  const idempotencyKey = c.req.header('idempotency-key') || undefined

  // P2-C2: annotation area-edit path. When the client sends normalized maskBounds
  // (0-1, relative to the source image) + sourceSize (natural px) instead of a
  // pre-rendered mask file, the BFF synthesizes the area mask PNG here (ruling:
  // mask PNG lives in the BFF — it has the image + bounds; the frontend doesn't
  // touch pixels). No maskBounds ⇒ whole-image edit (existing prompt-edit path).
  let mask = uploadedMask
  if (!mask) {
    const maskBoundsField = firstMultipartField(fields, 'maskBounds')
    if (maskBoundsField) {
      const sourceSizeField = firstMultipartField(fields, 'sourceSize')
      if (!sourceSizeField) {
        logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
        return c.json({ error: 'sourceSize is required with maskBounds' }, 400)
      }
      let bounds: NormalizedMaskBounds
      let size: MaskSize
      try {
        bounds = JSON.parse(maskBoundsField)
        size = JSON.parse(sourceSizeField)
      } catch {
        logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mask-json' })
        return c.json({ error: 'maskBounds/sourceSize must be valid JSON' }, 400)
      }
      if (
        typeof bounds?.x !== 'number' || typeof bounds?.y !== 'number' ||
        typeof bounds?.width !== 'number' || typeof bounds?.height !== 'number' ||
        typeof size?.width !== 'number' || typeof size?.height !== 'number'
      ) {
        logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mask-shape' })
        return c.json({ error: 'maskBounds needs x/y/width/height; sourceSize needs width/height' }, 400)
      }
      let maskBuffer: Buffer
      try {
        maskBuffer = generateAreaMaskPng(size, bounds)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'mask generation failed'
        logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'mask-gen-failed' })
        return c.json({ error: message }, 400)
      }
      mask = new File([maskBuffer], 'mask.png', { type: 'image/png' })
    }
  }

  const { record, created } = createTask('edit', modelField, requestId, idempotencyKey)
  // P1 fix: only launch the runner on first creation (see /generate).
  if (created) {
    void runEditTask(record.id, {
      image,
      prompt,
      imgRatio: firstMultipartField(fields, 'imgRatio'),
      quality: firstMultipartField(fields, 'quality'),
      model: modelField,
      mask,
      references,
      // Spatial context for the instruction-based (gemini) mask path; harmless
      // extras on the llm-proxy path.
      maskBoundsJson: firstMultipartField(fields, 'maskBounds'),
      sourceSizeJson: firstMultipartField(fields, 'sourceSize'),
      subjectLabel: firstMultipartField(fields, 'subjectLabel'),
      subjectsJson: firstMultipartField(fields, 'subjects'),
      markedImage: multipartFiles(files, 'markedImage')[0],
    }).catch((err) => {
      failTask(record.id, err instanceof Error ? err.message : 'runner crashed')
    })
  }
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 202, latencyMs: Date.now() - t0, upstream: 'task' })
  return c.json({ taskId: record.id }, 202)
})

// P2-C2: variations endpoint. Multipart: `image` (source) + `variations` (JSON
// array of {prompt?,imgRatio?,quality?,model?}, 1..MAX_VARIATIONS) + optional
// Idempotency-Key. Returns 202 {taskId,batchId,count} immediately; the runner
// fires N parallel llm-proxy /edits calls (concurrency-capped) and aggregates
// done/partial/failed into the registry. See server/contracts/tasks-async.md.
tasksRoute.post('/variations', async (c) => {
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
  const variationsField = firstMultipartField(fields, 'variations')
  if (!variationsField) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
    return c.json({ error: 'variations is required' }, 400)
  }
  let variations: VariationParam[]
  try {
    variations = JSON.parse(variationsField)
  } catch {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-variations-json' })
    return c.json({ error: 'variations must be a JSON array' }, 400)
  }
  if (!Array.isArray(variations) || variations.length === 0) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
    return c.json({ error: 'variations must be a non-empty array' }, 400)
  }
  if (variations.length > MAX_VARIATIONS) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0 })
    return c.json({ error: `variations exceeds max (${MAX_VARIATIONS})` }, 400)
  }
  const modelField = firstMultipartField(fields, 'model').trim() || defaultMivoImageModel
  const idempotencyKey = c.req.header('idempotency-key') || undefined
  // batchId groups this batch's N edits for client-side display (variant grid).
  // Not the taskId — the taskId is the registry id returned to the client.
  const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const { record, created } = createTask('variations', modelField, requestId, idempotencyKey, { batchId, count: variations.length })
  // P1 fix: only launch the runner on first creation (see /generate). On a repeat
  // submission the existing batchId/count are returned from the record, so the
  // client still sees the original batch grouping.
  if (created) {
    void runVariationsTask(record.id, { image, variations, batchId }).catch((err) => {
      failTask(record.id, err instanceof Error ? err.message : 'runner crashed')
    })
  }
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 202, latencyMs: Date.now() - t0, upstream: 'task' })
  return c.json({ taskId: record.id, batchId: record.batchId ?? batchId, count: record.count ?? variations.length }, 202)
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
