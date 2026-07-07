// server/routes/edit.ts
// POST /api/mivo/edit (multipart) — ported from vite.config.ts proxyMivoEdit L929-L1031.
// Dispatch invariant: no mask + platform model → platform (main image index 0, refs after);
// mask present → llm-proxy gpt-image-2; non-platform no-mask edits use their requested llm-proxy model.
import type { Handler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { HttpBindings } from '@hono/node-server'
import { defaultMivoImageModel, getEnvConfig } from '../lib/config'
import { rejectInvalidMivoApiKey, resolvePlatformCtx } from '../lib/keys'
import {
  fetchUpstreamWithTimeout,
  readUpstreamError,
  RequestBodyTooLargeError,
  UpstreamRequestTimeoutError,
} from '../lib/upstream'
import { normalizeMivoImages, normalizeMivoQuality, resolveRatioPayload } from '../lib/images'
import {
  appendFile,
  firstMultipartField,
  logMaskModelOverride,
  logRequest,
  multipartFiles,
  newRequestId,
  parseMultipartBody,
} from '../lib/request'
import {
  MIVO_PLATFORM_CHANNELS,
  mivoPlatformUploadOne,
  resolveMivoPlatformPayload,
  runMivoPlatformImageJob,
} from '../platform/job'

const readImageApiKey = (imageApiKey: string): string => {
  const key = imageApiKey.trim()
  if (!key) throw new Error('MIVO_IMAGE_API_KEY is not set')
  return key
}

export const editHandler: Handler<{ Bindings: HttpBindings }> = async (c) => {
  const requestId = newRequestId()
  c.header('X-Request-Id', requestId)
  const t0 = Date.now()
  const log = (status: number, upstream?: string, note?: string): void => {
    logRequest({
      method: c.req.method,
      path: c.req.path,
      requestId,
      status,
      upstream,
      latencyMs: Date.now() - t0,
      note,
    })
  }
  const env = getEnvConfig()
  const platformCtx = resolvePlatformCtx(c)
  try {
    if (c.req.method !== 'POST') {
      log(405)
      return c.json({ error: 'Method not allowed' }, 405)
    }

    // F4: reject malformed X-Mivo-Api-Key at the boundary (no env fallback).
    const badMivoKey = rejectInvalidMivoApiKey(c)
    if (badMivoKey) {
      log(400, undefined, 'bad-mivo-key')
      return badMivoKey
    }

    const { fields, files } = await parseMultipartBody(c)
    const image = multipartFiles(files, 'image')[0]
    if (!image) {
      log(400)
      return c.json({ error: 'image is required' }, 400)
    }

    const prompt = firstMultipartField(fields, 'prompt').trim()
    if (!prompt) {
      log(400)
      return c.json({ error: 'prompt is required' }, 400)
    }

    const quality = normalizeMivoQuality(firstMultipartField(fields, 'quality'))
    const requestedModel = firstMultipartField(fields, 'model').trim() || defaultMivoImageModel
    const mask = multipartFiles(files, 'mask')[0]
    const hasMaskBounds = Boolean(firstMultipartField(fields, 'maskBounds').trim())
    const hasMaskInput = Boolean(mask || hasMaskBounds)
    const model = hasMaskInput ? defaultMivoImageModel : requestedModel
    if (hasMaskInput && requestedModel !== model) {
      logMaskModelOverride({
        requestId,
        path: c.req.path,
        fromModel: requestedModel,
        toModel: model,
      })
    }

    // Dispatch invariant (review A): mask present ⇒ unconditionally llm-proxy gpt-image-2
    // (mivo platform has no mask capability); otherwise platform channel for platform
    // models (main image index 0, references appended after — do not drop main image).
    const usePlatform = !hasMaskInput && MIVO_PLATFORM_CHANNELS[model]
    if (usePlatform) {
      if (!platformCtx.platformKey.startsWith('mivo_')) {
        log(500)
        return c.json({ error: 'MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型' }, 500)
      }
      const controller = new AbortController()
      c.env.incoming.on('close', () => {
        if (!c.env.outgoing.headersSent) controller.abort()
      })
      const references = [...multipartFiles(files, 'reference[]'), ...multipartFiles(files, 'reference')]
      const allImages = [image, ...references] // main image first, do not drop
      const fileIds: string[] = []
      try {
        for (const f of allImages) {
          fileIds.push(await mivoPlatformUploadOne(platformCtx, f, controller.signal))
        }
      } catch {
        // upload 4xx/5xx/retry-exhausted → 502 desensitized (does NOT fall into outer 500 catch)
        log(502, 'upload-failed')
        return c.json({ error: '参考图上传失败，请重试或移除参考图' }, 502)
      }
      const { modelType, modelFormat, payload } = resolveMivoPlatformPayload(
        model,
        firstMultipartField(fields, 'imgRatio'),
        quality,
        prompt,
        fileIds,
      )
      const result = await runMivoPlatformImageJob(
        platformCtx,
        { modelType, modelFormat, payload },
        controller.signal,
      )
      if ('aborted' in result) {
        log(499, 'abort')
        return new Response(null, { status: 499 })
      }
      log(result.status, 'platform')
      return c.json(result.body, result.status)
    }

    // llm-proxy edit path (mask / non-platform models)
    const formData = new FormData()
    appendFile(formData, 'image', image)
    if (mask) appendFile(formData, 'mask', mask)
    for (const reference of [...multipartFiles(files, 'reference[]'), ...multipartFiles(files, 'reference')]) {
      appendFile(formData, 'reference[]', reference)
    }
    formData.set('model', model)
    formData.set('prompt', prompt)
    formData.set('quality', quality)
    const ratioPayload = resolveRatioPayload(model, firstMultipartField(fields, 'imgRatio'), quality)
    Object.entries(ratioPayload).forEach(([k, v]) => formData.set(k, v))

    const upstreamResponse = await fetchUpstreamWithTimeout(
      `${env.imageApiBase}/edits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readImageApiKey(env.imageApiKey)}`,
        },
        body: formData,
      },
      env.editUpstreamTimeoutMs,
    )

    if (!upstreamResponse.ok) {
      const msg = await readUpstreamError(upstreamResponse)
      log(upstreamResponse.status, `status=${upstreamResponse.status}`)
      return c.json({ error: msg }, upstreamResponse.status as ContentfulStatusCode)
    }

    log(200, 'ok')
    return c.json(normalizeMivoImages(await upstreamResponse.json()), 200)
  } catch (error) {
    const status =
      error instanceof RequestBodyTooLargeError ? 413 : error instanceof UpstreamRequestTimeoutError ? 504 : 500
    log(status, error instanceof UpstreamRequestTimeoutError ? 'timeout' : 'error')
    return c.json({ error: error instanceof Error ? error.message : 'Unable to edit image' }, status)
  }
}
