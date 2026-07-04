import { describe, expect, it, vi, beforeEach } from 'vitest'

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

import { useChatStore } from './chatStore'
import { saveImportedAsset } from '../lib/assetStorage'

beforeEach(() => {
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
