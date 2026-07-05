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

import { useChatStore } from './chatStore'
import { saveImportedAsset } from '../lib/assetStorage'
import { enhanceMivoPrompt } from '../lib/mivoImageClient'

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
