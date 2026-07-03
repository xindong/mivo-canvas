import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { eraserHitStrokeIds, eraserScreenRadius } from './brushGeometry'
import { stampGrowthIntervalMs, stampGrowthSizes } from './stampDefs'
import { isNodeEffectivelyLocked } from './useNodeTransform'
import type { SnapGuide } from './canvasGeometry'
import type { Viewport } from './canvasInteraction'

type UseBrushStampOptions = {
  screenToCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  viewportRef: RefObject<Viewport>
  onCloseContextMenu: () => void
  discardEmptyEditingText: (nodeId?: string) => void
  setEditingTextNodeId: (id: string | undefined) => void
  setSnapGuides: (guides: SnapGuide[]) => void
  clearSelection: () => void
}

// Eraser drag + stamp placement. Extracted from useCanvasInteractionController
// (F7 brush/stamp gap). Pure extraction; behavior identical to inline logic.
export function useBrushStamp({
  screenToCanvas,
  viewportRef,
  onCloseContextMenu,
  discardEmptyEditingText,
  setEditingTextNodeId,
  setSnapGuides,
  clearSelection,
}: UseBrushStampOptions) {
  const eraserDragRef = useRef<{ pointerId: number; historyCaptured: boolean } | null>(null)
  const stampPlacementRef = useRef<{ pointerId: number; stage: number; growTimer: number } | null>(null)
  const [stampPlacementPreview, setStampPlacementPreview] = useState<{
    x: number
    y: number
    stage: number
  } | null>(null)

  const eraseAtClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const drag = eraserDragRef.current
      if (!drag) return

      const point = screenToCanvas(clientX, clientY)
      const state = useCanvasStore.getState()
      const radius = eraserScreenRadius / viewportRef.current.scale
      const candidates = state.nodes.filter((node) => !isNodeEffectivelyLocked(node, state.nodes))
      const hits = eraserHitStrokeIds(candidates, point, radius)
      if (!hits.length) return

      if (!drag.historyCaptured) {
        state.captureHistory()
        drag.historyCaptured = true
      }
      state.eraseMarkupStrokes(hits)
    },
    [screenToCanvas, viewportRef],
  )

  // Entry from useTextAnnotation.beginMarkupBox when the active brush is the eraser.
  // Sets up the eraser drag ref and erases at the initial point.
  const beginEraserDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      eraserDragRef.current = { pointerId: event.pointerId, historyCaptured: false }
      eraseAtClientPoint(event.clientX, event.clientY)
    },
    [eraseAtClientPoint],
  )

  const clearStampPlacement = useCallback(() => {
    const placement = stampPlacementRef.current
    if (!placement) return

    window.clearInterval(placement.growTimer)
    stampPlacementRef.current = null
    setStampPlacementPreview(null)
  }, [])

  const beginStampPlacement = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      clearSelection()

      const point = screenToCanvas(event.clientX, event.clientY)
      // FigJam-style press-and-hold: the held stamp wiggles and grows through four stages.
      const growTimer = window.setInterval(() => {
        const placement = stampPlacementRef.current
        if (!placement || placement.stage >= stampGrowthSizes.length - 1) return

        placement.stage += 1
        setStampPlacementPreview((current) => (current ? { ...current, stage: placement.stage } : current))
      }, stampGrowthIntervalMs)
      stampPlacementRef.current = { pointerId: event.pointerId, stage: 0, growTimer }
      setStampPlacementPreview({ x: point.x, y: point.y, stage: 0 })
    },
    [clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas, setEditingTextNodeId, setSnapGuides],
  )

  // Dispatcher (handleCanvasPointerMove) branches.
  const tryMoveEraser = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (eraserDragRef.current?.pointerId !== event.pointerId) return false
      eraseAtClientPoint(event.clientX, event.clientY)
      return true
    },
    [eraseAtClientPoint],
  )

  const tryMoveStamp = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const placement = stampPlacementRef.current
      if (placement?.pointerId !== event.pointerId) return false
      const point = screenToCanvas(event.clientX, event.clientY)
      setStampPlacementPreview({ x: point.x, y: point.y, stage: placement.stage })
      return true
    },
    [screenToCanvas],
  )

  // Dispatcher (handleCanvasPointerEnd) branches.
  const tryEndEraser = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (eraserDragRef.current?.pointerId === event.pointerId) {
      eraserDragRef.current = null
    }
  }, [])

  const tryEndStamp = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (stampPlacementRef.current?.pointerId !== event.pointerId) return
      if (event.type === 'pointerup') {
        const placement = stampPlacementRef.current
        const point = screenToCanvas(event.clientX, event.clientY)
        const size = stampGrowthSizes[placement.stage]
        const store = useCanvasStore.getState()
        const placedStampId = store.addMarkupNode(
          'stamp',
          { x: point.x - size / 2, y: point.y - size / 2 },
          { width: size, height: size },
          { stampKind: store.activeStampKind, select: false },
        )
        store.noteStampPlaced(placedStampId)
      }
      // Stamp stays active for continuous stamping (FigJam convention); Esc or V exits.
      clearStampPlacement()
    },
    [clearStampPlacement, screenToCanvas],
  )

  // Scene reset / Escape / window blur.
  const resetBrushStamp = useCallback(() => {
    eraserDragRef.current = null
    if (stampPlacementRef.current) {
      window.clearInterval(stampPlacementRef.current.growTimer)
      stampPlacementRef.current = null
    }
    setStampPlacementPreview(null)
  }, [])

  return {
    stampPlacementPreview,
    beginStampPlacement,
    beginEraserDrag,
    tryMoveEraser,
    tryMoveStamp,
    tryEndEraser,
    tryEndStamp,
    resetBrushStamp,
  }
}
