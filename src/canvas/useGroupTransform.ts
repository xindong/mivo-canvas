import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  createGroupResizeState,
  resizeGroupSelection,
  type GroupResizeState,
  type Viewport,
} from './canvasInteraction'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'
import {
  smartSelectionGapFor,
  smartSelectionLayoutFor,
  smartSelectionSpacingUpdates,
  type SmartSelectionHandle,
  type SmartSelectionSpacingDragState,
} from './smartSelection'
import { isNodeEffectivelyLocked } from './useNodeTransform'

type UseGroupTransformOptions = {
  selectedBounds: { x: number; y: number; width: number; height: number } | undefined
  selectedNodes: MivoCanvasNode[]
  nodes: MivoCanvasNode[]
  viewportRef: RefObject<Viewport>
  startInteraction: () => void
  captureHistory: () => void
  updateNodesGeometry: (updates: Array<{ id: string; x: number; y: number; width: number; height: number }>) => void
  setSnapGuides: (guides: SnapGuide[]) => void
}

// Group resize + selection-spacing drag. The two refs MUST live in the same hook:
// beginGroupResize clears selectionSpacingDragRef and beginSelectionSpacingDrag
// clears groupResizeRef (互清 / mutual-clear). Splitting them across hooks would
// turn that mutual-clear into hidden cross-hook coupling. Extracted from
// useCanvasInteractionController (F7 node-transform gap: 组缩放 + spacing).
export function useGroupTransform({
  selectedBounds,
  selectedNodes,
  nodes,
  viewportRef,
  startInteraction,
  captureHistory,
  updateNodesGeometry,
  setSnapGuides,
}: UseGroupTransformOptions) {
  const groupResizeRef = useRef<GroupResizeState | null>(null)
  const selectionSpacingDragRef = useRef<SmartSelectionSpacingDragState | null>(null)

  const beginGroupResize = useCallback(
    (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !selectedBounds || selectedNodes.length < 2) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()
      // 互清: starting a group resize cancels any in-flight spacing drag.
      selectionSpacingDragRef.current = null
      captureHistory()

      groupResizeRef.current = createGroupResizeState(
        event.pointerId,
        corner,
        event.clientX,
        event.clientY,
        selectedBounds,
        selectedNodes,
      )
    },
    [captureHistory, selectedBounds, selectedNodes, startInteraction],
  )

  const beginSelectionSpacingDrag = useCallback(
    (handle: SmartSelectionHandle, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return

      const startLayout = smartSelectionLayoutFor(selectedNodes, {
        isEffectivelyLocked: (node) => isNodeEffectivelyLocked(node, nodes),
      })
      if (!startLayout) return
      const startGap = smartSelectionGapFor(startLayout, handle.axis, handle.index)
      if (startGap < 0) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()
      // 互清: starting a spacing drag cancels any in-flight group resize.
      groupResizeRef.current = null
      captureHistory()

      selectionSpacingDragRef.current = {
        pointerId: event.pointerId,
        axis: handle.axis,
        index: handle.index,
        layoutKind: startLayout.kind,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startGap,
        startLayout,
      }
    },
    [captureHistory, nodes, selectedNodes, startInteraction],
  )

  // Dispatcher (handleCanvasPointerMove) branches.
  const tryMoveGroupResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const groupResize = groupResizeRef.current
      if (groupResize?.pointerId !== event.pointerId) return false
      updateNodesGeometry(
        resizeGroupSelection(groupResize, event.clientX, event.clientY, viewportRef.current.scale, {
          centered: event.altKey,
        }).updates,
      )
      return true
    },
    [updateNodesGeometry, viewportRef],
  )

  const tryMoveSpacing = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const drag = selectionSpacingDragRef.current
      if (drag?.pointerId !== event.pointerId) return false
      const { updates } = smartSelectionSpacingUpdates(
        drag,
        event.clientX,
        event.clientY,
        viewportRef.current.scale,
      )
      updateNodesGeometry(updates)
      return true
    },
    [updateNodesGeometry, viewportRef],
  )

  // Dispatcher (handleCanvasPointerEnd) branches.
  const tryEndGroupResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (groupResizeRef.current?.pointerId === event.pointerId) {
        groupResizeRef.current = null
        setSnapGuides([])
      }
    },
    [setSnapGuides],
  )

  const tryEndSpacing = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (selectionSpacingDragRef.current?.pointerId === event.pointerId) {
      selectionSpacingDragRef.current = null
    }
  }, [])

  // Scene reset / Escape / window blur.
  const resetGroupTransform = useCallback(() => {
    groupResizeRef.current = null
    selectionSpacingDragRef.current = null
  }, [])

  return {
    beginGroupResize,
    beginSelectionSpacingDrag,
    tryMoveGroupResize,
    tryMoveSpacing,
    tryEndGroupResize,
    tryEndSpacing,
    resetGroupTransform,
  }
}
