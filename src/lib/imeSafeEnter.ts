// src/lib/imeSafeEnter.ts
import type { KeyboardEvent } from 'react'

/**
 * IME 合成态守卫：输入法候选未确认时，nativeEvent.isComposing 为 true，
 * 部分浏览器/输入法此时 keyCode=229。任何在 Enter 上提交/触发动作的输入框，
 * 都必须在 preventDefault/提交前先过此守卫，命中则早退，让 Enter 用于确认候选。
 */
export const isImeComposing = (e: KeyboardEvent<HTMLElement>): boolean =>
  e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
