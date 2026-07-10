import { useEffect, useState } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
import { useAuthStore } from '../store/authSlice'
import { useSettingsStore } from '../store/settingsSlice'
import { reconcileExpiredChatTasks } from '../store/chatTaskReconcile'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import { isLegacyKernel } from './kernelMode'
import { migrateV10ToV11 } from '../kernel/persistMigration'
import { rawIdbStorage } from '../lib/persistIdbStorage'

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
        // S6b-2:?kernel=new 时 auth 后 rehydrate 前调 migrate 仪式(幂等,Lead ①)。
        // ?kernel=legacy(默认)不调,legacy 零变化(§8)。migrate 把 v10 单 blob 迁 v11
        // document+session 三域(DocKernel canonical);幂等:document key 已存在则跳过(防重复迁移)。
        // 失败:rollback 已在 migrateV10ToV11 内跑(§4.3);useStoreHydration 不阻塞 rehydrate(降级默认)。
        if (!isLegacyKernel) {
          try {
            const result = await migrateV10ToV11(rawIdbStorage, 'mivo-canvas-demo')
            if (result.skipped) {
              debugLogger.log(SOURCE, `kernel migrate skipped (already migrated / no v10 blob)`)
            } else if (!result.ok) {
              debugLogger.warn(SOURCE, `kernel migrate failed: ${result.error ?? 'unknown'} (rollback ran)`)
            } else {
              debugLogger.log(SOURCE, `kernel migrate ok (v10 → v11 document+session)`)
            }
          } catch (error) {
            debugLogger.error(SOURCE, `kernel migrate threw: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        await Promise.all([
          useCanvasStore.persist.rehydrate(),
          useChatStore.persist.rehydrate(),
          // P1-2 (FX-3): 显式 await settings rehydrate,保证 reconcile 跑前 mivoKey/
          // gatewayKey 已从 IDB 恢复。settings 虽不用 skipHydration(模块加载即自动
          // rehydrate),但自动 rehydrate 与本 effect 的 auth /me + canvas/chat IDB
          // 并发竞态——auth 网络往返快或 settings IDB 冷启时,reconcile 的 settle
          // fetch(authHeaders 读 mivoKey 做 FX-2 owner fingerprint)可能在 key 未恢复
          // 时发出 → 401。此处显式 await 消除该竞态(401-because-ordering 靠时序修,
          // 非靠 reconcile 内重试硬扛);reconcile 内重试只兜其余瞬态(5xx/网络)。
          useSettingsStore.persist.rehydrate(),
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
