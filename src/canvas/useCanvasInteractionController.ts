import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import type { CanvasId, MivoCanvasNode } from '../types/mivoCanvas'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'
import { boundsForNodes, isActiveSelectionRect, previewIdsFromSelectionBox, runtimeToolFor, selectionRectFromBox, shouldStartCanvasSurfaceInteraction, type RuntimeCanvasTool } from './canvasInteraction'
import { canvasToolHandlers, type CanvasToolHandlerContext } from './canvasToolHandlers'
import { isCanvasToolEnabled } from './canvasToolRegistry'
import { smartSelectionHandlesFor } from './smartSelection'
import { useViewport } from './useViewport'
import { useMarqueeSelection } from './useMarqueeSelection'
import { useNodeTransform, isNodeEffectivelyLocked, isAutoDeletedEmptyTextNode } from './useNodeTransform'
import { useGroupTransform } from './useGroupTransform'
import { useBrushStamp } from './useBrushStamp'
import { useTextAnnotation, isEditableTextNode } from './useTextAnnotation'
import { useGlobalCanvasEvents } from './useGlobalCanvasEvents'
import { useZoomTool } from './useZoomTool'

export type { TextResizeEdge } from './useTextAnnotation'

type UseCanvasInteractionControllerOptions = {
  shellRef: RefObject<HTMLElement | null>
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  selectedNodeIds: string[]
  maskEditNodeId?: string
  onCancelMaskEdit?: () => void
  onCloseContextMenu: () => void
}

// Thin assembly shell over the extracted interaction hooks (F7 split). Hook
// returns are destructured to bare stable callbacks so React.memo on
// CanvasNodeView actually skips unchanged nodes (object deps would recreate
// the callbacks every render and defeat the memo).
export function useCanvasInteractionController({
  shellRef, sceneId, nodes, selectedNodeIds, maskEditNodeId, onCancelMaskEdit, onCloseContextMenu,
}: UseCanvasInteractionControllerOptions) {
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [activeSectionDropTargetId, setActiveSectionDropTargetId] = useState<string | undefined>()
  const [activeConnectorDropTargetId, setActiveConnectorDropTargetId] = useState<string | undefined>()
  const [editingTextNodeId, setEditingTextNodeId] = useState<string | undefined>()
  const [temporaryTool, setTemporaryTool] = useState<RuntimeCanvasTool | undefined>()
  const [zoomOutCursor, setZoomOutCursor] = useState(false)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const selectNode = useCanvasStore((state) => state.selectNode)
  const selectNodes = useCanvasStore((state) => state.selectNodes)
  const captureHistory = useCanvasStore((state) => state.captureHistory)
  const updateSelectedNodesPosition = useCanvasStore((state) => state.updateSelectedNodesPosition)
  const updateNodeGeometry = useCanvasStore((state) => state.updateNodeGeometry)
  const updateNodesGeometry = useCanvasStore((state) => state.updateNodesGeometry)
  const deleteNode = useCanvasStore((state) => state.deleteNode)
  const storedActiveTool = useCanvasStore((state) => state.activeTool)
  const activeTool = isCanvasToolEnabled(storedActiveTool) ? storedActiveTool : 'select'
  const interactionMode = runtimeToolFor(activeTool, temporaryTool)
  const activeToolHandler = canvasToolHandlers[interactionMode]
  const selectedNodes = useMemo(() => {
    const selectedNodeSet = new Set(selectedNodeIds)
    return nodes.filter((node) => selectedNodeSet.has(node.id))
  }, [nodes, selectedNodeIds])

  const {
    viewport: viewportState, viewportRef, isPanning, screenToCanvas, viewportCenter, zoomBy,
    zoomTo, fitToBounds, fit, fitAll, fitSelection, resetView, handleWheel, startPan, tryMovePan,
    tryEndPan, resetPan, resetViewportForScene,
  } = useViewport({ shellRef, sceneId, nodes, selectedNodes, onCloseContextMenu })

  const discardEmptyEditingText = useCallback((nodeId = editingTextNodeId) => {
    if (!nodeId) return
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
    if (isAutoDeletedEmptyTextNode(node) && !node.text?.trim()) deleteNode(nodeId)
    setEditingTextNodeId((current) => (current === nodeId ? undefined : current))
  }, [deleteNode, editingTextNodeId])

  const startInteraction = useCallback(() => {
    onCloseContextMenu()
    discardEmptyEditingText()
    setEditingTextNodeId(undefined)
    setSnapGuides([])
    setActiveSectionDropTargetId(undefined)
    setActiveConnectorDropTargetId(undefined)
  }, [discardEmptyEditingText, onCloseContextMenu])

  const editTextNode = useCallback((nodeId: string) => {
    const state = useCanvasStore.getState()
    const node = state.nodes.find((item) => item.id === nodeId)
    if (!isEditableTextNode(node) || isNodeEffectivelyLocked(node, state.nodes)) return false
    onCloseContextMenu()
    setSnapGuides([])
    setActiveSectionDropTargetId(undefined)
    setActiveConnectorDropTargetId(undefined)
    selectNode(nodeId)
    captureHistory()
    setEditingTextNodeId(nodeId)
    return true
  }, [captureHistory, onCloseContextMenu, selectNode])

  const {
    selectionBox, beginSelection, clearSelection, tryMoveSelection, tryEndSelection, resetMarquee,
  } = useMarqueeSelection({ screenToCanvas, startInteraction, selectNode, selectNodes, nodes, selectedNodeIds })

  const {
    stampPlacementPreview, beginStampPlacement, beginEraserDrag, tryMoveEraser, tryMoveStamp,
    tryEndEraser, tryEndStamp, resetBrushStamp,
  } = useBrushStamp({
    screenToCanvas, viewportRef, onCloseContextMenu, discardEmptyEditingText, setEditingTextNodeId,
    setSnapGuides, clearSelection,
  })

  const {
    markupCreationBox, activeTextCreationRect, activeFrameCreationRect,
    activeMarkupCreationRect, beginTextEdit, beginTextBox, beginMarkupPointMove, beginFrameBox,
    beginMarkupBox, updateEditingText, beginTextResize, finishTextEditing,
    tryMoveTextCreation, tryMoveFrameCreation, tryMoveMarkupCreation, tryMoveMarkupPointTransform,
    tryMoveTextResize, tryEndTextCreation, tryEndFrameCreation, tryEndMarkupCreation,
    tryEndMarkupPointTransform, tryEndTextResize, resetTextAnnotation,
  } = useTextAnnotation({
    screenToCanvas, viewportRef, onCloseContextMenu, discardEmptyEditingText, setEditingTextNodeId,
    setSnapGuides, setActiveConnectorDropTargetId, clearSelection, selectNode, editTextNode,
    beginEraserDrag, setActiveTool, nodes,
  })

  const {
    beginNodeMove, startNodeResize, tryMoveNodeTransform, tryEndNodeTransform, resetNodeTransform,
  } = useNodeTransform({
    viewportRef, startInteraction, clearSelection, selectNode, selectNodes, captureHistory,
    updateSelectedNodesPosition, updateNodeGeometry, setSnapGuides, setActiveSectionDropTargetId,
    setActiveConnectorDropTargetId, editTextNode, nodes, selectedNodeIds,
  })

  const selectedBounds = selectedNodes.length > 1 ? boundsForNodes(selectedNodes) : undefined
  const showGroupSelectionBounds =
    interactionMode === 'select' && !selectionBox && Boolean(selectedBounds) &&
    selectedNodes.some((node) => !isNodeEffectivelyLocked(node, nodes))
  const selectionSpacingHandles = useMemo(
    () =>
      showGroupSelectionBounds
        ? smartSelectionHandlesFor(selectedNodes, {
            isEffectivelyLocked: (node) => isNodeEffectivelyLocked(node, nodes),
            viewportScale: viewportState.scale,
          })
        : [],
    [nodes, selectedNodes, showGroupSelectionBounds, viewportState.scale],
  )

  const {
    beginGroupResize, beginSelectionSpacingDrag, tryMoveGroupResize, tryMoveSpacing,
    tryEndGroupResize, tryEndSpacing, resetGroupTransform,
  } = useGroupTransform({
    selectedBounds, selectedNodes, nodes, viewportRef, startInteraction, captureHistory,
    updateNodesGeometry, setSnapGuides,
  })

  const { beginZoomGesture, tryMoveZoomGesture, tryEndZoomGesture, resetZoomGesture } = useZoomTool({
    shellRef, viewportRef, startInteraction, zoomBy, fitToBounds, zoomOutCursor: interactionMode === 'zoom' && zoomOutCursor,
  })

  const beginPan = useCallback((event: ReactPointerEvent<HTMLElement>, options?: { clearSelection?: boolean }) => {
    if (event.button !== 0 && event.button !== 1) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    startInteraction()
    clearSelection()
    startPan(event)
    if (options?.clearSelection) selectNode(undefined)
  }, [clearSelection, selectNode, startInteraction, startPan])

  const toolHandlerContext = useMemo<CanvasToolHandlerContext>(() => ({
    beginPan,
    beginSelection,
    beginZoomGesture,
    beginNodeMove,
    beginNodeResize: startNodeResize,
    beginTextBox,
    beginFrameBox,
    beginMarkupBox,
    beginStampPlacement,
    beginTextEdit,
  }), [beginFrameBox, beginMarkupBox, beginNodeMove, beginPan, beginSelection, beginStampPlacement, beginTextBox, beginTextEdit, beginZoomGesture, startNodeResize])

  const beginNodePointerDown = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      activeToolHandler.onNodePointerDown(nodeId, event, toolHandlerContext)
    }, [activeToolHandler, toolHandlerContext])
  const beginNodeResize = useCallback(
    (nodeId: string, corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      activeToolHandler.onResizeHandlePointerDown(nodeId, corner, event, toolHandlerContext)
    }, [activeToolHandler, toolHandlerContext])
  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!shouldStartCanvasSurfaceInteraction(event.target)) return
    activeToolHandler.onCanvasPointerDown(event, toolHandlerContext)
  }, [activeToolHandler, toolHandlerContext])

  // Dispatcher: fan pointer events out to the hook tryMove/tryEnd handlers in
  // the original if-chain order. Each hook owns its ref + branch logic.
  const handleCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (tryMoveZoomGesture(event)) return
    if (tryMoveGroupResize(event)) return
    if (tryMoveEraser(event)) return
    if (tryMoveStamp(event)) return
    if (tryMoveSpacing(event)) return
    if (tryMoveTextCreation(event)) return
    if (tryMoveFrameCreation(event)) return
    if (tryMoveMarkupCreation(event)) return
    if (tryMoveNodeTransform(event)) return
    if (tryMoveMarkupPointTransform(event)) return
    if (tryMoveTextResize(event)) return
    if (tryMovePan(event)) return
    tryMoveSelection(event)
  }, [tryMoveEraser, tryMoveFrameCreation, tryMoveGroupResize, tryMoveMarkupCreation, tryMoveMarkupPointTransform, tryMoveNodeTransform, tryMovePan, tryMoveSelection, tryMoveSpacing, tryMoveStamp, tryMoveTextCreation, tryMoveTextResize, tryMoveZoomGesture])

  const handleCanvasPointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    tryEndZoomGesture(event)
    tryEndGroupResize(event)
    tryEndSpacing(event)
    tryEndTextCreation(event)
    tryEndFrameCreation(event)
    tryEndMarkupCreation(event)
    tryEndNodeTransform(event)
    tryEndTextResize(event)
    tryEndMarkupPointTransform(event)
    tryEndEraser(event)
    tryEndStamp(event)
    tryEndPan(event)
    tryEndSelection(event)
  }, [tryEndEraser, tryEndFrameCreation, tryEndGroupResize, tryEndMarkupCreation, tryEndMarkupPointTransform, tryEndNodeTransform, tryEndPan, tryEndSelection, tryEndSpacing, tryEndStamp, tryEndTextCreation, tryEndTextResize, tryEndZoomGesture])

  useGlobalCanvasEvents({
    maskEditNodeId, onCancelMaskEdit, onCloseContextMenu, setTemporaryTool, setEditingTextNodeId,
    setSnapGuides, setActiveConnectorDropTargetId, setZoomOutCursor, zoomBy, zoomTo, fitAll, fitSelection,
    viewportCenter, resetMarquee, resetNodeTransform, resetPan, resetTextAnnotation,
    resetBrushStamp, resetGroupTransform, resetZoomGesture,
  })

  // Scene reset: one rAF resets every interaction hook.
  // Contract: scene-reset.contract.test.ts must list every hook reset below.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      resetViewportForScene(sceneId)
      resetMarquee()
      resetNodeTransform()
      resetGroupTransform()
      resetTextAnnotation()
      resetBrushStamp()
      resetZoomGesture()
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      setTemporaryTool(undefined)
      setEditingTextNodeId(undefined)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sceneId, resetBrushStamp, resetGroupTransform, resetMarquee, resetNodeTransform, resetTextAnnotation, resetViewportForScene, resetZoomGesture])

  const selectionRect = selectionBox ? selectionRectFromBox(selectionBox) : undefined
  const activeSelectionRect = selectionRect && isActiveSelectionRect(selectionRect) ? selectionRect : undefined
  const selectionPreviewSet = previewIdsFromSelectionBox(selectionBox, nodes)

  return {
    viewport: viewportState, snapGuides, selectionBox, isPanning, temporaryTool, editingTextNodeId,
    interactionMode, selectedNodes, selectedBounds, selectionSpacingHandles, activeSectionDropTargetId,
    activeConnectorDropTargetId, showGroupSelectionBounds, activeSelectionRect,
    activeTextCreationRect, activeFrameCreationRect, activeMarkupCreationRect, markupCreationBox,
    stampPlacementPreview, selectionPreviewSet, beginGroupResize, beginSelectionSpacingDrag,
    beginNodePointerDown, beginNodeResize, editTextNode, beginTextResize, beginMarkupPointMove,
    updateEditingText, finishTextEditing, handleCanvasPointerDown, handleCanvasPointerMove,
    handleCanvasPointerEnd, handleWheel, zoomTo, zoomBy, fitToBounds, fit, fitAll, fitSelection, resetView,
  }
}
