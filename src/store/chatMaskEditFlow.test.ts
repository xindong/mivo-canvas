import { describe, expect, it, vi, beforeEach } from 'vitest'

// FIX-A test: 安装 in-memory localStorage 让 zustand persist 在 node env 能加载
// (同 chatStore.test.ts 模式)。
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

// Hermetic setup: 同 chatStore.test.ts 的 mock 模式,让 useChatStore 能在 node env 加载。
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1,
    title: name,
    hasTransparency: false,
    size: '100x100',
    dimensions: undefined,
    sourceDimensions: { width: 100, height: 100 },
  })),
  saveImportedAsset: vi.fn(),
  readImportedAssetFile: vi.fn(),
}))
vi.mock('../lib/mivoImageClient', () => ({
  enhanceMivoPrompt: vi.fn(),
  MivoImageRequestError: class MivoImageRequestError extends Error {
    kind: string
    constructor(message: string, kind: string) {
      super(message)
      this.name = 'MivoImageRequestError'
      this.kind = kind
    }
  },
}))
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))
const genFacadeSpies = vi.hoisted(() => ({
  prepareChatSlot: vi.fn(),
  generateIntoAiSlot: vi.fn(),
  generateBesideNode: vi.fn(),
  getSceneChangeInfo: vi.fn(),
}))
vi.mock('./generationFacade', () => ({ generationFacade: genFacadeSpies }))

// mask-chat-card 专属 mock: runMaskEditGeneration / removeMaskEditPlaceholder
// (chat flow 不直写 canvas,经 callbacks 驱动卡片状态)。
// edit-timeout-batch: prepareMaskEditPlaceholder 也纳入 hoisted spies,供 retry 单测
// 控制「新 slotId」返回值（retryMaskEditMessage 会调它建新 placeholder）。
const maskEditGenSpies = vi.hoisted(() => ({
  runMaskEditGeneration: vi.fn(),
  removeMaskEditPlaceholder: vi.fn(),
  prepareMaskEditPlaceholder: vi.fn(() => ({ slotId: 'slot-1', baselineSnapshot: undefined })),
}))
vi.mock('../canvas/maskEditGeneration', () => ({
  runMaskEditGeneration: maskEditGenSpies.runMaskEditGeneration,
  removeMaskEditPlaceholder: maskEditGenSpies.removeMaskEditPlaceholder,
  prepareMaskEditPlaceholder: maskEditGenSpies.prepareMaskEditPlaceholder,
}))

// 控制 useCanvasStore.getState() 返回的 sceneId/canvases(用于跨场景 notice 逻辑)。
// chatMaskEditFlow 的 finishMaskEditMessage/failMaskEditMessage 只读 sceneId + canvases[sceneId].title。
// edit-timeout-batch: failMaskEditMessage/retryMaskEditMessage 还读 canvases[sceneId].nodes
// 判 source 是否仍存在（some(n.id === sourceNodeId && n.type==='image' && !n.hidden)）。
const canvasStoreStub = vi.hoisted(() => ({
  sceneId: 'scene-1',
  canvases: {} as Record<string, { title: string; nodes?: { id: string; type: string; hidden?: boolean }[] }>,
}))
vi.mock('../store/canvasStore', () => ({
  useCanvasStore: {
    getState: () => ({
      sceneId: canvasStoreStub.sceneId,
      canvases: canvasStoreStub.canvases,
    }),
  },
}))

// cancelMaskEditMessage 的 best-effort 动态 import(fire-and-forget)。
// cancelTask 必须返回 Promise,否则 `cancelTask(id).catch()` 会 TypeError。
const taskClientSpies = vi.hoisted(() => ({
  cancelTask: vi.fn(() => Promise.resolve()),
}))
vi.mock('../lib/mivoTaskClient', () => ({
  cancelTask: taskClientSpies.cancelTask,
  submitEditTask: vi.fn(),
  pollTask: vi.fn(),
  taskPollIntervalMs: () => 10000,
  kindForFailedTask: () => 'upstream-error',
}))

import { useChatStore } from './chatStore'
import { enhanceMivoPrompt, MivoImageRequestError } from '../lib/mivoImageClient'
import {
  beginMaskEditMessage,
  runMaskEditChatFlow,
  cancelMaskEditMessage,
  retryMaskEditMessage,
} from './chatMaskEditFlow'
import {
  registerMaskEditTask,
  getMaskEditTask,
  __resetMaskEditTaskRegistryForTests,
  type ActiveMaskEditTask,
} from './maskEditTaskRuntime'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { ImageMaskSubmitPayload } from '../canvas/imageMaskGeometry'

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

const basePayload = (overrides: Partial<ImageMaskSubmitPayload> = {}): ImageMaskSubmitPayload => ({
  prompt: '把妹子换成帅哥',
  maskBounds: { x: 10, y: 10, width: 50, height: 50 },
  sourceSize: { width: 200, height: 200 },
  quality: 'medium',
  ...overrides,
})

const makeRecord = (overrides: Partial<ActiveMaskEditTask> = {}): ActiveMaskEditTask => ({
  sceneId: 'scene-1',
  messageId: 'msg-test',
  slotId: 'slot-1',
  abortController: new AbortController(),
  source: imageNode(),
  resolvedAssetUrl: undefined,
  payload: basePayload(),
  imgRatio: '1:1',
  quality: 'medium',
  ...overrides,
})

beforeEach(() => {
  ;(globalThis as { localStorage: { clear: () => void } }).localStorage.clear()
  useChatStore.setState({ ...useChatStore.getInitialState() } as never, true)
  canvasStoreStub.sceneId = 'scene-1'
  canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One' } }
  vi.mocked(enhanceMivoPrompt).mockReset()
  maskEditGenSpies.runMaskEditGeneration.mockReset()
  maskEditGenSpies.removeMaskEditPlaceholder.mockReset()
  maskEditGenSpies.prepareMaskEditPlaceholder.mockReset()
  maskEditGenSpies.prepareMaskEditPlaceholder.mockImplementation(() => ({ slotId: 'slot-1', baselineSnapshot: undefined }))
  taskClientSpies.cancelTask.mockReset()
  taskClientSpies.cancelTask.mockImplementation(() => Promise.resolve())
  __resetMaskEditTaskRegistryForTests()
})

// Tests -----------------------------------------------------------------------

describe('beginMaskEditMessage (SC-01)', () => {
  it('调后 messagesByScene[scene] 末尾出现 user(done) + assistant(enhancing, origin=mask-edit, phase=enhancing, pendingSlotId=slotId),返回 messageId 非空', () => {
    const source = imageNode({ id: 'src-a' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-x',
      imgRatio: '1:1',
      quality: 'medium',
    })

    expect(messageId).toBeTruthy()
    expect(typeof messageId).toBe('string')

    const messages = useChatStore.getState().messagesByScene['scene-1']
    expect(messages).toHaveLength(2)
    // user prompt bubble
    expect(messages[0]).toMatchObject({
      role: 'user',
      kind: 'text',
      text: '把妹子换成帅哥',
      status: 'done',
      origin: 'mask-edit',
    })
    // assistant loading card
    expect(messages[1]).toMatchObject({
      id: messageId,
      role: 'assistant',
      kind: 'text',
      status: 'enhancing',
      origin: 'mask-edit',
    })
    expect(messages[1].generationContext).toMatchObject({
      sourceNodeId: 'src-a',
      sourceNodeType: 'image',
      pendingSlotId: 'slot-x',
      maskEdit: { sourceTitle: 'Source', phase: 'enhancing' },
    })
  })
})

describe('runMaskEditChatFlow (SC-04/10/05/06/07/12/16)', () => {
  it('SC-04/10 成功路径: enhance generate mode → generating→done, resultNodeIds, sourceDeleted=false, registry 清空', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true,
      mode: 'generate',
      richPrompt: 'Replace the selected masked character with a handsome male.',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockImplementationOnce(async (args) => {
      // SC-13 契约:onTaskSubmitted 在 poll 前触发,写 serverTaskId
      args.callbacks?.onTaskSubmitted?.('task-1')
      return { nodeIds: ['n1'], sourceDeleted: false }
    })

    const source = imageNode({ id: 'src-ok' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-1',
      imgRatio: '1:1',
      quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)

    await runMaskEditChatFlow(record)

    const messages = useChatStore.getState().messagesByScene['scene-1']
    const assistant = messages.find((m) => m.id === messageId)!

    // enhance generate mode:patch 后 status 经 generating → done
    expect(assistant.status).toBe('done')
    expect(assistant.resultNodeIds).toEqual(['n1'])
    // SC-16 反向:source 存在时 sourceDeleted 落到 message 为 false(实现按 args.sourceDeleted 写)
    expect(assistant.generationContext?.maskEdit?.sourceDeleted).toBe(false)
    // SC-04:runMaskEditGeneration 收到的 payload.prompt 用 richPrompt
    const genCall = maskEditGenSpies.runMaskEditGeneration.mock.calls.at(-1)?.[0] as {
      payload: { prompt: string }
    }
    expect(genCall.payload.prompt).toBe('Replace the selected masked character with a handsome male.')
    // registry 清空
    expect(getMaskEditTask(messageId)).toBeUndefined()
  })

  it('SC-05 degraded: enhance 返 degradedReason=timeout → runMaskEditGeneration payload.prompt 用原始 overlay prompt,enhance.degradedReason 透传', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: false,
      degradedReason: 'timeout',
      stage: 'fallback',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    const source = imageNode({ id: 'src-deg' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-1',
      imgRatio: '1:1',
      quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)

    await runMaskEditChatFlow(record)

    // SC-05:runMaskEditGeneration 收到的 payload.prompt 是原始 overlay prompt(未用 richPrompt)
    const genCall = maskEditGenSpies.runMaskEditGeneration.mock.calls.at(-1)?.[0] as {
      payload: { prompt: string }
    }
    expect(genCall.payload.prompt).toBe('把妹子换成帅哥')

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('done')
    // degradedReason/stage 透传到 message.enhance
    expect(assistant.enhance?.degradedReason).toBe('timeout')
    expect(assistant.enhance?.stage).toBe('fallback')
    expect(getMaskEditTask(messageId)).toBeUndefined()
  })

  it('SC-06 chat mode: enhance 返 replyText → runMaskEditGeneration payload.prompt 用原始 prompt,done 后当前 scene 有 mask-edit notice 含 replyText', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true,
      mode: 'chat',
      replyText: '我会按你选中的区域改,未选区域保持不变。',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    const source = imageNode({ id: 'src-chat' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-1',
      imgRatio: '1:1',
      quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)

    await runMaskEditChatFlow(record)

    // SC-06:runMaskEditGeneration 收到的 payload.prompt 是原始 overlay prompt
    const genCall = maskEditGenSpies.runMaskEditGeneration.mock.calls.at(-1)?.[0] as {
      payload: { prompt: string }
    }
    expect(genCall.payload.prompt).toBe('把妹子换成帅哥')

    const messages = useChatStore.getState().messagesByScene['scene-1']
    const assistant = messages.find((m) => m.id === messageId)!
    expect(assistant.status).toBe('done')

    // SC-06:done 后当前 scene 有 origin:'mask-edit' notice 文本含 replyText
    const notices = messages.filter((m) => m.kind === 'notice' && m.origin === 'mask-edit')
    expect(notices.length).toBeGreaterThanOrEqual(1)
    expect(notices.at(-1)?.text).toContain('我会按你选中的区域改')
  })

  it('SC-07 enhance 阶段取消: abort 后 flow 自己查 signal.aborted 抛 canceled,runMaskEditGeneration 未调,removeMaskEditPlaceholder(canceled),assistant error/canceled,registry 清空', async () => {
    // enhance 返正常值(不 reject),但 flow 在 await 后查 signal.aborted === true → throw canceled
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true,
      mode: 'generate',
      richPrompt: 'x',
    } as never)

    const ac = new AbortController()
    const source = imageNode({ id: 'src-cancel' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-1',
      imgRatio: '1:1',
      quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source, abortController: ac })
    registerMaskEditTask(record)

    // 提交前先 abort(模拟卡片取消在 enhance 阶段触发)
    ac.abort()
    await runMaskEditChatFlow(record)

    // SC-07:cancel 在 enhance 阶段 → 不得 POST /tasks/edit
    expect(maskEditGenSpies.runMaskEditGeneration).not.toHaveBeenCalled()
    // removeMaskEditPlaceholder 被调(canceled:true)
    expect(maskEditGenSpies.removeMaskEditPlaceholder).toHaveBeenCalledWith(
      'scene-1',
      'slot-1',
      expect.objectContaining({ canceled: true }),
    )
    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    expect(assistant.errorKind).toBe('canceled')
    expect(assistant.retryDisabledReason).toBeTruthy()
    // registry 清空(后台 catch 收口 clearMaskEditTask)
    expect(getMaskEditTask(messageId)).toBeUndefined()
  })

  it('SC-12 失败: runMaskEditGeneration reject MivoImageRequestError(upstream-error) → removeMaskEditPlaceholder(canceled:false),assistant error/upstream-error,registry 清空', async () => {
    // 计划写 upstream-http,但 upstream-http 不是 MivoImageRequestErrorKind 合法成员
    // (属于 EnhanceDegradedReason)。这里用合法的 upstream-error。
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true,
      mode: 'generate',
      richPrompt: 'x',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('上游失败', 'upstream-error'),
    )

    const source = imageNode({ id: 'src-fail' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-1',
      imgRatio: '1:1',
      quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)

    await runMaskEditChatFlow(record)

    // removeMaskEditPlaceholder 被调(canceled:false,因 signal 未 abort 且 error.kind !== 'canceled')
    expect(maskEditGenSpies.removeMaskEditPlaceholder).toHaveBeenCalledWith(
      'scene-1',
      'slot-1',
      expect.objectContaining({ canceled: false, error: '上游失败' }),
    )
    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    expect(assistant.errorKind).toBe('upstream-error')
    expect(assistant.retryDisabledReason).toBeTruthy()
    expect(getMaskEditTask(messageId)).toBeUndefined()
  })

  it('SC-16 sourceDeleted: runMaskEditGeneration 返 sourceDeleted=true → assistant.maskEdit.sourceDeleted === true', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true,
      mode: 'generate',
      richPrompt: 'x',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: true })

    const source = imageNode({ id: 'src-del' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1',
      source,
      prompt: '把妹子换成帅哥',
      slotId: 'slot-1',
      imgRatio: '1:1',
      quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)

    await runMaskEditChatFlow(record)

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('done')
    // SC-16 审 F3:chat state 断言 sourceDeleted === true(不能只验 no edge)
    expect(assistant.generationContext?.maskEdit?.sourceDeleted).toBe(true)
  })
})

// F3 (审 P3): buildEditContext maskKind 派生。buildEditContext 未导出,通过 runMaskEditChatFlow
// 间接测——mock enhanceMivoPrompt 捕获入参 editContext,验证三种 payload 的 hasMask/maskKind 组合。
// 修复点:旧实现 bounds-only payload(maskBounds 有、mask 无)会派生 hasMask=false+maskKind='bounds'
// 的矛盾语义;修复后 hasMask=true+maskKind='bounds'。
describe('runMaskEditChatFlow buildEditContext maskKind 派生 (F3)', () => {
  it('mask blob + maskBounds → hasMask=true, maskKind=brush', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true, mode: 'generate', richPrompt: 'x',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    const source = imageNode({ id: 'src-f3a' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({
      messageId, sceneId: 'scene-1', slotId: 'slot-1', source,
      payload: basePayload({ mask: new Blob([], { type: 'image/png' }) }),
    })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const call = vi.mocked(enhanceMivoPrompt).mock.calls.at(-1)![0] as {
      editContext: { hasMask: boolean; maskKind: 'brush' | 'bounds' | undefined }
    }
    expect(call.editContext.hasMask).toBe(true)
    expect(call.editContext.maskKind).toBe('brush')
  })

  it('仅 maskBounds（bounds-only 无 mask blob）→ hasMask=true, maskKind=bounds（F3 修复点）', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true, mode: 'generate', richPrompt: 'x',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    const source = imageNode({ id: 'src-f3b' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    // basePayload 默认有 maskBounds 无 mask — 正好是 bounds-only 场景
    const record = makeRecord({
      messageId, sceneId: 'scene-1', slotId: 'slot-1', source,
      payload: basePayload(),
    })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const call = vi.mocked(enhanceMivoPrompt).mock.calls.at(-1)![0] as {
      editContext: { hasMask: boolean; maskKind: 'brush' | 'bounds' | undefined }
    }
    // F3 修复点:旧实现 hasMask=false + maskKind='bounds' 矛盾;修复后 hasMask=true + maskKind='bounds'
    expect(call.editContext.hasMask).toBe(true)
    expect(call.editContext.maskKind).toBe('bounds')
  })

  it('两者都无 → hasMask=false, maskKind=undefined', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({
      enhanced: true, mode: 'generate', richPrompt: 'x',
    } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    const source = imageNode({ id: 'src-f3c' })
    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({
      messageId, sceneId: 'scene-1', slotId: 'slot-1', source,
      payload: basePayload({ maskBounds: undefined }),
    })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const call = vi.mocked(enhanceMivoPrompt).mock.calls.at(-1)![0] as {
      editContext: { hasMask: boolean; maskKind: 'brush' | 'bounds' | undefined }
    }
    expect(call.editContext.hasMask).toBe(false)
    expect(call.editContext.maskKind).toBeUndefined()
  })
})

describe('cancelMaskEditMessage (SC-08/15)', () => {
  it('SC-08 runtime 在: register record → cancelMaskEditMessage abort 了 controller,返回,不删 registry(由后台 catch 收口),不调 removeMaskEditPlaceholder', () => {
    const ac = new AbortController()
    const record = makeRecord({ messageId: 'msg-runtime', abortController: ac })
    registerMaskEditTask(record)

    cancelMaskEditMessage('scene-1', 'msg-runtime')

    // abort 发生
    expect(ac.signal.aborted).toBe(true)
    // runtime 仍有 record(cancelMaskEditMessage 不删,后台 catch 清理)
    expect(getMaskEditTask('msg-runtime')).toBeDefined()
    // runtime 在时直接 return,不调 removeMaskEditPlaceholder
    expect(maskEditGenSpies.removeMaskEditPlaceholder).not.toHaveBeenCalled()
  })

  it('SC-15 刷新后 runtime 不在: seed message 带 serverTaskId+pendingSlotId → cancelMaskEditMessage 标 error/canceled + retryDisabledReason,removeMaskEditPlaceholder(slot-x),cancelTask(task-x)', async () => {
    const messageId = 'msg-refresh'
    useChatStore.setState({
      messagesByScene: {
        'scene-1': [
          {
            id: messageId,
            role: 'assistant',
            kind: 'text',
            text: '',
            createdAt: 0,
            status: 'generating',
            origin: 'mask-edit',
            generationContext: {
              model: 'gpt-image-2',
              requestedImgRatio: 'auto',
              requestedQuality: 'auto',
              pendingSlotId: 'slot-x',
              maskEdit: { serverTaskId: 'task-x', sourceTitle: 'Source' },
            },
          },
        ],
      },
    } as never)

    // 不 register record(模拟刷新后 runtime 丢失)
    cancelMaskEditMessage('scene-1', messageId)

    // message 标 error/canceled + retryDisabledReason
    const msg = useChatStore.getState().messagesByScene['scene-1'][0]
    expect(msg.status).toBe('error')
    expect(msg.errorKind).toBe('canceled')
    expect(msg.retryDisabledReason).toBeTruthy()

    // removeMaskEditPlaceholder 被调(slot-x)
    expect(maskEditGenSpies.removeMaskEditPlaceholder).toHaveBeenCalledWith(
      'scene-1',
      'slot-x',
      expect.objectContaining({ canceled: true, sourceTitle: 'Source' }),
    )

    // cancelTask 被调(task-x) — 动态 import 是 fire-and-forget,需等 macrotask 让链 resolve
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(taskClientSpies.cancelTask).toHaveBeenCalledWith('task-x')
  })
})

// edit-timeout-batch: 超时分级中文文案 + 可重试 CTA + 超时保留 record 供卡片重试复用。
// Item2: failMaskEditMessage 对 upstream-timeout/client-timeout 映射中文「局部重绘上游超时，
// 可稍后重试或降低质量重试」；canceled 维持「已取消生成」；其他错误原样。超时 + source 仍存在
// → retryDisabledReason=undefined（可重试）；超时 + source 已删 → maskEditSourceDeletedRetryDisabledReason；
// canceled/非超时 → maskEditRetryDisabledReason。
describe('runMaskEditChatFlow edit-timeout-batch: 超时文案 + retryable (Item2)', () => {
  it('upstream-timeout + source 存在 → assistant.error=局部重绘上游超时 + retryDisabledReason=undefined + errorKind=upstream-timeout + record 保留', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('Image API request timed out', 'upstream-timeout'),
    )
    const source = imageNode({ id: 'src-timeout-1' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    expect(assistant.error).toBe('局部重绘上游超时，可稍后重试或降低质量重试')
    expect(assistant.errorKind).toBe('upstream-timeout')
    expect(assistant.retryDisabledReason).toBeUndefined()
    // Item3: 超时失败保留 runtime record（含 mask blob/payload）供卡片重试复用
    expect(getMaskEditTask(messageId)).toBeDefined()
  })

  it('upstream-timeout + source 已删 → retryDisabledReason=原图已被删除，无法重试局部重绘', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('Image API request timed out', 'upstream-timeout'),
    )
    const source = imageNode({ id: 'src-timeout-del' })
    // source 已删：canvases[scene].nodes 不含 source 节点
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    expect(assistant.error).toBe('局部重绘上游超时，可稍后重试或降低质量重试')
    expect(assistant.errorKind).toBe('upstream-timeout')
    expect(assistant.retryDisabledReason).toBe('原图已被删除，无法重试局部重绘')
    // record 仍保留（超时一律保留，无论 source 是否存在）
    expect(getMaskEditTask(messageId)).toBeDefined()
  })

  it('client-timeout + source 存在 → assistant.error=局部重绘上游超时 + retryDisabledReason=undefined + errorKind=client-timeout', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('Image API request timed out', 'client-timeout'),
    )
    const source = imageNode({ id: 'src-ctimeout' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    expect(assistant.error).toBe('局部重绘上游超时，可稍后重试或降低质量重试')
    expect(assistant.errorKind).toBe('client-timeout')
    expect(assistant.retryDisabledReason).toBeUndefined()
    expect(getMaskEditTask(messageId)).toBeDefined()
  })

  it('canceled (runMaskEditGeneration reject) → error=已取消生成 + retryDisabledReason=maskEditRetryDisabledReason + record 清空', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('取消', 'canceled'),
    )
    const source = imageNode({ id: 'src-cancel-reject' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    expect(assistant.error).toBe('已取消生成，可修改提示后重试。')
    expect(assistant.errorKind).toBe('canceled')
    expect(assistant.retryDisabledReason).toBe('局部重绘任务已结束，请重新选择区域后再试')
    // canceled → record 清空（不可重试）
    expect(getMaskEditTask(messageId)).toBeUndefined()
  })

  it('非超时 (upstream-error) → error=原 message + retryDisabledReason=maskEditRetryDisabledReason + record 清空', async () => {
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('上游失败', 'upstream-error'),
    )
    const source = imageNode({ id: 'src-upstream-err' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    const assistant = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(assistant.status).toBe('error')
    // 非超时错误：原 message 原样透传
    expect(assistant.error).toBe('上游失败')
    expect(assistant.errorKind).toBe('upstream-error')
    expect(assistant.retryDisabledReason).toBe('局部重绘任务已结束，请重新选择区域后再试')
    // 非超时 → record 清空
    expect(getMaskEditTask(messageId)).toBeUndefined()
  })
})

// Item3: retryMaskEditMessage — 超时卡片重试。复用原 runtime record（含 mask blob/payload/source，
// 超时失败时未清），新建 placeholder + 新 abortController，patch message 回 enhancing，
// 重跑 runMaskEditChatFlow。硬约束：runtime record 在 + source 仍存在且未隐藏。
describe('retryMaskEditMessage (Item3)', () => {
  it('record 在 + source 存在 → prepareMaskEditPlaceholder 被调（新 slotId）、runMaskEditChatFlow 被调（retryRecord）、message patch 回 enhancing、返回 true', async () => {
    // 先制造超时失败（record 保留）
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('Image API request timed out', 'upstream-timeout'),
    )
    const source = imageNode({ id: 'src-retry-ok' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: '把妹子换成帅哥', slotId: 'slot-1', imgRatio: '1:1', quality: 'high',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source, quality: 'high' })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)
    // 确认超时后 record 仍在
    expect(getMaskEditTask(messageId)).toBeDefined()

    // retry 准备：新 slotId + enhance/generation mock 成功
    maskEditGenSpies.prepareMaskEditPlaceholder.mockImplementationOnce(() => ({ slotId: 'slot-2', baselineSnapshot: undefined }))
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    const result = retryMaskEditMessage('scene-1', messageId)
    expect(result).toBe(true)

    // prepareMaskEditPlaceholder 被调（sceneId, source, prompt）
    expect(maskEditGenSpies.prepareMaskEditPlaceholder).toHaveBeenCalledWith('scene-1', source, '把妹子换成帅哥')

    // message patch 回 status='enhancing'
    const msgAfter = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(msgAfter.status).toBe('enhancing')
    expect(msgAfter.error).toBeUndefined()
    expect(msgAfter.retryDisabledReason).toBeUndefined()
    // pendingSlotId 更新为新 slot
    expect(msgAfter.generationContext?.pendingSlotId).toBe('slot-2')

    // 等 runMaskEditChatFlow 推进到 runMaskEditGeneration 被调（retryRecord 传参）
    await vi.waitFor(() => {
      expect(maskEditGenSpies.runMaskEditGeneration).toHaveBeenCalled()
    })
    const genCall = maskEditGenSpies.runMaskEditGeneration.mock.calls.at(-1)?.[0] as { slotId: string; source: { id: string } }
    // retryRecord 用新 slotId
    expect(genCall.slotId).toBe('slot-2')
    // source 复用原 record 的
    expect(genCall.source.id).toBe('src-retry-ok')
  })

  it('source 已删 → 返回 false、runMaskEditGeneration 未调', async () => {
    // 先制造超时失败（record 保留）
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('Image API request timed out', 'upstream-timeout'),
    )
    const source = imageNode({ id: 'src-retry-del' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'medium',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)
    expect(getMaskEditTask(messageId)).toBeDefined()

    // 删除 source（canvases.nodes 清空）
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [] } }

    const genCallsBefore = maskEditGenSpies.runMaskEditGeneration.mock.calls.length
    const result = retryMaskEditMessage('scene-1', messageId)
    expect(result).toBe(false)
    // 等一拍确保 fire-and-forget 没偷偷调
    await new Promise((r) => setTimeout(r, 0))
    expect(maskEditGenSpies.runMaskEditGeneration.mock.calls.length).toBe(genCallsBefore)
  })

  it('record 不在（非超时已清）→ 返回 false', async () => {
    // 不 register record（模拟刷新后 runtime 丢失 / 非超时已清）
    const result = retryMaskEditMessage('scene-1', 'msg-no-record')
    expect(result).toBe(false)
    expect(maskEditGenSpies.runMaskEditGeneration).not.toHaveBeenCalled()
  })

  it('qualityOverride=medium → retryRecord.quality === medium', async () => {
    // 先制造超时失败（record 保留，原 quality=high）
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockRejectedValueOnce(
      new MivoImageRequestError('Image API request timed out', 'upstream-timeout'),
    )
    const source = imageNode({ id: 'src-retry-med' })
    canvasStoreStub.canvases = { 'scene-1': { title: 'Scene One', nodes: [source] } }

    const messageId = beginMaskEditMessage({
      sceneId: 'scene-1', source, prompt: 'p', slotId: 'slot-1', imgRatio: '1:1', quality: 'high',
    })
    const record = makeRecord({ messageId, sceneId: 'scene-1', slotId: 'slot-1', source, quality: 'high' })
    registerMaskEditTask(record)
    await runMaskEditChatFlow(record)

    // retry with qualityOverride='medium'
    maskEditGenSpies.prepareMaskEditPlaceholder.mockImplementationOnce(() => ({ slotId: 'slot-2', baselineSnapshot: undefined }))
    vi.mocked(enhanceMivoPrompt).mockResolvedValueOnce({ enhanced: true, mode: 'generate', richPrompt: 'x' } as never)
    maskEditGenSpies.runMaskEditGeneration.mockResolvedValueOnce({ nodeIds: ['n1'], sourceDeleted: false })

    retryMaskEditMessage('scene-1', messageId, 'medium')

    // message context.quality 同步降为 medium
    const msgAfter = useChatStore.getState().messagesByScene['scene-1'].find((m) => m.id === messageId)!
    expect(msgAfter.generationContext?.quality).toBe('medium')

    // runMaskEditGeneration 收到的 retryRecord.quality === 'medium'
    await vi.waitFor(() => {
      expect(maskEditGenSpies.runMaskEditGeneration).toHaveBeenCalled()
    })
    const genCall = maskEditGenSpies.runMaskEditGeneration.mock.calls.at(-1)?.[0] as { quality: string }
    expect(genCall.quality).toBe('medium')
  })
})
