// chat 气泡「复制提示词」:优先 navigator.clipboard,失败回退 document.execCommand;
// 成功/失败路径都必须落 toast + debugLogger(docs/development-logging.md 硬规约)。
// 独立伴生模块(不进 chatStore,结构红线:chatStore 零增长)。
import { debugLogger } from '../../store/debugLogStore'
import { toastFeedback } from '../../store/toastStore'

const legacyExecCommandCopy = (text: string): boolean => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

export const copyPromptText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else if (!legacyExecCommandCopy(text)) {
      throw new Error('execCommand copy rejected')
    }
    toastFeedback.success('已复制')
    debugLogger.log('Chat', `Prompt copied to clipboard (${text.length} chars)`)
    return true
  } catch (error) {
    // clipboard API 被拒(权限/非安全上下文)时再走一次 execCommand 兜底
    try {
      if (legacyExecCommandCopy(text)) {
        toastFeedback.success('已复制')
        debugLogger.log('Chat', `Prompt copied via execCommand fallback (${text.length} chars)`)
        return true
      }
    } catch {
      // fallthrough → 统一走失败路径
    }
    const message = error instanceof Error ? error.message : String(error)
    toastFeedback.error('复制失败')
    debugLogger.warn('Chat', `Prompt copy failed: ${message}`)
    return false
  }
}
