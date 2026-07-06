import { describe, expect, it } from 'vitest'
import { buildBusyDropMessages, busyRetryAdvice } from './chatBusyDrop'
import type { ChatMessage } from './chatStore'

// S01: buildBusyDropMessages 是纯构造函数（不碰 store）。直接单测锁契约：
// - finalPrompt 固化为用户原始 text（P1：retry 推导 prompt 优先命中它，而非 busyRetryAdvice）
// - referenceAssetUrls 被两条消息的 generationContext 引用（不孤儿）
// - assistant 是 error 态 + errorKind 'unknown'，不设 retryDisabledReason（Retry 可用）
describe('buildBusyDropMessages (S01 纯函数契约)', () => {
  const args = {
    text: '画一只橘猫',
    selectedNodeId: 'node-1',
    selectedNodeType: 'image' as const,
    referenceAssetUrls: ['mivo-asset://ref-1', 'mivo-asset://ref-2'],
    model: 'gpt-image-2',
    requestedImgRatio: '1:1' as const,
    requestedQuality: 'medium' as const,
  }

  it('user 消息保留原始 text + 引用 referenceAssetUrls + status done', () => {
    const { userMessage }: { userMessage: ChatMessage } = buildBusyDropMessages(args)
    expect(userMessage).toMatchObject({
      role: 'user',
      kind: 'text',
      text: '画一只橘猫',
      status: 'done',
      selectedNodeId: 'node-1',
      selectedNodeType: 'image',
    })
    expect(userMessage.generationContext?.referenceAssetUrls).toEqual([
      'mivo-asset://ref-1',
      'mivo-asset://ref-2',
    ])
    // P1：finalPrompt 固化为用户原始 text
    expect(userMessage.generationContext?.finalPrompt).toBe('画一只橘猫')
  })

  it('assistant 消息 error 态 + busyRetryAdvice 文案 + 引用同一 referenceAssetUrls', () => {
    const { assistantMessage }: { assistantMessage: ChatMessage } = buildBusyDropMessages(args)
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      kind: 'text',
      text: busyRetryAdvice,
      status: 'error',
      error: busyRetryAdvice,
      errorKind: 'unknown',
    })
    // 不设 retryDisabledReason（isBusy 瞬时，Retry 可用）
    expect(assistantMessage.retryDisabledReason).toBeUndefined()
    expect(assistantMessage.generationContext?.referenceAssetUrls).toEqual([
      'mivo-asset://ref-1',
      'mivo-asset://ref-2',
    ])
    // P1：assistant.generationContext.finalPrompt 也是用户原始 text，
    // 保证 retry 推导 context.finalPrompt 命中、不会误用 assistant.text=busyRetryAdvice
    expect(assistantMessage.generationContext?.finalPrompt).toBe('画一只橘猫')
  })

  it('两条消息 generationContext 同源（同一 droppedContext 引用）', () => {
    const { userMessage, assistantMessage } = buildBusyDropMessages(args)
    expect(userMessage.generationContext).toBe(assistantMessage.generationContext)
    // 两条消息 id 不同
    expect(userMessage.id).not.toBe(assistantMessage.id)
  })

  // P1 负例自验：若 finalPrompt 没固化，retry 会误用 busyRetryAdvice 当 prompt。
  // 这里直接断言 finalPrompt !== busyRetryAdvice，锁住固化行为。
  it('finalPrompt 绝不是 busyRetryAdvice 文案（P1 负例锚点）', () => {
    const { userMessage, assistantMessage } = buildBusyDropMessages(args)
    expect(userMessage.generationContext?.finalPrompt).not.toBe(busyRetryAdvice)
    expect(assistantMessage.generationContext?.finalPrompt).not.toBe(busyRetryAdvice)
  })
})
