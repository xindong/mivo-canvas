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
import { saveImportedAsset } from '../lib/assetStorage'
import { importedImageDisplaySize } from '../lib/imageSizing'
import { useCanvasStore } from '../store/canvasStore'
import type { CanvasId, MivoCanvasNode } from '../types/mivoCanvas'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'
import {
  boundsForNodes,
  clientPointToCanvas,
  createGroupResizeState,
  createNodeMoveState,
  createNodeResizeState,
  createPanState,
  createSelectionBox,
  isActiveSelectionRect,
  isEditingTarget,
  moveNodeTransform,
  previewIdsFromSelectionBox,
  resizeGroupSelection,
  resizeNodeTransform,
  runtimeToolFor,
  selectedIdsFromSelectionBox,
  selectionRectFromBox,
  shouldCommitNodeTransform,
  shouldStartCanvasSurfaceInteraction,
  viewportCenterPoint,
  viewportFromPan,
  type GroupResizeState,
  type CanvasBounds,
  type NodeTransformState,
  type PanState,
  type RuntimeCanvasTool,
  type SelectionBox,
  type Viewport,
} from './canvasInteraction'
import { canvasToolHandlers, type CanvasToolHandlerContext } from './canvasToolHandlers'
import { isCanvasToolEnabled, toolForKeyboardShortcut } from './canvasToolRegistry'
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

const minScale = 0.18
const maxScale = 2.4

export const defaultViewportFor = (sceneId: string): Viewport => ({
  x: 420,
  y: 240,
  scale: sceneId === 'stress-test' ? 0.62 : 1,
})

const clampScale = (scale: number) => Math.min(maxScale, Math.max(minScale, Number(scale.toFixed(3))))

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
      scale: clampScale(viewport.scale),
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

const isNodeEffectivelyLocked = (node: MivoCanvasNode, nodes: MivoCanvasNode[]) => {
  const section = node.sectionId ? nodes.find((item) => item.id === node.sectionId && item.type === 'frame') : undefined
  return Boolean(node.locked || section?.sectionLockMode === 'all')
}

const isEditableTextNode = (node: MivoCanvasNode | undefined): node is MivoCanvasNode & { type: 'text' | 'annotation' } =>
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
  const nodeTransformRef = useRef<NodeTransformState | null>(null)
  const textResizeRef = useRef<TextResizeState | null>(null)
  const groupResizeRef = useRef<GroupResizeState | null>(null)
  const persistedSceneRef = useRef(sceneId)
  const [viewport, setViewport] = useState(() => initialViewportFor(sceneId))
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [activeSectionDropTargetId, setActiveSectionDropTargetId] = useState<string | undefined>()
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const [textCreationBox, setTextCreationBox] = useState<TextCreationState | null>(null)
  const [frameCreationBox, setFrameCreationBox] = useState<FrameCreationState | null>(null)
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
  }, [viewport])

  useEffect(() => {
    if (persistedSceneRef.current !== sceneId) return
    window.localStorage.setItem(viewportStorageKey(sceneId), JSON.stringify(viewport))
  }, [sceneId, viewport])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      persistedSceneRef.current = sceneId
      setViewport(initialViewportFor(sceneId))
      setSnapGuides([])
      setActiveSectionDropTargetId(undefined)
      setSelectionBox(null)
      setTextCreationBox(null)
      setFrameCreationBox(null)
      setIsPanning(false)
      setTemporaryTool(undefined)
      setEditingTextNodeId(undefined)
      panRef.current = null
      selectionRef.current = null
      textCreationRef.current = null
      frameCreationRef.current = null
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
        if (!rect) return current

        const scale = clampScale(nextScale)
        const clientX = center?.clientX ?? rect.left + rect.width / 2
        const clientY = center?.clientY ?? rect.top + rect.height / 2
        const canvasX = (clientX - rect.left - current.x) / current.scale
        const canvasY = (clientY - rect.top - current.y) / current.scale

        return {
          x: clientX - rect.left - canvasX * scale,
          y: clientY - rect.top - canvasY * scale,
          scale,
        }
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

  const fitToBounds = useCallback((bounds: CanvasBounds | undefined) => {
    const rect = shellRef.current?.getBoundingClientRect()
    if (!rect || !bounds) {
      setViewport(defaultViewportFor(sceneId))
      return
    }

    const padding = 180
    const scale = clampScale(
      Math.min((rect.width - padding) / Math.max(bounds.width, 1), (rect.height - padding) / Math.max(bounds.height, 1)),
    )

    setViewport({
      scale,
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: rect.height / 2 - (bounds.y + bounds.height / 2) * scale,
    })
  }, [sceneId, shellRef])

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
      if (isEditableTextNode(node) && !node.text?.trim()) {
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
      selectionRef.current = null
      setSelectionBox(null)

      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      const alreadySelected = selectedNodeIds.includes(nodeId)
      const shouldPreserveMultiSelection = !additive && alreadySelected && selectedNodeIds.length > 1
      const shouldEditTextOnClick = !additive && alreadySelected && selectedNodeIds.length === 1 && isEditableTextNode(node)

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
    [discardEmptyEditingText, onCloseContextMenu, screenToCanvas],
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
      if (isEditableTextNode(node) && !node.text?.trim()) {
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
      beginTextEdit,
    }),
    [beginFrameBox, beginNodeMove, beginPan, beginSelection, beginTextBox, beginTextEdit, startNodeResize],
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
          updateNodeGeometry(nodeTransform.nodeId, snapped.x, snapped.y, snapped.width, snapped.height)
        }

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

      if (nodeTransformRef.current?.pointerId === event.pointerId) {
        const nodeTransform = nodeTransformRef.current
        nodeTransformRef.current = null
        setSnapGuides([])
        setActiveSectionDropTargetId(undefined)

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

      if (panRef.current?.pointerId === event.pointerId) {
        panRef.current = null
        setIsPanning(false)
      }

      if (selectionRef.current?.pointerId === event.pointerId) {
        finishSelection()
      }
    },
    [addFrameNode, addTextNode, editTextNode, finishSelection, resizeTextNode, selectNode, setActiveTool],
  )

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      event.preventDefault()
      onCloseContextMenu()

      if (event.ctrlKey || event.metaKey) {
        zoomBy(Math.exp(-event.deltaY * 0.002), { clientX: event.clientX, clientY: event.clientY })
        return
      }

      setViewport((current) => ({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
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
        groupResizeRef.current = null
        nodeTransformRef.current = null
        textResizeRef.current = null
        setEditingTextNodeId(undefined)
        setSelectionBox(null)
        setTextCreationBox(null)
        setFrameCreationBox(null)
        setSnapGuides([])
        selectNode(undefined)
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
      nodeTransformRef.current = null
      textResizeRef.current = null
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
        const asset = await saveImportedAsset(namedFile)
        const center = viewportCenter()
        const displaySize = importedImageDisplaySize(asset.dimensions)
        addImportedImage(
          asset.assetUrl,
          asset.title,
          asset.size,
          {
            x: center.x - displaySize.width / 2,
            y: center.y - displaySize.height / 2,
          },
          asset,
        )
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
    moveSelectedLayer,
    moveSelectedNodesBy,
    onCloseContextMenu,
    pasteClipboardNodes,
    redo,
    selectNode,
    setActiveTool,
    undo,
    resizeTextNode,
    updateTextNode,
    viewportCenter,
  ])

  const selectionRect = selectionBox ? selectionRectFromBox(selectionBox) : undefined
  const activeSelectionRect = selectionRect && isActiveSelectionRect(selectionRect) ? selectionRect : undefined
  const activeTextCreationRect = textCreationBox ? rectFromTextCreation(textCreationBox) : undefined
  const activeFrameCreationRect = frameCreationBox ? rectFromFrameCreation(frameCreationBox) : undefined
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
    showGroupSelectionBounds,
    activeSelectionRect,
    activeTextCreationRect,
    activeFrameCreationRect,
    selectionPreviewSet,
    beginGroupResize,
    beginNodePointerDown,
    beginNodeResize,
    editTextNode,
    beginTextResize,
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
