import type { AiWorkflowStatus, CanvasDocument, CanvasId, CanvasTask, DemoSceneId } from '../types/mivoCanvas'
import { defaultStampKind } from '../canvas/stampDefs'
import { debugLogger } from './debugLogStore'
import {
  defaultBrushStyle,
  documentFor,
  initialCanvases,
  normalizeDocument,
  normalizeLongMarkdownPreviewNodes,
  patchCanvasDocument,
  selectionFrom,
} from './canvasDocumentModel'
import { DEMO_PROJECTS, DEMO_SCENE_PROJECT_MAP } from './demoScenes'
import type { CanvasState } from './canvasStore'

// Local mirror of canvasStore.logCanvas so this module can log migration
// events without a runtime cycle (canvasStore imports mergeCanvasPersistedState
// / migratePersistedState from here). Both write to the same Debug Log source.
const logCanvas = (message: string) => debugLogger.log('Canvas Store', message)
const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)

// Single source of truth for the persist version. Shared by canvasPersistConfig
// (the persist `version` field) and mergeCanvasPersistedState (the migrate call
// inside merge) so the merge always re-runs migration at the current version
// rather than a stale hardcoded number — otherwise every hydration would re-run
// the v9 branches (duplicate warns / duplicate orphan cleanup).
export const CANVAS_PERSIST_VERSION = 10

// Persisted-state shape (subset of CanvasState that survives compactCanvasesForPersist).
type PersistedCanvasState = Partial<
  Pick<
    CanvasState,
    | 'canvases'
    | 'projects'
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

const expiredCanvasTaskStatuses = new Set<CanvasTask['status']>(['running', 'queued'])
const expiredAiWorkflowStatuses = new Set<AiWorkflowStatus>(['generating', 'queued'])

export type CanvasGenerationSettleCounts = {
  settledTasks: number
  settledSlots: number
}

const expiredTaskLabel = (label: string) =>
  label.includes('任务已过期') ? label : `${label}（任务已过期，请重试）`

const settledTaskLabel = (label: string, status: 'failed' | 'canceled') => {
  if (status === 'failed') return label.includes('失败') ? label : `${label}（失败）`
  return label.includes('取消') ? label : `${label}（已取消）`
}

// Persisted-state migration. Exported so canvasStoreMigrate.test.ts can cover
// the v6/v8/v9 branches (flat-state compat, <6 markdown normalization, <8
// brushStyle reset, <9 preset-task restoration). Re-exported by canvasStore
// for the persist `migrate` option + test imports.
export const migratePersistedState = (persistedState: unknown, persistedVersion = 0) => {
  const persisted = (persistedState || {}) as PersistedCanvasState
  const shouldNormalizeLongMarkdown = persistedVersion < 6
  // Captured once so the v<9 preset-task restoration (below) can source seed
  // status/label/progress/stage from demoScenes without drifting copies.
  const initial = initialCanvases()
  const canvases = {
    ...initial,
    ...(persisted.canvases || {}),
  }

  // S03: per-canvas try/catch——单条损坏画布不再让整个 migrate 抛掉。normalizeDocument
  // 对非数组 nodes/edges/tasks 会抛 TypeError（cloneNodes → .map），try 捕获后用初始
  // 画布回退（demo scene id 命中 `initial`）或删除条目（自定义 id），其余画布不受影响。
  Object.entries(canvases).forEach(([id, document]) => {
    try {
      const normalizedDocument = normalizeDocument(document)
      canvases[id] = shouldNormalizeLongMarkdown
        ? {
            ...normalizedDocument,
            nodes: normalizeLongMarkdownPreviewNodes(normalizedDocument.nodes),
          }
        : normalizedDocument
    } catch (error) {
      warnCanvas(`hydration 丢弃损坏画布 ${id}，其余画布不受影响：${error instanceof Error ? error.message : String(error)}`)
      const fallback = initial[id]
      if (fallback) canvases[id] = fallback
      else delete canvases[id]
    }
  })
  const sceneId =
    persisted.sceneId && canvases[persisted.sceneId]
      ? persisted.sceneId
      : 'character-flow'

  // S03: legacy flat-state 分支同样纳入防护。入口加最小形状校验（nodes/tasks 须为数组；
  // edges 存在时也须为数组），并把 normalizeDocument 包 try/catch——失败时 warnCanvas 后
  // 跳过整个 legacy overlay，保留上方已修复的 canvases。
  if (Array.isArray(persisted.nodes) && Array.isArray(persisted.tasks)) {
    try {
      if (persisted.edges !== undefined && !Array.isArray(persisted.edges)) {
        throw new Error('persisted.edges 不是数组')
      }
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
    } catch (error) {
      warnCanvas(`hydration 跳过 legacy flat-state overlay（损坏）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Version 9 introduced the `preset` marker on demo seed tasks (task-running,
  // task-asset) so the hydration settle pass skips them (see
  // settleExpiredCanvasGenerations). Legacy persisted v<9 state may have
  // already settled these seed tasks to failed + "（任务已过期，请重试）" on a
  // prior boot; restore their seed form so the demo doesn't ship with red
  // warning badges. Only the two fixed seed ids are touched — real/user tasks
  // are never modified. Seed values come from `initial` (initialCanvases) so
  // they stay in sync with demoScenes.ts.
  if (persistedVersion < 9) {
    const seedTasksById = new Map<string, CanvasTask>()
    for (const document of Object.values(initial)) {
      for (const task of document.tasks) {
        if (task.id === 'task-running' || task.id === 'task-asset') {
          seedTasksById.set(task.id, task)
        }
      }
    }
    let restoredCount = 0
    for (const [canvasId, document] of Object.entries(canvases)) {
      if (!document.tasks) continue
      let tasksChanged = false
      const tasks = document.tasks.map((task) => {
        const seed = seedTasksById.get(task.id)
        if (!seed) return task
        tasksChanged = true
        restoredCount += 1
        return { ...seed, nodeIds: task.nodeIds }
      })
      if (tasksChanged) {
        canvases[canvasId] = { ...document, tasks }
      }
    }
    if (restoredCount > 0) {
      logCanvas(`Hydration restored ${restoredCount} preset seed task(s) to seed form (migrated v${persistedVersion} → v9)`)
    }
  }

  const activeDocument = documentFor(canvases, sceneId)
  const selection = selectionFrom(activeDocument.selectedNodeIds, activeDocument.selectedNodeId, activeDocument.nodes)

  // v10: projects field + orphan projectId cleanup. At v<10 the field didn't
  // exist, so projects defaults to [] and EVERY canvas with a projectId is an
  // orphan (cleared). 后续版本同规则: at v10+ only projectIds pointing to a
  // project missing from the projects list are cleared. normalizeDocument
  // already backfilled createdAt/updatedAt per-canvas above; orphan cleanup is
  // a separate concern (reclassification, not a content change — no bump).
  const baseProjects = Array.isArray(persisted.projects) ? persisted.projects : []
  // v9→v10 one-time relink: when demo scene canvases are present without a
  // projectId (v9 had no projects field, so demo scenes migrated up ungrouped),
  // seed the two demo projects and re-attach them. Gated STRICTLY on
  // persistedVersion < 10 — the every-hydration re-migrate (merge calls migrate
  // with version=CANVAS_PERSIST_VERSION=10) must NOT re-run this, otherwise a
  // user who deleted the Concept Battlepass project would see it revive on
  // refresh. Seeding is conditional on demo canvases existing (per spec: 若 demo
  // 场景画板存在且 projectId 为空 → 补种并挂回) so a custom v9 workspace without
  // demo scenes does not gain empty demo projects. Relink runs before orphan
  // cleanup so the seeded projects are in the known set when orphans are checked.
  let projects = baseProjects
  if (persistedVersion < 10) {
    const targets: Array<{ canvasId: CanvasId; document: CanvasDocument; projectId: string }> = []
    for (const [canvasId, document] of Object.entries(canvases)) {
      const demoProjectId = DEMO_SCENE_PROJECT_MAP[canvasId as DemoSceneId]
      if (demoProjectId && !document.projectId) {
        targets.push({ canvasId: canvasId as CanvasId, document, projectId: demoProjectId })
      }
    }
    if (targets.length > 0) {
      const existingIds = new Set(baseProjects.map((p) => p.id))
      projects = baseProjects.concat(DEMO_PROJECTS.filter((p) => !existingIds.has(p.id)))
      for (const { canvasId, document, projectId } of targets) {
        canvases[canvasId] = { ...document, projectId }
      }
      logCanvas(
        `Hydration seeded ${projects.length - baseProjects.length} demo project(s) and relinked ${targets.length} demo canvas(es) (migrated v${persistedVersion} → v10)`,
      )
    }
  }
  const knownProjectIds = new Set(projects.map((p) => p.id))
  let orphanCount = 0
  for (const [canvasId, document] of Object.entries(canvases)) {
    if (document.projectId && !knownProjectIds.has(document.projectId)) {
      orphanCount += 1
      canvases[canvasId] = { ...document, projectId: undefined }
    }
  }
  if (orphanCount > 0) {
    warnCanvas(`Hydration cleared ${orphanCount} orphan projectId(s) (not in projects list)`)
  }

  return {
    ...persisted,
    canvases,
    projects,
    sceneId,
    nodes: activeDocument.nodes,
    edges: activeDocument.edges || [],
    tasks: activeDocument.tasks,
    selectedNodeId: selection.selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    activeTool: ['comment', 'image', 'video'].includes(String(persisted.activeTool)) ? 'select' : persisted.activeTool || 'select',
    clipboardNodes: [],
    clipboardAssets: [],
    // Version 8 introduced the black default and eraser mode; older persisted styles reset to the new default.
    brushStyle: persistedVersion < 8 ? defaultBrushStyle : persisted.brushStyle || defaultBrushStyle,
    activeStampKind: persisted.activeStampKind || defaultStampKind,
    lastPlacedStampId: undefined,
    historyPast: [],
    historyFuture: [],
  }
}

export const settleExpiredCanvasGenerations = (
  state: Pick<CanvasState, 'canvases' | 'sceneId'>,
): { state: Pick<CanvasState, 'canvases' | 'nodes' | 'edges' | 'tasks'>; counts: CanvasGenerationSettleCounts } => {
  const counts: CanvasGenerationSettleCounts = { settledTasks: 0, settledSlots: 0 }
  const canvases = Object.fromEntries(
    Object.entries(state.canvases).map(([canvasId, document]) => {
      let changed = false
      const tasks = document.tasks.map((task) => {
        // Preset demo seed tasks (task-running, task-asset) opt out of the
        // expired-generation settle pass — they are intentionally left in
        // running/queued state to showcase the demo, not zombie generations.
        if (!expiredCanvasTaskStatuses.has(task.status) || task.preset) return task
        counts.settledTasks += 1
        changed = true
        return { ...task, status: 'failed' as const, stage: 'failed', label: expiredTaskLabel(task.label) }
      })
      const nodes = document.nodes.map((node) => {
        if (
          node.type !== 'ai-slot' ||
          !node.aiWorkflow?.status ||
          !expiredAiWorkflowStatuses.has(node.aiWorkflow.status)
        ) {
          return node
        }
        counts.settledSlots += 1
        changed = true
        return {
          ...node,
          status: node.status === 'generating' || node.status === 'queued' ? 'failed' as const : node.status,
          aiWorkflow: { ...node.aiWorkflow, status: 'failed' as const },
        }
      })
      return [canvasId, changed ? { ...document, nodes, tasks } : document]
    }),
  ) as CanvasState['canvases']
  const activeDocument = documentFor(canvases, state.sceneId)
  return {
    state: { canvases, nodes: activeDocument.nodes, edges: activeDocument.edges || [], tasks: activeDocument.tasks },
    counts,
  }
}

export const mergeCanvasPersistedState = (
  persistedState: unknown,
  currentState: CanvasState,
  migrate: (persistedState: unknown, persistedVersion?: number) => unknown,
  warn: (message: string) => void,
): CanvasState => {
  // Fresh install (no persisted IDB state — getItem returned null): keep the
  // initial default state, which already seeds the demo projects + demo-scene
  // projectIds (createProjectsSlice / canvasDocumentFromScene). Re-running
  // migrate(null, 10) here would reset projects to [] and clobber that fresh
  // default, hiding the demo project grouping in the sidebar. There are no
  // persisted generations to settle either, so return currentState as-is.
  if (persistedState == null) {
    return currentState
  }
  // Re-run migrate at the CURRENT persist version (not a stale hardcoded 9) so
  // the v10 orphan-cleanup / timestamp-backfill branches apply on every
  // hydration. migrate is idempotent for already-v10 state (normalizeDocument
  // preserves existing timestamps; orphan cleanup is a no-op when projectIds
  // are all valid).
  const merged = { ...currentState, ...(migrate(persistedState, CANVAS_PERSIST_VERSION) as Partial<CanvasState>) }
  const result = settleExpiredCanvasGenerations(merged)
  if (result.counts.settledTasks > 0 || result.counts.settledSlots > 0) {
    warn(`Hydration settled expired canvas generations: slots=${result.counts.settledSlots}; tasks=${result.counts.settledTasks}`)
  }
  return { ...merged, ...result.state }
}

export const settleCanvasGenerationInState = (
  current: CanvasState,
  options: { sceneId: CanvasId; slotId?: string; taskId?: string; status: 'failed' | 'canceled' },
): { patch: Partial<CanvasState>; counts: CanvasGenerationSettleCounts } => {
  const counts: CanvasGenerationSettleCounts = { settledTasks: 0, settledSlots: 0 }
  if (!options.slotId && !options.taskId) return { patch: {}, counts }
  const document = current.canvases[options.sceneId]
  if (!document) return { patch: {}, counts }

  const slot = options.slotId
    ? document.nodes.find((node) => node.id === options.slotId && node.type === 'ai-slot')
    : undefined
  const taskId = options.taskId || slot?.generation?.taskId
  let changed = false

  const nodes = document.nodes.map((node) => {
    if (
      !options.slotId ||
      node.id !== options.slotId ||
      node.type !== 'ai-slot' ||
      !node.aiWorkflow?.status ||
      !expiredAiWorkflowStatuses.has(node.aiWorkflow.status)
    ) {
      return node
    }
    counts.settledSlots += 1
    changed = true
    return {
      ...node,
      status: node.status === 'generating' || node.status === 'queued' ? 'failed' as const : node.status,
      aiWorkflow: { ...node.aiWorkflow, status: options.status },
    }
  })

  const tasks = document.tasks.map((task) => {
    if (!taskId || task.id !== taskId || !expiredCanvasTaskStatuses.has(task.status)) return task
    counts.settledTasks += 1
    changed = true
    return { ...task, status: options.status, stage: options.status, label: settledTaskLabel(task.label, options.status) }
  })

  return { patch: changed ? patchCanvasDocument(current, options.sceneId, { nodes, tasks }) : {}, counts }
}
