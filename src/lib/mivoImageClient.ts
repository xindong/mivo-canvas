import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { MivoEditRequest, MivoGenerateRequest, MivoImageResponse } from '../types/generation'
import { readImportedAssetFile } from './assetStorage'

const defaultModel = 'gpt-image-2'

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
  if (!Array.isArray(response.images) || !response.images.every((image) => typeof image.b64 === 'string')) {
    throw new Error('Image service returned an invalid response')
  }
  return response
}

const fileNameForBlob = (blob: Blob, fallback: string) =>
  blob instanceof File && blob.name ? blob.name : fallback

export const generateMivoImage = async (request: MivoGenerateRequest) => {
  const response = await fetch('/api/mivo/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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

  const response = await fetch('/api/mivo/edit', {
    method: 'POST',
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
