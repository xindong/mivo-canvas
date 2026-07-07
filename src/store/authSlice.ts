// src/store/authSlice.ts
// ⚠️ STUB — replaced by E1 (feat/auth-feishu-login) at lead merge time.
// E2 consumes the auth contract { user, status, login(), logout() } so this
// branch builds + tests in isolation. E1's real implementation (Feishu OAuth →
// JWT cookie → /api/auth/me hydration) overrides this file wholesale; do NOT
// expand the stub, wire real auth here, or depend on its behavior beyond the
// typed surface below.
import { create } from 'zustand'
import { debugLogger } from './debugLogStore'

export type AuthUser = {
  id: string
  name: string
  avatar: string | null
}

export type AuthStatus = 'unknown' | 'loading' | 'authenticated' | 'guest'

type AuthState = {
  user: AuthUser | null
  status: AuthStatus
  /** E1: request /api/auth/login-url then redirect to Feishu OAuth. Stub: no-op. */
  login: () => void
  /** E1: POST /api/auth/logout + clear JWT cookie. Stub: local reset only. */
  logout: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  // Stub: not authenticated. E1 hydrates from /api/auth/me on boot and flips this
  // to 'authenticated' | 'guest' based on the JWT cookie.
  status: 'guest',
  login: () => {
    debugLogger.warn('Auth', 'login() called on E2 stub — E1 implements Feishu OAuth redirect')
  },
  logout: () => {
    debugLogger.warn('Auth', 'logout() called on E2 stub — E1 implements BFF logout')
    set({ user: null, status: 'guest' })
  },
}))
