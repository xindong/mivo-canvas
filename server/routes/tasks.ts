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
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveTaskOwner } from '../lib/owner'
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
import { cancelTask, createTask, failTask, getTaskForOwner, toView, type TaskView } from '../tasks/registry'
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
  // F4: reject malformed X-Mivo-Api-Key at the boundary (no env fallback).
  const badMivoKey = rejectInvalidMivoApiKey(c)
  if (badMivoKey) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
    return badMivoKey
  }
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
  const platformKey = c.req.header('x-mivo-api-key')?.trim() || undefined
  // FX-2 / G2.1: owner key for the task registry (per-user isolation). resolveTaskOwner
  // returns the SSO actor in strict mode (MIVO_SSO_STRICT=1; missing/wrong gateway proof
  // → SsoAuthError → 401 via ssoAuthBoundary, no fingerprint fallback) or the raw mivo
  // platform key in legacy mode (registry fingerprints → ownerFp; current behavior).
  // The runner's platformKey (LLM calls) is read separately from the header above.
  const ownerKey = resolveTaskOwner(c)
  const { record, created } = createTask('generate', model, requestId, ownerKey, idempotencyKey)
  // P1 fix (rev-behavior): only launch the runner on first creation. A repeat
  // submission with the same Idempotency-Key returns the existing task
  // (created=false) — re-running would duplicate upstream calls (billing) + race
  // on the same record. The existing taskId is returned unchanged.
  if (created) {
    // Fire-and-forget: the runner records progress/result into the registry. The
    // .catch is a safety net only — the runner catches internally.
    void runGenerateTask(record.id, { prompt, imgRatio: body.imgRatio, quality: body.quality, model: body.model, n: body.n, platformKey }).catch((err) => {
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
  // F4: reject malformed X-Mivo-Api-Key at the boundary (no env fallback).
  const badMivoKey = rejectInvalidMivoApiKey(c)
  if (badMivoKey) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
    return badMivoKey
  }
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

  const platformKey = c.req.header('x-mivo-api-key')?.trim() || undefined
  const ownerKey = resolveTaskOwner(c)
  const { record, created } = createTask('edit', modelField, requestId, ownerKey, idempotencyKey)
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
      platformKey,
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
  const ownerKey = resolveTaskOwner(c)
  const { record, created } = createTask('variations', modelField, requestId, ownerKey, idempotencyKey, { batchId, count: variations.length })
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

// FX-3: batch per-user task settle (hydrate-time reconciliation). The client uses
// this to recover wrongly-expired mask-edit chat cards: settleExpiredChatMessages
// (chatStore merge) blanket-marks every in-flight message as 'error' on hydrate —
// correct when the task is gone, WRONG when it actually succeeded on the server.
// This returns the TaskView for each taskId the caller owns and that still exists;
// omitted = gone/non-owner/never-existed (the client treats as expired — the
// server-confirmed settle, replacing the blanket client-side assumption). Reuses
// FX-2's getTaskForOwner so a cross-user probe learns nothing (omitted = same as
// gone). 404 semantics unchanged.
tasksRoute.post('/settle', async (c) => {
  const requestId = newRequestId()
  c.header('X-Request-Id', requestId)
  const t0 = Date.now()
  // FX-2: reject malformed X-Mivo-Api-Key at the boundary (no env fallback).
  const badMivoKey = rejectInvalidMivoApiKey(c)
  if (badMivoKey) {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
    return badMivoKey
  }
  let body: { taskIds?: unknown }
  try {
    body = await readJsonBody<{ taskIds?: unknown }>(c)
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
    return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
  }
  // Cap the batch so a hostile/buggy caller can't enumerate unboundedly; 64 is
  // generous for any real chat scene's in-flight mask-edit cards (the body is
  // also capped at jsonRequestMaxBytes by readJsonBody).
  const taskIds = (Array.isArray(body.taskIds) ? body.taskIds : [])
    .map((x) => String(x))
    .filter((x) => x.length > 0)
    .slice(0, 64)
  const ownerKey = resolveTaskOwner(c)
  const results: Record<string, TaskView> = {}
  for (const id of taskIds) {
    const record = getTaskForOwner(id, ownerKey)
    if (record) results[id] = toView(record)
    // omitted = gone/non-owner/never-existed → client treats as expired
  }
  logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0, upstream: 'task' })
  return c.json({ results }, 200)
})

tasksRoute.get('/:id', (c) => {
  // FX-2: reject malformed X-Mivo-Api-Key at the boundary (no env fallback), then
  // owner-scope the read — a cross-user GET returns the same 404 'unknown-task'
  // as a swept/unknown task (no existence leak).
  const badMivoKey = rejectInvalidMivoApiKey(c)
  if (badMivoKey) return badMivoKey
  const id = c.req.param('id')
  const ownerKey = resolveTaskOwner(c)
  const record = getTaskForOwner(id, ownerKey)
  if (!record) return c.json({ error: 'unknown-task' }, 404)
  return c.json(toView(record), 200)
})

tasksRoute.delete('/:id', (c) => {
  // FX-2: same owner-scope as GET — a cross-user DELETE returns 404 (no leak).
  const badMivoKey = rejectInvalidMivoApiKey(c)
  if (badMivoKey) return badMivoKey
  const id = c.req.param('id')
  const ownerKey = resolveTaskOwner(c)
  const record = getTaskForOwner(id, ownerKey)
  if (!record) return c.json({ error: 'unknown-task' }, 404)
  cancelTask(id)
  return c.json({ id, status: 'canceled' }, 200)
})
