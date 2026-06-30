import type { MivoCanvasNode } from '../../types/mivoCanvas'
import { capabilitiesForNode } from '../nodeTypes/canvasNodeRegistry'
import type { CanvasObjectCapability } from '../nodeTypes/nodeCapabilities'

export type { CanvasObjectCapability } from '../nodeTypes/nodeCapabilities'

export type CanvasSelectionKind = 'blank' | 'single' | 'multi'

export type CanvasSelectionContext = {
  kind: CanvasSelectionKind
  nodes: MivoCanvasNode[]
  primaryNode?: MivoCanvasNode
  selectedCount: number
  commonCapabilities: Set<CanvasObjectCapability>
  anyCapabilities: Set<CanvasObjectCapability>
  objectTypes: Set<MivoCanvasNode['type']>
}

const intersectionOf = (capabilitySets: Array<Set<CanvasObjectCapability>>) => {
  if (!capabilitySets.length) return new Set<CanvasObjectCapability>()

  const [firstSet, ...restSets] = capabilitySets
  return new Set([...firstSet].filter((capability) => restSets.every((set) => set.has(capability))))
}

const unionOf = (capabilitySets: Array<Set<CanvasObjectCapability>>) =>
  new Set(capabilitySets.flatMap((set) => [...set]))

export const createCanvasSelectionContext = (
  selectedNodes: MivoCanvasNode[],
  primaryNode?: MivoCanvasNode,
): CanvasSelectionContext => {
  const nodes = selectedNodes.length ? selectedNodes : primaryNode ? [primaryNode] : []
  const capabilitySets = nodes.map(capabilitiesForNode)

  return {
    kind: nodes.length === 0 ? 'blank' : nodes.length === 1 ? 'single' : 'multi',
    nodes,
    primaryNode: primaryNode && nodes.some((node) => node.id === primaryNode.id) ? primaryNode : nodes[0],
    selectedCount: nodes.length,
    commonCapabilities: intersectionOf(capabilitySets),
    anyCapabilities: unionOf(capabilitySets),
    objectTypes: new Set(nodes.map((node) => node.type)),
  }
}

export const hasCommonCapability = (
  context: CanvasSelectionContext,
  capability: CanvasObjectCapability,
) => context.commonCapabilities.has(capability)

export const hasAnyCapability = (
  context: CanvasSelectionContext,
  capability: CanvasObjectCapability,
) => context.anyCapabilities.has(capability)
