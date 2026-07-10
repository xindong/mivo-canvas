// canvasPersistConfig — persist options for useCanvasStore, extracted (FU4-2) so
// wiring IDB storage + skipHydration doesn't grow the structure-guard white-listed
// canvasStore.ts facade. migrate/merge semantics are unchanged from the pre-FU4-2
// inline config; only `storage` (localStorage → IDB) and `skipHydration` (defer to
// the App-layer hydration gate) are new.
import { createJSONStorage } from 'zustand/middleware'
import { idbStateStorage } from '../lib/persistIdbStorage'
import { compactCanvasesForPersist } from './canvasDocumentModel'
import { CANVAS_PERSIST_VERSION, mergeCanvasPersistedState, migratePersistedState } from './canvasGenerationHydration'
import { debugLogger } from './debugLogStore'
import { isLegacyKernel } from '../app/kernelMode'
import { docKernelPersistStorage } from '../kernel/docKernelPersistAdapter'
import type { CanvasState } from './canvasStore'

// Local warn — identical to canvasStore's exported warnCanvas. Duplicated (not
// imported) to avoid a runtime circular import: canvasStore imports this module
// for the options, so this module must not import canvasStore for a value.
const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)

export const canvasPersistOptions = {
  name: 'mivo-canvas-demo',
  version: CANVAS_PERSIST_VERSION,
  // FU4-2: persist to IndexedDB (10k+ node snapshots exceed localStorage's ~5MB
  // quota). skipHydration defers rehydrate to the App-layer hydration gate so the
  // first paint is the real state, not a demo-seed flash. migrate/merge unchanged.
  // T1.2 S6b:?kernel=new 时 persist storage 切 DocKernel-backed adapter(读写 document+session
  // 三域 canonical,Lead ① persist backend,setters 不动);?kernel=legacy(默认)仍 idbStateStorage
  // (single blob,legacy 零变化 §8)。isLegacyKernel 模块常量(生命周期内不变)。
  storage: createJSONStorage(() => (isLegacyKernel ? idbStateStorage : docKernelPersistStorage)),
  skipHydration: true,
  migrate: migratePersistedState,
  merge: (persistedState: unknown, currentState: CanvasState) =>
    mergeCanvasPersistedState(persistedState, currentState, migratePersistedState, warnCanvas),
  partialize: (state: CanvasState) => ({
    canvases: compactCanvasesForPersist(state.canvases),
    projects: state.projects,
    sceneId: state.sceneId,
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: state.selectedNodeIds,
    activeTool: state.activeTool,
    brushStyle: state.brushStyle,
    activeStampKind: state.activeStampKind,
  }),
}
