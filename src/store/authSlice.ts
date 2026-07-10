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
import {
  ANONYMOUS_USER_ID,
  getPersistUserId,
  setPersistUserId,
} from '../lib/persistUserId'
import { clearCurrentUserCache } from '../lib/persistIdbStorage'
import { migrateUntaggedAssets } from '../lib/assetStorage'

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

type AuthState = {
  user: AuthUser | null
  status: AuthStatus
  // 启动时调:GET /api/auth/me 水合登录态(网关 200 已登录 / 401 未登录)。
  hydrate: () => Promise<void>
  // 未登录入口:整页跳转 SSO 网关登录页(service=mivo_canvas,redirect=当前页)。
  login: () => Promise<void>
  // 登出:先清当前用户缓存命名空间 + 本地态,再整页跳 SSO 网关登出端点清 .dsworks.cn session cookie。
  logout: () => Promise<void>
  // 受保护 API 401 时由 mivoTaskClient 调:置未登录(幂等,不重复刷)。
  markUnauthenticated: () => void
}

// SSO 网关登录页。redirect=当前页绝对 URL(网关登录后回跳回应用)。
const SSO_LOGIN_URL = 'https://auth.dsworks.cn/login'
const SSO_LOGOUT_URL = 'https://auth.dsworks.cn/api/auth/logout'

// FX-6 single-flight: main.tsx fires hydrate at module load (for the user chip)
// and useStoreHydration awaits hydrate to gate canvas/chat rehydrate on the
// resolved userId namespace. Without dedupe, the store gate would start a second
// /api/auth/me fetch. The in-flight promise is cleared on completion so a later
// hydrate (e.g. detecting a mid-session account switch) re-runs fresh.
let hydrateInFlight: Promise<void> | null = null

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  status: 'unknown',

  hydrate: async () => {
    if (hydrateInFlight) return hydrateInFlight
    hydrateInFlight = (async () => {
      try {
        const me = await fetchMe()
        if (me.authenticated && me.user) {
          const newUid = me.user.id
          const prevUid = getPersistUserId()
          // FX-6: 非 logout 账号切换 — /api/auth/me 返回的 userId 与当前缓存命名空间
          // 不一致。整页重载让 stores 从新命名空间重新 hydrate(否则内存里仍是上个
          // 用户的画布)。全新启动 prevUid === 'anonymous' → 正常登录,非切换,不重载。
          if (prevUid !== ANONYMOUS_USER_ID && newUid !== prevUid) {
            setPersistUserId(newUid)
            debugLogger.warn('Auth', `账号切换检测:${prevUid} → ${newUid},重载切换缓存命名空间`)
            if (
              typeof window !== 'undefined' &&
              window.location &&
              typeof window.location.reload === 'function'
            ) {
              window.location.reload()
            }
            return
          }
          // FX-6: 把命名空间钉到当前用户,stores 随后 hydrate 即从 mivo-*:<uid> 读。
          setPersistUserId(newUid)
          // FX-6: 一次性认领 FX-6 前未带 userId 的存量 asset blob(防 logout 清不掉)。
          // fire-and-forget,不阻塞 hydrate;node 测试环境无 indexedDB 直接 no-op。
          void migrateUntaggedAssets(newUid)
          set({ user: me.user, status: 'authenticated' })
          debugLogger.log('Auth', `会话已恢复:${me.user.name} (${me.user.id})`)
        } else {
          // 网关 401 / dev 桩未开 → 未登录。预期态,打 info 不告警。
          // FX-6: 401 不是 logout —— 不重置缓存命名空间(否则会把内存画布写进共享
          // anonymous key)。真正的命名空间清理在 logout() 里做。
          set({ user: null, status: 'unauthenticated' })
          debugLogger.log('Auth', '未登录(网关 401 / dev 桩未开)')
        }
      } catch (err) {
        // non-2xx 真错误(非 401)→ 未登录 + 警告日志。
        set({ user: null, status: 'unauthenticated' })
        const msg = err instanceof Error ? err.message : String(err)
        debugLogger.warn('Auth', `会话恢复失败,按未登录处理:${msg}`)
      }
    })()
    try {
      await hydrateInFlight
    } finally {
      hydrateInFlight = null
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
    // FX-6: 先清当前用户缓存命名空间(canvas/chat namespaced key + 该用户 asset
    // blob),再清本地态、跳网关登出。redirect 会卸载页面 —— redirect 之后才排队的
    // IDB 写入永远落不到盘,所以清理必须在 set + 跳转之前 await 完。
    // clearCurrentUserCache 在 node 测试环境(无 indexedDB)逐级 no-op,不抛、不发 toast。
    await clearCurrentUserCache()
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
