import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { EnhanceRequest, EnhanceResponse, MivoEditRequest, MivoGenerateRequest, MivoImageQuality, MivoImageResponse } from '../types/generation'
import { debugLogger } from '../store/debugLogStore'
import { readImportedAssetFile } from './assetStorage'

const defaultModel = 'gpt-image-2'
const mivoRequestTimeoutMs = 310_000
const mivoEditRequestTimeoutMs = 185_000
const mivoEnhanceTimeoutMs = 30_000

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

export type MivoImageRequestErrorKind = 'client-timeout' | 'upstream-timeout' | 'canceled' | 'upstream-error'

export class MivoImageRequestError extends Error {
  kind: MivoImageRequestErrorKind

  constructor(message: string, kind: MivoImageRequestErrorKind, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MivoImageRequestError'
    this.kind = kind
  }
}

// 审查 B（Step 4b）：超时文案按 effective quality 条件化——high(2K) 才建议降质，
// medium/low(1K) 不再误导"降低质量"，改为"稍后重试、换比例或减少参考图"
const timeoutAdviceForQuality = (quality?: MivoImageQuality) =>
  quality === 'high' ? '可降低质量重试' : '可稍后重试、换比例或减少参考图'

export const mivoClientTimeoutMessageFor = (quality?: MivoImageQuality) =>
  `等待超时，结果可能仍在生成，${timeoutAdviceForQuality(quality)}`

export const mivoUpstreamTimeoutMessageFor = (quality?: MivoImageQuality) =>
  `上游生成超时，${timeoutAdviceForQuality(quality)}`

export const mivoUpstreamTemporaryFailureMessage = '上游服务临时失败，请重试'
export const mivoUpstreamSafetyFailureMessage = '内容被上游安全系统拦截，可尝试修改描述后重试'

const safetyFailurePattern =
  /safety|content policy|policy violation|moderation|blocked|unsafe|refused|sensitive|内容安全|安全策略|安全系统|违规|不合规|敏感/i
const upstream5xxFailurePattern = /ClosedChannelException|java\.[\w.]+Exception|Upstream error \((5\d\d)\)|\b5\d\d\b/i

export const formatMivoClientError = (status: number | undefined, rawMessage: string, source = 'Mivo Image') => {
  const normalizedRaw = rawMessage.trim() || 'Image request failed'
  let message = normalizedRaw
  if ((status === 400 || status === undefined) && safetyFailurePattern.test(normalizedRaw)) {
    message = mivoUpstreamSafetyFailureMessage
  } else if (
    status !== 504 &&
    ((status !== undefined && status >= 500 && status < 600) || upstream5xxFailurePattern.test(normalizedRaw))
  ) {
    message = mivoUpstreamTemporaryFailureMessage
  }
  if (message !== normalizedRaw) {
    const statusPart = status !== undefined ? `status=${status}` : 'status=unknown'
    debugLogger.error(source, `Raw upstream image error (${statusPart}): ${normalizedRaw}`)
  }
  return message
}

const fetchMivoWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = mivoRequestTimeoutMs,
  quality?: MivoImageQuality,
) => {
  const controller = new AbortController()
  let timedOut = false
  const parentSignal = init.signal
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromParent = () => controller.abort()

  if (parentSignal?.aborted) {
    controller.abort()
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new MivoImageRequestError(
        timedOut ? mivoClientTimeoutMessageFor(quality) : '图片请求已取消。',
        timedOut ? 'client-timeout' : 'canceled',
        { cause: error },
      )
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

const readMivoError = async (response: Response, quality?: MivoImageQuality) => {
  if (response.status === 504) return mivoUpstreamTimeoutMessageFor(quality)

  let rawMessage = `${response.status} ${response.statusText}`
  try {
    const payload = (await response.json()) as { error?: string; message?: string }
    rawMessage = payload.error || payload.message || rawMessage
  } catch {
    // Keep the status text fallback.
  }
  return formatMivoClientError(response.status, rawMessage)
}

const validateMivoImageResponse = (payload: unknown): MivoImageResponse => {
  const response = payload as MivoImageResponse
  if (
    !Array.isArray(response.images) ||
    !response.images.every((image) => typeof image.b64 === 'string' && image.b64.trim().length > 0)
  ) {
    throw new Error('Image service returned an invalid response')
  }
  return response
}

const fileNameForBlob = (blob: Blob, fallback: string) =>
  blob instanceof File && blob.name ? blob.name : fallback

export const generateMivoImage = async (request: MivoGenerateRequest) => {
  const response = await fetchMivoWithTimeout(
    '/api/mivo/generate',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: request.signal,
      body: JSON.stringify({
        prompt: request.prompt,
        imgRatio: request.imgRatio,
        quality: request.quality,
        n: request.n ?? 1,
        model: request.model || defaultModel,
      }),
    },
    mivoRequestTimeoutMs,
    request.quality,
  )

  if (!response.ok) {
    throw new MivoImageRequestError(
      await readMivoError(response, request.quality),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  return validateMivoImageResponse(await response.json())
}

export const editMivoImage = async (request: MivoEditRequest) => {
  const formData = new FormData()
  formData.append('image', request.image, fileNameForBlob(request.image, 'source.png'))
  if (request.mask) formData.append('mask', request.mask, fileNameForBlob(request.mask, 'mask.png'))
  request.reference?.forEach((blob, index) => {
    formData.append('reference[]', blob, fileNameForBlob(blob, `reference-${index + 1}.png`))
  })
  formData.set('prompt', request.prompt)
  formData.set('imgRatio', request.imgRatio || '1:1')
  formData.set('quality', request.quality || 'medium')
  formData.set('model', request.model || defaultModel)

  const response = await fetchMivoWithTimeout(
    '/api/mivo/edit',
    {
      method: 'POST',
      signal: request.signal,
      body: formData,
    },
    mivoEditRequestTimeoutMs,
    request.quality,
  )

  if (!response.ok) {
    throw new MivoImageRequestError(
      await readMivoError(response, request.quality),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  return validateMivoImageResponse(await response.json())
}

export const enhanceMivoPrompt = async (request: EnhanceRequest): Promise<EnhanceResponse> => {
  const { signal, ...body } = request
  try {
    const response = await fetchMivoWithTimeout(
      '/api/mivo/enhance',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body),
      },
      mivoEnhanceTimeoutMs,
    )
    if (!response.ok) return { enhanced: false, degradedReason: 'upstream-error' }
    return (await response.json()) as EnhanceResponse
  } catch {
    return { enhanced: false, degradedReason: 'upstream-error' }
  }
}

export const assetBlobForNode = async (node: MivoCanvasNode) => {
  if (!node.assetUrl) throw new Error('Unable to read source image for generation')

  const importedAsset = await readImportedAssetFile(node.assetUrl)
  if (importedAsset) return importedAsset.blob

  const response = await fetch(node.assetUrl)
  if (!response.ok) throw new Error('Unable to read source image for generation')
  return response.blob()
}
