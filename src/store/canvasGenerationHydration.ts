import type { AiWorkflowStatus, CanvasId, CanvasTask } from '../types/mivoCanvas'
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
import type { CanvasState } from './canvasStore'

// Local mirror of canvasStore.logCanvas so this module can log migration
// events without a runtime cycle (canvasStore imports mergeCanvasPersistedState
// / migratePersistedState from here). Both write to the same Debug Log source.
const logCanvas = (message: string) => debugLogger.log('Canvas Store', message)
const warnCanvas = (message: string) => debugLogger.warn('Canvas Store', message)

// Persisted-state shape (subset of CanvasState that survives compactCanvasesForPersist).
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

  return {
    ...persisted,
    canvases,
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
  const merged = { ...currentState, ...(migrate(persistedState, 9) as Partial<CanvasState>) }
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
