import { describe, expect, it } from 'vitest'
import { shouldSendOnEnter } from './composerEnterKey'

type EnterEvent = {
  key: string
  shiftKey: boolean
  nativeEvent: { isComposing?: boolean; keyCode?: number }
}

const enter = (overrides: {
  isComposing?: boolean
  keyCode?: number
  shiftKey?: boolean
} = {}): EnterEvent => ({
  key: 'Enter',
  shiftKey: overrides.shiftKey ?? false,
  nativeEvent: {
    isComposing: overrides.isComposing ?? false,
    keyCode: overrides.keyCode ?? 13,
  },
})

describe('shouldSendOnEnter (ChatComposer IME 守卫)', () => {
  it('非合成态 Enter 触发发送', () => {
    expect(shouldSendOnEnter(enter({ isComposing: false, keyCode: 13 }))).toBe(true)
  })

  it('IME 合成态(isComposing=true)Enter 不触发发送(用于确认候选词)', () => {
    expect(shouldSendOnEnter(enter({ isComposing: true }))).toBe(false)
  })

  it('keyCode 229(isComposing 未置位的兜底)Enter 不触发发送', () => {
    expect(shouldSendOnEnter(enter({ isComposing: false, keyCode: 229 }))).toBe(false)
  })

  it('Shift+Enter 不触发发送(换行)', () => {
    expect(shouldSendOnEnter(enter({ shiftKey: true }))).toBe(false)
  })

  it('非 Enter 键不触发发送', () => {
    expect(
      shouldSendOnEnter({
        key: 'Escape',
        shiftKey: false,
        nativeEvent: { isComposing: false, keyCode: 27 },
      }),
    ).toBe(false)
  })

  it('isComposing 与 keyCode 229 同时命中也不触发发送', () => {
    expect(shouldSendOnEnter(enter({ isComposing: true, keyCode: 229 }))).toBe(false)
  })
})
