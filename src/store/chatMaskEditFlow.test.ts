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
const maskEditGenSpies = vi.hoisted(() => ({
  runMaskEditGeneration: vi.fn(),
  removeMaskEditPlaceholder: vi.fn(),
}))
vi.mock('../canvas/maskEditGeneration', () => ({
  runMaskEditGeneration: maskEditGenSpies.runMaskEditGeneration,
  removeMaskEditPlaceholder: maskEditGenSpies.removeMaskEditPlaceholder,
  prepareMaskEditPlaceholder: vi.fn(() => ({ slotId: 'slot-1', baselineSnapshot: undefined })),
}))

// 控制 useCanvasStore.getState() 返回的 sceneId/canvases(用于跨场景 notice 逻辑)。
// chatMaskEditFlow 的 finishMaskEditMessage/failMaskEditMessage 只读 sceneId + canvases[sceneId].title。
const canvasStoreStub = vi.hoisted(() => ({
  sceneId: 'scene-1',
  canvases: {} as Record<string, { title: string }>,
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
