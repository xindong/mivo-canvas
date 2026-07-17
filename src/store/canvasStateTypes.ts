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
/**
 * T2.2 Block 1 F1:scene-scoped sync 回调类型。caller(无环层)注入 wrapMutationForScene 的适配,
 * generationSlice 调用它把 catch 内 slot 删除包进 before/after diff → server 模式发 delete-node。
 */
export type SceneScopedMutate = (targetSceneId: string, mutate: () => void) => void

export type CanvasGenerationOptions = {
  sceneId?: CanvasId
  createDerivationEdge?: boolean
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  model?: string
  referenceFiles?: File[]
  signal?: AbortSignal
  /**
   * T2.2 Block 1 F1:scene-scoped sync 注入点。generateIntoAiSlot catch 删 slot 经此回调 → server 模式
   * delete-node;未注入/local → pass-through 仍删(行为不退)。为何注入而非静态 import:generationSlice 由
   * canvasStore 组合,静态 import canvasSyncRuntime(canvas/actions)成 store→canvas→store 环;改由
   * generationFacade(无环)注入回调,generationSlice 只调回调不引环。运行期 options(同 referenceFiles/signal
   * 非序列化),不进序列化 command options。
   */
  onSceneMutation?: SceneScopedMutate
}
export type SelectionArrangeMode = 'row' | 'column' | 'grid' | 'tidy'
export type BrushStyle = {
  color: string
  width: number
  kind: BrushToolMode
}

// deleteProject 返回值:让 UI 层按结果分支 toast(避免删除被零-survivor 不变量阻止时仍弹
// "已删除"成功提示)。blocked 仅在 server 模式零 survivor 时出现(local 模式画板回落
// standalone,永不阻止);skipped 在 project 不存在时出现(UI 不可能触达,debugLog 已 warn,
// 静默不 toast 免噪声)。用 `status` 判别键(三态共用),UI 用 `result.status === 'blocked''
// narrow,避免 boolean 键在联合上无法直接访问的 narrowing 坑。
export type ProjectDeleteResult =
  | { status: 'deleted' }
  | { status: 'blocked'; reason: 'no-survivor' }
  | { status: 'skipped'; reason: 'missing' }

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
  deleteProject: (projectId: string) => ProjectDeleteResult
  restoreProject: (projectId: string, name?: string) => void
  // Phase 2 归档(回收站):archive/unarchive project + canvas。CR-5 archiveProject 级联归档子画布,
  //   unarchiveProject 仅恢复 archivedByCascade===true 的子画布(单独归档的不动);CR-10 unarchiveCanvas
  //   自动 unarchive 父项目(编辑先恢复同构);CR-11 archive/unarchive 不入 undo 栈(非画布内容 mutation)。
  archiveProject: (projectId: string) => void
  unarchiveProject: (projectId: string) => void
  moveCanvasToProject: (canvasId: CanvasId, projectId?: string) => void
  createCanvas: (title?: string, options?: { projectId?: string; templateId?: DemoSceneId }) => CanvasId
  duplicateCanvas: (canvasId?: CanvasId) => CanvasId | undefined
  deleteCanvas: (canvasId?: CanvasId) => void
  archiveCanvas: (canvasId?: CanvasId) => void
  unarchiveCanvas: (canvasId?: CanvasId) => void
  loadScene: (sceneId: CanvasId) => void
  refreshActiveCanvasContent: (sceneId: CanvasId) => void
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
