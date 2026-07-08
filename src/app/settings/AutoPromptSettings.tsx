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
    // e2e opt-out: non-auto-prompt scenarios set window.__MIVO_E2E_DISABLE_AUTO_PROMPT__
    // (via addInitScript) so the dev stub's logged-in state doesn't auto-open the
    // panel + intercept their clicks. The auto-prompt-settings scenario leaves it
    // unset so this effect fires normally.
    if (typeof window !== 'undefined' && window.__MIVO_E2E_DISABLE_AUTO_PROMPT__ === true) {
      return
    }
    // 用户实测 2026-07-08:未登录也自动弹(停在账号区,用户主动点登录);已登录+缺 key 弹 API Keys 区。
    const section = shouldAutoPromptSettings({ authStatus, keysComplete, autoPrompted, settingsHydrated })
    if (!section) {
      return
    }
    openSettings(section)
    markAutoPrompted()
    debugLogger.log(
      'Settings',
      section === 'account' ? '未登录,自动打开账号区(用户主动点登录)' : '首登缺 key,自动打开 API Keys 区',
    )
  }, [authStatus, keysComplete, autoPrompted, settingsHydrated, openSettings, markAutoPrompted])

  return null
}
