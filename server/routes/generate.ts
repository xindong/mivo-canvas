// server/routes/generate.ts
// POST /api/mivo/generate — ported from vite.config.ts proxyMivoGenerate L855-L927.
// Model dispatch: platform channel (gemini-3-pro-image / gpt-image-2) → submit→poll→download;
// otherwise llm-proxy. Platform failure does NOT fall back to llm-proxy.
import type { Handler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { HttpBindings } from '@hono/node-server'
import { defaultMivoImageModel, getEnvConfig, type PlatformCtx } from '../lib/config'
import {
  fetchUpstreamWithTimeout,
  readUpstreamError,
  RequestBodyTooLargeError,
  UpstreamRequestTimeoutError,
} from '../lib/upstream'
import { normalizeMivoImages, normalizeMivoQuality, resolveRatioPayload } from '../lib/images'
import { logRequest, newRequestId, readJsonBody } from '../lib/request'
import { MIVO_PLATFORM_CHANNELS, resolveMivoPlatformPayload, runMivoPlatformImageJob } from '../platform/job'

type GenerateBody = {
  prompt?: unknown
  imgRatio?: unknown
  quality?: unknown
  n?: unknown
  model?: unknown
}

const readImageApiKey = (imageApiKey: string): string => {
  const key = imageApiKey.trim()
  if (!key) throw new Error('MIVO_IMAGE_API_KEY is not set')
  return key
}

export const generateHandler: Handler<{ Bindings: HttpBindings }> = async (c) => {
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
  const platformCtx: PlatformCtx = { platformKey: env.platformKey, platformEndpoint: env.platformEndpoint }
  try {
    if (c.req.method !== 'POST') {
      log(405)
      return c.json({ error: 'Method not allowed' }, 405)
    }

    const body = await readJsonBody<GenerateBody>(c)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) {
      log(400)
      return c.json({ error: 'prompt is required' }, 400)
    }

    const quality = normalizeMivoQuality(body.quality)
    const modelId =
      typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultMivoImageModel

    // Dispatch: platform channels (gemini + gated gpt-image-2) → platform; rest → llm-proxy
    if (MIVO_PLATFORM_CHANNELS[modelId]) {
      if (!platformCtx.platformKey.startsWith('mivo_')) {
        log(500)
        return c.json({ error: 'MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型' }, 500)
      }
      const controller = new AbortController()
      c.env.incoming.on('close', () => {
        if (!c.env.outgoing.headersSent) controller.abort()
      })
      const { modelType, modelFormat, payload } = resolveMivoPlatformPayload(
        modelId,
        body.imgRatio,
        quality,
        prompt,
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

    // llm-proxy path (fallback: models not in platform channels)
    const upstreamResponse = await fetchUpstreamWithTimeout(
      `${env.imageApiBase}/generations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readImageApiKey(env.imageApiKey)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          prompt,
          n: Number.isFinite(Number(body.n)) ? Math.max(1, Math.min(4, Math.floor(Number(body.n)))) : 1,
          ...resolveRatioPayload(modelId, body.imgRatio, quality),
          quality,
        }),
      },
      env.upstreamTimeoutMs,
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
    return c.json({ error: error instanceof Error ? error.message : 'Unable to generate image' }, status)
  }
}
