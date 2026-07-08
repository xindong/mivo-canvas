// server/lib/pkce.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// PKCE(S256) + state + deviceId 生成。逻辑搬 maker authManager.ts:234-241
// (crypto.randomBytes + sha256 + base64url),载体从 Electron Node crypto 换到
// Hono BFF 的 node:crypto —— 算法逐行一致,飞书侧 S256 校验通过。
//
// 设计决策:PKCE 在 BFF 侧(/api/auth/login-url)生成,code_verifier 存签名
// httpOnly cookie(mivo_oauth),浏览器永远读不到。这比把 code_verifier 放
// 浏览器 sessionStorage 更安全(参考 04-mivo-side.md §6.2「Web OAuth 替代」),
// 且 /callback 是飞书顶层重定向回 BFF,浏览器内存态会丢,必须用 cookie 携带。
// 故本工具放 server/lib 而非 brief 任务 #5 的 src/lib —— 见 E1 交付报告说明。
import { randomBytes, createHash, randomUUID } from 'node:crypto'

export type PKCE = { codeVerifier: string; codeChallenge: string }

export const generatePKCE = (): PKCE => {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

// OAuth state: CSRF 令牌,绑定本次登录请求(authorize ↔ callback 配对校验)。
export const generateState = (): string => randomUUID()

// web 端 deviceId:maker JWT 带 device claim,/logout 用它定位 refresh token 记录。
// 浏览器无稳定 machineId,故每次登录随机生成(存 mivo_oauth cookie,随 JWT device claim 一致)。
// MivoCanvas 不做 refresh(过期重登),deviceId 仅用于 maker /logout 的 best-effort 清理。
export const generateDeviceId = (): string => `mivo-web-${randomBytes(16).toString('hex')}`
