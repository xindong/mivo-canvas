// src/app/settings/AutoPromptSettings.tsx
// Null-render component that opens the settings panel to the API Keys section on
// "first login + missing key". Wired to the auth + settings stores' live state;
// the actual decision is the pure `shouldAutoPromptSettings` predicate (unit-tested).
//
// Anti-loop: once the prompt fires, markAutoPrompted() sets a session-level flag
// so a user closing the panel won't re-trigger the effect on the next render.
// The flag is session-level (not persisted) so a reload re-arms the prompt.
import { useEffect } from 'react'
import { useAuthStore } from '../../store/authSlice'
import {
  selectKeysComplete,
  shouldAutoPromptSettings,
  useSettingsStore,
} from '../../store/settingsSlice'
import { debugLogger } from '../../store/debugLogStore'

export function AutoPromptSettings() {
  const authStatus = useAuthStore((state) => state.status)
  const keysComplete = useSettingsStore(selectKeysComplete)
  const autoPrompted = useSettingsStore((state) => state.autoPromptedThisSession)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const markAutoPrompted = useSettingsStore((state) => state.markAutoPrompted)
  // _hydrated flips true after persist rehydration (onRehydrateStorage) — a
  // reactive selector, so no set-state-in-effect subscription needed.
  const settingsHydrated = useSettingsStore((state) => state._hydrated)

  useEffect(() => {
    if (
      !shouldAutoPromptSettings({ authStatus, keysComplete, autoPrompted, settingsHydrated })
    ) {
      return
    }
    openSettings('api-keys')
    markAutoPrompted()
    debugLogger.log('Settings', '首登缺 key,自动打开 API Keys 区')
  }, [authStatus, keysComplete, autoPrompted, settingsHydrated, openSettings, markAutoPrompted])

  return null
}
