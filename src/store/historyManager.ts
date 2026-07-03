import type { CanvasEdge, CanvasTask, MivoCanvasNode, MivoCanvasSnapshot } from '../types/mivoCanvas'
import { normalizeCanvasSnapshotV2 } from '../model/canvasSnapshotModel'

/**
 * historyManager — pure functions for the canvas undo/redo history stack.
 *
 * These were extracted from canvasStore.ts (P0-b of the productization roadmap) so the
 * snapshot push / undo / redo / 60-item trimming logic can be unit-tested in isolation.
 * canvasStore injects its own deep-clone helpers (cloneNode/cloneEdge/cloneTask) via
 * {@link HistoryCloneFns}; this keeps the module free of any canvasStore import (no
 * runtime cycle) and makes it trivially testable with stub cloners.
 *
 * Behavior is identical to the prior inline implementation — only the location changed.
 */

export const HISTORY_LIMIT = 60

/** Deep-clone helpers injected by the caller. Kept as a parameter so this module stays pure. */
export type HistoryCloneFns = {
  cloneNode: (node: MivoCanvasNode) => MivoCanvasNode
  cloneEdge: (edge: CanvasEdge) => CanvasEdge
  cloneTask: (task: CanvasTask) => CanvasTask
}

/** The slice of canvas state needed to build or advance a history snapshot. */
export type HistorySnapshotSource = {
  sceneId: MivoCanvasSnapshot['sceneId']
  nodes: MivoCanvasNode[]
  edges: CanvasEdge[]
  tasks: CanvasTask[]
  selectedNodeId?: string | undefined
  selectedNodeIds: string[]
}

/** The two history stacks that advance together on every push/undo/redo. */
export type HistoryStacks = {
  historyPast: MivoCanvasSnapshot[]
  historyFuture: MivoCanvasSnapshot[]
}

/**
 * Build a deep-cloned v2 snapshot of the current state. The clone is essential: the
 * snapshot is stored in history and must not be mutated by later live-state edits.
 */
export const snapshotFromState = (
  state: HistorySnapshotSource,
  cloneFns: HistoryCloneFns,
): MivoCanvasSnapshot =>
  normalizeCanvasSnapshotV2({
    version: 2,
    sceneId: state.sceneId,
    nodes: state.nodes.map(cloneFns.cloneNode),
    edges: (state.edges || []).map(cloneFns.cloneEdge),
    tasks: state.tasks.map(cloneFns.cloneTask),
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: [...state.selectedNodeIds],
  })

/**
 * Push the current state onto the undo stack and clear the redo stack.
 * Trims the undo stack to the last {@link HISTORY_LIMIT} - 1 entries plus the new one.
 */
export const pushHistory = (
  state: HistorySnapshotSource & HistoryStacks,
  cloneFns: HistoryCloneFns,
): HistoryStacks => ({
  historyPast: [...state.historyPast.slice(-(HISTORY_LIMIT - 1)), snapshotFromState(state, cloneFns)],
  historyFuture: [],
})

/**
 * Undo: pop the last past snapshot. Returns the snapshot to apply plus the new stacks,
 * or `null` when there is nothing to undo (boundary).
 */
export const undoHistory = (
  state: HistorySnapshotSource & HistoryStacks,
  cloneFns: HistoryCloneFns,
): { snapshotToApply: MivoCanvasSnapshot } & HistoryStacks | null => {
  const previous = state.historyPast.at(-1)
  if (!previous) return null

  return {
    snapshotToApply: previous,
    historyPast: state.historyPast.slice(0, -1),
    historyFuture: [snapshotFromState(state, cloneFns), ...state.historyFuture.slice(0, HISTORY_LIMIT - 1)],
  }
}

/**
 * Redo: shift the first future snapshot. Returns the snapshot to apply plus the new
 * stacks, or `null` when there is nothing to redo (boundary).
 */
export const redoHistory = (
  state: HistorySnapshotSource & HistoryStacks,
  cloneFns: HistoryCloneFns,
): { snapshotToApply: MivoCanvasSnapshot } & HistoryStacks | null => {
  const next = state.historyFuture[0]
  if (!next) return null

  return {
    snapshotToApply: next,
    historyPast: [...state.historyPast.slice(-(HISTORY_LIMIT - 1)), snapshotFromState(state, cloneFns)],
    historyFuture: state.historyFuture.slice(1),
  }
}
