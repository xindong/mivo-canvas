// server/lib/authGate.ts
// feat/auth-feishu-login (E1 · F7 access gate 升级, A-2 default-deny)
//
// gate 设计(共同上下文:「BFF gate 只保护 AI/生图/资产类 API,/api/auth/*
// 与画布本地功能不拦;未登录调受保护 API 返 401 → 前端 toast 提示登录」):
//   1. 白名单(永远放行):/healthz、/api/auth/*
//   2. 受保护集(default-deny 反转):整个 /api/mivo/* + /api/keys/* 默认都拦
//      —— 不再逐条枚举 generate/edit/enhance/tasks,而是默认保护、例外放行。
//      覆盖 local-assets(枚举本机图)/ eagle/*(读 Eagle 原图)/ proxy-image
//      (服务端代理可滥用)等之前漏保护的资产类路由。
//   3. 显式例外(走自身鉴权):/api/mivo/debug-logs —— 它自有 MIVO_DEBUG_VIEW_TOKEN
//      + public-mode 403 gate(D8),不依赖主 gate;主 gate 放行让它走自己的鉴权。
//
// 凭证优先级:JWT cookie(mivo_auth,第一公民)→ MIVO_BFF_TOKEN 三方案(兼容/应急通道)。
// 两者都未配置 → gate 完全 no-op(本地 dev 默认,保留 PR #144 之前的开发体验)。
// A-1:JWT_SECRET 配置非法 → 受保护路径一律 401(见 app.ts gate)。

// 默认保护集:段匹配(/api/mivo 与 /api/mivo/*;/api/keys 与 /api/keys/*)。
const PROTECTED_PREFIXES = ['/api/mivo', '/api/keys'] as const

// 保护集内的显式例外(走自身鉴权,主 gate 放行)。
// /api/mivo/debug-logs:自有 MIVO_DEBUG_VIEW_TOKEN + public-mode 403(D8,见 debug-logs.ts)。
const PUBLIC_EXCEPTIONS = ['/api/mivo/debug-logs'] as const

const matchesSegment = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`)

export const isProtectedPath = (path: string): boolean => {
  const underProtected = PROTECTED_PREFIXES.some((p) => matchesSegment(path, p))
  if (!underProtected) return false
  if (PUBLIC_EXCEPTIONS.some((p) => matchesSegment(path, p))) return false
  return true
}

// cookie 名(httpOnly Secure SameSite=Lax):
//   mivo_auth   — maker JWT(access token),maxAge 对齐 JWT exp(~1h)。
//   mivo_oauth  — OAuth 进行态({codeVerifier,state,deviceId,returnTo}),签名 + 10min,回调后即清。
export const AUTH_COOKIE_NAME = 'mivo_auth'
export const OAUTH_STATE_COOKIE_NAME = 'mivo_oauth'

// 白名单:gate 跳过(放行)。
export const isGateWhitelisted = (path: string): boolean =>
  path === '/healthz' || path.startsWith('/api/auth/')
