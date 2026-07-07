// CanvasState 类型外提(结构守卫 facade 零增长)。
//
// canvasStore.ts 的 CanvasState 主类型及其同文件依赖的类型别名原本内联在
// facade 里,导致每接入一个新 slice(至少 +1 import +1 spread +若干方法签名)
// 都让 facade 行数增长,触发 structure-guard 的 allowlist「零增长」FAIL。
// 把纯类型声明整体外提到本文件,facade 只保留运行时代码 + re-export,
// 下游 `import type { CanvasState, SliceCreator, ... } from './canvasStore'`
// 路径零改动(re-export 在 canvasStore.ts 内)。
//
// 本文件不含任何运行时代码。

import type { StoreApi } from 'zustand'
import type {
  AiCanvasContextSnapshot,
  AiWorkflowOperation,
  CanvasAssetNodeType,
  CanvasEdge,
  CanvasId,
  CanvasDocument,
  CanvasProject,
  CanvasTask,
  BrushToolMode,
  CanvasStampKind,
  ConnectorBinding,
  DemoSceneId,
  MarkupBrushKind,
  MarkupKind,
  MarkupPoint,
  MarkdownDisplayMode,
  MivoCanvasNode,
  MivoCanvasSnapshot,
  SectionLockMode,
  ToolId,
} from '../types/mivoCanvas'
import type { ImportedFileMetadata } from '../lib/canvasAssetImport'
import type { ImportedImageMetadata } from '../lib/imageSizing'
import type { AnchorInput } from '../model/anchorModel'
import type { CanvasAssetClipboardItem } from '../app/assetLibraryModel'
import type {
  CommitGenerationResultPayload,
  GenerationRatio,
  MivoImageQuality,
  VariationParam,
} from '../types/generation'

type LayerMove = 'forward' | 'backward' | 'front' | 'back'
export type SelectionAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributionAxis = 'horizontal' | 'vertical'
export type CanvasGenerationOptions = {
  sceneId?: CanvasId
  createDerivationEdge?: boolean
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  model?: string
  referenceFiles?: File[]
  signal?: AbortSignal
}
export type SelectionArrangeMode = 'row' | 'column' | 'grid' | 'tidy'
export type BrushStyle = {
  color: string
  width: number
  kind: BrushToolMode
}

export type CanvasState = {
  canvases: Record<CanvasId, CanvasDocument>
  projects: CanvasProject[]
  nodes: MivoCanvasNode[]
  edges: CanvasEdge[]
  tasks: CanvasTask[]
  activeTool: ToolId
  selectedNodeId?: string
  selectedNodeIds: string[]
  sceneId: CanvasId
  clipboardNodes: MivoCanvasNode[]
  clipboardAssets: CanvasAssetClipboardItem[]
  brushStyle: BrushStyle
  activeStampKind: CanvasStampKind
  // Transient: id of the most recently placed stamp; drives the drop animation. Not persisted.
  lastPlacedStampId: string | undefined
  historyPast: MivoCanvasSnapshot[]
  historyFuture: MivoCanvasSnapshot[]
  createProject: (name?: string) => string
  renameProject: (projectId: string, name: string) => void
  deleteProject: (projectId: string) => void
  moveCanvasToProject: (canvasId: CanvasId, projectId?: string) => void
  createCanvas: (title?: string, options?: { projectId?: string; templateId?: DemoSceneId }) => CanvasId
  duplicateCanvas: (canvasId?: CanvasId) => CanvasId | undefined
  deleteCanvas: (canvasId?: CanvasId) => void
  loadScene: (sceneId: CanvasId) => void
  renameCanvas: (sceneId: CanvasId, title: string) => void
  selectNode: (nodeId?: string, options?: { additive?: boolean }) => void
  selectNodes: (nodeIds: string[], primaryNodeId?: string) => void
  setActiveTool: (toolId: ToolId) => void
  setBrushStyle: (style: Partial<BrushStyle>) => void
  setActiveStampKind: (kind: CanvasStampKind) => void
  noteStampPlaced: (id: string) => void
  eraseMarkupStrokes: (nodeIds: string[]) => void
  captureHistory: () => void
  undo: () => void
  redo: () => void
  updateNodePosition: (nodeId: string, x: number, y: number) => void
  updateSelectedNodesPosition: (anchorNodeId: string, x: number, y: number) => void
  updateNodeGeometry: (nodeId: string, x: number, y: number, width: number, height: number) => void
  updateNodesGeometry: (
    updates: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  ) => void
  updateNodeMeasuredSize: (nodeId: string, width: number, height: number) => void
  setMarkdownDisplayMode: (nodeId: string, mode: MarkdownDisplayMode) => void
  moveSelectedNodesBy: (dx: number, dy: number) => void
  duplicateNode: (nodeId: string) => void
  duplicateSelectedNodes: () => void
  groupSelectedNodes: () => void
  ungroupSelectedNodes: () => void
  moveNodeLayer: (nodeId: string, move: LayerMove) => void
  moveSelectedLayer: (move: LayerMove) => void
  deleteNode: (nodeId: string) => void
  deleteSelectedNodes: () => void
  toggleSelectedNodesLocked: () => void
  hideSelectedNodes: () => void
  showAllHiddenNodes: () => void
  alignSelectedNodes: (alignment: SelectionAlignment) => void
  distributeSelectedNodes: (axis: DistributionAxis) => void
  arrangeSelectedNodes: (mode: SelectionArrangeMode) => void
  copySelectedNodes: () => void
  cutSelectedNodes: () => void
  pasteClipboardNodes: (position?: { x: number; y: number }) => void
  copyAssetsToClipboard: (assets: CanvasAssetClipboardItem[]) => void
  pasteClipboardAssets: (position?: { x: number; y: number }) => void
  addImportedImage: (
    assetUrl: string,
    title?: string,
    size?: string,
    position?: { x: number; y: number },
    metadata?: ImportedImageMetadata,
  ) => void
  addImportedFileNode: (
    type: CanvasAssetNodeType,
    assetUrl: string,
    title?: string,
    size?: string,
    position?: { x: number; y: number },
    metadata?: ImportedFileMetadata,
  ) => void
  cropImageNode: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void
  addFrameNode: (
    position: { x: number; y: number },
    size?: { width: number; height: number },
    title?: string,
  ) => string
  addAiSlotNode: (
    position: { x: number; y: number },
    size?: { width: number; height: number },
    prompt?: string,
    options?: { sceneId?: CanvasId },
  ) => string
  addAnnotationNode: (
    sourceNodeId?: string,
    position?: { x: number; y: number },
    instruction?: string,
    options?: { operation?: AiWorkflowOperation; title?: string },
  ) => string | undefined
  addMarkupNode: (
    kind: MarkupKind,
    position: { x: number; y: number },
    geometry?: { width: number; height: number },
    options?: {
      points?: MarkupPoint[]
      text?: string
      strokeColor?: string
      fillColor?: string
      strokeWidth?: number
      strokeStyle?: MivoCanvasNode['markupStrokeStyle']
      brushKind?: MarkupBrushKind
      stampKind?: CanvasStampKind
      startArrow?: boolean
      endArrow?: boolean
      connectorStart?: ConnectorBinding
      connectorEnd?: ConnectorBinding
      select?: boolean
    },
  ) => string
  updateMarkupGeometry: (
    nodeId: string,
    geometry: { x: number; y: number; width: number; height: number },
    points?: MarkupPoint[],
    bindings?: {
      connectorStart?: ConnectorBinding | null
      connectorEnd?: ConnectorBinding | null
    },
  ) => void
  updateMarkupStyle: (
    nodeId: string,
    style: Pick<
      Partial<MivoCanvasNode>,
      | 'markupStrokeColor'
      | 'markupFillColor'
      | 'markupStrokeWidth'
      | 'markupStrokeStyle'
      | 'markupOpacity'
      | 'markupStartArrow'
      | 'markupEndArrow'
      | 'markupCornerRadius'
    >,
  ) => void
  updateSectionStyle: (
    nodeId: string,
    style: Pick<
      Partial<MivoCanvasNode>,
      'sectionFillColor' | 'sectionBorderColor' | 'sectionBorderWidth' | 'sectionBorderStyle' | 'sectionTitleVisible'
    >,
  ) => void
  setSectionLockMode: (nodeId: string, mode?: SectionLockMode) => void
  removeSectionOnly: (nodeId: string) => void
  renameNode: (nodeId: string, title: string) => void
  addTextNode: (position: { x: number; y: number }, text?: string) => string
  updateTextNode: (
    nodeId: string,
    text: string,
    geometry?: { width: number; height: number },
  ) => void
  updateTextStyle: (
    nodeId: string,
    style: Pick<Partial<MivoCanvasNode>, 'fontSize' | 'textColor' | 'fontWeight' | 'textAlign'>,
    geometry?: { width: number; height: number },
  ) => void
  resizeTextNode: (nodeId: string, x: number, width: number, height: number) => void
  generateVariations: (sourceNodeId?: string, variations?: VariationParam[], options?: CanvasGenerationOptions) => Promise<string[]>
  generateImageEdit: (
    sourceNodeId: string | undefined,
    operation: AiWorkflowOperation,
    prompt: string,
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateBesideNode: (
    sourceNodeId?: string,
    prompt?: string,
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateIntoAiSlot: (
    slotId?: string,
    prompt?: string,
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateFromAnnotation: (annotationNodeId?: string, options?: CanvasGenerationOptions) => Promise<string[]>
  commitGenerationResult: (payload: CommitGenerationResultPayload) => Promise<string[]>
  toggleFavorite: (nodeId: string) => void
  updatePrompt: (nodeId: string, prompt: string) => void
  // P2-D1 EXPERIMENTAL — Anchor MVP actions (roadmap §7 组 D). Migration rule
  // (§9 P4-a):收编为 formal CanvasAnchor, or remove the field + these actions.
  addAnchor: (nodeId: string, input: AnchorInput) => string | undefined
  updateAnchorInstruction: (nodeId: string, anchorId: string, instruction: string) => void
  removeAnchor: (nodeId: string, anchorId: string) => void
  recordAnchorResult: (nodeId: string, anchorId: string, resultNodeIds: string[]) => void
  resetCurrentScene: () => void
  replaceSnapshot: (snapshot: MivoCanvasSnapshot) => void
  getSnapshot: () => MivoCanvasSnapshot
  getAiContextSnapshot: () => AiCanvasContextSnapshot
}

/** Slice creator signature: receives the store's set/get, returns its slice of state + actions. */
export type SliceCreator = (
  set: StoreApi<CanvasState>['setState'],
  get: StoreApi<CanvasState>['getState'],
) => Partial<CanvasState>
