import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { StoreApi } from 'zustand'
import type {
  AiCanvasContextSnapshot,
  AiWorkflowOperation,
  CanvasAssetNodeType,
  CanvasEdge,
  CanvasId,
  CanvasDocument,
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
import { type ImportedFileMetadata } from '../lib/canvasAssetImport'
import { importedImageDisplaySize, type ImportedImageMetadata } from '../lib/imageSizing'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { type AnchorInput } from '../model/anchorModel'
import { debugLogger } from './debugLogStore'
import { scenes } from './demoScenes'
import type { CanvasAssetClipboardItem } from '../app/assetLibraryModel'
import type {
  CommitGenerationResultPayload,
  CommittedGenerationImage,
  GenerationRatio,
  MivoImageQuality, VariationParam,
} from '../types/generation'
import { compactCanvasesForPersist } from './canvasDocumentModel'
import { createDocumentSlice } from './documentSlice'
import { createNodeMutationSlice } from './nodeMutationSlice'
import { createNodeCreationSlice } from './nodeCreationSlice'
import { createGenerationSlice } from './generationSlice'
import { createSelectionSlice } from './selectionSlice'
import { mergeCanvasPersistedState, migratePersistedState } from './canvasGenerationHydration'

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

export { scenes }
export const blobFromCommittedGenerationImage = (image: CommittedGenerationImage) => {
  if (image.blob) return image.blob

  const raw = image.b64?.trim() || ''
  if (!raw) throw new Error('Image service returned empty image data')

  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.*)$/)
  const mimeType = image.mimeType || dataUrlMatch?.[1] || 'image/png'
  const base64 = (dataUrlMatch?.[2] || raw).trim()
  if (!base64) throw new Error('Image service returned empty image data')

  let binary: string
  try {
    binary = atob(base64)
  } catch (error) {
    throw new Error('Image service returned invalid image data', { cause: error })
  }
  if (!binary.length) throw new Error('Image service returned empty image data')

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: mimeType })
}

export type GeneratedAssetRecord = Awaited<ReturnType<typeof saveGeneratedAsset>>

export const displaySizeForGeneratedAsset = (
  asset: GeneratedAssetRecord,
  fallbackSize: { width: number; height: number },
) => asset.sourceDimensions ? importedImageDisplaySize(asset.sourceDimensions) : fallbackSize



// migratePersistedState lives in canvasGenerationHydration.ts (co-located with
// settleExpiredCanvasGenerations / mergeCanvasPersistedState — all version-gated
// hydration logic). Re-exported here so canvasStoreMigrate.test.ts and the
// persist `migrate` option can keep importing it from the store facade.
export { migratePersistedState }

export const logCanvas = (message: string) => debugLogger.log('Canvas Store', message)
export const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)
export const errorCanvas = (message: string) => debugLogger.error('Canvas Store', message)

/** Slice creator signature: receives the store's set/get, returns its slice of state + actions. */
export type SliceCreator = (
  set: StoreApi<CanvasState>['setState'],
  get: StoreApi<CanvasState>['getState'],
) => Partial<CanvasState>

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      ...createDocumentSlice(set, get),
      ...createNodeMutationSlice(set, get),
      ...createNodeCreationSlice(set, get),
      ...createGenerationSlice(set, get),
      ...createSelectionSlice(set, get),
    }) as CanvasState,
    {
      name: 'mivo-canvas-demo',
      version: 9,
      migrate: migratePersistedState,
      merge: (persistedState, currentState) =>
        mergeCanvasPersistedState(persistedState, currentState, migratePersistedState, warnCanvas),
      partialize: (state) => ({
        canvases: compactCanvasesForPersist(state.canvases),
        sceneId: state.sceneId,
        selectedNodeId: state.selectedNodeId,
        selectedNodeIds: state.selectedNodeIds,
        activeTool: state.activeTool,
        brushStyle: state.brushStyle,
        activeStampKind: state.activeStampKind,
      }),
    },
  ),
)
