import type {
  AiWorkflowKind,
  AiWorkflowOperation,
  AiWorkflowPlacement,
  AiWorkflowStatus,
  CanvasTask,
  MivoCanvasNode,
  MivoCanvasSnapshot,
  NodeStatus,
} from '../types/mivoCanvas'
import { normalizeCanvasSnapshotV2 } from '../model/canvasSnapshotModel'
import type { SerializedCanvasAsset } from './assetStorage'

const nodeStatuses = new Set<NodeStatus>(['ready', 'generating', 'failed', 'queued'])
const taskStatuses = new Set<CanvasTask['status']>(['running', 'queued', 'failed', 'done'])
const aiWorkflowKinds = new Set<AiWorkflowKind>(['slot', 'annotation', 'result'])
const aiWorkflowStatuses = new Set<AiWorkflowStatus>(['empty', 'queued', 'generating', 'ready', 'failed'])
const aiWorkflowOperations = new Set<AiWorkflowOperation>([
  'slot-generation',
  'beside-generation',
  'annotation-edit',
  'variation',
  'prompt-edit',
  'area-edit',
  'remove-background',
  'outpaint',
  'upscale',
])
const aiWorkflowPlacements = new Set<AiWorkflowPlacement>(['slot', 'right', 'left', 'below'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isTextAlign = (value: unknown) => value === undefined || value === 'left' || value === 'center' || value === 'right'
const isSectionBorderStyle = (value: unknown) => value === undefined || value === 'solid' || value === 'dashed'
const isSectionLockMode = (value: unknown) => value === undefined || value === 'all' || value === 'background'
const isMarkdownDisplayMode = (value: unknown) => value === undefined || value === 'full' || value === 'preview'
const isMarkupKind = (value: unknown) =>
  value === undefined ||
  value === 'arrow' ||
  value === 'line' ||
  value === 'rect' ||
  value === 'ellipse' ||
  value === 'brush' ||
  value === 'note' ||
  value === 'stamp'
const isMarkupStrokeStyle = (value: unknown) => value === undefined || value === 'solid' || value === 'dashed'
const isMarkupPointArray = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every(
      (point) =>
        isRecord(point) &&
        typeof point.x === 'number' &&
        typeof point.y === 'number' &&
        (point.pressure === undefined || typeof point.pressure === 'number'),
    ))

const isImageCrop = (value: unknown) => {
  if (value === undefined) return true
  if (!isRecord(value)) return false

  return (
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width > 0 &&
    value.height > 0 &&
    value.x + value.width <= 1.0001 &&
    value.y + value.height <= 1.0001
  )
}

const isAiWorkflow = (value: unknown) => {
  if (value === undefined) return true
  if (!isRecord(value)) return false

  return (
    aiWorkflowKinds.has(value.kind as AiWorkflowKind) &&
    (value.status === undefined || aiWorkflowStatuses.has(value.status as AiWorkflowStatus)) &&
    (value.operation === undefined || aiWorkflowOperations.has(value.operation as AiWorkflowOperation)) &&
    (value.prompt === undefined || typeof value.prompt === 'string') &&
    (value.sourceNodeIds === undefined || isStringArray(value.sourceNodeIds)) &&
    (value.anchorNodeId === undefined || typeof value.anchorNodeId === 'string') &&
    (value.annotationNodeId === undefined || typeof value.annotationNodeId === 'string') &&
    (value.slotId === undefined || typeof value.slotId === 'string') &&
    (value.placement === undefined || aiWorkflowPlacements.has(value.placement as AiWorkflowPlacement)) &&
    (value.createdAt === undefined || typeof value.createdAt === 'number')
  )
}

const isCanvasNode = (value: unknown): value is MivoCanvasNode => {
  if (!isRecord(value)) return false
  const nodeTypeValid =
    value.type === 'image' ||
    value.type === 'task-placeholder' ||
    value.type === 'text' ||
    value.type === 'frame' ||
    value.type === 'ai-slot' ||
    value.type === 'annotation' ||
    value.type === 'markup' ||
    value.type === 'markdown' ||
    value.type === 'pdf' ||
    value.type === 'video'
  const textFieldsValid =
    (value.type !== 'text' && value.type !== 'annotation' && value.type !== 'markup' && value.type !== 'markdown') ||
    ((value.text === undefined || typeof value.text === 'string') &&
      (value.fontSize === undefined || typeof value.fontSize === 'number') &&
      (value.textColor === undefined || typeof value.textColor === 'string') &&
      (value.fontWeight === undefined || typeof value.fontWeight === 'number') &&
      isTextAlign(value.textAlign) &&
      (value.textAutoWidth === undefined || typeof value.textAutoWidth === 'boolean'))
  const markupFieldsValid =
    value.type !== 'markup' ||
    (isMarkupKind(value.markupKind) &&
      (value.markupBrushKind === undefined ||
        value.markupBrushKind === 'marker' ||
        value.markupBrushKind === 'highlighter') &&
      (value.markupStampKind === undefined || typeof value.markupStampKind === 'string') &&
      isMarkupPointArray(value.markupPoints) &&
      (value.markupStrokeColor === undefined || typeof value.markupStrokeColor === 'string') &&
      (value.markupFillColor === undefined || typeof value.markupFillColor === 'string') &&
      (value.markupStrokeWidth === undefined || typeof value.markupStrokeWidth === 'number') &&
      isMarkupStrokeStyle(value.markupStrokeStyle) &&
      (value.markupOpacity === undefined || typeof value.markupOpacity === 'number') &&
      (value.markupStartArrow === undefined || typeof value.markupStartArrow === 'boolean') &&
      (value.markupEndArrow === undefined || typeof value.markupEndArrow === 'boolean') &&
      (value.markupCornerRadius === undefined || typeof value.markupCornerRadius === 'number'))

  return (
    typeof value.id === 'string' &&
    nodeTypeValid &&
    typeof value.title === 'string' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    nodeStatuses.has(value.status as NodeStatus) &&
    textFieldsValid &&
    markupFieldsValid &&
    (value.frameColor === undefined || typeof value.frameColor === 'string') &&
    (value.sectionId === undefined || typeof value.sectionId === 'string') &&
    (value.sectionFillColor === undefined || typeof value.sectionFillColor === 'string') &&
    (value.sectionBorderColor === undefined || typeof value.sectionBorderColor === 'string') &&
    (value.sectionBorderWidth === undefined || typeof value.sectionBorderWidth === 'number') &&
    isSectionBorderStyle(value.sectionBorderStyle) &&
    (value.sectionTitleVisible === undefined || typeof value.sectionTitleVisible === 'boolean') &&
    isSectionLockMode(value.sectionLockMode) &&
    (value.sectionTemplateId === undefined || typeof value.sectionTemplateId === 'string') &&
    (value.assetUrl === undefined || typeof value.assetUrl === 'string') &&
    (value.assetMimeType === undefined || typeof value.assetMimeType === 'string') &&
    (value.assetOriginalName === undefined || typeof value.assetOriginalName === 'string') &&
    (value.assetSizeBytes === undefined || typeof value.assetSizeBytes === 'number') &&
    isMarkdownDisplayMode(value.markdownDisplayMode) &&
    (value.imageHasTransparency === undefined || typeof value.imageHasTransparency === 'boolean') &&
    isImageCrop(value.imageCrop) &&
    (value.parentIds === undefined || isStringArray(value.parentIds)) &&
    (value.groupId === undefined || typeof value.groupId === 'string') &&
    (value.locked === undefined || typeof value.locked === 'boolean') &&
    (value.hidden === undefined || typeof value.hidden === 'boolean') &&
    isAiWorkflow(value.aiWorkflow)
  )
}

const isCanvasTask = (value: unknown): value is CanvasTask => {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    taskStatuses.has(value.status as CanvasTask['status']) &&
    typeof value.progress === 'number' &&
    value.progress >= 0 &&
    value.progress <= 100 &&
    isStringArray(value.nodeIds)
  )
}

const isSerializedCanvasAsset = (value: unknown): value is SerializedCanvasAsset => {
  if (!isRecord(value)) return false

  return (
    typeof value.assetUrl === 'string' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.dataUrl === 'string' &&
    value.dataUrl.startsWith('data:') &&
    (value.createdAt === undefined || typeof value.createdAt === 'number')
  )
}

const validateSnapshot = (parsed: unknown) => {
  if (!isRecord(parsed)) {
    return { ok: false as const, message: '快照内容必须是对象。' }
  }

  if (parsed.version !== 2) {
    return { ok: false as const, message: '暂不支持这个快照版本。' }
  }

  if (typeof parsed.sceneId !== 'string' || !parsed.sceneId.trim()) {
    return { ok: false as const, message: '快照里的场景 ID 无效。' }
  }

  if (!Array.isArray(parsed.nodes) || !parsed.nodes.every(isCanvasNode)) {
    return { ok: false as const, message: '快照里的画布节点无效。' }
  }

  if (!Array.isArray(parsed.tasks) || !parsed.tasks.every(isCanvasTask)) {
    return { ok: false as const, message: '快照里的任务列表无效。' }
  }

  if (parsed.selectedNodeId !== undefined && typeof parsed.selectedNodeId !== 'string') {
    return { ok: false as const, message: '快照里的选中节点无效。' }
  }

  if (parsed.selectedNodeIds !== undefined && !isStringArray(parsed.selectedNodeIds)) {
    return { ok: false as const, message: '快照里的多选节点无效。' }
  }

  return {
    ok: true as const,
    snapshot: normalizeCanvasSnapshotV2(parsed as MivoCanvasSnapshot),
  }
}

export type ParsedCanvasImport = {
  snapshot: MivoCanvasSnapshot
  assets: SerializedCanvasAsset[]
}

export const parseCanvasSnapshot = (text: string) => {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false as const, message: 'JSON 文件格式无效。' }
  }

  if (isRecord(parsed) && parsed.kind === 'mivo-canvas-archive') {
    if (parsed.version !== 2) {
      return { ok: false as const, message: '暂不支持这个 Mivo 归档版本。' }
    }

    const snapshotResult = validateSnapshot(parsed.snapshot)
    if (!snapshotResult.ok) return snapshotResult

    if (!Array.isArray(parsed.assets) || !parsed.assets.every(isSerializedCanvasAsset)) {
      return { ok: false as const, message: '归档里的素材数据无效。' }
    }

    return {
      ok: true as const,
      snapshot: snapshotResult.snapshot,
      assets: parsed.assets,
    } satisfies { ok: true; snapshot: MivoCanvasSnapshot; assets: SerializedCanvasAsset[] }
  }

  const snapshotResult = validateSnapshot(parsed)
  if (!snapshotResult.ok) return snapshotResult

  return {
    ok: true as const,
    snapshot: snapshotResult.snapshot,
    assets: [],
  } satisfies { ok: true; snapshot: MivoCanvasSnapshot; assets: SerializedCanvasAsset[] }
}
