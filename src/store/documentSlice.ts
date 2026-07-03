import type {
  AiWorkflowOperation,
  CanvasEdge,
  DemoSceneId,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import type { SliceCreator } from './canvasStore'
import { highlighterOpacity } from '../canvas/brushGeometry'
import { defaultStampKind, stampLabelFor } from '../canvas/stampDefs'
import { defaultSizeForNodeType } from '../canvas/nodeTypes/canvasNodeRegistry'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from '../canvas/textGeometry'
import { markdownShouldUsePreviewMode } from '../lib/canvasAssetImport'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { normalizeCanvasNodeV2, setNodeTransform } from '../model/documentModelV2'
import { buildAiContextSnapshot, chooseAdjacentPlacement } from './aiCanvasWorkflow'
import { blobFromCommittedGenerationImage, displaySizeForGeneratedAsset, logCanvas, warnCanvas, errorCanvas } from './canvasStore'
import { makeNode } from './demoScenes'
import { redoHistory, undoHistory } from './historyManager'
import {
  cloneEdges,
  cloneNodes,
  cloneTasks,
  createCanvasId,
  createEdgeId,
  createGenerationResultNode,
  createGroupId,
  createNodeId,
  createNodeCopy,
  isDerivationEdgeNode,
} from './nodeFactory'
import {
  applySnapshot,
  canvasDocumentFromScene,
  childIdsForSections,
  clamp,
  createBlankDocument,
  cropEqualsFullImage,
  defaultCanvases,
  defaultDocument,
  defaultMarkupFillColor,
  defaultMarkupStrokeColor,
  defaultMarkupStrokeWidth,
  defaultSceneId,
  defaultSectionBorderColor,
  defaultSectionBorderStyle,
  defaultSectionBorderWidth,
  defaultSectionFillColor,
  documentFor,
  historyCloneFns,
  isEditableTextNode,
  isEffectivelyLocked,
  isSectionNode,
  normalizeCanvasNodes,
  normalizeDocument,
  patchActiveCanvas,
  patchCanvasDocument,
  patchWithHistory,
  remember,
  sceneIds,
  selectedIdsFromState,
  selectedNodesFromState,
  snapshotFromState,
  targetNodeIdForMarkup,
  withFrameBehindArtwork,
  importedAssetDisplaySize,
  importedAssetPromptFor,
  importedAssetModelFor,
} from './canvasDocumentModel'

export const createDocumentSlice: SliceCreator = (set, get) => ({
  canvases: defaultCanvases,
  sceneId: defaultSceneId,
  nodes: defaultDocument.nodes,
  edges: defaultDocument.edges || [],
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

    logCanvas(`Created canvas "${title}" (${id})`)
    return id
  },
  duplicateCanvas: (canvasId) => {
    const state = get()
    const sourceId = canvasId || state.sceneId
    const sourceDocument = state.canvases[sourceId]
    if (!sourceDocument) {
      warnCanvas(`Duplicate canvas skipped: missing source ${sourceId}`)
      return undefined
    }

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

    logCanvas(`Duplicated canvas "${sourceDocument.title}" to ${id}`)
    return id
  },
  deleteCanvas: (canvasId) =>
    set((state) => {
      const targetId = canvasId || state.sceneId
      const canvasIds = Object.keys(state.canvases)
      if (!state.canvases[targetId]) {
        warnCanvas(`Delete canvas skipped: missing canvas ${targetId}`)
        return {}
      }
      if (canvasIds.length <= 1) {
        errorCanvas('Delete canvas blocked: at least one canvas must remain')
        return {}
      }

      const remainingCanvases = { ...state.canvases }
      const deletedTitle = state.canvases[targetId].title
      delete remainingCanvases[targetId]

      if (targetId !== state.sceneId) {
        logCanvas(`Deleted inactive canvas "${deletedTitle}"`)
        return { canvases: remainingCanvases }
      }

      const nextSceneId = canvasIds.find((id) => id !== targetId) || defaultSceneId
      const nextDocument = normalizeDocument(documentFor(remainingCanvases, nextSceneId))
      logCanvas(`Deleted active canvas "${deletedTitle}" and loaded "${nextDocument.title}"`)

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
      logCanvas(`Loaded canvas "${document.title}" (${sceneId})`)

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
      logCanvas(`Renamed canvas "${document.title}" to "${title}"`)

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
  captureHistory: () => set((state) => remember(state)),
  undo: () =>
    set((state) => {
      const result = undoHistory(state, historyCloneFns)
      if (!result) return {}

      return {
        ...applySnapshot(state, result.snapshotToApply),
        historyPast: result.historyPast,
        historyFuture: result.historyFuture,
      }
    }),
  redo: () =>
    set((state) => {
      const result = redoHistory(state, historyCloneFns)
      if (!result) return {}

      return {
        ...applySnapshot(state, result.snapshotToApply),
        historyPast: result.historyPast,
        historyFuture: result.historyFuture,
      }
    }),
  updateNodePosition: (nodeId, x, y) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId)
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId ? setNodeTransform(node, { x: Math.round(x), y: Math.round(y) }) : node,
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
            ? setNodeTransform(node, { x: node.x + dx, y: node.y + dy })
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
            ? setNodeTransform(node, {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
              })
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

        return setNodeTransform(node, {
          x: Math.round(update.x),
          y: Math.round(update.y),
          width: Math.round(update.width),
          height: Math.round(update.height),
        })
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
            ? setNodeTransform(node, {
                width: nextWidth,
                height: nextHeight,
              })
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
            ? setNodeTransform({
                ...node,
                markdownDisplayMode: mode,
              }, { height: Math.max(320, Math.round(nextHeight)) })
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
            ? setNodeTransform(node, { x: node.x + dx, y: node.y + dy })
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
  addImportedImage: (assetUrl, title = 'Imported Image', size = 'source', position, metadata) => {
    logCanvas(`Import image requested: ${title}`)
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
    logCanvas(`Imported ${type} node "${nodeTitle}" from ${metadata?.originalName || assetUrl}`)
  },
  cropImageNode: (nodeId, box) =>
    set((state) => {
      const source = state.nodes.find((node) => node.id === nodeId && node.type === 'image')
      if (!source) {
        warnCanvas(`Crop skipped: image node ${nodeId} not found`)
        return {}
      }

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
          ? setNodeTransform({
              ...node,
              imageCrop: cropEqualsFullImage(nextCrop) ? undefined : nextCrop,
            }, {
              x: Math.round(node.x + cropBox.x),
              y: Math.round(node.y + cropBox.y),
              width: Math.round(cropBox.width),
              height: Math.round(cropBox.height),
            })
          : node,
      )

      logCanvas(`Cropped image "${source.title}"`)
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

    logCanvas(`Created section ${id}`)
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

    logCanvas(`Created AI slot ${id}`)
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
      if (!source) {
        warnCanvas('Annotation creation skipped: no source node selected')
        return {}
      }

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

    if (created) logCanvas(`Created annotation ${id}`)
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
                : kind === 'stamp'
                  ? `Stamp ${stampLabelFor(options?.stampKind)}`
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
        markupBrushKind: kind === 'brush' ? options?.brushKind || 'marker' : undefined,
        markupStampKind: kind === 'stamp' ? options?.stampKind || defaultStampKind : undefined,
        markupPoints: options?.points?.map((point) => ({
          x: Math.round(point.x),
          y: Math.round(point.y),
          ...(point.pressure !== undefined ? { pressure: point.pressure } : {}),
        })),
        markupStrokeColor: options?.strokeColor || defaultMarkupStrokeColor,
        markupFillColor: options?.fillColor || (kind === 'note' ? '#fff1a8' : defaultMarkupFillColor),
        markupStrokeWidth: options?.strokeWidth || defaultMarkupStrokeWidth,
        markupStrokeStyle: options?.strokeStyle || 'solid',
        markupOpacity: kind === 'brush' && options?.brushKind === 'highlighter' ? highlighterOpacity : 1,
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

    logCanvas(`Created ${kind} markup ${id}`)
    return id
  },
  updateMarkupGeometry: (nodeId, geometry, points, bindings) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markup')
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId
            ? setNodeTransform({
                ...node,
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
              }, {
                x: Math.round(geometry.x),
                y: Math.round(geometry.y),
                width: Math.round(geometry.width),
                height: Math.round(geometry.height),
              })
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
          ? normalizeCanvasNodeV2({ ...node, ...style, fills: undefined, strokes: undefined })
          : node,
      )
      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  updateSectionStyle: (nodeId, style) =>
    set((state) => {
      const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
      if (!section || section.locked) return {}

      const nodes = state.nodes.map((node) =>
        node.id === nodeId
          ? normalizeCanvasNodeV2({ ...node, ...style, fills: undefined, strokes: undefined })
          : node,
      )
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

    logCanvas(`Created text node ${id}`)
    return id
  },
  updateTextNode: (nodeId, text, geometry) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId && isEditableTextNode(node)
          ? (() => {
              const nextNode = {
                ...node,
                title: node.type === 'markup' ? node.title : text.trim() || 'Text',
                text,
                generation:
                  node.type === 'markup' && node.generation
                    ? {
                        ...node.generation,
                        prompt: text.trim() || node.title,
                      }
                    : node.generation,
              }

              return geometry && node.type !== 'markup'
                ? setNodeTransform(nextNode, {
                    width: Math.round(geometry.width),
                    height: Math.round(geometry.height),
                  })
                : nextNode
            })()
          : node,
      )

      return patchActiveCanvas(state, { nodes })
    }),
  updateTextStyle: (nodeId, style, geometry) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId && isEditableTextNode(node)
          ? geometry && node.type !== 'markup'
            ? setNodeTransform({ ...node, ...style }, {
                width: Math.round(geometry.width),
                height: Math.round(geometry.height),
              })
            : { ...node, ...style }
          : node,
      )

      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  resizeTextNode: (nodeId, x, width, height) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId && isEditableTextNode(node)
          ? setNodeTransform({
              ...node,
              textAutoWidth: false,
            }, {
              x: Math.round(x),
              width: Math.round(width),
              height: Math.round(height),
            })
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
        const resultNode = createGenerationResultNode({
          id: nodeId,
          title: image.title?.trim() || `Generated image ${index + 1}`,
          placement,
          displaySize,
          asset: {
            assetUrl: asset.assetUrl,
            type: asset.type,
            name: asset.name,
            sizeBytes: asset.sizeBytes,
            hasTransparency: asset.hasTransparency,
            size: asset.size,
          },
          prompt,
          model: payload.model,
          taskId,
          createdAt,
          maskBounds: payload.maskBounds,
          operation,
          sourceNode: currentSource,
          placementDirection: payload.placement || 'right',
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
})
