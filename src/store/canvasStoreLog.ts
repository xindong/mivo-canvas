// src/store/canvasStoreLog.ts
// Canvas store facade 的日志 + 图像资产工具函数(D-4: 切断 slice↔facade value-import 环)。
// 原先这些符号定义在 canvasStore.ts(facade),被 6 个 slice value-import(用于日志/取 blob/
// 算 displaySize),而 canvasStore 反向装配 6 slice → 形成 6 个同步 ESM 环。把它们外提到本
// 独立模块后,slice 改从本模块直连,canvasStore 仅 re-export(非 slice consumer 零改动),
// slice↔facade 不再有 value-import 反向边 → 6 环消除。零行为变化:实现原样搬迁。
//
// 依赖方向:本模块 → debugLogStore / lib(imageSizing,assetStorage) / types;不反向依赖任何 slice
// 或 facade,故不会形成新环。
import { debugLogger } from './debugLogStore'
import { importedImageDisplaySize } from '../lib/imageSizing'
import { saveGeneratedAsset } from '../lib/assetStorage'
import type { CommittedGenerationImage } from '../types/generation'

export const blobFromCommittedGenerationImage = (image: CommittedGenerationImage) => {
  if (image.blob) return image.blob

  const raw = image.b64?.trim() || ''
  if (!raw) throw new Error('Image service returned empty image data')

  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.*)$/)
  const mimeType = image.mimeType || dataUrlMatch?.[1] || 'image/png'
  const base64 = (dataUrlMatch?.[2] || raw).trim()
  if (!base64) throw new Error('Image service returned empty image data')

  let binary: string
  try {
    binary = atob(base64)
  } catch (error) {
    throw new Error('Image service returned invalid image data', { cause: error })
  }
  if (!binary.length) throw new Error('Image service returned empty image data')

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: mimeType })
}

export type GeneratedAssetRecord = Awaited<ReturnType<typeof saveGeneratedAsset>>

export const displaySizeForGeneratedAsset = (
  asset: GeneratedAssetRecord,
  fallbackSize: { width: number; height: number },
) => asset.sourceDimensions ? importedImageDisplaySize(asset.sourceDimensions) : fallbackSize

export const logCanvas = (message: string) => debugLogger.log('Canvas Store', message)
export const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)
export const errorCanvas = (message: string) => debugLogger.error('Canvas Store', message)
