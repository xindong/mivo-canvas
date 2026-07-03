// server/lib/images.ts
// Image response normalization + ratio/quality helpers ported from vite.config.ts.
import {
  mivoModelRatioMap,
  mivoModelDefaultRatio,
  mivoImageSizeMap,
  mivoQualitySet,
  type MivoImageRatio,
  type MivoImageQuality,
  type MivoImageResponse,
} from './config'

export const normalizeMivoQuality = (quality: unknown): MivoImageQuality => {
  const value = typeof quality === 'string' && mivoQualitySet.has(quality) ? quality : 'medium'
  return value as MivoImageQuality
}

// B1: model-specific ratio payload — gemini uses aspect_ratio, gpt uses size
export const resolveRatioPayload = (
  modelId: string,
  imgRatio: unknown,
  quality: string,
): Record<string, string> => {
  const allowedRatios = mivoModelRatioMap[modelId] ?? mivoModelRatioMap['gpt-image-2']
  const defaultRatio = mivoModelDefaultRatio[modelId] ?? '1:1'
  const rawRatio = typeof imgRatio === 'string' ? imgRatio : defaultRatio
  const clampedRatio = (allowedRatios as string[]).includes(rawRatio) ? rawRatio : defaultRatio
  if (modelId === 'gemini-3-pro-image') {
    return { aspect_ratio: clampedRatio }
  }
  const gptRatio: MivoImageRatio = clampedRatio in mivoImageSizeMap ? (clampedRatio as MivoImageRatio) : '1:1'
  return { size: mivoImageSizeMap[gptRatio][normalizeMivoQuality(quality)] }
}

export const normalizeMivoImages = (payload: unknown): MivoImageResponse => {
  const maybePayload = payload as {
    data?: Array<{ b64_json?: unknown }>
    images?: Array<{ b64?: unknown }>
  }
  const images = (maybePayload.data || [])
    .map((item) => (typeof item.b64_json === 'string' && item.b64_json.trim() ? { b64: item.b64_json } : undefined))
    .filter((item): item is { b64: string } => Boolean(item))

  if (!images.length && maybePayload.images) {
    images.push(
      ...maybePayload.images
        .map((item) => (typeof item.b64 === 'string' && item.b64.trim() ? { b64: item.b64 } : undefined))
        .filter((item): item is { b64: string } => Boolean(item)),
    )
  }

  if (!images.length) throw new Error('Image API returned no images')
  return { images }
}
