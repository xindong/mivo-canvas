import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import type { CanvasId, MivoCanvasNode } from '../types/mivoCanvas'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'
import {
  boundsForNodes,
  isActiveSelectionRect,
  previewIdsFromSelectionBox,
  runtimeToolFor,
  selectionRectFromBox,
  shouldStartCanvasSurfaceInteraction,
  type RuntimeCanvasTool,
} from './canvasInteraction'
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

// Thin assembly shell over the extracted interaction hooks (F7 split):
// useViewport / useMarqueeSelection / useNodeTransform / useGroupTransform /
// useTextAnnotation / useBrushStamp / useGlobalCanvasEvents. Owns only the
// shared interaction state (snap guides, drop targets, editing text, temp tool)
// + the dispatcher that fans pointer events out to the hooks.
export function useCanvasInteractionController({
  shellRef, sceneId, nodes, selectedNodeIds, maskEditNodeId, onCancelMaskEdit, onCloseContextMenu,
}: UseCanvasInteractionControllerOptions) {
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [activeSectionDropTargetId, setActiveSectionDropTargetId] = useState<string | undefined>()
  const [activeConnectorDropTargetId, setActiveConnectorDropTargetId] = useState<string | undefined>()
  const [editingTextNodeId, setEditingTextNodeId] = useState<string | undefined>()
  const [temporaryTool, setTemporaryTool] = useState<RuntimeCanvasTool | undefined>()
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

  const viewport = useViewport({ shellRef, sceneId, nodes, selectedNodes, onCloseContextMenu })

  const discardEmptyEditingText = useCallback((nodeId = editingTextNodeId) => {
    if (!nodeId) return
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
    if (isAutoDeletedEmptyTextNode(node) && !node.text?.trim()) deleteNode(nodeId)
    setEditingTextNodeId((current) => (current === nodeId ? undefined : current))
  }, [deleteNode, editingTextNodeId])

  // Shared interaction-start cleanup (the 6 calls inlined across every begin*
  // that originally had them). Bundled here for the extracted hooks; behavior
  // identical — same calls, same order, React-batched.
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

  const marquee = useMarqueeSelection({
    screenToCanvas: viewport.screenToCanvas, startInteraction, selectNode, selectNodes, nodes, selectedNodeIds,
  })
  const brush = useBrushStamp({
    screenToCanvas: viewport.screenToCanvas, viewportRef: viewport.viewportRef, onCloseContextMenu,
    discardEmptyEditingText, setEditingTextNodeId, setSnapGuides, clearSelection: marquee.clearSelection,
  })
  const text = useTextAnnotation({
    screenToCanvas: viewport.screenToCanvas, viewportRef: viewport.viewportRef, onCloseContextMenu,
    discardEmptyEditingText, setEditingTextNodeId, setSnapGuides, setActiveConnectorDropTargetId,
    clearSelection: marquee.clearSelection, selectNode, editTextNode, beginEraserDrag: brush.beginEraserDrag,
    setActiveTool, nodes,
  })
  const nodeTransform = useNodeTransform({
    viewportRef: viewport.viewportRef, startInteraction, clearSelection: marquee.clearSelection,
    selectNode, selectNodes, captureHistory, updateSelectedNodesPosition, updateNodeGeometry,
    setSnapGuides, setActiveSectionDropTargetId, setActiveConnectorDropTargetId,
    editTextNode, nodes, selectedNodeIds,
  })

  const selectedBounds = selectedNodes.length > 1 ? boundsForNodes(selectedNodes) : undefined
  const showGroupSelectionBounds =
    interactionMode === 'select' && !marquee.selectionBox && Boolean(selectedBounds) &&
    selectedNodes.some((node) => !isNodeEffectivelyLocked(node, nodes))
  const selectionSpacingHandles = useMemo(
    () =>
      showGroupSelectionBounds
        ? smartSelectionHandlesFor(selectedNodes, {
            isEffectivelyLocked: (node) => isNodeEffectivelyLocked(node, nodes),
            viewportScale: viewport.viewport.scale,
          })
        : [],
    [nodes, selectedNodes, showGroupSelectionBounds, viewport.viewport.scale],
  )

  const group = useGroupTransform({
    selectedBounds, selectedNodes, nodes, viewportRef: viewport.viewportRef,
    startInteraction, captureHistory, updateNodesGeometry, setSnapGuides,
  })

  const beginPan = useCallback((event: ReactPointerEvent<HTMLElement>, options?: { clearSelection?: boolean }) => {
    if (event.button !== 0 && event.button !== 1) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    startInteraction()
    marquee.clearSelection()
    viewport.startPan(event)
    if (options?.clearSelection) selectNode(undefined)
  }, [marquee, selectNode, startInteraction, viewport])

  const toolHandlerContext = useMemo<CanvasToolHandlerContext>(() => ({
    beginPan,
    beginSelection: marquee.beginSelection,
    beginNodeMove: nodeTransform.beginNodeMove,
    beginNodeResize: nodeTransform.startNodeResize,
    beginTextBox: text.beginTextBox,
    beginFrameBox: text.beginFrameBox,
    beginMarkupBox: text.beginMarkupBox,
    beginStampPlacement: brush.beginStampPlacement,
    beginTextEdit: text.beginTextEdit,
  }), [beginPan, brush, marquee, nodeTransform, text])

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
    if (group.tryMoveGroupResize(event)) return
    if (brush.tryMoveEraser(event)) return
    if (brush.tryMoveStamp(event)) return
    if (group.tryMoveSpacing(event)) return
    if (text.tryMoveTextCreation(event)) return
    if (text.tryMoveFrameCreation(event)) return
    if (text.tryMoveMarkupCreation(event)) return
    if (nodeTransform.tryMoveNodeTransform(event)) return
    if (text.tryMoveMarkupPointTransform(event)) return
    if (text.tryMoveTextResize(event)) return
    if (viewport.tryMovePan(event)) return
    marquee.tryMoveSelection(event)
  }, [brush, group, marquee, nodeTransform, text, viewport])

  const handleCanvasPointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    group.tryEndGroupResize(event)
    group.tryEndSpacing(event)
    text.tryEndTextCreation(event)
    text.tryEndFrameCreation(event)
    text.tryEndMarkupCreation(event)
    nodeTransform.tryEndNodeTransform(event)
    text.tryEndTextResize(event)
    text.tryEndMarkupPointTransform(event)
    brush.tryEndEraser(event)
    brush.tryEndStamp(event)
    viewport.tryEndPan(event)
    marquee.tryEndSelection(event)
  }, [brush, group, marquee, nodeTransform, text, viewport])

  useGlobalCanvasEvents({
    maskEditNodeId, onCancelMaskEdit, onCloseContextMenu, setTemporaryTool, setEditingTextNodeId,
    setSnapGuides, setActiveConnectorDropTargetId, zoomBy: viewport.zoomBy, fitAll: viewport.fitAll,
    fitSelection: viewport.fitSelection, resetView: viewport.resetView, viewportCenter: viewport.viewportCenter,
    resetMarquee: marquee.resetMarquee, resetNodeTransform: nodeTransform.resetNodeTransform,
    resetPan: viewport.resetPan, resetTextAnnotation: text.resetTextAnnotation,
    resetBrushStamp: brush.resetBrushStamp, resetGroupTransform: group.resetGroupTransform,
  })

  const resetViewportForScene = viewport.resetViewportForScene
  const resetMarquee = marquee.resetMarquee
  const resetNodeTransform = nodeTransform.resetNodeTransform
  const resetGroupTransform = group.resetGroupTransform
  const resetTextAnnotation = text.resetTextAnnotation
  const resetBrushStamp = brush.resetBrushStamp
  // Scene reset: single rAF (preserves the original structure) resets every hook.
  // Deps are the individual stable reset callbacks (not the hook return objects,
  // which are new every render — depending on those would re-run this effect
  // every render and reset pan/selection/transform mid-interaction).
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      resetViewportForScene(sceneId)
      resetMarquee()
      resetNodeTransform()
      resetGroupTransform()
      resetTextAnnotation()
      resetBrushStamp()
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      setTemporaryTool(undefined)
      setEditingTextNodeId(undefined)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sceneId, resetBrushStamp, resetGroupTransform, resetMarquee, resetNodeTransform, resetTextAnnotation, resetViewportForScene])

  const selectionRect = marquee.selectionBox ? selectionRectFromBox(marquee.selectionBox) : undefined
  const activeSelectionRect = selectionRect && isActiveSelectionRect(selectionRect) ? selectionRect : undefined
  const selectionPreviewSet = previewIdsFromSelectionBox(marquee.selectionBox, nodes)

  return {
    viewport: viewport.viewport, snapGuides, selectionBox: marquee.selectionBox, isPanning: viewport.isPanning,
    temporaryTool, editingTextNodeId, interactionMode, selectedNodes, selectedBounds, selectionSpacingHandles,
    activeSectionDropTargetId, activeConnectorDropTargetId, showGroupSelectionBounds, activeSelectionRect,
    activeTextCreationRect: text.activeTextCreationRect, activeFrameCreationRect: text.activeFrameCreationRect,
    activeMarkupCreationRect: text.activeMarkupCreationRect, markupCreationBox: text.markupCreationBox,
    stampPlacementPreview: brush.stampPlacementPreview, selectionPreviewSet,
    beginGroupResize: group.beginGroupResize, beginSelectionSpacingDrag: group.beginSelectionSpacingDrag,
    beginNodePointerDown, beginNodeResize, editTextNode, beginTextResize: text.beginTextResize,
    beginMarkupPointMove: text.beginMarkupPointMove, updateEditingText: text.updateEditingText,
    finishTextEditing: text.finishTextEditing, handleCanvasPointerDown, handleCanvasPointerMove,
    handleCanvasPointerEnd, handleWheel: viewport.handleWheel, zoomBy: viewport.zoomBy, fit: viewport.fit,
    fitAll: viewport.fitAll, fitSelection: viewport.fitSelection, resetView: viewport.resetView,
  }
}
