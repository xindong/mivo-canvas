// src/lib/authClient.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// 纯 fetch 薄壳:封装 /api/auth/* 端点。刻意不 import 任何 store,避免与
// authSlice(消费本模块)形成运行时循环依赖。401 抛 AuthError(status=401),
// 由 authSlice 的 hydrate/login 调用方决定如何降级(置未登录态 + toast)。
//
// mivoTaskClient 侧的 401(AI/生图受保护 API 被拦)单独处理 —— 见 mivoTaskClient
// fetchWithTimeout 内的 onProtectedApi401,不经过本文件。

export type AuthUser = {
  id: string
  name: string
  avatar: string | null
}

export class AuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

// GET /api/auth/login-url → { authorizeUrl }。returnTo 为站点相对路径,回调后 302 回该路径。
export const fetchLoginUrl = async (returnTo?: string): Promise<string> => {
  const qs = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
  const res = await fetch(`/api/auth/login-url${qs}`)
  if (!res.ok) throw new AuthError(`login_url_failed_${res.status}`, res.status)
  const body = (await res.json()) as { authorizeUrl?: string }
  if (!body.authorizeUrl) throw new AuthError('login_url_malformed', res.status)
  return body.authorizeUrl
}

// GET /api/auth/me → { id, name, avatar }。401(BFF cookie 无效/过期)抛 AuthError(401)。
export const fetchMe = async (): Promise<AuthUser> => {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) throw new AuthError('unauthorized', 401)
  if (!res.ok) throw new AuthError(`me_failed_${res.status}`, res.status)
  const body = (await res.json()) as Partial<AuthUser>
  if (!body.id) throw new AuthError('me_malformed', res.status)
  return { id: body.id, name: body.name ?? '', avatar: body.avatar ?? null }
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
