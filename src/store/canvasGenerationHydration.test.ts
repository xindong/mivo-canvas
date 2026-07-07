import { describe, expect, it, vi } from 'vitest'

// Stub demo image rendering (no DOM in node test env) — matches the
// canvasStoreMigrate.test.ts hermetic pattern. canvasGenerationHydration itself
// never inspects demo-image content, so the placeholder is safe.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import { mergeCanvasPersistedState, settleExpiredCanvasGenerations } from './canvasGenerationHydration'
import type { CanvasState } from './canvasStore'
import type { CanvasDocument, CanvasId } from '../types/mivoCanvas'
import type { CanvasTask, MivoCanvasNode } from '../types/mivoCanvas'

// Helpers ---------------------------------------------------------------------

const task = (overrides: Partial<CanvasTask> = {}): CanvasTask => ({
  id: 'task-1',
  label: 'task',
  status: 'done',
  progress: 100,
  nodeIds: [],
  ...overrides,
})

const slotNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'slot-1',
  type: 'ai-slot',
  title: 'Slot',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'generating',
  aiWorkflow: { kind: 'slot', status: 'generating', operation: 'slot-generation', prompt: 'p' },
  ...overrides,
})

const document = (overrides: Partial<CanvasDocument> = {}): CanvasDocument => ({
  title: 'demo',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  ...overrides,
})

const buildState = (
  canvases: Record<CanvasId, CanvasDocument>,
  sceneId: CanvasId = 'character-flow',
): Pick<CanvasState, 'canvases' | 'sceneId'> => ({
  canvases,
  sceneId,
})

const minimalCurrentState = () => ({}) as unknown as CanvasState

const identityMigrate = (state: unknown) => state

// Tests -----------------------------------------------------------------------

describe('settleExpiredCanvasGenerations: preset task skip (SC-4)', () => {
  it('skips preset running/queued tasks and leaves them in seed state', () => {
    const presetRunning = task({
      id: 'task-running',
      label: '图生图变体生成中',
      status: 'running',
      progress: 62,
      preset: true,
    })
    const presetQueued = task({
      id: 'task-asset',
      label: '3 张候选已收束，1 张待入库',
      status: 'queued',
      progress: 38,
      preset: true,
    })
    const state = buildState({
      'character-flow': document({ tasks: [presetRunning, presetQueued] }),
    })

    const result = settleExpiredCanvasGenerations(state)

    expect(result.counts.settledTasks).toBe(0)
    const tasks = result.state.canvases['character-flow'].tasks
    expect(tasks[0].status).toBe('running')
    expect(tasks[0].label).toBe('图生图变体生成中')
    expect(tasks[1].status).toBe('queued')
    expect(tasks[1].label).toBe('3 张候选已收束，1 张待入库')
  })

  it('settles non-preset running/queued tasks to failed with the expired label (boundary: non-preset照清)', () => {
    const realRunning = task({ id: 'task-1', label: '生成中', status: 'running', progress: 42 })
    const state = buildState({
      'character-flow': document({ tasks: [realRunning] }),
    })

    const result = settleExpiredCanvasGenerations(state)

    expect(result.counts.settledTasks).toBe(1)
    const settled = result.state.canvases['character-flow'].tasks[0]
    expect(settled.status).toBe('failed')
    expect(settled.label).toBe('生成中（任务已过期，请重试）')
  })

  it('mixes: settles non-preset but skips preset in the same canvas', () => {
    const presetRunning = task({
      id: 'task-running',
      label: '图生图变体生成中',
      status: 'running',
      progress: 62,
      preset: true,
    })
    const realRunning = task({ id: 'task-1', label: '其他任务', status: 'running', progress: 10 })
    const state = buildState({
      'character-flow': document({ tasks: [presetRunning, realRunning] }),
    })

    const result = settleExpiredCanvasGenerations(state)

    expect(result.counts.settledTasks).toBe(1)
    const tasks = result.state.canvases['character-flow'].tasks
    expect(tasks[0].status).toBe('running') // preset skipped
    expect(tasks[1].status).toBe('failed') // non-preset settled
  })

  it('still settles generating ai-slots (preset only applies to tasks, not slots)', () => {
    const state = buildState({
      'character-flow': document({ nodes: [slotNode()] }),
    })

    const result = settleExpiredCanvasGenerations(state)

    expect(result.counts.settledSlots).toBe(1)
    const node = result.state.canvases['character-flow'].nodes[0]
    expect(node.status).toBe('failed')
    expect(node.aiWorkflow?.status).toBe('failed')
  })
})

describe('mergeCanvasPersistedState: hydration warning (SC-4 / #60 no regression)', () => {
  it('emits the hydration warning when non-preset tasks/slots are settled', () => {
    const persisted = {
      canvases: {
        'character-flow': document({
          nodes: [slotNode()],
          tasks: [task({ id: 'task-1', label: '生成中', status: 'running', progress: 42 })],
        }),
      },
      sceneId: 'character-flow',
    }

    const warn = vi.fn()
    const merged = mergeCanvasPersistedState(persisted, minimalCurrentState(), identityMigrate, warn)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Hydration settled expired canvas generations')
    expect(merged.canvases['character-flow'].tasks[0].status).toBe('failed')
    expect(merged.canvases['character-flow'].nodes[0].status).toBe('failed')
  })

  it('does NOT emit the hydration warning when only preset tasks are present (boundary: preset跳过)', () => {
    const persisted = {
      canvases: {
        'task-states': document({
          tasks: [
            task({
              id: 'task-running',
              label: '图生图变体生成中',
              status: 'running',
              progress: 62,
              preset: true,
            }),
          ],
        }),
      },
      sceneId: 'task-states',
    }

    const warn = vi.fn()
    const merged = mergeCanvasPersistedState(persisted, minimalCurrentState(), identityMigrate, warn)

    expect(warn).not.toHaveBeenCalled()
    expect(merged.canvases['task-states'].tasks[0].status).toBe('running')
  })
})
