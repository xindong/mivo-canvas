import { useEffect, useState } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
import { useAuthStore } from '../store/authSlice'
import { reconcileExpiredChatTasks } from '../store/chatTaskReconcile'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'

const SOURCE = 'Store Hydration'

/**
 * FU4-2: drive both persisted stores' rehydration from the App layer.
 *
 * Both stores use `skipHydration: true` + an IndexedDB-backed storage (async), so
 * the default first paint would be the demo-seed default state until IDB resolves —
 * a visible flash. This hook awaits `rehydrate()` for both stores before reporting
 * `hydrated=true`, so App can render a lightweight placeholder until the real state
 * is ready.
 *
 * FX-6: auth is hydrated FIRST. The persist adapters namespace their physical IDB
 * keys by the current auth userId (`mivo-canvas-demo:<userId>` / `mivo-chat-demo:
 * <userId>`), so the stores must not rehydrate until /api/auth/me has resolved and
 * set the namespace — otherwise they'd hydrate from the anonymous namespace and
 * then sit on stale data after the real user resolves. main.tsx also fires hydrate
 * for the user chip; authSlice's single-flight dedupes the two callers to one
 * /me fetch. On failure (IDB unavailable / corrupt persisted state), it logs +
 * toasts and still flips `hydrated=true` so the app degrades to default state
 * instead of hanging on a blank screen.
 */
export function useStoreHydration(): boolean {
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      try {
        // FX-6: resolve the auth userId namespace BEFORE rehydrating persisted
        // stores, so canvas/chat hydrate from mivo-*:<userId> (not anonymous).
        await useAuthStore.getState().hydrate()
        await Promise.all([
          useCanvasStore.persist.rehydrate(),
          useChatStore.persist.rehydrate(),
        ])
        // FX-3: server-truth reconciliation of wrongly-expired mask-edit chat cards.
        // The blanket settleExpiredChatMessages already ran in the chat merge (so no
        // first-paint flash); this async pass asks the per-user task registry (FX-2)
        // for the truth and recovers cards whose tasks actually succeeded on the
        // server. Fire-and-forget: never blocks first paint; patches the store when
        // done (Zustand setState re-renders). The chatHydration characterization
        // (#167) calls useChatStore.persist.rehydrate() directly, NOT this hook, so
        // it never triggers this pass — its blanket-settle assertions are untouched.
        if (!cancelled) {
          setHydrated(true)
          void reconcileExpiredChatTasks().catch((error) => {
            debugLogger.error(
              SOURCE,
              `reconcileExpiredChatTasks failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLogger.error(SOURCE, `rehydrate failed: ${message}`)
        toastFeedback.error('加载历史画布失败，已使用默认状态。')
        // Degrade to default state — render the app anyway rather than hang.
        if (!cancelled) setHydrated(true)
      }
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [])

  return hydrated
}
