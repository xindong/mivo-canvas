import { describe, expect, it } from 'vitest'
import { resolveChatEnhance } from './chatEnhanceFlow'
import type { EnhanceResponse } from '../types/generation'

describe('resolveChatEnhance (W4)', () => {
  it('chat 模式：finalPrompt = 原始 text，noticeText = replyText', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'chat',
      replyText: '可以，我来画一只猫',
    }
    const resolution = resolveChatEnhance(enhanceResult, '画一只猫')
    expect(resolution.finalPrompt).toBe('画一只猫')
    expect(resolution.noticeText).toBe('可以，我来画一只猫')
  })

  it('chat 模式 replyText 带空白 → trim 后作 noticeText', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'chat',
      replyText: '  可以讨论游戏美术  ',
    }
    const resolution = resolveChatEnhance(enhanceResult, '这里能对话么')
    expect(resolution.finalPrompt).toBe('这里能对话么')
    expect(resolution.noticeText).toBe('可以讨论游戏美术')
  })

  it('generate 模式：finalPrompt = richPrompt，无 noticeText', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'generate',
      scene: 'general',
      reasoning: 'r',
      richPrompt: 'a vivid cat illustration',
      imgRatio: '1:1',
      quality: 'medium',
    }
    const resolution = resolveChatEnhance(enhanceResult, '画一只猫')
    expect(resolution.finalPrompt).toBe('a vivid cat illustration')
    expect(resolution.noticeText).toBeUndefined()
  })

  it('generate 模式无 richPrompt → finalPrompt 回退到原始 text', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'generate',
      richPrompt: undefined,
    }
    const resolution = resolveChatEnhance(enhanceResult, '画一只猫')
    expect(resolution.finalPrompt).toBe('画一只猫')
    expect(resolution.noticeText).toBeUndefined()
  })

  it('chat 模式 replyText 空 → 走 generate 分支（finalPrompt=richPrompt||text）', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'chat',
      replyText: '   ',
    }
    const resolution = resolveChatEnhance(enhanceResult, '画一只猫')
    expect(resolution.finalPrompt).toBe('画一只猫')
    expect(resolution.noticeText).toBeUndefined()
  })

  it('降级（enhanced=false）→ finalPrompt=原始 text，无 noticeText', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: false,
      degradedReason: 'upstream-http',
      stage: 'fallback',
    }
    const resolution = resolveChatEnhance(enhanceResult, '画一只猫')
    expect(resolution.finalPrompt).toBe('画一只猫')
    expect(resolution.noticeText).toBeUndefined()
  })
})
