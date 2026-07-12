import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { canvasPersistOptions } from './canvasPersistConfig'
import { scenes } from './demoScenes'
import { createDocumentSlice } from './documentSlice'
import { createNodeMutationSlice } from './nodeMutationSlice'
import { createNodeCreationSlice } from './nodeCreationSlice'
import { createGenerationSlice } from './generationSlice'
import { createSelectionSlice } from './selectionSlice'
import { createProjectsSlice } from './projectsSlice'
import { migratePersistedState } from './canvasGenerationHydration'

// 纯类型声明:类型本体在 canvasStateTypes(结构守卫 facade 零增长)。slice 侧已改
// `import type { SliceCreator } from './canvasStateTypes'` 直连(切断 slice↔facade 边);
// facade 仍 re-export 供其它非 slice consumer。
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

// 日志 + 图像资产工具(blob/displaySize/log*)外提到 canvasStoreLog(D-4: 切断
// slice↔facade value-import 环;slice 改从 canvasStoreLog 直连,facade 仅 re-export
// 保非 slice consumer 零改动)。零行为变化:实现原样搬迁,见 canvasStoreLog.ts。
export {
  blobFromCommittedGenerationImage,
  displaySizeForGeneratedAsset,
  type GeneratedAssetRecord,
  logCanvas,
  warnCanvas,
  errorCanvas,
} from './canvasStoreLog'

export { scenes }

// migratePersistedState lives in canvasGenerationHydration.ts (co-located with
// settleExpiredCanvasGenerations / mergeCanvasPersistedState — all version-gated
// hydration logic). Re-exported here so canvasStoreMigrate.test.ts and the
// persist `migrate` option can keep importing it from the store facade.
export { migratePersistedState }

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
