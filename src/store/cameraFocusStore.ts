// 生图占位符镜头跟随请求(独立小 store,仿 toastStore 模式,不并入 canvasStore)。
// 写侧:prepareChatSlot / prepareMaskEditPlaceholder 建占位后 request;
// 读侧:useViewport 的 auto-focus effect 消费后 clear。瞬态状态,不持久化。
// 跨场景契约(#95):任务落在非活跃场景时不切场景、不动镜头,只记 log。
import { create } from 'zustand'
import { debugLogger } from './debugLogStore'

export type CameraFocusRequest = {
  nodeId: string
  source: string
  mode?: 'reveal' | 'center'
}

type CameraFocusState = {
  pendingFocus?: CameraFocusRequest
  requestPlaceholderFocus: (
    nodeId: string,
    context: { targetSceneId: string; activeSceneId: string; source: string },
  ) => void
  requestNodeFocus: (
    nodeId: string,
    context: { targetSceneId: string; activeSceneId: string; source: string; mode: CameraFocusRequest['mode'] },
  ) => void
  clearPlaceholderFocus: () => void
}

export const useCameraFocusStore = create<CameraFocusState>()((set) => ({
  pendingFocus: undefined,
  requestPlaceholderFocus: (nodeId, { targetSceneId, activeSceneId, source }) => {
    if (targetSceneId !== activeSceneId) {
      debugLogger.log(
        'Camera',
        `Auto-focus skipped (cross-scene): ${source} placeholder ${nodeId} targets ${targetSceneId}, active ${activeSceneId}`,
      )
      return
    }
    // 每次请求都换新对象引用,同一 nodeId 重复触发(如 retry 复用 slot)也能驱动 effect。
    set({ pendingFocus: { nodeId, source } })
  },
  requestNodeFocus: (nodeId, { targetSceneId, activeSceneId, source, mode }) => {
    if (targetSceneId !== activeSceneId) {
      debugLogger.log(
        'Camera',
        `Auto-focus skipped (cross-scene): ${source} node ${nodeId} targets ${targetSceneId}, active ${activeSceneId}`,
      )
      return
    }
    set({ pendingFocus: { nodeId, source, mode } })
  },
  clearPlaceholderFocus: () => set({ pendingFocus: undefined }),
}))
