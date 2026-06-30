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
export type MarkupKind = 'arrow' | 'line' | 'rect' | 'ellipse' | 'brush' | 'note'
export type MarkupStrokeStyle = 'solid' | 'dashed'
export type MarkdownDisplayMode = 'full' | 'preview'
export type ConnectorAnchor = 'center' | 'top' | 'right' | 'bottom' | 'left'
export type MarkupPoint = {
  x: number
  y: number
}
export type ConnectorBinding = {
  nodeId: string
  anchor: ConnectorAnchor
  offset?: number
}
export type AiWorkflowKind = 'slot' | 'annotation' | 'result'
export type AiWorkflowStatus = 'empty' | 'queued' | 'generating' | 'ready' | 'failed'
export type AiWorkflowOperation = 'slot-generation' | 'beside-generation' | 'annotation-edit' | 'variation'
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

export type MivoCanvasNode = {
  id: string
  type: CanvasNodeType
  title: string
  x: number
  y: number
  width: number
  height: number
  text?: string
  fontSize?: number
  textColor?: string
  fontWeight?: number
  textAlign?: 'left' | 'center' | 'right'
  textAutoWidth?: boolean
  markupKind?: MarkupKind
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
  generation?: {
    prompt: string
    model: string
    size: string
    seed: number
    strength?: number
    taskId?: string
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
  links: Array<{
    kind: AiWorkflowOperation | 'parent' | 'connector'
    fromNodeId: string
    toNodeId: string
  }>
}

export type CanvasTask = {
  id: string
  label: string
  status: 'running' | 'queued' | 'failed' | 'done'
  progress: number
  nodeIds: string[]
}

export type MivoCanvasSnapshot = {
  version: 1
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}

export type CanvasDocument = {
  title: string
  sourceTemplateId?: DemoSceneId
  projectId?: string
  nodes: MivoCanvasNode[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}

export type SceneDefinition = {
  id: DemoSceneId
  label: string
  nodes: MivoCanvasNode[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}
