// src/store/settingsSlice.ts
// B1: two keys (sk- gateway + mivo_ MCP) live browser-side. Zustand persist →
// IndexedDB (strictIdbStateStorage) so the raw key survives reloads but never
// touches the BFF/DB / localStorage. The BFF is stateless; it only probes
// (POST /api/keys/test) and reads the key back per-request via X-Mivo-Api-Key.
//
// Plus session-level UI state for the settings panel (panelOpen / panelSection /
// autoPromptedThisSession) — NOT persisted (partialize only persists the two keys)
// so a reload always starts with the panel closed and the auto-prompt armed.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { strictIdbStateStorage } from '../lib/persistIdbStorage'
import { debugLogger } from './debugLogStore'
import { toastFeedback } from './toastStore'
import { isGatewayKey, isMivoKey, keyTail, maskKey } from '../lib/keyFormat'

export type SettingsPanelSection = 'account' | 'api-keys'

export type SettingsState = {
  gatewayKey: string
  mivoKey: string
  // Session-level UI state (NOT persisted — partialize below only keeps the keys).
  panelOpen: boolean
  panelSection: SettingsPanelSection | null
  // Once the auto-prompt has fired (or been suppressed) this session, don't fire
  // again — stops the "user closes the panel → effect re-runs → re-opens" loop.
  autoPromptedThisSession: boolean
  // True once the persist middleware has finished rehydrating from IDB. AutoPrompt
  // gates on this so it doesn't read keys as '' (default) before the persisted blob
  // loads. NOT persisted (partialize only keeps the keys).
  _hydrated: boolean
  setGatewayKey: (key: string) => void
  setMivoKey: (key: string) => void
  clearGatewayKey: () => void
  clearMivoKey: () => void
  /** Programmatic open (used by UserChip click + the auto-prompt effect). Pass a
   * section to scroll/focus it; omit for a plain open (defaults to account/top). */
  openSettings: (section?: SettingsPanelSection) => void
  closeSettings: () => void
  /** Mark that the auto-prompt has fired this session so it won't fire again. */
  markAutoPrompted: () => void
}

const SETTINGS_PERSIST_VERSION = 1
const SETTINGS_PERSIST_NAME = 'mivo-canvas-settings'

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      gatewayKey: '',
      mivoKey: '',
      panelOpen: false,
      panelSection: null,
      autoPromptedThisSession: false,
      _hydrated: false,
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
        toastFeedback.success('Mivo Key 已保存')
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
      openSettings: (section) => {
        set({ panelOpen: true, panelSection: section ?? null })
      },
      closeSettings: () => {
        set({ panelOpen: false })
      },
      markAutoPrompted: () => {
        set({ autoPromptedThisSession: true })
      },
    }),
    {
      name: SETTINGS_PERSIST_NAME,
      version: SETTINGS_PERSIST_VERSION,
      // F1: strict IDB-only — NEVER falls back to localStorage (keys are secrets).
      storage: createJSONStorage(() => strictIdbStateStorage),
      // Only the two key strings persist — UI state (panelOpen/section/autoPrompted/
      // _hydrated) is session-level and must NOT survive reload (a reload re-arms
      // the prompt and starts with the panel closed).
      partialize: (state) => ({ gatewayKey: state.gatewayKey, mivoKey: state.mivoKey }),
      // Flip _hydrated after rehydration so AutoPromptSettings can gate on it via a
      // reactive selector (not a set-state-in-effect subscription, which the lint
      // rule forbids). Called after set(merge(persisted)) completes.
      onRehydrateStorage: () => () => {
        useSettingsStore.setState({ _hydrated: true })
      },
    },
  ),
)

// Derived selectors for UI. maskKey returns '' for empty/too-short input so the
// caller can fall back to a placeholder rather than printing a partial secret.
export const selectGatewayKeyMasked = (state: SettingsState): string => maskKey(state.gatewayKey)
export const selectMivoKeyMasked = (state: SettingsState): string => maskKey(state.mivoKey)
export const selectHasGatewayKey = (state: SettingsState): boolean => isGatewayKey(state.gatewayKey)
export const selectHasMivoKey = (state: SettingsState): boolean => isMivoKey(state.mivoKey)
export const selectKeysComplete = (state: SettingsState): boolean =>
  isGatewayKey(state.gatewayKey) && isMivoKey(state.mivoKey)

// Pure predicate for the "auto-open settings panel" trigger. Returns the section
// to open (or null = don't open). Extracted so it can be unit-tested without
// rendering the component. Two fire conditions (用户实测 2026-07-08):
//   - 未登录 → 'account'(账号区显示「登录」按钮,用户主动点才跳 SSO,不强制跳)
//   - 已登录 + 缺 key → 'api-keys'(首登缺 key 引导配置)
// `settingsHydrated` gates the check so the prompt doesn't fire on a false-positive
// empty-key read before IDB rehydration finishes. `autoPrompted` 防循环(用户关面板后不重弹)。
export type AutoPromptInput = {
  authStatus: string
  keysComplete: boolean
  autoPrompted: boolean
  settingsHydrated: boolean
}

export const shouldAutoPromptSettings = (input: AutoPromptInput): SettingsPanelSection | null => {
  if (!input.settingsHydrated || input.autoPrompted) return null
  if (input.authStatus === 'unauthenticated') return 'account'
  if (input.authStatus === 'authenticated' && !input.keysComplete) return 'api-keys'
  return null
}
