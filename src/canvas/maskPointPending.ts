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
