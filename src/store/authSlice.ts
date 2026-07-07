// src/store/authSlice.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// A2 身份依赖 maker server:前端不持有 JWT(httpOnly cookie,JS 读不到),
// 登录态由 GET /api/auth/me 水合。无 persist —— 会话在 BFF cookie(服务端),
// 每次页面加载重新水合,避免本地态与 cookie 不同步。
//
// 不做硬登录墙(用户需求 2026-07-07):应用未登录可用,入口在侧栏用户 chip(E2)。
// 受保护 AI/生图 API 401 → mivoTaskClient 调 markUnauthenticated() + toast 提示登录。
//
// 接口契约(与 E2 汇合点):useAuthStore 暴露 { user:{id,name,avatar}|null, status, login(), logout() }。
// hydrate/devLogin/markUnauthenticated 为 E1 内部 + 供 E2 dev 模式可选调用。
import { create } from 'zustand'
import {
  fetchLoginUrl,
  fetchMe,
  fetchLogout,
  fetchDevLogin,
  AuthError,
  type AuthUser,
} from '../lib/authClient'
import { debugLogger } from './debugLogStore'
import { toastFeedback } from './toastStore'

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

type AuthState = {
  user: AuthUser | null
  status: AuthStatus
  // 启动时调:GET /api/auth/me 水合登录态。401 → 未登录;其他错 → 未登录 + 警告日志。
  hydrate: () => Promise<void>
  // 未登录入口:GET /api/auth/login-url → 整页跳转飞书 authorize。
  login: () => Promise<void>
  // 登出:POST /api/auth/logout(清 BFF cookie)+ 本地置未登录。
  logout: () => Promise<void>
  // DEV-only:POST /api/auth/dev-login(镜像 maker dev-login)。生产 404 → toast 提示未启用。
  devLogin: () => Promise<void>
  // 受保护 API 401 时由 mivoTaskClient 调:置未登录(幂等,不重复刷)。
  markUnauthenticated: () => void
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  status: 'unknown',

  hydrate: async () => {
    try {
      const user = await fetchMe()
      set({ user, status: 'authenticated' })
      debugLogger.log('Auth', `会话已恢复:${user.name} (${user.id})`)
    } catch (err) {
      set({ user: null, status: 'unauthenticated' })
      // 401 = 有鉴权但无有效会话;503 = BFF 未配鉴权(本地/未启用,GET /me 返
      // auth_not_configured)。两者都是预期的「未登录」,打 info,不当异常告警 ——
      // 否则本地/dev 环境每次启动都会刷一条 warn(e2e init-warning 断言也会误挂)。
      if (err instanceof AuthError && (err.status === 401 || err.status === 503)) {
        debugLogger.log('Auth', err.status === 503 ? '鉴权未配置(本地/未启用),按未登录处理' : '未登录(无有效会话)')
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        debugLogger.warn('Auth', `会话恢复失败,按未登录处理:${msg}`)
      }
    }
  },

  login: async () => {
    // 回调后 302 回当前路径(含 query),保持上下文。
    const returnTo = window.location.pathname + window.location.search
    try {
      const authorizeUrl = await fetchLoginUrl(returnTo)
      debugLogger.log('Auth', '跳转飞书授权页')
      window.location.href = authorizeUrl
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      debugLogger.error('Auth', `登录启动失败:${msg}`)
      toastFeedback.error('登录启动失败,请稍后重试。')
    }
  },

  logout: async () => {
    try {
      await fetchLogout()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      debugLogger.warn('Auth', `登出请求失败(本地仍清登出态):${msg}`)
    }
    set({ user: null, status: 'unauthenticated' })
    debugLogger.log('Auth', '已登出')
    toastFeedback.success('已登出')
  },

  devLogin: async () => {
    try {
      const user = await fetchDevLogin()
      set({ user, status: 'authenticated' })
      debugLogger.log('Auth', `Dev 登录成功:${user.name} (${user.id})`)
      toastFeedback.success(`Dev 登录:${user.name}`)
    } catch (err) {
      if (err instanceof AuthError && err.status === 404) {
        toastFeedback.warn('Dev 登录未启用(需 MIVO_DEV_AUTH_ENABLED=1)。')
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        debugLogger.error('Auth', `Dev 登录失败:${msg}`)
        toastFeedback.error('Dev 登录失败。')
      }
    }
  },

  markUnauthenticated: () => {
    if (get().status !== 'unauthenticated') {
      set({ user: null, status: 'unauthenticated' })
    }
  },
}))
