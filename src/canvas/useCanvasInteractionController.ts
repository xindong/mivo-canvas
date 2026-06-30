import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { importImageFileToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'
import type { CanvasId, MarkupKind, MarkupPoint, MivoCanvasNode } from '../types/mivoCanvas'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'
import { nearestConnectorBindingForPoint } from './connectorGeometry'
import {
  boundsForNodes,
  clientPointToCanvas,
  clampViewportScale,
  createGroupResizeState,
  createNodeMoveState,
  createNodeResizeState,
  createPanState,
  createSelectionBox,
  isActiveSelectionRect,
  isEditingTarget,
  moveNodeTransform,
  normalizedWheelDelta,
  previewIdsFromSelectionBox,
  resizeGroupSelection,
  resizeNodeTransform,
  runtimeToolFor,
  selectedIdsFromSelectionBox,
  selectionRectFromBox,
  shouldCommitNodeTransform,
  shouldStartCanvasSurfaceInteraction,
  viewportCenterPoint,
  viewportForBounds,
  viewportFromPan,
  viewportFromZoom,
  type GroupResizeState,
  type CanvasBounds,
  type NodeTransformState,
  type PanState,
  type RuntimeCanvasTool,
  type SelectionBox,
  type Viewport,
} from './canvasInteraction'
import { canvasToolHandlers, type CanvasToolHandlerContext } from './canvasToolHandlers'
import { isCanvasToolEnabled, markupKindForTool, toolForKeyboardShortcut } from './canvasToolRegistry'
import { defaultTextFontSize, defaultTextWeight, textGeometryFor } from './textGeometry'

type UseCanvasInteractionControllerOptions = {
  shellRef: RefObject<HTMLElement | null>
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  selectedNodeIds: string[]
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

export const defaultViewportFor = (sceneId: string): Viewport => ({
  x: 420,
  y: 240,
  scale: sceneId === 'stress-test' ? 0.62 : 1,
})

const viewportStorageKey = (sceneId: CanvasId) => `mivo-canvas-viewport:${sceneId}`

const persistedViewportFor = (sceneId: CanvasId): Viewport | undefined => {
  try {
    const rawViewport = window.localStorage.getItem(viewportStorageKey(sceneId))
    if (!rawViewport) return undefined

    const viewport = JSON.parse(rawViewport) as Partial<Viewport>
    if (
      typeof viewport.x !== 'number' ||
      typeof viewport.y !== 'number' ||
      typeof viewport.scale !== 'number'
    ) {
      return undefined
    }

    return {
      x: viewport.x,
      y: viewport.y,
      scale: clampViewportScale(viewport.scale),
    }
  } catch {
    return undefined
  }
}

const initialViewportFor = (sceneId: CanvasId) => persistedViewportFor(sceneId) || defaultViewportFor(sceneId)

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

const rectFromMarkupCreation = (box: MarkupCreationState): CanvasBounds => ({
  x: Math.min(box.startX, box.currentX),
  y: Math.min(box.startY, box.currentY),
  width: Math.abs(box.currentX - box.startX),
  height: Math.abs(box.currentY - box.startY),
})

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

const isNodeEffectivelyLocked = (node: MivoCanvasNode, nodes: MivoCanvasNode[]) => {
  const section = node.sectionId ? nodes.find((item) => item.id === node.sectionId && item.type === 'frame') : undefined
  return Boolean(node.locked || section?.sectionLockMode === 'all')
}

const isEditableTextNode = (
  node: MivoCanvasNode | undefined,
): node is MivoCanvasNode & { type: 'text' | 'annotation' | 'markup' } =>
  node?.type === 'text' || node?.type === 'annotation' || node?.type === 'markup'

const isAutoDeletedEmptyTextNode = (
  node: MivoCanvasNode | undefined,
): node is MivoCanvasNode & { type: 'text' | 'annotation' } =>
  node?.type === 'text' || node?.type === 'annotation'

export function useCanvasInteractionController({
  shellRef,
  sceneId,
  nodes,
  selectedNodeIds,
  onCloseContextMenu,
}: UseCanvasInteractionControllerOptions) {
  const viewportRef = useRef<Viewport>(initialViewportFor(sceneId))
  const panRef = useRef<PanState | null>(null)
  const selectionRef = useRef<SelectionBox | null>(null)
  const textCreationRef = useRef<TextCreationState | null>(null)
  const frameCreationRef = useRef<FrameCreationState | null>(null)
  const markupCreationRef = useRef<MarkupCreationState | null>(null)
  const nodeTransformRef = useRef<NodeTransformState | null>(null)
  const markupPointTransformRef = useRef<MarkupPointTransformState | null>(null)
  const textResizeRef = useRef<TextResizeState | null>(null)
  const groupResizeRef = useRef<GroupResizeState | null>(null)
  const persistedSceneRef = useRef(sceneId)
  const [viewport, setViewport] = useState(() => initialViewportFor(sceneId))
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [activeSectionDropTargetId, setActiveSectionDropTargetId] = useState<string | undefined>()
  const [activeConnectorDropTargetId, setActiveConnectorDropTargetId] = useState<string | undefined>()
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const [textCreationBox, setTextCreationBox] = useState<TextCreationState | null>(null)
  const [frameCreationBox, setFrameCreationBox] = useState<FrameCreationState | null>(null)
  const [markupCreationBox, setMarkupCreationBox] = useState<MarkupCreationState | null>(null)
  const [isPanning, setIsPanning] = useState(false)
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
  const pasteClipboardNodes = useCanvasStore((state) => state.pasteClipboardNodes)
  const deleteSelectedNodes = useCanvasStore((state) => state.deleteSelectedNodes)
  const duplicateSelectedNodes = useCanvasStore((state) => state.duplicateSelectedNodes)
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addFrameNode = useCanvasStore((state) => state.addFrameNode)
  const addMarkupNode = useCanvasStore((state) => state.addMarkupNode)
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
  const selectedBounds = selectedNodes.length > 1 ? boundsForNodes(selectedNodes) : undefined
  const showGroupSelectionBounds =
    interactionMode === 'select' &&
    !selectionBox &&
    Boolean(selectedBounds) &&
    selectedNodes.some((node) => !isNodeEffectivelyLocked(node, nodes))

  useEffect(() => {
    viewportRef.current = viewport
    const shell = shellRef.current
    if (shell && (shell.scrollLeft !== 0 || shell.scrollTop !== 0)) {
      shell.scrollLeft = 0
      shell.scrollTop = 0
    }
  }, [shellRef, viewport])

  useEffect(() => {
    if (persistedSceneRef.current !== sceneId) return
    window.localStorage.setItem(viewportStorageKey(sceneId), JSON.stringify(viewport))
  }, [sceneId, viewport])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return undefined

    const preventNativeWheelDefault = (event: WheelEvent) => {
      event.preventDefault()
    }

    shell.addEventListener('wheel', preventNativeWheelDefault, { passive: false })

    return () => {
      shell.removeEventListener('wheel', preventNativeWheelDefault)
    }
  }, [shellRef])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      persistedSceneRef.current = sceneId
      setViewport(initialViewportFor(sceneId))
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      setSelectionBox(null)
      setTextCreationBox(null)
      setFrameCreationBox(null)
      setMarkupCreationBox(null)
      setIsPanning(false)
      setTemporaryTool(undefined)
      setEditingTextNodeId(undefined)
      panRef.current = null
      selectionRef.current = null
      textCreationRef.current = null
      frameCreationRef.current = null
      markupCreationRef.current = null
      markupPointTransformRef.current = null
      nodeTransformRef.current = null
      textResizeRef.current = null
      groupResizeRef.current = null
    })

    return () => window.cancelAnimationFrame(frame)
  }, [sceneId])

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number, sourceViewport = viewportRef.current) => {
      const rect = shellRef.current?.getBoundingClientRect()
      return clientPointToCanvas(rect, sourceViewport, clientX, clientY)
    },
    [shellRef],
  )

  const viewportCenter = useCallback(() => {
    const rect = shellRef.current?.getBoundingClientRect()
    return viewportCenterPoint(rect, viewportRef.current)
  }, [shellRef])

  const zoomTo = useCallback(
    (nextScale: number, center?: { clientX: number; clientY: number }) => {
      setViewport((current) => {
        const rect = shellRef.current?.getBoundingClientRect()
        return viewportFromZoom(current, rect, nextScale, center)
      })
    },
    [shellRef],
  )

  const zoomBy = useCallback(
    (factor: number, center?: { clientX: number; clientY: number }) => {
      zoomTo(viewportRef.current.scale * factor, center)
    },
    [zoomTo],
  )

  const fitToBounds = useCallback(
    (bounds: CanvasBounds | undefined) => {
      const rect = shellRef.current?.getBoundingClientRect()
      const nextViewport = bounds ? viewportForBounds(bounds, rect) : undefined

      setViewport(nextViewport || defaultViewportFor(sceneId))
    },
    [sceneId, shellRef],
  )

  const fitAll = useCallback(() => {
    fitToBounds(boundsForNodes(nodes.filter((node) => !node.hidden)))
  }, [fitToBounds, nodes])

  const fitSelection = useCallback(() => {
    const visibleNodes = nodes.filter((node) => !node.hidden)
    fitToBounds(boundsForNodes(selectedNodes.length ? selectedNodes : visibleNodes))
  }, [fitToBounds, nodes, selectedNodes])

  const fit = fitSelection

  const sectionDropTargetFor = useCallback(
    (movingNode: MivoCanvasNode, nextX: number, nextY: number) => {
      if (movingNode.type === 'frame') return undefined

      const selectedSet = new Set(selectedNodeIds.includes(movingNode.id) ? selectedNodeIds : [movingNode.id])
      if (nodes.some((node) => selectedSet.has(node.id) && node.type === 'frame')) return undefined

      const dx = nextX - movingNode.x
      const dy = nextY - movingNode.y
      const movingNodes = nodes.filter((node) => selectedSet.has(node.id) && node.type !== 'frame' && !node.hidden)
      const projectedCenters = (movingNodes.length ? movingNodes : [movingNode]).map((node) => ({
        x: node.x + dx + node.width / 2,
        y: node.y + dy + node.height / 2,
      }))

      return nodes
        .filter(
          (node) =>
            node.type === 'frame' &&
            !node.hidden &&
            !selectedSet.has(node.id) &&
            projectedCenters.every(
              (center) =>
                center.x >= node.x &&
                center.x <= node.x + node.width &&
                center.y >= node.y &&
                center.y <= node.y + node.height,
            ),
        )
        .at(-1)?.id
    },
    [nodes, selectedNodeIds],
  )

  const resetView = useCallback(() => {
    setViewport(defaultViewportFor(sceneId))
  }, [sceneId])

  const finishSelection = useCallback(() => {
    const current = selectionRef.current
    if (!current) return

    selectNodes(selectedIdsFromSelectionBox(current, nodes))

    selectionRef.current = null
    setSelectionBox(null)
  }, [nodes, selectNodes])

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

  const beginPan = useCallback(
    (event: ReactPointerEvent<HTMLElement>, options?: { clearSelection?: boolean }) => {
      if (event.button !== 0 && event.button !== 1) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      selectionRef.current = null
      setSelectionBox(null)
      setIsPanning(true)
      panRef.current = createPanState(event.pointerId, event.clientX, event.clientY, viewportRef.current)

      if (options?.clearSelection) {
        selectNode(undefined)
      }
    },
    [discardEmptyEditingText, onCloseContextMenu, selectNode],
  )

  const beginSelection = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)

      const point = screenToCanvas(event.clientX, event.clientY)
      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      selectionRef.current = createSelectionBox(event.pointerId, point, additive, selectedNodeIds)
      setSelectionBox(selectionRef.current)

      if (!additive) {
        selectNode(undefined)
      }
    },
    [discardEmptyEditingText, onCloseContextMenu, screenToCanvas, selectNode, selectedNodeIds],
  )

  const beginGroupResize = useCallback(
    (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !selectedBounds || selectedNodes.length < 2) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
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
    [captureHistory, discardEmptyEditingText, onCloseContextMenu, selectedBounds, selectedNodes],
  )

  const beginNodeMove = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      selectionRef.current = null
      setSelectionBox(null)

      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      const alreadySelected = selectedNodeIds.includes(nodeId)
      const shouldPreserveMultiSelection = !additive && alreadySelected && selectedNodeIds.length > 1
      const shouldEditTextOnClick =
        !additive && alreadySelected && selectedNodeIds.length === 1 && isAutoDeletedEmptyTextNode(node)

      if (additive) {
        selectNode(nodeId, { additive: true })
      } else if (shouldPreserveMultiSelection) {
        selectNodes(selectedNodeIds, nodeId)
      } else {
        selectNode(nodeId)
      }

      if (isNodeEffectivelyLocked(node, nodes)) return

      nodeTransformRef.current = createNodeMoveState(node, event.pointerId, event.clientX, event.clientY, {
        collapseSelectionOnClick: shouldPreserveMultiSelection,
        editTextOnClick: shouldEditTextOnClick,
      })
    },
    [discardEmptyEditingText, nodes, onCloseContextMenu, selectNode, selectNodes, selectedNodeIds],
  )

  const startNodeResize = useCallback(
    (nodeId: string, corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return

      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      onCloseContextMenu()
      discardEmptyEditingText()
      setEditingTextNodeId(undefined)
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
      selectionRef.current = null
      setSelectionBox(null)
      selectNode(nodeId)
      if (isNodeEffectivelyLocked(node, nodes)) return

      nodeTransformRef.current = createNodeResizeState(node, event.pointerId, corner, event.clientX, event.clientY)
    },
    [discardEmptyEditingText, nodes, onCloseContextMenu, selectNode],
  )

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
      setSelectionBox(null)
      selectionRef.current = null
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
    [discardEmptyEditingText, onCloseContextMenu, screenToCanvas, selectNode],
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
      setSelectionBox(null)
      selectionRef.current = null

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
    [discardEmptyEditingText, onCloseContextMenu, screenToCanvas],
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
      setSelectionBox(null)
      selectionRef.current = null

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
    [discardEmptyEditingText, onCloseContextMenu, screenToCanvas],
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
      beginTextEdit,
    }),
    [beginFrameBox, beginMarkupBox, beginNodeMove, beginPan, beginSelection, beginTextBox, beginTextEdit, startNodeResize],
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
        updateNodesGeometry(resizeGroupSelection(groupResize, event.clientX, event.clientY, viewportRef.current.scale).updates)
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
          if (distance > 2) markupCreation.points.push(point)
        }
        setMarkupCreationBox({ ...markupCreation, points: [...markupCreation.points] })
        return
      }

      const nodeTransform = nodeTransformRef.current
      if (nodeTransform?.pointerId === event.pointerId) {
        const node = nodes.find((item) => item.id === nodeTransform.nodeId)
        if (!node) return

        const didCommit = shouldCommitNodeTransform(nodeTransform, event.clientX, event.clientY)
        if (didCommit && !nodeTransform.historyCaptured) {
          captureHistory()
          nodeTransform.historyCaptured = true
        }

        if (nodeTransform.mode === 'move') {
          if (didCommit) nodeTransform.moved = true
          const snapped = moveNodeTransform(
            nodeTransform,
            node,
            nodes,
            event.clientX,
            event.clientY,
            viewportRef.current.scale,
          )
          setSnapGuides(snapped.guides)
          setActiveSectionDropTargetId(sectionDropTargetFor(node, snapped.x, snapped.y))
          updateSelectedNodesPosition(nodeTransform.nodeId, snapped.x, snapped.y)
        } else {
          const snapped = resizeNodeTransform(
            nodeTransform,
            node,
            nodes,
            event.clientX,
            event.clientY,
            viewportRef.current.scale,
          )
          setSnapGuides(snapped.guides)
          setActiveSectionDropTargetId(undefined)
      setActiveConnectorDropTargetId(undefined)
          updateNodeGeometry(nodeTransform.nodeId, snapped.x, snapped.y, snapped.width, snapped.height)
        }

        return
      }

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

      const pan = panRef.current
      if (pan?.pointerId === event.pointerId) {
        setViewport((current) => viewportFromPan(pan, event.clientX, event.clientY, current))
        return
      }

      const selection = selectionRef.current
      if (selection?.pointerId === event.pointerId) {
        const point = screenToCanvas(event.clientX, event.clientY)
        selection.currentX = point.x
        selection.currentY = point.y
        setSelectionBox({ ...selection })
      }
    },
    [
      captureHistory,
      nodes,
      resizeTextNode,
      screenToCanvas,
      updateNodeGeometry,
      updateMarkupGeometry,
      updateNodesGeometry,
      updateSelectedNodesPosition,
      sectionDropTargetFor,
    ],
  )

  const handleCanvasPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (groupResizeRef.current?.pointerId === event.pointerId) {
        groupResizeRef.current = null
        setSnapGuides([])
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

        addMarkupNode(markupCreation.kind, finalPosition, finalSize, { points, select: false, ...connectorOptions })
        markupCreationRef.current = null
        setMarkupCreationBox(null)
        setActiveConnectorDropTargetId(undefined)
        setActiveTool('select')
      }

      if (nodeTransformRef.current?.pointerId === event.pointerId) {
        const nodeTransform = nodeTransformRef.current
        nodeTransformRef.current = null
        setSnapGuides([])
        setActiveSectionDropTargetId(undefined)
        setActiveConnectorDropTargetId(undefined)

        if (nodeTransform.mode === 'move' && nodeTransform.collapseSelectionOnClick && !nodeTransform.moved) {
          selectNode(nodeTransform.nodeId)
        }

        if (nodeTransform.mode === 'move' && nodeTransform.editTextOnClick && !nodeTransform.moved) {
          editTextNode(nodeTransform.nodeId)
        }
      }

      if (textResizeRef.current?.pointerId === event.pointerId) {
        textResizeRef.current = null
      }

      if (markupPointTransformRef.current?.pointerId === event.pointerId) {
        markupPointTransformRef.current = null
        setActiveConnectorDropTargetId(undefined)
      }

      if (panRef.current?.pointerId === event.pointerId) {
        panRef.current = null
        setIsPanning(false)
      }

      if (selectionRef.current?.pointerId === event.pointerId) {
        finishSelection()
      }
    },
    [
      addFrameNode,
      addMarkupNode,
      addTextNode,
      editTextNode,
      finishSelection,
      nodes,
      resizeTextNode,
      selectNode,
      setActiveTool,
    ],
  )

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      onCloseContextMenu()

      const delta = normalizedWheelDelta(event.nativeEvent)
      if (event.ctrlKey || event.metaKey) {
        zoomBy(Math.exp(-delta.y * 0.002), { clientX: event.clientX, clientY: event.clientY })
        return
      }

      const deltaX = event.shiftKey && delta.x === 0 ? delta.y : delta.x
      const deltaY = event.shiftKey && delta.x === 0 ? 0 : delta.y
      setViewport((current) => ({
        ...current,
        x: current.x - deltaX,
        y: current.y - deltaY,
      }))
    },
    [onCloseContextMenu, zoomBy],
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
        onCloseContextMenu()
        selectionRef.current = null
        textCreationRef.current = null
        frameCreationRef.current = null
        markupCreationRef.current = null
        markupPointTransformRef.current = null
        groupResizeRef.current = null
        nodeTransformRef.current = null
        textResizeRef.current = null
        setEditingTextNodeId(undefined)
        setSelectionBox(null)
        setTextCreationBox(null)
        setFrameCreationBox(null)
        setMarkupCreationBox(null)
        setSnapGuides([])
        setActiveConnectorDropTargetId(undefined)
        selectNode(undefined)
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

      if (modifier && key === 'c') {
        event.preventDefault()
        copySelectedNodes()
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

      const shortcutTool = modifier ? undefined : toolForKeyboardShortcut(key)
      if (shortcutTool) {
        event.preventDefault()
        setActiveTool(shortcutTool)
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
      setIsPanning(false)
      setEditingTextNodeId(undefined)
      panRef.current = null
      textCreationRef.current = null
      setTextCreationBox(null)
      frameCreationRef.current = null
      setFrameCreationBox(null)
      markupCreationRef.current = null
      setMarkupCreationBox(null)
      markupPointTransformRef.current = null
      nodeTransformRef.current = null
      textResizeRef.current = null
      setActiveConnectorDropTargetId(undefined)
    }

    const handlePaste = async (event: ClipboardEvent) => {
      if (isEditingTarget(event.target)) return

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
    deleteSelectedNodes,
    deleteNode,
    duplicateSelectedNodes,
    fitAll,
    fitSelection,
    moveSelectedLayer,
    moveSelectedNodesBy,
    onCloseContextMenu,
    pasteClipboardNodes,
    redo,
    resetView,
    selectNode,
    setActiveTool,
    undo,
    resizeTextNode,
    updateMarkupGeometry,
    updateTextNode,
    viewportCenter,
    zoomBy,
  ])

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
    activeSectionDropTargetId,
    activeConnectorDropTargetId,
    showGroupSelectionBounds,
    activeSelectionRect,
    activeTextCreationRect,
    activeFrameCreationRect,
    activeMarkupCreationRect,
    markupCreationBox,
    selectionPreviewSet,
    beginGroupResize,
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
