import type { CanvasDocument, CanvasId } from '../types/mivoCanvas'

export type ActiveCanvasResolution =
  | { kind: 'keep'; sceneId: CanvasId }
  | { kind: 'switch'; sceneId: CanvasId }
  | { kind: 'blocked' }

const firstActiveCanvasId = (
  canvases: Record<CanvasId, CanvasDocument>,
): CanvasId | undefined => Object.keys(canvases).find((id) => canvases[id]?.status !== 'archived')

/**
 * Delete keeps the ≥1-canvas invariant, but should prefer an editable survivor over an
 * archived one. Only fall back to insertion-order first when every survivor is archived.
 */
export const findPreferredCanvasSurvivorId = (
  canvases: Record<CanvasId, CanvasDocument>,
): CanvasId | undefined => firstActiveCanvasId(canvases) ?? Object.keys(canvases)[0]

/**
 * Resolve the active scene against an archive operation's next-state canvases.
 * Archive is only safe when at least one active canvas remains. A missing or
 * archived scene is reconciled to that survivor; no synthetic document is made.
 */
export const resolveActiveCanvasAfterArchive = (
  canvases: Record<CanvasId, CanvasDocument>,
  sceneId: CanvasId,
): ActiveCanvasResolution => {
  const current = canvases[sceneId]
  if (current !== undefined && current.status !== 'archived') {
    return { kind: 'keep', sceneId }
  }

  const survivorId = firstActiveCanvasId(canvases)
  return survivorId === undefined
    ? { kind: 'blocked' }
    : { kind: 'switch', sceneId: survivorId }
}
