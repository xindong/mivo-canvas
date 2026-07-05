import { useCallback, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import type { MivoCanvasNode, MarkupKind, MarkupPoint, ToolId } from '../types/mivoCanvas'
import { nearestConnectorBindingForPoint } from './connectorGeometry'
import { markupKindForTool } from './canvasToolRegistry'
import { defaultTextFontSize, defaultTextWeight, textGeometryFor } from './textGeometry'
import { isAutoDeletedEmptyTextNode, isNodeEffectivelyLocked } from './useNodeTransform'
import type { CanvasBounds, Viewport } from './canvasInteraction'
import type { SnapGuide } from './canvasGeometry'

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
export { isEditableTextNode }

type UseTextAnnotationOptions = {
  screenToCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  viewportRef: RefObject<Viewport>
  onCloseContextMenu: () => void
  discardEmptyEditingText: (nodeId?: string) => void
  setEditingTextNodeId: Dispatch<SetStateAction<string | undefined>>
  setSnapGuides: (guides: SnapGuide[]) => void
  setActiveConnectorDropTargetId: (id: string | undefined) => void
  clearSelection: () => void
  selectNode: (id: string | undefined, options?: { additive?: boolean }) => void
  editTextNode: (nodeId: string) => boolean
  beginEraserDrag: (event: ReactPointerEvent<HTMLElement>) => void
  setActiveTool: (tool: ToolId) => void
  nodes: MivoCanvasNode[]
}

// Text / annotation / markup creation + text resize + text-edit glue.
// Extracted from useCanvasInteractionController (F7 text-annotation gap).
// Pure extraction; each begin* keeps its exact inline cleanup (the cleanup
// calls are NOT uniform across these begin* — see B1 finding).
export function useTextAnnotation({
  screenToCanvas,
  viewportRef,
  onCloseContextMenu,
  discardEmptyEditingText,
  setEditingTextNodeId,
  setSnapGuides,
  setActiveConnectorDropTargetId,
  clearSelection,
  selectNode,
  editTextNode,
  beginEraserDrag,
  setActiveTool,
  nodes,
}: UseTextAnnotationOptions) {
  const captureHistory = useCanvasStore((state) => state.captureHistory)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addFrameNode = useCanvasStore((state) => state.addFrameNode)
  const addMarkupNode = useCanvasStore((state) => state.addMarkupNode)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const resizeTextNode = useCanvasStore((state) => state.resizeTextNode)
  const updateMarkupGeometry = useCanvasStore((state) => state.updateMarkupGeometry)

  const textCreationRef = useRef<TextCreationState | null>(null)
  const frameCreationRef = useRef<FrameCreationState | null>(null)
  const markupCreationRef = useRef<MarkupCreationState | null>(null)
  const markupPointTransformRef = useRef<MarkupPointTransformState | null>(null)
  const textResizeRef = useRef<TextResizeState | null>(null)
  const [textCreationBox, setTextCreationBox] = useState<TextCreationState | null>(null)
  const [frameCreationBox, setFrameCreationBox] = useState<FrameCreationState | null>(null)
  const [markupCreationBox, setMarkupCreationBox] = useState<MarkupCreationState | null>(null)

  const beginTextEdit = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLElement>) => {
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
    [clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas, selectNode, setSnapGuides],
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
    [discardEmptyEditingText, nodes, onCloseContextMenu, selectNode, setSnapGuides],
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
    [clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas, setEditingTextNodeId, setSnapGuides],
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
        beginEraserDrag(event)
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
    [beginEraserDrag, clearSelection, discardEmptyEditingText, onCloseContextMenu, screenToCanvas, setEditingTextNodeId, setSnapGuides],
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
    [discardEmptyEditingText, nodes, onCloseContextMenu, selectNode, setEditingTextNodeId, setSnapGuides],
  )

  const finishTextEditing = useCallback(
    (nodeId: string) => {
      setEditingTextNodeId((current) => (current === nodeId ? undefined : current))

      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      if (isAutoDeletedEmptyTextNode(node) && !node.text?.trim()) {
        discardEmptyEditingText(nodeId)
      }
    },
    [discardEmptyEditingText, setEditingTextNodeId],
  )

  // Dispatcher (handleCanvasPointerMove) branches.
  const tryMoveTextCreation = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const textCreation = textCreationRef.current
      if (textCreation?.pointerId !== event.pointerId) return false
      const point = screenToCanvas(event.clientX, event.clientY)
      textCreation.currentX = point.x
      textCreation.currentY = point.y
      setTextCreationBox({ ...textCreation })
      return true
    },
    [screenToCanvas],
  )

  const tryMoveFrameCreation = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const frameCreation = frameCreationRef.current
      if (frameCreation?.pointerId !== event.pointerId) return false
      const point = screenToCanvas(event.clientX, event.clientY)
      frameCreation.currentX = point.x
      frameCreation.currentY = point.y
      setFrameCreationBox({ ...frameCreation })
      return true
    },
    [screenToCanvas],
  )

  const tryMoveMarkupCreation = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const markupCreation = markupCreationRef.current
      if (markupCreation?.pointerId !== event.pointerId) return false
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
          return true
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
      return true
    },
    [nodes, screenToCanvas, setActiveConnectorDropTargetId],
  )

  const tryMoveMarkupPointTransform = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const markupPointTransform = markupPointTransformRef.current
      if (markupPointTransform?.pointerId !== event.pointerId) return false

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
      return true
    },
    [captureHistory, nodes, setActiveConnectorDropTargetId, updateMarkupGeometry, viewportRef],
  )

  const tryMoveTextResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const textResize = textResizeRef.current
      if (textResize?.pointerId !== event.pointerId) return false

      const node = nodes.find((item) => item.id === textResize.nodeId)
      if (!isEditableTextNode(node)) return true

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
      return true
    },
    [captureHistory, nodes, resizeTextNode, viewportRef],
  )

  // Dispatcher (handleCanvasPointerEnd) branches.
  const tryEndTextCreation = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (textCreationRef.current?.pointerId !== event.pointerId) return false
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
      return true
    },
    [addTextNode, resizeTextNode, setActiveTool, setEditingTextNodeId],
  )

  const tryEndFrameCreation = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (frameCreationRef.current?.pointerId !== event.pointerId) return false
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
      return true
    },
    [addFrameNode, setActiveTool],
  )

  const tryEndMarkupCreation = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (markupCreationRef.current?.pointerId !== event.pointerId) return false
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
      return true
    },
    [addMarkupNode, nodes, setActiveConnectorDropTargetId, setActiveTool],
  )

  const tryEndMarkupPointTransform = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (markupPointTransformRef.current?.pointerId !== event.pointerId) return false
      markupPointTransformRef.current = null
      setActiveConnectorDropTargetId(undefined)
      return true
    },
    [setActiveConnectorDropTargetId],
  )

  const tryEndTextResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (textResizeRef.current?.pointerId !== event.pointerId) return false
      textResizeRef.current = null
      return true
    },
    [],
  )

  const resetTextAnnotation = useCallback(() => {
    textCreationRef.current = null
    frameCreationRef.current = null
    markupCreationRef.current = null
    markupPointTransformRef.current = null
    textResizeRef.current = null
    setTextCreationBox(null)
    setFrameCreationBox(null)
    setMarkupCreationBox(null)
  }, [])

  const activeTextCreationRect = textCreationBox ? rectFromTextCreation(textCreationBox) : undefined
  const activeFrameCreationRect = frameCreationBox ? rectFromFrameCreation(frameCreationBox) : undefined
  const activeMarkupCreationRect = markupCreationBox ? rectFromMarkupCreation(markupCreationBox) : undefined

  return {
    textCreationBox,
    frameCreationBox,
    markupCreationBox,
    activeTextCreationRect,
    activeFrameCreationRect,
    activeMarkupCreationRect,
    beginTextEdit,
    beginTextBox,
    beginMarkupPointMove,
    beginFrameBox,
    beginMarkupBox,
    updateEditingText,
    beginTextResize,
    finishTextEditing,
    tryMoveTextCreation,
    tryMoveFrameCreation,
    tryMoveMarkupCreation,
    tryMoveMarkupPointTransform,
    tryMoveTextResize,
    tryEndTextCreation,
    tryEndFrameCreation,
    tryEndMarkupCreation,
    tryEndMarkupPointTransform,
    tryEndTextResize,
    resetTextAnnotation,
  }
}
