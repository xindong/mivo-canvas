export type MaskInitialClientPoint = {
  nodeId: string
  clientX: number
  clientY: number
}

export type MaskPointPendingAction =
  | { type: 'set'; point: MaskInitialClientPoint }
  | { type: 'consume'; nodeId: string }
  | { type: 'discard-stale'; nodeId: string }
  | { type: 'clear' }

export const reduceMaskPointPending = (
  current: MaskInitialClientPoint | undefined,
  action: MaskPointPendingAction,
): MaskInitialClientPoint | undefined => {
  if (action.type === 'set') return action.point
  if (!current) return undefined
  if (action.type === 'consume') return current.nodeId === action.nodeId ? undefined : current
  if (action.type === 'discard-stale') return current.nodeId === action.nodeId ? current : undefined
  return undefined
}

// W5 (QoL batch): during the overlay-mounting window (maskEditNodeId set but the
// overlay's naturalSize not yet ready), a pointerdown on a different node or blank
// canvas should cancel the pending mask edit so the late-arriving overlay doesn't
// pop up over the new selection. clickedNodeId=undefined means blank canvas.
// Returns false when the click is on the mask-edit target itself (re-engage, keep).
export const shouldCancelPendingMaskEdit = (
  maskEditNodeId: string | undefined,
  clickedNodeId: string | undefined,
): boolean => {
  if (!maskEditNodeId) return false
  return clickedNodeId !== maskEditNodeId
}
