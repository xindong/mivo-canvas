// canvasPersistConfig — persist options for useCanvasStore, extracted (FU4-2) so
// wiring IDB storage + skipHydration doesn't grow the structure-guard white-listed
// canvasStore.ts facade. migrate/merge semantics are unchanged from the pre-FU4-2
// inline config; only `storage` (localStorage → IDB) and `skipHydration` (defer to
// the App-layer hydration gate) are new.
import { createJSONStorage } from 'zustand/middleware'
import { idbStateStorage } from '../lib/persistIdbStorage'
import { compactCanvasesForPersist } from './canvasDocumentModel'
import { mergeCanvasPersistedState, migratePersistedState } from './canvasGenerationHydration'
import { debugLogger } from './debugLogStore'
import type { CanvasState } from './canvasStore'

// Local warn — identical to canvasStore's exported warnCanvas. Duplicated (not
// imported) to avoid a runtime circular import: canvasStore imports this module
// for the options, so this module must not import canvasStore for a value.
const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)

export const canvasPersistOptions = {
  name: 'mivo-canvas-demo',
  version: 9,
  // FU4-2: persist to IndexedDB (10k+ node snapshots exceed localStorage's ~5MB
  // quota). skipHydration defers rehydrate to the App-layer hydration gate so the
  // first paint is the real state, not a demo-seed flash. migrate/merge unchanged.
  storage: createJSONStorage(() => idbStateStorage),
  skipHydration: true,
  migrate: migratePersistedState,
  merge: (persistedState: unknown, currentState: CanvasState) =>
    mergeCanvasPersistedState(persistedState, currentState, migratePersistedState, warnCanvas),
  partialize: (state: CanvasState) => ({
    canvases: compactCanvasesForPersist(state.canvases),
    sceneId: state.sceneId,
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: state.selectedNodeIds,
    activeTool: state.activeTool,
    brushStyle: state.brushStyle,
    activeStampKind: state.activeStampKind,
  }),
}
