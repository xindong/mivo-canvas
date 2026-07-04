import type { MivoCanvasNode, ToolId } from '../types/mivoCanvas'
import {
  getSnappedFreeResize,
  getSnappedPosition,
  getSnappedResize,
  type ResizeCorner,
  type SnapGuide,
} from './canvasGeometry'

export type RuntimeCanvasTool = 'select' | 'hand' | 'text' | 'frame' | 'markup' | 'stamp' | 'zoom'

export type Viewport = {
  x: number
  y: number
  scale: number
}

export type CanvasBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasPoint = {
  x: number
  y: number
}

export type ViewportFitRect = Pick<ClientRectLike, 'left' | 'top' | 'width' | 'height'>

export type PanState = {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

export type SelectionBox = {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  baseSelectedNodeIds: string[]
}

export type ZoomMarqueeBox = {
  pointerId: number
  shellLeft: number
  shellTop: number
  shellWidth: number
  shellHeight: number
  startClientX: number
  startClientY: number
  currentClientX: number
  currentClientY: number
}

export type GroupResizeState = {
  pointerId: number
  corner: ResizeCorner
  startClientX: number
  startClientY: number
  startBounds: CanvasBounds
  startNodes: MivoCanvasNode[]
  aspectRatio: number
  minScale: number
}

export type NodeMoveState = {
  mode: 'move'
  nodeId: string
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  moved: boolean
  historyCaptured: boolean
  collapseSelectionOnClick: boolean
  editTextOnClick: boolean
}

export type NodeResizeState = {
  mode: 'resize'
  nodeId: string
  pointerId: number
  corner: ResizeCorner
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  startWidth: number
  startHeight: number
  aspectRatio: number
  historyCaptured: boolean
}

export type NodeTransformState = NodeMoveState | NodeResizeState

type ClientRectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

const minViewportScale = 0.08
const maxViewportScale = 4
export const minSelectionDrag = 4
const minNodeTransformDrag = 4
const minNodeWidth = 96
const maxNodeWidth = 6000
const minSectionWidth = 160
const minSectionHeight = 120
const minMarkupWidth = 18
const minMarkupHeight = 18

export const runtimeToolFor = (activeTool: ToolId, temporaryTool?: RuntimeCanvasTool): RuntimeCanvasTool => {
  if (temporaryTool) return temporaryTool
  if (activeTool === 'text') return 'text'
  if (activeTool === 'frame') return 'frame'
  if (activeTool === 'stamp') return 'stamp'
  if (activeTool.startsWith('markup-')) return 'markup'
  return activeTool === 'hand' ? 'hand' : 'select'
}

export const isEditingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export const isCanvasUiTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false

  return Boolean(
    target.closest(
      [
        '.canvas-tool-dock',
        '.canvas-controls',
        '.node-context-menu',
        '.selection-handle',
        '[data-canvas-ui="true"]',
      ].join(', '),
    ),
  )
}

export const shouldStartCanvasSurfaceInteraction = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  return !isCanvasUiTarget(target) && !target.closest('.dom-node')
}

export const clientPointToCanvas = (
  rect: ClientRectLike | undefined,
  viewport: Viewport,
  clientX: number,
  clientY: number,
): CanvasPoint => {
  if (!rect) return { x: 0, y: 0 }

  return {
    x: (clientX - rect.left - viewport.x) / viewport.scale,
    y: (clientY - rect.top - viewport.y) / viewport.scale,
  }
}

export const viewportCenterPoint = (rect: ClientRectLike | undefined, viewport: Viewport) => {
  if (!rect) return { x: 0, y: 0 }
  return clientPointToCanvas(rect, viewport, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

export const clampViewportScale = (scale: number) =>
  Math.min(maxViewportScale, Math.max(minViewportScale, Number(scale.toFixed(3))))

export const viewportFromZoom = (
  viewport: Viewport,
  rect: ViewportFitRect | undefined,
  nextScale: number,
  center?: { clientX: number; clientY: number },
): Viewport => {
  if (!rect) return viewport

  const scale = clampViewportScale(nextScale)
  const clientX = center?.clientX ?? rect.left + rect.width / 2
  const clientY = center?.clientY ?? rect.top + rect.height / 2
  const canvasX = (clientX - rect.left - viewport.x) / viewport.scale
  const canvasY = (clientY - rect.top - viewport.y) / viewport.scale

  return {
    x: clientX - rect.left - canvasX * scale,
    y: clientY - rect.top - canvasY * scale,
    scale,
  }
}

export const viewportForBounds = (
  bounds: CanvasBounds,
  rect: ViewportFitRect | undefined,
  options?: { padding?: number; minPadding?: number },
): Viewport | undefined => {
  if (!rect) return undefined

  const minViewportSide = Math.max(1, Math.min(rect.width, rect.height))
  const padding = Math.min(options?.padding ?? 180, Math.max(options?.minPadding ?? 80, minViewportSide * 0.2))
  const availableWidth = Math.max(120, rect.width - padding)
  const availableHeight = Math.max(120, rect.height - padding)
  const scale = clampViewportScale(
    Math.min(availableWidth / Math.max(bounds.width, 1), availableHeight / Math.max(bounds.height, 1)),
  )

  return {
    scale,
    x: rect.width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: rect.height / 2 - (bounds.y + bounds.height / 2) * scale,
  }
}

export const normalizedWheelDelta = (event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>) => {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1

  return {
    x: event.deltaX * unit,
    y: event.deltaY * unit,
  }
}

export const boundsForNodes = (nodes: MivoCanvasNode[]): CanvasBounds | undefined => {
  if (!nodes.length) return undefined

  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export const rectsIntersect = (a: CanvasBounds, b: CanvasBounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export const createPanState = (
  pointerId: number,
  clientX: number,
  clientY: number,
  viewport: Viewport,
): PanState => ({
  pointerId,
  startClientX: clientX,
  startClientY: clientY,
  startX: viewport.x,
  startY: viewport.y,
})

export const viewportFromPan = (pan: PanState, clientX: number, clientY: number, viewport: Viewport): Viewport => ({
  ...viewport,
  x: pan.startX + clientX - pan.startClientX,
  y: pan.startY + clientY - pan.startClientY,
})

export const createSelectionBox = (
  pointerId: number,
  point: CanvasPoint,
  additive: boolean,
  baseSelectedNodeIds: string[],
): SelectionBox => ({
  pointerId,
  startX: point.x,
  startY: point.y,
  currentX: point.x,
  currentY: point.y,
  additive,
  baseSelectedNodeIds,
})

export const createZoomMarqueeBox = (
  pointerId: number,
  clientX: number,
  clientY: number,
  shellRect: ViewportFitRect,
): ZoomMarqueeBox => ({
  pointerId,
  shellLeft: shellRect.left,
  shellTop: shellRect.top,
  shellWidth: shellRect.width,
  shellHeight: shellRect.height,
  startClientX: clientX,
  startClientY: clientY,
  currentClientX: clientX,
  currentClientY: clientY,
})

export const zoomMarqueeOverlayRect = (box: ZoomMarqueeBox): CanvasBounds => ({
  x: Math.min(box.startClientX, box.currentClientX) - box.shellLeft,
  y: Math.min(box.startClientY, box.currentClientY) - box.shellTop,
  width: Math.abs(box.currentClientX - box.startClientX),
  height: Math.abs(box.currentClientY - box.startClientY),
})

export const isVisibleZoomMarqueeRect = (rect: CanvasBounds) =>
  rect.width > minSelectionDrag - 1 || rect.height > minSelectionDrag - 1

export const isZoomToBoundsMarqueeRect = (rect: CanvasBounds) =>
  rect.width >= minSelectionDrag && rect.height >= minSelectionDrag

export const canvasBoundsFromZoomMarquee = (box: ZoomMarqueeBox, viewport: Viewport): CanvasBounds => {
  const shellRect = {
    left: box.shellLeft,
    top: box.shellTop,
    width: box.shellWidth,
    height: box.shellHeight,
  }
  const start = clientPointToCanvas(shellRect, viewport, box.startClientX, box.startClientY)
  const current = clientPointToCanvas(shellRect, viewport, box.currentClientX, box.currentClientY)

  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  }
}

export const selectionRectFromBox = (box: SelectionBox): CanvasBounds => ({
  x: Math.min(box.startX, box.currentX),
  y: Math.min(box.startY, box.currentY),
  width: Math.abs(box.currentX - box.startX),
  height: Math.abs(box.currentY - box.startY),
})

export const isActiveSelectionRect = (rect: CanvasBounds) =>
  rect.width > minSelectionDrag - 1 || rect.height > minSelectionDrag - 1

export const nodeIdsInRect = (nodes: MivoCanvasNode[], rect: CanvasBounds) =>
  Array.from(
    new Set(
      nodes
        .filter((node) => !node.hidden && rectsIntersect(rect, node))
        .flatMap((node) =>
          node.groupId
            ? nodes.filter((candidate) => !candidate.hidden && candidate.groupId === node.groupId).map((candidate) => candidate.id)
            : [node.id],
        ),
    ),
  )

export const selectedIdsFromSelectionBox = (box: SelectionBox, nodes: MivoCanvasNode[]) => {
  const rect = selectionRectFromBox(box)

  if (rect.width < minSelectionDrag || rect.height < minSelectionDrag) {
    return box.additive ? box.baseSelectedNodeIds : []
  }

  const selected = nodeIdsInRect(nodes, rect)
  return box.additive ? Array.from(new Set([...box.baseSelectedNodeIds, ...selected])) : selected
}

export const previewIdsFromSelectionBox = (box: SelectionBox | null, nodes: MivoCanvasNode[]) => {
  if (!box) return new Set<string>()

  const rect = selectionRectFromBox(box)
  if (!isActiveSelectionRect(rect)) return new Set<string>()

  const selected = nodeIdsInRect(nodes, rect)
  return new Set(box.additive ? [...box.baseSelectedNodeIds, ...selected] : selected)
}

export const minGroupScaleFor = (bounds: CanvasBounds, nodes: MivoCanvasNode[]) =>
  Math.max(
    64 / Math.max(bounds.width, 1),
    64 / Math.max(bounds.height, 1),
    ...nodes.flatMap((node) => [32 / Math.max(node.width, 1), 32 / Math.max(node.height, 1)]),
  )

export const createGroupResizeState = (
  pointerId: number,
  corner: ResizeCorner,
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  nodes: MivoCanvasNode[],
): GroupResizeState => ({
  pointerId,
  corner,
  startClientX: clientX,
  startClientY: clientY,
  startBounds: bounds,
  startNodes: nodes.map((node) => ({ ...node })),
  aspectRatio: bounds.width / Math.max(bounds.height, 1),
  minScale: minGroupScaleFor(bounds, nodes),
})

export const createNodeMoveState = (
  node: MivoCanvasNode,
  pointerId: number,
  clientX: number,
  clientY: number,
  options?: { collapseSelectionOnClick?: boolean; editTextOnClick?: boolean },
): NodeMoveState => ({
  mode: 'move',
  nodeId: node.id,
  pointerId,
  startClientX: clientX,
  startClientY: clientY,
  startX: node.x,
  startY: node.y,
  moved: false,
  historyCaptured: false,
  collapseSelectionOnClick: Boolean(options?.collapseSelectionOnClick),
  editTextOnClick: Boolean(options?.editTextOnClick),
})

export const createNodeResizeState = (
  node: MivoCanvasNode,
  pointerId: number,
  corner: ResizeCorner,
  clientX: number,
  clientY: number,
): NodeResizeState => ({
  mode: 'resize',
  nodeId: node.id,
  pointerId,
  corner,
  startClientX: clientX,
  startClientY: clientY,
  startX: node.x,
  startY: node.y,
  startWidth: node.width,
  startHeight: node.height,
  aspectRatio: node.width / Math.max(node.height, 1),
  historyCaptured: false,
})

export const pointerMoveDistance = (state: Pick<NodeTransformState, 'startClientX' | 'startClientY'>, clientX: number, clientY: number) =>
  Math.abs(clientX - state.startClientX) + Math.abs(clientY - state.startClientY)

export const shouldCommitNodeTransform = (state: NodeTransformState, clientX: number, clientY: number) =>
  pointerMoveDistance(state, clientX, clientY) > minNodeTransformDrag

export const moveNodeTransform = (
  state: NodeMoveState,
  node: MivoCanvasNode,
  nodes: MivoCanvasNode[],
  clientX: number,
  clientY: number,
  viewportScale: number,
): { x: number; y: number; guides: SnapGuide[] } => {
  const dx = (clientX - state.startClientX) / viewportScale
  const dy = (clientY - state.startClientY) / viewportScale

  return getSnappedPosition(node, nodes, state.startX + dx, state.startY + dy)
}

export const resizeNodeTransform = (
  state: NodeResizeState,
  node: MivoCanvasNode,
  nodes: MivoCanvasNode[],
  clientX: number,
  clientY: number,
  viewportScale: number,
  options?: { centered?: boolean },
) => {
  const centered = Boolean(options?.centered)
  // Centered (Alt) resize doubles the pointer delta so the dragged corner
  // tracks the cursor while the opposite corner mirrors around the center.
  const deltaScale = centered ? 2 : 1
  const dx = ((clientX - state.startClientX) / viewportScale) * deltaScale
  const dy = ((clientY - state.startClientY) / viewportScale) * deltaScale
  const east = state.corner.endsWith('e')
  const south = state.corner.startsWith('s')

  if (node.type === 'frame' || node.type === 'markup') {
    const nextWidthRaw = state.startWidth + (east ? dx : -dx)
    const nextHeightRaw = state.startHeight + (south ? dy : -dy)
    const minWidth = node.type === 'markup' ? minMarkupWidth : minSectionWidth
    const minHeight = node.type === 'markup' ? minMarkupHeight : minSectionHeight
    const nextWidth = Math.max(minWidth, nextWidthRaw)
    const nextHeight = Math.max(minHeight, nextHeightRaw)

    if (centered) {
      return {
        x: state.startX + (state.startWidth - nextWidth) / 2,
        y: state.startY + (state.startHeight - nextHeight) / 2,
        width: nextWidth,
        height: nextHeight,
        guides: [],
      }
    }

    const nextX = east ? state.startX : state.startX + state.startWidth - nextWidth
    const nextY = south ? state.startY : state.startY + state.startHeight - nextHeight

    return getSnappedFreeResize(
      node,
      nodes,
      { x: nextX, y: nextY, width: nextWidth, height: nextHeight },
      state.corner,
      east ? state.startX : state.startX + state.startWidth,
      south ? state.startY : state.startY + state.startHeight,
      {
        minWidth,
        minHeight,
        maxWidth: Number.POSITIVE_INFINITY,
        maxHeight: Number.POSITIVE_INFINITY,
      },
    )
  }

  const widthFromX = state.startWidth + (east ? dx : -dx)
  const heightFromY = state.startHeight + (south ? dy : -dy)
  const widthFromY = heightFromY * state.aspectRatio
  const nextWidthRaw =
    Math.abs(widthFromX - state.startWidth) > Math.abs(widthFromY - state.startWidth)
      ? widthFromX
      : widthFromY
  const nextWidth = Math.min(maxNodeWidth, Math.max(minNodeWidth, nextWidthRaw))
  const nextHeight = nextWidth / state.aspectRatio

  if (centered) {
    return {
      x: state.startX + (state.startWidth - nextWidth) / 2,
      y: state.startY + (state.startHeight - nextHeight) / 2,
      width: nextWidth,
      height: nextHeight,
      guides: [],
    }
  }

  const nextX = east ? state.startX : state.startX + state.startWidth - nextWidth
  const nextY = south ? state.startY : state.startY + state.startHeight - nextHeight

  return getSnappedResize(
    node,
    nodes,
    { x: nextX, y: nextY, width: nextWidth, height: nextHeight },
    state.corner,
    state.aspectRatio,
    east ? state.startX : state.startX + state.startWidth,
    south ? state.startY : state.startY + state.startHeight,
  )
}

export const resizeGroupSelection = (
  groupResize: GroupResizeState,
  clientX: number,
  clientY: number,
  viewportScale: number,
  options?: { centered?: boolean },
) => {
  const centered = Boolean(options?.centered)
  const deltaScale = centered ? 2 : 1
  const dx = ((clientX - groupResize.startClientX) / viewportScale) * deltaScale
  const dy = ((clientY - groupResize.startClientY) / viewportScale) * deltaScale
  const east = groupResize.corner.endsWith('e')
  const south = groupResize.corner.startsWith('s')
  const { startBounds } = groupResize
  const widthFromX = startBounds.width + (east ? dx : -dx)
  const heightFromY = startBounds.height + (south ? dy : -dy)
  const widthFromY = heightFromY * groupResize.aspectRatio
  const rawWidth =
    Math.abs(widthFromX - startBounds.width) > Math.abs(widthFromY - startBounds.width)
      ? widthFromX
      : widthFromY
  const nextScale = Math.max(groupResize.minScale, rawWidth / Math.max(startBounds.width, 1))
  const nextWidth = startBounds.width * nextScale
  const nextHeight = startBounds.height * nextScale
  const nextX = centered
    ? startBounds.x + (startBounds.width - nextWidth) / 2
    : east
      ? startBounds.x
      : startBounds.x + startBounds.width - nextWidth
  const nextY = centered
    ? startBounds.y + (startBounds.height - nextHeight) / 2
    : south
      ? startBounds.y
      : startBounds.y + startBounds.height - nextHeight

  return {
    bounds: {
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight,
    },
    updates: groupResize.startNodes.map((node) => ({
      id: node.id,
      x: nextX + (node.x - startBounds.x) * nextScale,
      y: nextY + (node.y - startBounds.y) * nextScale,
      width: node.width * nextScale,
      height: node.height * nextScale,
    })),
  }
}
