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
  | 'comment'
  | 'image'
  | 'video'
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
  }
  aiWorkflow?: CanvasAiWorkflow
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
  nodeIds: string[]
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

export type CanvasDocument = {
  title: string
  sourceTemplateId?: DemoSceneId
  projectId?: string
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
