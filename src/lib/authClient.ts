// src/lib/authClient.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// 纯 fetch 薄壳:封装 /api/auth/* 端点。刻意不 import 任何 store,避免与
// authSlice(消费本模块)形成运行时循环依赖。
//
// /me 与 /login-url 语义:200 探测式(/me "当前会话是谁"总能回答,未登录答 null;
// /login-url 未配置时 200 + error body)。non-2xx 仅留给真错误(maker 不可达 502),
// 由调用方按异常处理。这样浏览器 console 零网络错,e2e console-error 断言不误挂。
//
// mivoTaskClient 侧的 401(AI/生图受保护 API 被 gate 拦)单独处理 —— 见 mivoTaskClient
// fetchWithTimeout 内的 onProtectedApi401,不经过本文件(那是 gate 的 401,与 /me 的 200 无关)。

export type AuthUser = {
  id: string
  name: string
  avatar: string | null
}

// /me 响应:authenticated=true 时 user 非空;false 时 user=null(未登录/未配置/无效 cookie)。
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

// GET /api/auth/login-url → authorizeUrl(整页跳转飞书)。
// 未配置鉴权时 BFF 返 200 {authorizeUrl:null, error:'auth_not_configured'} —— 抛 AuthError,
// 由 login() toast + log "登录启动失败"(不产生浏览器网络错)。
export const fetchLoginUrl = async (returnTo?: string): Promise<string> => {
  const qs = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
  const res = await fetch(`/api/auth/login-url${qs}`)
  if (!res.ok) throw new AuthError(`login_url_failed_${res.status}`, res.status)
  const body = (await res.json()) as { authorizeUrl?: string; error?: string; message?: string }
  if (!body.authorizeUrl) {
    // 200 但无 authorizeUrl = BFF 未配置(或异常空),转成可观测错误。
    throw new AuthError(body.error ? `login_url_${body.error}` : 'login_url_unavailable', res.status)
  }
  return body.authorizeUrl
}

// GET /api/auth/me → { authenticated, user }。200 = 探测成功(含未登录);
// non-2xx(502 maker 不可达)抛 AuthError(真错误)。
export const fetchMe = async (): Promise<MeResponse> => {
  const res = await fetch('/api/auth/me')
  if (!res.ok) throw new AuthError(`me_failed_${res.status}`, res.status)
  const body = (await res.json()) as Partial<MeResponse> & { user?: Partial<AuthUser> | null }
  const user = body.user ?? null
  return {
    authenticated: body.authenticated === true,
    user: user && user.id
      ? { id: user.id, name: user.name ?? '', avatar: user.avatar ?? null }
      : null,
  }
}

// POST /api/auth/logout → 清 BFF cookie。best-effort(maker 侧清理由 BFF 转调)。
export const fetchLogout = async (): Promise<void> => {
  await fetch('/api/auth/logout', { method: 'POST' })
}

// POST /api/auth/dev-login(DEV-only)→ { id, name, avatar }。404 = 生产/未启用。
export const fetchDevLogin = async (): Promise<AuthUser> => {
  const res = await fetch('/api/auth/dev-login', { method: 'POST' })
  if (res.status === 404) throw new AuthError('dev_login_disabled', 404)
  if (!res.ok) throw new AuthError(`dev_login_failed_${res.status}`, res.status)
  const body = (await res.json()) as Partial<AuthUser>
  if (!body.id) throw new AuthError('dev_login_malformed', res.status)
  return { id: body.id, name: body.name ?? '', avatar: body.avatar ?? null }
}

