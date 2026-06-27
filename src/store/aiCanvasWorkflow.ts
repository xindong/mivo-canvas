import type {
  AiCanvasContextSnapshot,
  AiWorkflowPlacement,
  CanvasId,
  MivoCanvasNode,
} from '../types/mivoCanvas'

type AiContextState = {
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  selectedNodeId?: string
  selectedNodeIds: string[]
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
  margin = 56,
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

export const buildAiContextSnapshot = (state: AiContextState): AiCanvasContextSnapshot => {
  const visibleNodes = state.nodes.filter((node) => !node.hidden)
  const selectedNodeIds = selectedIdsForSnapshot(state.selectedNodeIds, state.selectedNodeId, visibleNodes)
  const links: AiCanvasContextSnapshot['links'] = []
  const linkKeys = new Set<string>()
  const pushLink = (link: AiCanvasContextSnapshot['links'][number]) => {
    const key = `${link.kind}:${link.fromNodeId}:${link.toNodeId}`
    if (linkKeys.has(key)) return

    linkKeys.add(key)
    links.push(link)
  }

  visibleNodes.forEach((node) => {
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
  })

  return {
    version: 1,
    sceneId: state.sceneId,
    selectedNodeIds,
    summary: {
      nodes: visibleNodes.length,
      images: visibleNodes.filter((node) => node.type === 'image').length,
      slots: visibleNodes.filter((node) => node.type === 'ai-slot').length,
      annotations: visibleNodes.filter((node) => node.type === 'annotation').length,
      results: visibleNodes.filter((node) => node.aiWorkflow?.kind === 'result').length,
    },
    nodes: visibleNodes.map((node) => ({
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
      sectionId: node.sectionId,
      generation: node.generation ? { ...node.generation } : undefined,
      aiWorkflow: node.aiWorkflow
        ? {
            ...node.aiWorkflow,
            sourceNodeIds: node.aiWorkflow.sourceNodeIds ? [...node.aiWorkflow.sourceNodeIds] : undefined,
          }
        : undefined,
    })),
    links,
  }
}
