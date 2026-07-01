import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { MivoEditRequest, MivoGenerateRequest, MivoImageResponse } from '../types/generation'
import { readImportedAssetFile } from './assetStorage'

const defaultModel = 'gpt-image-2'
const mivoRequestTimeoutMs = 110_000

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

const fetchMivoWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const controller = new AbortController()
  let timedOut = false
  const parentSignal = init.signal
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, mivoRequestTimeoutMs)
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
      throw new Error(timedOut ? '图片请求超时，请重试。' : '图片请求已取消。')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

const readMivoError = async (response: Response) => {
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

  if (!response.ok) throw new Error(await readMivoError(response))
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

  const response = await fetchMivoWithTimeout('/api/mivo/edit', {
    method: 'POST',
    signal: request.signal,
    body: formData,
  })

  if (!response.ok) throw new Error(await readMivoError(response))
  return validateMivoImageResponse(await response.json())
}

export const assetBlobForNode = async (node: MivoCanvasNode) => {
  if (!node.assetUrl) throw new Error('Unable to read source image for generation')

  const importedAsset = await readImportedAssetFile(node.assetUrl)
  if (importedAsset) return importedAsset.blob

  const response = await fetch(node.assetUrl)
  if (!response.ok) throw new Error('Unable to read source image for generation')
  return response.blob()
}
