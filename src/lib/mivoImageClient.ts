import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { EnhanceRequest, EnhanceResponse, MivoEditRequest, MivoGenerateRequest, MivoImageResponse } from '../types/generation'
import { readImportedAssetFile } from './assetStorage'

const defaultModel = 'gpt-image-2'
const mivoRequestTimeoutMs = 245_000
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

export const mivoClientTimeoutMessage = '等待超时，结果可能仍在生成，可稍后重试或降低质量'
export const mivoUpstreamTimeoutMessage = '上游生成超时，可降低质量重试'

const fetchMivoWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = mivoRequestTimeoutMs) => {
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
        timedOut ? mivoClientTimeoutMessage : '图片请求已取消。',
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

const readMivoError = async (response: Response) => {
  if (response.status === 504) return mivoUpstreamTimeoutMessage

  try {
    const payload = (await response.json()) as { error?: string; message?: string }
    return payload.error || payload.message || `${response.status} ${response.statusText}`
  } catch {
    return `${response.status} ${response.statusText}`
  }
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
  const response = await fetchMivoWithTimeout('/api/mivo/generate', {
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
  })

  if (!response.ok) {
    throw new MivoImageRequestError(
      await readMivoError(response),
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
  )

  if (!response.ok) {
    throw new MivoImageRequestError(
      await readMivoError(response),
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
