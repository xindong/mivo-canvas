// src/kernel/mapping.ts
// T1.2 S1 纯脚手架:legacy MivoCanvasNode ↔ record 双向映射纯函数。
// 权威:docs/decisions/record-schema.md(K40/D24、单一家园、status 派生)+ documentModelV2.ts
// (legacy 侧合成/镜像逻辑;本文件镜像其 reverse-derivation,但不 import 它,保持 kernel 自洽)。
//
// 不接线任何 store/渲染;legacy 零行为变化(kernel=legacy 默认不消费本路径)。
// 单测(mapping.test.ts):64 字段往返无损(record round-trip + 一致节点 node round-trip)。

import type { MivoCanvasNode, CanvasNodeFill, CanvasNodeSolidFill, CanvasNodeStroke, NodeStatus } from '../types/mivoCanvas'
import type { AnchorRecord, EdgeRecord, NodeRecord, NodeRelations, Revision } from './records'

// ─── helpers(镜像 documentModelV2 的判别 + 合成,reverse 方向)──────────────────
const isSolidFill = (fill: CanvasNodeFill): fill is CanvasNodeSolidFill => fill.kind === 'solid'

const firstVisibleSolidFill = (fills: CanvasNodeFill[] | undefined): CanvasNodeSolidFill | undefined =>
  fills?.find((f): f is CanvasNodeSolidFill => f.visible && isSolidFill(f))
const firstVisibleStroke = (strokes: CanvasNodeStroke[] | undefined) => strokes?.find((s) => s.visible)

// status 派生规则(record-schema §2.1 裁决):task 不存在时 → 有 asset→ready、无 asset→failed。
// (task 存在→随 task 状态,S1 无 tasks 上下文,仅 fallback 分支;真实 task 派生在 S2/S3 + tasks registry。)
const deriveStatus = (node: Pick<MivoCanvasNode, 'asset' | 'assetUrl'>): NodeStatus =>
  node.asset || node.assetUrl ? 'ready' : 'failed'

// ─── toRecord:legacy node → NodeRecord(提取 K40,丢 D24)──────────────────────
export const toRecord = (node: MivoCanvasNode, revision: Revision = 0): NodeRecord => {
  // relations:单一家园(裁决 6)— 顶层 aiWorkflow 留 NodeRecord.aiWorkflow,relations 内移除。
  const rel = node.relations
  const relations: NodeRelations = {
    ...(rel?.parentIds ? { parentIds: [...rel.parentIds] } : {}),
    ...(rel?.sectionId ? { sectionId: rel.sectionId } : {}),
    ...(rel?.targetNodeId ? { targetNodeId: rel.targetNodeId } : {}),
    ...(rel?.connectorStart ? { connectorStart: { ...rel.connectorStart } } : {}),
    ...(rel?.connectorEnd ? { connectorEnd: { ...rel.connectorEnd } } : {}),
  }

  return {
    id: node.id,
    type: node.type,
    title: node.title,
    revision,
    transform: {
      x: node.transform?.x ?? node.x,
      y: node.transform?.y ?? node.y,
      width: node.transform?.width ?? node.width,
      height: node.transform?.height ?? node.height,
      rotation: node.transform?.rotation ?? 0,
    },
    fills: node.fills ? node.fills.map((f) => ({ ...f })) : [],
    strokes: node.strokes ? node.strokes.map((s) => ({ ...s })) : [],
    effects: node.effects ? node.effects.map((e) => ({ ...e })) : [],
    layout: node.layout ? { ...node.layout, ...(node.layout.padding ? { padding: { ...node.layout.padding } } : {}) } : undefined,
    constraints: node.constraints ? { ...node.constraints } : undefined,
    asset: node.asset ? { ...node.asset } : (node.assetUrl ? { url: node.assetUrl, mimeType: node.assetMimeType, originalName: node.assetOriginalName, sizeBytes: node.assetSizeBytes } : undefined),
    relations,
    text: node.text,
    fontSize: node.fontSize,
    textColor: node.textColor,
    fontWeight: node.fontWeight,
    textAlign: node.textAlign,
    textAutoWidth: node.textAutoWidth,
    markupKind: node.markupKind,
    markupBrushKind: node.markupBrushKind,
    markupStampKind: node.markupStampKind,
    markupPoints: node.markupPoints ? node.markupPoints.map((p) => ({ ...p })) : undefined,
    markupStartArrow: node.markupStartArrow,
    markupEndArrow: node.markupEndArrow,
    markupCornerRadius: node.markupCornerRadius,
    sectionTitleVisible: node.sectionTitleVisible,
    sectionLockMode: node.sectionLockMode,
    sectionTemplateId: node.sectionTemplateId,
    markdownDisplayMode: node.markdownDisplayMode,
    imageHasTransparency: node.imageHasTransparency,
    assetSourceDimensions: node.assetSourceDimensions ? { ...node.assetSourceDimensions } : undefined,
    imageCrop: node.imageCrop ? { ...node.imageCrop } : undefined,
    sourceNodeId: node.sourceNodeId,
    groupId: node.groupId,
    locked: node.locked,
    hidden: node.hidden,
    favorited: node.favorited,
    generation: node.generation ? { ...node.generation, ...(node.generation.maskBounds ? { maskBounds: { ...node.generation.maskBounds } } : {}), ...(node.generation.maskSourceSize ? { maskSourceSize: { ...node.generation.maskSourceSize } } : {}) } : undefined,
    // aiWorkflow canonical 顶层(裁决 6);relations.aiWorkflow 不取(移除)。
    aiWorkflow: node.aiWorkflow
      ? { ...node.aiWorkflow, ...(node.aiWorkflow.sourceNodeIds ? { sourceNodeIds: [...node.aiWorkflow.sourceNodeIds] } : {}) }
      : (rel?.aiWorkflow
        ? { ...rel.aiWorkflow, ...(rel.aiWorkflow.sourceNodeIds ? { sourceNodeIds: [...rel.aiWorkflow.sourceNodeIds] } : {}) }
        : undefined),
    experimentalAnchors: node.experimentalAnchors ? node.experimentalAnchors.map((a) => ({ ...a, ...(a.resultNodeIds ? { resultNodeIds: [...a.resultNodeIds] } : {}) })) : undefined,
    annotationBounds: node.annotationBounds ? { ...node.annotationBounds } : undefined,
  }
}

// ─── fromRecord:NodeRecord → legacy MivoCanvasNode(K40 + D24 重算)─────────────
// D24 镜像由 canonical 重算(镜像 documentModelV2 setNodeFills/setNodeStrokes/setNodeAsset/
// setNodeRelations + transformForNode 的 reverse-derivation)。
export const fromRecord = (r: NodeRecord): MivoCanvasNode => {
  const t = r.transform
  const solid = firstVisibleSolidFill(r.fills)
  const stroke = firstVisibleStroke(r.strokes)

  // D24:几何镜像 transform(同 documentModelV2 withLegacyGeometry)
  const x = t.x, y = t.y, width = t.width, height = t.height

  // D24:资产镜像 asset(同 setNodeAsset L362-374)
  const assetUrl = r.asset?.url
  const assetMimeType = r.asset?.mimeType
  const assetOriginalName = r.asset?.originalName
  const assetSizeBytes = r.asset?.sizeBytes

  // D24:section/markup 镜像 fills/strokes(同 setNodeFills L312-334 / setNodeStrokes L336-360)
  const sectionFillColor = (r.type === 'frame' && solid) ? solid.color : undefined
  const sectionBorderColor = (r.type === 'frame' && stroke) ? stroke.color : undefined
  const sectionBorderWidth = (r.type === 'frame' && stroke) ? stroke.width : undefined
  const sectionBorderStyle = (r.type === 'frame' && stroke) ? stroke.style : undefined
  const frameColor = (r.type === 'frame' && stroke) ? stroke.color : undefined // 镜像 stroke color(frame)
  const markupFillColor = (r.type === 'markup' && solid) ? solid.color : undefined
  const markupOpacity = (r.type === 'markup' && solid) ? solid.opacity : undefined
  const markupStrokeColor = (r.type === 'markup' && stroke) ? stroke.color : undefined
  const markupStrokeWidth = (r.type === 'markup' && stroke) ? stroke.width : undefined
  const markupStrokeStyle = (r.type === 'markup' && stroke) ? stroke.style : undefined
  // markupOpacity 已由 fills 设(markup + solid);strokes 的 opacity 仅当 fills 无 solid 时回退:
  const markupOpacityFromStroke = (r.type === 'markup' && stroke && !solid) ? stroke.opacity : undefined
  const markupOpacityFinal = markupOpacity ?? markupOpacityFromStroke

  // D24:关系镜像 relations(同 setNodeRelations L376-393;aiWorkflow 不镜像进 relations — 单一家园)
  const parentIds = r.relations?.parentIds ? [...r.relations.parentIds] : undefined
  const sectionId = r.relations?.sectionId
  const targetNodeId = r.relations?.targetNodeId
  const connectorStart = r.relations?.connectorStart ? { ...r.relations.connectorStart } : undefined
  const connectorEnd = r.relations?.connectorEnd ? { ...r.relations.connectorEnd } : undefined

  // relations(canonical,带 parentIds/sectionId/targetNodeId/connectorStart/connectorEnd;无 aiWorkflow)
  const relations = r.relations

  // D24:status 派生(record-schema §2.1)
  const status = deriveStatus(r)

  const node: MivoCanvasNode = {
    id: r.id,
    type: r.type,
    title: r.title,
    x, y, width, height,
    transform: t,
    fills: r.fills.map((f) => ({ ...f })),
    strokes: r.strokes.map((s) => ({ ...s })),
    effects: r.effects ? r.effects.map((e) => ({ ...e })) : undefined,
    layout: r.layout ? { ...r.layout, ...(r.layout.padding ? { padding: { ...r.layout.padding } } : {}) } : undefined,
    constraints: r.constraints ? { ...r.constraints } : undefined,
    asset: r.asset ? { ...r.asset } : undefined,
    assetUrl, assetMimeType, assetOriginalName, assetSizeBytes,
    relations,
    parentIds, sectionId, targetNodeId, connectorStart, connectorEnd,
    text: r.text,
    fontSize: r.fontSize,
    textColor: r.textColor,
    fontWeight: r.fontWeight,
    textAlign: r.textAlign,
    textAutoWidth: r.textAutoWidth,
    markupKind: r.markupKind,
    markupBrushKind: r.markupBrushKind,
    markupStampKind: r.markupStampKind,
    markupPoints: r.markupPoints ? r.markupPoints.map((p) => ({ ...p })) : undefined,
    markupStrokeColor, markupFillColor, markupStrokeWidth, markupStrokeStyle,
    markupOpacity: markupOpacityFinal,
    markupStartArrow: r.markupStartArrow,
    markupEndArrow: r.markupEndArrow,
    markupCornerRadius: r.markupCornerRadius,
    frameColor,
    sectionFillColor, sectionBorderColor, sectionBorderWidth, sectionBorderStyle,
    sectionTitleVisible: r.sectionTitleVisible,
    sectionLockMode: r.sectionLockMode,
    sectionTemplateId: r.sectionTemplateId,
    markdownDisplayMode: r.markdownDisplayMode,
    imageHasTransparency: r.imageHasTransparency,
    assetSourceDimensions: r.assetSourceDimensions ? { ...r.assetSourceDimensions } : undefined,
    imageCrop: r.imageCrop ? { ...r.imageCrop } : undefined,
    status,
    groupId: r.groupId,
    locked: r.locked,
    hidden: r.hidden,
    favorited: r.favorited,
    sourceNodeId: r.sourceNodeId,
    generation: r.generation ? { ...r.generation, ...(r.generation.maskBounds ? { maskBounds: { ...r.generation.maskBounds } } : {}), ...(r.generation.maskSourceSize ? { maskSourceSize: { ...r.generation.maskSourceSize } } : {}) } : undefined,
    aiWorkflow: r.aiWorkflow ? { ...r.aiWorkflow, ...(r.aiWorkflow.sourceNodeIds ? { sourceNodeIds: [...r.aiWorkflow.sourceNodeIds] } : {}) } : undefined,
    experimentalAnchors: r.experimentalAnchors ? r.experimentalAnchors.map((a) => ({ ...a, ...(a.resultNodeIds ? { resultNodeIds: [...a.resultNodeIds] } : {}) })) : undefined,
    annotationBounds: r.annotationBounds ? { ...r.annotationBounds } : undefined,
  }
  return node
}

// ─── EdgeRecord 映射 ───────────────────────────────────────────────────
export const edgeToRecord = (edge: import('../types/mivoCanvas').CanvasEdge, revision: Revision = 0): EdgeRecord => ({
  id: edge.id, from: edge.from, to: edge.to, type: edge.type, prompt: edge.prompt, createdAt: edge.createdAt, revision,
})
export const edgeFromRecord = (r: EdgeRecord): import('../types/mivoCanvas').CanvasEdge => ({
  id: r.id, from: r.from, to: r.to, type: r.type, prompt: r.prompt, createdAt: r.createdAt,
})

// ─── AnchorRecord 映射(收编:legacy node.experimentalAnchors[] → AnchorRecord[])──
export const anchorsToRecords = (anchors: MivoCanvasNode['experimentalAnchors'], revision: Revision = 0): AnchorRecord[] =>
  (anchors ?? []).map((a) => ({
    id: a.id, type: a.type, targetNodeId: a.targetNodeId, x: a.x, y: a.y,
    instruction: a.instruction, createdAt: a.createdAt,
    ...(a.width != null ? { width: a.width } : {}),
    ...(a.height != null ? { height: a.height } : {}),
    ...(a.resultNodeIds ? { resultNodeIds: [...a.resultNodeIds] } : {}),
    revision,
  }))
export const anchorsFromRecords = (records: AnchorRecord[]): MivoCanvasNode['experimentalAnchors'] =>
  records.length ? records.map((r) => ({
    id: r.id, type: r.type, targetNodeId: r.targetNodeId, x: r.x, y: r.y,
    instruction: r.instruction, createdAt: r.createdAt,
    ...(r.width != null ? { width: r.width } : {}),
    ...(r.height != null ? { height: r.height } : {}),
    ...(r.resultNodeIds ? { resultNodeIds: [...r.resultNodeIds] } : {}),
  })) : undefined
