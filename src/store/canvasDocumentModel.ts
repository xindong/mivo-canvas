import type {
  CanvasAssetNodeType,
  CanvasDocument,
  CanvasEdge,
  CanvasId,
  DemoSceneId,
  MarkupPoint,
  MivoCanvasNode,
  MivoCanvasSnapshot,
  SectionBorderStyle,
  ToolId,
} from '../types/mivoCanvas'
import type { BrushStyle, CanvasState, SelectionArrangeMode } from './canvasStore'
import type { CanvasAssetClipboardItem } from '../app/assetLibraryModel'
import { connectorBindingPointFor, isConnectorNode } from '../canvas/connectorGeometry'
import { defaultBrushWidth } from '../canvas/brushGeometry'
import { defaultSizeForNodeType } from '../canvas/nodeTypes/canvasNodeRegistry'
import {
  markdownDocumentWidth,
  markdownDocumentSizeFor,
  markdownPreviewHeight,
  markdownShouldUsePreviewMode,
  type ImportedFileMetadata,
} from '../lib/canvasAssetImport'
import { importedImageDisplaySize } from '../lib/imageSizing'
import { normalizeCanvasSnapshotV2 } from '../model/canvasSnapshotModel'
import { normalizeCanvasNodesV2, setNodeTransform } from '../model/documentModelV2'
import { scenes, snapshotFromScene } from './demoScenes'
import { pushHistory, snapshotFromState as buildHistorySnapshot, type HistoryCloneFns } from './historyManager'
import {
  cloneEdge,
  cloneEdges,
  cloneNode,
  cloneNodes,
  cloneTask,
  cloneTasks,
  createDerivationEdgeNode,
  isDerivationEdgeNode,
} from './nodeFactory'

export const sceneOptions = scenes()
export const sceneIds = new Set<DemoSceneId>(sceneOptions.map((scene) => scene.id))
export const sceneLabels = new Map(sceneOptions.map((scene) => [scene.id, scene.label]))

export const fallbackTitle = (sceneId: CanvasId) => sceneLabels.get(sceneId as DemoSceneId) || sceneId

// Inject the canvasStore clone helpers into the pure history functions (historyManager.ts),
// keeping this module the single source of truth for *how* nodes/edges/tasks are deep-cloned
// while historyManager owns the push/undo/redo/trim logic.
export const historyCloneFns: HistoryCloneFns = {
  cloneNode,
  cloneEdge,
  cloneTask,
}

// Phase 1 (C4): updatedAt bump hub. Documents carry createdAt/updatedAt (ISO).
// Content patches (nodes/edges/tasks/title) bump updatedAt; selection-only patches
// do not; an explicit bumpUpdatedAt:false covers high-frequency machine updates
// (mask-edit poll progress). Hydration/normalize backfill missing timestamps.
const nowIso = () => new Date().toISOString()

/** Subset of CanvasDocument a patch may carry. Declared at module top so the
 *  bump helpers below can reference it before the patch functions are defined. */
type CanvasDocumentPatch = Partial<
  Pick<CanvasDocument, 'nodes' | 'edges' | 'tasks' | 'selectedNodeId' | 'selectedNodeIds' | 'title'>
>

/** A patch is "content" if it changes nodes/edges/tasks/title (not just selection). */
const hasContentPatch = (patch: CanvasDocumentPatch) =>
  'nodes' in patch || 'edges' in patch || 'tasks' in patch || 'title' in patch

/** Bump on content patches unless the caller explicitly opts out (mask-edit progress). */
const shouldBumpUpdatedAt = (patch: CanvasDocumentPatch, bumpUpdatedAt?: boolean) =>
  bumpUpdatedAt !== false && hasContentPatch(patch)

export const compactNodeForPersist = (node: MivoCanvasNode): MivoCanvasNode => {
  const compactNode = cloneNode(node)
  const transform = compactNode.transform
  const rotation = transform?.rotation ?? 0

  delete compactNode.asset
  delete compactNode.fills
  delete compactNode.relations
  delete compactNode.strokes
  delete compactNode.transform

  return {
    ...compactNode,
    ...(Math.abs(rotation) > 0.0001 ? { transform } : {}),
  }
}

export const compactDocumentForPersist = (document: CanvasDocument): CanvasDocument => ({
  ...document,
  nodes: document.nodes.map(compactNodeForPersist),
  tasks: cloneTasks(document.tasks),
  selectedNodeIds: document.selectedNodeIds ? [...document.selectedNodeIds] : undefined,
})

export const compactCanvasesForPersist = (canvases: Record<CanvasId, CanvasDocument>) =>
  Object.fromEntries(
    Object.entries(canvases).map(([canvasId, document]) => [canvasId, compactDocumentForPersist(document)]),
  ) as Record<CanvasId, CanvasDocument>

export const normalizeSelection = (nodeIds: string[] | undefined, nodes: MivoCanvasNode[]) => {
  const validIds = new Set(nodes.filter((node) => !node.hidden).map((node) => node.id))
  return Array.from(new Set(nodeIds || [])).filter((nodeId) => validIds.has(nodeId))
}

export const selectionFrom = (nodeIds: string[] | undefined, selectedNodeId: string | undefined, nodes: MivoCanvasNode[]) => {
  const selection = normalizeSelection(nodeIds?.length ? nodeIds : selectedNodeId ? [selectedNodeId] : [], nodes)
  const primary = selectedNodeId && selection.includes(selectedNodeId) ? selectedNodeId : selection[0]

  return { selectedNodeId: primary, selectedNodeIds: selection }
}

export const snapshotFromState = (
  state: Parameters<typeof buildHistorySnapshot>[0],
) => buildHistorySnapshot(state, historyCloneFns)

export const remember = (state: CanvasState) => pushHistory(state, historyCloneFns)

export const defaultSectionFillColor = '#ffffff'
export const defaultSectionBorderColor = '#ff8a00'
export const defaultSectionBorderWidth = 2
export const defaultSectionBorderStyle: SectionBorderStyle = 'dashed'
export const defaultMarkupStrokeColor = '#6957e8'
export const defaultMarkupFillColor = 'rgba(105, 87, 232, 0.08)'
export const defaultMarkupStrokeWidth = 3
export const defaultBrushColor = '#232323'
export const defaultBrushStyle: BrushStyle = {
  color: defaultBrushColor,
  width: defaultBrushWidth,
  kind: 'marker',
}

export const isSectionNode = (node: MivoCanvasNode) => node.type === 'frame'
export const isEditableTextNode = (node: MivoCanvasNode | undefined) =>
  node?.type === 'text' ||
  node?.type === 'annotation' ||
  (node?.type === 'markup' && node.markupKind !== 'stamp')

export const nodeCenter = (node: Pick<MivoCanvasNode, 'x' | 'y' | 'width' | 'height'>) => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2,
})

export const containsPoint = (section: MivoCanvasNode, point: { x: number; y: number }) =>
  point.x >= section.x &&
  point.x <= section.x + section.width &&
  point.y >= section.y &&
  point.y <= section.y + section.height

export const sectionForNode = (nodes: MivoCanvasNode[], node: MivoCanvasNode) =>
  node.sectionId ? nodes.find((item) => item.id === node.sectionId && isSectionNode(item)) : undefined

export const isEffectivelyLocked = (nodes: MivoCanvasNode[], node: MivoCanvasNode) => {
  const parentSection = sectionForNode(nodes, node)
  return Boolean(node.locked || parentSection?.sectionLockMode === 'all')
}

export const childIdsForSections = (nodes: MivoCanvasNode[], sectionIds: Set<string>) =>
  nodes.filter((node) => node.sectionId && sectionIds.has(node.sectionId)).map((node) => node.id)

export const sectionIdForNodeBounds = (nodes: MivoCanvasNode[], node: MivoCanvasNode) => {
  if (isSectionNode(node)) return undefined

  const center = nodeCenter(node)
  const sections = nodes.filter((item) => isSectionNode(item) && !item.hidden && containsPoint(item, center))
  return sections.at(-1)?.id
}

export const targetNodeIdForMarkup = (nodes: MivoCanvasNode[], markup: MivoCanvasNode) => {
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

export const normalizeSectionMembership = (nodes: MivoCanvasNode[]) =>
  nodes.map((node) => {
    if (isSectionNode(node) || node.hidden) return node

    const nextSectionId = sectionIdForNodeBounds(nodes, node)
    return nextSectionId === node.sectionId ? node : { ...node, sectionId: nextSectionId }
  })

export const defaultLineMarkupPointsFor = (node: MivoCanvasNode): MarkupPoint[] => [
  { x: Math.max(2, node.markupStrokeWidth || 3), y: Math.max(2, node.height - (node.markupStrokeWidth || 3)) },
  { x: Math.max(2, node.width - (node.markupStrokeWidth || 3)), y: Math.max(2, node.markupStrokeWidth || 3) },
]

export const lineMarkupPointsFor = (node: MivoCanvasNode): MarkupPoint[] =>
  node.markupPoints && node.markupPoints.length >= 2
    ? node.markupPoints.slice(0, 2).map((point) => ({ ...point }))
    : defaultLineMarkupPointsFor(node)

export const markupGeometryFromAbsolutePoints = (points: MarkupPoint[]) => {
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

export const normalizeConnectorMarkupNodes = (nodes: MivoCanvasNode[]) =>
  nodes.map((node) => {
    if (!isConnectorNode(node) || (!node.connectorStart && !node.connectorEnd)) return node

    const startBindingPoint = connectorBindingPointFor(nodes, node.connectorStart)
    const endBindingPoint = connectorBindingPointFor(nodes, node.connectorEnd)
    const points = lineMarkupPointsFor(node)
    const absolutePoints = points.map((point) => ({ x: node.x + point.x, y: node.y + point.y }))
    if (startBindingPoint) absolutePoints[0] = startBindingPoint
    if (endBindingPoint) absolutePoints[1] = endBindingPoint

    const next = markupGeometryFromAbsolutePoints(absolutePoints)
    return setNodeTransform({
      ...node,
      markupPoints: next.points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
      connectorStart: startBindingPoint ? node.connectorStart : undefined,
      connectorEnd: endBindingPoint ? node.connectorEnd : undefined,
    }, {
      x: Math.round(next.geometry.x),
      y: Math.round(next.geometry.y),
      width: Math.round(next.geometry.width),
      height: Math.round(next.geometry.height),
    })
  })

export const syncDerivationEdgeNodes = (nodes: MivoCanvasNode[], edges: CanvasEdge[]) => {
  const contentNodes = nodes.filter((node) => !isDerivationEdgeNode(node))
  const contentIds = new Set(contentNodes.filter((node) => !node.hidden).map((node) => node.id))
  const edgeNodes = edges
    .filter((edge) => contentIds.has(edge.from) && contentIds.has(edge.to))
    .map((edge) => createDerivationEdgeNode(edge, contentNodes))
    .filter((node): node is MivoCanvasNode => Boolean(node))

  return [...contentNodes, ...edgeNodes]
}

export const normalizeCanvasNodes = (nodes: MivoCanvasNode[]) =>
  normalizeCanvasNodesV2(normalizeConnectorMarkupNodes(normalizeSectionMembership(nodes)))

export const normalizeCanvasGraph = (nodes: MivoCanvasNode[], edges: CanvasEdge[] = []) =>
  normalizeCanvasNodes(syncDerivationEdgeNodes(nodes, edges))

export const normalizeLongMarkdownPreviewNodes = (nodes: MivoCanvasNode[]) =>
  nodes.map((node) => {
    if (node.type !== 'markdown' || !markdownShouldUsePreviewMode(node.text)) return node

    return {
      ...node,
      markdownDisplayMode: 'preview' as const,
      width: markdownDocumentWidth,
      height: markdownPreviewHeight,
    }
  })

export const createBlankDocument = (title = 'Untitled Canvas', projectId?: string): CanvasDocument => {
  const now = nowIso()
  return {
    title,
    projectId,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    tasks: [],
    selectedNodeId: undefined,
    selectedNodeIds: [],
  }
}

export const canvasDocumentFromScene = (sceneId: DemoSceneId): CanvasDocument => {
  const snapshot = snapshotFromScene(sceneId)
  const selection = selectionFrom(snapshot.selectedNodeIds, snapshot.selectedNodeId, snapshot.nodes)
  const now = nowIso()

  return {
    title: fallbackTitle(sceneId),
    sourceTemplateId: sceneId,
    createdAt: now,
    updatedAt: now,
    nodes: normalizeCanvasGraph(cloneNodes(snapshot.nodes), snapshot.edges || []),
    edges: cloneEdges(snapshot.edges || []),
    tasks: cloneTasks(snapshot.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }
}

export const initialCanvases = () =>
  Object.fromEntries(sceneOptions.map((scene) => [scene.id, canvasDocumentFromScene(scene.id)])) as Record<
    CanvasId,
    CanvasDocument
  >

export const documentFor = (canvases: Record<CanvasId, CanvasDocument>, sceneId: CanvasId) =>
  canvases[sceneId] || (sceneIds.has(sceneId as DemoSceneId) ? canvasDocumentFromScene(sceneId as DemoSceneId) : createBlankDocument(fallbackTitle(sceneId)))

export const normalizeDocument = (document: CanvasDocument): CanvasDocument => {
  const edges = cloneEdges(document.edges || [])
  const nodes = normalizeCanvasGraph(cloneNodes(document.nodes), edges)
  const selection = selectionFrom(document.selectedNodeIds, document.selectedNodeId, nodes)
  // Backfill timestamps for legacy snapshots / demo scenes that predate createdAt/updatedAt.
  const now = nowIso()

  return {
    ...document,
    projectId: document.projectId,
    sourceTemplateId: document.sourceTemplateId,
    createdAt: document.createdAt || now,
    updatedAt: document.updatedAt || now,
    nodes,
    edges,
    tasks: cloneTasks(document.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
  }
}

export const patchActiveCanvas = (
  state: CanvasState,
  patch: CanvasDocumentPatch,
  options: { bumpUpdatedAt?: boolean } = {},
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
  const bump = shouldBumpUpdatedAt(patch, options.bumpUpdatedAt)
  const nextDocument: CanvasDocument = {
    ...currentDocument,
    ...patch,
    nodes: nextNodes,
    edges: nextEdges,
    tasks: patch.tasks || currentDocument.tasks,
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    ...(bump ? { updatedAt: nowIso() } : {}),
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

export const patchWithHistory = (
  state: CanvasState,
  patch: CanvasDocumentPatch,
  options: { bumpUpdatedAt?: boolean } = {},
) => ({
  ...remember(state),
  ...patchActiveCanvas(state, patch, options),
})

export const patchCanvasDocument = (
  state: CanvasState,
  sceneId: CanvasId,
  patch: CanvasDocumentPatch,
  options: { history?: boolean; bumpUpdatedAt?: boolean } = {},
) => {
  if (sceneId === state.sceneId) {
    return options.history
      ? patchWithHistory(state, patch, { bumpUpdatedAt: options.bumpUpdatedAt })
      : patchActiveCanvas(state, patch, { bumpUpdatedAt: options.bumpUpdatedAt })
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
  const bump = shouldBumpUpdatedAt(patch, options.bumpUpdatedAt)
  const nextDocument: CanvasDocument = {
    ...currentDocument,
    ...patch,
    nodes: nextNodes,
    edges: nextEdges,
    tasks: patch.tasks ? cloneTasks(patch.tasks) : cloneTasks(currentDocument.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    ...(bump ? { updatedAt: nowIso() } : {}),
  }

  return {
    canvases: {
      ...state.canvases,
      [sceneId]: nextDocument,
    },
  }
}

export const applySnapshot = (state: CanvasState, snapshot: MivoCanvasSnapshot) => {
  const normalizedSnapshot = normalizeCanvasSnapshotV2(snapshot)
  const currentDocument = documentFor(state.canvases, normalizedSnapshot.sceneId)
  const edges = cloneEdges(normalizedSnapshot.edges || [])
  const nodes = normalizeCanvasGraph(cloneNodes(normalizedSnapshot.nodes), edges)
  const selection = selectionFrom(normalizedSnapshot.selectedNodeIds, normalizedSnapshot.selectedNodeId, nodes)
  const document: CanvasDocument = {
    ...currentDocument,
    nodes,
    edges,
    tasks: cloneTasks(normalizedSnapshot.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    // undo/redo/replaceSnapshot are user-visible content restores → bump.
    updatedAt: nowIso(),
  }

  return {
    sceneId: normalizedSnapshot.sceneId,
    nodes: document.nodes,
    edges: document.edges,
    tasks: document.tasks,
    selectedNodeId: document.selectedNodeId,
    selectedNodeIds: document.selectedNodeIds || [],
    activeTool: 'select' as ToolId,
    canvases: {
      ...state.canvases,
      [normalizedSnapshot.sceneId]: document,
    },
  }
}

export const rollbackLatestHistoryBaseline = (
  state: CanvasState,
  sceneId: CanvasId,
  options: { removeNodeId?: string; expectedBaseline?: MivoCanvasSnapshot } = {},
) => {
  const snapshot = state.historyPast.at(-1)
  if (!snapshot || snapshot.sceneId !== sceneId) return undefined
  // S01: 仅当栈顶快照正是生成开始时捕获的基线引用才回滚。异步生成期间用户若编辑过
  // （pushHistory 推了新快照），栈顶已不是该基线，回滚会吞掉用户编辑并清空
  // historyFuture —— 此时返回 undefined 让 caller 走 filter-removal（删节点但保留
  // history 栈）。刻意取舍：保编辑 > 还原 reflow 位移。
  if (options.expectedBaseline && snapshot !== options.expectedBaseline) return undefined

  const normalizedSnapshot = normalizeCanvasSnapshotV2(snapshot)
  const currentDocument = documentFor(state.canvases, sceneId)
  const removeNodeId = options.removeNodeId
  const edges = cloneEdges(normalizedSnapshot.edges || []).filter(
    (edge) => !removeNodeId || (edge.from !== removeNodeId && edge.to !== removeNodeId),
  )
  const nodes = normalizeCanvasGraph(
    cloneNodes(normalizedSnapshot.nodes).filter((node) => node.id !== removeNodeId),
    edges,
  )
  const selection = selectionFrom(normalizedSnapshot.selectedNodeIds, normalizedSnapshot.selectedNodeId, nodes)
  const document: CanvasDocument = {
    ...currentDocument,
    nodes,
    edges,
    tasks: cloneTasks(normalizedSnapshot.tasks),
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds || [],
    // mask-edit failure/cancel rollback removes a placeholder → content change → bump.
    updatedAt: nowIso(),
  }

  return {
    ...(state.sceneId === sceneId
      ? {
          nodes: document.nodes,
          edges: document.edges,
          tasks: document.tasks,
          selectedNodeId: document.selectedNodeId,
          selectedNodeIds: document.selectedNodeIds || [],
        }
      : {}),
    historyPast: state.historyPast.slice(0, -1),
    historyFuture: [],
    canvases: {
      ...state.canvases,
      [sceneId]: document,
    },
  }
}

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const cropEqualsFullImage = (crop: { x: number; y: number; width: number; height: number }) =>
  Math.abs(crop.x) < 0.0001 &&
  Math.abs(crop.y) < 0.0001 &&
  Math.abs(crop.width - 1) < 0.0001 &&
  Math.abs(crop.height - 1) < 0.0001

export const withFrameBehindArtwork = (nodes: MivoCanvasNode[], frame: MivoCanvasNode) => {
  const firstArtworkIndex = nodes.findIndex((node) => node.type !== 'frame')
  if (firstArtworkIndex < 0) return [...nodes, frame]

  return [...nodes.slice(0, firstArtworkIndex), frame, ...nodes.slice(firstArtworkIndex)]
}

export const nodePrompt = (node: MivoCanvasNode | undefined, fallback = '基于当前画布上下文生成新图') =>
  node?.text?.trim() || node?.generation?.prompt || node?.aiWorkflow?.prompt || fallback

export const selectedNodesFromState = (state: CanvasState) => {
  const selected = state.selectedNodeIds.length ? state.selectedNodeIds : state.selectedNodeId ? [state.selectedNodeId] : []
  const selectedSet = new Set(selected)
  return state.nodes.filter((node) => !node.hidden && selectedSet.has(node.id))
}

export const selectedIdsFromState = (state: CanvasState) => selectedNodesFromState(state).map((node) => node.id)

export const arrangeSelectionSpacing = 32

export const visualRowOrder = (nodes: MivoCanvasNode[]) =>
  [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)

const medianNodeHeight = (nodes: MivoCanvasNode[]) => {
  if (!nodes.length) return 0
  const heights = nodes.map((node) => Math.max(1, node.height)).sort((a, b) => a - b)
  const mid = Math.floor(heights.length / 2)
  return heights.length % 2 === 0 ? (heights[mid - 1] + heights[mid]) / 2 : heights[mid]
}

export const firstAnchorImageFor = (nodes: MivoCanvasNode[]) => {
  const images = nodes.filter((node) => node.type === 'image' && !node.hidden)
  if (!images.length) return undefined

  const ordered = visualRowOrder(images)
  const first = ordered[0]
  const rowTolerance = medianNodeHeight(images) / 2
  return ordered
    .filter((node) => Math.abs(node.y - first.y) < rowTolerance)
    .sort((a, b) => a.x - b.x || a.y - b.y)[0]
}

export const arrangedSubjectNodesFrom = (nodes: MivoCanvasNode[], selectedNodes: MivoCanvasNode[]) => {
  const selectedSectionIds = new Set(selectedNodes.filter(isSectionNode).map((node) => node.id))

  return selectedNodes.filter(
    (node) =>
      !isConnectorNode(node) &&
      !isEffectivelyLocked(nodes, node) &&
      !(node.sectionId && selectedSectionIds.has(node.sectionId)),
  )
}

export const boundsForNodes = (nodes: MivoCanvasNode[]) => {
  const minX = Math.min(...nodes.map((node) => node.x))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export const resolvedArrangeModeFor = (mode: SelectionArrangeMode, nodes: MivoCanvasNode[]) => {
  if (mode !== 'tidy') return mode
  if (nodes.length <= 2) {
    const bounds = boundsForNodes(nodes)
    return bounds.width >= bounds.height ? 'row' : 'column'
  }

  const bounds = boundsForNodes(nodes)
  if (bounds.width > bounds.height * 1.8) return 'row'
  if (bounds.height > bounds.width * 1.8) return 'column'
  return 'grid'
}

export const gridColumnCountFor = (count: number, bounds: ReturnType<typeof boundsForNodes>) => {
  const aspect = Math.max(0.45, Math.min(2.8, bounds.width / Math.max(bounds.height, 1)))
  return Math.max(2, Math.min(count, Math.round(Math.sqrt(count * aspect))))
}

export const arrangedPositionsFor = (
  nodes: MivoCanvasNode[],
  requestedMode: SelectionArrangeMode,
): Map<string, { x: number; y: number }> => {
  const positions = new Map<string, { x: number; y: number }>()
  if (nodes.length < 2) return positions

  const bounds = boundsForNodes(nodes)
  const mode = resolvedArrangeModeFor(requestedMode, nodes)

  if (mode === 'row') {
    let cursorX = bounds.minX
    const centerY = bounds.minY + bounds.height / 2

    ;[...nodes]
      .sort((a, b) => a.x - b.x || a.y - b.y)
      .forEach((node) => {
        positions.set(node.id, {
          x: Math.round(cursorX),
          y: Math.round(centerY - node.height / 2),
        })
        cursorX += node.width + arrangeSelectionSpacing
      })

    return positions
  }

  if (mode === 'column') {
    let cursorY = bounds.minY
    const centerX = bounds.minX + bounds.width / 2

    ;[...nodes]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((node) => {
        positions.set(node.id, {
          x: Math.round(centerX - node.width / 2),
          y: Math.round(cursorY),
        })
        cursorY += node.height + arrangeSelectionSpacing
      })

    return positions
  }

  const sorted = visualRowOrder(nodes)
  const columnCount = gridColumnCountFor(sorted.length, bounds)
  const rows: MivoCanvasNode[][] = []
  sorted.forEach((node, index) => {
    const rowIndex = Math.floor(index / columnCount)
    rows[rowIndex] = rows[rowIndex] || []
    rows[rowIndex].push(node)
  })

  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.width || 0)),
  )
  const rowHeights = rows.map((row) => Math.max(...row.map((node) => node.height)))
  const columnXs: number[] = []
  const rowYs: number[] = []
  let cursorX = bounds.minX
  let cursorY = bounds.minY

  columnWidths.forEach((width, index) => {
    columnXs[index] = cursorX
    cursorX += width + arrangeSelectionSpacing
  })
  rowHeights.forEach((height, index) => {
    rowYs[index] = cursorY
    cursorY += height + arrangeSelectionSpacing
  })

  rows.forEach((row, rowIndex) => {
    row.forEach((node, columnIndex) => {
      positions.set(node.id, {
        x: Math.round(columnXs[columnIndex] + (columnWidths[columnIndex] - node.width) / 2),
        y: Math.round(rowYs[rowIndex] + (rowHeights[rowIndex] - node.height) / 2),
      })
    })
  })

  return positions
}
export const defaultSceneId: CanvasId = 'character-flow'
export const defaultCanvases = initialCanvases()
export const defaultDocument = documentFor(defaultCanvases, defaultSceneId)
export const importedAssetDisplaySize = (type: CanvasAssetNodeType, metadata?: ImportedFileMetadata) => {
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
      : markdownDocumentSizeFor(metadata?.text)
  }

  return defaultSizeForNodeType(type)
}

export const importedAssetPromptFor = (type: Exclude<CanvasAssetNodeType, 'markdown'>) => {
  if (type === 'pdf') return '本地导入 PDF 文档，可作为后续 AI 上下文'
  if (type === 'video') return '本地导入视频文件，可作为后续 AI 上下文'
  return '本地导入图片，可作为后续 AI 上下文'
}

export const clipboardAssetTitle = (asset: CanvasAssetClipboardItem) =>
  asset.title?.trim() || asset.name?.replace(/\.[^.]+$/, '') || 'Eagle asset'

export const clipboardAssetDisplaySize = (asset: CanvasAssetClipboardItem) =>
  importedImageDisplaySize(
    asset.width && asset.height
      ? {
          width: asset.width,
          height: asset.height,
        }
      : undefined,
  )

export const importedAssetModelFor = (type: Exclude<CanvasAssetNodeType, 'markdown'>) => {
  if (type === 'pdf') return 'Imported PDF'
  if (type === 'video') return 'Imported Video'
  return 'Imported'
}
