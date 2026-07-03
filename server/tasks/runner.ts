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
import { fetchUpstreamWithTimeout, readUpstreamError } from '../lib/upstream'
import { normalizeMivoImages, normalizeMivoQuality, resolveRatioPayload } from '../lib/images'
import {
  MIVO_PLATFORM_CHANNELS,
  mivoPlatformUploadOne,
  resolveMivoPlatformPayload,
  runMivoPlatformImageJob,
  type OnProgress,
} from '../platform/job'
import { completeTask, failTask, getTask, updateProgress } from './registry'

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

  try {
    if (MIVO_PLATFORM_CHANNELS[model]) {
      if (!platformCtx.platformKey.startsWith('mivo_')) {
        failTask(taskId, 'MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型')
        return
      }
      const { modelType, modelFormat, payload } = resolveMivoPlatformPayload(model, params.imgRatio, quality, params.prompt)
      const result = await runMivoPlatformImageJob(platformCtx, { modelType, modelFormat, payload }, record.controller.signal, progressSink(taskId))
      if (canceledInFlight(taskId)) return
      if ('aborted' in result) return // abort without explicit cancel — leave as-is (no commit)
      if (result.status === 200) {
        completeTask(taskId, result.body)
        return
      }
      failTask(taskId, result.body.error)
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
      failTask(taskId, await readUpstreamError(upstreamResponse))
      return
    }
    completeTask(taskId, normalizeMivoImages(await upstreamResponse.json()))
  } catch (error) {
    if (canceledInFlight(taskId)) return // cancel wins over failure
    failTask(taskId, error instanceof Error ? error.message : 'task failed')
  }
}

// Edit task. Dispatch invariant (matches #24 sync edit handler): no mask + platform
// model → platform (upload images, main first, then run job); mask OR non-platform
// model → llm-proxy gpt-image-2.
export const runEditTask = async (taskId: string, params: EditParams): Promise<void> => {
  const record = getTask(taskId)
  if (!record) return
  if (canceledInFlight(taskId)) return
  const env = getEnvConfig()
  const platformCtx: PlatformCtx = { platformKey: env.platformKey, platformEndpoint: env.platformEndpoint }
  const quality = normalizeMivoQuality(params.quality)
  const model = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : defaultMivoImageModel
  const mask = params.mask
  const usePlatform = !mask && Boolean(MIVO_PLATFORM_CHANNELS[model])

  try {
    if (usePlatform) {
      if (!platformCtx.platformKey.startsWith('mivo_')) {
        failTask(taskId, 'MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型')
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
        failTask(taskId, '参考图上传失败，请重试或移除参考图')
        return
      }
      if (canceledInFlight(taskId)) return
      const { modelType, modelFormat, payload } = resolveMivoPlatformPayload(model, params.imgRatio, quality, params.prompt, fileIds)
      const result = await runMivoPlatformImageJob(platformCtx, { modelType, modelFormat, payload }, record.controller.signal, progressSink(taskId))
      if (canceledInFlight(taskId)) return
      if ('aborted' in result) return
      if (result.status === 200) {
        completeTask(taskId, result.body)
        return
      }
      failTask(taskId, result.body.error)
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
      failTask(taskId, await readUpstreamError(upstreamResponse))
      return
    }
    completeTask(taskId, normalizeMivoImages(await upstreamResponse.json()))
  } catch (error) {
    if (canceledInFlight(taskId)) return
    failTask(taskId, error instanceof Error ? error.message : 'task failed')
  }
}
