import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AiCanvasContextSnapshot,
  AiWorkflowOperation,
  CanvasAssetNodeType,
  CanvasEdge,
  CanvasEdgeType,
  CanvasId,
  CanvasDocument,
  CanvasMaskBounds,
  CanvasTask,
  ConnectorBinding,
  DemoSceneId,
  MarkupKind,
  MarkupPoint,
  MarkdownDisplayMode,
  MivoCanvasNode,
  MivoCanvasSnapshot,
  SectionBorderStyle,
  SectionLockMode,
  ToolId,
} from '../types/mivoCanvas'
import { connectorAnchorPointFor, connectorBindingPointFor, derivationConnectorBindingsFor, isConnectorNode } from '../canvas/connectorGeometry'
import { defaultSizeForNodeType } from '../canvas/nodeTypes/canvasNodeRegistry'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from '../canvas/textGeometry'
import {
  markdownDocumentWidth,
  markdownPreviewHeight,
  markdownShouldUsePreviewMode,
  type ImportedFileMetadata,
} from '../lib/canvasAssetImport'
import { importedImageDisplaySize, type ImportedImageMetadata } from '../lib/imageSizing'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { MivoImageRequestError, assetBlobForNode, editMivoImage, generateMivoImage } from '../lib/mivoImageClient'
import { buildAiContextSnapshot, chooseAdjacentPlacement } from './aiCanvasWorkflow'
import { makeNode, realCaseImages, scenes, snapshotFromScene } from './demoScenes'
import { mockGenerationAdapter } from './mockGeneration'
import type { CanvasAssetClipboardItem } from '../app/assetLibraryModel'
import type {
  CommitGenerationResultPayload,
  CommittedGenerationImage,
  GenerationRatio,
  MivoImageQuality,
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

type CanvasState = {
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
  copySelectedNodes: () => void
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
  Pick<CanvasState, 'canvases' | 'nodes' | 'edges' | 'tasks' | 'sceneId' | 'selectedNodeId' | 'selectedNodeIds' | 'activeTool'>
>

export { scenes }

const historyLimit = 60
const sceneOptions = scenes()
const sceneIds = new Set<DemoSceneId>(sceneOptions.map((scene) => scene.id))
const sceneLabels = new Map(sceneOptions.map((scene) => [scene.id, scene.label]))

const fallbackTitle = (sceneId: CanvasId) => sceneLabels.get(sceneId as DemoSceneId) || sceneId

const cloneNode = (node: MivoCanvasNode): MivoCanvasNode => ({
  ...node,
  markupPoints: node.markupPoints ? node.markupPoints.map((point) => ({ ...point })) : undefined,
  connectorStart: node.connectorStart ? { ...node.connectorStart } : undefined,
  connectorEnd: node.connectorEnd ? { ...node.connectorEnd } : undefined,
  parentIds: node.parentIds ? [...node.parentIds] : undefined,
  generation: node.generation
    ? {
        ...node.generation,
        maskBounds: node.generation.maskBounds ? { ...node.generation.maskBounds } : undefined,
      }
    : undefined,
  aiWorkflow: node.aiWorkflow
    ? {
        ...node.aiWorkflow,
        sourceNodeIds: node.aiWorkflow.sourceNodeIds ? [...node.aiWorkflow.sourceNodeIds] : undefined,
      }
    : undefined,
})

const cloneTask = (task: CanvasTask): CanvasTask => ({
  ...task,
  nodeIds: [...task.nodeIds],
})

const cloneEdge = (edge: CanvasEdge): CanvasEdge => ({ ...edge })

const cloneNodes = (nodes: MivoCanvasNode[]) => nodes.map(cloneNode)
const cloneTasks = (tasks: CanvasTask[]) => tasks.map(cloneTask)
const cloneEdges = (edges: CanvasEdge[] = []) => edges.map(cloneEdge)

const normalizeSelection = (nodeIds: string[] | undefined, nodes: MivoCanvasNode[]) => {
  const validIds = new Set(nodes.filter((node) => !node.hidden).map((node) => node.id))
  return Array.from(new Set(nodeIds || [])).filter((nodeId) => validIds.has(nodeId))
}

const selectionFrom = (nodeIds: string[] | undefined, selectedNodeId: string | undefined, nodes: MivoCanvasNode[]) => {
  const selection = normalizeSelection(nodeIds?.length ? nodeIds : selectedNodeId ? [selectedNodeId] : [], nodes)
  const primary = selectedNodeId && selection.includes(selectedNodeId) ? selectedNodeId : selection[0]

  return { selectedNodeId: primary, selectedNodeIds: selection }
}

const snapshotFromState = (state: Pick<CanvasState, 'sceneId' | 'nodes' | 'edges' | 'tasks' | 'selectedNodeId' | 'selectedNodeIds'>) => ({
  version: 1 as const,
  sceneId: state.sceneId,
  nodes: cloneNodes(state.nodes),
  edges: cloneEdges(state.edges),
  tasks: cloneTasks(state.tasks),
  selectedNodeId: state.selectedNodeId,
  selectedNodeIds: [...state.selectedNodeIds],
})

const remember = (state: CanvasState) => ({
  historyPast: [...state.historyPast.slice(-(historyLimit - 1)), snapshotFromState(state)],
  historyFuture: [],
})

const createCanvasId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `canvas-${crypto.randomUUID()}`
  }

  return `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const createGroupId = () => `group-${Date.now()}-${Math.random().toString(16).slice(2)}`
const createNodeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const createEdgeId = () => createNodeId('edge')

const defaultSectionFillColor = '#ffffff'
const defaultSectionBorderColor = '#ff8a00'
const defaultSectionBorderWidth = 2
const defaultSectionBorderStyle: SectionBorderStyle = 'dashed'
const defaultMarkupStrokeColor = '#6957e8'
const defaultMarkupFillColor = 'rgba(105, 87, 232, 0.08)'
const defaultMarkupStrokeWidth = 3

const isSectionNode = (node: MivoCanvasNode) => node.type === 'frame'
const isEditableTextNode = (node: MivoCanvasNode | undefined) =>
  node?.type === 'text' || node?.type === 'annotation' || node?.type === 'markup'

const nodeCenter = (node: Pick<MivoCanvasNode, 'x' | 'y' | 'width' | 'height'>) => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2,
})

const containsPoint = (section: MivoCanvasNode, point: { x: number; y: number }) =>
  point.x >= section.x &&
  point.x <= section.x + section.width &&
  point.y >= section.y &&
  point.y <= section.y + section.height

const sectionForNode = (nodes: MivoCanvasNode[], node: MivoCanvasNode) =>
  node.sectionId ? nodes.find((item) => item.id === node.sectionId && isSectionNode(item)) : undefined

const isEffectivelyLocked = (nodes: MivoCanvasNode[], node: MivoCanvasNode) => {
  const parentSection = sectionForNode(nodes, node)
  return Boolean(node.locked || parentSection?.sectionLockMode === 'all')
}

const childIdsForSections = (nodes: MivoCanvasNode[], sectionIds: Set<string>) =>
  nodes.filter((node) => node.sectionId && sectionIds.has(node.sectionId)).map((node) => node.id)

const sectionIdForNodeBounds = (nodes: MivoCanvasNode[], node: MivoCanvasNode) => {
  if (isSectionNode(node)) return undefined

  const center = nodeCenter(node)
  const sections = nodes.filter((item) => isSectionNode(item) && !item.hidden && containsPoint(item, center))
  return sections.at(-1)?.id
}

const targetNodeIdForMarkup = (nodes: MivoCanvasNode[], markup: MivoCanvasNode) => {
  const center = nodeCenter(markup)

  return nodes
    .filter(
      (node) =>
        !node.hidden &&
        node.id !== markup.id &&
        node.type !== 'frame' &&
        node.type !== 'markup' &&
        containsPoint(node, center),
    )
    .at(-1)?.id
}

const normalizeSectionMembership = (nodes: MivoCanvasNode[]) =>
  nodes.map((node) => {
    if (isSectionNode(node) || node.hidden) return node

    const nextSectionId = sectionIdForNodeBounds(nodes, node)
    return nextSectionId === node.sectionId ? node : { ...node, sectionId: nextSectionId }
  })

const defaultLineMarkupPointsFor = (node: MivoCanvasNode): MarkupPoint[] => [
  { x: Math.max(2, node.markupStrokeWidth || 3), y: Math.max(2, node.height - (node.markupStrokeWidth || 3)) },
  { x: Math.max(2, node.width - (node.markupStrokeWidth || 3)), y: Math.max(2, node.markupStrokeWidth || 3) },
]

const lineMarkupPointsFor = (node: MivoCanvasNode): MarkupPoint[] =>
  node.markupPoints && node.markupPoints.length >= 2
    ? node.markupPoints.slice(0, 2).map((point) => ({ ...point }))
    : defaultLineMarkupPointsFor(node)

const markupGeometryFromAbsolutePoints = (points: MarkupPoint[]) => {
  const minWidth = 18
  const minHeight = 18
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const rawWidth = maxX - minX
  const rawHeight = maxY - minY
  const width = Math.max(minWidth, rawWidth)
  const height = Math.max(minHeight, rawHeight)
  const x = rawWidth < minWidth ? minX - (minWidth - rawWidth) / 2 : minX
  const y = rawHeight < minHeight ? minY - (minHeight - rawHeight) / 2 : minY

  return {
    geometry: { x, y, width, height },
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
  }
}

const normalizeConnectorMarkupNodes = (nodes: MivoCanvasNode[]) =>
  nodes.map((node) => {
    if (!isConnectorNode(node) || (!node.connectorStart && !node.connectorEnd)) return node

    const startBindingPoint = connectorBindingPointFor(nodes, node.connectorStart)
    const endBindingPoint = connectorBindingPointFor(nodes, node.connectorEnd)
    const points = lineMarkupPointsFor(node)
    const absolutePoints = points.map((point) => ({ x: node.x + point.x, y: node.y + point.y }))
    if (startBindingPoint) absolutePoints[0] = startBindingPoint
    if (endBindingPoint) absolutePoints[1] = endBindingPoint

    const next = markupGeometryFromAbsolutePoints(absolutePoints)
    return {
      ...node,
      x: Math.round(next.geometry.x),
      y: Math.round(next.geometry.y),
      width: Math.round(next.geometry.width),
      height: Math.round(next.geometry.height),
      markupPoints: next.points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
      connectorStart: startBindingPoint ? node.connectorStart : undefined,
      connectorEnd: endBindingPoint ? node.connectorEnd : undefined,
    }
  })

const derivationEdgeModel = 'Mivo Derivation Edge'
const derivationEdgeNodeId = (edgeId: string) => `derivation-${edgeId}`
const isDerivationEdgeNode = (node: MivoCanvasNode) =>
  node.type === 'markup' && node.generation?.model === derivationEdgeModel

const createDerivationEdgeNode = (edge: CanvasEdge, nodes: MivoCanvasNode[]): MivoCanvasNode | undefined => {
  const source = nodes.find((node) => node.id === edge.from && !node.hidden)
  const target = nodes.find((node) => node.id === edge.to && !node.hidden)
  if (!source || !target) return undefined

  // M10: dynamic anchor selection — pick shortest-distance anchor pair
  const { start, end } = derivationConnectorBindingsFor(source, target)
  const startPt = connectorAnchorPointFor(source, start.anchor, 0.5)
  const endPt = connectorAnchorPointFor(target, end.anchor, 0.5)

  return makeNode({
    id: derivationEdgeNodeId(edge.id),
    type: 'markup',
    title: edge.type === 'edit' ? 'Edit derivation' : 'Generation derivation',
    // Initial geometry; overridden by normalizeConnectorMarkupNodes from binding anchor points
    x: Math.min(startPt.x, endPt.x),
    y: Math.min(startPt.y, endPt.y),
    width: Math.max(24, Math.abs(endPt.x - startPt.x)),
    height: Math.max(24, Math.abs(endPt.y - startPt.y)),
    markupKind: 'arrow',
    markupStrokeColor: '#497466',
    markupStrokeWidth: 3,
    markupStrokeStyle: 'solid',
    markupOpacity: 0.82,
    markupStartArrow: false,
    markupEndArrow: true,
    markupPoints: [
      { x: 0, y: 0 },
      { x: Math.max(24, Math.abs(endPt.x - startPt.x)), y: Math.round(endPt.y - startPt.y) },
    ],
    connectorStart: start,
    connectorEnd: end,
    status: 'ready',
    locked: true,
    generation: {
      prompt: edge.prompt,
      model: derivationEdgeModel,
      createdAt: edge.createdAt,
    },
  })
}

const syncDerivationEdgeNodes = (nodes: MivoCanvasNode[], edges: CanvasEdge[]) => {
  const contentNodes = nodes.filter((node) => !isDerivationEdgeNode(node))
  const contentIds = new Set(contentNodes.filter((node) => !node.hidden).map((node) => node.id))
  const edgeNodes = edges
    .filter((edge) => contentIds.has(edge.from) && contentIds.has(edge.to))
    .map((edge) => createDerivationEdgeNode(edge, contentNodes))
    .filter((node): node is MivoCanvasNode => Boolean(node))

  return [...contentNodes, ...edgeNodes]
}

const normalizeCanvasNodes = (nodes: MivoCanvasNode[]) =>
  normalizeConnectorMarkupNodes(normalizeSectionMembership(nodes))

const normalizeCanvasGraph = (nodes: MivoCanvasNode[], edges: CanvasEdge[] = []) =>
  normalizeCanvasNodes(syncDerivationEdgeNodes(nodes, edges))

const normalizeLongMarkdownPreviewNodes = (nodes: MivoCanvasNode[]) =>
  nodes.map((node) => {
    if (node.type !== 'markdown' || !markdownShouldUsePreviewMode(node.text)) return node

    return {
      ...node,
      markdownDisplayMode: 'preview' as const,
      width: markdownDocumentWidth,
      height: markdownPreviewHeight,
    }
  })

const createBlankDocument = (title = 'Untitled Canvas', projectId?: string): CanvasDocument => ({
  title,
  projectId,
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeId: undefined,
  selectedNodeIds: [],
})

const canvasDocumentFromScene = (sceneId: DemoSceneId): CanvasDocument => {
  const snapshot = snapshotFromScene(sceneId)
  const selection = selectionFrom(snapshot.selectedNodeIds, snapshot.selectedNodeId, snapshot.nodes)

  return {
    title: fallbackTitle(sceneId),
    sourceTemplateId: sceneId,
    nodes: normalizeCanvasGraph(cloneNodes(snapshot.nodes), snapshot.edges || []),
    edges: cloneEdges(snapshot.edges || []),
    tasks: cloneTasks(snapshot.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }
}

const initialCanvases = () =>
  Object.fromEntries(sceneOptions.map((scene) => [scene.id, canvasDocumentFromScene(scene.id)])) as Record<
    CanvasId,
    CanvasDocument
  >

const documentFor = (canvases: Record<CanvasId, CanvasDocument>, sceneId: CanvasId) =>
  canvases[sceneId] || (sceneIds.has(sceneId as DemoSceneId) ? canvasDocumentFromScene(sceneId as DemoSceneId) : createBlankDocument(fallbackTitle(sceneId)))

const normalizeDocument = (document: CanvasDocument): CanvasDocument => {
  const edges = cloneEdges(document.edges || [])
  const nodes = normalizeCanvasGraph(cloneNodes(document.nodes), edges)
  const selection = selectionFrom(document.selectedNodeIds, document.selectedNodeId, nodes)

  return {
    ...document,
    projectId: document.projectId,
    sourceTemplateId: document.sourceTemplateId,
    nodes,
    edges,
    tasks: cloneTasks(document.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }
}

const patchActiveCanvas = (
  state: CanvasState,
  patch: Partial<Pick<CanvasDocument, 'nodes' | 'edges' | 'tasks' | 'selectedNodeId' | 'selectedNodeIds' | 'title'>>,
) => {
  const currentDocument = documentFor(state.canvases, state.sceneId)
  const nextEdges = 'edges' in patch ? cloneEdges(patch.edges || []) : state.edges
  const nextNodes =
    'nodes' in patch || 'edges' in patch
      ? normalizeCanvasGraph(patch.nodes || state.nodes, nextEdges)
      : state.nodes
  const selection = selectionFrom(
    'selectedNodeIds' in patch ? patch.selectedNodeIds : state.selectedNodeIds,
    'selectedNodeId' in patch ? patch.selectedNodeId : state.selectedNodeId,
    nextNodes,
  )
  const nextDocument = {
    ...currentDocument,
    ...patch,
    nodes: nextNodes,
    edges: nextEdges,
    tasks: patch.tasks || currentDocument.tasks,
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }

  return {
    ...('nodes' in patch || 'edges' in patch ? { nodes: nextNodes } : {}),
    ...('edges' in patch ? { edges: nextEdges } : {}),
    ...(patch.tasks ? { tasks: patch.tasks } : {}),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    canvases: {
      ...state.canvases,
      [state.sceneId]: nextDocument,
    },
  }
}

const patchWithHistory = (
  state: CanvasState,
  patch: Partial<Pick<CanvasDocument, 'nodes' | 'edges' | 'tasks' | 'selectedNodeId' | 'selectedNodeIds' | 'title'>>,
) => ({
  ...remember(state),
  ...patchActiveCanvas(state, patch),
})

type CanvasDocumentPatch = Partial<
  Pick<CanvasDocument, 'nodes' | 'edges' | 'tasks' | 'selectedNodeId' | 'selectedNodeIds' | 'title'>
>

const patchCanvasDocument = (
  state: CanvasState,
  sceneId: CanvasId,
  patch: CanvasDocumentPatch,
  options: { history?: boolean } = {},
) => {
  if (sceneId === state.sceneId) {
    return options.history ? patchWithHistory(state, patch) : patchActiveCanvas(state, patch)
  }

  const currentDocument = state.canvases[sceneId]
  if (!currentDocument) return {}

  const nextEdges = 'edges' in patch ? cloneEdges(patch.edges || []) : cloneEdges(currentDocument.edges || [])
  const nextNodes =
    'nodes' in patch || 'edges' in patch
      ? normalizeCanvasGraph(cloneNodes(patch.nodes || currentDocument.nodes), nextEdges)
      : cloneNodes(currentDocument.nodes)
  const selection = selectionFrom(
    'selectedNodeIds' in patch ? patch.selectedNodeIds : currentDocument.selectedNodeIds,
    'selectedNodeId' in patch ? patch.selectedNodeId : currentDocument.selectedNodeId,
    nextNodes,
  )
  const nextDocument: CanvasDocument = {
    ...currentDocument,
    ...patch,
    nodes: nextNodes,
    edges: nextEdges,
    tasks: patch.tasks ? cloneTasks(patch.tasks) : cloneTasks(currentDocument.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }

  return {
    canvases: {
      ...state.canvases,
      [sceneId]: nextDocument,
    },
  }
}

const applySnapshot = (state: CanvasState, snapshot: MivoCanvasSnapshot) => {
  const currentDocument = documentFor(state.canvases, snapshot.sceneId)
  const edges = cloneEdges(snapshot.edges || [])
  const nodes = normalizeCanvasGraph(cloneNodes(snapshot.nodes), edges)
  const selection = selectionFrom(snapshot.selectedNodeIds, snapshot.selectedNodeId, nodes)
  const document: CanvasDocument = {
    ...currentDocument,
    nodes,
    edges,
    tasks: cloneTasks(snapshot.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }

  return {
    sceneId: snapshot.sceneId,
    nodes: document.nodes,
    edges: document.edges,
    tasks: document.tasks,
    selectedNodeId: document.selectedNodeId,
    selectedNodeIds: document.selectedNodeIds || [],
    activeTool: 'select' as ToolId,
    canvases: {
      ...state.canvases,
      [snapshot.sceneId]: document,
    },
  }
}

const createNodeCopy = (
  source: MivoCanvasNode,
  index: number,
  offset = 28,
  overrides?: Partial<MivoCanvasNode>,
): MivoCanvasNode => ({
  ...cloneNode(source),
  id: `${source.id}-copy-${Date.now()}-${index}`,
  title: `${source.title} Copy`,
  x: source.x + offset,
  y: source.y + offset,
  groupId: undefined,
  sectionId: undefined,
  connectorStart: undefined,
  connectorEnd: undefined,
  hidden: undefined,
  ...overrides,
})

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const cropEqualsFullImage = (crop: { x: number; y: number; width: number; height: number }) =>
  Math.abs(crop.x) < 0.0001 &&
  Math.abs(crop.y) < 0.0001 &&
  Math.abs(crop.width - 1) < 0.0001 &&
  Math.abs(crop.height - 1) < 0.0001

const withFrameBehindArtwork = (nodes: MivoCanvasNode[], frame: MivoCanvasNode) => {
  const firstArtworkIndex = nodes.findIndex((node) => node.type !== 'frame')
  if (firstArtworkIndex < 0) return [...nodes, frame]

  return [...nodes.slice(0, firstArtworkIndex), frame, ...nodes.slice(firstArtworkIndex)]
}

const nodePrompt = (node: MivoCanvasNode | undefined, fallback = '基于当前画布上下文生成新图') =>
  node?.text?.trim() || node?.generation?.prompt || node?.aiWorkflow?.prompt || fallback

const mockResultAssetUrl = (nodes: MivoCanvasNode[]) => realCaseImages[nodes.length % realCaseImages.length]
const defaultMivoImageModel = 'gpt-image-2'

const importedAssetDisplaySize = (type: CanvasAssetNodeType, metadata?: ImportedFileMetadata) => {
  if (type === 'image' || type === 'video') {
    return metadata?.dimensions ? importedImageDisplaySize(metadata.dimensions) : defaultSizeForNodeType(type)
  }

  if (type === 'markdown') {
    const defaultSize = defaultSizeForNodeType(type)
    return markdownShouldUsePreviewMode(metadata?.text)
      ? {
          ...defaultSize,
          width: markdownDocumentWidth,
          height: markdownPreviewHeight,
        }
      : {
          ...defaultSize,
          width: markdownDocumentWidth,
        }
  }

  return defaultSizeForNodeType(type)
}

const importedAssetPromptFor = (type: Exclude<CanvasAssetNodeType, 'markdown'>) => {
  if (type === 'pdf') return '本地导入 PDF 文档，可作为后续 AI 上下文'
  if (type === 'video') return '本地导入视频文件，可作为后续 AI 上下文'
  return '本地导入图片，可作为后续 AI 上下文'
}

const clipboardAssetTitle = (asset: CanvasAssetClipboardItem) =>
  asset.title?.trim() || asset.name?.replace(/\.[^.]+$/, '') || 'Eagle asset'

const clipboardAssetDisplaySize = (asset: CanvasAssetClipboardItem) =>
  importedImageDisplaySize(
    asset.width && asset.height
      ? {
          width: asset.width,
          height: asset.height,
        }
      : undefined,
  )

const importedAssetModelFor = (type: Exclude<CanvasAssetNodeType, 'markdown'>) => {
  if (type === 'pdf') return 'Imported PDF'
  if (type === 'video') return 'Imported Video'
  return 'Imported'
}

const cloneMaskBounds = (maskBounds?: CanvasMaskBounds) =>
  maskBounds ? { ...maskBounds } : undefined

const edgeTypeForOperation = (operation: AiWorkflowOperation): CanvasEdgeType =>
  operation === 'slot-generation' || operation === 'beside-generation' || operation === 'variation'
    ? 'generate'
    : 'edit'

const blobFromCommittedGenerationImage = (image: CommittedGenerationImage) => {
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
  } catch {
    throw new Error('Image service returned invalid image data')
  }
  if (!binary.length) throw new Error('Image service returned empty image data')

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: mimeType })
}

type GeneratedAssetRecord = Awaited<ReturnType<typeof saveGeneratedAsset>>

const displaySizeForGeneratedAsset = (
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

const selectedNodesFromState = (state: CanvasState) => {
  const selected = state.selectedNodeIds.length ? state.selectedNodeIds : state.selectedNodeId ? [state.selectedNodeId] : []
  const selectedSet = new Set(selected)
  return state.nodes.filter((node) => !node.hidden && selectedSet.has(node.id))
}

const selectedIdsFromState = (state: CanvasState) => selectedNodesFromState(state).map((node) => node.id)

const migratePersistedState = (persistedState: unknown, persistedVersion = 0) => {
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
    historyPast: [],
    historyFuture: [],
  }
}

const defaultSceneId: CanvasId = 'character-flow'
const defaultCanvases = initialCanvases()
const defaultDocument = documentFor(defaultCanvases, defaultSceneId)

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      canvases: defaultCanvases,
      sceneId: defaultSceneId,
      nodes: defaultDocument.nodes,
      edges: defaultDocument.edges || [],
      tasks: defaultDocument.tasks,
      selectedNodeId: defaultDocument.selectedNodeId,
      selectedNodeIds: defaultDocument.selectedNodeIds || [],
      activeTool: 'select',
      clipboardNodes: [],
      clipboardAssets: [],
      historyPast: [],
      historyFuture: [],
      createCanvas: (title = 'Untitled Canvas', options) => {
        const id = createCanvasId()

        set((state) => {
          const document = options?.templateId
            ? {
                ...canvasDocumentFromScene(options.templateId),
                title,
                projectId: options.projectId,
              }
            : createBlankDocument(title, options?.projectId)
          const normalizedDocument = normalizeDocument(document)

          return {
            sceneId: id,
            nodes: normalizedDocument.nodes,
            edges: normalizedDocument.edges || [],
            tasks: normalizedDocument.tasks,
            selectedNodeId: normalizedDocument.selectedNodeId,
            selectedNodeIds: normalizedDocument.selectedNodeIds || [],
            activeTool: 'select',
            historyPast: [],
            historyFuture: [],
            canvases: {
              ...state.canvases,
              [id]: normalizedDocument,
            },
          }
        })

        return id
      },
      duplicateCanvas: (canvasId) => {
        const state = get()
        const sourceId = canvasId || state.sceneId
        const sourceDocument = state.canvases[sourceId]
        if (!sourceDocument) return undefined

        const id = createCanvasId()
        const duplicatedDocument = normalizeDocument({
          ...sourceDocument,
          title: `${sourceDocument.title} Copy`,
          nodes: cloneNodes(sourceDocument.nodes),
          tasks: cloneTasks(sourceDocument.tasks),
        })

        set((current) => ({
          sceneId: id,
          nodes: duplicatedDocument.nodes,
          edges: duplicatedDocument.edges || [],
          tasks: duplicatedDocument.tasks,
          selectedNodeId: duplicatedDocument.selectedNodeId,
          selectedNodeIds: duplicatedDocument.selectedNodeIds || [],
          activeTool: 'select',
          historyPast: [],
          historyFuture: [],
          canvases: {
            ...current.canvases,
            [id]: duplicatedDocument,
          },
        }))

        return id
      },
      deleteCanvas: (canvasId) =>
        set((state) => {
          const targetId = canvasId || state.sceneId
          const canvasIds = Object.keys(state.canvases)
          if (!state.canvases[targetId] || canvasIds.length <= 1) return {}

          const remainingCanvases = { ...state.canvases }
          delete remainingCanvases[targetId]

          if (targetId !== state.sceneId) {
            return { canvases: remainingCanvases }
          }

          const nextSceneId = canvasIds.find((id) => id !== targetId) || defaultSceneId
          const nextDocument = normalizeDocument(documentFor(remainingCanvases, nextSceneId))

          return {
            canvases: remainingCanvases,
            sceneId: nextSceneId,
            nodes: nextDocument.nodes,
            edges: nextDocument.edges || [],
            tasks: nextDocument.tasks,
            selectedNodeId: nextDocument.selectedNodeId,
            selectedNodeIds: nextDocument.selectedNodeIds || [],
            activeTool: 'select',
            historyPast: [],
            historyFuture: [],
          }
        }),
      loadScene: (sceneId) =>
        set((state) => {
          const document = normalizeDocument(documentFor(state.canvases, sceneId))

          return {
            sceneId,
            nodes: document.nodes,
            edges: document.edges || [],
            tasks: document.tasks,
            selectedNodeId: document.selectedNodeId,
            selectedNodeIds: document.selectedNodeIds || [],
            activeTool: 'select',
            historyPast: [],
            historyFuture: [],
            canvases: {
              ...state.canvases,
              [sceneId]: document,
            },
          }
        }),
      renameCanvas: (sceneId, title) =>
        set((state) => {
          const document = documentFor(state.canvases, sceneId)

          return {
            canvases: {
              ...state.canvases,
              [sceneId]: {
                ...document,
                title,
              },
            },
          }
        }),
      selectNode: (nodeId, options) =>
        set((state) => {
          if (!nodeId) return patchActiveCanvas(state, { selectedNodeId: undefined, selectedNodeIds: [] })

          const target = state.nodes.find((node) => node.id === nodeId && !node.hidden)
          if (!target) return {}

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

            return patchActiveCanvas(state, { selectedNodeId, selectedNodeIds: normalizedSelection })
          }

          return patchActiveCanvas(state, { selectedNodeId: nodeId, selectedNodeIds: targetNodeIds })
        }),
      selectNodes: (nodeIds, primaryNodeId) =>
        set((state) => {
          const selectedNodeIds = normalizeSelection(nodeIds, state.nodes)
          const selectedNodeId =
            primaryNodeId && selectedNodeIds.includes(primaryNodeId) ? primaryNodeId : selectedNodeIds[0]

          return patchActiveCanvas(state, { selectedNodeId, selectedNodeIds })
        }),
      setActiveTool: (toolId) => set({ activeTool: toolId }),
      captureHistory: () => set((state) => remember(state)),
      undo: () =>
        set((state) => {
          const previous = state.historyPast.at(-1)
          if (!previous) return {}

          return {
            ...applySnapshot(state, previous),
            historyPast: state.historyPast.slice(0, -1),
            historyFuture: [snapshotFromState(state), ...state.historyFuture.slice(0, historyLimit - 1)],
          }
        }),
      redo: () =>
        set((state) => {
          const next = state.historyFuture[0]
          if (!next) return {}

          return {
            ...applySnapshot(state, next),
            historyPast: [...state.historyPast.slice(-(historyLimit - 1)), snapshotFromState(state)],
            historyFuture: state.historyFuture.slice(1),
          }
        }),
      updateNodePosition: (nodeId, x, y) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId)
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              node.id === nodeId ? { ...node, x: Math.round(x), y: Math.round(y) } : node,
            ),
          )

          return patchActiveCanvas(state, { nodes })
        }),
      updateSelectedNodesPosition: (anchorNodeId, x, y) =>
        set((state) => {
          const anchor = state.nodes.find((node) => node.id === anchorNodeId)
          if (!anchor || isEffectivelyLocked(state.nodes, anchor)) return {}

          const selectedNodeIds = state.selectedNodeIds.includes(anchorNodeId)
            ? state.selectedNodeIds
            : [anchorNodeId]
          const selectedSet = new Set(selectedNodeIds)
          const movingSectionIds = new Set(
            state.nodes
              .filter((node) => selectedSet.has(node.id) && isSectionNode(node) && !isEffectivelyLocked(state.nodes, node))
              .map((node) => node.id),
          )
          const moveSet = new Set([...selectedNodeIds, ...childIdsForSections(state.nodes, movingSectionIds)])
          const dx = Math.round(x - anchor.x)
          const dy = Math.round(y - anchor.y)
          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              moveSet.has(node.id) && !isEffectivelyLocked(state.nodes, node)
                ? { ...node, x: node.x + dx, y: node.y + dy }
                : node,
            ),
          )

          return patchActiveCanvas(state, { nodes, selectedNodeId: anchorNodeId, selectedNodeIds })
        }),
      updateNodeGeometry: (nodeId, x, y, width, height) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId)
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    x: Math.round(x),
                    y: Math.round(y),
                    width: Math.round(width),
                    height: Math.round(height),
                  }
                : node,
            ),
          )

          return patchActiveCanvas(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      updateNodesGeometry: (updates) =>
        set((state) => {
          if (!updates.length) return {}

          const updatesById = new Map(updates.map((update) => [update.id, update]))
          const nodes = normalizeCanvasNodes(state.nodes.map((node) => {
            const update = updatesById.get(node.id)
            if (!update || isEffectivelyLocked(state.nodes, node)) return node

            return {
              ...node,
              x: Math.round(update.x),
              y: Math.round(update.y),
              width: Math.round(update.width),
              height: Math.round(update.height),
            }
          }))

          return patchActiveCanvas(state, {
            nodes,
            selectedNodeId: state.selectedNodeId,
            selectedNodeIds: state.selectedNodeIds,
          })
        }),
      updateNodeMeasuredSize: (nodeId, width, height) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId)
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nextWidth = Math.max(120, Math.round(width))
          const nextHeight = Math.max(80, Math.round(height))
          if (Math.abs(target.width - nextWidth) < 1 && Math.abs(target.height - nextHeight) < 1) return {}

          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    width: nextWidth,
                    height: nextHeight,
                  }
                : node,
            ),
          )

          return patchActiveCanvas(state, { nodes })
        }),
      setMarkdownDisplayMode: (nodeId, mode) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markdown')
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nextHeight = mode === 'preview' ? Math.min(target.height, 620) : target.height
          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    markdownDisplayMode: mode,
                    height: Math.max(320, Math.round(nextHeight)),
                  }
                : node,
            ),
          )

          return patchWithHistory(state, { nodes })
        }),
      moveSelectedNodesBy: (dx, dy) =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (!selectedNodeIds.length) return {}

          const selectedSet = new Set(selectedNodeIds)
          const movingSectionIds = new Set(
            state.nodes
              .filter((node) => selectedSet.has(node.id) && isSectionNode(node) && !isEffectivelyLocked(state.nodes, node))
              .map((node) => node.id),
          )
          const moveSet = new Set([...selectedNodeIds, ...childIdsForSections(state.nodes, movingSectionIds)])
          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              moveSet.has(node.id) && !isEffectivelyLocked(state.nodes, node)
                ? { ...node, x: node.x + dx, y: node.y + dy }
                : node,
            ),
          )

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
        }),
      duplicateNode: (nodeId) =>
        set((state) => {
          const source = state.nodes.find((node) => node.id === nodeId)
          if (!source) return {}

          const clone = createNodeCopy(source, 0)

          return patchWithHistory(state, {
            selectedNodeId: clone.id,
            selectedNodeIds: [clone.id],
            nodes: [...state.nodes, clone],
          })
        }),
      duplicateSelectedNodes: () =>
        set((state) => {
          const selectedNodes = selectedNodesFromState(state)
          if (!selectedNodes.length) return {}

          const groupIdMap = new Map<string, string>()
          const clones = selectedNodes.map((node, index) => {
            const groupId = node.groupId
              ? groupIdMap.get(node.groupId) || (() => {
                  const nextGroupId = createGroupId()
                  groupIdMap.set(node.groupId || '', nextGroupId)
                  return nextGroupId
                })()
              : undefined

            return createNodeCopy(node, index, 28, { groupId })
          })

          return patchWithHistory(state, {
            selectedNodeId: clones[0]?.id,
            selectedNodeIds: clones.map((node) => node.id),
            nodes: [...state.nodes, ...clones],
          })
        }),
      groupSelectedNodes: () =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (selectedNodeIds.length < 2) return {}

          const groupId = createGroupId()
          const selectedSet = new Set(selectedNodeIds)
          const nodes = state.nodes.map((node) => (selectedSet.has(node.id) ? { ...node, groupId } : node))

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
        }),
      ungroupSelectedNodes: () =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (!selectedNodeIds.length) return {}

          const selectedNodes = state.nodes.filter((node) => selectedNodeIds.includes(node.id))
          const groupIds = new Set(selectedNodes.map((node) => node.groupId).filter(Boolean))
          if (!groupIds.size) return {}

          const nodes = state.nodes.map((node) =>
            node.groupId && groupIds.has(node.groupId) ? { ...node, groupId: undefined } : node,
          )
          const nextSelectedNodeIds = nodes
            .filter((node) => !node.hidden && selectedNodeIds.includes(node.id))
            .map((node) => node.id)

          return patchWithHistory(state, {
            nodes,
            selectedNodeId: nextSelectedNodeIds[0],
            selectedNodeIds: nextSelectedNodeIds,
          })
        }),
      moveNodeLayer: (nodeId, move) =>
        set((state) => {
          const index = state.nodes.findIndex((node) => node.id === nodeId)
          if (index < 0) return {}
          if (isEffectivelyLocked(state.nodes, state.nodes[index])) return {}

          const nodes = [...state.nodes]
          const [node] = nodes.splice(index, 1)
          const nextIndex =
            move === 'front'
              ? nodes.length
              : move === 'back'
                ? 0
                : move === 'forward'
                  ? Math.min(index + 1, nodes.length)
                  : Math.max(index - 1, 0)

          nodes.splice(nextIndex, 0, node)

          return patchWithHistory(state, {
            selectedNodeId: nodeId,
            selectedNodeIds: state.selectedNodeIds.includes(nodeId) ? state.selectedNodeIds : [nodeId],
            nodes,
          })
        }),
      moveSelectedLayer: (move) =>
        set((state) => {
          const lockedNodeIds = new Set(
            state.nodes.filter((node) => isEffectivelyLocked(state.nodes, node)).map((node) => node.id),
          )
          const selectedNodeIds = selectedIdsFromState(state).filter((nodeId) => !lockedNodeIds.has(nodeId))
          if (!selectedNodeIds.length) return {}

          const selectedSet = new Set(selectedNodeIds)
          let nodes = [...state.nodes]

          if (move === 'front') {
            nodes = [...nodes.filter((node) => !selectedSet.has(node.id)), ...nodes.filter((node) => selectedSet.has(node.id))]
          } else if (move === 'back') {
            nodes = [...nodes.filter((node) => selectedSet.has(node.id)), ...nodes.filter((node) => !selectedSet.has(node.id))]
          } else if (move === 'forward') {
            for (let index = nodes.length - 2; index >= 0; index -= 1) {
              if (selectedSet.has(nodes[index].id) && !selectedSet.has(nodes[index + 1].id)) {
                const current = nodes[index]
                nodes[index] = nodes[index + 1]
                nodes[index + 1] = current
              }
            }
          } else {
            for (let index = 1; index < nodes.length; index += 1) {
              if (selectedSet.has(nodes[index].id) && !selectedSet.has(nodes[index - 1].id)) {
                const current = nodes[index]
                nodes[index] = nodes[index - 1]
                nodes[index - 1] = current
              }
            }
          }

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
        }),
      deleteNode: (nodeId) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId)
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const deletedIds = new Set([
            nodeId,
            ...(isSectionNode(target) ? state.nodes.filter((node) => node.sectionId === nodeId).map((node) => node.id) : []),
          ])
          const selectedNodeIds = state.selectedNodeIds.filter((id) => !deletedIds.has(id))

          return patchWithHistory(state, {
            selectedNodeId: deletedIds.has(state.selectedNodeId || '') ? selectedNodeIds[0] : state.selectedNodeId,
            selectedNodeIds,
            nodes: normalizeCanvasNodes(state.nodes.filter((node) => !deletedIds.has(node.id))),
            edges: state.edges.filter((edge) => !deletedIds.has(edge.from) && !deletedIds.has(edge.to)),
          })
        }),
      deleteSelectedNodes: () =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (!selectedNodeIds.length) return {}

          const selectedSet = new Set(
            selectedNodeIds.filter((nodeId) => {
              const node = state.nodes.find((item) => item.id === nodeId)
              return node && !isEffectivelyLocked(state.nodes, node)
            }),
          )
          state.nodes.forEach((node) => {
            if (selectedSet.has(node.id) && isSectionNode(node)) {
              state.nodes
                .filter((child) => child.sectionId === node.id && !isEffectivelyLocked(state.nodes, child))
                .forEach((child) => selectedSet.add(child.id))
            }
          })
          if (!selectedSet.size) return {}

          return patchWithHistory(state, {
            selectedNodeId: undefined,
            selectedNodeIds: [],
            nodes: normalizeCanvasNodes(state.nodes.filter((node) => !selectedSet.has(node.id))),
            edges: state.edges.filter((edge) => !selectedSet.has(edge.from) && !selectedSet.has(edge.to)),
          })
        }),
      toggleSelectedNodesLocked: () =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (!selectedNodeIds.length) return {}

          const selectedSet = new Set(selectedNodeIds)
          const selectedNodes = state.nodes.filter((node) => selectedSet.has(node.id))
          const shouldLock = selectedNodes.some((node) => !node.locked)
          const nodes = state.nodes.map((node) =>
            selectedSet.has(node.id) ? { ...node, locked: shouldLock } : node,
          )

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
        }),
      hideSelectedNodes: () =>
        set((state) => {
          const selectedNodeIds = selectedIdsFromState(state)
          if (!selectedNodeIds.length) return {}

          const selectedSet = new Set(selectedNodeIds)
          state.nodes.forEach((node) => {
            if (selectedSet.has(node.id) && isSectionNode(node)) {
              state.nodes.filter((child) => child.sectionId === node.id).forEach((child) => selectedSet.add(child.id))
            }
          })
          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) => (selectedSet.has(node.id) ? { ...node, hidden: true } : node)),
          )

          return patchWithHistory(state, {
            nodes,
            selectedNodeId: undefined,
            selectedNodeIds: [],
          })
        }),
      showAllHiddenNodes: () =>
        set((state) => {
          if (!state.nodes.some((node) => node.hidden)) return {}

          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) => (node.hidden ? { ...node, hidden: undefined } : node)),
          )

          return patchWithHistory(state, { nodes })
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

            if (alignment === 'left') return { ...node, x: Math.round(minX) }
            if (alignment === 'center') return { ...node, x: Math.round(centerX - node.width / 2) }
            if (alignment === 'right') return { ...node, x: Math.round(maxX - node.width) }
            if (alignment === 'top') return { ...node, y: Math.round(minY) }
            if (alignment === 'middle') return { ...node, y: Math.round(centerY - node.height / 2) }
            return { ...node, y: Math.round(maxY - node.height) }
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
            return axis === 'horizontal' ? { ...node, x: position } : { ...node, y: position }
          })

          return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
        }),
      copySelectedNodes: () =>
        set((state) => {
          const selectedNodes = selectedNodesFromState(state)
          if (!selectedNodes.length) return {}

          return { clipboardNodes: cloneNodes(selectedNodes), clipboardAssets: [] }
        }),
      pasteClipboardNodes: (position) =>
        set((state) => {
          if (!state.clipboardNodes.length) return {}

          const groupIdMap = new Map<string, string>()
          const clones = state.clipboardNodes.map((node, index) => {
            const groupId = node.groupId
              ? groupIdMap.get(node.groupId) || (() => {
                  const nextGroupId = createGroupId()
                  groupIdMap.set(node.groupId || '', nextGroupId)
                  return nextGroupId
                })()
              : undefined

            return createNodeCopy(node, index, 36, { groupId })
          })
          const nextClones = position
            ? (() => {
                const minX = Math.min(...clones.map((node) => node.x))
                const maxX = Math.max(...clones.map((node) => node.x + node.width))
                const minY = Math.min(...clones.map((node) => node.y))
                const maxY = Math.max(...clones.map((node) => node.y + node.height))
                const dx = Math.round(position.x - (minX + (maxX - minX) / 2))
                const dy = Math.round(position.y - (minY + (maxY - minY) / 2))

                return clones.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy }))
              })()
            : clones

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
      addImportedImage: (assetUrl, title = 'Imported Image', size = 'source', position, metadata) => {
        get().addImportedFileNode('image', assetUrl, title, size, position, metadata)
      },
      addImportedFileNode: (type, assetUrl, title, size = 'source', position, metadata) => {
        const id = createNodeId('imported')
        const displaySize = importedAssetDisplaySize(type, metadata)
        const markdownDisplayMode =
          type === 'markdown' && markdownShouldUsePreviewMode(metadata?.text) ? 'preview' : 'full'
        const nodeTitle =
          title?.trim() ||
          metadata?.originalName?.replace(/\.[^.]+$/, '') ||
          (type === 'markdown' ? 'Markdown document' : type === 'pdf' ? 'PDF document' : type === 'video' ? 'Video file' : 'Imported Image')
        set((state) =>
          patchWithHistory(state, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: [
              ...state.nodes,
              makeNode({
                id,
                type,
                title: nodeTitle,
                text: type === 'markdown' ? metadata?.text || '' : undefined,
                x: Math.round(position?.x ?? -64 + state.nodes.length * 16),
                y: Math.round(position?.y ?? -64 + state.nodes.length * 16),
                width: displaySize.width,
                height: displaySize.height,
                assetUrl,
                assetMimeType: metadata?.mimeType,
                assetOriginalName: metadata?.originalName,
                assetSizeBytes: metadata?.sizeBytes,
                markdownDisplayMode: type === 'markdown' ? markdownDisplayMode : undefined,
                imageHasTransparency: type === 'image' ? metadata?.hasTransparency : undefined,
                generation:
                  type === 'markdown'
                    ? undefined
                    : {
                        prompt: importedAssetPromptFor(type),
                        model: importedAssetModelFor(type),
                        size,
                        seed: Date.now() % 99999,
                      },
              }),
            ],
          }),
        )
      },
      cropImageNode: (nodeId, box) =>
        set((state) => {
          const source = state.nodes.find((node) => node.id === nodeId && node.type === 'image')
          if (!source) return {}

          const sourceWidth = Math.max(1, source.width)
          const sourceHeight = Math.max(1, source.height)
          const cropBox = {
            x: clamp(box.x, 0, sourceWidth - 1),
            y: clamp(box.y, 0, sourceHeight - 1),
            width: clamp(box.width, 1, sourceWidth),
            height: clamp(box.height, 1, sourceHeight),
          }
          cropBox.width = Math.min(cropBox.width, sourceWidth - cropBox.x)
          cropBox.height = Math.min(cropBox.height, sourceHeight - cropBox.y)

          const currentCrop = source.imageCrop || { x: 0, y: 0, width: 1, height: 1 }
          const nextCrop = {
            x: clamp(currentCrop.x + (cropBox.x / sourceWidth) * currentCrop.width, 0, 1),
            y: clamp(currentCrop.y + (cropBox.y / sourceHeight) * currentCrop.height, 0, 1),
            width: clamp((cropBox.width / sourceWidth) * currentCrop.width, 0.001, 1),
            height: clamp((cropBox.height / sourceHeight) * currentCrop.height, 0.001, 1),
          }
          nextCrop.width = Math.min(nextCrop.width, 1 - nextCrop.x)
          nextCrop.height = Math.min(nextCrop.height, 1 - nextCrop.y)

          const nodes = state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  x: Math.round(node.x + cropBox.x),
                  y: Math.round(node.y + cropBox.y),
                  width: Math.round(cropBox.width),
                  height: Math.round(cropBox.height),
                  imageCrop: cropEqualsFullImage(nextCrop) ? undefined : nextCrop,
                }
              : node,
          )

          return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      addFrameNode: (position, size, title) => {
        const id = createNodeId('frame')
        const defaultSize = defaultSizeForNodeType('frame')

        set((state) => {
          const frameCount = state.nodes.filter((node) => node.type === 'frame').length
          const frame = makeNode({
            id,
            type: 'frame',
            title: title || `Section ${frameCount + 1}`,
            x: Math.round(position.x),
            y: Math.round(position.y),
            width: Math.round(size?.width ?? defaultSize.width),
            height: Math.round(size?.height ?? defaultSize.height),
            frameColor: '#6957e8',
            sectionFillColor: defaultSectionFillColor,
            sectionBorderColor: defaultSectionBorderColor,
            sectionBorderWidth: defaultSectionBorderWidth,
            sectionBorderStyle: defaultSectionBorderStyle,
            sectionTitleVisible: true,
          })

          return patchWithHistory(state, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: normalizeCanvasNodes(withFrameBehindArtwork(state.nodes, frame)),
          })
        })

        return id
      },
      addAiSlotNode: (position, size, prompt, options) => {
        const targetSceneId = options?.sceneId || get().sceneId
        const targetDocument = get().canvases[targetSceneId]
        if (!targetDocument) throw new Error('目标画布已删除，无法继续生成。')

        const id = createNodeId('ai-slot')
        const defaultSize = defaultSizeForNodeType('ai-slot')
        const width = Math.round(size?.width ?? defaultSize.width)
        const height = Math.round(size?.height ?? defaultSize.height)
        const createdAt = Date.now()
        const slotPrompt = prompt?.trim() || '等待 AI 生成的画布槽位'

        set((state) => {
          const document = state.canvases[targetSceneId]
          if (!document) return {}

          const slotCount = document.nodes.filter((node) => node.type === 'ai-slot').length
          const slot = makeNode({
            id,
            type: 'ai-slot',
            title: `AI Slot ${slotCount + 1}`,
            x: Math.round(position.x),
            y: Math.round(position.y),
            width,
            height,
            status: 'ready',
            generation: {
              prompt: slotPrompt,
              model: 'Mivo Mock Image Workflow',
              size: `${width}x${height}`,
              seed: createdAt % 99999,
            },
            aiWorkflow: {
              kind: 'slot',
              status: 'empty',
              operation: 'slot-generation',
              prompt: slotPrompt,
              placement: 'slot',
              createdAt,
            },
          })

          return patchCanvasDocument(state, targetSceneId, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: normalizeCanvasNodes([...document.nodes, slot]),
          }, { history: true })
        })

        return id
      },
      addAnnotationNode: (sourceNodeId, position, instruction, options) => {
        const id = createNodeId('annotation')
        const defaultSize = defaultSizeForNodeType('annotation')
        const createdAt = Date.now()
        let created = false

        set((state) => {
          const source =
            state.nodes.find((node) => node.id === sourceNodeId && !node.hidden) ||
            state.nodes.find((node) => node.id === state.selectedNodeId && !node.hidden)
          if (!source) return {}

          const note = instruction?.trim() || 'Describe the image edit here'
          const x = Math.round(position?.x ?? source.x + 28)
          const y = Math.round(position?.y ?? source.y - 132)
          const annotation = makeNode({
            id,
            type: 'annotation',
            title: options?.title || `Edit note for ${source.title}`,
            text: note,
            fontSize: 18,
            textColor: '#4f4548',
            fontWeight: 720,
            textAlign: 'left',
            textAutoWidth: false,
            x,
            y,
            width: defaultSize.width,
            height: defaultSize.height,
            status: 'ready',
            parentIds: [source.id],
            generation: {
              prompt: note,
              model: 'Annotation brief',
              size: 'canvas-note',
              seed: createdAt % 99999,
            },
            aiWorkflow: {
              kind: 'annotation',
              status: 'ready',
              operation: options?.operation || 'annotation-edit',
              prompt: note,
              sourceNodeIds: [source.id],
              anchorNodeId: source.id,
              createdAt,
            },
          })
          created = true

          return patchWithHistory(state, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: normalizeCanvasNodes([...state.nodes, annotation]),
          })
        })

        return created ? id : undefined
      },
      addMarkupNode: (kind, position, geometry, options) => {
        const id = createNodeId('markup')
        const defaultSize = defaultSizeForNodeType('markup')
        const width = Math.max(18, Math.round(geometry?.width ?? defaultSize.width))
        const height = Math.max(18, Math.round(geometry?.height ?? defaultSize.height))
        const title =
          kind === 'arrow'
            ? 'Arrow annotation'
            : kind === 'line'
              ? 'Line annotation'
              : kind === 'rect'
                ? 'Rectangle annotation'
                : kind === 'ellipse'
                  ? 'Ellipse annotation'
                  : kind === 'brush'
                    ? 'Brush annotation'
                    : 'Markup note'

        set((state) => {
          const draft = makeNode({
            id,
            type: 'markup',
            title,
            text: options?.text || (kind === 'note' ? 'Note' : undefined),
            fontSize: kind === 'note' ? 18 : defaultTextFontSize,
            textColor: defaultTextColor,
            fontWeight: kind === 'note' ? 760 : defaultTextWeight,
            textAlign: kind === 'note' ? defaultTextAlign : 'center',
            textAutoWidth: false,
            x: Math.round(position.x),
            y: Math.round(position.y),
            width,
            height,
            status: 'ready',
            markupKind: kind,
            markupPoints: options?.points?.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
            markupStrokeColor: options?.strokeColor || defaultMarkupStrokeColor,
            markupFillColor: options?.fillColor || (kind === 'note' ? '#fff1a8' : defaultMarkupFillColor),
            markupStrokeWidth: options?.strokeWidth || defaultMarkupStrokeWidth,
            markupStrokeStyle: options?.strokeStyle || 'solid',
            markupOpacity: 1,
            markupStartArrow: options?.startArrow ?? false,
            markupEndArrow: options?.endArrow ?? kind === 'arrow',
            markupCornerRadius: 4,
            connectorStart: options?.connectorStart,
            connectorEnd: options?.connectorEnd,
            generation: {
              prompt: options?.text || title,
              model: 'Canvas markup',
              size: `${width}x${height}`,
              seed: Date.now() % 99999,
            },
          })
          const targetNodeId = targetNodeIdForMarkup(state.nodes, draft)
          const markup = targetNodeId ? { ...draft, targetNodeId, parentIds: [targetNodeId] } : draft

          return patchWithHistory(state, {
            selectedNodeId: options?.select === false ? state.selectedNodeId : id,
            selectedNodeIds: options?.select === false ? state.selectedNodeIds : [id],
            nodes: normalizeCanvasNodes([...state.nodes, markup]),
          })
        })

        return id
      },
      updateMarkupGeometry: (nodeId, geometry, points, bindings) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markup')
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nodes = normalizeCanvasNodes(
            state.nodes.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    x: Math.round(geometry.x),
                    y: Math.round(geometry.y),
                    width: Math.round(geometry.width),
                    height: Math.round(geometry.height),
                    markupPoints: points?.map((point) => ({
                      x: Math.round(point.x),
                      y: Math.round(point.y),
                    })),
                    ...(bindings && 'connectorStart' in bindings
                      ? { connectorStart: bindings.connectorStart || undefined }
                      : {}),
                    ...(bindings && 'connectorEnd' in bindings
                      ? { connectorEnd: bindings.connectorEnd || undefined }
                      : {}),
                  }
                : node,
            ),
          )

          return patchActiveCanvas(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      updateMarkupStyle: (nodeId, style) =>
        set((state) => {
          const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markup')
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nodes = state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  ...style,
                }
              : node,
          )
          return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      updateSectionStyle: (nodeId, style) =>
        set((state) => {
          const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
          if (!section || section.locked) return {}

          const nodes = state.nodes.map((node) => (node.id === nodeId ? { ...node, ...style } : node))
          return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      setSectionLockMode: (nodeId, mode) =>
        set((state) => {
          const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
          if (!section) return {}

          const nodes = state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  locked: Boolean(mode),
                  sectionLockMode: mode,
                }
              : node,
          )
          return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      removeSectionOnly: (nodeId) =>
        set((state) => {
          const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
          if (!section || isEffectivelyLocked(state.nodes, section)) return {}

          const nodes = state.nodes
            .filter((node) => node.id !== nodeId)
            .map((node) => (node.sectionId === nodeId ? { ...node, sectionId: undefined } : node))

          return patchWithHistory(state, {
            nodes,
            selectedNodeId: undefined,
            selectedNodeIds: [],
          })
        }),
      renameNode: (nodeId, title) =>
        set((state) => {
          const nextTitle = title.trim()
          if (!nextTitle) return {}
          const target = state.nodes.find((node) => node.id === nodeId)
          if (!target || isEffectivelyLocked(state.nodes, target)) return {}

          const nodes = state.nodes.map((node) => (node.id === nodeId ? { ...node, title: nextTitle } : node))
          return patchWithHistory(state, { nodes })
        }),
      addTextNode: (position, text = '') => {
        const id = `text-${Date.now()}`
        const defaultSize = defaultSizeForNodeType('text')

        set((state) =>
          patchWithHistory(state, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: [
              ...state.nodes,
              makeNode({
                id,
                type: 'text',
                title: text.trim() || 'Text',
                text,
                fontSize: defaultTextFontSize,
                textColor: defaultTextColor,
                fontWeight: defaultTextWeight,
                textAlign: defaultTextAlign,
                textAutoWidth: true,
                x: Math.round(position.x),
                y: Math.round(position.y),
                width: defaultSize.width,
                height: defaultSize.height,
              }),
            ],
          }),
        )

        return id
      },
      updateTextNode: (nodeId, text, geometry) =>
        set((state) => {
          const nodes = state.nodes.map((node) =>
            node.id === nodeId && isEditableTextNode(node)
              ? {
                  ...node,
                  title: node.type === 'markup' ? node.title : text.trim() || 'Text',
                  text,
                  width: geometry && node.type !== 'markup' ? Math.round(geometry.width) : node.width,
                  height: geometry && node.type !== 'markup' ? Math.round(geometry.height) : node.height,
                  generation:
                    node.type === 'markup' && node.generation
                      ? {
                          ...node.generation,
                          prompt: text.trim() || node.title,
                        }
                      : node.generation,
                }
              : node,
          )

          return patchActiveCanvas(state, { nodes })
        }),
      updateTextStyle: (nodeId, style, geometry) =>
        set((state) => {
          const nodes = state.nodes.map((node) =>
            node.id === nodeId && isEditableTextNode(node)
              ? {
                  ...node,
                  ...style,
                  width: geometry && node.type !== 'markup' ? Math.round(geometry.width) : node.width,
                  height: geometry && node.type !== 'markup' ? Math.round(geometry.height) : node.height,
                }
              : node,
          )

          return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      resizeTextNode: (nodeId, x, width, height) =>
        set((state) => {
          const nodes = state.nodes.map((node) =>
            node.id === nodeId && isEditableTextNode(node)
              ? {
                  ...node,
                  x: Math.round(x),
                  width: Math.round(width),
                  height: Math.round(height),
                  textAutoWidth: false,
                }
              : node,
          )

          return patchActiveCanvas(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
        }),
      commitGenerationResult: async (payload) => {
        const prompt = payload.prompt.trim()
        if (!prompt) throw new Error('Prompt is required')
        if (!payload.resultImages.length) throw new Error('No generated images returned')
        const targetSceneId = payload.sceneId || get().sceneId

        const initialState = get()
        const initialDocument = initialState.canvases[targetSceneId]
        if (!initialDocument) throw new Error('目标画布已删除，无法继续生成。')
        const source = payload.sourceNodeId
          ? initialDocument.nodes.find((node) => node.id === payload.sourceNodeId && !node.hidden)
          : undefined
        if (payload.sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')

        const createdAt = Date.now()
        const savedImages = await Promise.all(
          payload.resultImages.map(async (image, index) => {
            const blob = blobFromCommittedGenerationImage(image)
            const extension = blob.type === 'image/jpeg' || blob.type === 'image/jpg' ? 'jpg' : 'png'
            const name = image.title?.trim() || `mivo-${payload.kind}-${createdAt}-${index + 1}.${extension}`
            const asset = await saveGeneratedAsset(blob, name, image.mimeType || blob.type || 'image/png')
            return { image, asset }
          }),
        )

        const createdNodeIds: string[] = []

        const currentState = get()
        const currentDocument = currentState.canvases[targetSceneId]
        if (!currentDocument) throw new Error('目标画布已删除，无法继续生成。')
        if (
          payload.sourceNodeId &&
          !currentDocument.nodes.find((node) => node.id === payload.sourceNodeId && !node.hidden)
        ) {
          throw new Error('源节点已删除，无法继续生成。')
        }

        set((state) => {
          const targetDocument = state.canvases[targetSceneId]
          if (!targetDocument) return {}

          const currentSource = payload.sourceNodeId
            ? targetDocument.nodes.find((node) => node.id === payload.sourceNodeId && !node.hidden)
            : undefined
          if (payload.sourceNodeId && !currentSource) return {}

          let nextNodes = targetDocument.nodes.filter((node) => !isDerivationEdgeNode(node))
          const nextEdges = cloneEdges(targetDocument.edges || [])
          const newNodes: MivoCanvasNode[] = []
          const newEdges: CanvasEdge[] = []

          savedImages.forEach(({ image, asset }, index) => {
            const fallbackSize = currentSource
              ? { width: currentSource.width, height: currentSource.height }
              : {
                  width: image.width || defaultSizeForNodeType('image').width,
                  height: image.height || defaultSizeForNodeType('image').height,
                }
            const displaySize = displaySizeForGeneratedAsset(asset, fallbackSize)
            const placement = currentSource
              ? chooseAdjacentPlacement({
                  nodes: nextNodes,
                  anchor: currentSource,
                  width: displaySize.width,
                  height: displaySize.height,
                  placement: payload.placement || 'right',
                })
              : { x: index * 36, y: index * 36 }
            const nodeId = createNodeId(`${payload.kind}-result`)
            const taskId = payload.taskId || `task-${nodeId}`
            const operation: AiWorkflowOperation =
              payload.kind === 'edit'
                ? 'area-edit'
                : currentSource?.type === 'ai-slot'
                  ? 'slot-generation'
                  : 'beside-generation'
            const resultNode = makeNode({
              id: nodeId,
              type: 'image',
              title: image.title?.trim() || `Generated image ${index + 1}`,
              x: Math.round(placement.x),
              y: Math.round(placement.y),
              width: Math.round(displaySize.width),
              height: Math.round(displaySize.height),
              assetUrl: asset.assetUrl,
              assetMimeType: asset.type,
              assetOriginalName: asset.name,
              assetSizeBytes: asset.sizeBytes,
              imageHasTransparency: asset.hasTransparency,
              status: 'ready',
              parentIds: currentSource ? [currentSource.id] : undefined,
              sourceNodeId: currentSource?.id,
              generation: {
                prompt,
                model: payload.model,
                size: asset.size,
                taskId,
                createdAt,
                maskBounds: cloneMaskBounds(payload.maskBounds),
              },
              aiWorkflow: {
                kind: 'result',
                status: 'ready',
                operation,
                prompt,
                sourceNodeIds: currentSource ? [currentSource.id] : undefined,
                anchorNodeId: currentSource?.id,
                slotId: currentSource?.type === 'ai-slot' ? currentSource.id : undefined,
                placement: payload.placement || 'right',
                createdAt,
              },
            })

            createdNodeIds.push(nodeId)
            newNodes.push(resultNode)
            nextNodes = [...nextNodes, resultNode]

            if (currentSource && payload.createDerivationEdge !== false) {
              newEdges.push({
                id: createEdgeId(),
                from: currentSource.id,
                to: nodeId,
                type: payload.kind,
                prompt,
                createdAt,
              })
            }
          })

          nextEdges.push(...newEdges)

          return patchCanvasDocument(state, targetSceneId, {
            selectedNodeId: createdNodeIds[0],
            selectedNodeIds: createdNodeIds,
            nodes: nextNodes,
            edges: nextEdges,
          }, { history: true })
        })

        return createdNodeIds
      },
      generateVariations: (sourceNodeId) => {
        const state = get()
        const source =
          state.nodes.find((node) => node.id === sourceNodeId) ||
          state.nodes.find((node) => node.id === state.selectedNodeId) ||
          state.nodes[0]

        if (!source) return

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
          if (!annotation) return {}

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
          const result = makeNode({
            id,
            type: 'image',
            title: `Edited from ${source?.title || annotation.title}`,
            x: Math.round(placement.x),
            y: Math.round(placement.y),
            width: Math.round(width),
            height: Math.round(height),
            assetUrl: mockResultAssetUrl(state.nodes),
            status: 'ready',
            parentIds: source ? [source.id, annotation.id] : [annotation.id],
            sourceNodeId: anchor.id,
            generation: {
              prompt: resultPrompt,
              model: 'Mivo Mock Image Workflow',
              size: `${Math.round(width)}x${Math.round(height)}`,
              seed: createdAt % 99999,
              strength: 0.66,
              taskId: `task-${id}`,
              createdAt,
            },
            aiWorkflow: {
              kind: 'result',
              status: 'ready',
              operation: 'annotation-edit',
              prompt: resultPrompt,
              sourceNodeIds: source ? [source.id] : [annotation.id],
              annotationNodeId: annotation.id,
              anchorNodeId: anchor.id,
              placement: 'right',
              createdAt,
            },
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

          return patchWithHistory(state, {
            selectedNodeId: id,
            selectedNodeIds: [id],
            nodes: normalizeCanvasNodes([...state.nodes, result]),
            edges: [...state.edges, edge],
            tasks: [task, ...state.tasks].slice(0, 5),
          })
        })
      },
      toggleFavorite: (nodeId) =>
        set((state) => {
          const nodes = state.nodes.map((node) =>
            node.id === nodeId ? { ...node, favorited: !node.favorited } : node,
          )

          return patchWithHistory(state, { nodes })
        }),
      updatePrompt: (nodeId, prompt) =>
        set((state) => {
          const nodes = state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  generation: {
                    prompt,
                    model: node.generation?.model || 'Mivo Character v3',
                    size: node.generation?.size || '1024x1365',
                    seed: node.generation?.seed || 0,
                    strength: node.generation?.strength,
                    taskId: node.generation?.taskId,
                  },
                }
              : node,
          )

          return patchActiveCanvas(state, { nodes })
        }),
      resetCurrentScene: () =>
        set((state) => {
          const document = sceneIds.has(state.sceneId as DemoSceneId)
            ? canvasDocumentFromScene(state.sceneId as DemoSceneId)
            : createBlankDocument(documentFor(state.canvases, state.sceneId).title)

          return {
            ...remember(state),
            nodes: document.nodes,
            edges: document.edges || [],
            tasks: document.tasks,
            selectedNodeId: document.selectedNodeId,
            selectedNodeIds: document.selectedNodeIds || [],
            activeTool: 'select',
            canvases: {
              ...state.canvases,
              [state.sceneId]: document,
            },
          }
        }),
      replaceSnapshot: (snapshot) =>
        set((state) => ({
          ...applySnapshot(state, snapshot),
          historyPast: [],
          historyFuture: [],
        })),
      getSnapshot: () => snapshotFromState(get()),
      getAiContextSnapshot: () => {
        const state = get()
        return buildAiContextSnapshot({
          sceneId: state.sceneId,
          nodes: state.nodes,
          edges: state.edges,
          selectedNodeId: state.selectedNodeId,
          selectedNodeIds: state.selectedNodeIds,
        })
      },
    }),
    {
      name: 'mivo-canvas-demo',
      version: 8,
      migrate: migratePersistedState,
      partialize: (state) => ({
        canvases: state.canvases,
        nodes: state.nodes,
        edges: state.edges,
        tasks: state.tasks,
        sceneId: state.sceneId,
        selectedNodeId: state.selectedNodeId,
        selectedNodeIds: state.selectedNodeIds,
        activeTool: state.activeTool,
      }),
    },
  ),
)
