import type { AiWorkflowStatus, CanvasId, CanvasTask } from '../types/mivoCanvas'
import { documentFor, patchCanvasDocument } from './canvasDocumentModel'
import type { CanvasState } from './canvasStore'

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

export const settleExpiredCanvasGenerations = (
  state: Pick<CanvasState, 'canvases' | 'sceneId'>,
): { state: Pick<CanvasState, 'canvases' | 'nodes' | 'edges' | 'tasks'>; counts: CanvasGenerationSettleCounts } => {
  const counts: CanvasGenerationSettleCounts = { settledTasks: 0, settledSlots: 0 }
  const canvases = Object.fromEntries(
    Object.entries(state.canvases).map(([canvasId, document]) => {
      let changed = false
      const tasks = document.tasks.map((task) => {
        if (!expiredCanvasTaskStatuses.has(task.status)) return task
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
  migratePersistedState: (persistedState: unknown, persistedVersion?: number) => unknown,
  warn: (message: string) => void,
): CanvasState => {
  const merged = { ...currentState, ...(migratePersistedState(persistedState, 8) as Partial<CanvasState>) }
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
