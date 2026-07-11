import type { ImageDimensions } from '../lib/imageSizing'

export type ToolId =
  | 'select'
  | 'hand'
  | 'import'
  | 'text-to-image'
  | 'image-to-image'
  | 'variations'
  | 'upscale'
  | 'remove-bg'
  | 'asset'
  | 'text'
  | 'frame'
  | 'markup-arrow'
  | 'markup-line'
  | 'markup-rect'
  | 'markup-ellipse'
  | 'markup-brush'
  | 'markup-note'
  | 'brush'
  | 'stamp'
  | 'sticker'
  | 'crop'
  | 'expand'
  | 'mask'

export type CanvasId = string

export type DemoSceneId =
  | 'character-flow'
  | 'variants'
  | 'task-states'
  | 'stress-test'
  | 'asset-handoff'
  | 'empty'

export type NodeStatus = 'ready' | 'generating' | 'failed' | 'queued'

export type CanvasNodeType =
  | 'image'
  | 'task-placeholder'
  | 'text'
  | 'frame'
  | 'ai-slot'
  | 'annotation'
  | 'markup'
  | 'markdown'
  | 'pdf'
  | 'video'
export type CanvasAssetNodeType = Extract<CanvasNodeType, 'image' | 'markdown' | 'pdf' | 'video'>
export type SectionBorderStyle = 'solid' | 'dashed'
export type SectionLockMode = 'all' | 'background'
export type MarkupKind = 'arrow' | 'line' | 'rect' | 'ellipse' | 'brush' | 'note' | 'stamp'
export type CanvasStampKind =
  | 'plus-one'
  | 'heart'
  | 'star'
  | 'check'
  | 'question'
  | 'thumbs-down'
  | 'down-2'
  | 'face'
  | 'smile'
  | 'eyes'
export type MarkupStrokeStyle = 'solid' | 'dashed'
export type MarkdownDisplayMode = 'full' | 'preview'
export type ConnectorAnchor = 'center' | 'top' | 'right' | 'bottom' | 'left'
export type MarkupPoint = {
  x: number
  y: number
  /** Stylus pressure in [0, 1]; only recorded for pen input so mouse strokes keep simulated pressure. */
  pressure?: number
}
export type MarkupBrushKind = 'marker' | 'highlighter'
/** Brush tool modes: the two stroke kinds plus the FigJam-style whole-stroke eraser. */
export type BrushToolMode = MarkupBrushKind | 'eraser'
export type ConnectorBinding = {
  nodeId: string
  anchor: ConnectorAnchor
  offset?: number
}
export type CanvasEdgeType = 'generate' | 'edit'
export type CanvasMaskBounds = {
  x: number
  y: number
  width: number
  height: number
}
export type CanvasEdge = {
  id: string
  from: string
  to: string
  type: CanvasEdgeType
  prompt: string
  createdAt: number
}
export type AiWorkflowKind = 'slot' | 'annotation' | 'result'
export type AiWorkflowStatus = 'empty' | 'queued' | 'generating' | 'ready' | 'failed' | 'canceled'
export type AiWorkflowOperation =
  | 'slot-generation'
  | 'beside-generation'
  | 'annotation-edit'
  | 'variation'
  | 'prompt-edit'
  | 'area-edit'
  | 'remove-background'
  | 'outpaint'
  | 'upscale'
export type AiWorkflowPlacement = 'slot' | 'right' | 'left' | 'below'

export type CanvasAiWorkflow = {
  kind: AiWorkflowKind
  status?: AiWorkflowStatus
  operation?: AiWorkflowOperation
  prompt?: string
  sourceNodeIds?: string[]
  anchorNodeId?: string
  annotationNodeId?: string
  slotId?: string
  placement?: AiWorkflowPlacement
  createdAt?: number
  /** F5 (QoL batch): monotonic server progress 0..100, patched on each poll. */
  progress?: number
  /** F5 (QoL batch): server stage label (e.g. "enhancing" / "rendering"). */
  stage?: string
  /** F5 (QoL batch): epoch ms when generation started, for elapsed-time display. */
  startedAt?: number
  /** F5 (QoL batch): derived elapsed seconds (now - startedAt), patched on each
   *  poll so the render stays pure (no Date.now() during render). */
  elapsedSec?: number
}

export type ImageCrop = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasNodeTransform = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export type CanvasNodeSolidFill = {
  id: string
  kind: 'solid'
  color: string
  opacity: number
  visible: boolean
}

export type CanvasNodeImageFill = {
  id: string
  kind: 'image'
  assetUrl: string
  opacity: number
  visible: boolean
  scaleMode: 'fill' | 'fit' | 'crop' | 'tile'
}

export type CanvasNodeFill = CanvasNodeSolidFill | CanvasNodeImageFill

export type CanvasNodeStroke = {
  id: string
  color: string
  width: number
  style: MarkupStrokeStyle
  opacity: number
  visible: boolean
}

export type CanvasNodeEffect =
  | {
      id: string
      kind: 'shadow'
      color: string
      x: number
      y: number
      blur: number
      spread: number
      opacity: number
      visible: boolean
    }
  | {
      id: string
      kind: 'blur'
      radius: number
      visible: boolean
    }

export type CanvasNodeLayout = {
  mode: 'none' | 'auto'
  direction?: 'horizontal' | 'vertical'
  gap?: number
  padding?: {
    top: number
    right: number
    bottom: number
    left: number
  }
}

export type CanvasNodeConstraints = {
  horizontal?: 'left' | 'right' | 'left-right' | 'center' | 'scale'
  vertical?: 'top' | 'bottom' | 'top-bottom' | 'center' | 'scale'
}

export type CanvasNodeAssetRef = {
  url: string
  mimeType?: string
  originalName?: string
  sizeBytes?: number
}

export type CanvasNodeRelations = {
  parentIds?: string[]
  sectionId?: string
  targetNodeId?: string
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  aiWorkflow?: CanvasAiWorkflow
}

// P2-D1 EXPERIMENTAL — Anchor MVP field (roadmap §7 组 D). Optional + backward
// compatible: no persist key/version bump (rides along in compactNodeForPersist via
// cloneNode). Canvas-coordinate (x/y relative to the canvas, NOT the node). box
// anchors require width/height; point anchors omit them. NEVER store UI temp state
// here (drag-in-progress, uncommitted selection) — only committed anchors.
// Migration rule (roadmap §9 P4-a): this field is either收编为 the formal
// CanvasAnchor type or removed (with its actions) once the spike resolves.
export type ExperimentalAnchorType = 'point' | 'box'
export type ExperimentalAnchor = {
  id: string
  type: ExperimentalAnchorType
  targetNodeId: string
  x: number
  y: number
  instruction: string
  createdAt: number
  /** Required for type==='box'; meaningless for type==='point'. */
  width?: number
  height?: number
  /** Node ids produced by generation triggered from this anchor (recorded on success). */
  resultNodeIds?: string[]
}

export type MivoCanvasNode = {
  id: string
  type: CanvasNodeType
  title: string
  x: number
  y: number
  width: number
  height: number
  transform?: CanvasNodeTransform
  fills?: CanvasNodeFill[]
  strokes?: CanvasNodeStroke[]
  effects?: CanvasNodeEffect[]
  layout?: CanvasNodeLayout
  constraints?: CanvasNodeConstraints
  asset?: CanvasNodeAssetRef
  relations?: CanvasNodeRelations
  text?: string
  fontSize?: number
  textColor?: string
  fontWeight?: number
  textAlign?: 'left' | 'center' | 'right'
  textAutoWidth?: boolean
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
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  targetNodeId?: string
  frameColor?: string
  sectionId?: string
  sectionFillColor?: string
  sectionBorderColor?: string
  sectionBorderWidth?: number
  sectionBorderStyle?: SectionBorderStyle
  sectionTitleVisible?: boolean
  sectionLockMode?: SectionLockMode
  sectionTemplateId?: string
  assetUrl?: string
  assetMimeType?: string
  assetOriginalName?: string
  assetSizeBytes?: number
  markdownDisplayMode?: MarkdownDisplayMode
  imageHasTransparency?: boolean
  assetSourceDimensions?: ImageDimensions
  imageCrop?: ImageCrop
  status: NodeStatus
  parentIds?: string[]
  groupId?: string
  locked?: boolean
  hidden?: boolean
  favorited?: boolean
  sourceNodeId?: string
  generation?: {
    prompt: string
    model: string
    size?: string
    seed?: number
    strength?: number
    taskId?: string
    createdAt?: number
    maskBounds?: CanvasMaskBounds
    // 黑块修复：maskBounds 的坐标空间标定。仅局部重绘（area-edit）结果节点携带，
    // 值为提交编辑时源图的 natural pixel 尺寸 —— 二次重绘时把上次洞区等比映射到
    // 新源图空间做高优先黑块检测。可选 + 向后兼容：不 bump persist version，
    // 缺失（旧数据 / annotation 画布坐标路径）时检测器跳过历史洞区。
    maskSourceSize?: { width: number; height: number }
  }
  aiWorkflow?: CanvasAiWorkflow
  /** P2-D1 EXPERIMENTAL — see {@link ExperimentalAnchor}. Undefined on most nodes. */
  experimentalAnchors?: ExperimentalAnchor[]
  // P2-C2 EXPERIMENTAL — annotation area-edit bounds (roadmap §7 组 C). Optional +
  // backward compatible: no persist key/version bump (rides along in
  // compactNodeForPersist via cloneNode, like experimentalAnchors). Canvas-coordinate
  // (x/y relative to the canvas, NOT the node). Only meaningful on annotation nodes
  // (points at the editable region of the source image). The client normalizes this
  // to the source node's relative 0-1 maskBounds before sending to /tasks/edit; the
  // BFF synthesizes the mask PNG (see server/lib/maskPng.ts). Migration rule (roadmap
  // §9 P4-a):收编为 a formal field or removed once the area-edit spike resolves.
  annotationBounds?: CanvasMaskBounds
}

export type AiCanvasContextNode = {
  id: string
  type: CanvasNodeType
  title: string
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  status: NodeStatus
  text?: string
  assetUrl?: string
  assetMimeType?: string
  assetOriginalName?: string
  assetSizeBytes?: number
  sectionId?: string
  targetNodeId?: string
  markupKind?: MarkupKind
  markupBrushKind?: MarkupBrushKind
  markupStampKind?: CanvasStampKind
  markupPoints?: MarkupPoint[]
  markupStrokeColor?: string
  markupFillColor?: string
  markupStrokeWidth?: number
  markupStrokeStyle?: MarkupStrokeStyle
  markupStartArrow?: boolean
  markupEndArrow?: boolean
  markupCornerRadius?: number
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  generation?: MivoCanvasNode['generation']
  aiWorkflow?: CanvasAiWorkflow
}

export type AiCanvasContextSnapshot = {
  version: 1
  sceneId: CanvasId
  selectedNodeIds: string[]
  summary: {
    nodes: number
    images: number
    slots: number
    annotations: number
    results: number
  }
  nodes: AiCanvasContextNode[]
  edges: CanvasEdge[]
  links: Array<{
    kind: AiWorkflowOperation | CanvasEdgeType | 'parent' | 'connector'
    fromNodeId: string
    toNodeId: string
  }>
}

export type CanvasTask = {
  id: string
  label: string
  status: 'running' | 'queued' | 'failed' | 'done' | 'canceled'
  progress: number
  // P2-C1b: server-side pipeline stage from GET /tasks/:id (submit|upload|poll|
  // download|request|done|failed|canceled). Optional — legacy/mock tasks
  // (variations, annotation) don't track stage. Not asserted by A1 contracts.
  stage?: string
  nodeIds: string[]
  // Demo seed tasks (task-running, task-asset) carry preset:true so the
  // hydration settle pass (canvasGenerationHydration.ts) skips them instead of
  // misjudging them as expired generations on boot. Real/user tasks never set
  // this — only the two fixed demo ids in demoScenes.ts. Persisted as-is (rides
  // along in compactDocumentForPersist via cloneTask) so it survives rehydrate.
  preset?: true
}

export type MivoCanvasSnapshot = {
  version: 2
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  edges: CanvasEdge[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}

export type CanvasProject = {
  id: string
  name: string
  /** ISO timestamp; set once at createProject time. */
  createdAt: string
}

export type CanvasDocument = {
  title: string
  sourceTemplateId?: DemoSceneId
  projectId?: string
  /** ISO timestamp; set once when the canvas is created (normalizeDocument backfills for legacy snapshots). */
  createdAt: string
  /** ISO timestamp; bumped on user-visible content changes (nodes/edges/tasks/title), not on selection-only patches. */
  updatedAt: string
  nodes: MivoCanvasNode[]
  edges: CanvasEdge[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}

export type SceneDefinition = {
  id: DemoSceneId
  label: string
  nodes: MivoCanvasNode[]
  edges?: CanvasEdge[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}

// ── F6 返修五:runtime enum 值数组(单一来源,shared/persist-contract.ts enum predicate 用)──
// 用 `as const satisfies readonly T[]` 让编译期保证数组元素穷尽 type 且不漂移;改枚举必须同步此处,
// 否则 satisfies 报错。服务端 tsconfig ES2023 可编译(纯数据数组,无 DOM/Node API;type import 已 erase)。
export const MARKUP_KIND_VALUES = ['arrow', 'line', 'rect', 'ellipse', 'brush', 'note', 'stamp'] as const satisfies readonly MarkupKind[]
export const MARKUP_BRUSH_KIND_VALUES = ['marker', 'highlighter'] as const satisfies readonly MarkupBrushKind[]
export const CANVAS_STAMP_KIND_VALUES = [
  'plus-one', 'heart', 'star', 'check', 'question', 'thumbs-down', 'down-2', 'face', 'smile', 'eyes',
] as const satisfies readonly CanvasStampKind[]
export const SECTION_LOCK_MODE_VALUES = ['all', 'background'] as const satisfies readonly SectionLockMode[]
export const MARKDOWN_DISPLAY_MODE_VALUES = ['full', 'preview'] as const satisfies readonly MarkdownDisplayMode[]
export const MARKUP_STROKE_STYLE_VALUES = ['solid', 'dashed'] as const satisfies readonly MarkupStrokeStyle[]
export const EXPERIMENTAL_ANCHOR_TYPE_VALUES = ['point', 'box'] as const satisfies readonly ExperimentalAnchorType[]
