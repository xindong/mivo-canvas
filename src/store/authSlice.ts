// src/store/authSlice.ts
// SSO 网关方案(feat/auth-sso):身份由 nginx 网关(auth.dsworks.cn)提供 /api/auth/me,
// app 不做 OAuth。登录 = 整页跳转网关登录页;登出 = 先本地清态再跳网关登出端点。
// 无 persist —— 每次 hydrate 读 /me,避免本地态与网关 session 不同步。
//
// 接口契约:useAuthStore { user:{id,name,avatar}|null, status, login(), logout() }。
// markUnauthenticated 供 mivoTaskClient 在受保护 API 401(网关 session 过期)时调。
import { create } from 'zustand'
import { fetchMe, type AuthUser } from '../lib/authClient'
import { debugLogger } from './debugLogStore'

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

type AuthState = {
  user: AuthUser | null
  status: AuthStatus
  // 启动时调:GET /api/auth/me 水合登录态(网关 200 已登录 / 401 未登录)。
  hydrate: () => Promise<void>
  // 未登录入口:整页跳转 SSO 网关登录页(service=mivo_canvas,redirect=当前页)。
  login: () => Promise<void>
  // 登出:先乐观清本地态,再整页跳 SSO 网关登出端点清 .dsworks.cn session cookie。
  logout: () => Promise<void>
  // 受保护 API 401 时由 mivoTaskClient 调:置未登录(幂等,不重复刷)。
  markUnauthenticated: () => void
}

// SSO 网关登录页。redirect=当前页绝对 URL(网关登录后回跳回应用)。
const SSO_LOGIN_URL = 'https://auth.dsworks.cn/login'
const SSO_LOGOUT_URL = 'https://auth.dsworks.cn/api/auth/logout'

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  status: 'unknown',

  hydrate: async () => {
    try {
      const me = await fetchMe()
      if (me.authenticated && me.user) {
        set({ user: me.user, status: 'authenticated' })
        debugLogger.log('Auth', `会话已恢复:${me.user.name} (${me.user.id})`)
      } else {
        // 网关 401 / dev 桩未开 → 未登录。预期态,打 info 不告警。
        set({ user: null, status: 'unauthenticated' })
        debugLogger.log('Auth', '未登录(网关 401 / dev 桩未开)')
      }
    } catch (err) {
      // non-2xx 真错误(非 401)→ 未登录 + 警告日志。
      set({ user: null, status: 'unauthenticated' })
      const msg = err instanceof Error ? err.message : String(err)
      debugLogger.warn('Auth', `会话恢复失败,按未登录处理:${msg}`)
    }
  },

  login: async () => {
    // 整页跳转 SSO 网关登录页;service=mivo_canvas,redirect=当前页绝对 URL。
    const redirect = window.location.href
    const loginUrl = `${SSO_LOGIN_URL}?service=mivo_canvas&redirect=${encodeURIComponent(redirect)}`
    debugLogger.log('Auth', `跳转 SSO 网关登录:${loginUrl}`)
    window.location.href = loginUrl
  },

  logout: async () => {
    set({ user: null, status: 'unauthenticated' })
    const redirect = `${window.location.origin}/`
    const logoutUrl = `${SSO_LOGOUT_URL}?service=mivo_canvas&redirect=${encodeURIComponent(redirect)}`
    debugLogger.log('Auth', `登出:本地态已清,跳转 SSO 网关登出:${logoutUrl}`)
    window.location.href = logoutUrl
  },

  markUnauthenticated: () => {
    if (get().status !== 'unauthenticated') {
      set({ user: null, status: 'unauthenticated' })
    }
  },
}))
