import { describe, expect, it } from 'vitest'
import { isImeComposing } from './imeSafeEnter'
import type { KeyboardEvent } from 'react'

// isImeComposing 只读 nativeEvent.isComposing / nativeEvent.keyCode，构造最小结构体
// 强转为 React KeyboardEvent<HTMLElement> 即可。
const fakeEvent = (overrides: {
  isComposing?: boolean
  keyCode?: number
} = {}): KeyboardEvent<HTMLElement> =>
  ({
    nativeEvent: {
      isComposing: overrides.isComposing ?? false,
      keyCode: overrides.keyCode ?? 13,
    },
  }) as unknown as KeyboardEvent<HTMLElement>

describe('isImeComposing (IME 合成态守卫)', () => {
  it('非合成态 Enter(isComposing=false, keyCode=13)不命中守卫 → 进入保存逻辑(保存)', () => {
    expect(isImeComposing(fakeEvent({ isComposing: false, keyCode: 13 }))).toBe(false)
  })

  it('IME 合成态(isComposing=true)命中守卫 → 早退不保存(Enter 用于确认候选)', () => {
    expect(isImeComposing(fakeEvent({ isComposing: true }))).toBe(true)
  })

  it('keyCode 229(isComposing 未置位的兜底)命中守卫 → 早退不保存', () => {
    expect(isImeComposing(fakeEvent({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it('isComposing 与 keyCode 229 同时命中守卫 → 早退不保存', () => {
    expect(isImeComposing(fakeEvent({ isComposing: true, keyCode: 229 }))).toBe(true)
  })
})
