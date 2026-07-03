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
import { defaultStampKind } from '../canvas/stampDefs'
import { type ImportedFileMetadata } from '../lib/canvasAssetImport'
import { importedImageDisplaySize, type ImportedImageMetadata } from '../lib/imageSizing'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { MivoImageRequestError, assetBlobForNode, editMivoImage, generateMivoImage } from '../lib/mivoImageClient'
import { createAiResultNode } from '../model/aiCanvasCommands'
import { setNodeTransform } from '../model/documentModelV2'
import { chooseAdjacentPlacement } from './aiCanvasWorkflow'
import { debugLogger } from './debugLogStore'
import { makeNode, realCaseImages, scenes } from './demoScenes'
import {
  cloneNode,
  cloneNodes,
  createEdgeId,
  createGroupId,
  createNodeId,
  createNodeCopy,
  edgeTypeForOperation,
} from './nodeFactory'
import { mockGenerationAdapter } from './mockGeneration'
import type { CanvasAssetClipboardItem } from '../app/assetLibraryModel'
import type {
  CommitGenerationResultPayload,
  CommittedGenerationImage,
  GenerationRatio,
  MivoImageQuality,
} from '../types/generation'
import {
  arrangedPositionsFor,
  arrangedSubjectNodesFrom,
  compactCanvasesForPersist,
  defaultBrushStyle,
  defaultDocument,
  documentFor,
  initialCanvases,
  isEffectivelyLocked,
  isSectionNode,
  nodePrompt,
  normalizeCanvasNodes,
  normalizeDocument,
  normalizeLongMarkdownPreviewNodes,
  normalizeSelection,
  patchActiveCanvas,
  patchCanvasDocument,
  patchWithHistory,
  selectedIdsFromState,
  selectedNodesFromState,
  selectionFrom,
  clipboardAssetDisplaySize,
  clipboardAssetTitle,
} from './canvasDocumentModel'
import { createDocumentSlice } from './documentSlice'

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
  generateVariations: (sourceNodeId?: string) => void
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
  generateFromAnnotation: (annotationNodeId?: string) => void
  commitGenerationResult: (payload: CommitGenerationResultPayload) => Promise<string[]>
  toggleFavorite: (nodeId: string) => void
  updatePrompt: (nodeId: string, prompt: string) => void
  resetCurrentScene: () => void
  replaceSnapshot: (snapshot: MivoCanvasSnapshot) => void
  getSnapshot: () => MivoCanvasSnapshot
  getAiContextSnapshot: () => AiCanvasContextSnapshot
}

type PersistedCanvasState = Partial<
  Pick<
    CanvasState,
    | 'canvases'
    | 'nodes'
    | 'edges'
    | 'tasks'
    | 'sceneId'
    | 'selectedNodeId'
    | 'selectedNodeIds'
    | 'activeTool'
    | 'brushStyle'
    | 'activeStampKind'
  >
>

export { scenes }

const mockResultAssetUrl = (nodes: MivoCanvasNode[]) => realCaseImages[nodes.length % realCaseImages.length]
const defaultMivoImageModel = 'gpt-image-2'


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

const upsertTask = (tasks: CanvasTask[], task: CanvasTask) => [
  task,
  ...tasks.filter((item) => item.id !== task.id),
].slice(0, 5)

const failedTask = (task: CanvasTask, label: string): CanvasTask => ({
  ...task,
  label,
  status: 'failed',
  progress: 100,
})

const canceledTask = (task: CanvasTask, label: string): CanvasTask => ({
  ...task,
  label,
  status: 'canceled',
  progress: 100,
})

const doneTask = (task: CanvasTask, label: string, nodeIds: string[]): CanvasTask => ({
  ...task,
  label,
  status: 'done',
  progress: 100,
  nodeIds,
})

const isCanceledGenerationError = (error: unknown, signal?: AbortSignal) =>
  Boolean(signal?.aborted) ||
  (error instanceof MivoImageRequestError && error.kind === 'canceled') ||
  (error instanceof Error && error.message.includes('已取消'))


// Persisted-state migration is exported so canvasStoreMigrate.test.ts can cover the
// v8 migration branches (flat-state compat, <6 markdown normalization, <8 brushStyle reset).
export const migratePersistedState = (persistedState: unknown, persistedVersion = 0) => {
  const persisted = (persistedState || {}) as PersistedCanvasState
  const shouldNormalizeLongMarkdown = persistedVersion < 6
  const canvases = {
    ...initialCanvases(),
    ...(persisted.canvases || {}),
  }

  Object.entries(canvases).forEach(([id, document]) => {
    const normalizedDocument = normalizeDocument(document)
    canvases[id] = shouldNormalizeLongMarkdown
      ? {
          ...normalizedDocument,
          nodes: normalizeLongMarkdownPreviewNodes(normalizedDocument.nodes),
        }
      : normalizedDocument
  })
  const sceneId =
    persisted.sceneId && canvases[persisted.sceneId]
      ? persisted.sceneId
      : 'character-flow'

  if (persisted.nodes && persisted.tasks) {
    const currentDocument = documentFor(canvases, sceneId)
    const normalizedDocument = normalizeDocument({
      ...currentDocument,
      nodes: persisted.nodes,
      edges: persisted.edges || currentDocument.edges || [],
      tasks: persisted.tasks,
      selectedNodeId: persisted.selectedNodeId,
      selectedNodeIds: persisted.selectedNodeIds,
    })
    canvases[sceneId] = shouldNormalizeLongMarkdown
      ? {
          ...normalizedDocument,
          nodes: normalizeLongMarkdownPreviewNodes(normalizedDocument.nodes),
        }
      : normalizedDocument
  }

  const activeDocument = documentFor(canvases, sceneId)
  const selection = selectionFrom(activeDocument.selectedNodeIds, activeDocument.selectedNodeId, activeDocument.nodes)

  return {
    ...persisted,
    canvases,
    sceneId,
    nodes: activeDocument.nodes,
    edges: activeDocument.edges || [],
    tasks: activeDocument.tasks,
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    activeTool: persisted.activeTool || 'select',
    clipboardNodes: [],
    clipboardAssets: [],
    // Version 8 introduced the black default and eraser mode; older persisted styles reset to the new default.
    brushStyle: persistedVersion < 8 ? defaultBrushStyle : persisted.brushStyle || defaultBrushStyle,
    activeStampKind: persisted.activeStampKind || defaultStampKind,
    historyPast: [],
    historyFuture: [],
  }
}

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
      tasks: defaultDocument.tasks,
      selectedNodeId: defaultDocument.selectedNodeId,
      selectedNodeIds: defaultDocument.selectedNodeIds || [],
      activeTool: 'select',
      clipboardNodes: [],
      clipboardAssets: [],
      brushStyle: defaultBrushStyle,
      activeStampKind: defaultStampKind,
      selectNode: (nodeId, options) =>
        set((state) => {
          if (!nodeId) {
            logCanvas('Selection cleared')
            return patchActiveCanvas(state, { selectedNodeId: undefined, selectedNodeIds: [] })
          }

          const target = state.nodes.find((node) => node.id === nodeId && !node.hidden)
          if (!target) {
            warnCanvas(`Selection skipped: node ${nodeId} is missing or hidden`)
            return {}
          }

          const targetNodeIds = target.groupId
            ? state.nodes
                .filter((node) => !node.hidden && node.groupId === target.groupId)
                .map((node) => node.id)
            : [nodeId]

          if (options?.additive) {
            const targetSet = new Set(targetNodeIds)
            const targetAlreadySelected = targetNodeIds.every((id) => state.selectedNodeIds.includes(id))
            const selectedNodeIds = targetAlreadySelected
              ? state.selectedNodeIds.filter((id) => !targetSet.has(id))
              : [...state.selectedNodeIds, ...targetNodeIds]
            const normalizedSelection = normalizeSelection(selectedNodeIds, state.nodes)
            const selectedNodeId = normalizedSelection.includes(state.selectedNodeId || '')
              ? state.selectedNodeId
              : normalizedSelection.at(-1)

            logCanvas(`Selection toggled: ${normalizedSelection.length} selected`)
            return patchActiveCanvas(state, { selectedNodeId, selectedNodeIds: normalizedSelection })
          }

          logCanvas(`Selected ${targetNodeIds.length === 1 ? target.title : `${targetNodeIds.length} grouped nodes`}`)
          return patchActiveCanvas(state, { selectedNodeId: nodeId, selectedNodeIds: targetNodeIds })
        }),
      selectNodes: (nodeIds, primaryNodeId) =>
        set((state) => {
          const selectedNodeIds = normalizeSelection(nodeIds, state.nodes)
          const selectedNodeId =
            primaryNodeId && selectedNodeIds.includes(primaryNodeId) ? primaryNodeId : selectedNodeIds[0]
          logCanvas(`Selected ${selectedNodeIds.length} node${selectedNodeIds.length === 1 ? '' : 's'}`)

          return patchActiveCanvas(state, { selectedNodeId, selectedNodeIds })
        }),
      setActiveTool: (toolId) => {
        logCanvas(`Tool changed to ${toolId}`)
        set({ activeTool: toolId })
      },
      setBrushStyle: (style) =>
        set((state) => {
          const brushStyle = { ...state.brushStyle, ...style }
          logCanvas(`Brush style set: ${brushStyle.kind}, ${brushStyle.color}, ${brushStyle.width}px`)
          return { brushStyle }
        }),
      setActiveStampKind: (kind) => {
        logCanvas(`Stamp kind set to ${kind}`)
        set({ activeStampKind: kind })
      },
      eraseMarkupStrokes: (nodeIds) =>
        set((state) => {
          // History is captured once per eraser drag by the interaction controller,
          // so repeated calls during one drag stay a single undo step.
          const erasableSet = new Set(
            nodeIds.filter((nodeId) => {
              const node = state.nodes.find((item) => item.id === nodeId)
              return (
                node &&
                node.type === 'markup' &&
                node.markupKind === 'brush' &&
                !isEffectivelyLocked(state.nodes, node)
              )
            }),
          )
          if (!erasableSet.size) return {}

          logCanvas(`Erased ${erasableSet.size} brush stroke${erasableSet.size === 1 ? '' : 's'}`)

          return patchActiveCanvas(state, {
            selectedNodeId: erasableSet.has(state.selectedNodeId || '') ? undefined : state.selectedNodeId,
            selectedNodeIds: state.selectedNodeIds.filter((nodeId) => !erasableSet.has(nodeId)),
            nodes: normalizeCanvasNodes(state.nodes.filter((node) => !erasableSet.has(node.id))),
          })
        }),
      alignSelectedNodes: (alignment) =>
        set((state) => {
          const selectedNodes = selectedNodesFromState(state)
          if (selectedNodes.length < 2) return {}

          const minX = Math.min(...selectedNodes.map((node) => node.x))
          const maxX = Math.max(...selectedNodes.map((node) => node.x + node.width))
          const minY = Math.min(...selectedNodes.map((node) => node.y))
          const maxY = Math.max(...selectedNodes.map((node) => node.y + node.height))
          const centerX = minX + (maxX - minX) / 2
          const centerY = minY + (maxY - minY) / 2
          const selectedSet = new Set(selectedNodes.map((node) => node.id))
          const nodes = state.nodes.map((node) => {
            if (!selectedSet.has(node.id) || node.locked) return node

            if (alignment === 'left') return setNodeTransform(node, { x: Math.round(minX) })
            if (alignment === 'center') return setNodeTransform(node, { x: Math.round(centerX - node.width / 2) })
            if (alignment === 'right') return setNodeTransform(node, { x: Math.round(maxX - node.width) })
            if (alignment === 'top') return setNodeTransform(node, { y: Math.round(minY) })
            if (alignment === 'middle') return setNodeTransform(node, { y: Math.round(centerY - node.height / 2) })
            return setNodeTransform(node, { y: Math.round(maxY - node.height) })
          })

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
        }),
      distributeSelectedNodes: (axis) =>
        set((state) => {
          const selectedNodes = selectedNodesFromState(state)
          if (selectedNodes.length < 3) return {}

          const sorted = [...selectedNodes].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y))
          const start = axis === 'horizontal' ? sorted[0].x : sorted[0].y
          const end =
            axis === 'horizontal'
              ? sorted[sorted.length - 1].x + sorted[sorted.length - 1].width
              : sorted[sorted.length - 1].y + sorted[sorted.length - 1].height
          const totalSize = sorted.reduce((sum, node) => sum + (axis === 'horizontal' ? node.width : node.height), 0)
          const gap = (end - start - totalSize) / (sorted.length - 1)
          let cursor = start
          const positions = new Map<string, number>()

          sorted.forEach((node) => {
            positions.set(node.id, Math.round(cursor))
            cursor += (axis === 'horizontal' ? node.width : node.height) + gap
          })

          const nodes = state.nodes.map((node) => {
            const position = positions.get(node.id)
            if (position === undefined || node.locked) return node
            return axis === 'horizontal' ? setNodeTransform(node, { x: position }) : setNodeTransform(node, { y: position })
          })

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
        }),
      arrangeSelectedNodes: (mode) =>
        set((state) => {
          const selectedNodes = selectedNodesFromState(state)
          const subjectNodes = arrangedSubjectNodesFrom(state.nodes, selectedNodes)
          if (subjectNodes.length < 2) return {}

          const positions = arrangedPositionsFor(subjectNodes, mode)
          if (!positions.size) return {}

          const sectionDeltas = new Map<string, { dx: number; dy: number }>()

          subjectNodes.forEach((node) => {
            const position = positions.get(node.id)
            if (!position || !isSectionNode(node)) return

            sectionDeltas.set(node.id, {
              dx: Math.round(position.x - node.x),
              dy: Math.round(position.y - node.y),
            })
          })

          let changed = false
          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) => {
              const position = positions.get(node.id)
              if (position) {
                if (node.x !== position.x || node.y !== position.y) changed = true
                return setNodeTransform(node, {
                  x: position.x,
                  y: position.y,
                })
              }

              const sectionDelta = node.sectionId ? sectionDeltas.get(node.sectionId) : undefined
              if (!sectionDelta || isEffectivelyLocked(state.nodes, node)) return node
              if (!sectionDelta.dx && !sectionDelta.dy) return node

              changed = true
              return setNodeTransform(node, {
                x: Math.round(node.x + sectionDelta.dx),
                y: Math.round(node.y + sectionDelta.dy),
              })
            }),
          )

          if (!changed) return {}

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
        }),
      copySelectedNodes: () =>
        set((state) => {
          const selectedNodes = selectedNodesFromState(state)
          if (!selectedNodes.length) return {}

          return { clipboardNodes: cloneNodes(selectedNodes), clipboardAssets: [] }
        }),
      cutSelectedNodes: () =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (!selectedNodeIds.length) return {}

          const removedSet = new Set(
            selectedNodeIds.filter((nodeId) => {
              const node = state.nodes.find((item) => item.id === nodeId)
              return node && !isEffectivelyLocked(state.nodes, node)
            }),
          )
          state.nodes.forEach((node) => {
            if (removedSet.has(node.id) && isSectionNode(node)) {
              state.nodes
                .filter((child) => child.sectionId === node.id && !isEffectivelyLocked(state.nodes, child))
                .forEach((child) => removedSet.add(child.id))
            }
          })
          if (!removedSet.size) return {}

          logCanvas(`Cut ${removedSet.size} node${removedSet.size === 1 ? '' : 's'} to clipboard`)

          return {
            clipboardNodes: cloneNodes(state.nodes.filter((node) => removedSet.has(node.id))),
            ...patchWithHistory(state, {
              selectedNodeId: undefined,
              selectedNodeIds: [],
              nodes: normalizeCanvasNodes(state.nodes.filter((node) => !removedSet.has(node.id))),
            }),
          }
        }),
      pasteClipboardNodes: (position) =>
        set((state) => {
          if (!state.clipboardNodes.length) return {}

          const groupIdMap = new Map<string, string>()
          const clipboardIds = new Set(state.clipboardNodes.map((node) => node.id))
          const cloneIdMap = new Map<string, string>()
          const clones = state.clipboardNodes.map((node, index) => {
            const groupId = node.groupId
              ? groupIdMap.get(node.groupId) || (() => {
                  const nextGroupId = createGroupId()
                  groupIdMap.set(node.groupId || '', nextGroupId)
                  return nextGroupId
                })()
              : undefined

            const clone = createNodeCopy(node, index, 36, { groupId })
            cloneIdMap.set(node.id, clone.id)
            return clone
          })
          // Children cut together with their Section keep membership in the pasted Section,
          // mirroring how groupId is remapped above.
          const clonesWithSections = clones.map((clone, index) => {
            const sourceSectionId = state.clipboardNodes[index].sectionId
            return sourceSectionId && clipboardIds.has(sourceSectionId)
              ? { ...clone, sectionId: cloneIdMap.get(sourceSectionId) }
              : clone
          })
          const nextClones = position
            ? (() => {
                const minX = Math.min(...clonesWithSections.map((node) => node.x))
                const maxX = Math.max(...clonesWithSections.map((node) => node.x + node.width))
                const minY = Math.min(...clonesWithSections.map((node) => node.y))
                const maxY = Math.max(...clonesWithSections.map((node) => node.y + node.height))
                const dx = Math.round(position.x - (minX + (maxX - minX) / 2))
                const dy = Math.round(position.y - (minY + (maxY - minY) / 2))

                return clonesWithSections.map((node) => setNodeTransform(node, { x: node.x + dx, y: node.y + dy }))
              })()
            : clonesWithSections

          return {
            clipboardNodes: nextClones.map(cloneNode),
            ...patchWithHistory(state, {
              selectedNodeId: nextClones[0]?.id,
              selectedNodeIds: nextClones.map((node) => node.id),
              nodes: [...state.nodes, ...nextClones],
            }),
          }
        }),
      copyAssetsToClipboard: (assets) =>
        set(() => ({
          clipboardAssets: assets.map((asset) => ({ ...asset, tags: asset.tags ? [...asset.tags] : undefined })),
          clipboardNodes: [],
        })),
      pasteClipboardAssets: (position) =>
        set((state) => {
          if (!state.clipboardAssets.length) return {}

          const start = position || { x: -64 + state.nodes.length * 16, y: -64 + state.nodes.length * 16 }
          const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(state.clipboardAssets.length))))
          const gap = 32
          const displaySizes = state.clipboardAssets.map((asset) => clipboardAssetDisplaySize(asset))
          const cellWidth = Math.max(...displaySizes.map((size) => size.width)) + gap
          const cellHeight = Math.max(...displaySizes.map((size) => size.height)) + gap
          const createdAt = Date.now()
          const nodes = state.clipboardAssets.map((asset, index) => {
            const displaySize = displaySizes[index]
            const column = index % columns
            const row = Math.floor(index / columns)
            const id = createNodeId('asset')

            return makeNode({
              id,
              type: 'image',
              title: clipboardAssetTitle(asset),
              x: Math.round(start.x + column * cellWidth),
              y: Math.round(start.y + row * cellHeight),
              width: displaySize.width,
              height: displaySize.height,
              assetUrl: asset.url,
              assetOriginalName: asset.name,
              status: 'ready',
              generation: {
                prompt: 'Eagle 素材库复制粘贴导入，可作为后续 AI 上下文',
                model: 'Imported Eagle Asset',
                size:
                  asset.width && asset.height
                    ? `${Math.round(asset.width)}x${Math.round(asset.height)}`
                    : `${displaySize.width}x${displaySize.height}`,
                seed: createdAt % 99999,
                createdAt,
              },
            })
          })

          return patchWithHistory(state, {
            selectedNodeId: nodes[0]?.id,
            selectedNodeIds: nodes.map((node) => node.id),
            nodes: [...state.nodes, ...nodes],
          })
        }),
      generateVariations: (sourceNodeId) => {
        const state = get()
        const source =
          state.nodes.find((node) => node.id === sourceNodeId) ||
          state.nodes.find((node) => node.id === state.selectedNodeId) ||
          state.nodes[0]

        if (!source) {
          warnCanvas('Variation generation skipped: no source node available')
          return
        }

        const batchId = Date.now() % 100000
        const result = mockGenerationAdapter.generateVariations({
          sourceNode: source,
          count: 4,
          batchId,
        })
        const createdAt = Date.now()
        const resultNodes = result.nodes.map((node) => ({
          ...node,
          sourceNodeId: source.id,
          generation: node.generation
            ? {
                ...node.generation,
                createdAt,
              }
            : node.generation,
        }))
        const edges = resultNodes.map((node) => ({
          id: createEdgeId(),
          from: source.id,
          to: node.id,
          type: 'generate' as const,
          prompt: node.generation?.prompt || nodePrompt(source),
          createdAt,
        }))

        set((current) => ({
          activeTool: 'variations',
          ...patchWithHistory(current, {
            selectedNodeId: resultNodes[0]?.id,
            selectedNodeIds: resultNodes[0] ? [resultNodes[0].id] : [],
            nodes: [...current.nodes, ...resultNodes],
            edges: [...current.edges, ...edges],
            tasks: [result.task, ...current.tasks].slice(0, 5),
          }),
        }))
        logCanvas(`Generated ${result.nodes.length} variations from "${source.title}"`)
      },
      generateImageEdit: async (sourceNodeId, operation, prompt, options = {}) => {
        const targetSceneId = options.sceneId || get().sceneId
        const taskId = createNodeId(`task-${operation}`)
        const operationLabels: Record<string, string> = {
          'prompt-edit': 'Prompt edit',
          'area-edit': 'Area edit',
          'remove-background': 'Remove background',
          outpaint: 'Expand image',
          upscale: 'Boost resolution',
        }
        const operationLabel = operationLabels[operation] || 'Image edit'
        const state = get()
        const document = state.canvases[targetSceneId]
        if (!document) throw new Error('目标画布已删除，无法继续生成。')
        const source =
          (sourceNodeId
            ? document.nodes.find((node) => node.id === sourceNodeId && node.type === 'image' && !node.hidden)
            : undefined) ||
          (!sourceNodeId
            ? document.nodes.find((node) => node.id === document.selectedNodeId && node.type === 'image' && !node.hidden)
            : undefined)
        if (sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')
        if (!source) return []

        const resultPrompt = prompt.trim() || operationLabel
        const model = options.model || defaultMivoImageModel
        const runningTask: CanvasTask = {
          id: taskId,
          label: `${operationLabel}: ${source.title}`,
          status: 'running',
          progress: 20,
          nodeIds: [],
        }

        set((current) => {
          const targetDocument = current.canvases[targetSceneId]
          if (!targetDocument) return {}
          return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(targetDocument.tasks, runningTask) })
        })

        try {
          const image = await assetBlobForNode(source)
          const response = await editMivoImage({
            image,
            reference: options.referenceFiles,
            prompt: resultPrompt,
            imgRatio: options.imgRatio || '1:1',
            quality: options.quality || 'medium',
            model,
            signal: options.signal,
          })
          const nodeIds = await get().commitGenerationResult({
            sceneId: targetSceneId,
            sourceNodeId: source.id,
            resultImages: response.images,
            prompt: resultPrompt,
            model,
            kind: edgeTypeForOperation(operation),
            taskId,
            createDerivationEdge: options.createDerivationEdge,
          })
          set((current) => {
            const targetDocument = current.canvases[targetSceneId]
            if (!targetDocument) return {}
            return patchCanvasDocument(current, targetSceneId, {
              tasks: upsertTask(targetDocument.tasks, doneTask(runningTask, `${operationLabel}: ${source.title}`, nodeIds)),
            })
          })
          return nodeIds
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Image edit failed'
          const canceled = isCanceledGenerationError(error, options.signal)
          set((current) => {
            const targetDocument = current.canvases[targetSceneId]
            if (!targetDocument) return {}
            return patchCanvasDocument(current, targetSceneId, {
              tasks: upsertTask(
                targetDocument.tasks,
                canceled
                  ? canceledTask(runningTask, `${operationLabel} canceled`)
                  : failedTask(runningTask, `${operationLabel} failed: ${message}`),
              ),
            })
          })
          throw error
        }
      },
      generateBesideNode: async (sourceNodeId, prompt, options = {}) => {
        const targetSceneId = options.sceneId || get().sceneId
        const state = get()
        const document = state.canvases[targetSceneId]
        if (!document) throw new Error('目标画布已删除，无法继续生成。')
        const source =
          (sourceNodeId ? document.nodes.find((node) => node.id === sourceNodeId && !node.hidden) : undefined) ||
          (!sourceNodeId
            ? document.nodes.find((node) => node.id === document.selectedNodeId && !node.hidden) ||
              document.nodes.find((node) => !node.hidden)
            : undefined)
        if (sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')
        if (!source) return []

        const resultPrompt = prompt?.trim() || nodePrompt(source)
        const model = options.model || defaultMivoImageModel
        const taskId = createNodeId('task-beside-generation')
        const runningTask: CanvasTask = {
          id: taskId,
          label: `旁边生成：${source.title}`,
          status: 'running',
          progress: 20,
          nodeIds: [],
        }

        set((current) => {
          const targetDocument = current.canvases[targetSceneId]
          if (!targetDocument) return {}
          return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(targetDocument.tasks, runningTask) })
        })

        try {
          const referenceFiles = options.referenceFiles || []
          const sourceImage = source.type === 'image' && source.assetUrl ? await assetBlobForNode(source) : undefined
          const editImage = sourceImage || referenceFiles[0]
          const response = editImage
            ? await editMivoImage({
                image: editImage,
                reference: sourceImage ? referenceFiles : referenceFiles.slice(1),
                prompt: resultPrompt,
                imgRatio: options.imgRatio || '1:1',
                quality: options.quality || 'medium',
                model,
                signal: options.signal,
              })
            : await generateMivoImage({
                prompt: resultPrompt,
                imgRatio: options.imgRatio || '1:1',
                quality: options.quality || 'medium',
                n: 1,
                model,
                signal: options.signal,
              })
          const nodeIds = await get().commitGenerationResult({
            sceneId: targetSceneId,
            sourceNodeId: source.id,
            resultImages: response.images,
            prompt: resultPrompt,
            model,
            kind: 'generate',
            taskId,
            createDerivationEdge: options.createDerivationEdge,
          })
          set((current) => {
            const targetDocument = current.canvases[targetSceneId]
            if (!targetDocument) return {}
            return patchCanvasDocument(current, targetSceneId, {
              tasks: upsertTask(targetDocument.tasks, doneTask(runningTask, `旁边生成：${source.title}`, nodeIds)),
            })
          })
          return nodeIds
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Generation failed'
          const canceled = isCanceledGenerationError(error, options.signal)
          set((current) => {
            const targetDocument = current.canvases[targetSceneId]
            if (!targetDocument) return {}
            return patchCanvasDocument(current, targetSceneId, {
              tasks: upsertTask(
                targetDocument.tasks,
                canceled
                  ? canceledTask(runningTask, `旁边生成已取消：${source.title}`)
                  : failedTask(runningTask, `旁边生成失败：${message}`),
              ),
            })
          })
          throw error
        }
      },
      generateIntoAiSlot: async (slotId, prompt, options = {}) => {
        const targetSceneId = options.sceneId || get().sceneId
        const state = get()
        const document = state.canvases[targetSceneId]
        if (!document) throw new Error('目标画布已删除，无法继续生成。')
        const slot =
          (slotId ? document.nodes.find((node) => node.id === slotId && node.type === 'ai-slot' && !node.hidden) : undefined) ||
          (!slotId
            ? document.nodes.find((node) => node.id === document.selectedNodeId && node.type === 'ai-slot' && !node.hidden)
            : undefined)
        if (slotId && !slot) throw new Error('AI 生成槽位已删除，无法继续生成。')
        if (!slot) return []

        const resultPrompt = prompt?.trim() || nodePrompt(slot, '根据 AI 槽位生成图片')
        const model = options.model || defaultMivoImageModel
        const taskId = createNodeId('task-slot-generation')
        const runningTask: CanvasTask = {
          id: taskId,
          label: `生成到槽位：${slot.title}`,
          status: 'running',
          progress: 20,
          nodeIds: [],
        }

        set((current) => {
          const targetDocument = current.canvases[targetSceneId]
          if (!targetDocument) return {}
          const nodes = targetDocument.nodes.map((node) =>
            node.id === slot.id
              ? {
                  ...node,
                  generation: {
                    prompt: resultPrompt,
                    model,
                    size: node.generation?.size || `${Math.round(slot.width)}x${Math.round(slot.height)}`,
                    seed: node.generation?.seed,
                    strength: node.generation?.strength,
                    taskId,
                    createdAt: Date.now(),
                  },
                  aiWorkflow: {
                    ...(node.aiWorkflow || { kind: 'slot' as const }),
                    status: 'generating' as const,
                    operation: 'slot-generation' as const,
                    prompt: resultPrompt,
                  },
                }
              : node,
          )
          return patchCanvasDocument(current, targetSceneId, { nodes, tasks: upsertTask(targetDocument.tasks, runningTask) })
        })

        try {
          const referenceFiles = options.referenceFiles || []
          const response = referenceFiles[0]
            ? await editMivoImage({
                image: referenceFiles[0],
                reference: referenceFiles.slice(1),
                prompt: resultPrompt,
                imgRatio: options.imgRatio || '1:1',
                quality: options.quality || 'medium',
                model,
                signal: options.signal,
              })
            : await generateMivoImage({
                prompt: resultPrompt,
                imgRatio: options.imgRatio || '1:1',
                quality: options.quality || 'medium',
                n: 1,
                model,
                signal: options.signal,
              })
          const nodeIds = await get().commitGenerationResult({
            sceneId: targetSceneId,
            sourceNodeId: slot.id,
            resultImages: response.images,
            prompt: resultPrompt,
            model,
            kind: 'generate',
            taskId,
            placement: 'right',
            createDerivationEdge: options.createDerivationEdge,
          })
          set((current) => {
            const targetDocument = current.canvases[targetSceneId]
            if (!targetDocument) return {}
            const nodes = targetDocument.nodes.map((node) =>
              node.id === slot.id && node.aiWorkflow
                ? {
                    ...node,
                    aiWorkflow: {
                      ...node.aiWorkflow,
                      status: 'ready' as const,
                    },
                  }
                : node,
            )
            return patchCanvasDocument(current, targetSceneId, {
              nodes,
              tasks: upsertTask(targetDocument.tasks, doneTask(runningTask, `生成到槽位：${slot.title}`, nodeIds)),
            })
          })
          return nodeIds
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Generation failed'
          const canceled = isCanceledGenerationError(error, options.signal)
          set((current) => {
            const targetDocument = current.canvases[targetSceneId]
            if (!targetDocument) return {}
            const nodes = targetDocument.nodes.map((node) =>
              node.id === slot.id && node.aiWorkflow
                ? {
                    ...node,
                    aiWorkflow: {
                      ...node.aiWorkflow,
                      status: canceled ? 'canceled' as const : 'failed' as const,
                    },
                  }
                : node,
            )
            return patchCanvasDocument(current, targetSceneId, {
              nodes,
              tasks: upsertTask(
                targetDocument.tasks,
                canceled
                  ? canceledTask(runningTask, `生成到槽位已取消：${slot.title}`)
                  : failedTask(runningTask, `生成到槽位失败：${message}`),
              ),
            })
          })
          throw error
        }
      },
      generateFromAnnotation: (annotationNodeId) => {
        const id = createNodeId('annotation-result')
        const createdAt = Date.now()

        set((state) => {
          const annotation =
            state.nodes.find((node) => node.id === annotationNodeId && node.type === 'annotation' && !node.hidden) ||
            state.nodes.find((node) => node.id === state.selectedNodeId && node.type === 'annotation' && !node.hidden)
          if (!annotation) {
            warnCanvas('Annotation generation skipped: no annotation selected')
            return {}
          }

          const sourceId = annotation.aiWorkflow?.sourceNodeIds?.[0] || annotation.parentIds?.[0]
          const source = sourceId ? state.nodes.find((node) => node.id === sourceId && !node.hidden) : undefined
          const anchor = source || annotation
          const width = source && source.type !== 'text' && source.type !== 'annotation' ? source.width : 320
          const height = source && source.type !== 'text' && source.type !== 'annotation' ? source.height : 240
          const placement = chooseAdjacentPlacement({
            nodes: state.nodes,
            anchor,
            width,
            height,
            placement: 'right',
          })
          const resultPrompt = nodePrompt(annotation, '根据批注生成修订版图片')
          const result = createAiResultNode({
            id,
            title: `Edited from ${source?.title || annotation.title}`,
            sourceNodes: source ? [source] : [annotation],
            anchorNode: anchor,
            annotationNode: annotation,
            operation: 'annotation-edit',
            prompt: resultPrompt,
            placement: 'right',
            position: { x: placement.x, y: placement.y },
            size: { width, height },
            assetUrl: mockResultAssetUrl(state.nodes),
            createdAt,
            taskId: `task-${id}`,
            strength: 0.66,
          })
          const task: CanvasTask = {
            id: `task-${id}`,
            label: `批注修图：${source?.title || annotation.title}`,
            status: 'done',
            progress: 100,
            nodeIds: [id],
          }
          const edge: CanvasEdge = {
            id: createEdgeId(),
            from: anchor.id,
            to: id,
            type: 'edit',
            prompt: resultPrompt,
            createdAt,
          }

          logCanvas(`Generated from annotation "${annotation.title}"`)
          return patchWithHistory(state, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: normalizeCanvasNodes([...state.nodes, result]),
            edges: [...state.edges, edge],
            tasks: [task, ...state.tasks].slice(0, 5),
          })
        })
      },
    }) as CanvasState,
    {
      name: 'mivo-canvas-demo',
      version: 8,
      migrate: migratePersistedState,
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
