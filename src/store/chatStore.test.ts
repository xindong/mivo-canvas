import { describe, expect, it, vi, beforeEach } from 'vitest'

// FIX-A test: zustand v5 persist only attaches `api.persist` when
// `createJSONStorage(() => localStorage)` resolves a storage. Node env has no
// window/localStorage, so we install an in-memory localStorage before the store
// module loads (same pattern as canvasStore.contract.test.ts). Runs in vi.hoisted
// so it executes before the `import` below.
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k) },
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage }
  if (g.localStorage === undefined) g.localStorage = memStorage
})

// Hermetic setup: stub demo-image canvas renderer (canvasStore triggers scenes() at
// module load), the IndexedDB-backed asset store, the enhance endpoint, and the remote
// debug-log flusher — same approach as canvasStore.contract.test.ts.
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
  saveImportedAsset: vi.fn(), // configured per-test
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

// FIX-4 test: mock generationFacade so retryMessage can be driven without the
// canvas store. Spies are controllable per-test (resolve/reject generateIntoAiSlot).
const genFacadeSpies = vi.hoisted(() => ({
  prepareChatSlot: vi.fn(),
  generateIntoAiSlot: vi.fn(),
  generateBesideNode: vi.fn(),
  getSceneChangeInfo: vi.fn(),
}))
vi.mock('./generationFacade', () => ({ generationFacade: genFacadeSpies }))

// SC-19: mock chatMaskEditFlow 的 cancelMaskEditMessage 为 spy,验证 cancelGeneration
// 分支顺序——origin:'mask-edit' 的 in-flight message 委托 cancelMaskEditMessage,
// 不走全局 activeChatAbortController(保证 chat×mask 并行取消隔离)。
const maskEditFlowSpies = vi.hoisted(() => ({
  cancelMaskEditMessage: vi.fn(),
}))
vi.mock('./chatMaskEditFlow', () => ({
  cancelMaskEditMessage: maskEditFlowSpies.cancelMaskEditMessage,
  beginMaskEditMessage: vi.fn(() => 'mask-msg-stub'),
  runMaskEditChatFlow: vi.fn(async () => {}),
  finishMaskEditMessage: vi.fn(),
  failMaskEditMessage: vi.fn(),
  setChatStoreAccessor: vi.fn(() => {}),
}))

import { useChatStore } from './chatStore'
import { saveImportedAsset, readImportedAssetFile } from '../lib/assetStorage'
import { enhanceMivoPrompt } from '../lib/mivoImageClient'
import { debugLogger } from './debugLogStore'

beforeEach(() => {
  // Clear the in-memory localStorage so each test starts clean (FIX-A hydration
  // test writes to it; other tests must not see stale persisted state).
  ;(globalThis as { localStorage: { clear: () => void } }).localStorage.clear()
  useChatStore.setState({ ...useChatStore.getInitialState() } as never, true)
  vi.mocked(saveImportedAsset).mockReset()
})

describe('sendMessage (S03b: 参考图保存失败不丢消息)', () => {
  it('参考图保存失败时落 user + assistant error 两条消息，保留用户输入文本', async () => {
    vi.mocked(saveImportedAsset).mockRejectedValueOnce(new Error('磁盘满了'))
    const file = new File(['x'], 'ref.png', { type: 'image/png' })

    await useChatStore.getState().sendMessage({
      sceneId: 'scene-1',
      text: '画一只橘猫',
      referenceFiles: [file],
    })

    const messages = useChatStore.getState().messagesByScene['scene-1']
    expect(messages).toHaveLength(2)
    // user 消息保留用户输入文本
    expect(messages[0]).toMatchObject({
      role: 'user',
      kind: 'text',
      text: '画一只橘猫',
      status: 'done',
    })
    // assistant 消息为失败态，文案带错误原因
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      status: 'error',
      errorKind: 'unknown',
    })
    expect(messages[1].text).toMatch(/参考图保存失败.*磁盘满了/)
    expect(messages[1].error).toMatch(/参考图保存失败.*磁盘满了/)
    // S03b: 无 generationContext 可供 retryMessage 重放，显式禁用 Retry 按钮避免死按钮
    expect(messages[1].retryDisabledReason).toBe('参考图保存失败，请重新选择图片后再发送')
    // isBusy 从未置 true，无残留
    expect(useChatStore.getState().isBusy).toBe(false)
  })

  it('参考图保存失败的 assistant 消息禁用 Retry（避免死按钮：retryMessage 无 context 会静默 return）', async () => {
    // ChatMessageList 对 status:'error' 且无 retryDisabledReason 的消息渲染可点 Retry 按钮，
    // 点击后 retryMessage 因无 generationContext 在 :550-551 直接 return——按钮点了没反应。
    // failedAssistantMessage 显式带 retryDisabledReason → 按钮 disabled，引导用户重选图片。
    vi.mocked(saveImportedAsset).mockRejectedValueOnce(new Error('磁盘满了'))
    const file = new File(['x'], 'ref.png', { type: 'image/png' })

    await useChatStore.getState().sendMessage({
      sceneId: 'scene-3',
      text: '画一只橘猫',
      referenceFiles: [file],
    })

    const messages = useChatStore.getState().messagesByScene['scene-3']
    const failedAssistant = messages[1]
    expect(failedAssistant.status).toBe('error')
    expect(failedAssistant.generationContext).toBeUndefined() // 无 context 可重放
    expect(failedAssistant.retryDisabledReason).toBeTruthy() // 显式禁用 Retry
    // retryMessage 对该消息应直接 return（无 context），不抛错也不重放
    const retryResult = useChatStore.getState().retryMessage({
      sceneId: 'scene-3',
      messageId: failedAssistant.id,
    })
    await retryResult
    // 重试后消息形态不变（仍是 error + retryDisabledReason）
    const afterRetry = useChatStore.getState().messagesByScene['scene-3'][1]
    expect(afterRetry.status).toBe('error')
    expect(afterRetry.retryDisabledReason).toBeTruthy()
  })

  it('无参考图时正常路径不触发 catch（回归保护）', async () => {
    // 无 referenceFiles → saveReferenceAssets([]) 不调 saveImportedAsset，不 reject。
    // 此用例确认 catch 仅在真的有参考图失败时触发，不影响正常流的前置 guard。
    vi.mocked(saveImportedAsset).mockRejectedValueOnce(new Error('不应被调用'))
    // sendMessage 会进入 enhance 流程；这里只断言没因 catch 落两条失败消息
    await useChatStore
      .getState()
      .sendMessage({ sceneId: 'scene-2', text: '你好' })
      .catch(() => {})
    const messages = useChatStore.getState().messagesByScene['scene-2'] || []
    // 正常流会落 user + assistant（enhancing→...），但不应是"参考图保存失败"的 error
    expect(messages.some((m) => m.error?.includes('参考图保存失败'))).toBe(false)
  })
})

// S01: sendMessage(:228) / retryMessage(:494) 第二道 isBusy return 不能静默丢输入。
// send 路径：参考图已落 IDB，必须落失败态消息引用 referenceAssetUrls（不孤儿、不丢输入）。
// retry 路径：targetMsg 仍在、referenceFiles 临时读出未消费，warn 后 return 即可。
describe('S01: isBusy 第二道 return 不丢输入/无孤儿参考图', () => {
  beforeEach(() => {
    vi.mocked(saveImportedAsset).mockReset()
    vi.mocked(readImportedAssetFile).mockReset()
    vi.mocked(enhanceMivoPrompt).mockReset()
  })

  it('参考图保存后 isBusy → 落 user+assistant(error) 消息，referenceAssetUrls 被引用，可 retry', async () => {
    // 模拟 await saveReferenceAssets 期间另一生成启动：saveImportedAsset 在 resolve 前
    // 把 isBusy 翻成 true，命中 :228 第二道 return。
    vi.mocked(saveImportedAsset).mockImplementationOnce(async () => {
      useChatStore.setState({ isBusy: true })
      return {
        assetUrl: 'mivo-asset://busy-ref',
        name: 'ref.png',
        type: 'image/png',
        sizeBytes: 1,
        title: 'ref',
        size: '100x100',
        dimensions: undefined,
        sourceDimensions: { width: 100, height: 100 },
        hasTransparency: false,
      }
    })
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    const file = new File(['x'], 'ref.png', { type: 'image/png' })

    await useChatStore.getState().sendMessage({
      sceneId: 'scene-busy',
      text: '画一只橘猫',
      referenceFiles: [file],
    })

    const messages = useChatStore.getState().messagesByScene['scene-busy']
    expect(messages).toHaveLength(2)
    // 用户输入保留
    expect(messages[0]).toMatchObject({ role: 'user', text: '画一只橘猫', status: 'done' })
    // assistant 失败态
    expect(messages[1]).toMatchObject({ role: 'assistant', status: 'error', errorKind: 'unknown' })
    // 参考图被 generationContext 引用（不孤儿），retry 可重放消费
    expect(messages[0].generationContext?.referenceAssetUrls).toEqual(['mivo-asset://busy-ref'])
    expect(messages[1].generationContext?.referenceAssetUrls).toEqual(['mivo-asset://busy-ref'])
    // 不设 retryDisabledReason —— isBusy 瞬时，另一生成结束后 Retry 可用
    expect(messages[1].retryDisabledReason).toBeUndefined()
    // warn 已记
    expect(warnSpy.mock.calls.some((c) => /another generation is in flight/i.test(String(c[1])))).toBe(true)
    // isBusy 未被本路径翻回 false（仍为 true，由抢先的生成负责收尾）
    expect(useChatStore.getState().isBusy).toBe(true)
  })

  it('retryMessage 第二道 isBusy → warn 后 return，消息形态不变且不进 enhance', async () => {
    // seed: assistant error + user，generationContext 有 referenceAssetUrls。
    // readImportedAssetFile 在 resolve 前 flip isBusy=true 命中 :494。
    vi.mocked(readImportedAssetFile).mockImplementationOnce(async () => {
      useChatStore.setState({ isBusy: true })
      return { name: 'ref.png', type: 'image/png', blob: new Blob(['x']), createdAt: 0 }
    })
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    useChatStore.setState({
      messagesByScene: {
        'scene-retry-busy': [
          { id: 'u1', role: 'user', kind: 'text', text: '画猫', createdAt: 0, status: 'done' },
          {
            id: 'a1', role: 'assistant', kind: 'text', text: '', createdAt: 0, status: 'error',
            error: '上游超时', errorKind: 'upstream-timeout',
            generationContext: {
              model: 'gpt-image-2',
              requestedImgRatio: 'auto', requestedQuality: 'auto',
              referenceAssetUrls: ['mivo-asset://retry-ref'],
            },
          },
        ],
      },
    } as never)

    await useChatStore.getState().retryMessage({ sceneId: 'scene-retry-busy', messageId: 'a1' })

    const after = useChatStore.getState().messagesByScene['scene-retry-busy']
    // 消息形态不变（仍 error），未进入 enhance/generate
    expect(after.find((m) => m.id === 'a1')?.status).toBe('error')
    expect(vi.mocked(enhanceMivoPrompt)).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.some((c) => /retryMessage dropped/i.test(String(c[1])))).toBe(true)
  })

  it('busy-drop 后 retry 该消息：generate 用用户原始 text 当 prompt，不是 busyRetryAdvice', async () => {
    // P1（Greptile）：droppedContext 必须落 finalPrompt=text，否则 retry 推导命中
    // targetMsg.text=busyRetryAdvice 当 prompt。本用例锁行为：retry 调 generateIntoAiSlot
    // 时第 2 参（finalPrompt）=== 用户原始 text。
    genFacadeSpies.prepareChatSlot.mockReset()
    genFacadeSpies.generateIntoAiSlot.mockReset()
    genFacadeSpies.generateBesideNode.mockReset()
    genFacadeSpies.getSceneChangeInfo.mockReset()

    // 1) send busy 路径：落失败消息，generationContext.finalPrompt 固化为原始 text
    vi.mocked(saveImportedAsset).mockImplementationOnce(async () => {
      useChatStore.setState({ isBusy: true })
      return {
        assetUrl: 'mivo-asset://busy-ref',
        name: 'ref.png',
        type: 'image/png',
        sizeBytes: 1,
        title: 'ref',
        size: '100x100',
        dimensions: undefined,
        sourceDimensions: { width: 100, height: 100 },
        hasTransparency: false,
      }
    })
    const file = new File(['x'], 'ref.png', { type: 'image/png' })
    await useChatStore.getState().sendMessage({
      sceneId: 'scene-busy-retry',
      text: '画一只橘猫',
      referenceFiles: [file],
    })
    const assistant = useChatStore.getState().messagesByScene['scene-busy-retry'][1]
    // 前置：finalPrompt 已固化为用户原始输入
    expect(assistant.generationContext?.finalPrompt).toBe('画一只橘猫')

    // 2) 另一生成结束，isBus 复位（retry 第二道 isBusy 不再命中）
    useChatStore.setState({ isBusy: false })

    // 3) retry：readImportedAssetFile 返合法 asset 使 referenceFilesFromAssets 不抛
    vi.mocked(readImportedAssetFile).mockResolvedValueOnce({
      name: 'ref.png', type: 'image/png', blob: new Blob(['x']), createdAt: 0,
    })
    genFacadeSpies.prepareChatSlot.mockReturnValue({ slotId: 'slot-1', mode: 'into-slot' })
    genFacadeSpies.getSceneChangeInfo.mockReturnValue({ sceneChanged: false, currentSceneId: 'scene-busy-retry' })
    genFacadeSpies.generateIntoAiSlot.mockResolvedValueOnce(['node-1'])

    await useChatStore.getState().retryMessage({ sceneId: 'scene-busy-retry', messageId: assistant.id })

    // 行为断言：generate 拿到的 finalPrompt 是用户原始 text，不是 busyRetryAdvice
    expect(genFacadeSpies.generateIntoAiSlot).toHaveBeenCalledWith(
      'slot-1',
      '画一只橘猫',
      expect.objectContaining({ sceneId: 'scene-busy-retry' }),
    )
    const callPrompt = genFacadeSpies.generateIntoAiSlot.mock.calls[0]?.[1]
    expect(callPrompt).toBe('画一只橘猫')
    // 负例锚点：绝不命中 busyRetryAdvice 文案
    expect(callPrompt).not.toBe('已有生成进行中，请稍后重试')
    // retry 成功 → assistant 转 done
    const after = useChatStore.getState().messagesByScene['scene-busy-retry']
    expect(after.find((m) => m.id === assistant.id)?.status).toBe('done')
  })
})

// FIX-4: retry 的 chat 语义与 send 一致 —— 失败后 retry 成功也要补澄清附言。
// 之前 retryNoticeText 是局部变量，仅在 retry 重跑 enhance（!baseContext.finalPrompt）
// 时赋值；send 已设 finalPrompt → retry 跳过 enhance → retryNoticeText 永远 undefined
// → retry 成功不补附言。修法：noticeText 持久化到 generationContext，retry 从 context 读回。
describe('retryMessage (FIX-4: retry 补 chat 澄清附言)', () => {
  beforeEach(() => {
    genFacadeSpies.prepareChatSlot.mockReset()
    genFacadeSpies.generateIntoAiSlot.mockReset()
    genFacadeSpies.generateBesideNode.mockReset()
    genFacadeSpies.getSceneChangeInfo.mockReset()
    vi.mocked(enhanceMivoPrompt).mockReset()
  })

  it('retry 不重跑 enhance 时从 context.noticeText 补澄清附言', async () => {
    // retry 成功的 generation
    genFacadeSpies.prepareChatSlot.mockReturnValue({ slotId: 'slot-1', mode: 'into-slot' })
    genFacadeSpies.getSceneChangeInfo.mockReturnValue({ sceneChanged: false, currentSceneId: 'scene-1' })
    genFacadeSpies.generateIntoAiSlot.mockResolvedValueOnce(['node-1'])

    // Seed: 一条 chat 模式 send 失败后的 assistant error 消息，generationContext
    // 已持久化 noticeText（send 路径在 generation 前写 context.noticeText）。
    // 用 merge（不带 true）避免冲掉 store 上的 retryMessage 等方法。
    useChatStore.setState({
      messagesByScene: {
        'scene-1': [
          { id: 'u1', role: 'user', kind: 'text', text: '能画角色么', createdAt: 0, status: 'done' },
          {
            id: 'a1', role: 'assistant', kind: 'text', text: '', createdAt: 0, status: 'error',
            error: '上游超时', errorKind: 'timeout',
            generationContext: {
              model: 'gpt-image-2',
              requestedImgRatio: 'auto', requestedQuality: 'auto',
              imgRatio: '1:1', quality: 'medium',
              finalPrompt: '能画角色么', // 存在 → retry 跳过 enhance 块
              noticeText: '可以画角色、场景、UI 哦', // FIX-4: 持久化的 chat 附言
            },
          },
        ],
      },
    } as never)

    const beforeNotices = useChatStore.getState().messagesByScene['scene-1'].filter((m) => m.kind === 'notice').length

    await useChatStore.getState().retryMessage({ sceneId: 'scene-1', messageId: 'a1' })

    const after = useChatStore.getState().messagesByScene['scene-1']
    // retry 成功 → assistant 转 done
    expect(after.find((m) => m.id === 'a1')?.status).toBe('done')
    // FIX-4: notice 从 context.noticeText 补回（retry 未重跑 enhance）
    const notices = after.filter((m) => m.kind === 'notice')
    expect(notices.length).toBe(beforeNotices + 1)
    expect(notices.at(-1)?.text).toContain('可以画角色')
    // 证明 retry 跳过了 enhance（finalPrompt 已存在），noticeText 来自 context 而非重跑
    expect(vi.mocked(enhanceMivoPrompt)).not.toHaveBeenCalled()
  })
})

// FIX-A: zustand v5 persisted version == options version (v2==v2) 时 migrate 不走，
// 只走 merge。86ce7d4 之前写入的脏 degradedReason string 会经 merge 进 runtime/UI。
// 真实 hydration 测试（非只测 migrateChatPersistedState 函数）：localStorage 写入
// version:2 + unknown degradedReason → persist.rehydrate() → 断言 undefined。
describe('chatStore hydration (FIX-A: merge 路径 sanitize 脏 degradedReason)', () => {
  it('persisted v2 == options v2 → 走 merge（非 migrate）仍 normalize 脏 degradedReason', async () => {
    const ls = (globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage
    // 模拟 86ce7d4 之前写入的脏 v2 状态：unknown degradedReason string
    const dirtyPersisted = {
      state: {
        messagesByScene: {
          'scene-fixa': [{
            id: 'm-fixa', role: 'assistant', kind: 'text', text: 't', createdAt: 0, status: 'done',
            enhance: { degradedReason: 'legacy-unknown-string' },
          }],
        },
        selectedModel: 'gpt-image-2',
        paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      },
      version: 2, // == options.version → zustand v5 不调 migrate，只调 merge
    }
    ls.setItem('mivo-chat-demo', JSON.stringify(dirtyPersisted))

    // 强制 rehydrate → 走 merge（settleExpiredChatMessages + FIX-A sanitize map）
    await useChatStore.persist.rehydrate()

    const msg = useChatStore.getState().messagesByScene['scene-fixa']?.[0]
    expect(msg).toBeDefined()
    expect(msg?.id).toBe('m-fixa')
    // FIX-A: merge 路径也 normalize —— 脏 string 不经 migrate 也被清为 undefined
    expect(msg?.enhance?.degradedReason).toBeUndefined()
  })

  it('persisted v2 valid union member 保留（merge 不误杀合法值）', async () => {
    const ls = (globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage
    const cleanPersisted = {
      state: {
        messagesByScene: {
          'scene-fixb': [{
            id: 'm-fixb', role: 'assistant', kind: 'text', text: 't', createdAt: 0, status: 'done',
            enhance: { degradedReason: 'upstream-http' },
          }],
        },
        selectedModel: 'gpt-image-2',
        paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      },
      version: 2,
    }
    ls.setItem('mivo-chat-demo', JSON.stringify(cleanPersisted))
    await useChatStore.persist.rehydrate()
    const msg = useChatStore.getState().messagesByScene['scene-fixb']?.[0]
    expect(msg?.enhance?.degradedReason).toBe('upstream-http')
  })
})

// SC-19 (审 F1): cancelGeneration 分支顺序。普通 chat generating 与 mask generating
// 并行时,点 mask 卡取消只触发 mask 的 abort/DELETE/回滚,普通 chat 的
// activeChatAbortController 不被 abort;反向取消 chat 卡不影响 mask 任务。
// 分支顺序硬约束:先按 sceneId/messageId 精确解析 target → target.origin === 'mask-edit'
// 在触碰任何 activeChatAbortController 逻辑之前委托 cancelMaskEditMessage 并 return。
describe('cancelGeneration (SC-19: chat×mask 并行取消隔离)', () => {
  beforeEach(() => {
    maskEditFlowSpies.cancelMaskEditMessage.mockReset()
  })

  it('origin=mask-edit 的 in-flight message → 委托 cancelMaskEditMessage,不走全局 abort,message 不被 cancelGeneration 自己改 error', () => {
    // seed 一条 origin:'mask-edit' status:'generating' 的 assistant message
    useChatStore.setState({
      messagesByScene: {
        'scene-mask': [
          { id: 'u1', role: 'user', kind: 'text', text: '改背景', createdAt: 0, status: 'done', origin: 'mask-edit' },
          {
            id: 'a1', role: 'assistant', kind: 'text', text: '', createdAt: 0, status: 'generating',
            origin: 'mask-edit',
            generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto', pendingSlotId: 'slot-m' },
          },
        ],
      },
    } as never)

    useChatStore.getState().cancelGeneration({ sceneId: 'scene-mask', messageId: 'a1' })

    // 委托 cancelMaskEditMessage(sceneId, messageId)
    expect(maskEditFlowSpies.cancelMaskEditMessage).toHaveBeenCalledWith('scene-mask', 'a1')
    expect(maskEditFlowSpies.cancelMaskEditMessage).toHaveBeenCalledTimes(1)
    // message 未被 cancelGeneration 自己改成 error(由 cancelMaskEditMessage 负责)
    const msg = useChatStore.getState().messagesByScene['scene-mask'][1]
    expect(msg.status).toBe('generating')
    expect(msg.errorKind).toBeUndefined()
  })

  it('origin 非 mask-edit 的 in-flight message + 无 activeChatAbortController → 走 fallback settle,cancelMaskEditMessage 未被调', () => {
    // seed 一条普通 chat(无 origin)status:'generating' 的 assistant message
    useChatStore.setState({
      messagesByScene: {
        'scene-chat': [
          { id: 'u2', role: 'user', kind: 'text', text: '画猫', createdAt: 0, status: 'done' },
          {
            id: 'a2', role: 'assistant', kind: 'text', text: '', createdAt: 0, status: 'generating',
            generationContext: { model: 'gpt-image-2', requestedImgRatio: 'auto', requestedQuality: 'auto', pendingSlotId: 'slot-c' },
          },
        ],
      },
    } as never)

    useChatStore.getState().cancelGeneration({ sceneId: 'scene-chat', messageId: 'a2' })

    // 普通 chat 分支:cancelMaskEditMessage 未被调
    expect(maskEditFlowSpies.cancelMaskEditMessage).not.toHaveBeenCalled()
    // fallback settle 把 message 标 error/canceled
    const msg = useChatStore.getState().messagesByScene['scene-chat'][1]
    expect(msg.status).toBe('error')
    expect(msg.errorKind).toBe('canceled')
  })
})
