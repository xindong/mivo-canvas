import { describe, expect, it, vi, beforeEach } from 'vitest'

// Hermetic setup: stub the demo-image canvas renderer (canvasStore triggers scenes()
// at module load), the IndexedDB-backed asset store, and the remote debug-log flusher
// — same approach as generation.contract.test.ts.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1234,
    hasTransparency: false,
    size: '200x200',
    sourceDimensions: { width: 200, height: 200 },
  })),
  saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imported' })),
  readImportedAssetFile: vi.fn(),
}))
vi.mock('../store/remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import { useCanvasStore } from '../store/canvasStore'
import { prepareMaskEditPlaceholder, removeMaskEditPlaceholder } from './maskEditGeneration'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// Helpers ---------------------------------------------------------------------

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'src-1',
  type: 'image',
  title: 'Source',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  status: 'ready',
  assetUrl: '/a.png',
  ...overrides,
})

const baseState = useCanvasStore.getState()

const seed = (overrides: Record<string, unknown> = {}) =>
  useCanvasStore.setState({ ...baseState, ...overrides } as never, true)

const seedCanvas = (sceneId: string, nodes: MivoCanvasNode[]) => {
  const document = { title: sceneId, nodes, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
  return {
    canvases: { [sceneId]: document },
    sceneId,
    nodes,
    edges: [],
    tasks: [],
    selectedNodeId: undefined,
    selectedNodeIds: [],
  }
}

beforeEach(() => {
  useCanvasStore.setState({ ...baseState } as never, true)
})

// Tests -----------------------------------------------------------------------

describe('mask-edit placeholder rollback (S01)', () => {
  it('prepare captures the baseline; remove rolls back to it when栈顶 unchanged', () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))

    const { slotId, baselineSnapshot } = prepareMaskEditPlaceholder('character-flow', source, 'edit prompt')
    expect(slotId).toBeDefined()
    expect(baselineSnapshot).toBeDefined()
    // prepare pushed a pre-slot baseline (active scene → addAiSlotNode history:true)
    expect(useCanvasStore.getState().historyPast).toHaveLength(1)
    expect(useCanvasStore.getState().nodes.some((n) => n.id === slotId)).toBe(true)

    removeMaskEditPlaceholder('character-flow', slotId, { error: 'boom', baselineSnapshot })

    const state = useCanvasStore.getState()
    expect(state.nodes.some((n) => n.id === slotId)).toBe(false)
    expect(state.historyPast).toHaveLength(0) // baseline popped (栈顶 matched)
  })

  it('remove preserves user edits when栈顶 changed during async (expectedBaseline mismatch)', () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))

    const { slotId, baselineSnapshot } = prepareMaskEditPlaceholder('character-flow', source, 'edit prompt')
    expect(baselineSnapshot).toBeDefined()

    // 模拟异步生成期间用户编辑：追加节点 + captureHistory 推新快照，栈顶已不是基线
    const userEditNode = imageNode({ id: 'user-edit', x: 500 })
    useCanvasStore.setState((s) => {
      const sceneDoc = s.canvases['character-flow']
      const nextNodes = [...sceneDoc.nodes, userEditNode]
      return {
        nodes: nextNodes,
        canvases: { ...s.canvases, 'character-flow': { ...sceneDoc, nodes: nextNodes } },
      }
    })
    useCanvasStore.getState().captureHistory()
    // 栈顶已是用户编辑后的快照，与生成基线不是同一引用
    expect(useCanvasStore.getState().historyPast.at(-1)).not.toBe(baselineSnapshot)

    removeMaskEditPlaceholder('character-flow', slotId, { error: 'boom', baselineSnapshot })

    const state = useCanvasStore.getState()
    expect(state.nodes.some((n) => n.id === slotId)).toBe(false) // placeholder removed
    expect(state.nodes.some((n) => n.id === 'user-edit')).toBe(true) // 用户编辑保留
    expect(state.historyPast).toHaveLength(2) // 基线 + 用户编辑，均未被 pop
  })

  it('remove falls back to filter when baselineSnapshot is undefined (non-active scene)', () => {
    // 非活跃场景：addAiSlotNode 不 push history → prepare 返回 baselineSnapshot=undefined
    // → remove 跳过 rollback 走 filter-removal，删占位符但不动 history 栈。
    const source = imageNode({ id: 'src-1' })
    const otherScene = { title: 'other', nodes: [source], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] }
    seed({
      ...seedCanvas('character-flow', []),
      canvases: {
        'character-flow': { title: 'character-flow', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] },
        'other-scene': otherScene,
      },
    })
    // active scene is 'character-flow'; target 'other-scene' is non-active
    expect(useCanvasStore.getState().sceneId).toBe('character-flow')

    const { slotId, baselineSnapshot } = prepareMaskEditPlaceholder('other-scene', source, 'edit prompt')
    expect(baselineSnapshot).toBeUndefined()
    expect(useCanvasStore.getState().canvases['other-scene'].nodes.some((n) => n.id === slotId)).toBe(true)

    removeMaskEditPlaceholder('other-scene', slotId, { error: 'boom', baselineSnapshot })

    const state = useCanvasStore.getState()
    expect(state.canvases['other-scene'].nodes.some((n) => n.id === slotId)).toBe(false)
    expect(state.historyPast).toHaveLength(0) // 未 push 也未 pop
  })

  // SC-W2 ④: 生成中用户编辑其他节点后取消 → 用户编辑不被回滚吞（#81 三态之取消）。
  // 与 failure 路径同语义（expectedBaseline 不匹配 → filter-removal），但显式 canceled:true
  // 覆盖取消态，证明 removeMaskEditPlaceholder 的 baselineSnapshot 守卫在 cancel 路径也成立。
  it('remove preserves user edits on cancel when栈顶 changed during async (canceled path)', () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))

    const { slotId, baselineSnapshot } = prepareMaskEditPlaceholder('character-flow', source, 'edit prompt')
    expect(baselineSnapshot).toBeDefined()

    // 异步生成期间用户在别处追加节点 + captureHistory，栈顶已不是生成基线
    const userEditNode = imageNode({ id: 'user-edit-cancel', x: 700 })
    useCanvasStore.setState((s) => {
      const sceneDoc = s.canvases['character-flow']
      const nextNodes = [...sceneDoc.nodes, userEditNode]
      return {
        nodes: nextNodes,
        canvases: { ...s.canvases, 'character-flow': { ...sceneDoc, nodes: nextNodes } },
      }
    })
    useCanvasStore.getState().captureHistory()
    expect(useCanvasStore.getState().historyPast.at(-1)).not.toBe(baselineSnapshot)

    // 取消态：canceled:true，仍带同一 baselineSnapshot
    removeMaskEditPlaceholder('character-flow', slotId, { canceled: true, baselineSnapshot })

    const state = useCanvasStore.getState()
    expect(state.nodes.some((n) => n.id === slotId)).toBe(false) // placeholder removed
    expect(state.nodes.some((n) => n.id === 'user-edit-cancel')).toBe(true) // 用户编辑保留
    expect(state.historyPast).toHaveLength(2) // 基线 + 用户编辑，均未被 pop
  })
})
