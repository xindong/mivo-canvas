import type { MivoCanvasNode } from '../../types/mivoCanvas'

export type CanvasObjectCapability =
  | 'selectable'
  | 'movable'
  | 'resizable'
  | 'layerable'
  | 'groupable'
  | 'lockable'
  | 'hideable'
  | 'exportable'
  | 'downloadOriginal'
  | 'asset'
  | 'imageAsset'
  | 'text'
  | 'frame'
  | 'promptSource'
  | 'aiReference'
  | 'aiEditable'
  | 'videoAsset'
  | 'pdfAsset'
  | 'markdownDoc'
  | 'annotatable'
  | 'task'
  | 'aiSlot'
  | 'annotation'
  | 'aiResult'

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

const baseObjectCapabilities: CanvasObjectCapability[] = [
  'selectable',
  'movable',
  'resizable',
  'layerable',
  'groupable',
  'lockable',
  'hideable',
  'exportable',
]

export const capabilitiesForNode = (node: MivoCanvasNode): Set<CanvasObjectCapability> => {
  const organizationCapabilities: CanvasObjectCapability[] = ['selectable', 'lockable', 'hideable']

  if (node.type === 'text') {
    if (node.locked) return new Set([...organizationCapabilities, 'text', 'promptSource', 'exportable'])
    return new Set([...baseObjectCapabilities, 'text', 'promptSource'])
  }

  if (node.type === 'annotation') {
    if (node.locked) {
      return new Set([...organizationCapabilities, 'text', 'annotation', 'promptSource', 'annotatable', 'exportable'])
    }
    return new Set([...baseObjectCapabilities, 'text', 'annotation', 'promptSource', 'annotatable'])
  }

  if (node.type === 'frame') {
    if (node.locked) return new Set([...organizationCapabilities, 'frame'])
    return new Set([...baseObjectCapabilities, 'frame'])
  }

  if (node.type === 'ai-slot') {
    if (node.locked) return new Set([...organizationCapabilities, 'aiSlot', 'promptSource', 'exportable'])
    return new Set([...baseObjectCapabilities, 'aiSlot', 'promptSource'])
  }

  if (node.type === 'task-placeholder') {
    if (node.locked) {
      return new Set([...organizationCapabilities, 'asset', 'imageAsset', 'aiReference', 'task', 'exportable'])
    }
    return new Set([...baseObjectCapabilities, 'asset', 'imageAsset', 'aiReference', 'task'])
  }

  if (node.locked) {
    return new Set([
      ...organizationCapabilities,
      'asset',
      'imageAsset',
      'downloadOriginal',
      'aiReference',
      'aiEditable',
      'exportable',
      ...(node.aiWorkflow?.kind === 'result' ? (['aiResult'] as CanvasObjectCapability[]) : []),
    ])
  }

  return new Set([
    ...baseObjectCapabilities,
    'asset',
    'imageAsset',
    'downloadOriginal',
    'aiReference',
    'aiEditable',
    ...(node.aiWorkflow?.kind === 'result' ? (['aiResult'] as CanvasObjectCapability[]) : []),
  ])
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
