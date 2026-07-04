// chatStoreMigrate — persist v1→v2 迁移逻辑（co-located with sanitize/clamp helpers）。
// 从 chatStore.ts 抽出以保持该文件在 structure-guard 900 行阈值内（同 #76 把
// migratePersistedState 搬到 canvasGenerationHydration.ts 的先例）。chatStore 运行时
// import clampChatGenerationContext / migrateChatPersistedState；本模块仅 type-only
// 反向引用 chatStore 的类型，无运行时循环。
import type { ChatGenerationContext, ChatParamOverrides, ChatMessage } from './chatStore'
import { getModelCapabilities } from '../lib/modelCapabilities'
import { debugLogger } from './debugLogStore'

// 审查 B：persist v1→v2 迁移与 retryMessage 入口共用——把不再被当前模型支持的 ratio 收敛掉，
// 防止老会话的 21:9 在 gemini 能力表去 21:9 后从 generationContext 复活。
// enhance.imgRatio 保留作历史展示，不在此处收敛。
// Exported so chatStoreMigrate.test.ts can cover the ratio-convergence branches directly.
export const clampChatGenerationContext = (context: ChatGenerationContext): ChatGenerationContext => {
  const validRatios = getModelCapabilities(context.model).ratios as readonly string[]
  const requestedImgRatio =
    context.requestedImgRatio === 'auto' || validRatios.includes(context.requestedImgRatio)
      ? context.requestedImgRatio
      : 'auto'
  const imgRatio =
    context.imgRatio && validRatios.includes(context.imgRatio) ? context.imgRatio : undefined
  return { ...context, requestedImgRatio, imgRatio }
}

// Persisted-state migration extracted to a named export so chatStoreMigrate.test.ts can
// cover the v1→v2 ratio-convergence branches. Behavior is identical to the prior inline form.
export type ChatPersistedState = {
  selectedModel?: string
  paramOverrides?: ChatParamOverrides
  messagesByScene?: Record<string, ChatMessage[]>
}

// S04: 共用 sanitize helper——对 messagesByScene 的每个条目做 Array 校验，非数组条目
// warn + drop，避免 .map 抛错让整个 migrate 崩掉（裸断言 → 单条损坏全盘丢数据）。
// v>=2 与 v1 分支共用。
const sanitizeMessagesByScene = (raw: unknown): Record<string, ChatMessage[]> => {
  const result: Record<string, ChatMessage[]> = {}
  for (const [sceneId, messages] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(messages)) result[sceneId] = messages as ChatMessage[]
    else debugLogger.warn('Chat Store', `migrate 丢弃损坏会话 ${sceneId}（非数组）`)
  }
  return result
}

export const migrateChatPersistedState = (
  persistedState: unknown,
  version = 0,
): { selectedModel: string; paramOverrides: ChatParamOverrides; messagesByScene: Record<string, ChatMessage[]> } => {
  const state = (persistedState ?? {}) as ChatPersistedState
  if (version >= 2) {
    // S04: v>=2 也走 sanitize + 形状回落（旧实现裸 `state as {...}` 对非数组
    // messagesByScene 条目与缺失 selectedModel/paramOverrides 无防护）。
    return {
      selectedModel: state.selectedModel || 'gemini-3-pro-image',
      paramOverrides: state.paramOverrides ?? { imgRatio: 'auto' as const, quality: 'auto' as const },
      messagesByScene: sanitizeMessagesByScene(state.messagesByScene),
    }
  }
  // v1 → v2: gemini 能力表去 21:9，把老会话里不再支持的 ratio 收敛掉
  // 老用户已选模型保留（selectedModel 原样回填），仅对 ratios 做收敛
  const selectedModel = state.selectedModel || 'gemini-3-pro-image'
  const validRatios = getModelCapabilities(selectedModel).ratios as readonly string[]
  const prevOverrides = state.paramOverrides ?? {
    imgRatio: 'auto' as const,
    quality: 'auto' as const,
  }
  const paramOverrides: ChatParamOverrides = {
    imgRatio:
      prevOverrides.imgRatio !== 'auto' && !validRatios.includes(prevOverrides.imgRatio)
        ? 'auto'
        : prevOverrides.imgRatio,
    quality: prevOverrides.quality,
  }
  // S04: .map 前先过 sanitizeMessagesByScene——非数组条目 warn + drop，合法数组再
  // 走 clampChatGenerationContext 收敛。
  const sanitized = sanitizeMessagesByScene(state.messagesByScene)
  const messagesByScene: Record<string, ChatMessage[]> = {}
  for (const [sceneId, messages] of Object.entries(sanitized)) {
    messagesByScene[sceneId] = messages.map((msg) =>
      msg.generationContext
        ? { ...msg, generationContext: clampChatGenerationContext(msg.generationContext) }
        : msg,
    )
  }
  return { selectedModel, paramOverrides, messagesByScene }
}
