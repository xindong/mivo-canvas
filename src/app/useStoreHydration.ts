import { useEffect, useState } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
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
 * On failure (IDB unavailable / corrupt persisted state), it logs + toasts and still
 * flips `hydrated=true` so the app degrades to default state instead of hanging on a
 * blank screen.
 */
export function useStoreHydration(): boolean {
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      try {
        await Promise.all([
          useCanvasStore.persist.rehydrate(),
          useChatStore.persist.rehydrate(),
        ])
        if (!cancelled) setHydrated(true)
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
