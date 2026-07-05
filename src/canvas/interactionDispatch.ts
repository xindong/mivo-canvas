import { useCallback, useMemo, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { projectNodes } from '../render/projection'
import { sortForHitTest } from '../render/hitTest'
import {
  resolveCanvasHitAtClientPoint,
  type EditState,
  type HitTestTarget,
  type ViewportLike,
} from '../render/interactionAdapter'
import { shouldStartCanvasSurfaceInteraction } from './canvasInteraction'
import type { CanvasToolHandler, CanvasToolHandlerContext } from './canvasToolHandlers'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// Phase 1b-4: shell-unified hit dispatch. Owns the back-to-front hit-test node
// list, the active edit-state (mask > crop > text-edit), and the resolve/cancel
// helpers the controller's handleCanvasPointerDown + useMaskPointArmed peek.
// Lives outside useCanvasInteractionController so the controller (structure-guard
// whitelisted) stays a thin assembly shell; pure logic here is freely growable.

type UseCanvasHitDispatchOptions = {
  shellRef: RefObject<HTMLElement | null>
  viewport: ViewportLike
  nodes: MivoCanvasNode[]
  selectedNodeIds: string[]
  maskEditNodeId?: string
  cropEditNodeId?: string
  editingTextNodeId?: string
  onCancelMaskEdit?: () => void
  onCancelCropEdit?: () => void
  /** Exit text-edit mode (discard empty text + clear editingTextNodeId). */
  exitTextEdit: () => void
}

export type EditOverlayCancelTarget = Extract<
  HitTestTarget,
  { kind: 'edit-overlay-cancel' }
>

export function useCanvasHitDispatch({
  shellRef,
  viewport,
  nodes,
  selectedNodeIds,
  maskEditNodeId,
  cropEditNodeId,
  editingTextNodeId,
  onCancelMaskEdit,
  onCancelCropEdit,
  exitTextEdit,
}: UseCanvasHitDispatchOptions) {
  // Back-to-front z-order (frame < content < selected-elevated). selectedNodeIds
  // feeds projectNode so .selected mirrors the DOM z-index:20 elevation — without
  // it, a selected node under a non-selected peer would lose the topmost hit.
  const hitTestNodes = useMemo(
    () => sortForHitTest(projectNodes(nodes, { selectedNodeIds: new Set(selectedNodeIds) })),
    [nodes, selectedNodeIds],
  )

  // Active edit overlay owns the pointer (Layer.EditOverlay). mask wins over crop
  // wins over text-edit (only one is active at a time in practice; order is for safety).
  const activeEditState = useMemo<EditState | undefined>(() => {
    if (maskEditNodeId) return { activeEditNodeId: maskEditNodeId, activeEditKind: 'mask' }
    if (cropEditNodeId) return { activeEditNodeId: cropEditNodeId, activeEditKind: 'crop' }
    if (editingTextNodeId) return { activeEditNodeId: editingTextNodeId, activeEditKind: 'text-edit' }
    return undefined
  }, [maskEditNodeId, cropEditNodeId, editingTextNodeId])

  const resolveCanvasHit = useCallback(
    (clientX: number, clientY: number): HitTestTarget | null =>
      resolveCanvasHitAtClientPoint(
        shellRef.current?.getBoundingClientRect(),
        viewport,
        hitTestNodes,
        clientX,
        clientY,
        { editState: activeEditState },
      ),
    [activeEditState, hitTestNodes, shellRef, viewport],
  )

  const cancelEditTarget = useCallback(
    (target: EditOverlayCancelTarget) => {
      if (target.editKind === 'mask') onCancelMaskEdit?.()
      else if (target.editKind === 'crop') onCancelCropEdit?.()
      else if (target.editKind === 'text-edit') exitTextEdit()
    },
    [onCancelMaskEdit, onCancelCropEdit, exitTextEdit],
  )

  // Phase 1b-4 shell dispatch: UI skip → resolve → cancel/node/anchor/blank.
  // handler + ctx are passed in (controller owns activeToolHandler/toolHandlerContext)
  // so this useCallback stays stable across tool/selection changes.
  const dispatchPointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      handler: CanvasToolHandler,
      ctx: CanvasToolHandlerContext,
    ) => {
      if (!shouldStartCanvasSurfaceInteraction(event.target)) return
      const target = resolveCanvasHit(event.clientX, event.clientY)
      if (!target) { handler.onCanvasPointerDown(event, ctx); return }
      if (target.kind === 'edit-overlay-cancel') { cancelEditTarget(target); return }
      if (target.kind === 'anchor') return // AnchorOverlay self-manages
      handler.onNodePointerDown(target.nodeId, event, ctx)
    },
    [cancelEditTarget, resolveCanvasHit],
  )

  return { hitTestNodes, activeEditState, resolveCanvasHit, cancelEditTarget, dispatchPointerDown }
}
