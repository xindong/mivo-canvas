import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { importImageFileToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'
import type { CanvasId, MarkupKind, MarkupPoint, MivoCanvasNode } from '../types/mivoCanvas'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'
import { nearestConnectorBindingForPoint } from './connectorGeometry'
import {
  boundsForNodes,
  createGroupResizeState,
  isActiveSelectionRect,
  isEditingTarget,
  previewIdsFromSelectionBox,
  resizeGroupSelection,
  runtimeToolFor,
  selectionRectFromBox,
  shouldStartCanvasSurfaceInteraction,
  type CanvasBounds,
  type GroupResizeState,
  type RuntimeCanvasTool,
} from './canvasInteraction'
import { eraserHitStrokeIds, eraserScreenRadius } from './brushGeometry'
import { stampGrowthIntervalMs, stampGrowthSizes } from './stampDefs'
import { canvasToolHandlers, type CanvasToolHandlerContext } from './canvasToolHandlers'
import { isCanvasToolEnabled, markupKindForTool, toolForKeyboardShortcut } from './canvasToolRegistry'
import {
  smartSelectionGapFor,
  smartSelectionHandlesFor,
  smartSelectionLayoutFor,
  smartSelectionSpacingUpdates,
  type SmartSelectionHandle,
  type SmartSelectionSpacingDragState,
} from './smartSelection'
import { defaultTextFontSize, defaultTextWeight, textGeometryFor } from './textGeometry'
import { useViewport } from './useViewport'
import { useMarqueeSelection } from './useMarqueeSelection'
import { useNodeTransform, isAutoDeletedEmptyTextNode, isNodeEffectivelyLocked } from './useNodeTransform'

type UseCanvasInteractionControllerOptions = {
  shellRef: RefObject<HTMLElement | null>
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  selectedNodeIds: string[]
  maskEditNodeId?: string
  onCancelMaskEdit?: () => void
  onCloseContextMenu: () => void
}

export type TextResizeEdge = 'w' | 'e'

type TextResizeState = {
  pointerId: number
  nodeId: string
  edge: TextResizeEdge
  startClientX: number
  startX: number
  startWidth: number
  historyCaptured: boolean
}

type TextCreationState = {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
}

type FrameCreationState = TextCreationState

type MarkupCreationState = TextCreationState & {
  kind: MarkupKind
  points: MarkupPoint[]
}

type MarkupPointTransformState = {
  pointerId: number
  nodeId: string
  pointIndex: number
  startClientX: number
  startClientY: number
  startNode: MivoCanvasNode
  startPoints: MarkupPoint[]
  historyCaptured: boolean
}

const rectFromTextCreation = (box: TextCreationState): CanvasBounds => ({
  x: Math.min(box.startX, box.currentX),
  y: Math.min(box.startY, box.currentY),
  width: Math.abs(box.currentX - box.startX),
  height: Math.abs(box.currentY - box.startY),
})

const rectFromFrameCreation = (box: FrameCreationState): CanvasBounds => ({
  x: Math.min(box.startX, box.currentX),
  y: Math.min(box.startY, box.currentY),
  width: Math.abs(box.currentX - box.startX),
  height: Math.abs(box.currentY - box.startY),
})

const rectFromMarkupCreation = (box: MarkupCreationState): CanvasBounds => {
  // Freehand brush strokes span every sampled point, not just start→current.
  // Bounding by start/current alone makes the box origin/size snap around as
  // the cursor loops back over the start; the preview SVG (viewBox 0 0 w h with
  // preserveAspectRatio="none") then squashes and mirror-flips the stroke — the
  // "3D flip" glitch seen while drawing. Bound by the actual points instead.
  if (box.kind === 'brush' && box.points.length > 0) {
    let minX = box.points[0].x
    let minY = box.points[0].y
    let maxX = box.points[0].x
    let maxY = box.points[0].y
    for (const point of box.points) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }
  return {
    x: Math.min(box.startX, box.currentX),
    y: Math.min(box.startY, box.currentY),
    width: Math.abs(box.currentX - box.startX),
    height: Math.abs(box.currentY - box.startY),
  }
}

const constrainBoxPoint = (start: MarkupPoint, current: MarkupPoint): MarkupPoint => {
  const dx = current.x - start.x
  const dy = current.y - start.y
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  if (side <= 0) return current

  return {
    x: start.x + (dx < 0 ? -side : side),
    y: start.y + (dy < 0 ? -side : side),
  }
}

const constrainAnglePoint = (start: MarkupPoint, current: MarkupPoint): MarkupPoint => {
  const dx = current.x - start.x
  const dy = current.y - start.y
  const length = Math.hypot(dx, dy)
  if (length <= 0) return current

  const snappedAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return {
    x: start.x + Math.cos(snappedAngle) * length,
    y: start.y + Math.sin(snappedAngle) * length,
  }
}

const constrainedMarkupPoint = (
  kind: MarkupKind,
  start: MarkupPoint,
  current: MarkupPoint,
  constrain: boolean,
): MarkupPoint => {
  if (!constrain) return current
  if (kind === 'rect' || kind === 'ellipse') return constrainBoxPoint(start, current)
  if (kind === 'arrow' || kind === 'line' || kind === 'brush') return constrainAnglePoint(start, current)
  return current
}

const normalizeMarkupPoints = (box: MarkupCreationState, bounds: CanvasBounds): MarkupPoint[] | undefined => {
  if (box.kind !== 'arrow' && box.kind !== 'line' && box.kind !== 'brush') return undefined

  const sourcePoints =
    box.kind === 'brush' && box.points.length > 1
      ? box.points
      : [
          { x: box.startX, y: box.startY },
          { x: box.currentX, y: box.currentY },
        ]

  return sourcePoints.map((point) => ({
    x: point.x - bounds.x,
    y: point.y - bounds.y,
    ...('pressure' in point && point.pressure !== undefined ? { pressure: point.pressure } : {}),
  }))
}

const defaultLineMarkupPointsFor = (node: MivoCanvasNode): MarkupPoint[] => [
  { x: Math.max(2, node.markupStrokeWidth || 3), y: Math.max(2, node.height - (node.markupStrokeWidth || 3)) },
  { x: Math.max(2, node.width - (node.markupStrokeWidth || 3)), y: Math.max(2, node.markupStrokeWidth || 3) },
]

const lineMarkupPointsFor = (node: MivoCanvasNode): MarkupPoint[] =>
  node.markupPoints && node.markupPoints.length >= 2
    ? node.markupPoints.slice(0, 2).map((point) => ({ ...point }))
    : defaultLineMarkupPointsFor(node)

const markupGeometryFromAbsolutePoints = (points: MarkupPoint[]) => {
  const minWidth = 18
  const minHeight = 18
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const rawWidth = maxX - minX
  const rawHeight = maxY - minY
  const width = Math.max(minWidth, rawWidth)
  const height = Math.max(minHeight, rawHeight)
  const x = rawWidth < minWidth ? minX - (minWidth - rawWidth) / 2 : minX
  const y = rawHeight < minHeight ? minY - (minHeight - rawHeight) / 2 : minY

  return {
    geometry: { x, y, width, height },
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
  }
}

const isEditableTextNode = (
  node: MivoCanvasNode | undefined,
): node is MivoCanvasNode & { type: 'text' | 'annotation' | 'markup' } =>
  node?.type === 'text' ||
  node?.type === 'annotation' ||
  (node?.type === 'markup' && node.markupKind !== 'stamp')

export function useCanvasInteractionController({
  shellRef,
  sceneId,
  nodes,
  selectedNodeIds,
  maskEditNodeId,
  onCancelMaskEdit,
  onCloseContextMenu,
}: UseCanvasInteractionControllerOptions) {
  const textCreationRef = useRef<TextCreationState | null>(null)
  const frameCreationRef = useRef<FrameCreationState | null>(null)
  const markupCreationRef = useRef<MarkupCreationState | null>(null)
  const markupPointTransformRef = useRef<MarkupPointTransformState | null>(null)
  const textResizeRef = useRef<TextResizeState | null>(null)
  const groupResizeRef = useRef<GroupResizeState | null>(null)
  const selectionSpacingDragRef = useRef<SmartSelectionSpacingDragState | null>(null)
  const eraserDragRef = useRef<{ pointerId: number; historyCaptured: boolean } | null>(null)
  const stampPlacementRef = useRef<{ pointerId: number; stage: number; growTimer: number } | null>(null)
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [activeSectionDropTargetId, setActiveSectionDropTargetId] = useState<string | undefined>()
  const [activeConnectorDropTargetId, setActiveConnectorDropTargetId] = useState<string | undefined>()
  const [textCreationBox, setTextCreationBox] = useState<TextCreationState | null>(null)
  const [frameCreationBox, setFrameCreationBox] = useState<FrameCreationState | null>(null)
  const [markupCreationBox, setMarkupCreationBox] = useState<MarkupCreationState | null>(null)
  const [stampPlacementPreview, setStampPlacementPreview] = useState<{
    x: number
    y: number
    stage: number
  } | null>(null)
  const [temporaryTool, setTemporaryTool] = useState<RuntimeCanvasTool | undefined>()
  const storedActiveTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const selectNode = useCanvasStore((state) => state.selectNode)
  const selectNodes = useCanvasStore((state) => state.selectNodes)
  const captureHistory = useCanvasStore((state) => state.captureHistory)
  const undo = useCanvasStore((state) => state.undo)
  const redo = useCanvasStore((state) => state.redo)
  const updateSelectedNodesPosition = useCanvasStore((state) => state.updateSelectedNodesPosition)
  const updateNodeGeometry = useCanvasStore((state) => state.updateNodeGeometry)
  const updateMarkupGeometry = useCanvasStore((state) => state.updateMarkupGeometry)
  const updateNodesGeometry = useCanvasStore((state) => state.updateNodesGeometry)
  const moveSelectedNodesBy = useCanvasStore((state) => state.moveSelectedNodesBy)
  const moveSelectedLayer = useCanvasStore((state) => state.moveSelectedLayer)
  const copySelectedNodes = useCanvasStore((state) => state.copySelectedNodes)
  const cutSelectedNodes = useCanvasStore((state) => state.cutSelectedNodes)
  const eraseMarkupStrokes = useCanvasStore((state) => state.eraseMarkupStrokes)
  const pasteClipboardNodes = useCanvasStore((state) => state.pasteClipboardNodes)
  const pasteClipboardAssets = useCanvasStore((state) => state.pasteClipboardAssets)
  const groupSelectedNodes = useCanvasStore((state) => state.groupSelectedNodes)
  const ungroupSelectedNodes = useCanvasStore((state) => state.ungroupSelectedNodes)
  const deleteSelectedNodes = useCanvasStore((state) => state.deleteSelectedNodes)
  const duplicateSelectedNodes = useCanvasStore((state) => state.duplicateSelectedNodes)
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addFrameNode = useCanvasStore((state) => state.addFrameNode)
  const addMarkupNode = useCanvasStore((state) => state.addMarkupNode)
  const noteStampPlaced = useCanvasStore((state) => state.noteStampPlaced)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const resizeTextNode = useCanvasStore((state) => state.resizeTextNode)
  const deleteNode = useCanvasStore((state) => state.deleteNode)
  const [editingTextNodeId, setEditingTextNodeId] = useState<string | undefined>()
  const activeTool = isCanvasToolEnabled(storedActiveTool) ? storedActiveTool : 'select'
  const interactionMode = runtimeToolFor(activeTool, temporaryTool)
  const activeToolHandler = canvasToolHandlers[interactionMode]
  const selectedNodes = useMemo(() => {
    const selectedNodeSet = new Set(selectedNodeIds)
    return nodes.filter((node) => selectedNodeSet.has(node.id))
  }, [nodes, selectedNodeIds])

  const {
    viewport,
    viewportRef,
    isPanning,
    screenToCanvas,
    viewportCenter,
    zoomBy,
    fitAll,
    fitSelection,
    fit,
    resetView,
    handleWheel,
    startPan,
    tryMovePan,
    tryEndPan,
    resetPan,
    resetViewportForScene,
  } = useViewport({ shellRef, sceneId, nodes, selectedNodes, onCloseContextMenu })

  const discardEmptyEditingText = useCallback(
    (nodeId = editingTextNodeId) => {
      if (!nodeId) return

      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      if (isAutoDeletedEmptyTextNode(node) && !node.text?.trim()) {
        deleteNode(nodeId)
      }

      setEditingTextNodeId((current) => (current === nodeId ? undefined : current))
    },
    [deleteNode, editingTextNodeId],
  )

  // Shared interaction-start cleanup (6 calls inlined across every begin* in the
  // original controller). Bundled here for the extracted hooks; behavior
  // identical — same calls, same order, React-batched.
  const startInteraction = useCallback(() => {
    onCloseContextMenu()
    discardEmptyEditingText()
    setEditingTextNodeId(undefined)
    setSnapGuides([])
    setActiveSectionDropTargetId(undefined)
    setActiveConnectorDropTargetId(undefined)
  }, [discardEmptyEditingText, onCloseContextMenu])

  const editTextNode = useCallback(
    (nodeId: string) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      if (!isEditableTextNode(node) || isNodeEffectivelyLocked(node, useCanvasStore.getState().nodes)) return false

      onCloseContextMenu()
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      selectNode(nodeId)
      captureHistory()
      setEditingTextNodeId(nodeId)

      return true
    },
    [captureHistory, onCloseContextMenu, selectNode],
  )

  const {
    selectionBox,
    beginSelection,
    clearSelection,
    tryMoveSelection,
    tryEndSelection,
    resetMarquee,
  } = useMarqueeSelection({
    screenToCanvas,
    startInteraction,
    selectNode,
    selectNodes,
    nodes,
    selectedNodeIds,
  })

  const selectedBounds = selectedNodes.length > 1 ? boundsForNodes(selectedNodes) : undefined
  const showGroupSelectionBounds =
    interactionMode === 'select' &&
    !selectionBox &&
    Boolean(selectedBounds) &&
    selectedNodes.some((node) => !isNodeEffectivelyLocked(node, nodes))
  const selectionSpacingHandles = useMemo(
    () =>
      showGroupSelectionBounds
        ? smartSelectionHandlesFor(selectedNodes, {
            isEffectivelyLocked: (node) => isNodeEffectivelyLocked(node, nodes),
            viewportScale: viewport.scale,
          })
        : [],
    [nodes, selectedNodes, showGroupSelectionBounds, viewport.scale],
  )

  const {
    beginNodeMove,
    startNodeResize,
    tryMoveNodeTransform,
    tryEndNodeTransform,
    resetNodeTransform,
  } = useNodeTransform({
    viewportRef,
    startInteraction,
    clearSelection,
    selectNode,
    selectNodes,
    captureHistory,
    updateSelectedNodesPosition,
    updateNodeGeometry,
    setSnapGuides,
    setActiveSectionDropTargetId,
    setActiveConnectorDropTargetId,
    editTextNode,
    nodes,
    selectedNodeIds,
  })

  const beginPan = useCallback(
    (event: ReactPointerEvent<HTMLElement>, options?: { clearSelection?: boolean }) => {
      if (event.button !== 0 && event.button !== 1) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()
      clearSelection()
      startPan(event)

      if (options?.clearSelection) {
        selectNode(undefined)
      }
    },
    [clearSelection, selectNode, startInteraction, startPan],
  )

  const beginGroupResize = useCallback(
    (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !selectedBounds || selectedNodes.length < 2) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()
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

  const beginTextEdit = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return false

      event.preventDefault()
      event.stopPropagation()
      return editTextNode(nodeId)
    },
    [editTextNode],
  )

  const beginTextBox = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setSnapGuides([])
      clearSelection()
      selectNode(undefined)

      const point = screenToCanvas(event.clientX, event.clientY)
      const nextBox = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
      }
      textCreationRef.current = nextBox
      setTextCreationBox(nextBox)
    },
    [clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas, selectNode],
  )

  const beginMarkupPointMove = useCallback(
    (nodeId: string, pointIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return

      const node = nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'markup' || (node.markupKind !== 'arrow' && node.markupKind !== 'line')) return
      if (isNodeEffectivelyLocked(node, nodes)) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setSnapGuides([])
      selectNode(nodeId)

      markupPointTransformRef.current = {
        pointerId: event.pointerId,
        nodeId,
        pointIndex,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startNode: node,
        startPoints: lineMarkupPointsFor(node),
        historyCaptured: false,
      }
    },
    [discardEmptyEditingText, nodes, onCloseContextMenu, selectNode],
  )

  const beginFrameBox = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      clearSelection()

      const point = screenToCanvas(event.clientX, event.clientY)
      const nextBox = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
      }
      frameCreationRef.current = nextBox
      setFrameCreationBox(nextBox)
    },
    [clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas],
  )

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
        captureHistory()
        drag.historyCaptured = true
      }
      eraseMarkupStrokes(hits)
    },
    [captureHistory, eraseMarkupStrokes, screenToCanvas, viewportRef],
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
    [clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas],
  )

  const beginMarkupBox = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const kind = markupKindForTool(useCanvasStore.getState().activeTool)
      if (!kind) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      clearSelection()

      if (kind === 'brush' && useCanvasStore.getState().brushStyle.kind === 'eraser') {
        eraserDragRef.current = { pointerId: event.pointerId, historyCaptured: false }
        eraseAtClientPoint(event.clientX, event.clientY)
        return
      }

      const point = screenToCanvas(event.clientX, event.clientY)
      const nextBox: MarkupCreationState = {
        pointerId: event.pointerId,
        kind,
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
        points: [point],
      }
      markupCreationRef.current = nextBox
      setMarkupCreationBox(nextBox)
    },
    [clearSelection, discardEmptyEditingText, eraseAtClientPoint, onCloseContextMenu, screenToCanvas],
  )

  const updateEditingText = useCallback(
    (nodeId: string, text: string) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      const fontSize = node?.fontSize || defaultTextFontSize
      const fontWeight = node?.fontWeight || defaultTextWeight
      const preferredWidth = node?.textAutoWidth === false ? node.width : undefined
      updateTextNode(nodeId, text, textGeometryFor(text, fontSize, preferredWidth, fontWeight))
    },
    [updateTextNode],
  )

  const beginTextResize = useCallback(
    (nodeId: string, edge: TextResizeEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return

      const node = nodes.find((item) => item.id === nodeId)
      if (!isEditableTextNode(node) || isNodeEffectivelyLocked(node, nodes)) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      selectNode(nodeId)

      textResizeRef.current = {
        pointerId: event.pointerId,
        nodeId,
        edge,
        startClientX: event.clientX,
        startX: node.x,
        startWidth: node.width,
        historyCaptured: false,
      }
    },
    [discardEmptyEditingText, nodes, onCloseContextMenu, selectNode],
  )

  const finishTextEditing = useCallback(
    (nodeId: string) => {
      setEditingTextNodeId((current) => (current === nodeId ? undefined : current))

      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      if (isAutoDeletedEmptyTextNode(node) && !node.text?.trim()) {
        discardEmptyEditingText(nodeId)
      }
    },
    [discardEmptyEditingText],
  )

  const toolHandlerContext = useMemo<CanvasToolHandlerContext>(
    () => ({
      beginPan,
      beginSelection,
      beginNodeMove,
      beginNodeResize: startNodeResize,
      beginTextBox,
      beginFrameBox,
      beginMarkupBox,
      beginStampPlacement,
      beginTextEdit,
    }),
    [
      beginFrameBox,
      beginMarkupBox,
      beginNodeMove,
      beginPan,
      beginSelection,
      beginStampPlacement,
      beginTextBox,
      beginTextEdit,
      startNodeResize,
    ],
  )

  const beginNodePointerDown = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      activeToolHandler.onNodePointerDown(nodeId, event, toolHandlerContext)
    },
    [activeToolHandler, toolHandlerContext],
  )

  const beginNodeResize = useCallback(
    (nodeId: string, corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      activeToolHandler.onResizeHandlePointerDown(nodeId, corner, event, toolHandlerContext)
    },
    [activeToolHandler, toolHandlerContext],
  )

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!shouldStartCanvasSurfaceInteraction(event.target)) return

      activeToolHandler.onCanvasPointerDown(event, toolHandlerContext)
    },
    [activeToolHandler, toolHandlerContext],
  )

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const groupResize = groupResizeRef.current
      if (groupResize?.pointerId === event.pointerId) {
        updateNodesGeometry(
          resizeGroupSelection(groupResize, event.clientX, event.clientY, viewportRef.current.scale, {
            centered: event.altKey,
          }).updates,
        )
        return
      }

      if (eraserDragRef.current?.pointerId === event.pointerId) {
        eraseAtClientPoint(event.clientX, event.clientY)
        return
      }

      const stampPlacement = stampPlacementRef.current
      if (stampPlacement?.pointerId === event.pointerId) {
        const point = screenToCanvas(event.clientX, event.clientY)
        setStampPlacementPreview({ x: point.x, y: point.y, stage: stampPlacement.stage })
        return
      }

      const selectionSpacingDrag = selectionSpacingDragRef.current
      if (selectionSpacingDrag?.pointerId === event.pointerId) {
        const { updates } = smartSelectionSpacingUpdates(
          selectionSpacingDrag,
          event.clientX,
          event.clientY,
          viewportRef.current.scale,
        )

        updateNodesGeometry(updates)
        return
      }

      const textCreation = textCreationRef.current
      if (textCreation?.pointerId === event.pointerId) {
        const point = screenToCanvas(event.clientX, event.clientY)
        textCreation.currentX = point.x
        textCreation.currentY = point.y
        setTextCreationBox({ ...textCreation })
        return
      }

      const frameCreation = frameCreationRef.current
      if (frameCreation?.pointerId === event.pointerId) {
        const point = screenToCanvas(event.clientX, event.clientY)
        frameCreation.currentX = point.x
        frameCreation.currentY = point.y
        setFrameCreationBox({ ...frameCreation })
        return
      }

      const markupCreation = markupCreationRef.current
      if (markupCreation?.pointerId === event.pointerId) {
        const rawPoint = screenToCanvas(event.clientX, event.clientY)
        const startPoint = { x: markupCreation.startX, y: markupCreation.startY }
        const point = constrainedMarkupPoint(markupCreation.kind, startPoint, rawPoint, event.shiftKey)
        markupCreation.currentX = point.x
        markupCreation.currentY = point.y
        if (markupCreation.kind === 'arrow' || markupCreation.kind === 'line') {
          const snap = nearestConnectorBindingForPoint(nodes, point)
          setActiveConnectorDropTargetId(snap?.binding.nodeId)
        }
        if (markupCreation.kind === 'brush') {
          if (event.shiftKey) {
            markupCreation.points = [startPoint, point]
            setMarkupCreationBox({ ...markupCreation, points: [...markupCreation.points] })
            return
          }

          const previousPoint = markupCreation.points.at(-1)
          const distance = previousPoint
            ? Math.abs(previousPoint.x - point.x) + Math.abs(previousPoint.y - point.y)
            : Number.POSITIVE_INFINITY
          if (distance > 2) {
            markupCreation.points.push(
              event.pointerType === 'pen' ? { ...point, pressure: event.pressure } : point,
            )
          }
        }
        setMarkupCreationBox({ ...markupCreation, points: [...markupCreation.points] })
        return
      }

      if (tryMoveNodeTransform(event)) return

      const markupPointTransform = markupPointTransformRef.current
      if (markupPointTransform?.pointerId === event.pointerId) {
        if (!markupPointTransform.historyCaptured) {
          captureHistory()
          markupPointTransform.historyCaptured = true
        }

        const dx = (event.clientX - markupPointTransform.startClientX) / viewportRef.current.scale
        const dy = (event.clientY - markupPointTransform.startClientY) / viewportRef.current.scale
        const startAbsolutePoints = markupPointTransform.startPoints.map((point) => ({
          x: markupPointTransform.startNode.x + point.x,
          y: markupPointTransform.startNode.y + point.y,
        }))
        const stationaryPoint = startAbsolutePoints[markupPointTransform.pointIndex === 0 ? 1 : 0]
        const rawMovingPoint = {
          x: startAbsolutePoints[markupPointTransform.pointIndex].x + dx,
          y: startAbsolutePoints[markupPointTransform.pointIndex].y + dy,
        }
        const movingPoint = event.shiftKey ? constrainAnglePoint(stationaryPoint, rawMovingPoint) : rawMovingPoint
        const snap = nearestConnectorBindingForPoint(nodes, movingPoint, {
          connectorNodeId: markupPointTransform.nodeId,
        })
        const snappedMovingPoint = snap?.point || movingPoint
        setActiveConnectorDropTargetId(snap?.binding.nodeId)
        const absolutePoints = startAbsolutePoints.map((point, index) =>
          index === markupPointTransform.pointIndex ? snappedMovingPoint : point,
        )
        const next = markupGeometryFromAbsolutePoints(absolutePoints)
        updateMarkupGeometry(
          markupPointTransform.nodeId,
          next.geometry,
          next.points,
          markupPointTransform.pointIndex === 0
            ? { connectorStart: snap?.binding || null }
            : { connectorEnd: snap?.binding || null },
        )
        return
      }

      const textResize = textResizeRef.current
      if (textResize?.pointerId === event.pointerId) {
        const node = nodes.find((item) => item.id === textResize.nodeId)
        if (!isEditableTextNode(node)) return

        if (!textResize.historyCaptured) {
          captureHistory()
          textResize.historyCaptured = true
        }

        const dx = (event.clientX - textResize.startClientX) / viewportRef.current.scale
        const rawWidth = textResize.edge === 'e' ? textResize.startWidth + dx : textResize.startWidth - dx
        const nextWidth = Math.min(540, Math.max(96, rawWidth))
        const nextX = textResize.edge === 'e' ? textResize.startX : textResize.startX + textResize.startWidth - nextWidth
        const nextHeight = textGeometryFor(
          node.text || '',
          node.fontSize || defaultTextFontSize,
          nextWidth,
          node.fontWeight || defaultTextWeight,
        ).height

        resizeTextNode(textResize.nodeId, nextX, nextWidth, nextHeight)
        return
      }

      if (tryMovePan(event)) return

      tryMoveSelection(event)
    },
    [
      captureHistory,
      eraseAtClientPoint,
      nodes,
      resizeTextNode,
      screenToCanvas,
      tryMoveNodeTransform,
      tryMovePan,
      tryMoveSelection,
      updateMarkupGeometry,
      updateNodesGeometry,
      viewportRef,
    ],
  )

  const handleCanvasPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (groupResizeRef.current?.pointerId === event.pointerId) {
        groupResizeRef.current = null
        setSnapGuides([])
      }

      if (selectionSpacingDragRef.current?.pointerId === event.pointerId) {
        selectionSpacingDragRef.current = null
      }

      if (textCreationRef.current?.pointerId === event.pointerId) {
        const textCreation = textCreationRef.current
        const rect = rectFromTextCreation(textCreation)
        const dragged = rect.width > 8 || rect.height > 8
        const width = dragged ? Math.max(96, rect.width) : 220
        const height = dragged ? Math.max(42, rect.height) : 42
        const x = dragged ? rect.x : textCreation.startX
        const y = dragged ? rect.y : textCreation.startY - defaultTextFontSize
        const id = addTextNode({ x, y })

        if (dragged) {
          resizeTextNode(id, x, width, height)
        }

        textCreationRef.current = null
        setTextCreationBox(null)
        setEditingTextNodeId(id)
        setActiveTool('select')
      }

      if (frameCreationRef.current?.pointerId === event.pointerId) {
        const frameCreation = frameCreationRef.current
        const rect = rectFromFrameCreation(frameCreation)
        const dragged = rect.width > 8 || rect.height > 8
        const width = dragged ? Math.max(180, rect.width) : 560
        const height = dragged ? Math.max(120, rect.height) : 320
        const x = dragged ? rect.x : frameCreation.startX
        const y = dragged ? rect.y : frameCreation.startY

        addFrameNode({ x, y }, { width, height })
        frameCreationRef.current = null
        setFrameCreationBox(null)
        setActiveTool('select')
      }

      if (markupCreationRef.current?.pointerId === event.pointerId) {
        const markupCreation = markupCreationRef.current
        const rect = rectFromMarkupCreation(markupCreation)
        const dragged = rect.width > 8 || rect.height > 8
        const width = dragged ? Math.max(18, rect.width) : markupCreation.kind === 'note' ? 180 : 160
        const height = dragged ? Math.max(18, rect.height) : markupCreation.kind === 'note' ? 108 : 96
        const x = dragged ? rect.x : markupCreation.startX - width / 2
        const y = dragged ? rect.y : markupCreation.startY - height / 2
        const fallbackBounds = { x, y, width, height }
        let points = dragged
          ? normalizeMarkupPoints(markupCreation, rect)
          : markupCreation.kind === 'arrow' || markupCreation.kind === 'line'
            ? [
                { x: 8, y: height - 8 },
                { x: width - 8, y: 8 },
              ]
            : markupCreation.kind === 'brush'
              ? [
                  { x: 12, y: height * 0.62 },
                  { x: width * 0.32, y: height * 0.25 },
                  { x: width * 0.56, y: height * 0.68 },
                  { x: width - 12, y: height * 0.3 },
                ]
              : normalizeMarkupPoints(markupCreation, fallbackBounds)

        let finalPosition = { x, y }
        let finalSize = { width, height }
        const connectorOptions: {
          connectorStart?: MivoCanvasNode['connectorStart']
          connectorEnd?: MivoCanvasNode['connectorEnd']
        } = {}

        if ((markupCreation.kind === 'arrow' || markupCreation.kind === 'line') && points && points.length >= 2) {
          const absolutePoints = points.slice(0, 2).map((point) => ({ x: x + point.x, y: y + point.y }))
          const startSnap = nearestConnectorBindingForPoint(nodes, absolutePoints[0])
          const endSnap = nearestConnectorBindingForPoint(nodes, absolutePoints[1])
          if (startSnap) {
            absolutePoints[0] = startSnap.point
            connectorOptions.connectorStart = startSnap.binding
          }
          if (endSnap) {
            absolutePoints[1] = endSnap.point
            connectorOptions.connectorEnd = endSnap.binding
          }
          const next = markupGeometryFromAbsolutePoints(absolutePoints)
          finalPosition = { x: next.geometry.x, y: next.geometry.y }
          finalSize = { width: next.geometry.width, height: next.geometry.height }
          points = next.points
        }

        const isBrush = markupCreation.kind === 'brush'
        const brushStyle = useCanvasStore.getState().brushStyle
        addMarkupNode(markupCreation.kind, finalPosition, finalSize, {
          points,
          select: false,
          ...(isBrush
            ? {
                strokeColor: brushStyle.color,
                strokeWidth: brushStyle.width,
                brushKind: brushStyle.kind === 'highlighter' ? ('highlighter' as const) : ('marker' as const),
              }
            : {}),
          ...connectorOptions,
        })
        markupCreationRef.current = null
        setMarkupCreationBox(null)
        setActiveConnectorDropTargetId(undefined)
        // Brush stays active for continuous strokes (FigJam/Excalidraw convention); Esc or V exits.
        if (!isBrush) setActiveTool('select')
      }

      tryEndNodeTransform(event)

      if (textResizeRef.current?.pointerId === event.pointerId) {
        textResizeRef.current = null
      }

      if (markupPointTransformRef.current?.pointerId === event.pointerId) {
        markupPointTransformRef.current = null
        setActiveConnectorDropTargetId(undefined)
      }

      if (eraserDragRef.current?.pointerId === event.pointerId) {
        eraserDragRef.current = null
      }

      if (stampPlacementRef.current?.pointerId === event.pointerId) {
        if (event.type === 'pointerup') {
          const placement = stampPlacementRef.current
          const point = screenToCanvas(event.clientX, event.clientY)
          const size = stampGrowthSizes[placement.stage]
          const placedStampId = addMarkupNode(
            'stamp',
            { x: point.x - size / 2, y: point.y - size / 2 },
            { width: size, height: size },
            { stampKind: useCanvasStore.getState().activeStampKind, select: false },
          )
          noteStampPlaced(placedStampId)
        }
        // Stamp stays active for continuous stamping (FigJam convention); Esc or V exits.
        clearStampPlacement()
      }

      tryEndPan(event)

      tryEndSelection(event)
    },
    [
      addFrameNode,
      addMarkupNode,
      addTextNode,
      clearStampPlacement,
      nodes,
      noteStampPlaced,
      resizeTextNode,
      screenToCanvas,
      setActiveTool,
      tryEndNodeTransform,
      tryEndPan,
      tryEndSelection,
    ],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditingTarget(event.target)) return

      const modifier = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (event.code === 'Space') {
        event.preventDefault()
        if (!event.repeat) setTemporaryTool('hand')
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        if (maskEditNodeId) {
          onCancelMaskEdit?.()
          return
        }
        onCloseContextMenu()
        resetMarquee()
        resetNodeTransform()
        textCreationRef.current = null
        frameCreationRef.current = null
        markupCreationRef.current = null
        markupPointTransformRef.current = null
        groupResizeRef.current = null
        selectionSpacingDragRef.current = null
        eraserDragRef.current = null
        if (stampPlacementRef.current) {
          window.clearInterval(stampPlacementRef.current.growTimer)
          stampPlacementRef.current = null
        }
        setStampPlacementPreview(null)
        textResizeRef.current = null
        setEditingTextNodeId(undefined)
        setTextCreationBox(null)
        setFrameCreationBox(null)
        setMarkupCreationBox(null)
        setSnapGuides([])
        setActiveConnectorDropTargetId(undefined)
        selectNode(undefined)
        if (useCanvasStore.getState().activeTool !== 'select') setActiveTool('select')
        return
      }

      if (modifier && (event.key === '=' || event.key === '+' || event.code === 'Equal')) {
        event.preventDefault()
        zoomBy(1.12)
        return
      }

      if (modifier && (event.key === '-' || event.code === 'Minus')) {
        event.preventDefault()
        zoomBy(1 / 1.12)
        return
      }

      if (modifier && event.code === 'Digit0') {
        event.preventDefault()
        resetView()
        return
      }

      if (!modifier && event.shiftKey && event.code === 'Digit1') {
        event.preventDefault()
        fitAll()
        return
      }

      if (!modifier && event.shiftKey && event.code === 'Digit2') {
        event.preventDefault()
        fitSelection()
        return
      }

      if (modifier && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }

      if (modifier && key === 'a') {
        event.preventDefault()
        // Read nodes via getState so this effect does not re-subscribe on every node change.
        const allNodes = useCanvasStore.getState().nodes
        selectNodes(allNodes.filter((node) => !node.hidden).map((node) => node.id))
        return
      }

      if (modifier && key === 'c') {
        event.preventDefault()
        copySelectedNodes()
        return
      }

      if (modifier && key === 'x') {
        event.preventDefault()
        cutSelectedNodes()
        return
      }

      if (modifier && key === 'g') {
        event.preventDefault()
        if (event.shiftKey) ungroupSelectedNodes()
        else groupSelectedNodes()
        return
      }

      if (modifier && key === 'd') {
        event.preventDefault()
        duplicateSelectedNodes()
        return
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        deleteSelectedNodes()
        return
      }

      if (event.key === '[') {
        event.preventDefault()
        moveSelectedLayer(event.shiftKey ? 'back' : 'backward')
        return
      }

      if (event.key === ']') {
        event.preventDefault()
        moveSelectedLayer(event.shiftKey ? 'front' : 'forward')
        return
      }

      if (!modifier && key === 'e') {
        event.preventDefault()
        const store = useCanvasStore.getState()
        store.setActiveTool('markup-brush')
        if (store.brushStyle.kind !== 'eraser') store.setBrushStyle({ kind: 'eraser' })
        return
      }

      const shortcutTool = modifier ? undefined : toolForKeyboardShortcut(key)
      if (shortcutTool) {
        event.preventDefault()
        setActiveTool(shortcutTool)
        if (shortcutTool === 'markup-brush') {
          // P always means "draw": leaving eraser mode goes back to the marker.
          const store = useCanvasStore.getState()
          if (store.brushStyle.kind === 'eraser') store.setBrushStyle({ kind: 'marker' })
        }
        return
      }

      const arrowDelta = event.shiftKey ? 10 : 1
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        moveSelectedNodesBy(-arrowDelta, 0)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        moveSelectedNodesBy(arrowDelta, 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveSelectedNodesBy(0, -arrowDelta)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveSelectedNodesBy(0, arrowDelta)
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault()
        setTemporaryTool(undefined)
      }
    }

    const handleWindowBlur = () => {
      setTemporaryTool(undefined)
      resetPan()
      resetMarquee()
      resetNodeTransform()
      setEditingTextNodeId(undefined)
      textCreationRef.current = null
      setTextCreationBox(null)
      frameCreationRef.current = null
      setFrameCreationBox(null)
      markupCreationRef.current = null
      setMarkupCreationBox(null)
      markupPointTransformRef.current = null
      eraserDragRef.current = null
      if (stampPlacementRef.current) {
        window.clearInterval(stampPlacementRef.current.growTimer)
        stampPlacementRef.current = null
      }
      setStampPlacementPreview(null)
      textResizeRef.current = null
      setActiveConnectorDropTargetId(undefined)
    }

    const handlePaste = async (event: ClipboardEvent) => {
      if (isEditingTarget(event.target)) return

      if (useCanvasStore.getState().clipboardAssets.length) {
        event.preventDefault()
        pasteClipboardAssets(viewportCenter())
        return
      }

      const items = Array.from(event.clipboardData?.items || [])
      const imageItem = items.find((item) => item.type.startsWith('image/'))

      if (imageItem) {
        const file = imageItem.getAsFile()
        if (!file) return

        event.preventDefault()
        const namedFile = file.name
          ? file
          : new File([file], `clipboard-${Date.now()}.png`, { type: file.type || 'image/png' })
        const center = viewportCenter()
        await importImageFileToCanvas({
          file: namedFile,
          position: center,
          addImportedImage,
        })
        return
      }

      if (useCanvasStore.getState().clipboardNodes.length) {
        event.preventDefault()
        pasteClipboardNodes()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('paste', handlePaste)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('paste', handlePaste)
    }
  }, [
    addFrameNode,
    addImportedImage,
    copySelectedNodes,
    cutSelectedNodes,
    deleteSelectedNodes,
    duplicateSelectedNodes,
    fitAll,
    fitSelection,
    maskEditNodeId,
    groupSelectedNodes,
    moveSelectedLayer,
    moveSelectedNodesBy,
    onCancelMaskEdit,
    onCloseContextMenu,
    pasteClipboardNodes,
    pasteClipboardAssets,
    redo,
    resetMarquee,
    resetNodeTransform,
    resetPan,
    resetView,
    selectNode,
    selectNodes,
    setActiveTool,
    undo,
    ungroupSelectedNodes,
    viewportCenter,
    zoomBy,
  ])

  // Scene reset: single rAF (preserves the original structure) resets the viewport
  // hook + marquee + node-transform hooks + the remaining interaction state/refs.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      resetViewportForScene(sceneId)
      resetMarquee()
      resetNodeTransform()
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      setTextCreationBox(null)
      setFrameCreationBox(null)
      setMarkupCreationBox(null)
      setStampPlacementPreview(null)
      setTemporaryTool(undefined)
      setEditingTextNodeId(undefined)
      textCreationRef.current = null
      frameCreationRef.current = null
      markupCreationRef.current = null
      markupPointTransformRef.current = null
      textResizeRef.current = null
      groupResizeRef.current = null
      selectionSpacingDragRef.current = null
      eraserDragRef.current = null
      if (stampPlacementRef.current) {
        window.clearInterval(stampPlacementRef.current.growTimer)
        stampPlacementRef.current = null
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [sceneId, resetMarquee, resetNodeTransform, resetViewportForScene])

  const selectionRect = selectionBox ? selectionRectFromBox(selectionBox) : undefined
  const activeSelectionRect = selectionRect && isActiveSelectionRect(selectionRect) ? selectionRect : undefined
  const activeTextCreationRect = textCreationBox ? rectFromTextCreation(textCreationBox) : undefined
  const activeFrameCreationRect = frameCreationBox ? rectFromFrameCreation(frameCreationBox) : undefined
  const activeMarkupCreationRect = markupCreationBox ? rectFromMarkupCreation(markupCreationBox) : undefined
  const selectionPreviewSet = previewIdsFromSelectionBox(selectionBox, nodes)

  return {
    viewport,
    snapGuides,
    selectionBox,
    isPanning,
    temporaryTool,
    editingTextNodeId,
    interactionMode,
    selectedNodes,
    selectedBounds,
    selectionSpacingHandles,
    activeSectionDropTargetId,
    activeConnectorDropTargetId,
    showGroupSelectionBounds,
    activeSelectionRect,
    activeTextCreationRect,
    activeFrameCreationRect,
    activeMarkupCreationRect,
    markupCreationBox,
    stampPlacementPreview,
    selectionPreviewSet,
    beginGroupResize,
    beginSelectionSpacingDrag,
    beginNodePointerDown,
    beginNodeResize,
    editTextNode,
    beginTextResize,
    beginMarkupPointMove,
    updateEditingText,
    finishTextEditing,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerEnd,
    handleWheel,
    zoomBy,
    fit,
    fitAll,
    fitSelection,
    resetView,
  }
}
