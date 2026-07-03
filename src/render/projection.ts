// projection — canonical render projection (P3-0a, SC6.1).
//
// Formalizes what canvasRenderAdapter.ts computes today (geometry, fills,
// strokes, text, markup, section) into a stable RenderNode/RenderEdge/RenderAnchor
// contract. The renderer (CanvasNodeView et al.) will, in P3-0b, consume RenderNode
// instead of reading MivoCanvasNode directly. Anchor (P4-a CanvasAnchor) changes
// will then only touch projectNode/projectAnchor, not the renderer.
//
// SC6.1: the renderer imports RenderNode/RenderEdge/RenderAnchor + leaf visual
// types (CanvasNodeFill, ...). It does NOT import MivoCanvasNode. projectNode
// (this module) is the adapter that owns the MivoCanvasNode dependency; the
// renderer never calls it.
//
// Field source: docs/decisions/p4-schema-spike.md §3 (P3-0 投影字段清单).

import type {
  CanvasAiWorkflow,
  CanvasEdge,
  CanvasMaskBounds,
  CanvasNodeEffect,
  CanvasNodeFill,
  CanvasNodeStroke,
  CanvasNodeType,
  CanvasStampKind,
  ConnectorBinding,
  ExperimentalAnchor,
  ImageCrop,
  MarkdownDisplayMode,
  MarkupBrushKind,
  MarkupKind,
  MarkupPoint,
  MarkupStrokeStyle,
  MivoCanvasNode,
  NodeStatus,
  SectionBorderStyle,
  SectionLockMode,
} from '../types/mivoCanvas'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'
import type { ViewportMatrix } from './viewportMatrix'

// --- Render types (renderer consumes; never MivoCanvasNode directly) ---------

export type RenderGeometry = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

// RenderAnchor is render-only (NOT ExperimentalAnchor) so P4-a can swap the
// projection source (node-relative → canvas) without touching the renderer.
export type RenderAnchor = {
  id: string
  type: 'point' | 'box'
  targetNodeId: string
  /** Canvas-coordinate. MVP: experimentalAnchors are already canvas. */
  x: number
  y: number
  /** Required for type==='box'; absent for type==='point'. */
  width?: number
  height?: number
  instruction: string
  resultNodeIds?: string[]
  /**
   * Screen-space coords (filled when a ViewportMatrix is supplied to projectNode).
   * The DOM overlay reads these to position the anchor mark without re-applying
   * the viewport transform.
   */
  screenX?: number
  screenY?: number
}

// Local generation shape (MivoCanvasNode['generation'] is inline; we re-state it
// so RenderNode has zero MivoCanvasNode references).
export type RenderGeneration = {
  prompt: string
  model: string
  size?: string
  seed?: number
  strength?: number
  taskId?: string
  createdAt?: number
  maskBounds?: CanvasMaskBounds
}

export type RenderNode = {
  id: string
  type: CanvasNodeType
  status: NodeStatus
  title: string
  geometry: RenderGeometry
  hidden: boolean
  locked: boolean
  favorited: boolean
  /** Projected from selection state (ProjectionContext.selectedNodeIds). */
  selected: boolean
  fills: CanvasNodeFill[]
  strokes: CanvasNodeStroke[]
  effects?: CanvasNodeEffect[]
  // text
  text?: string
  fontSize?: number
  textColor?: string
  fontWeight?: number
  textAlign?: 'left' | 'center' | 'right'
  textAutoWidth?: boolean
  markdownDisplayMode?: MarkdownDisplayMode
  // markup
  markupKind?: MarkupKind
  markupBrushKind?: MarkupBrushKind
  markupStampKind?: CanvasStampKind
  markupPoints?: MarkupPoint[]
  markupStrokeColor?: string
  markupFillColor?: string
  markupStrokeWidth?: number
  markupStrokeStyle?: MarkupStrokeStyle
  markupOpacity?: number
  markupStartArrow?: boolean
  markupEndArrow?: boolean
  markupCornerRadius?: number
  // section / frame
  frameColor?: string
  sectionId?: string
  sectionFillColor?: string
  sectionBorderColor?: string
  sectionBorderWidth?: number
  sectionBorderStyle?: SectionBorderStyle
  sectionTitleVisible?: boolean
  sectionLockMode?: SectionLockMode
  sectionTemplateId?: string
  // asset
  assetUrl?: string
  assetMimeType?: string
  assetOriginalName?: string
  assetSizeBytes?: number
  imageHasTransparency?: boolean
  imageCrop?: ImageCrop
  // relations (normalized — always the V2 form)
  parentIds?: string[]
  groupId?: string
  sourceNodeId?: string
  targetNodeId?: string
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  // generation + aiWorkflow
  generation?: RenderGeneration
  aiWorkflow?: CanvasAiWorkflow
  /** P2-D1 experimental → P4-a CanvasAnchor. Projection isolates the change. */
  anchors?: RenderAnchor[]
}

export type RenderEdge = {
  id: string
  from: string
  to: string
  type: 'generate' | 'edit'
  prompt: string
  createdAt: number
}

export type ProjectionContext = {
  /** Selected node ids; when present, RenderNode.selected is derived from it. */
  selectedNodeIds?: ReadonlySet<string>
  /** Optional viewport matrix; fills RenderAnchor.screenX/Y when supplied. */
  matrix?: ViewportMatrix
}

// --- projection functions -----------------------------------------------------

/** Project an experimental anchor → RenderAnchor. Pure; no node lookup. */
export const projectAnchor = (anchor: ExperimentalAnchor, matrix?: ViewportMatrix): RenderAnchor => {
  const r: RenderAnchor = {
    id: anchor.id,
    type: anchor.type,
    targetNodeId: anchor.targetNodeId,
    x: anchor.x,
    y: anchor.y,
    instruction: anchor.instruction,
  }
  if (anchor.type === 'box') {
    r.width = anchor.width
    r.height = anchor.height
  }
  if (anchor.resultNodeIds) r.resultNodeIds = [...anchor.resultNodeIds]
  if (matrix) {
    r.screenX = anchor.x * matrix.scale + matrix.translateX
    r.screenY = anchor.y * matrix.scale + matrix.translateY
  }
  return r
}

const cloneFill = (fill: CanvasNodeFill): CanvasNodeFill => ({ ...fill })
const cloneStroke = (stroke: CanvasNodeStroke): CanvasNodeStroke => ({ ...stroke })
const cloneEffect = (effect: CanvasNodeEffect): CanvasNodeEffect => ({ ...effect })

/**
 * Project a (possibly legacy) MivoCanvasNode → RenderNode. Runs
 * normalizeCanvasNodeV2 so legacy + V2 inputs both yield the same V2-shaped
 * projection (geometry from transform, fills/strokes/asset/relations normalized).
 */
export const projectNode = (node: MivoCanvasNode, ctx?: ProjectionContext): RenderNode => {
  const n = normalizeCanvasNodeV2(node)
  const transform = n.transform ?? { x: n.x, y: n.y, width: n.width, height: n.height, rotation: 0 }
  const selected = ctx?.selectedNodeIds ? ctx.selectedNodeIds.has(n.id) : false

  const r: RenderNode = {
    id: n.id,
    type: n.type,
    status: n.status,
    title: n.title,
    geometry: {
      x: transform.x,
      y: transform.y,
      width: transform.width,
      height: transform.height,
      rotation: transform.rotation,
    },
    hidden: Boolean(n.hidden),
    locked: Boolean(n.locked),
    favorited: Boolean(n.favorited),
    selected,
    fills: n.fills ? n.fills.map(cloneFill) : [],
    strokes: n.strokes ? n.strokes.map(cloneStroke) : [],
  }

  if (n.effects) r.effects = n.effects.map(cloneEffect)

  // text
  if (n.text !== undefined) r.text = n.text
  if (n.fontSize !== undefined) r.fontSize = n.fontSize
  if (n.textColor !== undefined) r.textColor = n.textColor
  if (n.fontWeight !== undefined) r.fontWeight = n.fontWeight
  if (n.textAlign !== undefined) r.textAlign = n.textAlign
  if (n.textAutoWidth !== undefined) r.textAutoWidth = n.textAutoWidth
  if (n.markdownDisplayMode !== undefined) r.markdownDisplayMode = n.markdownDisplayMode

  // markup
  if (n.markupKind !== undefined) r.markupKind = n.markupKind
  if (n.markupBrushKind !== undefined) r.markupBrushKind = n.markupBrushKind
  if (n.markupStampKind !== undefined) r.markupStampKind = n.markupStampKind
  if (n.markupPoints) r.markupPoints = n.markupPoints.map((p) => ({ ...p }))
  if (n.markupStrokeColor !== undefined) r.markupStrokeColor = n.markupStrokeColor
  if (n.markupFillColor !== undefined) r.markupFillColor = n.markupFillColor
  if (n.markupStrokeWidth !== undefined) r.markupStrokeWidth = n.markupStrokeWidth
  if (n.markupStrokeStyle !== undefined) r.markupStrokeStyle = n.markupStrokeStyle
  if (n.markupOpacity !== undefined) r.markupOpacity = n.markupOpacity
  if (n.markupStartArrow !== undefined) r.markupStartArrow = n.markupStartArrow
  if (n.markupEndArrow !== undefined) r.markupEndArrow = n.markupEndArrow
  if (n.markupCornerRadius !== undefined) r.markupCornerRadius = n.markupCornerRadius

  // section / frame
  if (n.frameColor !== undefined) r.frameColor = n.frameColor
  if (n.sectionId !== undefined) r.sectionId = n.sectionId
  if (n.sectionFillColor !== undefined) r.sectionFillColor = n.sectionFillColor
  if (n.sectionBorderColor !== undefined) r.sectionBorderColor = n.sectionBorderColor
  if (n.sectionBorderWidth !== undefined) r.sectionBorderWidth = n.sectionBorderWidth
  if (n.sectionBorderStyle !== undefined) r.sectionBorderStyle = n.sectionBorderStyle
  if (n.sectionTitleVisible !== undefined) r.sectionTitleVisible = n.sectionTitleVisible
  if (n.sectionLockMode !== undefined) r.sectionLockMode = n.sectionLockMode
  if (n.sectionTemplateId !== undefined) r.sectionTemplateId = n.sectionTemplateId

  // asset
  if (n.assetUrl !== undefined) r.assetUrl = n.assetUrl
  if (n.assetMimeType !== undefined) r.assetMimeType = n.assetMimeType
  if (n.assetOriginalName !== undefined) r.assetOriginalName = n.assetOriginalName
  if (n.assetSizeBytes !== undefined) r.assetSizeBytes = n.assetSizeBytes
  if (n.imageHasTransparency !== undefined) r.imageHasTransparency = n.imageHasTransparency
  if (n.imageCrop !== undefined) r.imageCrop = n.imageCrop

  // relations (normalized V2 form — parentIds cloned, connector bindings cloned)
  if (n.parentIds) r.parentIds = [...n.parentIds]
  if (n.groupId !== undefined) r.groupId = n.groupId
  if (n.sourceNodeId !== undefined) r.sourceNodeId = n.sourceNodeId
  if (n.targetNodeId !== undefined) r.targetNodeId = n.targetNodeId
  if (n.connectorStart) r.connectorStart = { ...n.connectorStart }
  if (n.connectorEnd) r.connectorEnd = { ...n.connectorEnd }

  // generation + aiWorkflow
  if (n.generation) r.generation = { ...n.generation, ...(n.generation.maskBounds ? { maskBounds: { ...n.generation.maskBounds } } : {}) }
  if (n.aiWorkflow) r.aiWorkflow = { ...n.aiWorkflow, ...(n.aiWorkflow.sourceNodeIds ? { sourceNodeIds: [...n.aiWorkflow.sourceNodeIds] } : {}) }

  // anchors (experimental → RenderAnchor; P4-a swaps the source)
  if (n.experimentalAnchors?.length) {
    r.anchors = n.experimentalAnchors.map((a) => projectAnchor(a, ctx?.matrix))
  }

  return r
}

/** Project all nodes (convenience; same as nodes.map(n => projectNode(n, ctx))). */
export const projectNodes = (nodes: MivoCanvasNode[], ctx?: ProjectionContext): RenderNode[] =>
  nodes.map((n) => projectNode(n, ctx))

/** Project a CanvasEdge → RenderEdge (passthrough + clone). */
export const projectEdge = (edge: CanvasEdge): RenderEdge => ({ ...edge })

/** Project all edges. */
export const projectEdges = (edges: CanvasEdge[]): RenderEdge[] => edges.map(projectEdge)
