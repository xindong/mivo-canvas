// src/store/maskEditTaskRuntime.ts
// mask-chat-card: 非 persisted runtime registry，按 messageId 管理局部重绘后台任务的
// 真实取消与回滚资源。不入 zustand persist —— baselineSnapshot / Blob / AbortController
// 都不能持久化；刷新后按 hydration 失败态处理（chatGenerationHydration settle 为 error，
// canvasGenerationHydration 把 running slot settle 为 failed）。
//
// 职责边界：本模块只管 runtime 记录的 CRUD + abort controller。不直接改 UI/chat 状态；
// 后台 flow catch 负责最终 message 状态收口（finishMaskEditMessage / failMaskEditMessage）。
// 参考 chatEnhanceFlow.ts / chatGenerationHydration.ts 的小模块模式。
import type { MivoCanvasNode, MivoCanvasSnapshot } from '../types/mivoCanvas'
import type { MivoImageQuality, MivoImageRatio } from '../types/generation'
import type { ImageMaskSubmitPayload } from '../canvas/imageMaskGeometry'

export type ActiveMaskEditTask = {
  sceneId: string
  messageId: string
  slotId: string
  baselineSnapshot?: MivoCanvasSnapshot
  abortController: AbortController
  source: MivoCanvasNode
  resolvedAssetUrl?: string
  payload: ImageMaskSubmitPayload
  /** 源图派生的 imgRatio（runMaskEditGeneration 用，不读 message context 避免 cast）。 */
  imgRatio: MivoImageRatio
  /** overlay 四档 quality（auto=undefined；不读 message context）。 */
  quality?: MivoImageQuality
}

const activeMaskEditTasks = new Map<string, ActiveMaskEditTask>()

export const registerMaskEditTask = (record: ActiveMaskEditTask): void => {
  activeMaskEditTasks.set(record.messageId, record)
}

export const getMaskEditTask = (messageId: string): ActiveMaskEditTask | undefined =>
  activeMaskEditTasks.get(messageId)

export const clearMaskEditTask = (messageId: string): void => {
  activeMaskEditTasks.delete(messageId)
}

/** Abort only the controller for this messageId; do NOT touch UI/canvas state.
 *  The background flow's catch is responsible for cancelTask + removeMaskEditPlaceholder
 *  + message terminal state. Returns true if a record was found and aborted. */
export const abortMaskEditTask = (messageId: string): boolean => {
  const record = activeMaskEditTasks.get(messageId)
  if (!record) return false
  if (!record.abortController.signal.aborted) {
    record.abortController.abort()
  }
  return true
}

/** Test-only helper to reset the singleton registry between unit tests. */
export const __resetMaskEditTaskRegistryForTests = (): void => {
  activeMaskEditTasks.clear()
}
