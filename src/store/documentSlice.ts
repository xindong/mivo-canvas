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
import { enqueuePersistWrite, isPersistWriteActive } from '../lib/persistBoot'
import { isServerPersist } from '../lib/persistMode'
import { getSceneWrap } from '../lib/sceneWrapRegistry'
// Phase 1 项4(复活加固):store delete action 发起时写持久 tombstone(详见 src/lib/deletionTombstones.ts)。
import { recordDeletionTombstone } from '../lib/deletionTombstones'
import { toastFeedback } from './toastStore'
import { resolveActiveCanvasAfterArchive } from './archiveSurvivor'

// Phase 1 项4(复活加固):server/shadow 模式删 canvas 时写持久 tombstone(与队列记录生死解耦,覆盖溢出驱逐/
//   重试耗尽离队后 pending-delete 失效的复活;hydrate step2 并集 tombstone 过滤)。local 模式(queue 未启动)
//   无 hydrate/无复活,不写(避免 IDB 积累永不清的 tombstone)。fire-and-forget(recordDeletionTombstone 内部
//   best-effort 永不 throw);clear 时机 = onOutcome DELETE 终态 success(persistBoot)。
const recordCanvasTombstone = (canvasId: string): void => {
  if (!isPersistWriteActive()) return
  void recordDeletionTombstone('canvas', canvasId).catch((e) =>
    warnCanvas(`tombstone record failed (canvas ${canvasId}): ${e instanceof Error ? e.message : String(e)}`),
  )
}

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
        // PR-C1 SC-3:默认父项目取首个 active 项目(非 projects[0])——否则新画布可能静默
        //   落进 archived 项目(级联归档语义下 archived project 的画布不可见 = 丢画布)。
        const firstExisting = get().projects.find((p) => p.status !== 'archived')?.id
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
    // A2 前置 c:server 模式 standalone 源(无 projectId)时镜像 createCanvas 的兜底
    // (firstExisting / 建 Default Project)——否则 enqueue createCanvas 缺 projectId,POST
    // /api/canvas → 404 unknown-project 终态删记录,"duplicate 后服务端有记录"不成立。
    let docProjectId = sourceDocument.projectId
    if (isServerPersist && !docProjectId) {
      // PR-C1 SC-3:默认父项目取首个 active 项目(非 projects[0]),防 duplicate 落进 archived 项目。
      const firstExisting = get().projects.find((p) => p.status !== 'archived')?.id
      docProjectId = firstExisting ?? get().createProject('Default Project')
    }
    const opProjectId = docProjectId ?? ''
    const now = new Date().toISOString()
    const duplicatedDocument = {
      ...normalizeDocument({
        ...sourceDocument,
        title: `${sourceDocument.title} Copy`,
        projectId: docProjectId,
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
    // G1-a P1-2 / A2 前置 c:server/shadow 模式 enqueue createCanvas(POST 幂等,带新 id + projectId + title)。
    // 服务端建记录 + onSuccess 回灌 metaRevision,后续 rename/move 用 fresh base(不 428)。local no-op。
    // standalone 源在 local 模式(opProjectId='')不 enqueue——server 画布必须归 project,无 project 不可 persist。
    if (opProjectId) {
      enqueuePersistWrite({ kind: 'createCanvas', canvasId: id, projectId: opProjectId, title: duplicatedDocument.title })
    } else {
      warnCanvas(`Duplicate canvas ${id} not enqueued: standalone source, no projectId (local mode; not server-persistable)`)
    }
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
        recordCanvasTombstone(targetId) // Phase 1 项4:server 模式写 tombstone 挡复活
        return { canvases: remainingCanvases }
      }

      const nextSceneId = canvasIds.find((id) => id !== targetId) || defaultSceneId
      const nextDocument = normalizeDocument(documentFor(remainingCanvases, nextSceneId))
      logCanvas(`Deleted active canvas "${deletedTitle}" and loaded "${nextDocument.title}"`)
      // G1-a P1-2:server/shadow 模式 enqueue deleteCanvas(DELETE 幂等)。local no-op。
      enqueuePersistWrite({ kind: 'deleteCanvas', canvasId: targetId })
      recordCanvasTombstone(targetId) // Phase 1 项4:server 模式写 tombstone 挡复活

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
  // Phase 2 归档(回收站)——CR-10 unarchiveCanvas 自动 unarchive 父项目(编辑先恢复同构)+ CR-11 不入 undo 栈
  //   (status 变更非画布内容 mutation,historyManager 只管画布内容)。归档后必须仍有 ≥1 active canvas。
  archiveCanvas: (canvasId) =>
    set((state) => {
      const targetId = canvasId || state.sceneId
      const document = state.canvases[targetId]
      if (!document) {
        warnCanvas(`Archive canvas skipped: missing canvas ${targetId}`)
        return {}
      }
      if (document.status === 'archived') {
        warnCanvas(`Archive canvas skipped: already archived ${targetId}`)
        return {}
      }
      const nextCanvases = {
        ...state.canvases,
        [targetId]: { ...document, status: 'archived' as const, archivedByCascade: false },
      }
      const resolution = resolveActiveCanvasAfterArchive(nextCanvases, state.sceneId)
      if (resolution.kind === 'blocked') {
        warnCanvas(`Archive canvas blocked: ${targetId} would leave no active canvas`)
        toastFeedback.warn('至少保留一个活跃画布,请先创建或恢复其他画布再归档')
        return {}
      }

      logCanvas(`Archived canvas "${document.title}" (${targetId})`)
      // 直接归档:archivedByCascade=false(unarchiveProject 不恢复此画布;CR-5)。server 幂等:已归档→200 no-op。
      enqueuePersistWrite({ kind: 'archiveCanvas', canvasId: targetId })
      if (resolution.kind === 'keep') {
        return { canvases: nextCanvases }
      }
      const nextSceneId = resolution.sceneId
      const nextDocument = normalizeDocument(documentFor(nextCanvases, nextSceneId))
      logCanvas(`Archived active canvas → switched scene to ${nextSceneId}`)
      return {
        canvases: nextCanvases,
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
  unarchiveCanvas: (canvasId) =>
    set((state) => {
      const targetId = canvasId || state.sceneId
      const document = state.canvases[targetId]
      if (!document) {
        warnCanvas(`Unarchive canvas skipped: missing canvas ${targetId}`)
        return {}
      }
      if (document.status !== 'archived') {
        warnCanvas(`Unarchive canvas skipped: not archived ${targetId}`)
        return {}
      }
      // CR-10:unarchive canvas 自动 unarchive 父项目(若父 archived)——archived canvas 挂 archived 项目下,只恢复
      //   画布不恢复项目则画布仍不可见(active 视图项目组不显示)。**单 set 原子**完成 canvas active + project
      //   active + 级联恢复 cascade-archived 同辈(archivedByCascade===true→active,同 unarchiveProject 语义),
      //   防分两 set 的 lost-update(先 set canvas 再调 unarchiveProject 会以后者 stale state 覆盖前者)。
      //   级联同辈的 server 恢复由 unarchiveProject op 的 unarchiveProjectTree 承担;本直接归档画布经自身
      //   unarchiveCanvas op 恢复(archivedByCascade=false,server cascade 不重复动它)。无 projectId(standalone)→ 跳过。
      const parentId = document.projectId
      const parent = parentId ? state.projects.find((p) => p.id === parentId) : undefined
      const unarchiveParent = parent !== undefined && parent.status === 'archived'
      const canvases = Object.fromEntries(
        Object.entries(state.canvases).map(([id, doc]) => {
          if (id === targetId) {
            return [id, { ...doc, status: 'active' as const, archivedByCascade: false }]
          }
          // 父项目归档恢复 → 级联恢复 archivedByCascade===true 的同辈(同 unarchiveProject 语义);直接归档同辈不动。
          if (
            unarchiveParent &&
            parentId !== undefined &&
            doc.projectId === parentId &&
            doc.archivedByCascade === true
          ) {
            return [id, { ...doc, status: 'active' as const, archivedByCascade: false }]
          }
          return [id, doc]
        }),
      )
      const projects = unarchiveParent && parentId
        ? state.projects.map((p) => (p.id === parentId ? { ...p, status: 'active' as const } : p))
        : state.projects
      logCanvas(
        `Unarchived canvas "${document.title}" (${targetId})${unarchiveParent ? `; parent project ${parentId} auto-unarchived + cascade-archived siblings restored (CR-10)` : ''}`,
      )
      enqueuePersistWrite({ kind: 'unarchiveCanvas', canvasId: targetId })
      if (unarchiveParent && parentId) {
        enqueuePersistWrite({ kind: 'unarchiveProject', projectId: parentId })
      }
      return { canvases, projects }
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
  /**
   * A2-S3 block 8:hydrate 后顶层 content 刷新。hydrateActiveCanvasContent 只写
   * canvases[sceneId].nodes/edges,顶层 state.nodes/edges 需同步(否则 loadScene 在 fetch
   * 完成前拍的空 document 留在顶层,用户看到空画布:docNodesLength>0 但 topLevelNodesLength=0)。
   * 复用 loadScene 拍平逻辑(documentFor + normalizeDocument),但只刷 nodes/edges——不碰
   * selection/history/activeTool/viewport(用户可感状态;loadScene 重入会重置这些,故抽此共用函数)。
   * race:fetch 完成时 active ≠ sceneId(用户已切走)→ 返空不动顶层(内容留 canvases[sceneId],
   * 切回时 loadScene 自然拍平)。
   */
  refreshActiveCanvasContent: (sceneId) =>
    set((state) => {
      if (state.sceneId !== sceneId) return {} // race:已切走,不动顶层(内容留 canvases[sceneId],切回 loadScene 拍平)
      const document = normalizeDocument(documentFor(state.canvases, sceneId))
      return {
        nodes: document.nodes,
        edges: document.edges || [],
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
    if (!existing) return
    // G1-a P1-2 / A2 前置 c:metaRevision 有值 → enqueue updateCanvas(PUT,If-Match = metaRevision)。
    //   metaRevision undefined(旧 IDB 画板,未 hydrate 到服务端)→ enqueue createCanvas(POST ensureCreate
    //   带新 title)而非 updateCanvas(PUT)——PUT 对 existing 缺 If-Match base → 428(返修 #4);POST 三态
    //   (created/restored/existing)不 428 + onSuccess 回灌 metaRevision,后续 rename 用 fresh base。
    //   队列 combineOps 把 pending createCanvas + 后续 updateCanvas 合并为单 createCanvas(带最终 title),
    //   故首写改 create 不会丢 rename。standalone 画板(无 projectId)在 local 不 enqueue(local no-op);
    //   server 模式 standalone 用 firstExisting 兜底(不建 Default,避免 rename 副作用)。
    if (metaRevision !== undefined) {
      enqueuePersistWrite({
        kind: 'updateCanvas',
        canvasId: sceneId,
        projectId: existing.projectId ?? '',
        title,
        baseRevision: metaRevision,
      })
    } else {
      // PR-C1 SC-3:默认父项目取首个 active 项目(非 projects[0]),防 rename-standalone 落进 archived 项目。
      const opProjectId = existing.projectId ?? get().projects.find((p) => p.status !== 'archived')?.id ?? ''
      if (opProjectId) {
        enqueuePersistWrite({ kind: 'createCanvas', canvasId: sceneId, projectId: opProjectId, title })
      } else {
        warnCanvas(`renameCanvas ${sceneId} not enqueued: no metaRevision and no projectId (standalone, no project to persist into)`)
      }
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
      if (projectId !== undefined && state.projects.some((p) => p.id === projectId && p.status === 'archived')) {
        warnCanvas(`Move canvas blocked: target project ${projectId} is archived`)
        toastFeedback.warn('目标项目已归档,请先恢复项目再移动')
        return {}
      }
      // Target === current归属 → no-op (no bump, no log).
      if (document.projectId === projectId) return {}

      const target = projectId === undefined ? 'Canvas' : projectId
      logCanvas(`Moved canvas "${document.title}" (${canvasId}) → ${target}`)
      // G1-a P1-2 / A2 前置 c:metaRevision 有值 → enqueue updateCanvas(PUT,projectId 改 = move;move 双端 owner-only authz)。
      //   metaRevision undefined(旧 IDB 画板)→ enqueue createCanvas(POST ensureCreate,带 target projectId + title)
      //   而非 updateCanvas(PUT)——PUT 对 existing 缺 If-Match base → 428(返修 #4);POST 三态不 428 + onSuccess
      //   回灌 metaRevision。move-to-standalone(projectId undefined)无 target project → 不 enqueue(不可 persist)。
      if (document.metaRevision !== undefined) {
        enqueuePersistWrite({
          kind: 'updateCanvas',
          canvasId,
          projectId: projectId ?? '',
          title: document.title,
          baseRevision: document.metaRevision,
        })
      } else if (projectId !== undefined) {
        enqueuePersistWrite({ kind: 'createCanvas', canvasId, projectId, title: document.title })
      } else {
        warnCanvas(`moveCanvasToProject ${canvasId} not enqueued: no metaRevision and move-to-standalone (no target project to persist into)`)
      }
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

    // T2.2 Block 3:wrap the synchronous set 段 with scene-scoped server-wire。set 段是
    //   await saveGeneratedAsset 之后的同步子片段(commitGenerationResult 虽 async,但 set 本身
    //   同步);wrap 它即让 generate result 的 node-create / slot-replace edit-node 经
    //   submitChange 落 server。Block 2 的 computeAssetSideEffects assetUrl-diff 自动驱动 attach
    //   (result asset.assetUrl → server assetId → create-node/edit-node accepted 后 attach),
    //   无需手工 enqueueAssetAttach(下方原 TODO 485-488 由本接线闭环)。
    //   覆盖面:5 个 generate* 变体的 success commit 全经此(无重复包);
    //   chatTaskReconcile.reconcileExpiredChatTasks 的 commit(sceneId 锚定)亦经此
    //   → 一处接线覆盖全部 deferred generate-result 路径。local 模式 wrapMutationForScene
    //   的 isLocalPersist gate 短路,不发 submit,零行为变化。
    getSceneWrap()(targetSceneId, () => set((state) => {
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
        // T2.2 Block 3 闭环:generate 结果路径现已经 getSceneWrap() 包 set 段(见上方 wrap)→
        //   node-create / slot-replace edit-node 经 submitChange 落 server;attach 由 Block 2 的
        //   computeAssetSideEffects assetUrl-diff 自动驱动(result asset.assetUrl → server assetId →
        //   create-node/edit-node accepted 后 enqueueAssetAttach),无需此手工补 enqueueAssetAttach。
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
    }))

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
