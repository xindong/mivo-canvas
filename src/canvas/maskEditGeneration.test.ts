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

// FIX-1 tests: spy on the task client + image source + black-plate inspection so
// runMaskEditGeneration's cancel path can be exercised without a real BFF/upstream.
const taskClientSpies = vi.hoisted(() => ({
  submitEditTask: vi.fn(),
  pollTask: vi.fn(),
  cancelTask: vi.fn(),
}))
vi.mock('../lib/mivoTaskClient', () => ({
  submitEditTask: taskClientSpies.submitEditTask,
  pollTask: taskClientSpies.pollTask,
  cancelTask: taskClientSpies.cancelTask,
  taskPollIntervalMs: () => 10000,
  kindForFailedTask: () => 'upstream-error',
}))
vi.mock('../lib/canvasImageSource', () => ({
  readCanvasImageBlob: vi.fn(async () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'src.png', { type: 'image/png' })),
}))
const inspectArtifactsSpy = vi.hoisted(() => vi.fn())
vi.mock('../lib/maskResultInspection', () => ({
  inspectMaskResultForBlackArtifacts: inspectArtifactsSpy,
  // 纯等比映射，与真实实现同语义（prior-bounds 断言依赖它算出的期望值）。
  mapBoundsToResultSpace: (bounds: { x: number; y: number; width: number; height: number }, from: { width: number; height: number }, to: { width: number; height: number }) => {
    const scaleX = to.width / Math.max(1, from.width)
    const scaleY = to.height / Math.max(1, from.height)
    const x = Math.max(0, Math.floor(bounds.x * scaleX))
    const y = Math.max(0, Math.floor(bounds.y * scaleY))
    const right = Math.min(to.width, Math.ceil((bounds.x + bounds.width) * scaleX))
    const bottom = Math.min(to.height, Math.ceil((bounds.y + bounds.height) * scaleY))
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
  },
}))

// 黑块检测 mock 返回值助手。
const artifactHit = (reason = 'out-of-mask-new-black-component') => ({
  hasArtifact: true,
  reason,
  components: [{ bounds: { x: 48, y: 48, width: 110, height: 110 }, areaPx: 9500, bboxFillRatio: 0.78, sourceBlackRatio: 0 }],
})
const artifactClean = () => ({ hasArtifact: false, components: [] })

import { useCanvasStore } from '../store/canvasStore'
import { prepareMaskEditPlaceholder, removeMaskEditPlaceholder, runMaskEditGeneration } from './maskEditGeneration'
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

// FIX-1: cancelTask must DELETE the IN-FLIGHT task. Before the fix, serverTaskId was
// assigned only AFTER runOneAttempt returned, so an abort during the poll left it
// undefined → cancelTask no-op'd → orphaned in-flight server task. currentTaskId is
// now set inside runOneAttempt right after submitEditTask returns, and each retry
// attempt overwrites it with its own fresh id.
describe('runMaskEditGeneration cancel (FIX-1: DELETE the in-flight task)', () => {
  beforeEach(() => {
    taskClientSpies.submitEditTask.mockReset()
    taskClientSpies.pollTask.mockReset()
    taskClientSpies.cancelTask.mockReset()
    inspectArtifactsSpy.mockReset()
  })

  const basePayload = {
    prompt: 'p',
    sourceSize: { width: 200, height: 200 },
    maskBounds: { x: 10, y: 10, width: 50, height: 50 },
    quality: 'medium' as const,
  }

  it('abort during first-attempt poll → cancelTask DELETEs task-1 (not undefined/no-op)', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    const ac = new AbortController()
    taskClientSpies.submitEditTask.mockResolvedValueOnce('task-1')
    // First poll returns running, then aborts so the subsequent sleep rejects canceled.
    taskClientSpies.pollTask.mockImplementationOnce(async () => {
      ac.abort()
      return { status: 'running', progress: 10, stage: 'submit' }
    })

    await expect(runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: basePayload as never,
      imgRatio: '1:1' as never,
      signal: ac.signal,
    })).rejects.toThrow()

    expect(taskClientSpies.cancelTask).toHaveBeenCalledWith('task-1')
    expect(taskClientSpies.cancelTask).toHaveBeenCalledTimes(1)
  })

  it('self-heal retry abort → cancelTask DELETEs task-2 (the new in-flight id), not stale task-1', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    const ac = new AbortController()
    taskClientSpies.submitEditTask
      .mockResolvedValueOnce('task-1') // first attempt
      .mockResolvedValueOnce('task-2') // self-heal retry
    taskClientSpies.pollTask
      .mockResolvedValueOnce({
        status: 'done', progress: 100, stage: 'done',
        result: { images: [{ b64: 'black-plate-b64' }] },
      }) // first attempt returns a black-plate result
      .mockImplementationOnce(async () => {
        ac.abort() // second attempt poll → abort mid-poll
        return { status: 'running', progress: 10, stage: 'submit' }
      })
    inspectArtifactsSpy.mockResolvedValueOnce(artifactHit()) // first result detected as black → retry

    await expect(runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: basePayload as never,
      imgRatio: '1:1' as never,
      signal: ac.signal,
    })).rejects.toThrow()

    // The retry's in-flight task is task-2; cancelTask must DELETE task-2, NOT the
    // stale task-1 (which already completed and whose id was in serverTaskId).
    expect(taskClientSpies.cancelTask).toHaveBeenCalledWith('task-2')
    expect(taskClientSpies.cancelTask).not.toHaveBeenCalledWith('task-1')
    expect(taskClientSpies.cancelTask).toHaveBeenCalledTimes(1)
  })
})

// Quality parity (auto/low/medium/high): overlay 四档选择器 → payload.quality →
// runMaskEditGeneration 透传 → submitEditTask request.quality。auto = undefined 一路
// 穿透（不带 quality 字段，与 chat 生图路径一致）；low/medium/high 原样下发。
// 证据：四档各自 submitEditTask 调用的 request.quality 实际值。
//
// 测试让 pollTask 直接返回 failed，runOneAttempt 抛错 → 外层 catch 跳过 commit
// 直接 rethrow（canceled=false → 不走 cancelTask）。这样只验证 submitEditTask 收
// 到的 request.quality，不耦合 commitGenerationResult 的全流程。
describe('runMaskEditGeneration quality pass-through (auto/low/medium/high parity)', () => {
  beforeEach(() => {
    taskClientSpies.submitEditTask.mockReset()
    taskClientSpies.pollTask.mockReset()
    taskClientSpies.cancelTask.mockReset()
    inspectArtifactsSpy.mockReset()
  })

  const baseSubmitPayload = {
    prompt: 'p',
    sourceSize: { width: 200, height: 200 },
    // No maskBounds → black-plate inspection skipped (canInspect=false).
  }

  const runFor = (quality: 'auto' | 'low' | 'medium' | 'high') => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    taskClientSpies.submitEditTask.mockResolvedValueOnce('task-q')
    taskClientSpies.pollTask.mockResolvedValueOnce({
      status: 'failed', progress: 0, stage: 'submit', error: 'upstream boom',
    })
    return runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: {
        ...baseSubmitPayload,
        quality: quality === 'auto' ? undefined : (quality as never),
      } as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
    })
  }

  const capturedRequest = (): { quality?: string } =>
    taskClientSpies.submitEditTask.mock.calls.at(-1)?.[0] as { quality?: string }

  it('auto → submitEditTask request.quality 为 undefined（不带 quality 字段，对齐 chat 生图路径）', async () => {
    await expect(runFor('auto')).rejects.toThrow()
    expect(capturedRequest().quality).toBeUndefined()
  })

  it('low → submitEditTask request.quality === "low"', async () => {
    await expect(runFor('low')).rejects.toThrow()
    expect(capturedRequest().quality).toBe('low')
  })

  it('medium → submitEditTask request.quality === "medium"', async () => {
    await expect(runFor('medium')).rejects.toThrow()
    expect(capturedRequest().quality).toBe('medium')
  })

  it('high → submitEditTask request.quality === "high"', async () => {
    await expect(runFor('high')).rejects.toThrow()
    expect(capturedRequest().quality).toBe('high')
  })
})

// SC-13: runMaskEditGeneration 的 callbacks 契约 + 返回值 {nodeIds, sourceDeleted}。
// - onTaskSubmitted(taskId): submitEditTask 返回后、poll 前触发(写 message.maskEdit.serverTaskId)。
// - onSelfHealRetry(taskIds): 黑盘自愈重试开始时触发,card 保持 generating。
// - 返回值:source 存在时 sourceDeleted=false;nodeIds 来自 commitGenerationResult。
describe('runMaskEditGeneration callbacks + return value (SC-13)', () => {
  beforeEach(() => {
    taskClientSpies.submitEditTask.mockReset()
    taskClientSpies.pollTask.mockReset()
    taskClientSpies.cancelTask.mockReset()
    inspectArtifactsSpy.mockReset()
  })

  it('onTaskSubmitted: submitEditTask 返 task-1 → onTaskSubmitted 在 poll 前被调 with task-1', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    // 覆盖 commitGenerationResult 避免真实 commit 落图(只测 callback 契约)
    useCanvasStore.setState({
      commitGenerationResult: vi.fn(async () => ['n1']),
    } as never)

    taskClientSpies.submitEditTask.mockResolvedValueOnce('task-1')
    const onTaskSubmitted = vi.fn()
    // pollTask mock 内部断言 onTaskSubmitted 已在 poll 前被调
    taskClientSpies.pollTask.mockImplementationOnce(async () => {
      expect(onTaskSubmitted).toHaveBeenCalledWith('task-1')
      return {
        status: 'done', progress: 100, stage: 'done',
        result: { images: [{ b64: 'ok-b64' }] },
      }
    })

    const result = await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      // 无 maskBounds → canInspect=false,跳过黑盘检查,直接 commit
      payload: { prompt: 'p', sourceSize: { width: 200, height: 200 } } as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
      callbacks: { onTaskSubmitted },
    })

    expect(onTaskSubmitted).toHaveBeenCalledWith('task-1')
    expect(result.nodeIds).toEqual(['n1'])
  })

  it('onSelfHealRetry: 首 attempt done+black → 第二 attempt → onSelfHealRetry([task-1, task-2]) 被调', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    useCanvasStore.setState({
      commitGenerationResult: vi.fn(async () => ['n1']),
    } as never)

    taskClientSpies.submitEditTask
      .mockResolvedValueOnce('task-1') // first attempt
      .mockResolvedValueOnce('task-2') // self-heal retry
    taskClientSpies.pollTask
      .mockResolvedValueOnce({
        status: 'done', progress: 100, stage: 'done',
        result: { images: [{ b64: 'black-plate-b64' }] }, // first attempt returns black-plate
      })
      .mockResolvedValueOnce({
        status: 'done', progress: 100, stage: 'done',
        result: { images: [{ b64: 'ok-b64' }] }, // retry returns non-black
      })
    inspectArtifactsSpy
      .mockResolvedValueOnce(artifactHit()) // first result detected as black → retry
      .mockResolvedValueOnce(artifactClean()) // retry result not black → no warn

    const onSelfHealRetry = vi.fn()
    await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      // 有 maskBounds → canInspect=true,触发黑盘检查
      payload: {
        prompt: 'p',
        sourceSize: { width: 200, height: 200 },
        maskBounds: { x: 10, y: 10, width: 50, height: 50 },
      } as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
      callbacks: { onSelfHealRetry },
    })

    // SC-13: onSelfHealRetry 收到两个 attempt 的 taskId 列表
    expect(onSelfHealRetry).toHaveBeenCalledWith(['task-1', 'task-2'])
  })

  it('返回值 {nodeIds, sourceDeleted}: source 存在时 sourceDeleted=false,nodeIds 来自 commitGenerationResult', async () => {
    const source = imageNode({ id: 'src-exists' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    useCanvasStore.setState({
      commitGenerationResult: vi.fn(async () => ['n1']),
    } as never)

    taskClientSpies.submitEditTask.mockResolvedValueOnce('task-1')
    taskClientSpies.pollTask.mockResolvedValueOnce({
      status: 'done', progress: 100, stage: 'done',
      result: { images: [{ b64: 'ok-b64' }] },
    })

    const result = await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: { prompt: 'p', sourceSize: { width: 200, height: 200 } } as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
    })

    // source 仍在 canvas → sourceDeleted=false
    expect(result.sourceDeleted).toBe(false)
    // nodeIds 来自 commitGenerationResult 的返回值
    expect(result.nodeIds).toEqual(['n1'])
  })
})

// F2 (审 P2): onSelfHealRetry 时机——拿到 task-2 后立即触发（submit 后、第二次 poll done 前）。
// 旧实现在第二次 runOneAttempt 完整结束后才触发 onSelfHealRetry（phase 几乎不可见）；
// 修复后在 runOneAttempt 的 onSubmitted 回调里触发,即 submitEditTask 返回 task-2 后、poll 前。
// 断言手段:第二次 pollTask 被调时,onSelfHealRetry 应已被调（证明它在 poll 返回 done 前触发）。
describe('runMaskEditGeneration onSelfHealRetry 时机 (F2)', () => {
  beforeEach(() => {
    taskClientSpies.submitEditTask.mockReset()
    taskClientSpies.pollTask.mockReset()
    taskClientSpies.cancelTask.mockReset()
    inspectArtifactsSpy.mockReset()
  })

  it('onSelfHealRetry 在 task-2 submit 后、第二次 poll done 前被调', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    useCanvasStore.setState({
      commitGenerationResult: vi.fn(async () => ['n1']),
    } as never)

    taskClientSpies.submitEditTask
      .mockResolvedValueOnce('task-1') // first attempt
      .mockResolvedValueOnce('task-2') // self-heal retry
    inspectArtifactsSpy
      .mockResolvedValueOnce(artifactHit())  // first result black → retry
      .mockResolvedValueOnce(artifactClean()) // retry result not black → no warn

    const onSelfHealRetry = vi.fn()
    // F2 关键:第二次 pollTask 被调时,断言 onSelfHealRetry 已经被调过
    // (证明它在 submitEditTask 返回 task-2 后、第二次 poll done 前触发)
    taskClientSpies.pollTask
      .mockResolvedValueOnce({
        status: 'done', progress: 100, stage: 'done',
        result: { images: [{ b64: 'black-plate-b64' }] }, // first attempt returns black-plate
      })
      .mockImplementationOnce(async () => {
        // 此时 onSelfHealRetry 应已触发(F2: onSubmitted 回调在 poll 前)
        expect(onSelfHealRetry).toHaveBeenCalledWith(['task-1', 'task-2'])
        return {
          status: 'done', progress: 100, stage: 'done',
          result: { images: [{ b64: 'ok-b64' }] }, // retry returns non-black
        }
      })

    await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      // 有 maskBounds → canInspect=true,触发黑盘检查
      payload: {
        prompt: 'p',
        sourceSize: { width: 200, height: 200 },
        maskBounds: { x: 10, y: 10, width: 50, height: 50 },
      } as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
      callbacks: { onSelfHealRetry },
    })

    // 最终 onSelfHealRetry 收到 [task-1, task-2]
    expect(onSelfHealRetry).toHaveBeenCalledWith(['task-1', 'task-2'])
  })
})

// 黑块修复：自愈失败不 commit + 历史洞区/坐标空间元数据。
//  ① 第一次区域外黑 → 新 idempotency 重试；第二次干净 → commit（带 maskSourceSize）。
//  ② 两次全黑 → reject（upstream-error）且 commitGenerationResult 未被调 —— 宁可失败不落坏图。
//  ③ source 带 generation.maskBounds+maskSourceSize → 检测输入携带映射后的 priorMaskBoundsPx。
describe('runMaskEditGeneration 黑块自愈失败不 commit（黑块修复）', () => {
  beforeEach(() => {
    taskClientSpies.submitEditTask.mockReset()
    taskClientSpies.pollTask.mockReset()
    taskClientSpies.cancelTask.mockReset()
    inspectArtifactsSpy.mockReset()
  })

  const boundsPayload = {
    prompt: 'p',
    sourceSize: { width: 200, height: 200 },
    maskBounds: { x: 10, y: 10, width: 50, height: 50 },
  }

  it('① 第一次区域外黑 → 重试；第二次干净 → commit，且 commit payload 带 maskSourceSize', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    const commitSpy = vi.fn(async () => ['n1'])
    useCanvasStore.setState({ commitGenerationResult: commitSpy } as never)

    taskClientSpies.submitEditTask
      .mockResolvedValueOnce('task-1')
      .mockResolvedValueOnce('task-2')
    taskClientSpies.pollTask
      .mockResolvedValueOnce({ status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: 'black-out-of-mask' }] } })
      .mockResolvedValueOnce({ status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: 'clean-b64' }] } })
    inspectArtifactsSpy
      .mockResolvedValueOnce(artifactHit('out-of-mask-new-black-component'))
      .mockResolvedValueOnce(artifactClean())

    const result = await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: boundsPayload as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
    })

    expect(taskClientSpies.submitEditTask).toHaveBeenCalledTimes(2)
    // 重试必须换新 idempotencyKey（BFF 按 key dedupe，复用会返回缓存的坏 task）
    const key1 = (taskClientSpies.submitEditTask.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey
    const key2 = (taskClientSpies.submitEditTask.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey
    expect(key1).toBeTruthy()
    expect(key2).toBeTruthy()
    expect(key1).not.toBe(key2)
    expect(result.nodeIds).toEqual(['n1'])
    expect(commitSpy).toHaveBeenCalledTimes(1)
    const commitPayload = (commitSpy.mock.calls[0] as unknown[])[0] as { maskSourceSize?: { width: number; height: number }; resultImages: Array<{ b64: string }> }
    // 坐标空间标定：结果节点作为下次编辑 source 时用于历史洞区检测
    expect(commitPayload.maskSourceSize).toEqual({ width: 200, height: 200 })
    // commit 的是重试（干净）结果
    expect(commitPayload.resultImages[0].b64).toBe('clean-b64')
  })

  it('② 两次全黑 → reject 且 commitGenerationResult 未被调', async () => {
    const source = imageNode({ id: 'src-1' })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    const commitSpy = vi.fn(async () => ['n1'])
    useCanvasStore.setState({ commitGenerationResult: commitSpy } as never)

    taskClientSpies.submitEditTask
      .mockResolvedValueOnce('task-1')
      .mockResolvedValueOnce('task-2')
    taskClientSpies.pollTask
      .mockResolvedValueOnce({ status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: 'black-1' }] } })
      .mockResolvedValueOnce({ status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: 'black-2' }] } })
    inspectArtifactsSpy
      .mockResolvedValueOnce(artifactHit('current-mask-black-plate'))
      .mockResolvedValueOnce(artifactHit('out-of-mask-new-black-component'))

    await expect(runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: boundsPayload as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ message: '局部重绘结果异常，请重新选择区域或换源图后重试。', kind: 'upstream-error' })

    // 宁可失败不落坏图：坏图绝不 commit
    expect(commitSpy).not.toHaveBeenCalled()
    expect(taskClientSpies.submitEditTask).toHaveBeenCalledTimes(2)
  })

  it('③ source 带上次洞区元数据 → 检测输入携带映射后的 priorMaskBoundsPx', async () => {
    // 上次编辑：源图 400x400、洞区 (100,100,80,80)；本次源图（上次结果）200x200
    // → 等比映射为 (50,50,40,40)。
    const source = imageNode({
      id: 'src-result',
      generation: {
        prompt: 'prev',
        model: 'gpt-image-2',
        maskBounds: { x: 100, y: 100, width: 80, height: 80 },
        maskSourceSize: { width: 400, height: 400 },
      },
      aiWorkflow: { kind: 'result', status: 'ready' } as never,
    })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    useCanvasStore.setState({ commitGenerationResult: vi.fn(async () => ['n1']) } as never)

    taskClientSpies.submitEditTask.mockResolvedValueOnce('task-1')
    taskClientSpies.pollTask.mockResolvedValueOnce({ status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: 'ok-b64' }] } })
    inspectArtifactsSpy.mockResolvedValueOnce(artifactClean())

    await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: boundsPayload as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
    })

    expect(inspectArtifactsSpy).toHaveBeenCalledTimes(1)
    const input = inspectArtifactsSpy.mock.calls[0][0] as { priorMaskBoundsPx?: Array<{ x: number; y: number; width: number; height: number }> }
    expect(input.priorMaskBoundsPx).toEqual([{ x: 50, y: 50, width: 40, height: 40 }])
  })

  it('③b maskSourceSize 缺失（旧数据）→ priorMaskBoundsPx 不携带（坐标空间不明，跳过）', async () => {
    const source = imageNode({
      id: 'src-legacy',
      generation: {
        prompt: 'prev',
        model: 'gpt-image-2',
        maskBounds: { x: 100, y: 100, width: 80, height: 80 },
        // 无 maskSourceSize
      },
    })
    seed(seedCanvas('character-flow', [source]))
    const { slotId } = prepareMaskEditPlaceholder('character-flow', source, 'p')
    useCanvasStore.setState({ commitGenerationResult: vi.fn(async () => ['n1']) } as never)

    taskClientSpies.submitEditTask.mockResolvedValueOnce('task-1')
    taskClientSpies.pollTask.mockResolvedValueOnce({ status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: 'ok-b64' }] } })
    inspectArtifactsSpy.mockResolvedValueOnce(artifactClean())

    await runMaskEditGeneration({
      sceneId: 'character-flow',
      source,
      slotId,
      resolvedAssetUrl: undefined,
      payload: boundsPayload as never,
      imgRatio: '1:1' as never,
      signal: new AbortController().signal,
    })

    const input = inspectArtifactsSpy.mock.calls[0][0] as { priorMaskBoundsPx?: unknown }
    expect(input.priorMaskBoundsPx).toBeUndefined()
  })
})
