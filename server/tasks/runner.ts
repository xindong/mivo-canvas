// server/tasks/runner.ts
// P2-C1a: async task orchestration. Reuses #24's platform/llm-proxy primitives
// (runMivoPlatformImageJob / fetchUpstreamWithTimeout / resolveMivoPlatformPayload
// / mivoPlatformUploadOne / normalizeMivoImages) and wires them to the task
// registry: real monotonic progress via onProgress, upstream cancel via the
// task's AbortController.
//
// The runner is fire-and-forget: the route creates the task, kicks off
// runGenerateTask/runEditTask WITHOUT awaiting, and returns {taskId} immediately.
// Errors are caught and recorded as task failures (never thrown to the caller).

import { defaultMivoImageModel, getEnvConfig, type PlatformCtx } from '../lib/config'
import { fetchUpstreamWithTimeout, readUpstreamError, UpstreamRequestTimeoutError } from '../lib/upstream'
import { normalizeMivoImages, normalizeMivoQuality, resolveRatioPayload } from '../lib/images'
import { logMaskModelOverride, logTaskTerminal } from '../lib/request'
import {
  MIVO_PLATFORM_CHANNELS,
  mivoPlatformUploadOne,
  resolveMivoPlatformPayload,
  runMivoPlatformImageJob,
  type OnProgress,
} from '../platform/job'
import {
  completePartialTask,
  completeTask,
  failTask,
  getTask,
  updateProgress,
  type TaskFailure,
  type TaskRecord,
  type TaskResult,
  type TaskResultImage,
} from './registry'

const readImageApiKey = (imageApiKey: string): string => {
  const key = imageApiKey.trim()
  if (!key) throw new Error('MIVO_IMAGE_API_KEY is not set')
  return key
}

// If the task was canceled (or its signal aborted) mid-flight, stop and leave
// the registry's 'canceled' state intact — do NOT commit a result or failure.
const canceledInFlight = (taskId: string): boolean => {
  const r = getTask(taskId)
  if (!r) return true
  return r.controller.signal.aborted || r.status === 'canceled'
}

const progressSink = (taskId: string): OnProgress => (report) => updateProgress(taskId, report.stage, report.progress)

type TaskLogContext = {
  record: TaskRecord
  model: string
  hasMask: boolean
  hasReferences: boolean
  channel: 'platform' | 'llm-proxy'
  promptLength?: number
}

const errorClassFor = (error: unknown): string =>
  error instanceof Error ? error.constructor.name || error.name || 'Error' : 'unknown-error'

const statusFromErrorText = (error: string | undefined): number | undefined => {
  const match = error?.match(/\b([45]\d\d)\b/)
  return match ? Number(match[1]) : undefined
}

const logTerminal = (
  context: TaskLogContext,
  finalStatus: 'done' | 'partial' | 'failed',
  details: { errorClass?: string; httpStatus?: number } = {},
): void => {
  logTaskTerminal({
    taskId: context.record.id,
    requestId: context.record.requestId,
    kind: context.record.kind,
    model: context.model,
    hasMask: context.hasMask,
    hasReferences: context.hasReferences,
    channel: context.channel,
    finalStatus,
    latencyMs: Date.now() - context.record.createdAt,
    promptLength: context.promptLength,
    errorClass: details.errorClass,
    httpStatus: details.httpStatus,
  })
}

const completeTaskLogged = (taskId: string, result: TaskResult, context: TaskLogContext): void => {
  completeTask(taskId, result)
  if (getTask(taskId)?.status === 'done') logTerminal(context, 'done')
}

const completePartialTaskLogged = (
  taskId: string,
  result: TaskResult,
  failures: TaskFailure[],
  context: TaskLogContext,
): void => {
  completePartialTask(taskId, result, failures)
  if (getTask(taskId)?.status === 'partial') {
    logTerminal(context, 'partial', {
      errorClass: 'partial-upstream-error',
      httpStatus: statusFromErrorText(failures[0]?.error),
    })
  }
}

const failTaskLogged = (
  taskId: string,
  error: string,
  context: TaskLogContext,
  details: { errorClass?: string; httpStatus?: number } = {},
): void => {
  failTask(taskId, error)
  if (getTask(taskId)?.status === 'failed') logTerminal(context, 'failed', details)
}

const effectiveModelForMask = (requestedModel: string, hasMask: boolean, record: TaskRecord): string => {
  if (!hasMask) return requestedModel
  if (requestedModel !== defaultMivoImageModel) {
    logMaskModelOverride({
      requestId: record.requestId,
      taskId: record.id,
      path: '/api/mivo/tasks/edit',
      fromModel: requestedModel,
      toModel: defaultMivoImageModel,
    })
  }
  return defaultMivoImageModel
}

export type GenerateParams = {
  prompt: string
  imgRatio?: unknown
  quality?: unknown // raw; normalized here
  model?: unknown // raw; normalized here
  n?: unknown
}

export type EditParams = {
  image: File
  prompt: string
  imgRatio?: unknown
  quality?: unknown
  model?: unknown
  mask?: File
  references: File[]
}

// Generate task. Dispatch: platform channel → runMivoPlatformImageJob (real
// progress 10→20-90→95→100); otherwise llm-proxy fetch (coarse 10→100).
export const runGenerateTask = async (taskId: string, params: GenerateParams): Promise<void> => {
  const record = getTask(taskId)
  if (!record) return
  if (canceledInFlight(taskId)) return
  const env = getEnvConfig()
  const platformCtx: PlatformCtx = { platformKey: env.platformKey, platformEndpoint: env.platformEndpoint }
  const quality = normalizeMivoQuality(params.quality)
  const model = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : defaultMivoImageModel
  const channel = MIVO_PLATFORM_CHANNELS[model] ? 'platform' : 'llm-proxy'
  const logContext: TaskLogContext = {
    record,
    model,
    hasMask: false,
    hasReferences: false,
    channel,
    promptLength: params.prompt.length,
  }

  try {
    if (MIVO_PLATFORM_CHANNELS[model]) {
      if (!platformCtx.platformKey.startsWith('mivo_')) {
        failTaskLogged(taskId, 'MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型', logContext, {
          errorClass: 'config',
          httpStatus: 500,
        })
        return
      }
      const { modelType, modelFormat, payload } = resolveMivoPlatformPayload(model, params.imgRatio, quality, params.prompt)
      const result = await runMivoPlatformImageJob(platformCtx, { modelType, modelFormat, payload }, record.controller.signal, progressSink(taskId))
      if (canceledInFlight(taskId)) return
      if ('aborted' in result) return // abort without explicit cancel — leave as-is (no commit)
      if (result.status === 200) {
        completeTaskLogged(taskId, result.body, logContext)
        return
      }
      failTaskLogged(taskId, result.body.error, logContext, {
        errorClass: 'platform-status',
        httpStatus: result.status,
      })
      return
    }

    // llm-proxy path (coarse progress)
    updateProgress(taskId, 'request', 10)
    const n = Number.isFinite(Number(params.n)) ? Math.max(1, Math.min(4, Math.floor(Number(params.n)))) : 1
    const upstreamResponse = await fetchUpstreamWithTimeout(
      `${env.imageApiBase}/generations`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${readImageApiKey(env.imageApiKey)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: params.prompt, n, ...resolveRatioPayload(model, params.imgRatio, quality), quality }),
      },
      env.upstreamTimeoutMs,
      record.controller.signal,
    )
    if (canceledInFlight(taskId)) return
    if (!upstreamResponse.ok) {
      failTaskLogged(taskId, await readUpstreamError(upstreamResponse), logContext, {
        errorClass: 'upstream-status',
        httpStatus: upstreamResponse.status,
      })
      return
    }
    completeTaskLogged(taskId, normalizeMivoImages(await upstreamResponse.json()), logContext)
  } catch (error) {
    if (canceledInFlight(taskId)) return // cancel wins over failure
    failTaskLogged(taskId, error instanceof Error ? error.message : 'task failed', logContext, {
      errorClass: errorClassFor(error),
      httpStatus: error instanceof UpstreamRequestTimeoutError ? 504 : undefined,
    })
  }
}

// Edit task. Dispatch invariant (matches sync edit handler): no mask + platform
// model → platform (upload images, main first, then run job); mask → llm-proxy
// gpt-image-2; non-platform no-mask edits use their requested llm-proxy model.
export const runEditTask = async (taskId: string, params: EditParams): Promise<void> => {
  const record = getTask(taskId)
  if (!record) return
  if (canceledInFlight(taskId)) return
  const env = getEnvConfig()
  const platformCtx: PlatformCtx = { platformKey: env.platformKey, platformEndpoint: env.platformEndpoint }
  const quality = normalizeMivoQuality(params.quality)
  const mask = params.mask
  const requestedModel = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : defaultMivoImageModel
  const model = effectiveModelForMask(requestedModel, Boolean(mask), record)
  const usePlatform = !mask && Boolean(MIVO_PLATFORM_CHANNELS[model])
  const logContext: TaskLogContext = {
    record,
    model,
    hasMask: Boolean(mask),
    hasReferences: params.references.length > 0,
    channel: usePlatform ? 'platform' : 'llm-proxy',
    promptLength: params.prompt.length,
  }

  try {
    if (usePlatform) {
      if (!platformCtx.platformKey.startsWith('mivo_')) {
        failTaskLogged(taskId, 'MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型', logContext, {
          errorClass: 'config',
          httpStatus: 500,
        })
        return
      }
      updateProgress(taskId, 'upload', 5)
      const allImages = [params.image, ...params.references] // main first, do not drop
      const fileIds: string[] = []
      try {
        for (const f of allImages) {
          fileIds.push(await mivoPlatformUploadOne(platformCtx, f, record.controller.signal))
        }
      } catch {
        failTaskLogged(taskId, '参考图上传失败，请重试或移除参考图', logContext, {
          errorClass: 'platform-upload',
          httpStatus: 502,
        })
        return
      }
      if (canceledInFlight(taskId)) return
      const { modelType, modelFormat, payload } = resolveMivoPlatformPayload(model, params.imgRatio, quality, params.prompt, fileIds)
      const result = await runMivoPlatformImageJob(platformCtx, { modelType, modelFormat, payload }, record.controller.signal, progressSink(taskId))
      if (canceledInFlight(taskId)) return
      if ('aborted' in result) return
      if (result.status === 200) {
        completeTaskLogged(taskId, result.body, logContext)
        return
      }
      failTaskLogged(taskId, result.body.error, logContext, {
        errorClass: 'platform-status',
        httpStatus: result.status,
      })
      return
    }

    // llm-proxy edit path (mask / non-platform models; coarse progress)
    updateProgress(taskId, 'request', 10)
    const formData = new FormData()
    formData.append('image', params.image, params.image.name || 'image.png')
    if (mask) formData.append('mask', mask, mask.name || 'mask.png')
    for (const reference of params.references) formData.append('reference[]', reference, reference.name || 'reference.png')
    formData.set('model', model)
    formData.set('prompt', params.prompt)
    formData.set('quality', quality)
    const ratioPayload = resolveRatioPayload(model, params.imgRatio, quality)
    Object.entries(ratioPayload).forEach(([k, v]) => formData.set(k, v))

    const upstreamResponse = await fetchUpstreamWithTimeout(
      `${env.imageApiBase}/edits`,
      { method: 'POST', headers: { Authorization: `Bearer ${readImageApiKey(env.imageApiKey)}` }, body: formData },
      env.editUpstreamTimeoutMs,
      record.controller.signal,
    )
    if (canceledInFlight(taskId)) return
    if (!upstreamResponse.ok) {
      failTaskLogged(taskId, await readUpstreamError(upstreamResponse), logContext, {
        errorClass: 'upstream-status',
        httpStatus: upstreamResponse.status,
      })
      return
    }
    completeTaskLogged(taskId, normalizeMivoImages(await upstreamResponse.json()), logContext)
  } catch (error) {
    if (canceledInFlight(taskId)) return
    failTaskLogged(taskId, error instanceof Error ? error.message : 'task failed', logContext, {
      errorClass: errorClassFor(error),
      httpStatus: error instanceof UpstreamRequestTimeoutError ? 504 : undefined,
    })
  }
}

// ─── P2-C2: variations (batch of N parallel edits sharing one source image) ────
//
// Per the C2 contract (server/contracts/tasks-async.md §variations): the client
// sends the source image + N variation param sets; the BFF fires N parallel
// llm-proxy /edits calls (one per variation, each = image + that variation's
// prompt/params), concurrency capped by MIVO_VARIATIONS_CONCURRENCY (default 4,
// batched). Settled outcomes aggregate into:
//   all success → completeTask({images: all, with variationIndex})
//   some success → completePartialTask({images: successes}, failures[])
//   all fail    → failTask(desensitized first error)
// Cancel: the task controller's signal aborts every in-flight per-variation fetch
// (linkExternalSignal in fetchUpstreamWithTimeout); the final canceledInFlight
// check leaves the registry's 'canceled' state intact (no commit).
//
// Variation params mirror /tasks/generate's body (prompt/imgRatio/quality/model);
// the call is /edits (img-to-img) because variations share the source image
// ("对一张源图...共享同一源图"). Platform-channel models are NOT dispatched here
// in C2 (variations stay on llm-proxy /edits); platform variations are a follow-up.

export type VariationParam = {
  prompt?: unknown
  imgRatio?: unknown
  quality?: unknown
  model?: unknown
}

export type VariationsParams = {
  image: File
  variations: VariationParam[]
  batchId: string
}

// Strip URL/key/stack info from a per-variation failure so failures[] carries a
// safe, stable classifier the client can render (e2e asserts on the status code).
const desensitizeVariationError = (error: unknown): string => {
  if (error instanceof UpstreamRequestTimeoutError) return 'upstream-timeout'
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'canceled'
    const msg = error.message
    if (/timeout|timed[\s-]?out|超时/i.test(msg)) return 'upstream-timeout'
    // "Upstream error (NNN)" from runOneVariationEdit's non-OK branch — keep the
    // status, drop the body (which may carry upstream-internal detail).
    const statusMatch = msg.match(/Upstream error \((\d+)\)/)
    if (statusMatch) return `Upstream error (${statusMatch[1]})`
    return 'upstream-error'
  }
  return 'unknown-error'
}

// One variation = one llm-proxy /edits call (image + prompt + params, n=1). Throws
// on any failure (the caller's allSettled bucket catches it into failures[]).
const runOneVariationEdit = async (
  env: ReturnType<typeof getEnvConfig>,
  image: File,
  variation: VariationParam,
  variationIndex: number,
  signal: AbortSignal,
): Promise<TaskResultImage> => {
  const model = typeof variation.model === 'string' && variation.model.trim() ? variation.model.trim() : defaultMivoImageModel
  const quality = normalizeMivoQuality(variation.quality)
  const prompt = (typeof variation.prompt === 'string' ? variation.prompt : '').trim() || '基于当前参考图继续发散'
  const formData = new FormData()
  formData.append('image', image, image.name || 'source.png')
  formData.set('model', model)
  formData.set('prompt', prompt)
  formData.set('quality', quality)
  const ratioPayload = resolveRatioPayload(model, variation.imgRatio, quality)
  Object.entries(ratioPayload).forEach(([k, v]) => formData.set(k, v))

  const response = await fetchUpstreamWithTimeout(
    `${env.imageApiBase}/edits`,
    { method: 'POST', headers: { Authorization: `Bearer ${readImageApiKey(env.imageApiKey)}` }, body: formData },
    env.editUpstreamTimeoutMs,
    signal,
  )
  if (!response.ok) throw new Error(`Upstream error (${response.status})`)
  const normalized = normalizeMivoImages(await response.json())
  const b64 = normalized.images[0]?.b64
  if (!b64) throw new Error('Upstream returned no image')
  return { b64, variationIndex }
}

export const runVariationsTask = async (taskId: string, params: VariationsParams): Promise<void> => {
  const record = getTask(taskId)
  if (!record) return
  if (canceledInFlight(taskId)) return
  const env = getEnvConfig()
  const signal = record.controller.signal
  const total = params.variations.length
  if (total === 0) {
    failTaskLogged(
      taskId,
      'variations array is empty',
      {
        record,
        model: record.model,
        hasMask: false,
        hasReferences: false,
        channel: 'llm-proxy',
        promptLength: 0,
      },
      { errorClass: 'validation', httpStatus: 400 },
    )
    return
  }
  const logContext: TaskLogContext = {
    record,
    model: record.model,
    hasMask: false,
    hasReferences: false,
    channel: 'llm-proxy',
    promptLength: params.variations.reduce((sum, variation) => {
      const prompt = typeof variation.prompt === 'string' ? variation.prompt : ''
      return sum + prompt.length
    }, 0),
  }
  const concurrency = Math.max(1, Math.min(total, env.variationsConcurrency))
  updateProgress(taskId, 'submit', 5)

  const successes: TaskResultImage[] = []
  const failures: TaskFailure[] = []
  let settled = 0

  // Batched allSettled: launch `concurrency` at a time, wait for the batch, then
  // start the next. Matching the contract's "并发上限…>4 时分批,每批 4".
  for (let start = 0; start < total; start += concurrency) {
    if (canceledInFlight(taskId)) return
    const batch = params.variations.slice(start, start + concurrency)
    const results = await Promise.allSettled(
      batch.map((variation, offset) => runOneVariationEdit(env, params.image, variation, start + offset, signal)),
    )
    results.forEach((result, offset) => {
      const variationIndex = start + offset
      settled += 1
      if (result.status === 'fulfilled') {
        successes.push(result.value)
      } else {
        failures.push({ variationIndex, error: desensitizeVariationError(result.reason) })
      }
      // Monotonic progress = settled/total, capped at 95 (terminal sets 100).
      updateProgress(taskId, 'poll', Math.min(95, 5 + Math.round((settled / total) * 90)))
    })
  }

  if (canceledInFlight(taskId)) return
  if (successes.length === 0) {
    const error = failures[0]?.error || 'All variations failed'
    failTaskLogged(taskId, error, logContext, {
      errorClass: 'upstream-status',
      httpStatus: statusFromErrorText(error),
    })
    return
  }
  if (failures.length === 0) {
    completeTaskLogged(taskId, { images: successes }, logContext)
    return
  }
  completePartialTaskLogged(taskId, { images: successes }, failures, logContext)
}
