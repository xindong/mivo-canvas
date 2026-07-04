// server/platform/job.ts
// Platform channel: submit/poll/download/upload + runMivoPlatformImageJob.
// Ported from vite.config.ts L677-L853. Returns structured result (does NOT write
// to the response directly — the Hono handler maps result → c.json(body, status)).
import { Buffer } from 'node:buffer'
import type { PlatformCtx } from '../lib/config'
import { getEnvConfig, resolveMivoPlatformPollDeadlineMs } from '../lib/config'
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

export type PlatformJobMetadata = {
  resolution?: string
  pollDeadlineMs?: number
  platformJobIdHash?: string
}

export type PlatformJobResult =
  | { status: 200; body: { images: Array<{ b64: string }> }; metadata?: PlatformJobMetadata }
  | { status: 504; body: { error: string }; metadata?: PlatformJobMetadata }
  | { status: 502; body: { error: string }; metadata?: PlatformJobMetadata }
  | { aborted: true }

// P2-C1a: progress reporting hook. Optional; #24's sync callers pass nothing
// (behavior unchanged). The async task runner passes a callback that updates the
// task registry. progress is 0-100, monotonic by contract (the registry clamps).
export type ProgressReport = { stage: string; progress: number }
export type OnProgress = (report: ProgressReport) => void

const platformRetryBackoffMs = 1_000
// V03: how many consecutive transient poll failures (fetch reject or 5xx) the
// poll loop tolerates before giving up. 3 ≈ "a blip + a retry pair" — a single
// 5xx/timeout no longer voids a 170s generation. 4xx stays a hard throw.
const platformPollMaxFailures = 3
const transientPlatformErrorPattern =
  /ClosedChannelException|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|connection reset|connection terminated|socket hang up|socket terminated|fetch failed|UND_ERR/i

class PlatformHttpError extends Error {
  status: number

  constructor(operation: string, status: number, bodyText = '') {
    const sanitized = sanitizePlatformError(bodyText)
    super(`platform ${operation} ${status}${sanitized ? `: ${sanitized}` : ''}`)
    this.name = 'PlatformHttpError'
    this.status = status
  }
}

class DownloadRetryExhaustedError extends Error {
  constructor(cause: unknown) {
    super('platform download retry exhausted', { cause })
    this.name = 'DownloadRetryExhaustedError'
  }
}

const shortPlatformJobId = (jobId: string): string => jobId.slice(-8)

const platformResponseError = async (operation: string, res: Response): Promise<PlatformHttpError> =>
  new PlatformHttpError(operation, res.status, await res.text().catch(() => ''))

const isRetriablePlatformError = (error: unknown): boolean => {
  if (error instanceof DownloadRetryExhaustedError) return false
  if (error instanceof PlatformHttpError) {
    return error.status >= 500 && error.status < 600 && error.status !== 504
  }
  if (error instanceof Error && error.name === 'AbortError') return false
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as Error & { cause?: unknown }).cause || '')}`
      : String(error)
  return transientPlatformErrorPattern.test(text)
}

const waitForPlatformRetry = async (signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, platformRetryBackoffMs)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const logPlatformTransientRetry = (operation: string, error: unknown): void => {
  const reason = sanitizePlatformError(error instanceof Error ? error.message : String(error))
  console.log(`[mivo-bff] event=platform-transient-retry operation=${operation} attempt=2 reason=${reason}`)
}

// V03: like logPlatformTransientRetry but with the real attempt number — the poll
// loop retries more than once, so the streak counter is what observers want.
const logPollTransientRetry = (attempt: number, error: unknown): void => {
  const reason = sanitizePlatformError(error instanceof Error ? error.message : String(error))
  console.log(`[mivo-bff] event=platform-transient-retry operation=poll attempt=${attempt} reason=${reason}`)
}

const withPlatformTransientRetry = async <T>(
  operation: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    if (signal?.aborted || !isRetriablePlatformError(error)) throw error
    logPlatformTransientRetry(operation, error)
    await waitForPlatformRetry(signal)
    return run()
  }
}

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
    throw await platformResponseError('submit', res)
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
  onProgress?: OnProgress,
  pollDeadlineMs?: number,
): Promise<PollResult> => {
  const { platformPollIntervalMs } = getEnvConfig()
  const platformPollDeadlineMs = pollDeadlineMs ?? resolveMivoPlatformPollDeadlineMs('1K')
  const t0 = Date.now()
  let lastStatus: string | null = null
  // V03: tolerate transient poll failures (fetch reject or 5xx). A single blip
  // no longer voids a long generation — only `platformPollMaxFailures` in a row
  // do. Any 2xx response resets the streak. 4xx stays a hard throw (permanent).
  // Aborts surface immediately. The outer while-deadline still bounds total time,
  // so retry waits cannot extend past platformPollDeadlineMs.
  let consecutiveFailures = 0
  while (Date.now() - t0 < platformPollDeadlineMs) {
    if (signal?.aborted) return { status: 'aborted' }
    // P2-C1a: map elapsed/deadline to 20-90 (real progress, not hardcoded).
    const elapsed = Date.now() - t0
    const pollProgress = 20 + Math.min(1, elapsed / platformPollDeadlineMs) * 70
    onProgress?.({ stage: 'poll', progress: pollProgress })
    let res: Response
    try {
      res = await mivoPlatformFetch(
        `${ctx.platformEndpoint}/api/v1/message/${jobId}`,
        { headers: {} },
        ctx,
        signal,
      )
    } catch (error) {
      // V03: abort is not a transient failure — surface it immediately.
      if (signal?.aborted) return { status: 'aborted' }
      // V03: fetch reject (network stall, V05 per-request timeout, ECONNRESET, …)
      // is transient — count it, wait one interval, keep polling.
      consecutiveFailures += 1
      logPollTransientRetry(consecutiveFailures, error)
      if (consecutiveFailures >= platformPollMaxFailures) throw error
      await new Promise((r) => setTimeout(r, platformPollIntervalMs))
      continue
    }
    if (!res.ok) {
      // 4xx is permanent (bad jobId / auth / shape) — never retry, throw now.
      if (res.status < 500) throw await platformResponseError('poll', res)
      // 5xx is transient — same streak path as a fetch reject.
      const err = await platformResponseError('poll', res)
      consecutiveFailures += 1
      logPollTransientRetry(consecutiveFailures, err)
      if (consecutiveFailures >= platformPollMaxFailures) throw err
      await new Promise((r) => setTimeout(r, platformPollIntervalMs))
      continue
    }
    // A 2xx response resets the streak — only sustained failure throws.
    consecutiveFailures = 0
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
  try {
    return await withPlatformTransientRetry('download', signal, async () => {
      const fileId = String(fileUrlPath).split('/').pop() || ''
      if (!fileId) throw new Error('platform download: empty fileId')
      const signRes = await mivoPlatformFetch(
        `${ctx.platformEndpoint}/api/v1/file/signUrl/${fileId}`,
        { headers: {} },
        ctx,
        signal,
      )
      if (!signRes.ok) throw await platformResponseError('signUrl', signRes)
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
      if (!imgRes.ok) throw new PlatformHttpError('download', imgRes.status)
      return Buffer.from(await imgRes.arrayBuffer())
    })
  } catch (error) {
    if (isRetriablePlatformError(error)) throw new DownloadRetryExhaustedError(error)
    throw error
  }
}

export const mivoPlatformUploadOne = async (
  ctx: PlatformCtx,
  file: File,
  signal?: AbortSignal,
): Promise<string> => {
  const buf = Buffer.from(await file.arrayBuffer())
  return withPlatformTransientRetry('upload', signal, async () => {
    const blob = new Blob([buf], { type: file.type || 'image/png' })
    const form = new FormData()
    form.append('file', blob, file.name || 'reference.png')
    const res = await mivoPlatformFetch(
      `${ctx.platformEndpoint}/api/v1/file/`,
      { method: 'POST', body: form },
      ctx,
      signal,
    )
    if (!res.ok) throw await platformResponseError('upload', res)
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
  })
}

const runMivoPlatformImageJobOnce = async (
  ctx: PlatformCtx,
  params: PlatformJobParams,
  signal: AbortSignal | undefined,
  onProgress: OnProgress | undefined,
  metadata: PlatformJobMetadata,
): Promise<PlatformJobResult> => {
  onProgress?.({ stage: 'submit', progress: 10 })
  const jobId = await mivoPlatformSubmitMessage(ctx, params, signal)
  metadata.platformJobIdHash = shortPlatformJobId(jobId)
  const poll = await mivoPlatformPollJob(ctx, jobId, signal, onProgress, metadata.pollDeadlineMs)
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
      metadata,
    }
  }
  if (poll.status === 'failed') {
    if (isRetriablePlatformError(new Error(poll.error || 'platform poll failed'))) {
      throw new Error(poll.error || 'platform poll failed')
    }
    return { status: 502, body: { error: poll.error || '生成失败' }, metadata }
  }
  const imgPath = poll.images?.[0]
  if (!imgPath) {
    return { status: 502, body: { error: '生成失败：结果为空' }, metadata }
  }
  onProgress?.({ stage: 'download', progress: 95 })
  const buf = await mivoPlatformDownloadImage(ctx, imgPath, signal)
  onProgress?.({ stage: 'done', progress: 100 })
  return { status: 200, body: { images: [{ b64: buf.toString('base64') }] }, metadata }
}

// Platform image job runner: submit + poll + download + normalize {images:[{b64}]}.
// Returns a structured result; the Hono handler maps it to c.json(body, status).
// Abort (client disconnect) → {aborted:true}; faithful to dev's writableEnded guard
// (handler returns 499 into the void — client is already gone).
export const runMivoPlatformImageJob = async (
  ctx: PlatformCtx,
  params: PlatformJobParams,
  signal?: AbortSignal,
  onProgress?: OnProgress,
): Promise<PlatformJobResult> => {
  const resolution = String(params.payload.resolution || '1K')
  let metadata: PlatformJobMetadata = { resolution }
  return withPlatformTransientRetry('image-job', signal, async () => {
    try {
      metadata = {
        resolution,
        pollDeadlineMs: resolveMivoPlatformPollDeadlineMs(params.payload.resolution),
      }
      return await runMivoPlatformImageJobOnce(ctx, params, signal, onProgress, metadata)
    } catch (error) {
      if (signal?.aborted) return { aborted: true as const }
      if (isRetriablePlatformError(error)) throw error
      return {
        status: 502 as const,
        body: { error: sanitizePlatformError(error instanceof Error ? error.message : '生成失败') },
        metadata,
      }
    }
  }).catch((error) => {
    if (signal?.aborted) return { aborted: true as const }
    return {
      status: 502 as const,
      body: { error: sanitizePlatformError(error instanceof Error ? error.message : '生成失败') },
      metadata,
    }
  })
}
