import type {
  AiWorkflowOperation,
  AiWorkflowPlacement,
  CanvasEdge,
  CanvasEdgeType,
  CanvasMaskBounds,
  CanvasTask,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import { cloneCanvasNodeV2 } from '../model/documentModelV2'
import { normalizeAnchors } from '../model/anchorModel'
import { connectorAnchorPointFor, derivationConnectorBindingsFor } from '../canvas/connectorGeometry'
import { makeNode } from './demoScenes'
import type { ImageDimensions } from '../lib/imageSizing'

/**
 * nodeFactory — pure helpers for cloning and constructing canvas nodes.
 *
 * Extracted from canvasStore.ts (P0-c of the productization roadmap) so that node
 * cloning, duplication, derivation-edge construction, and generation-result node
 * construction are unit-testable in isolation. The module has no canvasStore import
 * (no runtime cycle); it depends only on the model layer, connector geometry, and
 * the demoScenes `makeNode` factory.
 *
 * Behavior is identical to the prior inline implementation — only the location changed.
 */

// --- clone helpers -----------------------------------------------------------

// cloneNode serves history / clipboard / persist, where sub-objects must NOT be
// shared with the source (a later mutation of the source must not leak into the
// clone). It therefore calls cloneCanvasNodeV2 (always full rebuild) rather than
// normalizeCanvasNodeV2 — the latter gains a return-same-reference fast path in
// commit #2 which would break clone isolation. See documentModelV2.ts.
export const cloneNode = (node: MivoCanvasNode): MivoCanvasNode => ({
  ...cloneCanvasNodeV2(node),
  markupPoints: node.markupPoints ? node.markupPoints.map((point) => ({ ...point })) : undefined,
  connectorStart: node.connectorStart ? { ...node.connectorStart } : undefined,
  connectorEnd: node.connectorEnd ? { ...node.connectorEnd } : undefined,
  parentIds: node.parentIds ? [...node.parentIds] : undefined,
  generation: node.generation
    ? {
        ...node.generation,
        maskBounds: node.generation.maskBounds ? { ...node.generation.maskBounds } : undefined,
      }
    : undefined,
  aiWorkflow: node.aiWorkflow
    ? {
        ...node.aiWorkflow,
        sourceNodeIds: node.aiWorkflow.sourceNodeIds ? [...node.aiWorkflow.sourceNodeIds] : undefined,
      }
    : undefined,
  // P2-D1: explicit deep-copy + light validation for experimentalAnchors. The
  // spread above only shallow-copies the array (nested anchor objects would be
  // shared across history/clipboard/persist). normalizeAnchors deep-copies each
  // anchor, drops box anchors missing width/height (with a dev warning), and
  // returns undefined when none remain — so a bare node stays bare.
  experimentalAnchors: normalizeAnchors(node.experimentalAnchors, true),
})

export const cloneTask = (task: CanvasTask): CanvasTask => ({
  ...task,
  nodeIds: [...task.nodeIds],
})

export const cloneEdge = (edge: CanvasEdge): CanvasEdge => ({ ...edge })

export const cloneNodes = (nodes: MivoCanvasNode[]) => nodes.map(cloneNode)
export const cloneTasks = (tasks: CanvasTask[]) => tasks.map(cloneTask)
export const cloneEdges = (edges: CanvasEdge[] = []) => edges.map(cloneEdge)

export const cloneMaskBounds = (maskBounds?: CanvasMaskBounds) =>
  maskBounds ? { ...maskBounds } : undefined

// --- id generators -----------------------------------------------------------

export const createCanvasId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `canvas-${crypto.randomUUID()}`
  }

  return `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const createGroupId = () => `group-${Date.now()}-${Math.random().toString(16).slice(2)}`
export const createNodeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
export const createEdgeId = () => createNodeId('edge')

// --- node construction -------------------------------------------------------

/** Duplicate a node for paste/duplicate, offsetting geometry and clearing linkage fields. */
export const createNodeCopy = (
  source: MivoCanvasNode,
  index: number,
  offset = 28,
  overrides?: Partial<MivoCanvasNode>,
): MivoCanvasNode => ({
  ...cloneNode(source),
  id: `${source.id}-copy-${Date.now()}-${index}`,
  title: `${source.title} Copy`,
  x: source.x + offset,
  y: source.y + offset,
  groupId: undefined,
  sectionId: undefined,
  connectorStart: undefined,
  connectorEnd: undefined,
  hidden: undefined,
  ...overrides,
})

const derivationEdgeModel = 'Mivo Derivation Edge'
const derivationEdgeNodeId = (edgeId: string) => `derivation-${edgeId}`

export const isDerivationEdgeNode = (node: MivoCanvasNode) =>
  node.type === 'markup' && node.generation?.model === derivationEdgeModel

/**
 * Build the markup arrow node that visually represents a derivation edge between two
 * content nodes. Returns `undefined` when either endpoint is missing or hidden.
 */
export const createDerivationEdgeNode = (
  edge: CanvasEdge,
  nodes: MivoCanvasNode[],
): MivoCanvasNode | undefined => {
  const source = nodes.find((node) => node.id === edge.from && !node.hidden)
  const target = nodes.find((node) => node.id === edge.to && !node.hidden)
  if (!source || !target) return undefined

  // M10: dynamic anchor selection — pick shortest-distance anchor pair
  const { start, end } = derivationConnectorBindingsFor(source, target)
  const startPt = connectorAnchorPointFor(source, start.anchor, 0.5)
  const endPt = connectorAnchorPointFor(target, end.anchor, 0.5)

  return makeNode({
    id: derivationEdgeNodeId(edge.id),
    type: 'markup',
    title: edge.type === 'edit' ? 'Edit derivation' : 'Generation derivation',
    // Initial geometry; overridden by normalizeConnectorMarkupNodes from binding anchor points
    x: Math.min(startPt.x, endPt.x),
    y: Math.min(startPt.y, endPt.y),
    width: Math.max(24, Math.abs(endPt.x - startPt.x)),
    height: Math.max(24, Math.abs(endPt.y - startPt.y)),
    markupKind: 'arrow',
    markupStrokeColor: '#497466',
    markupStrokeWidth: 3,
    markupStrokeStyle: 'solid',
    markupOpacity: 0.82,
    markupStartArrow: false,
    markupEndArrow: true,
    markupPoints: [
      { x: 0, y: 0 },
      { x: Math.max(24, Math.abs(endPt.x - startPt.x)), y: Math.round(endPt.y - startPt.y) },
    ],
    connectorStart: start,
    connectorEnd: end,
    status: 'ready',
    locked: true,
    generation: {
      prompt: edge.prompt,
      model: derivationEdgeModel,
      createdAt: edge.createdAt,
    },
  })
}

// --- generation result node construction -------------------------------------

/** Structural shape of a persisted generated asset — what the node builder reads. */
export type GenerationResultAsset = {
  assetUrl: string
  type: string
  name: string
  sizeBytes: number
  hasTransparency?: boolean
  sourceDimensions?: ImageDimensions
  size: string
}

export type GenerationResultNodeOptions = {
  id: string
  title: string
  placement: { x: number; y: number }
  displaySize: { width: number; height: number }
  asset: GenerationResultAsset
  prompt: string
  model: string
  taskId: string
  createdAt: number
  maskBounds?: CanvasMaskBounds
  operation: AiWorkflowOperation
  sourceNode?: MivoCanvasNode
  placementDirection?: AiWorkflowPlacement
}

/**
 * Build the image node that represents one generated result, plus its aiWorkflow
 * metadata. Pure: the caller resolves placement, display size, ids, and the operation
 * (which depend on live node state) and passes them in.
 */
export const createGenerationResultNode = (options: GenerationResultNodeOptions): MivoCanvasNode => {
  const {
    id,
    title,
    placement,
    displaySize,
    asset,
    prompt,
    model,
    taskId,
    createdAt,
    maskBounds,
    operation,
    sourceNode,
    placementDirection,
  } = options

  return makeNode({
    id,
    type: 'image',
    title,
    x: Math.round(placement.x),
    y: Math.round(placement.y),
    width: Math.round(displaySize.width),
    height: Math.round(displaySize.height),
    assetUrl: asset.assetUrl,
    assetMimeType: asset.type,
    assetOriginalName: asset.name,
    assetSizeBytes: asset.sizeBytes,
    imageHasTransparency: asset.hasTransparency,
    assetSourceDimensions: asset.sourceDimensions,
    status: 'ready',
    parentIds: sourceNode ? [sourceNode.id] : undefined,
    sourceNodeId: sourceNode?.id,
    generation: {
      prompt,
      model,
      size: asset.size,
      taskId,
      createdAt,
      maskBounds: cloneMaskBounds(maskBounds),
    },
    aiWorkflow: {
      kind: 'result',
      status: 'ready',
      operation,
      prompt,
      sourceNodeIds: sourceNode ? [sourceNode.id] : undefined,
      anchorNodeId: sourceNode?.id,
      slotId: sourceNode?.type === 'ai-slot' ? sourceNode.id : undefined,
      placement: placementDirection || 'right',
      createdAt,
    },
  })
}

/** Resolve the derivation edge type ('generate' vs 'edit') from the workflow operation. */
export const edgeTypeForOperation = (operation: AiWorkflowOperation): CanvasEdgeType =>
  operation === 'slot-generation' || operation === 'beside-generation' || operation === 'variation'
    ? 'generate'
    : 'edit'
