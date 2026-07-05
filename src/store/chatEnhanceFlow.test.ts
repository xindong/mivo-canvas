import { describe, expect, it } from 'vitest'
import { resolveChatEnhance, resolveMaskEditEnhance } from './chatEnhanceFlow'
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

describe('resolveMaskEditEnhance (mask-chat-card)', () => {
  it('generate 模式 + richPrompt → finalPrompt=richPrompt，无 noticeText', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'generate',
      scene: 'general',
      reasoning: 'r',
      richPrompt: 'a vivid cat illustration with mask region',
      imgRatio: '1:1',
      quality: 'medium',
    }
    const resolution = resolveMaskEditEnhance(enhanceResult, '把猫的眼睛改成蓝色')
    expect(resolution.finalPrompt).toBe('a vivid cat illustration with mask region')
    expect(resolution.noticeText).toBeUndefined()
  })

  it('chat 模式 + replyText → finalPrompt=原始 text，noticeText=replyText.trim()', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: true,
      mode: 'chat',
      replyText: '  好的，我来修改猫的眼睛颜色  ',
    }
    const resolution = resolveMaskEditEnhance(enhanceResult, '把猫的眼睛改成蓝色')
    expect(resolution.finalPrompt).toBe('把猫的眼睛改成蓝色')
    expect(resolution.noticeText).toBe('好的，我来修改猫的眼睛颜色')
  })

  it('降级（enhanced=false）→ finalPrompt=原始 text，无 noticeText', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: false,
      degradedReason: 'upstream-http',
      stage: 'fallback',
    }
    const resolution = resolveMaskEditEnhance(enhanceResult, '把猫的眼睛改成蓝色')
    expect(resolution.finalPrompt).toBe('把猫的眼睛改成蓝色')
    expect(resolution.noticeText).toBeUndefined()
  })

  it('降级时 degradeReason/stage 不被本函数触碰（透传由调用方处理）', () => {
    const enhanceResult: EnhanceResponse = {
      enhanced: false,
      degradedReason: 'upstream-network',
      stage: 'primary',
    }
    const snapshot = { ...enhanceResult }
    const resolution = resolveMaskEditEnhance(enhanceResult, '把猫的眼睛改成蓝色')
    // 函数不修改入参对象字段
    expect(enhanceResult).toEqual(snapshot)
    expect(enhanceResult.degradedReason).toBe('upstream-network')
    expect(enhanceResult.stage).toBe('primary')
    // 解析结果只有 finalPrompt，不携带降级信息（调用方自行从 enhanceResult 透传）
    expect(resolution.finalPrompt).toBe('把猫的眼睛改成蓝色')
    expect(resolution.noticeText).toBeUndefined()
    expect(resolution).not.toHaveProperty('degradedReason')
    expect(resolution).not.toHaveProperty('stage')
  })
})
