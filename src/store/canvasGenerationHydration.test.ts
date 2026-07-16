import { describe, expect, it, vi } from 'vitest'

// Stub demo image rendering (no DOM in node test env) — matches the
// canvasStoreMigrate.test.ts hermetic pattern. canvasGenerationHydration itself
// never inspects demo-image content, so the placeholder is safe.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import { mergeCanvasPersistedState, settleExpiredCanvasGenerations, migratePersistedState } from './canvasGenerationHydration'
import { debugLogger } from '../store/debugLogStore'
import { DEMO_PROJECTS } from './demoScenes'
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

// ── Phase 1 项2(2026-07-16):orphan projectId 不再静默清空(选项 B)──────────────────
// 验收(计划 Phase 1 项2):水合时凡 projectId 不在 projects 列表的画布,旧版把 projectId **清空** → 画布甩到
//   "无项目态"(顶层 standalone)= 用户可见的"妹子"丢项目归属。改:保留不清空(项目可能仍在迁移/软删/
//   服务端侧不可见),仅 warn 计数让可观测。配套项3:停清后 orphan-parent 画布在迁移收集器跳过(防 404 死循环)。
describe('Phase 1 项2 — orphan projectId 不再静默清空(选项 B;retained, not cleared)', () => {
  it('projectId 指向不在 projects 列表的项目 → 保留不清空(不再甩到 standalone)+ warn 可观测', () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    try {
      const persisted = {
        canvases: {
          'c-mei': document({ projectId: 'p-gone' }),
        },
        projects: [] as { id: string; name: string; createdAt: string }[],
        sceneId: 'c-mei',
      }
      const migrated = migratePersistedState(persisted, 11) as unknown as CanvasState
      // 项2:projectId 保留不清空(项目可能仍在迁移/软删),不再变 undefined 甩到 standalone
      expect(migrated.canvases['c-mei'].projectId).toBe('p-gone')
      // warn 可观测(检测到 orphan,保留不清空)
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[1] === 'string' &&
            c[1].includes('orphan projectId') &&
            c[1].includes('retained, not cleared'),
        ),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('无 orphan(所有 projectId 都在 projects 列表,含 demo project 覆盖 initialCanvases)→ 不 warn,projectId 不变', () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    try {
      const persisted = {
        canvases: { c1: document({ projectId: 'p1' }) },
        // projects 须含 DEMO_PROJECTS(initialCanvases 注入的 demo 画布的 projectId 指向它们,否则被误判 orphan)
        projects: [...DEMO_PROJECTS, { id: 'p1', name: 'P1', createdAt: 't' }] as { id: string; name: string; createdAt: string }[],
        sceneId: 'c1',
      }
      const migrated = migratePersistedState(persisted, 11) as unknown as CanvasState
      expect(migrated.canvases['c1'].projectId).toBe('p1')
      expect(warnSpy.mock.calls.some((c) => typeof c[1] === 'string' && c[1].includes('orphan'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
