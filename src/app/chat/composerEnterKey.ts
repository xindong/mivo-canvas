/**
 * 判定 ChatComposer 的 Enter 是否应触发发送提示词。
 *
 * IME 合成态(中文/日文等输入法选候选词期间)下的 Enter 用于确认候选词,
 * 不应发送;候选确认完毕后再次按 Enter(非合成态)才发送。
 * - isComposing:合成态标准标志(现代浏览器可靠置位)。
 * - keyCode 229 兜底:部分浏览器/输入法合成态未置位 isComposing 但 keyCode=229。
 *
 * Shift+Enter 始终换行,不发送。与 sidebar/EditableName 的 IME 守卫同款,
 * 此处额外加 keyCode 229 兜底以覆盖更老的输入法。
 */
export function shouldSendOnEnter(e: {
  key: string
  shiftKey: boolean
  nativeEvent: { isComposing?: boolean; keyCode?: number }
}): boolean {
  if (e.key !== 'Enter') return false
  if (e.shiftKey) return false
  if (e.nativeEvent.isComposing) return false
  if (e.nativeEvent.keyCode === 229) return false
  return true
}
