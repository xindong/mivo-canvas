// chatPersistConfig — persist options for useChatStore, extracted (G1-a R8b) so the
// SC-15 R2 onRehydrateStorage gated-writeback + merge settle-count wiring doesn't
// grow the structure-guard white-listed chatStore.ts facade. migrate/merge/onRehydrate
// semantics are unchanged from the pre-R8b inline config; only the location moves.
// Mirrors canvasPersistConfig.ts: plain options export + local settle counter +
// dynamic import of useChatStore to break the chatStore ⇄ chatPersistConfig static
// cycle (chatStore statically imports this module for the options, so this module
// must not statically import chatStore for a value — only `type` and a deferred
// dynamic import, identical to the canvasStore ⇄ canvasPersistConfig arrangement).
import { createJSONStorage } from 'zustand/middleware'
import { idbStateStorage } from '../lib/persistIdbStorage'
import { debugLogger } from './debugLogStore'
import { migrateChatPersistedState, sanitizeEnhanceDegradedReason } from './chatStoreMigrate'
import { settleExpiredChatMessages } from './chatGenerationHydration'
import type { ChatState, ChatMessage } from './chatStore'

// SC-15 R2: hydrate() writes merge's settled state via the *vanilla* set
// (middleware.mjs:421), not the wrapped one, and only calls setItem on a version
// *migrate* (line 422-424). With v2==v2 (no migrate) setItem never fires → settled
// state lives only in memory while IDB keeps the generating blob. This counter gates
// ONE controlled writeback in onRehydrateStorage (0 when durable already settled →
// no rewrite on reload-2+).
let pendingChatHydrationSettleCount = 0

export const chatPersistOptions = {
  name: 'mivo-chat-demo',
  version: 2,
  // FU4-2: persist to IndexedDB alongside canvasStore. skipHydration defers to
  // the App-layer hydration gate (no first-paint flash). migrate/merge unchanged.
  storage: createJSONStorage(() => idbStateStorage),
  skipHydration: true,
  partialize: (state: ChatState) => ({
    messagesByScene: state.messagesByScene,
    // P2-3:持久化 unsynced sidecar(跨 boot 存活;boot 时 IDB rehydrate 先于 hydrate,sidecar 就绪)。
    unsyncedChatMsgIds: state.unsyncedChatMsgIds,
    selectedModel: state.selectedModel,
    paramOverrides: state.paramOverrides,
    // isBusy excluded (runtime state)
  }),
  migrate: migrateChatPersistedState,
  merge: (persistedState: unknown, currentState: ChatState) => {
    const persisted = (persistedState ?? {}) as Partial<ChatState>
    const merged = {
      ...currentState,
      ...persisted,
      isBusy: false,
    }
    const result = settleExpiredChatMessages(merged.messagesByScene || {})
    if (result.settledMessages > 0) {
      debugLogger.warn('Chat Store', `Hydration settled ${result.settledMessages} expired chat generation message(s)`)
    }
    // SC-15 R2: record settle count for onRehydrateStorage's gated writeback.
    pendingChatHydrationSettleCount = result.settledMessages
    // FIX-A: zustand v5 persisted version == options version (v2==v2) 时 migrate
    // 不走，只走 merge。86ce7d4 之前写入的脏 degradedReason string 仍会经 merge 进
    // runtime/UI。在 merge 必经路径对每条 message 跑 sanitizeEnhanceDegradedReason
    // （与 settle 同一处 map），保证 hydration 后 degradedReason 必为 union 成员或 undefined。
    const sanitizedMessages: Record<string, ChatMessage[]> = {}
    for (const [sceneId, messages] of Object.entries(result.messagesByScene)) {
      sanitizedMessages[sceneId] = messages.map(sanitizeEnhanceDegradedReason)
    }
    return {
      ...merged,
      messagesByScene: sanitizedMessages,
      // P2-3:旧 persisted 无 unsyncedChatMsgIds → 显式 default {}(防 undefined 漏入 runtime)。
      unsyncedChatMsgIds: merged.unsyncedChatMsgIds ?? {},
    }
  },
  // SC-15 R2: gated writeback — see pendingChatHydrationSettleCount above. The
  // wrapped api.setState (middleware.mjs:366-369) triggers setItem → writes the
  // settled messagesByScene durably. skipHydration=true → only fires on rehydrate.
  // Dynamic import of useChatStore breaks the chatStore ⇄ chatPersistConfig static
  // cycle (chatStore statically imports this module for the options); the store is
  // loaded by the time rehydrate runs, so the dynamic import resolves synchronously.
  onRehydrateStorage: () => async () => {
    const settled = pendingChatHydrationSettleCount
    pendingChatHydrationSettleCount = 0
    if (settled <= 0) return
    const { useChatStore } = await import('./chatStore')
    // New messagesByScene ref guarantees persist's setItem subscriber fires (v5
    // doesn't promise to write when the partialized slice ref is unchanged).
    useChatStore.setState((s) => ({ messagesByScene: { ...s.messagesByScene } }))
  },
}
