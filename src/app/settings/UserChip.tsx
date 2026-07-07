// src/app/settings/UserChip.tsx
// Sidebar bottom user chip (maker-paradigm). Replaces the old settings-row button:
//   - not authenticated → "Log In" row (same grid as sidebar bottom rows)
//   - authenticated     → avatar + name + "XD.Inc · v<version>" subline, opens SettingsPanel
// Auth state comes from useAuthStore (E1 owns the real implementation; E2 ships a
// stub so this branch builds in isolation — see src/store/authSlice.ts).
import { useState } from 'react'
import { LogIn } from 'lucide-react'
import { useAuthStore } from '../../store/authSlice'
import { debugLogger } from '../../store/debugLogStore'
import { SettingsPanel } from './SettingsPanel'

// First-version hardcode. TODO: wire to build-time version injection (VERSIONING.md
// / package.json) once a release pipeline owns the value — avoids a json import
// dependency in tsconfig.app.json (no resolveJsonModule today).
const APP_VERSION = '0.1.0'

export function UserChip() {
  const user = useAuthStore((state) => state.user)
  const status = useAuthStore((state) => state.status)
  const login = useAuthStore((state) => state.login)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const isAuthenticated = status === 'authenticated' && user !== null

  if (!isAuthenticated) {
    return (
      <button
        type="button"
        className="settings-row"
        aria-label="Log in"
        onClick={() => {
          debugLogger.log('Auth', 'Login chip clicked — initiating login')
          login()
        }}
      >
        <LogIn size={17} />
        <span>Log In</span>
      </button>
    )
  }

  const initial = (user.name || '?').slice(0, 1).toUpperCase()
  return (
    <>
      <button
        type="button"
        className="user-chip"
        aria-label="Open settings"
        onClick={() => {
          debugLogger.log('Settings', 'User chip clicked — opening settings panel')
          setSettingsOpen(true)
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
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </>
  )
}
