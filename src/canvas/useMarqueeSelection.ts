import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  createSelectionBox,
  selectedIdsFromSelectionBox,
  type SelectionBox,
} from './canvasInteraction'

type UseMarqueeSelectionOptions = {
  screenToCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  startInteraction: () => void
  selectNode: (id: string | undefined, options?: { additive?: boolean }) => void
  selectNodes: (ids: string[], focusId?: string) => void
  nodes: MivoCanvasNode[]
  selectedNodeIds: string[]
}

// Marquee selection box state + begin/finish/clear + dispatcher branches.
// Extracted from useCanvasInteractionController (F7 marquee gap). Pure extraction;
// the 6-call interaction cleanup is delegated to `startInteraction` (behavior
// identical — same calls, same order, React-batched).
export function useMarqueeSelection({
  screenToCanvas,
  startInteraction,
  selectNode,
  selectNodes,
  nodes,
  selectedNodeIds,
}: UseMarqueeSelectionOptions) {
  const selectionRef = useRef<SelectionBox | null>(null)
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)

  const finishSelection = useCallback(() => {
    const current = selectionRef.current
    if (!current) return

    selectNodes(selectedIdsFromSelectionBox(current, nodes))

    selectionRef.current = null
    setSelectionBox(null)
  }, [nodes, selectNodes])

  const beginSelection = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()

      const point = screenToCanvas(event.clientX, event.clientY)
      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      selectionRef.current = createSelectionBox(event.pointerId, point, additive, selectedNodeIds)
      setSelectionBox(selectionRef.current)

      if (!additive) {
        selectNode(undefined)
      }
    },
    [screenToCanvas, selectNode, selectedNodeIds, startInteraction],
  )

  const clearSelection = useCallback(() => {
    selectionRef.current = null
    setSelectionBox(null)
  }, [])

  // Dispatcher (handleCanvasPointerMove) selection branch.
  const tryMoveSelection = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const selection = selectionRef.current
      if (selection?.pointerId !== event.pointerId) return false
      const point = screenToCanvas(event.clientX, event.clientY)
      selection.currentX = point.x
      selection.currentY = point.y
      setSelectionBox({ ...selection })
      return true
    },
    [screenToCanvas],
  )

  // Dispatcher (handleCanvasPointerEnd) selection branch.
  const tryEndSelection = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (selectionRef.current?.pointerId === event.pointerId) {
        finishSelection()
      }
    },
    [finishSelection],
  )

  const resetMarquee = useCallback(() => {
    selectionRef.current = null
    setSelectionBox(null)
  }, [])

  return {
    selectionBox,
    beginSelection,
    finishSelection,
    clearSelection,
    tryMoveSelection,
    tryEndSelection,
    resetMarquee,
  }
}
