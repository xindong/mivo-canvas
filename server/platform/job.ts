// server/platform/job.ts
// Platform channel: submit/poll/download/upload + runMivoPlatformImageJob.
// Ported from vite.config.ts L677-L853. Returns structured result (does NOT write
// to the response directly — the Hono handler maps result → c.json(body, status)).
import { Buffer } from 'node:buffer'
import type { PlatformCtx } from '../lib/config'
import { getEnvConfig } from '../lib/config'
import { mivoPlatformEnsureChatSession, mivoPlatformFetch, sanitizePlatformError } from './state'

export const MIVO_PLATFORM_CHANNELS: Record<string, { modelType: string; version: string }> = {
  'gemini-3-pro-image': { modelType: 'NANOBANANA', version: 'gemini-3-pro-image-preview' },
  'gpt-image-2': { modelType: 'GPT', version: 'gpt-image-2' },
}

const mivoPlatformRatioSet = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '4:5', '5:4'])
const mivoResolutionMap: Record<string, string> = { low: '1K', medium: '1K', high: '2K' }

export type PlatformJobParams = {
  modelType: string
  modelFormat?: { version: string }
  payload: Record<string, unknown>
}

export type PlatformJobResult =
  | { status: 200; body: { images: Array<{ b64: string }> } }
  | { status: 504; body: { error: string } }
  | { status: 502; body: { error: string } }
  | { aborted: true }

export const resolveMivoPlatformPayload = (
  modelId: string,
  imgRatio: unknown,
  quality: string,
  prompt: string,
  images?: string[],
): PlatformJobParams => {
  const channel = MIVO_PLATFORM_CHANNELS[modelId]
  const rawRatio = typeof imgRatio === 'string' ? imgRatio : '1:1'
  const clampedRatio = mivoPlatformRatioSet.has(rawRatio) ? rawRatio : '1:1'
  const resolution = mivoResolutionMap[quality] || '1K'
  const payload: Record<string, unknown> = { prompt, imgRatio: clampedRatio, resolution, n: 1 }
  if (images && images.length) payload.images = images
  return {
    modelType: channel?.modelType || 'NANOBANANA',
    modelFormat: channel ? { version: channel.version } : undefined,
    payload,
  }
}

export const mivoPlatformSubmitMessage = async (
  ctx: PlatformCtx,
  params: PlatformJobParams,
  signal?: AbortSignal,
): Promise<string> => {
  const chatSessionId = await mivoPlatformEnsureChatSession(ctx, signal)
  const body: Record<string, unknown> = {
    chatSessionId,
    messageType: 'image',
    modelType: params.modelType,
    action: 'mcp',
    payload: params.payload,
  }
  if (params.modelFormat !== undefined) body.modelFormat = params.modelFormat
  const res = await mivoPlatformFetch(
    `${ctx.platformEndpoint}/api/v1/message`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ctx,
    signal,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`platform submit ${res.status}: ${sanitizePlatformError(text)}`)
  }
  const json = (await res.json()) as { object_id?: string; jobId?: string }
  const jobId = json.object_id || json.jobId
  if (!jobId) throw new Error(`platform submit no jobId: ${sanitizePlatformError(JSON.stringify(json).slice(0, 200))}`)
  return jobId
}

type PollResult = {
  status: 'completed' | 'failed' | 'timeout' | 'aborted'
  images?: string[]
  error?: string
  lastStatus?: string | null
}

export const mivoPlatformPollJob = async (
  ctx: PlatformCtx,
  jobId: string,
  signal?: AbortSignal,
): Promise<PollResult> => {
  const { platformPollDeadlineMs, platformPollIntervalMs } = getEnvConfig()
  const t0 = Date.now()
  let lastStatus: string | null = null
  while (Date.now() - t0 < platformPollDeadlineMs) {
    if (signal?.aborted) return { status: 'aborted' }
    const res = await mivoPlatformFetch(
      `${ctx.platformEndpoint}/api/v1/message/${jobId}`,
      { headers: {} },
      ctx,
      signal,
    )
    if (!res.ok) throw new Error(`platform poll ${res.status}`)
    const json = (await res.json()) as {
      content?: { status?: string; state?: string; images?: string[]; error?: string; message?: string }
      status?: string
      images?: string[]
      error?: string
    }
    const content =
      json.content ||
      (json as { status?: string; state?: string; images?: string[]; error?: string; message?: string })
    lastStatus = content.status || content.state || 'pending'
    if (lastStatus === 'completed') {
      return { status: 'completed', images: content.images || [] }
    }
    if (lastStatus === 'failed') {
      return { status: 'failed', error: sanitizePlatformError(content.error || content.message || 'failed') }
    }
    await new Promise((r) => setTimeout(r, platformPollIntervalMs))
  }
  return { status: 'timeout', lastStatus }
}

export const mivoPlatformDownloadImage = async (
  ctx: PlatformCtx,
  fileUrlPath: string,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const fileId = String(fileUrlPath).split('/').pop() || ''
  if (!fileId) throw new Error('platform download: empty fileId')
  const signRes = await mivoPlatformFetch(
    `${ctx.platformEndpoint}/api/v1/file/signUrl/${fileId}`,
    { headers: {} },
    ctx,
    signal,
  )
  if (!signRes.ok) throw new Error(`platform signUrl ${signRes.status}`)
  let signedUrl = (await signRes.text()).trim()
  if (signedUrl.startsWith('"') && signedUrl.endsWith('"')) signedUrl = signedUrl.slice(1, -1)
  if (signedUrl.startsWith('{')) {
    const j = JSON.parse(signedUrl) as { url?: string; signUrl?: string; data?: { url?: string } }
    signedUrl = j.url || j.signUrl || j.data?.url || ''
  }
  // signUrl may be protocol-relative (//host/...); prefix https:
  if (signedUrl.startsWith('//')) signedUrl = `https:${signedUrl}`
  if (!signedUrl.startsWith('http')) throw new Error('platform signUrl not a url')
  const imgRes = await fetch(signedUrl, { signal })
  if (!imgRes.ok) throw new Error(`platform download ${imgRes.status}`)
  return Buffer.from(await imgRes.arrayBuffer())
}

export const mivoPlatformUploadOne = async (
  ctx: PlatformCtx,
  file: File,
  signal?: AbortSignal,
): Promise<string> => {
  const buf = Buffer.from(await file.arrayBuffer())
  const blob = new Blob([buf], { type: file.type || 'image/png' })
  const form = new FormData()
  form.append('file', blob, file.name || 'reference.png')
  const res = await mivoPlatformFetch(
    `${ctx.platformEndpoint}/api/v1/file/`,
    { method: 'POST', body: form },
    ctx,
    signal,
  )
  if (!res.ok) throw new Error(`platform upload ${res.status}`)
  const json = (await res.json()) as unknown
  const arr = (Array.isArray(json)
    ? json
    : (json as { files?: unknown[]; data?: unknown[] })?.files ||
      (json as { data?: unknown[] })?.data ||
      [json]) as Array<{ object_id?: string; _id?: string }>
  const id =
    arr[0]?.object_id ||
    arr[0]?._id ||
    (json as { object_id?: string; _id?: string })?.object_id ||
    (json as { _id?: string })?._id
  if (!id) throw new Error('platform upload no file id')
  return id
}

// Platform image job runner: submit + poll + download + normalize {images:[{b64}]}.
// Returns a structured result; the Hono handler maps it to c.json(body, status).
// Abort (client disconnect) → {aborted:true}; faithful to dev's writableEnded guard
// (handler returns 499 into the void — client is already gone).
export const runMivoPlatformImageJob = async (
  ctx: PlatformCtx,
  params: PlatformJobParams,
  signal?: AbortSignal,
): Promise<PlatformJobResult> => {
  try {
    const jobId = await mivoPlatformSubmitMessage(ctx, params, signal)
    const poll = await mivoPlatformPollJob(ctx, jobId, signal)
    if (poll.status === 'aborted') return { aborted: true }
    if (poll.status === 'timeout') {
      const isHigh = params.payload.resolution === '2K'
      return {
        status: 504,
        body: {
          error: isHigh
            ? '上游生成超时，可降低质量重试'
            : '上游生成超时，可稍后重试、换比例或减少参考图',
        },
      }
    }
    if (poll.status === 'failed') {
      return { status: 502, body: { error: poll.error || '生成失败' } }
    }
    const imgPath = poll.images?.[0]
    if (!imgPath) {
      return { status: 502, body: { error: '生成失败：结果为空' } }
    }
    const buf = await mivoPlatformDownloadImage(ctx, imgPath, signal)
    return { status: 200, body: { images: [{ b64: buf.toString('base64') }] } }
  } catch (error) {
    if (signal?.aborted) return { aborted: true }
    return {
      status: 502,
      body: { error: sanitizePlatformError(error instanceof Error ? error.message : '生成失败') },
    }
  }
}
