import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { importedImageDisplaySize } from '../lib/imageSizing'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { canvasPersistOptions } from './canvasPersistConfig'
import { debugLogger } from './debugLogStore'
import { scenes } from './demoScenes'
import type { CommittedGenerationImage } from '../types/generation'
import { createDocumentSlice } from './documentSlice'
import { createNodeMutationSlice } from './nodeMutationSlice'
import { createNodeCreationSlice } from './nodeCreationSlice'
import { createGenerationSlice } from './generationSlice'
import { createSelectionSlice } from './selectionSlice'
import { createProjectsSlice } from './projectsSlice'
import { migratePersistedState } from './canvasGenerationHydration'

// 纯类型声明外提到 canvasStateTypes(结构守卫 facade 零增长)。下游
// `import type { CanvasState, SliceCreator, ... } from './canvasStore'` 路径零改动。
export type {
  CanvasState,
  SelectionAlignment,
  DistributionAxis,
  CanvasGenerationOptions,
  SelectionArrangeMode,
  BrushStyle,
  SliceCreator,
} from './canvasStateTypes'
import type { CanvasState } from './canvasStateTypes'

export { scenes }
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



// migratePersistedState lives in canvasGenerationHydration.ts (co-located with
// settleExpiredCanvasGenerations / mergeCanvasPersistedState — all version-gated
// hydration logic). Re-exported here so canvasStoreMigrate.test.ts and the
// persist `migrate` option can keep importing it from the store facade.
export { migratePersistedState }

export const logCanvas = (message: string) => debugLogger.log('Canvas Store', message)
export const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)
export const errorCanvas = (message: string) => debugLogger.error('Canvas Store', message)

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      ...createProjectsSlice(set, get),
      ...createDocumentSlice(set, get),
      ...createNodeMutationSlice(set, get),
      ...createNodeCreationSlice(set, get),
      ...createGenerationSlice(set, get),
      ...createSelectionSlice(set, get),
    }) as CanvasState,
    canvasPersistOptions,
  ),
)
