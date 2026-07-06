import type {
  AiCanvasContextSnapshot,
  AiWorkflowPlacement,
  CanvasEdge,
  CanvasId,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import { debugLogger } from './debugLogStore'

type AiContextState = {
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  edges: CanvasEdge[]
  selectedNodeId?: string
  selectedNodeIds: string[]
}

const derivationEdgeModel = 'Mivo Derivation Edge'

export const AI_SLOT_GAP = 56

/** chat 生图 slot 替换时的结果落图尺寸:按结果图自然宽高比、与占位符等面积
 *  (视觉跳变最小)。规格(2026-07-05 用户澄清):chat 占位符恒 1:1 方形 loading,
 *  完成替换时结果图按自己的比例落画布;#86 W2-F5「替换保留占位尺寸」契约收窄
 *  为 mask-edit 专属。结果图无自然尺寸信息时回退占位符尺寸。 */
export const equalAreaSizeForDimensions = (
  base: { width: number; height: number },
  dimensions?: { width: number; height: number },
): { width: number; height: number } => {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return base
  const width = Math.round(Math.sqrt((base.width * base.height * dimensions.width) / dimensions.height))
  if (width <= 0) return base
  return { width, height: Math.round((width * dimensions.height) / dimensions.width) }
}

const rectsOverlap = (
  a: Pick<MivoCanvasNode, 'x' | 'y' | 'width' | 'height'>,
  b: Pick<MivoCanvasNode, 'x' | 'y' | 'width' | 'height'>,
  padding = 0,
) =>
  !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  )

const yProjectionsOverlap = (
  a: Pick<MivoCanvasNode, 'y' | 'height'>,
  b: Pick<MivoCanvasNode, 'y' | 'height'>,
) => a.y < b.y + b.height && b.y < a.y + a.height

const selectedIdsForSnapshot = (
  selectedNodeIds: string[],
  selectedNodeId: string | undefined,
  visibleNodes: MivoCanvasNode[],
) => {
  const visibleIds = new Set(visibleNodes.map((node) => node.id))
  const multiSelection = selectedNodeIds.filter((nodeId) => visibleIds.has(nodeId))

  if (multiSelection.length) return multiSelection
  return selectedNodeId && visibleIds.has(selectedNodeId) ? [selectedNodeId] : []
}

export const chooseAdjacentPlacement = ({
  nodes,
  anchor,
  width,
  height,
  placement = 'right',
  margin = AI_SLOT_GAP,
  ignoredObstacleIds = [],
}: {
  nodes: MivoCanvasNode[]
  anchor: MivoCanvasNode
  width: number
  height: number
  placement?: AiWorkflowPlacement
  margin?: number
  ignoredObstacleIds?: string[]
}) => {
  let x = anchor.x + anchor.width + margin
  let y = anchor.y

  if (placement === 'left') x = anchor.x - width - margin
  if (placement === 'below') {
    x = anchor.x
    y = anchor.y + anchor.height + margin
  }

  const ignoredObstacles = new Set(ignoredObstacleIds)
  if (anchor.sectionId) ignoredObstacles.add(anchor.sectionId)

  const obstacles = nodes.filter((node) => !node.hidden && node.id !== anchor.id && !ignoredObstacles.has(node.id))
  const stepX = Math.max(width + margin, 1)
  const stepY = Math.max(height + margin, 1)

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, width, height }
    if (!obstacles.some((node) => rectsOverlap(candidate, node, margin / 2))) return candidate

    if (placement === 'below') y += stepY
    else if (placement === 'left') x -= stepX
    else x += stepX
  }

  return { x, y }
}

type ReflowRect = Pick<MivoCanvasNode, 'x' | 'y' | 'width' | 'height'> & { id?: string }

const canReflowNode = (node: MivoCanvasNode, placedRect: ReflowRect) =>
  !node.hidden &&
  !node.locked &&
  !node.sectionId &&
  node.id !== placedRect.id &&
  node.x + node.width > placedRect.x

export const reflowRightObstacles = (
  nodes: MivoCanvasNode[],
  placedRect: ReflowRect,
  gap = AI_SLOT_GAP,
  maxIterations = 60,
) => {
  let nextNodes = nodes
  const queue: ReflowRect[] = [placedRect]
  const movedIds = new Set<string>()
  let iterations = 0

  while (queue.length && iterations < maxIterations) {
    const blocker = queue.shift()
    if (!blocker) continue

    const requiredX = blocker.x + blocker.width + gap
    const candidate = [...nextNodes]
      .sort((a, b) => a.x - b.x || a.y - b.y)
      .find(
        (node) =>
          canReflowNode(node, placedRect) &&
          node.id !== blocker.id &&
          !movedIds.has(node.id) &&
          yProjectionsOverlap(node, blocker) &&
          node.x < requiredX,
      )

    if (!candidate) continue

    // Keep transform.x in sync with the legacy geometry so the reflowed node stays
    // V2-normalized. Without this, normalizeCanvasNodeV2 (run by patchCanvasDocument
    // → normalizeCanvasGraph) flags the half-normalized node (transform.x !== x),
    // re-derives x from the stale transform, and silently undoes the reflow — the
    // mask-edit SC4.2 regression where B stayed at its original x instead of being
    // pushed to slot.right+gap. y/width/height are unchanged by reflow, so only x
    // needs syncing.
    const movedX = Math.round(requiredX)
    const moved = candidate.transform
      ? { ...candidate, x: movedX, transform: { ...candidate.transform, x: movedX } }
      : { ...candidate, x: movedX }
    movedIds.add(candidate.id)
    nextNodes = nextNodes.map((node) => (node.id === candidate.id ? moved : node))
    queue.push(moved)
    iterations += 1
  }

  if (queue.length) {
    debugLogger.warn('AI Slot Reflow', `Stopped after ${iterations} iterations; right-side obstacles may still overlap.`)
  }

  return nextNodes
}

export const buildAiContextSnapshot = (state: AiContextState): AiCanvasContextSnapshot => {
  const visibleNodes = state.nodes.filter((node) => !node.hidden)
  const visibleContentNodes = visibleNodes.filter((node) => node.generation?.model !== derivationEdgeModel)
  const visibleContentIds = new Set(visibleContentNodes.map((node) => node.id))
  const visibleEdges = state.edges.filter(
    (edge) => visibleContentIds.has(edge.from) && visibleContentIds.has(edge.to),
  )
  const selectedNodeIds = selectedIdsForSnapshot(state.selectedNodeIds, state.selectedNodeId, visibleContentNodes)
  const links: AiCanvasContextSnapshot['links'] = []
  const linkKeys = new Set<string>()
  const pushLink = (link: AiCanvasContextSnapshot['links'][number]) => {
    const key = `${link.kind}:${link.fromNodeId}:${link.toNodeId}`
    if (linkKeys.has(key)) return

    linkKeys.add(key)
    links.push(link)
  }

  visibleEdges.forEach((edge) => {
    pushLink({ kind: edge.type, fromNodeId: edge.from, toNodeId: edge.to })
  })

  visibleContentNodes.forEach((node) => {
    node.parentIds?.forEach((parentId) => {
      pushLink({ kind: 'parent', fromNodeId: parentId, toNodeId: node.id })
    })
    node.aiWorkflow?.sourceNodeIds?.forEach((sourceNodeId) => {
      pushLink({
        kind: node.aiWorkflow?.operation || 'beside-generation',
        fromNodeId: sourceNodeId,
        toNodeId: node.id,
      })
    })
    if (node.aiWorkflow?.slotId) {
      pushLink({
        kind: node.aiWorkflow.operation || 'slot-generation',
        fromNodeId: node.aiWorkflow.slotId,
        toNodeId: node.id,
      })
    }
    if (node.aiWorkflow?.annotationNodeId) {
      pushLink({
        kind: node.aiWorkflow.operation || 'annotation-edit',
        fromNodeId: node.aiWorkflow.annotationNodeId,
        toNodeId: node.id,
      })
    }
    if (node.connectorStart?.nodeId && node.connectorEnd?.nodeId) {
      pushLink({
        kind: 'connector',
        fromNodeId: node.connectorStart.nodeId,
        toNodeId: node.connectorEnd.nodeId,
      })
    } else if (node.connectorStart?.nodeId || node.connectorEnd?.nodeId) {
      pushLink({
        kind: 'connector',
        fromNodeId: node.connectorStart?.nodeId || node.connectorEnd?.nodeId || node.id,
        toNodeId: node.id,
      })
    }
  })

  return {
    version: 1,
    sceneId: state.sceneId,
    selectedNodeIds,
    summary: {
      nodes: visibleContentNodes.length,
      images: visibleContentNodes.filter((node) => node.type === 'image').length,
      slots: visibleContentNodes.filter((node) => node.type === 'ai-slot').length,
      annotations: visibleContentNodes.filter((node) => node.type === 'annotation').length,
      results: visibleContentNodes.filter((node) => node.aiWorkflow?.kind === 'result').length,
    },
    nodes: visibleContentNodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      bounds: {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      },
      status: node.status,
      text: node.text,
      assetUrl: node.assetUrl,
      assetMimeType: node.assetMimeType,
      assetOriginalName: node.assetOriginalName,
      assetSizeBytes: node.assetSizeBytes,
      sectionId: node.sectionId,
      targetNodeId: node.targetNodeId,
      markupKind: node.markupKind,
      markupStampKind: node.markupStampKind,
      markupPoints: node.markupPoints ? node.markupPoints.map((point) => ({ ...point })) : undefined,
      markupStrokeColor: node.markupStrokeColor,
      markupFillColor: node.markupFillColor,
      markupStrokeWidth: node.markupStrokeWidth,
      markupStrokeStyle: node.markupStrokeStyle,
      markupStartArrow: node.markupStartArrow,
      markupEndArrow: node.markupEndArrow,
      markupCornerRadius: node.markupCornerRadius,
      connectorStart: node.connectorStart ? { ...node.connectorStart } : undefined,
      connectorEnd: node.connectorEnd ? { ...node.connectorEnd } : undefined,
      generation: node.generation ? { ...node.generation } : undefined,
      aiWorkflow: node.aiWorkflow
        ? {
            ...node.aiWorkflow,
            sourceNodeIds: node.aiWorkflow.sourceNodeIds ? [...node.aiWorkflow.sourceNodeIds] : undefined,
          }
        : undefined,
    })),
    edges: visibleEdges.map((edge) => ({ ...edge })),
    links,
  }
}
