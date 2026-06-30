import type { ConnectorAnchor, ConnectorBinding, MarkupPoint, MivoCanvasNode } from '../types/mivoCanvas'

export const connectorAnchors: ConnectorAnchor[] = ['center', 'top', 'right', 'bottom', 'left']
export const connectorSnapThreshold = 24
const centerSnapRatio = 0.1
const insideEdgeSnapThreshold = 16

export const isConnectorNode = (node: MivoCanvasNode | undefined) =>
  node?.type === 'markup' && (node.markupKind === 'arrow' || node.markupKind === 'line')

export const isConnectableNode = (node: MivoCanvasNode, connectorNodeId?: string) =>
  !node.hidden && node.id !== connectorNodeId && !isConnectorNode(node)

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const normalizedOffset = (offset: number | undefined) =>
  typeof offset === 'number' && Number.isFinite(offset) ? clamp01(offset) : 0.5

const containsPoint = (node: MivoCanvasNode, point: MarkupPoint) =>
  point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height

export const connectorAnchorPointFor = (
  node: MivoCanvasNode,
  anchor: ConnectorAnchor,
  offset?: number,
): MarkupPoint => {
  if (anchor === 'top') return { x: node.x + node.width * normalizedOffset(offset), y: node.y }
  if (anchor === 'right') return { x: node.x + node.width, y: node.y + node.height * normalizedOffset(offset) }
  if (anchor === 'bottom') return { x: node.x + node.width * normalizedOffset(offset), y: node.y + node.height }
  if (anchor === 'left') return { x: node.x, y: node.y + node.height * normalizedOffset(offset) }

  return { x: node.x + node.width / 2, y: node.y + node.height / 2 }
}

const connectorSideBindingForPoint = (
  node: MivoCanvasNode,
  point: MarkupPoint,
): { binding: ConnectorBinding; point: MarkupPoint; distance: number } => {
  const distances: Array<{ anchor: Exclude<ConnectorAnchor, 'center'>; distance: number }> = [
    { anchor: 'top', distance: Math.abs(point.y - node.y) },
    { anchor: 'right', distance: Math.abs(point.x - (node.x + node.width)) },
    { anchor: 'bottom', distance: Math.abs(point.y - (node.y + node.height)) },
    { anchor: 'left', distance: Math.abs(point.x - node.x) },
  ]
  const anchor = distances.reduce((best, item) => (item.distance < best.distance ? item : best)).anchor
  const offset =
    anchor === 'top' || anchor === 'bottom'
      ? clamp01((point.x - node.x) / Math.max(1, node.width))
      : clamp01((point.y - node.y) / Math.max(1, node.height))
  const binding = { nodeId: node.id, anchor, offset }
  const anchorPoint = connectorAnchorPointFor(node, anchor, offset)

  return {
    binding,
    point: anchorPoint,
    distance: Math.hypot(anchorPoint.x - point.x, anchorPoint.y - point.y),
  }
}

export const connectorBindingPointFor = (
  nodes: MivoCanvasNode[],
  binding: ConnectorBinding | undefined,
): MarkupPoint | undefined => {
  if (!binding) return undefined

  const node = nodes.find((item) => item.id === binding.nodeId && !item.hidden)
  return node ? connectorAnchorPointFor(node, binding.anchor, binding.offset) : undefined
}

export const nearestConnectorBindingForPoint = (
  nodes: MivoCanvasNode[],
  point: MarkupPoint,
  options?: {
    connectorNodeId?: string
    threshold?: number
  },
): { binding: ConnectorBinding; point: MarkupPoint; distance: number } | undefined => {
  const threshold = options?.threshold ?? connectorSnapThreshold
  let best: { binding: ConnectorBinding; point: MarkupPoint; distance: number } | undefined
  let bestNodeIndex = -1
  const shouldUseCandidate = (candidate: { distance: number }, nodeIndex: number) =>
    !best || candidate.distance < best.distance - 0.001 || (Math.abs(candidate.distance - best.distance) <= 0.001 && nodeIndex > bestNodeIndex)

  nodes.forEach((node, nodeIndex) => {
    if (!isConnectableNode(node, options?.connectorNodeId)) return

    const centerPoint = connectorAnchorPointFor(node, 'center')
    const centerDistance = Math.hypot(centerPoint.x - point.x, centerPoint.y - point.y)
    if (centerDistance <= Math.min(threshold / 2, Math.min(node.width, node.height) * centerSnapRatio)) {
      if (shouldUseCandidate({ distance: centerDistance }, nodeIndex)) {
        best = {
          binding: { nodeId: node.id, anchor: 'center' },
          point: centerPoint,
          distance: centerDistance,
        }
        bestNodeIndex = nodeIndex
      }
      return
    }

    const sideCandidate = connectorSideBindingForPoint(node, point)
    const sideSnapLimit = containsPoint(node, point) ? Math.min(threshold, insideEdgeSnapThreshold) : threshold
    if (sideCandidate.distance <= sideSnapLimit && shouldUseCandidate(sideCandidate, nodeIndex)) {
      best = sideCandidate
      bestNodeIndex = nodeIndex
      return
    }

    if (containsPoint(node, point)) {
      if (nodeIndex > bestNodeIndex) {
        best = undefined
        bestNodeIndex = nodeIndex
      }
      return
    }

    connectorAnchors.forEach((anchor) => {
      const anchorPoint = connectorAnchorPointFor(node, anchor)
      const distance = Math.hypot(anchorPoint.x - point.x, anchorPoint.y - point.y)
      if (distance > threshold) return
      if (shouldUseCandidate({ distance }, nodeIndex)) {
        best = {
          binding: { nodeId: node.id, anchor },
          point: anchorPoint,
          distance,
        }
        bestNodeIndex = nodeIndex
      }
    })
  })

  return best
}
