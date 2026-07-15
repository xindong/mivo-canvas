// src/canvas/arrowNudgeThrottle.test.ts
// #arrowflood 节流模块测试。两层:
//   1) 纯单测(createArrowNudgeThrottle + vi.fn deps):状态机行为 —— burst 不结算、keyup/blur/flush
//      结算、多键全释放才结算、累计 delta 正确、shift=10、idempotent double-settle 不重复。
//   2) 集成测(真 store + 真 wrapMutation + mock CanvasSyncPort,server/local 双模):完成标准 ——
//      burst N 次 keydown → submitChange 计数 ≤2 + 最终位置正确;keyup/blur/flush 各结算一次;
//      local 模式零 submit 回归。复用 canvasSyncRuntime.test.ts 的 persistMode/port mock 范式。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasChange, ChangeOutcome, CanvasSyncPort } from '../lib/canvasSyncPort'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { createArrowNudgeThrottle } from './arrowNudgeThrottle'

vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage }
  if (g.localStorage === undefined) g.localStorage = localStorage
})

vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('../store/remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 120,
  height: 80,
  status: 'ready',
  assetUrl: '/image.png',
  ...overrides,
})

// 集成测 harness:mock persistMode + CanvasSyncPort(可计 submitChange),返回真 store + wrapMutation。
// 范式同 canvasSyncRuntime.test.ts 的 loadRuntimeModule(本仓无 React hook render harness,行为测
// 必须靠动态 import 注入 mock persist/port)。
const loadHarness = async (options: { local?: boolean } = {}) => {
  vi.resetModules()
  const submitChange = vi.fn<(canvasId: string, change: CanvasChange) => Promise<ChangeOutcome>>(
    async () => ({ kind: 'accepted', cursor: 'cursor' as never }) as ChangeOutcome,
  )
  const abortPendingCreate = vi.fn(() => false)
  vi.doMock('../lib/persistMode', () => ({ isLocalPersist: options.local ?? false }))
  vi.doMock('../lib/canvasSyncPortClient', () => ({
    getCanvasSyncPort: () => ({ submitChange }) as unknown as CanvasSyncPort,
    abortPendingCanvasSyncCreate: abortPendingCreate,
    persistMode: options.local ? 'local' : 'server',
  }))
  const realAssetWiring = await import('../lib/assetAttachWiring')
  vi.doMock('../lib/assetAttachWiring', () => ({
    serverAssetIdFromUrl: realAssetWiring.serverAssetIdFromUrl,
    enqueueAssetAttach: vi.fn(),
    enqueueAssetDetach: vi.fn(),
  }))
  const { wrapMutation, __resetCanvasSyncRuntimeQueue } = await import('./actions/canvasSyncRuntime')
  const { useCanvasStore } = await import('../store/canvasStore')
  return { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange }
}

// 装一个选中 n1 的画布(镜像 canvasSyncRuntime.test.ts 的 setState 形态)。
// param 取 unknown + 内部 cast:绕开 UseBoundStore 的 setState 重载签名(replace?: false / replace: true)
// 与 helper 形参的 contravariance 冲突。真 store 必有 getInitialState/setState。
const seedStoreWithSelectedNode = (useCanvasStore: unknown) => {
  const store = useCanvasStore as {
    getInitialState: () => Record<string, unknown>
    setState: (state: never, replace?: boolean) => void
  }
  const baseState = store.getInitialState()
  store.setState(
    {
      ...baseState,
      sceneId: 'c1',
      canvases: {
        c1: {
          title: 'Canvas',
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z',
          nodes: [imageNode()],
          edges: [],
          tasks: [],
          selectedNodeId: 'n1',
          selectedNodeIds: ['n1'],
        },
      },
      nodes: [imageNode()],
      edges: [],
      tasks: [],
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
    } as never,
    true,
  )
}

// #arrowflood P1 测试 seed:画布 c1 含 A(n1,选中)+ B(n2),用于「burst 中换选区」集成测。
const seedStoreWithTwoNodesSelectedA = (useCanvasStore: unknown) => {
  const store = useCanvasStore as {
    getInitialState: () => Record<string, unknown>
    setState: (state: never, replace?: boolean) => void
  }
  const baseState = store.getInitialState()
  const n1 = imageNode({ id: 'n1', x: 10, y: 20 })
  const n2 = imageNode({ id: 'n2', x: 100, y: 200 })
  store.setState(
    {
      ...baseState,
      sceneId: 'c1',
      canvases: {
        c1: {
          title: 'Canvas',
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z',
          nodes: [n1, n2],
          edges: [],
          tasks: [],
          selectedNodeId: 'n1',
          selectedNodeIds: ['n1'],
        },
      },
      nodes: [n1, n2],
      edges: [],
      tasks: [],
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
    } as never,
    true,
  )
}

// #arrowflood P1 测试 seed:两画布 c1(n1=A,选中)+ c2(n3),active=c1,用于「burst 中切画布」集成测。
const seedStoreWithTwoCanvases = (useCanvasStore: unknown) => {
  const store = useCanvasStore as {
    getInitialState: () => Record<string, unknown>
    setState: (state: never, replace?: boolean) => void
  }
  const baseState = store.getInitialState()
  const n1 = imageNode({ id: 'n1', x: 10, y: 20 })
  const n3 = imageNode({ id: 'n3', x: 500, y: 50 })
  const doc = (nodes: MivoCanvasNode[], selectedNodeId: string) => ({
    title: 'Canvas',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    nodes,
    edges: [],
    tasks: [],
    selectedNodeId,
    selectedNodeIds: [selectedNodeId],
  })
  store.setState(
    {
      ...baseState,
      sceneId: 'c1',
      canvases: { c1: doc([n1], 'n1'), c2: doc([n3], 'n3') },
      nodes: [n1],
      edges: [],
      tasks: [],
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
    } as never,
    true,
  )
}

// 读指定画布的 nodes(cast 绕开 CanvasDocument 类型引用;测试 seed 用字面量 canvas id)。
const nodesOfCanvas = (state: unknown, canvasId: string): MivoCanvasNode[] =>
  (state as { canvases: Record<string, { nodes: MivoCanvasNode[] }> }).canvases[canvasId].nodes

// 节流 + 真 store + 真 wrapMutation 的接线(同 useGlobalCanvasEvents.ts 的 settle 实现)。
const wireThrottleToStore = (
  wrapMutation: <TArgs extends unknown[], TResult>(
    mutate: (...args: TArgs) => TResult,
  ) => (...args: TArgs) => TResult,
  useCanvasStore: { getState: () => { moveSelectedNodesBy: (dx: number, dy: number) => void; nodes: MivoCanvasNode[] } },
) =>
  createArrowNudgeThrottle({
    moveBy: (dx, dy) => useCanvasStore.getState().moveSelectedNodesBy(dx, dy),
    settle: (accDx, accDy) => {
      if (accDx === 0 && accDy === 0) return
      const store = useCanvasStore.getState()
      store.moveSelectedNodesBy(-accDx, -accDy)
      wrapMutation(store.moveSelectedNodesBy)(accDx, accDy)
    },
  })

// 排空 enqueueCanvasSyncChanges 的异步链(mock submitChange 返回 resolved promise,需让微任务跑完)。
const flushMicrotasks = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('createArrowNudgeThrottle — 纯状态机(无 store/port)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('burst 期间每次 keydown 裸 move + 累加,不结算', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    for (let i = 0; i < 30; i += 1) t.onKeyDown('ArrowRight', false)

    // 30 次 move,每次 (+1, 0) —— 即时视觉、零 submit。
    expect(moveBy).toHaveBeenCalledTimes(30)
    expect(moveBy.mock.calls.every(([dx, dy]) => dx === 1 && dy === 0)).toBe(true)
    // burst 期间不结算。
    expect(settle).not.toHaveBeenCalled()
  })

  it('最后一个方向键 keyup → 结算一次,累计 delta 正确', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    for (let i = 0; i < 30; i += 1) t.onKeyDown('ArrowRight', false)
    expect(settle).not.toHaveBeenCalled()
    t.onKeyUp('ArrowRight')

    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(30, 0)
  })

  it('shift 按住 → 单步 delta = 10', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    t.onKeyDown('ArrowUp', true)
    t.onKeyDown('ArrowUp', true)
    t.onKeyUp('ArrowUp')

    expect(moveBy.mock.calls).toEqual([
      [0, -10],
      [0, -10],
    ])
    expect(settle).toHaveBeenCalledWith(0, -20)
  })

  it('多键同按(Left+Up):全部释放才结算,中间释放不结算', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    t.onKeyDown('ArrowLeft', false)
    t.onKeyDown('ArrowUp', false)
    // 释放 Up 但 Left 仍按住 → 不结算。
    t.onKeyUp('ArrowUp')
    expect(settle).not.toHaveBeenCalled()
    // 释放最后一个 → 结算累计(-1, -1)。
    t.onKeyUp('ArrowLeft')
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(-1, -1)
  })

  it('blur 中断 → 立即结算一次,内部状态清零(后续 flush 不重复)', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    for (let i = 0; i < 10; i += 1) t.onKeyDown('ArrowRight', false)
    t.onBlur()

    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(10, 0)
    // blur 后再 flush → idempotent guard(acc 已清零)不再调 settle。
    t.flush()
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('flush(组件卸载,无 keyup) → 结算一次', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    for (let i = 0; i < 10; i += 1) t.onKeyDown('ArrowDown', false)
    t.flush()

    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(0, 10)
  })

  it('keyup 后再 flush → 不重复结算(double-settle idempotent)', () => {
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    t.onKeyDown('ArrowRight', false)
    t.onKeyUp('ArrowRight')
    t.flush()
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('净 delta 为 0(Left+Right 同按后释放)→ settle 收到 (0,0) 被 guard,不调 deps.settle', () => {
    // Left(+(-1)) 与 Right(+1) 抵消 → acc=(0,0)。runSettle 的 idempotent guard 命中 → deps.settle 不调。
    // (moveBy 仍每次调,视觉来回动;但无净位移 → 无需 submit,故 settle 跳过。)
    const moveBy = vi.fn()
    const settle = vi.fn()
    const t = createArrowNudgeThrottle({ moveBy, settle })

    t.onKeyDown('ArrowLeft', false)
    t.onKeyDown('ArrowRight', false)
    t.onKeyUp('ArrowLeft')
    t.onKeyUp('ArrowRight')

    expect(moveBy).toHaveBeenCalledTimes(2)
    expect(settle).not.toHaveBeenCalled()
  })
})

describe('arrowNudgeThrottle 集成(真 store + wrapMutation + mock port)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('server 模式按住 1 秒(30 次 keydown)→ submitChange 计数 = 1 (≤2) + 最终位置正确', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: false })
    seedStoreWithSelectedNode(useCanvasStore)
    const initialX = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    for (let i = 0; i < 30; i += 1) throttle.onKeyDown('ArrowRight', false)
    throttle.onKeyUp('ArrowRight')
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(1) // ≤2 ✓
    // 单条 edit-node change,改的是 n1 的 transform。
    expect(submitChange.mock.calls[0][0]).toBe('c1')
    expect(submitChange.mock.calls[0][1]).toMatchObject({ kind: 'edit-node', nodeId: 'n1' })
    const finalX = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x
    expect(finalX).toBe(initialX + 30) // 最终位置正确 ✓
    __resetCanvasSyncRuntimeQueue()
  })

  it('local 模式:30 次 keydown + keyup → submitChange 计数 = 0(零回归) + 最终位置正确', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: true })
    seedStoreWithSelectedNode(useCanvasStore)
    const initialX = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    for (let i = 0; i < 30; i += 1) throttle.onKeyDown('ArrowRight', false)
    throttle.onKeyUp('ArrowRight')
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(0) // local 零 submit 回归 ✓
    const finalX = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x
    expect(finalX).toBe(initialX + 30) // 位置仍正确(local 也即时视觉 + 结算重放)✓
    __resetCanvasSyncRuntimeQueue()
  })

  it('blur 中断结算:10 次 keydown + blur → submitChange = 1 + 最终位置 = initial+10', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: false })
    seedStoreWithSelectedNode(useCanvasStore)
    const initialX = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    for (let i = 0; i < 10; i += 1) throttle.onKeyDown('ArrowRight', false)
    throttle.onBlur()
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(1)
    const finalX = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x
    expect(finalX).toBe(initialX + 10)
    __resetCanvasSyncRuntimeQueue()
  })

  it('flush(卸载)结算:10 次 keydown + flush → submitChange = 1 + 最终位置正确', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: false })
    seedStoreWithSelectedNode(useCanvasStore)

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    for (let i = 0; i < 10; i += 1) throttle.onKeyDown('ArrowDown', false)
    throttle.flush()
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(1)
    const finalY = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.y
    expect(finalY).toBe(20 + 10) // 初始 y=20 + 10
    __resetCanvasSyncRuntimeQueue()
  })

  it('多个独立 burst(按-放-按-放)→ 每次 1 submit,共 2(≤2 per burst,总数符合预期)', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: false })
    seedStoreWithSelectedNode(useCanvasStore)

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    // burst 1
    for (let i = 0; i < 5; i += 1) throttle.onKeyDown('ArrowRight', false)
    throttle.onKeyUp('ArrowRight')
    await flushMicrotasks()
    // burst 2
    for (let i = 0; i < 5; i += 1) throttle.onKeyDown('ArrowRight', false)
    throttle.onKeyUp('ArrowRight')
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(2) // 每 burst 1 次 ✓
    __resetCanvasSyncRuntimeQueue()
  })

  // ── #arrowflood P1(Greptile:结算目标随实时选区漂移)──
  // burst 期间对 A 的裸移动零 submit;若选区/画布在 settle 前切换,settle 会作用于实时选区(B/新画布)
  //   → A 累计位移永不提交,刷新后 A 回退(节流引入的新回归窗口)。fix:pointerdown(capture)先 flush,
  //   settle 落在 A。下列测验证「flush 在选区/场景切换前调用」时 A 正确提交、B/新画布零影响
  //   (pointerdown→flush 接线由 useGlobalCanvasEvents.contract.test 钉死)。
  it('P1 选区漂移:burst 中 pointerdown flush 先结算 A,再换选区到 B → A 累计位移已提交、B 零影响', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: false })
    seedStoreWithTwoNodesSelectedA(useCanvasStore)
    const initialA = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x
    const initialB = useCanvasStore.getState().nodes.find((n) => n.id === 'n2')!.x

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    // burst 5× ArrowRight on A(裸 move,A 视觉 +5,零 submit)
    for (let i = 0; i < 5; i += 1) throttle.onKeyDown('ArrowRight', false)
    // pointerdown flush:settle 在选区仍是 A 时 → 提交 A +5(B 还未选,settle 不碰 B)
    throttle.flush()
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(1)
    expect(submitChange.mock.calls[0][0]).toBe('c1')
    expect(submitChange.mock.calls[0][1]).toMatchObject({ kind: 'edit-node', nodeId: 'n1' })
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x).toBe(initialA + 5) // A 累计位移已提交 ✓

    // 换选区到 B(模拟 pointerdown 后 click→selectNode('n2'))
    useCanvasStore.getState().selectNode('n2')
    // B 零影响:未被 A 的 burst settle 碰到(fix 下 settle 在选区还是 A 时已完成)
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n2')!.x).toBe(initialB) // B 零影响 ✓
    __resetCanvasSyncRuntimeQueue()
  })

  it('P1 画布漂移:burst 中 pointerdown flush 先结算 A,再切画布到 c2 → A 累计位移已提交到 c1、c2 零影响', async () => {
    const { wrapMutation, __resetCanvasSyncRuntimeQueue, useCanvasStore, submitChange } = await loadHarness({ local: false })
    seedStoreWithTwoCanvases(useCanvasStore)
    const initialA = useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x
    const initialC2N3 = nodesOfCanvas(useCanvasStore.getState(), 'c2').find((n) => n.id === 'n3')!.x

    const throttle = wireThrottleToStore(wrapMutation, useCanvasStore)
    for (let i = 0; i < 5; i += 1) throttle.onKeyDown('ArrowRight', false)
    // pointerdown flush:settle 在画布仍是 c1 时 → 提交 A +5 到 c1(锚 state.sceneId=c1)
    throttle.flush()
    await flushMicrotasks()

    expect(submitChange).toHaveBeenCalledTimes(1)
    expect(submitChange.mock.calls[0][0]).toBe('c1') // 提交到原画布 c1 ✓
    expect(submitChange.mock.calls[0][1]).toMatchObject({ kind: 'edit-node', nodeId: 'n1' })
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n1')!.x).toBe(initialA + 5) // A 累计位移已提交到 c1 ✓

    // 切画布到 c2(模拟 pointerdown 后 openCanvasById → loadScene('c2'))
    useCanvasStore.getState().loadScene('c2')
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n3')!.x).toBe(initialC2N3) // c2 节点零影响 ✓
    __resetCanvasSyncRuntimeQueue()
  })
})
