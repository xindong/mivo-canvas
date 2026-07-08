// src/store/authSlice.ts
// SSO 网关方案(feat/auth-sso):身份由 nginx 网关(auth.dsworks.cn)提供 /api/auth/me,
// app 不做 OAuth。登录 = 整页跳转网关登录页;登出 = 本地清 + TODO(网关登出端点待 ops 提供)。
// 无 persist —— 每次 hydrate 读 /me,避免本地态与网关 session 不同步。
//
// 接口契约:useAuthStore { user:{id,name,avatar}|null, status, login(), logout() }。
// markUnauthenticated 供 mivoTaskClient 在受保护 API 401(网关 session 过期)时调。
import { create } from 'zustand'
import { fetchMe, type AuthUser } from '../lib/authClient'
import { debugLogger } from './debugLogStore'
import { toastFeedback } from './toastStore'

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

type AuthState = {
  user: AuthUser | null
  status: AuthStatus
  // 启动时调:GET /api/auth/me 水合登录态(网关 200 已登录 / 401 未登录)。
  hydrate: () => Promise<void>
  // 未登录入口:整页跳转 SSO 网关登录页(service=mivo_canvas,redirect=当前页)。
  login: () => Promise<void>
  // 登出:TODO 网关登出端点待 ops 提供;先本地清状态 + 提示(网关 session 未清,刷新会重新登录)。
  logout: () => Promise<void>
  // 受保护 API 401 时由 mivoTaskClient 调:置未登录(幂等,不重复刷)。
  markUnauthenticated: () => void
}

// SSO 网关登录页。redirect=当前页绝对 URL(网关登录后回跳回应用)。
const SSO_LOGIN_URL = 'https://auth.dsworks.cn/login'

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
    // TODO: SSO 网关登出端点待 ops 提供;先本地清状态 + 提示。
    // 注意:网关 session 未清,刷新会重新登录态(本地清仅影响内存,无 persist)。
    set({ user: null, status: 'unauthenticated' })
    debugLogger.warn('Auth', '本地登出:网关 session 未清,刷新会重新登录;待 ops 提供网关登出端点后补跳转')
    toastFeedback.info('已本地登出。完整登出请通过 SSO 网关(端点待补)。')
  },

  markUnauthenticated: () => {
    if (get().status !== 'unauthenticated') {
      set({ user: null, status: 'unauthenticated' })
    }
  },
}))
