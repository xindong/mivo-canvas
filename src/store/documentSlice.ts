import type {
  AiWorkflowOperation,
  CanvasEdge,
  DemoSceneId,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import type { SliceCreator } from './canvasStateTypes'
import { saveGeneratedAsset } from '../lib/assetStorage'
import { defaultSizeForNodeType } from '../model/canvasNodeRegistry'
import { AI_SLOT_GAP, buildAiContextSnapshot, chooseAdjacentPlacement, equalAreaSizeForDimensions, reflowRightObstacles } from './aiCanvasWorkflow'
import { blobFromCommittedGenerationImage, displaySizeForGeneratedAsset, logCanvas, warnCanvas, errorCanvas } from './canvasStoreLog'
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
import { enqueuePersistWrite } from '../lib/persistBoot'
import { isServerPersist } from '../lib/persistMode'

export const createDocumentSlice: SliceCreator = (set, get) => ({
  canvases: defaultCanvases,
  sceneId: defaultSceneId,
  nodes: defaultDocument.nodes,
  edges: defaultDocument.edges || [],
  historyPast: [],
  historyFuture: [],
  createCanvas: (title = 'Untitled Canvas', options) => {
    const id = createCanvasId()
    // R2 F2 / R3 F2-B:server 模式 canvas 必须归 project(防 POST /api/canvas projectId='' → 400
    // bad-body / 404 unknown-project 被队列当 rejected terminal 删 → 刷新画布消失)。
    //   - R2 F2:有 project 时强制归 project(原本 fallback '' 致 standalone canvas 终态失败)。
    //   - R3 F2-B:零项目账号此前 fallback '' → 真 Hono 400 → 终态删记录 → 画布消失。修:零项目时
    //     先自动建默认 project(createProject 同步 mint id + enqueue createProject),canvas 归它;
    //     createProject 先于 createCanvas enqueue(drain 顺序保证 projectId 先服务端建好)。
    // local 模式保持 options?.projectId(undefined = standalone,零变化)。
    // docProjectId 用于本地 doc(local standalone=undefined);opProjectId 用于 enqueue op(string 要求,'' 兜底)。
    let docProjectId: string | undefined
    if (isServerPersist) {
      if (options?.projectId) {
        docProjectId = options.projectId
      } else {
        const firstExisting = get().projects[0]?.id
        docProjectId = firstExisting ?? get().createProject('Default Project')
      }
    } else {
      docProjectId = options?.projectId
    }
    const opProjectId = docProjectId ?? ''

    set((state) => {
      const document = options?.templateId
        ? {
            ...canvasDocumentFromScene(options.templateId),
            title,
            projectId: docProjectId,
          }
        : createBlankDocument(title, docProjectId)
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
    // G1-a P1-2:server/shadow 模式 enqueue createCanvas(POST 幂等,带本地 id + projectId + title);
    // canvas content(nodes/edges)同步属 G1-c(节点 mutation),本轮只 enqueue meta create。local no-op。
    enqueuePersistWrite({
      kind: 'createCanvas',
      canvasId: id,
      projectId: opProjectId,
      title,
      ...(options?.templateId ? { sourceTemplateId: options.templateId } : {}),
    })
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
    // C8: duplicate does NOT inherit the source's timestamps — the copy is a new
    // entity with fresh createdAt/updatedAt. projectId IS inherited (copy stays
    // in the same project); only the title gets a " Copy" suffix.
    const now = new Date().toISOString()
    const duplicatedDocument = {
      ...normalizeDocument({
        ...sourceDocument,
        title: `${sourceDocument.title} Copy`,
        nodes: cloneNodes(sourceDocument.nodes),
        tasks: cloneTasks(sourceDocument.tasks),
      }),
      createdAt: now,
      updatedAt: now,
    }

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
        // G1-a P1-2:server/shadow 模式 enqueue deleteCanvas(DELETE 幂等)。local no-op。
        enqueuePersistWrite({ kind: 'deleteCanvas', canvasId: targetId })
        return { canvases: remainingCanvases }
      }

      const nextSceneId = canvasIds.find((id) => id !== targetId) || defaultSceneId
      const nextDocument = normalizeDocument(documentFor(remainingCanvases, nextSceneId))
      logCanvas(`Deleted active canvas "${deletedTitle}" and loaded "${nextDocument.title}"`)
      // G1-a P1-2:server/shadow 模式 enqueue deleteCanvas(DELETE 幂等)。local no-op。
      enqueuePersistWrite({ kind: 'deleteCanvas', canvasId: targetId })

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
  renameCanvas: (sceneId, title) => {
    const existing = get().canvases[sceneId]
    const metaRevision = existing?.metaRevision
    set((state) => {
      const document = documentFor(state.canvases, sceneId)
      logCanvas(`Renamed canvas "${document.title}" to "${title}"`)
      // Route through patchCanvasDocument so updatedAt bumps (title is a content
      // change — Phase 1d bump hub, single source of truth). The active-scene path
      // also surfaces unchanged nodes/edges/tasks/selection (no-op merge); the
      // non-active path returns { canvases } exactly as before.
      return patchCanvasDocument(state, sceneId, { title })
    })
    // G1-a P1-2:server/shadow 模式 enqueue updateCanvas(PUT,If-Match = metaRevision)。
    // IDB 画布无 metaRevision → 428 rejected(fail-visible:canvas 全量 hydrate 属 G1-c,未 hydrate 无法同步 rename)。local no-op。
    if (existing) {
      enqueuePersistWrite({
        kind: 'updateCanvas',
        canvasId: sceneId,
        projectId: existing.projectId ?? '',
        title,
        baseRevision: metaRevision,
      })
    }
  },
  moveCanvasToProject: (canvasId, projectId) =>
    set((state) => {
      const document = state.canvases[canvasId]
      if (!document) {
        warnCanvas(`Move canvas skipped: missing canvas ${canvasId}`)
        return {}
      }
      // projectId === undefined → move back to the Canvas 区 (clear projectId).
      if (projectId !== undefined && !state.projects.some((p) => p.id === projectId)) {
        warnCanvas(`Move canvas skipped: target project ${projectId} does not exist`)
        return {}
      }
      // Target === current归属 → no-op (no bump, no log).
      if (document.projectId === projectId) return {}

      const target = projectId === undefined ? 'Canvas' : projectId
      logCanvas(`Moved canvas "${document.title}" (${canvasId}) → ${target}`)
      // G1-a P1-2:server/shadow 模式 enqueue updateCanvas(PUT,projectId 改 = move;move 双端 owner-only authz)。
      // baseRevision = metaRevision(IDB 画布无 → 428;G1-c canvas hydrate 后填充)。fire-and-forget;local no-op。
      enqueuePersistWrite({
        kind: 'updateCanvas',
        canvasId,
        projectId: projectId ?? '',
        title: document.title,
        baseRevision: document.metaRevision,
      })
      return {
        canvases: {
          ...state.canvases,
          [canvasId]: {
            ...document,
            projectId,
            // Moving is a user-visible reclassification → bump (mirrors maker's
            // move → recent-list refresh semantics).
            updatedAt: new Date().toISOString(),
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
    const replaceSlotId = payload.replaceSlotId
    const lineageSourceId = payload.lineageSourceId || payload.sourceNodeId

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
    // S02: 资产已落盘——sourceNodeId / lineageSource / replacementSlot 在 await 期间被删
    // 时必须显式抛错（文案带已保存资产名，便于人工找回孤儿资产），不再让 set 内静默
    // return 造成"生成成功但画布无节点"的假成功。await 前的入参校验（:228-240）保持
    // 原文案不变（那时还没有资产）。savedNames 在所有 post-save 校验之前计算一次。
    const savedNames = savedImages.map((s) => s.asset.name).join(', ')
    if (
      payload.sourceNodeId &&
      !currentDocument.nodes.find((node) => node.id === payload.sourceNodeId && !node.hidden)
    ) {
      throw new Error(`源节点已删除，生成结果未落画布。已保存资产：${savedNames}`)
    }
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
        // 规格(2026-07-05 用户二次澄清,取代 #86 W2-F5「替换保留占位尺寸」契约):
        // 所有生图占位符一律 1:1 方形 loading(chat 与局部重绘同规,无 kind 特例),
        // 替换时统一按结果图自然宽高比、与占位符等面积落画布——edit 结果与源图同
        // 比例由生成本身保证,无需靠占位尺寸传递;结果无自然尺寸信息时 equalArea
        // 内部回退占位尺寸。Non-slot placements 不变,仍用资产自然尺寸。
        const displaySize = replacingSlot
          ? equalAreaSizeForDimensions(fallbackSize, asset.sourceDimensions)
          : displaySizeForGeneratedAsset(asset, fallbackSize)
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
            sourceDimensions: asset.sourceDimensions,
            size: asset.size,
          },
          prompt,
          model: payload.model,
          taskId,
          createdAt,
          maskBounds: payload.maskBounds,
          maskSourceSize: payload.maskSourceSize,
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
        if (payload.reflow) {
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
