import type { CanvasDocument, CanvasId } from '../types/mivoCanvas'

export type ActiveCanvasResolution =
  | { kind: 'keep'; sceneId: CanvasId }
  | { kind: 'switch'; sceneId: CanvasId }
  | { kind: 'blocked' }

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

  const survivorId = Object.keys(canvases).find((id) => canvases[id]?.status !== 'archived')
  return survivorId === undefined
    ? { kind: 'blocked' }
    : { kind: 'switch', sceneId: survivorId }
}
