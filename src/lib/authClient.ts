// src/lib/authClient.ts
// SSO 网关方案(feat/auth-sso):身份由 nginx 网关(auth.dsworks.cn)提供 /api/auth/me,
// app 不做 OAuth。本文件只读 /me(网关 200 已登录 / 401 未登录)。
//
// 网关契约(实测):
//   未登录:401 {"detail":"Not authenticated"}
//   已登录:200 {"authenticated":true,"username":"zhuzan@xd.com","display_name":"朱赞",
//               "is_admin":false,"services":[...,"mivo_canvas"]}
// 字段映射:AuthUser id←username, name←display_name, avatar←null(SSO 无头像,UserChip 用首字母)。
//
// 纯 fetch 薄壳:不 import 任何 store,避免与 authSlice 形成运行时循环依赖。
// mivoTaskClient 侧的 401(受保护 API 网关 session 过期)单独处理(onProtectedApi401),不经过本文件。

export type AuthUser = {
  id: string
  name: string
  avatar: string | null
}

// /me 响应:authenticated=true 时 user 非空;false 时 user=null(未登录)。
export type MeResponse = {
  authenticated: boolean
  user: AuthUser | null
}

export class AuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

// GET /api/auth/me → { authenticated, user }。
// 401(网关未登录 / dev 桩生产 fallback)→ 未登录(不抛,hydrate 按 info 处理;
//   浏览器 console 的 401 网络错是网关行为,app 不可控,dev 桩返 200 无此问题)。
// 200 + authenticated=true + username → user(id=username, name=display_name, avatar=avatar_url??null)。
//   avatar_url 是可选字段(当前 SSO 无;同事将来给 /me 加时自动 <img>,否则首字母兜底)。
// non-2xx(非 401 真错误)→ 抛 AuthError。
export const fetchMe = async (): Promise<MeResponse> => {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) return { authenticated: false, user: null }
  if (!res.ok) throw new AuthError(`me_failed_${res.status}`, res.status)
  const body = (await res.json()) as {
    authenticated?: boolean
    username?: string
    display_name?: string
    avatar_url?: string | null
  }
  if (body.authenticated && body.username) {
    return {
      authenticated: true,
      user: {
        id: body.username,
        name: body.display_name ?? body.username,
        avatar: body.avatar_url ?? null,
      },
    }
  }
  return { authenticated: false, user: null }
}
