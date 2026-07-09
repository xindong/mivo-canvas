// src/app/settings/UserChip.tsx
// Sidebar bottom user chip. SSO gateway scheme: production forces login (gateway),
// so a user reaching the app is already authenticated → chip shows display_name +
// initial-avatar (SSO has no avatar image). Not authenticated (rare, session
// expired) → "Log In" row that opens the account settings section; the settings
// panel's account button is the only place that jumps to the SSO gateway. Clicking
// the authenticated chip opens the settings panel via the store's openSettings
// action (so AutoPromptSettings can also open it programmatically). The panel
// itself renders at the App root, so this chip only triggers openSettings — it
// does not host the panel.
import { LogIn } from 'lucide-react'
import { useAuthStore } from '../../store/authSlice'
import { useSettingsStore } from '../../store/settingsSlice'
import { debugLogger } from '../../store/debugLogStore'

// First-version hardcode. TODO: wire to build-time version injection (VERSIONING.md
// / package.json) once a release pipeline owns the value — avoids a json import
// dependency in tsconfig.app.json (no resolveJsonModule today).
const APP_VERSION = '0.1.0'

export function UserChip() {
  const user = useAuthStore((state) => state.user)
  const status = useAuthStore((state) => state.status)
  const openSettings = useSettingsStore((state) => state.openSettings)

  const isAuthenticated = status === 'authenticated' && user !== null

  if (!isAuthenticated) {
    return (
      <button
        type="button"
        className="settings-row"
        aria-label="Log in"
        onClick={() => {
          debugLogger.log('Auth', 'Login chip clicked — opening account settings')
          openSettings('account')
        }}
      >
        <LogIn size={17} />
        <span>Log In</span>
      </button>
    )
  }

  const initial = (user.name || '?').slice(0, 1).toUpperCase()
  return (
    <button
      type="button"
      className="user-chip"
      aria-label="Open settings"
      onClick={() => {
        debugLogger.log('Settings', 'User chip clicked — opening settings panel')
        openSettings()
      }}
    >
      <span className="user-chip-avatar" aria-hidden="true">
        {user.avatar ? <img src={user.avatar} alt="" /> : <span className="user-chip-avatar-fallback">{initial}</span>}
      </span>
      <span className="user-chip-text">
        <span className="user-chip-name">{user.name}</span>
        <span className="user-chip-sub">XD.Inc · v{APP_VERSION}</span>
      </span>
    </button>
  )
}
