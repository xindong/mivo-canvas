import { describe, expect, it, vi } from 'vitest'

// Importing canvasStore triggers `scenes()` at module load, which renders demo images
// via an HTML canvas (`document.createElement('canvas')`). The node test environment has
// no DOM, so we stub `createDemoImage` to a plain data URL — the migrate function never
// inspects demo-image content, so the placeholder is safe and keeps the test hermetic.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import { migratePersistedState } from './canvasStore'
import { DEMO_PROJECTS, DEMO_PROJECT_IDS, DEMO_SCENE_PROJECT_MAP } from './demoScenes'
import type { MivoCanvasNode, CanvasTask } from '../types/mivoCanvas'
import type { BrushStyle } from './canvasStore'

// Helpers ---------------------------------------------------------------------

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'img-1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  assetUrl: '/a.png',
  ...overrides,
})

const longMarkdownNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'md-1',
  type: 'markdown',
  title: 'Long doc',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'ready',
  text: 'x'.repeat(3600), // > 3500 chars triggers markdownShouldUsePreviewMode
  ...overrides,
})

const task = (overrides: Partial<CanvasTask> = {}): CanvasTask => ({
  id: 'task-1',
  label: 'task',
  status: 'done',
  progress: 100,
  nodeIds: ['img-1'],
  ...overrides,
})

const defaultBrushStyle: BrushStyle = { color: '#232323', width: 4, kind: 'marker' }

// Tests -----------------------------------------------------------------------

describe('migratePersistedState (canvas persist v8)', () => {
  describe('flat-state compatibility (top-level nodes/tasks/edges)', () => {
    it('merges persisted top-level nodes/tasks into the active scene and surfaces them on the result', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [imageNode()],
          tasks: [task()],
          selectedNodeId: 'img-1',
          selectedNodeIds: ['img-1'],
        },
        7,
      )

      expect(result.sceneId).toBe('character-flow')
      expect(result.nodes.map((n) => n.id)).toContain('img-1')
      expect(result.tasks.map((t) => t.id)).toContain('task-1')
      expect(result.selectedNodeId).toBe('img-1')
      // v2 normalization augments the node with transform/fills/asset
      const node = result.nodes.find((n) => n.id === 'img-1')
      expect(node?.transform).toEqual({ x: 10, y: 20, width: 300, height: 200, rotation: 0 })
      expect(node?.asset).toEqual({ url: '/a.png' })
    })

    it('uses edges from persisted flat-state when provided', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [imageNode({ id: 'a' }), imageNode({ id: 'b', x: 400 })],
          edges: [{ id: 'e1', from: 'a', to: 'b', type: 'generate', prompt: 'p', createdAt: 1 }],
          tasks: [task()],
        },
        7,
      )

      expect(result.edges.map((e) => e.id)).toContain('e1')
    })

    it('falls back to the default scene when persisted.sceneId is unknown', () => {
      const result = migratePersistedState(
        { sceneId: 'does-not-exist', nodes: [imageNode()], tasks: [task()] },
        7,
      )

      expect(result.sceneId).toBe('character-flow')
    })
  })

  describe('<6 markdown normalization branch', () => {
    it('forces long-markdown nodes into preview display mode at version 5', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [longMarkdownNode()],
          tasks: [task()],
        },
        5,
      )

      const md = result.nodes.find((n) => n.id === 'md-1')
      expect(md?.markdownDisplayMode).toBe('preview')
      expect(md?.width).toBe(560)
      expect(md?.height).toBe(620)
    })

    it('does not force preview mode at version 6+ (preserves whatever was persisted)', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          nodes: [longMarkdownNode({ markdownDisplayMode: 'full', width: 100, height: 100 })],
          tasks: [task()],
        },
        6,
      )

      const md = result.nodes.find((n) => n.id === 'md-1')
      expect(md?.markdownDisplayMode).toBe('full')
      expect(md?.width).not.toBe(560)
    })
  })

  describe('<8 brushStyle reset branch', () => {
    it('resets brushStyle to the default at version 7 (ignores persisted custom style)', () => {
      const custom: BrushStyle = { color: '#ff0000', width: 10, kind: 'highlighter' }
      const result = migratePersistedState(
        { sceneId: 'character-flow', brushStyle: custom } as never,
        7,
      )

      expect(result.brushStyle).toEqual(defaultBrushStyle)
      expect(result.brushStyle).not.toEqual(custom)
    })

    it('preserves the persisted brushStyle at version 8', () => {
      const custom: BrushStyle = { color: '#ff0000', width: 10, kind: 'highlighter' }
      const result = migratePersistedState({ brushStyle: custom } as never, 8)

      expect(result.brushStyle).toEqual(custom)
    })

    it('falls back to the default when persisted.brushStyle is missing at version 8', () => {
      const result = migratePersistedState({} as never, 8)

      expect(result.brushStyle).toEqual(defaultBrushStyle)
    })
  })

  describe('runtime fields reset on every migration', () => {
    it('clears clipboard and history regardless of persisted values', () => {
      const result = migratePersistedState(
        {
          sceneId: 'character-flow',
          // these should NOT survive migration
          clipboardNodes: [imageNode()] as never,
          clipboardAssets: [{ x: 1 } as never] as never,
        } as never,
        8,
      )

      expect(result.clipboardNodes).toEqual([])
      expect(result.clipboardAssets).toEqual([])
      expect(result.historyPast).toEqual([])
      expect(result.historyFuture).toEqual([])
    })

    it('defaults activeTool to select when persisted value is missing', () => {
      const result = migratePersistedState({} as never, 8)
      expect(result.activeTool).toBe('select')
    })

    it('preserves a persisted activeTool', () => {
      const result = migratePersistedState({ activeTool: 'brush' } as never, 8)
      expect(result.activeTool).toBe('brush')
    })

    it.each(['comment', 'image', 'video'])('falls back from removed activeTool "%s"', (activeTool) => {
      const result = migratePersistedState({ activeTool } as never, 8)
      expect(result.activeTool).toBe('select')
    })
  })

  describe('S03: hydration corrupt-entry isolation', () => {
    it('drops a single corrupt canvas while preserving the rest (two good, one bad)', () => {
      const good1 = { title: 'g1', nodes: [imageNode({ id: 'g1-img' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
      const good2 = { title: 'g2', nodes: [imageNode({ id: 'g2-img' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
      const bad = { title: 'bad', nodes: 42 as never, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }

      const result = migratePersistedState(
        { sceneId: 'g1', canvases: { g1: good1, g2: good2, 'bad-canvas': bad } },
        8,
      )

      expect(result.canvases.g1.nodes.map((n) => n.id)).toContain('g1-img')
      expect(result.canvases.g2.nodes.map((n) => n.id)).toContain('g2-img')
      expect(result.canvases['bad-canvas']).toBeUndefined() // 自定义 id 无 fallback → 删除
      expect(result.sceneId).toBe('g1')
    })

    it('falls back to the default scene when the active canvas is the corrupt one', () => {
      const good = { title: 'g', nodes: [imageNode({ id: 'g-img' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
      const bad = { title: 'bad', nodes: {} as never, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }

      const result = migratePersistedState(
        { sceneId: 'bad-active', canvases: { 'good-scene': good, 'bad-active': bad } },
        8,
      )

      expect(result.canvases['good-scene'].nodes.map((n) => n.id)).toContain('g-img')
      expect(result.canvases['bad-active']).toBeUndefined()
      expect(result.sceneId).toBe('character-flow') // 坏活跃画布 → 回落默认
    })

    it('restores the initial demo canvas when a corrupt entry has a demo scene id', () => {
      const bad = { title: 'bad', nodes: 42 as never, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }

      const result = migratePersistedState(
        { sceneId: 'character-flow', canvases: { 'character-flow': bad } },
        8,
      )

      expect(result.canvases['character-flow']).toBeDefined()
      expect(Array.isArray(result.canvases['character-flow'].nodes)).toBe(true)
      expect(result.sceneId).toBe('character-flow')
    })

    it('skips the legacy flat-state overlay when top-level nodes is corrupt (non-array)', () => {
      const good = { title: 'g', nodes: [imageNode({ id: 'g-img' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }

      const result = migratePersistedState(
        { sceneId: 'g', canvases: { g: good }, nodes: 42 as never, tasks: [task()] },
        7,
      )

      // canvases 保留；legacy overlay 未进入（nodes 非数组），不抛错
      expect(result.canvases.g.nodes.map((n) => n.id)).toContain('g-img')
      expect(result.sceneId).toBe('g')
    })

    it('skips the legacy flat-state overlay when edges is corrupt but nodes/tasks are arrays', () => {
      const good = { title: 'g', nodes: [imageNode({ id: 'g-img' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }

      const result = migratePersistedState(
        {
          sceneId: 'g',
          canvases: { g: good },
          nodes: [imageNode({ id: 'legacy-img' })],
          edges: 42 as never,
          tasks: [task()],
        },
        7,
      )

      // canvases 保留（overlay 抛错被 catch，跳过）
      expect(result.canvases.g.nodes.map((n) => n.id)).toContain('g-img')
      // legacy overlay 未应用（g 仍是原 good，没被 legacy 覆盖）
      expect(result.canvases.g.nodes.some((n) => n.id === 'legacy-img')).toBe(false)
    })

    it('is idempotent: migrating twice yields the same result', () => {
      const good = { title: 'g', nodes: [imageNode({ id: 'g-img' })], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
      const input = { sceneId: 'g', canvases: { g: good } }

      const first = migratePersistedState(input, 8)
      const second = migratePersistedState(first, 8)

      expect(second.canvases.g.nodes.map((n) => n.id)).toEqual(first.canvases.g.nodes.map((n) => n.id))
      expect(second.sceneId).toBe(first.sceneId)
    })
  })
})

// SC-2: legacy persisted v<9 state may have the demo seed tasks (task-running,
// task-asset) already settled to failed + "（任务已过期，请重试）" by a prior boot's
// hydration settle pass. The v<9 migration branch restores their seed form so
// the demo doesn't ship with red warning badges. Only these two fixed ids are
// touched — real/user tasks pass through untouched.
describe('v9 preset task restoration (persistedVersion < 9)', () => {
  const expiredSuffix = '（任务已过期，请重试）'

  it('restores polluted task-running and task-asset to seed form at version 8', () => {
    // Simulate a legacy v8 persisted state where a prior boot's settle pass
    // already failed the two demo seed tasks.
    const pollutedCanvases = {
      'task-states': {
        title: '任务状态',
        nodes: [],
        edges: [],
        tasks: [
          {
            id: 'task-running',
            label: `图生图变体生成中${expiredSuffix}`,
            status: 'failed',
            progress: 62,
            stage: 'failed',
            nodeIds: ['loading-task'],
          },
        ],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      },
      'asset-handoff': {
        title: '资产入库流程',
        nodes: [],
        edges: [],
        tasks: [
          {
            id: 'task-asset',
            label: `3 张候选已收束，1 张待入库${expiredSuffix}`,
            status: 'failed',
            progress: 38,
            stage: 'failed',
            nodeIds: ['asset-final-a'],
          },
        ],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      },
    }

    const result = migratePersistedState(
      { sceneId: 'task-states', canvases: pollutedCanvases } as never,
      8,
    )

    const restoredRunning = result.canvases['task-states'].tasks.find((t) => t.id === 'task-running')!
    expect(restoredRunning.status).toBe('running')
    expect(restoredRunning.label).toBe('图生图变体生成中')
    expect(restoredRunning.progress).toBe(62)
    expect(restoredRunning.stage).toBeUndefined()
    expect(restoredRunning.preset).toBe(true)

    const restoredAsset = result.canvases['asset-handoff'].tasks.find((t) => t.id === 'task-asset')!
    expect(restoredAsset.status).toBe('queued')
    expect(restoredAsset.label).toBe('3 张候选已收束，1 张待入库')
    expect(restoredAsset.progress).toBe(38)
    expect(restoredAsset.stage).toBeUndefined()
    expect(restoredAsset.preset).toBe(true)
  })

  it('does NOT touch non-preset user tasks during v8 → v9 restoration', () => {
    const userTask = {
      id: 'task-custom',
      label: '用户自定义任务',
      status: 'failed' as const,
      progress: 50,
      stage: 'failed',
      nodeIds: ['img-1'],
    }

    const result = migratePersistedState(
      {
        sceneId: 'character-flow',
        canvases: {
          'character-flow': {
            title: '角色流程',
            nodes: [],
            edges: [],
            tasks: [userTask],
            selectedNodeId: undefined,
            selectedNodeIds: [],
          },
        },
      } as never,
      8,
    )

    const task = result.canvases['character-flow'].tasks[0]
    expect(task.id).toBe('task-custom')
    expect(task.status).toBe('failed') // unchanged — restoration only targets task-running/task-asset
    expect(task.label).toBe('用户自定义任务')
    expect(task.preset).toBeUndefined()
  })

  it('does not restore at version 9 (preset tasks pass through as-is)', () => {
    // At version 9 the v<9 branch is a no-op; preset tasks already carry
    // preset:true in persisted state and the settle pass skips them.
    const result = migratePersistedState(
      {
        sceneId: 'task-states',
        canvases: {
          'task-states': {
            title: '任务状态',
            nodes: [],
            edges: [],
            tasks: [
              {
                id: 'task-running',
                label: '图生图变体生成中',
                status: 'running',
                progress: 62,
                nodeIds: ['loading-task'],
                preset: true,
              },
            ],
            selectedNodeId: undefined,
            selectedNodeIds: [],
          },
        },
      } as never,
      9,
    )

    const task = result.canvases['task-states'].tasks[0]
    expect(task.status).toBe('running')
    expect(task.preset).toBe(true)
  })
})

// SC-6 / Phase 1 (C3 / C12): v9 → v10 migration. Introduces the `projects` field,
// backfills createdAt/updatedAt on every canvas (defensive — normalizeDocument
// handles missing timestamps at all versions), and clears orphan projectIds
// (projectId pointing to a project not in the projects list). At v<10 projects is
// necessarily empty, so every canvas with a projectId is treated as an orphan.
describe('v10 migration (persistedVersion < 10): projects + timestamps + orphan cleanup', () => {
  it('seeds demo projects and relinks demo scene canvases at v9 (persistedVersion < 10)', () => {
    const result = migratePersistedState(
      {
        sceneId: 'character-flow',
        canvases: {
          'character-flow': { title: 'C', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      9,
    )

    // v9 had no projects field → the demo scene canvas relinks to its demo project
    // and the two demo projects are seeded (guardrail 4a).
    expect(result.projects).toEqual(DEMO_PROJECTS)
    expect(result.canvases['character-flow'].projectId).toBe(DEMO_PROJECT_IDS.conceptBattlepass)
  })

  it('does NOT seed demo projects at v9 when no demo scene canvases are present (custom workspace)', () => {
    const result = migratePersistedState(
      {
        sceneId: 'c1',
        canvases: {
          c1: { title: 'C1', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      9,
    )

    // No demo scene canvases to relink → no seeding → projects stay empty so a
    // custom v9 workspace does not gain empty demo projects.
    expect(result.projects).toEqual([])
    expect(result.canvases.c1.projectId).toBeUndefined()
  })

  it('backfills createdAt/updatedAt on every canvas missing timestamps', () => {
    const before = Date.now()
    const result = migratePersistedState(
      {
        sceneId: 'c1',
        canvases: {
          c1: { title: 'C1', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
          c2: { title: 'C2', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      9,
    )
    const after = Date.now()

    for (const id of ['c1', 'c2']) {
      const doc = result.canvases[id]
      expect(doc.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(doc.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const ms = Date.parse(doc.updatedAt)
      expect(ms >= before).toBe(true)
      expect(ms <= after).toBe(true)
    }
  })

  it('clears orphan projectIds at v9 (projects is empty → every projectId is an orphan)', () => {
    const result = migratePersistedState(
      {
        sceneId: 'c1',
        canvases: {
          c1: { title: 'C1', projectId: 'project-ghost', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      9,
    )

    expect(result.projects).toEqual([])
    expect(result.canvases.c1.projectId).toBeUndefined()
  })

  it('preserves a valid projectId when the project exists in the projects list (v10)', () => {
    const result = migratePersistedState(
      {
        sceneId: 'c1',
        projects: [{ id: 'p1', name: 'P', createdAt: '2026-01-01T00:00:00.000Z' }],
        canvases: {
          c1: { title: 'C1', projectId: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      10,
    )

    expect(result.projects).toHaveLength(1)
    expect(result.canvases.c1.projectId).toBe('p1')
  })

  it('clears orphan projectIds at v10 too (后续版本同规则)', () => {
    const result = migratePersistedState(
      {
        sceneId: 'c1',
        projects: [{ id: 'p1', name: 'P', createdAt: '2026-01-01T00:00:00.000Z' }],
        canvases: {
          c1: { title: 'C1', projectId: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
          c2: { title: 'C2', projectId: 'project-ghost', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      10,
    )

    expect(result.canvases.c1.projectId).toBe('p1') // valid — kept
    expect(result.canvases.c2.projectId).toBeUndefined() // orphan — cleared
  })

  it('preserves existing timestamps at v10 (no re-backfill)', () => {
    const result = migratePersistedState(
      {
        sceneId: 'c1',
        projects: [],
        canvases: {
          c1: { title: 'C1', createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-03-03T00:00:00.000Z', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        },
      } as never,
      10,
    )

    expect(result.canvases.c1.createdAt).toBe('2026-02-02T00:00:00.000Z')
    expect(result.canvases.c1.updatedAt).toBe('2026-03-03T00:00:00.000Z')
  })
})

describe('v10 demo project relink (guardrail 4a/4b: seed once at v9, never revive at v10)', () => {
  const blankCanvas = (title: string) => ({
    title,
    nodes: [],
    edges: [],
    tasks: [],
    selectedNodeId: undefined,
    selectedNodeIds: [],
  })

  it('4a: v9 snapshot with demo scene canvases (no projectId) → seeds 2 demo projects + relinks canvases', () => {
    const result = migratePersistedState(
      {
        sceneId: 'character-flow',
        canvases: {
          'character-flow': blankCanvas('Character Flow'),
          variants: blankCanvas('Variants'),
          'asset-handoff': blankCanvas('Asset Handoff'),
          'stress-test': blankCanvas('Stress Test'),
          'task-states': blankCanvas('Task States'), // standalone — not in any demo project
        },
      } as never,
      9,
    )

    expect(result.projects).toEqual(DEMO_PROJECTS)
    expect(result.canvases['character-flow'].projectId).toBe(DEMO_PROJECT_IDS.conceptBattlepass)
    expect(result.canvases.variants.projectId).toBe(DEMO_PROJECT_IDS.conceptBattlepass)
    expect(result.canvases['asset-handoff'].projectId).toBe(DEMO_PROJECT_IDS.conceptBattlepass)
    expect(result.canvases['stress-test'].projectId).toBe(DEMO_PROJECT_IDS.productDirection)
    expect(result.canvases['task-states'].projectId).toBeUndefined() // standalone stays standalone
  })

  it('4b: v10 snapshot after user deleted demo projects (projectId already cleared) → no revival on re-hydration', () => {
    // User deleted both demo projects in a v10 session; deleteProject cascaded
    // (cleared projectId on member canvases). The persisted v10 state has no
    // demo projects and standalone demo scene canvases.
    const result = migratePersistedState(
      {
        sceneId: 'character-flow',
        projects: [],
        canvases: {
          'character-flow': { ...blankCanvas('Character Flow'), projectId: undefined, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
          'stress-test': { ...blankCanvas('Stress Test'), projectId: undefined, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
        },
      } as never,
      10, // merge re-runs migrate at CANVAS_PERSIST_VERSION=10 on every hydration
    )

    // Demo projects must NOT revive; canvases stay standalone.
    expect(result.projects).toEqual([])
    expect(result.canvases['character-flow'].projectId).toBeUndefined()
    expect(result.canvases['stress-test'].projectId).toBeUndefined()
  })

  it('4b (stale projectId): v10 snapshot with orphaned demo projectIds + empty projects → orphan cleanup clears, no revival', () => {
    // Edge case: a v10 snapshot where demo canvases still carry a demo projectId
    // but the projects list is empty (e.g. projects field wiped out-of-band).
    // Orphan cleanup must clear the projectIds; relink must NOT re-seed at v10.
    const result = migratePersistedState(
      {
        sceneId: 'character-flow',
        projects: [],
        canvases: {
          'character-flow': { ...blankCanvas('Character Flow'), projectId: DEMO_PROJECT_IDS.conceptBattlepass, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
        },
      } as never,
      10,
    )

    expect(result.projects).toEqual([]) // no revival
    expect(result.canvases['character-flow'].projectId).toBeUndefined() // orphan cleared
  })

  it('DEMO_SCENE_PROJECT_MAP covers exactly the 4 grouped demo scenes (sanity)', () => {
    // Guardrail 1: the shared mapping is the single source of truth — assert its
    // shape so a future edit doesn't silently drop a scene or add a stray one.
    expect(Object.keys(DEMO_SCENE_PROJECT_MAP).sort()).toEqual(
      ['asset-handoff', 'character-flow', 'stress-test', 'variants'],
    )
    expect(DEMO_SCENE_PROJECT_MAP['character-flow']).toBe(DEMO_PROJECT_IDS.conceptBattlepass)
    expect(DEMO_SCENE_PROJECT_MAP['stress-test']).toBe(DEMO_PROJECT_IDS.productDirection)
  })
})
