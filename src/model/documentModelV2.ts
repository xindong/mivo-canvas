import type {
  CanvasAiWorkflow,
  CanvasNodeAssetRef,
  CanvasNodeConstraints,
  CanvasNodeEffect,
  CanvasNodeFill,
  CanvasNodeImageFill,
  CanvasNodeLayout,
  CanvasNodeRelations,
  CanvasNodeSolidFill,
  CanvasNodeStroke,
  CanvasNodeTransform,
  ConnectorBinding,
  MivoCanvasNode,
} from '../types/mivoCanvas'

const defaultRotation = 0
const defaultOpacity = 1

const cloneConnectorBinding = (binding: ConnectorBinding | undefined) =>
  binding ? { ...binding } : undefined

const cloneAiWorkflow = (workflow: CanvasAiWorkflow | undefined) =>
  workflow
    ? {
        ...workflow,
        sourceNodeIds: workflow.sourceNodeIds ? [...workflow.sourceNodeIds] : undefined,
      }
    : undefined

const cloneFill = (fill: CanvasNodeFill): CanvasNodeFill => ({ ...fill })
const cloneStroke = (stroke: CanvasNodeStroke): CanvasNodeStroke => ({ ...stroke })
const cloneEffect = (effect: CanvasNodeEffect): CanvasNodeEffect => ({ ...effect })
const isSolidFill = (fill: CanvasNodeFill): fill is CanvasNodeSolidFill => fill.kind === 'solid'
const isImageFill = (fill: CanvasNodeFill): fill is CanvasNodeImageFill => fill.kind === 'image'

const cloneLayout = (layout: CanvasNodeLayout | undefined): CanvasNodeLayout | undefined =>
  layout
    ? {
        ...layout,
        padding: layout.padding ? { ...layout.padding } : undefined,
      }
    : undefined

const cloneConstraints = (constraints: CanvasNodeConstraints | undefined): CanvasNodeConstraints | undefined =>
  constraints ? { ...constraints } : undefined

const cloneAsset = (asset: CanvasNodeAssetRef | undefined): CanvasNodeAssetRef | undefined =>
  asset ? { ...asset } : undefined

const cloneRelations = (relations: CanvasNodeRelations | undefined): CanvasNodeRelations | undefined =>
  relations
    ? {
        ...relations,
        parentIds: relations.parentIds ? [...relations.parentIds] : undefined,
        connectorStart: cloneConnectorBinding(relations.connectorStart),
        connectorEnd: cloneConnectorBinding(relations.connectorEnd),
        aiWorkflow: cloneAiWorkflow(relations.aiWorkflow),
      }
    : undefined

const transformForNode = (node: MivoCanvasNode): CanvasNodeTransform => ({
  x: node.transform?.x ?? node.x,
  y: node.transform?.y ?? node.y,
  width: node.transform?.width ?? node.width,
  height: node.transform?.height ?? node.height,
  rotation: node.transform?.rotation ?? defaultRotation,
})

const assetForNode = (node: MivoCanvasNode): CanvasNodeAssetRef | undefined => {
  if (node.asset) return cloneAsset(node.asset)
  if (!node.assetUrl) return undefined

  return {
    url: node.assetUrl,
    mimeType: node.assetMimeType,
    originalName: node.assetOriginalName,
    sizeBytes: node.assetSizeBytes,
  }
}

const fillsForNode = (node: MivoCanvasNode): CanvasNodeFill[] | undefined => {
  if (node.fills) return node.fills.map(cloneFill)

  if ((node.type === 'image' || node.type === 'task-placeholder') && node.assetUrl) {
    return [
      {
        id: `${node.id}-image-fill`,
        kind: 'image',
        assetUrl: node.assetUrl,
        opacity: defaultOpacity,
        visible: true,
        scaleMode: 'fill',
      },
    ]
  }

  if (node.type === 'frame' && node.sectionFillColor) {
    return [
      {
        id: `${node.id}-section-fill`,
        kind: 'solid',
        color: node.sectionFillColor,
        opacity: defaultOpacity,
        visible: true,
      },
    ]
  }

  if (node.type === 'markup' && node.markupFillColor) {
    return [
      {
        id: `${node.id}-markup-fill`,
        kind: 'solid',
        color: node.markupFillColor,
        opacity: node.markupOpacity ?? defaultOpacity,
        visible: true,
      },
    ]
  }

  return undefined
}

const strokesForNode = (node: MivoCanvasNode): CanvasNodeStroke[] | undefined => {
  if (node.strokes) return node.strokes.map(cloneStroke)

  if (node.type === 'frame' && (node.sectionBorderColor || node.frameColor || node.sectionBorderWidth)) {
    return [
      {
        id: `${node.id}-section-stroke`,
        color: node.sectionBorderColor || node.frameColor || '#000000',
        width: node.sectionBorderWidth ?? 1,
        style: node.sectionBorderStyle || 'solid',
        opacity: defaultOpacity,
        visible: true,
      },
    ]
  }

  if (node.type === 'markup' && (node.markupStrokeColor || node.markupStrokeWidth)) {
    return [
      {
        id: `${node.id}-markup-stroke`,
        color: node.markupStrokeColor || '#000000',
        width: node.markupStrokeWidth ?? 1,
        style: node.markupStrokeStyle || 'solid',
        opacity: node.markupOpacity ?? defaultOpacity,
        visible: true,
      },
    ]
  }

  return undefined
}

const relationsForNode = (node: MivoCanvasNode): CanvasNodeRelations | undefined => {
  if (node.relations) return cloneRelations(node.relations)

  const relations: CanvasNodeRelations = {}
  if (node.parentIds) relations.parentIds = [...node.parentIds]
  if (node.sectionId) relations.sectionId = node.sectionId
  if (node.targetNodeId) relations.targetNodeId = node.targetNodeId
  if (node.connectorStart) relations.connectorStart = cloneConnectorBinding(node.connectorStart)
  if (node.connectorEnd) relations.connectorEnd = cloneConnectorBinding(node.connectorEnd)
  if (node.aiWorkflow) relations.aiWorkflow = cloneAiWorkflow(node.aiWorkflow)

  return Object.keys(relations).length ? relations : undefined
}

const withLegacyGeometry = (node: MivoCanvasNode, transform: CanvasNodeTransform): MivoCanvasNode => ({
  ...node,
  x: transform.x,
  y: transform.y,
  width: transform.width,
  height: transform.height,
  transform,
})

// Clone entry: always full rebuild + shallow-clone every sub-object. Clone semantics
// are byte-for-byte identical to the pre-split normalizeCanvasNodeV2 body — history /
// clipboard / persist consumers that rely on "clone always produces new sub-objects"
// (nodeFactory.cloneNode) must call this entry, NOT normalizeCanvasNodeV2, so the
// fast-path optimization added in commit #2 (return-same-reference-when-normalized)
// can never break clone isolation.
export const cloneCanvasNodeV2 = (node: MivoCanvasNode): MivoCanvasNode => {
  const transform = transformForNode(node)

  return withLegacyGeometry(
    {
      ...node,
      fills: fillsForNode(node),
      strokes: strokesForNode(node),
      effects: node.effects ? node.effects.map(cloneEffect) : undefined,
      layout: cloneLayout(node.layout),
      constraints: cloneConstraints(node.constraints),
      asset: assetForNode(node),
      relations: relationsForNode(node),
    },
    transform,
  )
}

// Normalize entry. Commit #1: delegates directly to cloneCanvasNodeV2 — zero behavior
// change versus the pre-split single function. Commit #2 adds the
// isNormalizedCanvasNodeV2 fast-path predicate (return the same reference when the
// node is already normalized) so unchanged nodes skip the per-field rebuild during
// drag; the predicate is deliberately NOT wired here yet so cloneNode can switch to
// cloneCanvasNodeV2 first and prove (via the deep-copy contract tests) that clone
// isolation no longer depends on normalize.
export const normalizeCanvasNodeV2 = (node: MivoCanvasNode): MivoCanvasNode =>
  cloneCanvasNodeV2(node)

export const normalizeCanvasNodesV2 = (nodes: MivoCanvasNode[]) => nodes.map(normalizeCanvasNodeV2)

export const setNodeTransform = (
  node: MivoCanvasNode,
  patch: Partial<CanvasNodeTransform>,
): MivoCanvasNode => {
  const transform = {
    ...transformForNode(node),
    ...patch,
  }

  return withLegacyGeometry(normalizeCanvasNodeV2(node), transform)
}

export const setNodeFills = (node: MivoCanvasNode, fills: CanvasNodeFill[]): MivoCanvasNode => {
  const normalized = normalizeCanvasNodeV2(node)
  const nextFills = fills.map(cloneFill)
  const firstVisibleSolidFill = nextFills.find((fill): fill is CanvasNodeSolidFill => fill.visible && isSolidFill(fill))
  const firstVisibleImageFill = nextFills.find((fill): fill is CanvasNodeImageFill => fill.visible && isImageFill(fill))

  return {
    ...normalized,
    fills: nextFills,
    ...(normalized.type === 'frame' && firstVisibleSolidFill
      ? { sectionFillColor: firstVisibleSolidFill.color }
      : {}),
    ...(normalized.type === 'markup' && firstVisibleSolidFill
      ? {
          markupFillColor: firstVisibleSolidFill.color,
          markupOpacity: firstVisibleSolidFill.opacity,
        }
      : {}),
    ...((normalized.type === 'image' || normalized.type === 'task-placeholder') && firstVisibleImageFill
      ? { assetUrl: firstVisibleImageFill.assetUrl }
      : {}),
  }
}

export const setNodeStrokes = (node: MivoCanvasNode, strokes: CanvasNodeStroke[]): MivoCanvasNode => {
  const normalized = normalizeCanvasNodeV2(node)
  const nextStrokes = strokes.map(cloneStroke)
  const firstVisibleStroke = nextStrokes.find((stroke) => stroke.visible)

  return {
    ...normalized,
    strokes: nextStrokes,
    ...(normalized.type === 'frame' && firstVisibleStroke
      ? {
          sectionBorderColor: firstVisibleStroke.color,
          sectionBorderWidth: firstVisibleStroke.width,
          sectionBorderStyle: firstVisibleStroke.style,
        }
      : {}),
    ...(normalized.type === 'markup' && firstVisibleStroke
      ? {
          markupStrokeColor: firstVisibleStroke.color,
          markupStrokeWidth: firstVisibleStroke.width,
          markupStrokeStyle: firstVisibleStroke.style,
          markupOpacity: firstVisibleStroke.opacity,
        }
      : {}),
  }
}

export const setNodeAsset = (node: MivoCanvasNode, asset: CanvasNodeAssetRef | undefined): MivoCanvasNode => {
  const normalized = normalizeCanvasNodeV2(node)
  const nextAsset = cloneAsset(asset)

  return {
    ...normalized,
    asset: nextAsset,
    assetUrl: nextAsset?.url,
    assetMimeType: nextAsset?.mimeType,
    assetOriginalName: nextAsset?.originalName,
    assetSizeBytes: nextAsset?.sizeBytes,
  }
}

export const setNodeRelations = (
  node: MivoCanvasNode,
  relations: CanvasNodeRelations | undefined,
): MivoCanvasNode => {
  const normalized = normalizeCanvasNodeV2(node)
  const nextRelations = cloneRelations(relations)

  return {
    ...normalized,
    relations: nextRelations,
    parentIds: nextRelations?.parentIds ? [...nextRelations.parentIds] : undefined,
    sectionId: nextRelations?.sectionId,
    targetNodeId: nextRelations?.targetNodeId,
    connectorStart: cloneConnectorBinding(nextRelations?.connectorStart),
    connectorEnd: cloneConnectorBinding(nextRelations?.connectorEnd),
    aiWorkflow: cloneAiWorkflow(nextRelations?.aiWorkflow),
  }
}
