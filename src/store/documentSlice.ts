import type {
  AiWorkflowOperation,
  CanvasEdge,
  DemoSceneId,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import type { SliceCreator } from './canvasStore'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { defaultSizeForNodeType } from '../canvas/nodeTypes/canvasNodeRegistry'
import { AI_SLOT_GAP, buildAiContextSnapshot, chooseAdjacentPlacement, reflowRightObstacles } from './aiCanvasWorkflow'
import { blobFromCommittedGenerationImage, displaySizeForGeneratedAsset, logCanvas, warnCanvas, errorCanvas } from './canvasStore'
import { redoHistory, undoHistory } from './historyManager'
import {
  cloneEdges,
  cloneNodes,
  cloneTasks,
  createCanvasId,
  createEdgeId,
  createGenerationResultNode,
  createNodeId,
  isDerivationEdgeNode,
} from './nodeFactory'
import {
  applySnapshot,
  canvasDocumentFromScene,
  createBlankDocument,
  defaultCanvases,
  defaultDocument,
  defaultSceneId,
  documentFor,
  historyCloneFns,
  normalizeDocument,
  patchCanvasDocument,
  remember,
  sceneIds,
  snapshotFromState,
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
  commitGenerationResult: async (payload) => {
    const prompt = payload.prompt.trim()
    if (!prompt) throw new Error('Prompt is required')
    if (!payload.resultImages.length) throw new Error('No generated images returned')
    const targetSceneId = payload.sceneId || get().sceneId
    const payloadExtras = payload as {
      replaceSlotId?: string
      lineageSourceId?: string
      reflow?: boolean
    }
    const replaceSlotId = payloadExtras.replaceSlotId
    const lineageSourceId = payloadExtras.lineageSourceId || payload.sourceNodeId

    const initialState = get()
    const initialDocument = initialState.canvases[targetSceneId]
    if (!initialDocument) throw new Error('目标画布已删除，无法继续生成。')
    const source = payload.sourceNodeId
      ? initialDocument.nodes.find((node) => node.id === payload.sourceNodeId && !node.hidden)
      : undefined
    if (payload.sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')
    const lineageSource = lineageSourceId
      ? initialDocument.nodes.find((node) => node.id === lineageSourceId && !node.hidden)
      : undefined
    if (lineageSourceId && !lineageSource) throw new Error('源节点已删除，无法继续生成。')
    const replacementSlot = replaceSlotId
      ? initialDocument.nodes.find((node) => node.id === replaceSlotId && node.type === 'ai-slot' && !node.hidden)
      : undefined
    if (replaceSlotId && !replacementSlot) throw new Error('AI 生成槽位已删除，无法继续生成。')

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
    // S02: 资产已落盘——lineageSource / replacementSlot 在 await 期间被删时必须显式抛错
    // （文案带已保存资产名，便于人工找回孤儿资产），不再让 set 内静默 return 造成
    // "生成成功但画布无节点"的假成功。await 前的入参校验（:228-240）保持原文案不变
    // （那时还没有资产）。
    const savedNames = savedImages.map((s) => s.asset.name).join(', ')
    const currentLineageSource = lineageSourceId
      ? currentDocument.nodes.find((node) => node.id === lineageSourceId && !node.hidden)
      : undefined
    if (lineageSourceId && !currentLineageSource) {
      throw new Error(`源节点已删除，生成结果未落画布。已保存资产：${savedNames}`)
    }
    const currentReplacementSlot = replaceSlotId
      ? currentDocument.nodes.find((node) => node.id === replaceSlotId && node.type === 'ai-slot' && !node.hidden)
      : undefined
    if (replaceSlotId && !currentReplacementSlot) {
      throw new Error(`AI 生成槽位已删除，生成结果未落画布。已保存资产：${savedNames}`)
    }

    set((state) => {
      const targetDocument = state.canvases[targetSceneId]
      if (!targetDocument) return {}

      const currentSource = payload.sourceNodeId
        ? targetDocument.nodes.find((node) => node.id === payload.sourceNodeId && !node.hidden)
        : undefined
      if (payload.sourceNodeId && !currentSource) return {}
      const currentLineageSource = lineageSourceId
        ? targetDocument.nodes.find((node) => node.id === lineageSourceId && !node.hidden)
        : undefined
      if (lineageSourceId && !currentLineageSource) return {}
      const currentReplacementSlot = replaceSlotId
        ? targetDocument.nodes.find((node) => node.id === replaceSlotId && node.type === 'ai-slot' && !node.hidden)
        : undefined
      if (replaceSlotId && !currentReplacementSlot) return {}

      let nextNodes = targetDocument.nodes.filter((node) => !isDerivationEdgeNode(node))
      const nextEdges = cloneEdges(targetDocument.edges || [])
      const newNodes: MivoCanvasNode[] = []
      const newEdges: CanvasEdge[] = []

      savedImages.forEach(({ image, asset }, index) => {
        const replacingSlot = index === 0 ? currentReplacementSlot : undefined
        const lineageNode =
          currentLineageSource && currentLineageSource.id !== replacingSlot?.id ? currentLineageSource : undefined
        const fallbackNode = replacingSlot || currentSource
        const fallbackSize = fallbackNode
          ? { width: fallbackNode.width, height: fallbackNode.height }
          : {
              width: image.width || defaultSizeForNodeType('image').width,
              height: image.height || defaultSizeForNodeType('image').height,
            }
        const displaySize = displaySizeForGeneratedAsset(asset, fallbackSize)
        const placement = replacingSlot
          ? { x: replacingSlot.x, y: replacingSlot.y }
          : currentSource
          ? chooseAdjacentPlacement({
              nodes: nextNodes,
              anchor: currentSource,
              width: displaySize.width,
              height: displaySize.height,
              placement: payload.placement || 'right',
            })
          : { x: index * 36, y: index * 36 }
        const nodeId = replacingSlot?.id || createNodeId(`${payload.kind}-result`)
        const taskId = payload.taskId || `task-${nodeId}`
        const operation: AiWorkflowOperation =
          payload.kind === 'edit'
            ? 'area-edit'
            : replacingSlot || currentSource?.type === 'ai-slot'
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
          sourceNode: lineageNode,
          placementDirection: payload.placement || 'right',
        })

        createdNodeIds.push(nodeId)
        if (replacingSlot) {
          nextNodes = nextNodes.map((node) => (node.id === replacingSlot.id ? resultNode : node))
        } else {
          newNodes.push(resultNode)
          nextNodes = [...nextNodes, resultNode]
        }
        if (payloadExtras.reflow) {
          nextNodes = reflowRightObstacles(nextNodes, resultNode, AI_SLOT_GAP)
        }

        if (lineageNode && payload.createDerivationEdge !== false) {
          newEdges.push({
            id: createEdgeId(),
            from: lineageNode.id,
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
      }, { history: !replaceSlotId })
    })

    // S02: 落地断言——资产已保存但无任何节点落地（set 内同 tick 竞态最后防线触发了
    // 静默 return {}）时显式抛错带资产名，避免假成功。正常流下上提校验已拦住所有
    // 删除场景，此断言为防御性最后防线。
    if (savedImages.length > 0 && createdNodeIds.length === 0) {
      throw new Error(`生成结果未落画布（画布状态在保存期间变化）。已保存资产：${savedNames}`)
    }

    return createdNodeIds
  },
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
