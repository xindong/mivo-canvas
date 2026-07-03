import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  createNodeMoveState,
  createNodeResizeState,
  moveNodeTransform,
  resizeNodeTransform,
  shouldCommitNodeTransform,
  type NodeTransformState,
  type Viewport,
} from './canvasInteraction'
import type { ResizeCorner, SnapGuide } from './canvasGeometry'

export const isNodeEffectivelyLocked = (node: MivoCanvasNode, nodes: MivoCanvasNode[]): boolean => {
  const section = node.sectionId ? nodes.find((item) => item.id === node.sectionId && item.type === 'frame') : undefined
  return Boolean(node.locked || section?.sectionLockMode === 'all')
}

export const isAutoDeletedEmptyTextNode = (
  node: MivoCanvasNode | undefined,
): node is MivoCanvasNode & { type: 'text' | 'annotation' } =>
  node?.type === 'text' || node?.type === 'annotation'

type UseNodeTransformOptions = {
  viewportRef: RefObject<Viewport>
  startInteraction: () => void
  clearSelection: () => void
  selectNode: (id: string | undefined, options?: { additive?: boolean }) => void
  selectNodes: (ids: string[], focusId?: string) => void
  captureHistory: () => void
  updateSelectedNodesPosition: (nodeId: string, x: number, y: number) => void
  updateNodeGeometry: (nodeId: string, x: number, y: number, width: number, height: number) => void
  setSnapGuides: (guides: SnapGuide[]) => void
  setActiveSectionDropTargetId: (id: string | undefined) => void
  setActiveConnectorDropTargetId: (id: string | undefined) => void
  editTextNode: (nodeId: string) => boolean
  nodes: MivoCanvasNode[]
  selectedNodeIds: string[]
}

// Node move/resize transform state + begin + dispatcher branches.
// Extracted from useCanvasInteractionController (F7 node-transform gap).
// Pure extraction; geometry stays in canvasInteraction/canvasGeometry.
export function useNodeTransform({
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
}: UseNodeTransformOptions) {
  const nodeTransformRef = useRef<NodeTransformState | null>(null)

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

  const beginNodeMove = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()
      clearSelection()

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
    [clearSelection, nodes, selectNode, selectNodes, selectedNodeIds, startInteraction],
  )

  const startNodeResize = useCallback(
    (nodeId: string, corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return

      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()
      clearSelection()
      selectNode(nodeId)
      if (isNodeEffectivelyLocked(node, nodes)) return

      nodeTransformRef.current = createNodeResizeState(node, event.pointerId, corner, event.clientX, event.clientY)
    },
    [clearSelection, nodes, selectNode, startInteraction],
  )

  // Dispatcher (handleCanvasPointerMove) node-transform branch.
  const tryMoveNodeTransform = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const nodeTransform = nodeTransformRef.current
      if (nodeTransform?.pointerId !== event.pointerId) return false

      const node = nodes.find((item) => item.id === nodeTransform.nodeId)
      if (!node) return true

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
          { centered: event.altKey },
        )
        setSnapGuides(snapped.guides)
        setActiveSectionDropTargetId(undefined)
        setActiveConnectorDropTargetId(undefined)
        updateNodeGeometry(nodeTransform.nodeId, snapped.x, snapped.y, snapped.width, snapped.height)
      }

      return true
    },
    [
      captureHistory,
      nodes,
      sectionDropTargetFor,
      setActiveConnectorDropTargetId,
      setActiveSectionDropTargetId,
      setSnapGuides,
      updateNodeGeometry,
      updateSelectedNodesPosition,
      viewportRef,
    ],
  )

  // Dispatcher (handleCanvasPointerEnd) node-transform branch.
  const tryEndNodeTransform = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (nodeTransformRef.current?.pointerId !== event.pointerId) return

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
    },
    [editTextNode, selectNode, setActiveConnectorDropTargetId, setActiveSectionDropTargetId, setSnapGuides],
  )

  const resetNodeTransform = useCallback(() => {
    nodeTransformRef.current = null
  }, [])

  return {
    beginNodeMove,
    startNodeResize,
    tryMoveNodeTransform,
    tryEndNodeTransform,
    resetNodeTransform,
  }
}
