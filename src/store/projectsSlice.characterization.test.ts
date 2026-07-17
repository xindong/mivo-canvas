import { describe, expect, it, vi, beforeEach } from 'vitest'

// =============================================================================
// projectsSlice.characterization.test.ts — T0.4③ 表征测试（计划 v3 T0.4③）
// -----------------------------------------------------------------------------
// 目的：把"项目/画布 CRUD"现状语义钉死，作为 IDB → /api/projects + /api/canvas
// 迁移的回归基线。硬约束：只录现状不改行为；疑似 bug 钉现状 + 进 PR"现状疑点"
// 段，不修。
//
// Baseline 断言数: 83  （`grep -c 'expect('` 计；迁移回归基线，勿降）
//   分块断言分布（每 describe 块的 expect 断言行数；helper 与文件头单列）：
//     ① createCanvas                          : 28
//     ③ deleteCanvas（first-survivor 钉规则）  : 18
//     ④ renameCanvas                          :  7
//     ④ duplicateCanvas                       : 11
//     createProject shape invariant           :  3
//     ⑥ 跨切片一致性不变量                     :  6
//     ⑤ 折叠状态解耦（现状疑点）               :  3
//     expectActiveSceneMirror 定义             :  6
//     文件头 grep 行                           :  1
//                                             合计 83
//
// 与现有测试的分工（先读后排，避免同构重复）：
//   - projectsSlice.test.ts  → createProject / renameProject / deleteProject
//                                cascade（含 no-dangling 回落不变量）/
//                                moveCanvasToProject 的单点行为（已覆盖 happy + edge）
//   - canvasStore.contract.test.ts → persist shape / selectNode / undo·redo /
//                                commitGenerationResult（已覆盖）
//   - useCollapsedProjects.test.ts → 折叠纯 helper（key / round-trip / silent）
//                                （已覆盖）
//   - projectSidebarModel.test.ts  → buildSidebarModel 派生（已覆盖）
// 本文件定位为跨切片 CRUD 表征基线（非完全零重复：createCanvas / duplicateCanvas
// 的时间戳语义与 canvasDocumentModel.test.ts 有轻量重叠，作为迁移回归基线在此再钉
// 一次）。本文件只补上述都没盖住的语义：
//   ① createCanvas 同步返 id + 初始结构 + active 切换（含 templateId 路径）
//   ③ deleteCanvas（active 切换 + 钉 first-survivor 回落规则 / inactive 不切 /
//      最后一块阻断 / 不存在 no-op）
//   ④ renameCanvas（bump updatedAt / active·inactive 分支）+ duplicateCanvas
//      （同步返 id / projectId 继承 / 全新时间戳）+ createProject 初始结构不变量
//   ⑥ 跨切片一致性不变量（active-scene 镜像 / canvases 非空 / 时间戳回填；
//      deleteProject no-dangling 回落已由 projectsSlice.test.ts 覆盖，本文件不重复）
//   ⑤ 折叠状态与 project 生命周期的解耦（orphan 残留 — 现状疑点）
// =============================================================================

// zustand v5 persist 只在 storage 可解析时挂 api.persist。装一个内存 localStorage
// + window，让 persist API 可达（与 canvasStore.contract.test.ts 同一套 hermetic
// 手法；vi.hoisted 保证在下方 import 之前执行）。
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage }
  if (g.localStorage === undefined) g.localStorage = memStorage
})

// scenes() → createDemoImage → document.createElement('canvas') 在 node 无 DOM；stub。
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

// documentSlice 顶部 import saveGeneratedAsset（IndexedDB）；stub 保持 hermetic。
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1234,
    hasTransparency: false,
    size: '300x200',
    sourceDimensions: { width: 300, height: 200 },
  })),
  saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imported' })),
  readImportedAssetFile: vi.fn(),
}))

// debugLogger.warn/error → reportRemoteDebugEntry（window.setTimeout + fetch）；stub。
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import { useCanvasStore } from './canvasStore'
import type { CanvasDocument } from '../types/mivoCanvas'

// useCollapsedProjects 的折叠集合 localStorage key（与 src/app/sidebar/
// useCollapsedProjects.ts 的 COLLAPSED_PROJECTS_STORAGE_KEY 字面量一致；这里不
// import 该模块以避免在 store 单测里拉入 React hook 副作用，直接按 key 操作
// localStorage 即可表征"store 是否触碰折叠状态"）。
const COLLAPSED_KEY = 'mivo.sidebar.collapsedProjects'

const baseState = useCanvasStore.getState()

const seed = (overrides: Record<string, unknown> = {}) =>
  useCanvasStore.setState({ ...baseState, ...overrides } as never, true)

const blankDocument = (overrides: Partial<CanvasDocument> = {}): CanvasDocument => ({
  title: 'Canvas',
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T10:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeId: undefined,
  selectedNodeIds: [],
  ...overrides,
})

/** active-scene 镜像不变量：canvases[sceneId] 的文档字段 === 顶层投影。 */
const expectActiveSceneMirror = () => {
  const s = useCanvasStore.getState()
  const doc = s.canvases[s.sceneId]
  expect(doc).toBeDefined()
  expect(s.nodes).toEqual(doc!.nodes)
  expect(s.edges).toEqual(doc!.edges || [])
  expect(s.tasks).toEqual(doc!.tasks)
  expect(s.selectedNodeId).toBe(doc!.selectedNodeId)
  expect(s.selectedNodeIds).toEqual(doc!.selectedNodeIds || [])
}

beforeEach(() => {
  const ls = (globalThis as { localStorage?: { clear: () => void } }).localStorage
  if (ls) ls.clear()
  useCanvasStore.setState({ ...baseState } as never, true)
})

// --- ① createCanvas：同步返 id + 初始结构 + active 切换 ------------------------

describe('characterization: createCanvas — sync id + initial structure', () => {
  it('returns a canvas- prefixed id synchronously (caller can use it immediately)', () => {
    const id = useCanvasStore.getState().createCanvas('C')!
    expect(id).toMatch(/^canvas-/)
    expect(useCanvasStore.getState().canvases[id]).toBeDefined()
  })

  it('seeds canvases[id] as a blank document: default title, standalone projectId, empty content', () => {
    const id = useCanvasStore.getState().createCanvas()!
    const doc = useCanvasStore.getState().canvases[id]!
    expect(doc.title).toBe('Untitled Canvas')
    expect(doc.projectId).toBeUndefined()
    expect(doc.nodes).toEqual([])
    expect(doc.edges).toEqual([])
    expect(doc.tasks).toEqual([])
    expect(doc.selectedNodeId).toBeUndefined()
    expect(doc.selectedNodeIds).toEqual([])
  })

  it('seeds canvases[id] with the full field set (createdAt/updatedAt present, no sourceTemplateId for blank)', () => {
    const before = new Date().toISOString()
    const id = useCanvasStore.getState().createCanvas('C')!
    const after = new Date().toISOString()
    const doc = useCanvasStore.getState().canvases[id]!
    expect(doc.createdAt >= before).toBe(true)
    expect(doc.createdAt <= after).toBe(true)
    expect(doc.updatedAt).toBe(doc.createdAt)
    expect(doc.sourceTemplateId).toBeUndefined()
  })

  it('switches sceneId to the new id and syncs top-level state to the new document', () => {
    const before = useCanvasStore.getState().sceneId
    const id = useCanvasStore.getState().createCanvas('C')
    expect(useCanvasStore.getState().sceneId).toBe(id)
    expect(id).not.toBe(before)
    expectActiveSceneMirror()
  })

  it('resets activeTool to select and clears both history stacks', () => {
    useCanvasStore.getState().captureHistory()
    const id = useCanvasStore.getState().createCanvas('C')
    const s = useCanvasStore.getState()
    expect(s.sceneId).toBe(id)
    expect(s.activeTool).toBe('select')
    expect(s.historyPast).toEqual([])
    expect(s.historyFuture).toEqual([])
  })

  it('honors options.projectId to attach the new canvas under an existing project', () => {
    const projectId = useCanvasStore.getState().createProject('P')
    const id = useCanvasStore.getState().createCanvas('C', { projectId })!
    expect(useCanvasStore.getState().canvases[id]!.projectId).toBe(projectId)
  })

  it('honors options.templateId to clone a demo scene content, with title + projectId override', () => {
    const id = useCanvasStore.getState().createCanvas('From Template', { templateId: 'character-flow' })!
    const doc = useCanvasStore.getState().canvases[id]!
    expect(doc.title).toBe('From Template')
    expect(doc.sourceTemplateId).toBe('character-flow')
    // character-flow scene = 3 nodes + 1 task
    expect(doc.nodes).toHaveLength(3)
    expect(doc.tasks).toHaveLength(1)
    // 模板新建画布不自动挂 demo 项目（options.projectId override = undefined）
    expect(doc.projectId).toBeUndefined()
  })

  it('two sequential createCanvas calls produce distinct ids and both canvases survive', () => {
    const a = useCanvasStore.getState().createCanvas('A')!
    const b = useCanvasStore.getState().createCanvas('B')!
    expect(a).not.toBe(b)
    expect(useCanvasStore.getState().canvases[a]).toBeDefined()
    expect(useCanvasStore.getState().canvases[b]).toBeDefined()
  })
})

// --- ③ deleteCanvas -----------------------------------------------------------

describe('characterization: deleteCanvas', () => {
  it('deletes the active canvas and switches sceneId to a surviving canvas (top-level sync)', () => {
    seed({
      canvases: {
        'c-active': blankDocument({ title: 'Active' }),
        'c-other': blankDocument({ title: 'Other' }),
      },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas('c-active')
    const s = useCanvasStore.getState()
    expect(s.canvases['c-active']).toBeUndefined()
    expect(s.sceneId).not.toBe('c-active')
    expect(s.canvases[s.sceneId]).toBeDefined()
    expectActiveSceneMirror()
  })

  it('picks the first survivor in map insertion order as next active (first-survivor rule, ≥3 canvases)', () => {
    // deleteCanvas picks the next active via Object.keys(canvases).find(id => id
    // !== targetId) — the first non-target key in MAP INSERTION ORDER
    // (documentSlice.ts:145). With canvases inserted as [c-first, c-active,
    // c-last] and deleting the active, the next active MUST be c-first (not
    // c-last). Asserting a precise id pins first-survivor; a loose "some
    // survivor" assertion would let last-survivor or random implementations
    // pass undetected.
    seed({
      canvases: {
        'c-first': blankDocument({ title: 'First' }),
        'c-active': blankDocument({ title: 'Active' }),
        'c-last': blankDocument({ title: 'Last' }),
      },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas('c-active')
    const s = useCanvasStore.getState()
    expect(s.canvases['c-active']).toBeUndefined()
    expect(s.sceneId).toBe('c-first')
    expect(s.canvases['c-first']).toBeDefined()
    expectActiveSceneMirror()
  })

  it('first-survivor tracks insertion order (same survivor set, reversed order → different next active)', () => {
    // Same three canvas ids as the case above, but insertion order reversed so
    // c-last is now first. The next active MUST be c-last — the rule varies
    // with map insertion order, not a fixed id or alphabetical order.
    // (Alphabetical 'c-first' < 'c-last' would still pick c-first; last-survivor
    // would also pick c-first. Only first-survivor-in-insertion-order yields
    // c-last, so this case alone distinguishes first-survivor from both.)
    seed({
      canvases: {
        'c-last': blankDocument({ title: 'Last' }),
        'c-active': blankDocument({ title: 'Active' }),
        'c-first': blankDocument({ title: 'First' }),
      },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas('c-active')
    const s = useCanvasStore.getState()
    expect(s.canvases['c-active']).toBeUndefined()
    expect(s.sceneId).toBe('c-last')
    expect(s.canvases['c-last']).toBeDefined()
    expectActiveSceneMirror()
  })

  it('deletes an inactive canvas without switching the active scene', () => {
    seed({
      canvases: {
        'c-active': blankDocument({ title: 'Active' }),
        'c-inactive': blankDocument({ title: 'Inactive' }),
      },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas('c-inactive')
    const s = useCanvasStore.getState()
    expect(s.canvases['c-inactive']).toBeUndefined()
    expect(s.sceneId).toBe('c-active')
    expect(s.canvases['c-active']).toBeDefined()
  })

  it('defaults to the active sceneId when called with no argument', () => {
    seed({
      canvases: {
        'c-active': blankDocument({ title: 'Active' }),
        'c-other': blankDocument({ title: 'Other' }),
      },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas()
    const s = useCanvasStore.getState()
    expect(s.canvases['c-active']).toBeUndefined()
    expect(s.canvases[s.sceneId]).toBeDefined()
  })

  it('is a blocked no-op (error) when only one canvas remains — at least one must survive', () => {
    seed({
      canvases: { only: blankDocument({ title: 'Only' }) },
      sceneId: 'only',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas('only')
    const s = useCanvasStore.getState()
    expect(s.canvases.only).toBeDefined()
    expect(Object.keys(s.canvases)).toHaveLength(1)
    expect(s.sceneId).toBe('only')
  })

  it('is a warn no-op when the canvas id does not exist', () => {
    seed({
      canvases: { c1: blankDocument({ title: 'C1' }) },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const before = useCanvasStore.getState().canvases
    useCanvasStore.getState().deleteCanvas('does-not-exist')
    expect(useCanvasStore.getState().canvases).toBe(before)
  })
})

// --- ④ renameCanvas + duplicateCanvas -----------------------------------------

describe('characterization: renameCanvas', () => {
  it('updates the title and bumps updatedAt on the active scene (content patch → bump)', () => {
    const before = '2026-07-06T10:00:00.000Z'
    seed({
      canvases: { c1: blankDocument({ title: 'Old', updatedAt: before, createdAt: before }) },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().renameCanvas('c1', 'New')
    const doc = useCanvasStore.getState().canvases.c1!
    expect(doc.title).toBe('New')
    expect(doc.updatedAt > before).toBe(true)
  })

  it('bumps updatedAt on an inactive scene without touching the active scene top-level state', () => {
    const before = '2026-07-06T10:00:00.000Z'
    seed({
      canvases: {
        'c-active': blankDocument({ title: 'Active' }),
        'c-inactive': blankDocument({ title: 'Old', updatedAt: before, createdAt: before }),
      },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().renameCanvas('c-inactive', 'New')
    const s = useCanvasStore.getState()
    expect(s.canvases['c-inactive']!.title).toBe('New')
    expect(s.canvases['c-inactive']!.updatedAt > before).toBe(true)
    expect(s.canvases['c-active']!.title).toBe('Active')
    expect(s.sceneId).toBe('c-active')
  })

  it('is a silent no-op when the target inactive canvas does not exist', () => {
    seed({
      canvases: { 'c-active': blankDocument({ title: 'Active' }) },
      sceneId: 'c-active',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const before = useCanvasStore.getState().canvases
    useCanvasStore.getState().renameCanvas('ghost', 'X')
    expect(useCanvasStore.getState().canvases).toBe(before)
  })
})

describe('characterization: duplicateCanvas', () => {
  it('returns a new canvas- prefixed id synchronously and copies the title with " Copy" suffix', () => {
    seed({
      canvases: { c1: blankDocument({ title: 'Original' }) },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const newId = useCanvasStore.getState().duplicateCanvas('c1')
    expect(typeof newId).toBe('string')
    expect(newId).toMatch(/^canvas-/)
    expect(newId).not.toBe('c1')
    expect(useCanvasStore.getState().canvases[newId!]!.title).toBe('Original Copy')
  })

  it('inherits projectId from the source (copy stays in the same project)', () => {
    seed({
      canvases: { c1: blankDocument({ title: 'O', projectId: 'p1' }) },
      projects: [{ id: 'p1', name: 'P', createdAt: '2026-07-01T00:00:00.000Z' }],
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const newId = useCanvasStore.getState().duplicateCanvas('c1')
    expect(useCanvasStore.getState().canvases[newId!]!.projectId).toBe('p1')
  })

  it('uses fresh createdAt/updatedAt (does NOT inherit the source timestamps)', () => {
    const sourceTs = '2026-07-01T00:00:00.000Z'
    seed({
      canvases: { c1: blankDocument({ title: 'O', createdAt: sourceTs, updatedAt: sourceTs }) },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const before = new Date().toISOString()
    const newId = useCanvasStore.getState().duplicateCanvas('c1')
    const after = new Date().toISOString()
    const doc = useCanvasStore.getState().canvases[newId!]!
    expect(doc.createdAt >= before).toBe(true)
    expect(doc.createdAt <= after).toBe(true)
    expect(doc.updatedAt).toBe(doc.createdAt)
  })

  it('switches sceneId to the duplicate and syncs top-level state', () => {
    seed({
      canvases: { c1: blankDocument({ title: 'O' }) },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const newId = useCanvasStore.getState().duplicateCanvas('c1')
    expect(useCanvasStore.getState().sceneId).toBe(newId)
    expectActiveSceneMirror()
  })

  it('returns undefined (warn) when the source canvas id does not exist', () => {
    seed({
      canvases: { c1: blankDocument({ title: 'C' }) },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    const result = useCanvasStore.getState().duplicateCanvas('ghost')
    expect(result).toBeUndefined()
    expect(useCanvasStore.getState().canvases.ghost).toBeUndefined()
  })
})

// --- createProject 初始结构不变量（补 projectsSlice.test.ts 未钉的 shape pin）-

describe('characterization: createProject — shape invariant (complement)', () => {
  it('the project record has exactly {id, name, createdAt} — no extra fields leaked', () => {
    const id = useCanvasStore.getState().createProject('P')
    const project = useCanvasStore.getState().projects.find((p) => p.id === id)!
    expect(Object.keys(project).sort()).toEqual(['createdAt', 'id', 'name'])
  })

  it('does not mutate canvases or sceneId (createProject is project-only, no canvas side-effect)', () => {
    const canvasesBefore = useCanvasStore.getState().canvases
    const sceneBefore = useCanvasStore.getState().sceneId
    useCanvasStore.getState().createProject('P')
    expect(useCanvasStore.getState().canvases).toBe(canvasesBefore)
    expect(useCanvasStore.getState().sceneId).toBe(sceneBefore)
  })
})

// --- ⑥ 跨切片一致性不变量 -----------------------------------------------------

describe('characterization: cross-slice consistency invariants', () => {
  it('active-scene mirror holds after createCanvas with templateId (non-blank content)', () => {
    const id = useCanvasStore.getState().createCanvas('T', { templateId: 'character-flow' })
    expect(useCanvasStore.getState().sceneId).toBe(id)
    expectActiveSceneMirror()
  })

  it('active-scene mirror holds after loadScene', () => {
    useCanvasStore.getState().createCanvas('New')
    useCanvasStore.getState().loadScene('character-flow')
    expect(useCanvasStore.getState().sceneId).toBe('character-flow')
    expectActiveSceneMirror()
  })

  it('deleteCanvas can never empty the canvases map (≥1 always survives)', () => {
    seed({
      canvases: {
        c1: blankDocument({ title: '1' }),
        c2: blankDocument({ title: '2' }),
      },
      sceneId: 'c1',
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
    useCanvasStore.getState().deleteCanvas('c2')
    expect(Object.keys(useCanvasStore.getState().canvases).length).toBeGreaterThanOrEqual(1)
    // 删最后一块 → 阻断，map 仍非空
    useCanvasStore.getState().deleteCanvas()
    expect(Object.keys(useCanvasStore.getState().canvases).length).toBeGreaterThanOrEqual(1)
  })

  it('every canvas document has non-empty createdAt/updatedAt (normalizeDocument backfill)', () => {
    useCanvasStore.getState().createCanvas('A')
    useCanvasStore.getState().createCanvas('B')
    const canvases = Object.values(useCanvasStore.getState().canvases)
    expect(canvases.every((d) => typeof d.createdAt === 'string' && d.createdAt.length > 0)).toBe(true)
    expect(canvases.every((d) => typeof d.updatedAt === 'string' && d.updatedAt.length > 0)).toBe(true)
  })
})

// --- ⑤ 折叠状态 vs project 生命周期（解耦 / orphan 残留 — 现状疑点）-----------

describe('characterization: collapse-state decoupling (现状疑点)', () => {
  it('deleting a project does NOT prune its id from the collapsed set (orphan survives)', () => {
    const ls = (globalThis as {
      localStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }
    }).localStorage
    const projectId = useCanvasStore.getState().createProject('Doomed')
    ls.setItem(COLLAPSED_KEY, JSON.stringify([projectId]))
    useCanvasStore.getState().deleteProject(projectId)
    // store 不触碰折叠状态：折叠集合里该 project id 仍残留（孤儿）
    const collapsed = JSON.parse(ls.getItem(COLLAPSED_KEY) || '[]') as string[]
    expect(collapsed).toContain(projectId)
    // 迁移到 /api/user-state 后多设备会同步这条孤儿 id — 需后端/迁移侧补 prune
  })

  it('createCanvas does not validate options.projectId against the projects list (orphan accepted) — 现状疑点', () => {
    // 与 moveCanvasToProject（target project 不存在 → reject）不同，createCanvas 无
    // guard，可直接造出指向不存在 project 的画布。钉现状，迁移侧需统一 guard。
    const id = useCanvasStore.getState().createCanvas('Orphan', { projectId: 'project-nonexistent' })!
    expect(useCanvasStore.getState().canvases[id]!.projectId).toBe('project-nonexistent')
    expect(useCanvasStore.getState().projects.some((p) => p.id === 'project-nonexistent')).toBe(false)
  })
})
