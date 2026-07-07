// src/store/settingsSlice.ts
// B1: two keys (sk- gateway + mivo_ MCP) live browser-side. Zustand persist →
// IndexedDB (idbStateStorage) so the raw key survives reloads but never touches
// the BFF/DB. The BFF is stateless; it only probes (POST /api/keys/test) and reads
// the key back per-request via the X-Mivo-Api-Key header.
//
// State surface (UI consumes):
//   gatewayKey / mivoKey           — raw key strings ('' = not configured)
//   setGatewayKey / setMivoKey     — persist a new key (gateway: only after the
//                                     /api/keys/test probe passes — caller enforces)
//   clearGatewayKey / clearMivoKey — wipe
//   selectGatewayKeyMasked / ...   — derived for UI (sk-••••••<last4>)
//
// Logging invariant: debugLogger only ever sees keyTail (last 4). The raw key
// never enters debugLogger or remote debug reports.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { strictIdbStateStorage } from '../lib/persistIdbStorage'
import { debugLogger } from './debugLogStore'
import { toastFeedback } from './toastStore'
import { isGatewayKey, isMivoKey, keyTail, maskKey } from '../lib/keyFormat'

export type SettingsState = {
  gatewayKey: string
  mivoKey: string
  setGatewayKey: (key: string) => void
  setMivoKey: (key: string) => void
  clearGatewayKey: () => void
  clearMivoKey: () => void
}

const SETTINGS_PERSIST_VERSION = 1
const SETTINGS_PERSIST_NAME = 'mivo-canvas-settings'

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      gatewayKey: '',
      mivoKey: '',
      setGatewayKey: (key) => {
        const trimmed = key.trim()
        debugLogger.log('Settings', `gateway key saved: tail=${keyTail(trimmed)}`)
        set({ gatewayKey: trimmed })
        toastFeedback.success('网关 Key 已保存')
      },
      setMivoKey: (key) => {
        const trimmed = key.trim()
        debugLogger.log('Settings', `mivo key saved: tail=${keyTail(trimmed)}`)
        set({ mivoKey: trimmed })
      },
      clearGatewayKey: () => {
        debugLogger.log('Settings', 'gateway key cleared')
        set({ gatewayKey: '' })
        toastFeedback.info('网关 Key 已清除')
      },
      clearMivoKey: () => {
        debugLogger.log('Settings', 'mivo key cleared')
        set({ mivoKey: '' })
        toastFeedback.info('Mivo Key 已清除')
      },
    }),
    {
      name: SETTINGS_PERSIST_NAME,
      version: SETTINGS_PERSIST_VERSION,
      // F1: strict IDB-only — NEVER falls back to localStorage (keys are secrets).
      // IDB unavailable / write failure → fail-closed (in-memory only + toast).
      storage: createJSONStorage(() => strictIdbStateStorage),
      // Only the two key strings persist — actions are rehydrated from the store
      // factory, never serialized.
      partialize: (state) => ({ gatewayKey: state.gatewayKey, mivoKey: state.mivoKey }),
    },
  ),
)

// Derived selectors for UI. maskKey returns '' for empty/too-short input so the
// caller can fall back to a placeholder rather than printing a partial secret.
export const selectGatewayKeyMasked = (state: SettingsState): string => maskKey(state.gatewayKey)
export const selectMivoKeyMasked = (state: SettingsState): string => maskKey(state.mivoKey)
export const selectHasGatewayKey = (state: SettingsState): boolean => isGatewayKey(state.gatewayKey)
export const selectHasMivoKey = (state: SettingsState): boolean => isMivoKey(state.mivoKey)
