// src/kernel/records.ts
// T1.2 S1 纯脚手架:document 域 record 类型定义(按 record-schema.md K40 + 裁决)。
// 权威:docs/decisions/record-schema.md(#174 已合入)。本文件只定义类型,不接线任何 store/渲染。
//
// 裁决落点(2026-07-10):
// - K40/D24:NodeRecord 存 K40(canonical),D24 派生不存(legacy 侧由 mapping.fromRecord 重算)。
// - 单一家园(矛盾 1):纯图关系字段(parentIds/sectionId/targetNodeId/connectorStart/connectorEnd)
//   canonical 归 relations;aiWorkflow canonical 留顶层,relations.aiWorkflow 移除(Omit)。
// - status:record 不存(D),session 派生自 tasks(派生规则见 mapping.fromRecord)。
// - experimentalAnchors:收编为顶层 Anchor record(§4.2);NodeRecord.experimentalAnchors 为
//   node-embedded 过渡形态,mapping 负责 legacy.experimentalAnchors ↔ AnchorRecord[] 收编。
// - 每节点独立 record 带 revision(platform §13.5 硬约束)。

import type {
  CanvasAiWorkflow,
  CanvasEdgeType,
  CanvasMaskBounds,
  CanvasNodeAssetRef,
  CanvasNodeConstraints,
  CanvasNodeEffect,
  CanvasNodeFill,
  CanvasNodeLayout,
  CanvasNodeRelations,
  CanvasNodeStroke,
  CanvasNodeTransform,
  CanvasNodeType,
  ExperimentalAnchor,
  ExperimentalAnchorType,
  ImageCrop,
  MarkupBrushKind,
  MarkupKind,
  MarkupPoint,
  SectionLockMode,
} from '../types/mivoCanvas'

/** Per-record revision(节点级合并 tie-break,platform §13.5)。 */
export type Revision = number

/**
 * relations 类型(裁决 6):CanvasNodeRelations Omit aiWorkflow。
 * aiWorkflow canonical 留 NodeRecord.aiWorkflow(顶层),relations 内不再镜像。
 */
export type NodeRelations = Omit<CanvasNodeRelations, 'aiWorkflow'>

/** generation inline(与 mivoCanvas.ts:313-327 同形;record-schema §3.7)。 */
export type NodeGeneration = {
  prompt: string
  model: string
  size?: string
  seed?: number
  strength?: number
  taskId?: string
  createdAt?: number
  maskBounds?: CanvasMaskBounds
  maskSourceSize?: { width: number; height: number }
}

/**
 * NodeRecord:document 域节点 record(K40 + revision)。
 * D24(x/y/w/h、assetUrl/MimeType/OriginalName/SizeBytes、sectionColor/frameColor、markup 镜像、
 * parentIds/sectionId/targetNodeId/connectorStart/connectorEnd、status)不在此,由
 * mapping.fromRecord 从 canonical 重算(record-schema §0 注)。
 */
export type NodeRecord = {
  id: string
  type: CanvasNodeType
  title: string
  revision: Revision
  transform: CanvasNodeTransform
  fills: CanvasNodeFill[]
  strokes: CanvasNodeStroke[]
  effects: CanvasNodeEffect[]
  layout?: CanvasNodeLayout
  constraints?: CanvasNodeConstraints
  asset?: CanvasNodeAssetRef
  relations: NodeRelations
  text?: string
  fontSize?: number
  textColor?: string
  fontWeight?: number
  textAlign?: 'left' | 'center' | 'right'
  textAutoWidth?: boolean
  markupKind?: MarkupKind
  markupBrushKind?: MarkupBrushKind
  markupStampKind?: import('../types/mivoCanvas').CanvasStampKind
  markupPoints?: MarkupPoint[]
  markupStartArrow?: boolean
  markupEndArrow?: boolean
  markupCornerRadius?: number
  sectionTitleVisible?: boolean
  sectionLockMode?: SectionLockMode
  sectionTemplateId?: string
  markdownDisplayMode?: import('../types/mivoCanvas').MarkdownDisplayMode
  imageHasTransparency?: boolean
  assetSourceDimensions?: { width: number; height: number }
  imageCrop?: ImageCrop
  sourceNodeId?: string
  groupId?: string
  locked?: boolean
  hidden?: boolean
  favorited?: boolean
  generation?: NodeGeneration
  aiWorkflow?: CanvasAiWorkflow
  /** node-embedded 过渡形态;收编目标 = 顶层 AnchorRecord(见 mapping 提取)。 */
  experimentalAnchors?: ExperimentalAnchor[]
  annotationBounds?: CanvasMaskBounds
}

/** EdgeRecord:document 域边 record(对应 CanvasEdge,带 revision)。 */
export type EdgeRecord = {
  id: string
  from: string
  to: string
  type: CanvasEdgeType
  prompt: string
  createdAt: number
  revision: Revision
}

/**
 * AnchorRecord:document 域顶层锚点 record(裁决 DP-2 收编)。
 * 从 legacy node.experimentalAnchors 提取为独立 record(每 anchor 独立 id+revision)。
 */
export type AnchorRecord = {
  id: string
  type: ExperimentalAnchorType
  targetNodeId: string
  x: number
  y: number
  instruction: string
  createdAt: number
  width?: number
  height?: number
  resultNodeIds?: string[]
  revision: Revision
}
