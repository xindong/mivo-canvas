// server/routes/auth.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// A2 身份依赖 maker server: BFF 不自建用户体系、不自做飞书 code 交换。
// 流程(Web 标准 OAuth + BFF):
//   1. GET  /api/auth/login-url  — BFF 生成 PKCE(S256)+state+deviceId,签名 httpOnly
//                                  cookie 暂存,返回飞书 authorize URL(redirect_uri=BFF callback)
//   2. GET  /api/auth/callback   — 飞书重定向回 BFF;校 state → 转调 maker /api/auth/login
//                                  {code,codeVerifier,deviceId,clientType:'web',redirectUri}
//                                  → 拿 maker JWT → Set-Cookie httpOnly Secure SameSite=Lax → 302 回应用
//   3. GET  /api/auth/me         — 验 cookie JWT → 代理 maker /api/user/me → {id,name,avatar}
//   4. POST /api/auth/logout     — 清 cookie(+ best-effort 转调 maker /logout)
//   5. POST /api/auth/dev-login  — DEV-only(MIVO_DEV_AUTH_ENABLED=1),镜像 maker dev-login,生产 404
//
// JWT: maker 颁发 HS256,共享 JWT_SECRET(base64)验签,放 httpOnly cookie,~1h 过期重登(F2,不做 refresh)。
// 凭证零落地前端:JWT 在 httpOnly cookie,前端 JS 读不到;maker refreshToken/飞书 token 一律丢弃。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie, setSignedCookie, getSignedCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv } from '../lib/types'
import { getAuthConfig } from '../lib/authConfig'
import type { AuthConfig } from '../lib/authConfig'
import { verifyAccessToken } from '../lib/jwt'
import { generatePKCE, generateState, generateDeviceId } from '../lib/pkce'
import { AUTH_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from '../lib/authGate'

export const authRoute = new Hono<AppEnv>()

const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const OAUTH_STATE_MAX_AGE_SECONDS = 600 // 10 min( authorize + 飞书登录 + 回调窗口)
const DEFAULT_AUTH_COOKIE_MAX_AGE = 3600 // 1h(对齐 maker accessExpiresIn 默认)

// maker /api/auth/login 响应里 E1 消费的字段(refreshToken / 飞书 token 一律丢弃)。
type MakerLoginResult = {
  accessToken: string
  user: { id: string; name: string; avatar: string | null }
}

type OAuthStatePayload = {
  v: string // code_verifier
  s: string // state(CSRF)
  d: string // deviceId(随 JWT device claim 一致,/logout 用)
  r: string // returnTo(回调后 302 目标,站点相对路径)
}

// 鉴权未配置(JWT_SECRET / MAKER_SERVER_URL / FEISHU_APP_ID 任缺)→ 503,提示运维配 env。
const assertAuthConfigured = (cfg: AuthConfig): string | null => {
  if (!cfg.jwtSecretBytes) return 'JWT_SECRET 未配置(BFF 无法验签 maker JWT)'
  if (!cfg.makerServerUrl) return 'MAKER_SERVER_URL 未配置(无法转调 maker 登录)'
  if (!cfg.feishuAppId) return 'MIVO_FEISHU_APP_ID 未配置(无法构造飞书 authorize URL)'
  return null
}

// BFF OAuth 回调绝对 URL:显式 env 优先(MIVO_OAUTH_REDIRECT_URI,生产必填以精确匹配飞书后台白名单);
// 缺省按请求 origin 推导(本地 dev: http://127.0.0.1:8080/api/auth/callback)。
const resolveRedirectUri = (c: Context<AppEnv>, cfg: AuthConfig): string => {
  if (cfg.oauthRedirectUri) return cfg.oauthRedirectUri
  const url = new URL(c.req.url)
  const proto = (c.req.header('x-forwarded-proto') || url.protocol).replace(/:$/, '')
  const host = c.req.header('x-forwarded-host') || url.host
  return `${proto}://${host}/api/auth/callback`
}

// returnTo 校验:只接受站点相对路径(防 open-redirect),默认 '/'。
const safeReturnTo = (raw: string | undefined): string => {
  const r = raw ?? '/'
  return r.startsWith('/') && !r.startsWith('//') ? r : '/'
}

// --- 1. GET /api/auth/login-url ---
authRoute.get('/login-url', async (c) => {
  const cfg = getAuthConfig()
  const missing = assertAuthConfigured(cfg)
  if (missing) {
    return c.json({ error: 'auth_not_configured', message: missing }, 503)
  }

  const { codeVerifier, codeChallenge } = generatePKCE()
  const state = generateState()
  const deviceId = generateDeviceId()
  const returnTo = safeReturnTo(c.req.query('returnTo'))
  const redirectUri = resolveRedirectUri(c, cfg)

  const params = new URLSearchParams({
    client_id: cfg.feishuAppId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: cfg.feishuScope,
  })

  // 暂存 OAuth 进行态到签名 httpOnly cookie(10min)。code_verifier 永不下发浏览器 JS。
  // setSignedCookie 是 async(HMAC 走 crypto.subtle),必须 await —— 否则响应先于签名完成发出,cookie 丢失。
  const payload: OAuthStatePayload = { v: codeVerifier, s: state, d: deviceId, r: returnTo }
  await setSignedCookie(c, OAUTH_STATE_COOKIE_NAME, JSON.stringify(payload), cfg.jwtSecretRaw, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  })

  return c.json({ authorizeUrl: `${FEISHU_AUTHORIZE_URL}?${params.toString()}` })
})

// --- 2. GET /api/auth/callback ---
authRoute.get('/callback', async (c) => {
  const cfg = getAuthConfig()
  const fail = (reason: string) => {
    // 浏览器顶层跳转回来 → 错误也用 302 回应用,前端读 ?auth_error toast。
    console.warn(`[auth/callback] ${reason}`)
    return c.redirect(`${safeReturnTo('/')}?auth_error=${encodeURIComponent(reason)}`)
  }

  const missing = assertAuthConfigured(cfg)
  if (missing) return fail('auth_not_configured')

  const code = typeof c.req.query('code') === 'string' ? c.req.query('code') : ''
  const queryState = typeof c.req.query('state') === 'string' ? c.req.query('state') : ''
  if (!code || !queryState) return fail('missing_code_or_state')

  // 取签名 oauth state cookie;缺失/被篡改 → 拒(防 CSRF / cookie 注入)。
  // 注意 getSignedCookie 签名是 (c, secret, key) —— secret 在前、name 在后,
  // 与 setSignedCookie(c, name, value, secret, opt) 的顺序不同(Hono API 怪癖)。
  const stateRaw = await getSignedCookie(c, cfg.jwtSecretRaw, OAUTH_STATE_COOKIE_NAME)
  if (!stateRaw) return fail('state_cookie_missing')
  let st: OAuthStatePayload
  try {
    st = JSON.parse(stateRaw) as OAuthStatePayload
  } catch {
    return fail('state_cookie_malformed')
  }
  if (typeof st.v !== 'string' || typeof st.s !== 'string' || typeof st.d !== 'string') {
    return fail('state_cookie_invalid')
  }
  // CSRF 校验:cookie state 必须等于飞书回传的 state。
  if (st.s !== queryState) return fail('state_mismatch')

  const redirectUri = resolveRedirectUri(c, cfg)
  let makerResp: Response
  try {
    makerResp = await fetch(`${cfg.makerServerUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        codeVerifier: st.v,
        deviceId: st.d,
        clientType: 'web',
        redirectUri,
      }),
    })
  } catch {
    return fail('maker_unreachable')
  }
  if (!makerResp.ok) {
    const reason = await makerResp.text().catch(() => '')
    console.warn(`[auth/callback] maker /login ${makerResp.status}: ${reason.slice(0, 200)}`)
    return fail(`maker_login_failed_${makerResp.status}`)
  }

  const result = (await makerResp.json()) as MakerLoginResult
  if (!result?.accessToken || !result?.user?.id) return fail('maker_login_malformed')

  // 本地验签(也校验 JWT_SECRET 与 maker 一致)+ 取 exp 给 cookie maxAge。
  const payload = await verifyAccessToken(result.accessToken, cfg.jwtSecretBytes!)
  if (!payload) return fail('jwt_verification_failed')

  const nowSec = Math.floor(Date.now() / 1000)
  const maxAge = typeof payload.exp === 'number'
    ? Math.max(0, payload.exp - nowSec)
    : DEFAULT_AUTH_COOKIE_MAX_AGE

  setCookie(c, AUTH_COOKIE_NAME, result.accessToken, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  })
  deleteCookie(c, OAUTH_STATE_COOKIE_NAME, { path: '/' })

  return c.redirect(st.r || '/')
})

// --- 3. GET /api/auth/me ---
authRoute.get('/me', async (c) => {
  const cfg = getAuthConfig()
  if (!cfg.jwtSecretBytes) return c.json({ error: 'auth_not_configured' }, 503)

  const token = getCookie(c, AUTH_COOKIE_NAME)
  if (!token) return c.json({ error: 'unauthorized' }, 401)

  // 本地验签(无网络):失败直接 401,不打扰 maker。
  const payload = await verifyAccessToken(token, cfg.jwtSecretBytes)
  if (!payload) return c.json({ error: 'unauthorized' }, 401)

  // 代理 maker /api/user/me 拿姓名/头像(JWT claims 只有 sub+device,无展示信息)。
  let makerResp: Response
  try {
    makerResp = await fetch(`${cfg.makerServerUrl}/api/user/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    return c.json({ error: 'maker_unreachable' }, 502)
  }
  if (makerResp.status === 401) return c.json({ error: 'unauthorized' }, 401)
  if (!makerResp.ok) return c.json({ error: 'maker_user_me_failed' }, 502)

  const body = (await makerResp.json()) as { user?: { id?: string; name?: string; avatar?: string | null } }
  const user = body?.user
  if (!user?.id) return c.json({ error: 'maker_user_me_malformed' }, 502)

  return c.json({ id: user.id, name: user.name ?? '', avatar: user.avatar ?? null })
})

// --- 4. POST /api/auth/logout ---
authRoute.post('/logout', async (c) => {
  const cfg = getAuthConfig()
  const token = getCookie(c, AUTH_COOKIE_NAME)

  // best-effort 转调 maker /logout(清 maker 侧 refresh token 记录);失败不阻塞本地登出。
  if (token && cfg.jwtSecretBytes && cfg.makerServerUrl) {
    const payload = await verifyAccessToken(token, cfg.jwtSecretBytes)
    if (payload?.device) {
      fetch(`${cfg.makerServerUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: payload.device }),
      }).catch(() => {
        /* fire-and-forget: 本地 cookie 已清,maker 侧记录残留无害 */
      })
    }
  }

  deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' })
  deleteCookie(c, OAUTH_STATE_COOKIE_NAME, { path: '/' })
  return c.json({ success: true })
})

// --- 5. POST /api/auth/dev-login (DEV-only) ---
authRoute.post('/dev-login', async (c) => {
  const cfg = getAuthConfig()
  // A-3 生产双保险:MIVO_PUBLIC=1 或 NODE_ENV=production 时无条件 404,
  // 优先级高于 MIVO_DEV_AUTH_ENABLED —— 即便误设 enabled=1,生产环境也不开 dev-login。
  if (cfg.isProduction) return c.json({ error: 'not_found' }, 404)
  // 未显式 MIVO_DEV_AUTH_ENABLED=1 → 404(路由存在但不可用)。
  if (!cfg.devAuthEnabled) return c.json({ error: 'not_found' }, 404)

  const missing = assertAuthConfigured(cfg)
  if (missing) return c.json({ error: 'auth_not_configured', message: missing }, 503)

  const deviceId = generateDeviceId()
  let makerResp: Response
  try {
    makerResp = await fetch(`${cfg.makerServerUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    })
  } catch {
    return c.json({ error: 'maker_unreachable' }, 502)
  }
  if (!makerResp.ok) {
    return c.json({ error: 'maker_dev_login_failed', status: makerResp.status }, 502)
  }

  const result = (await makerResp.json()) as MakerLoginResult
  if (!result?.accessToken || !result?.user?.id) {
    return c.json({ error: 'maker_dev_login_malformed' }, 502)
  }

  const payload = await verifyAccessToken(result.accessToken, cfg.jwtSecretBytes!)
  if (!payload) return c.json({ error: 'jwt_verification_failed' }, 502)

  const nowSec = Math.floor(Date.now() / 1000)
  const maxAge = typeof payload.exp === 'number'
    ? Math.max(0, payload.exp - nowSec)
    : DEFAULT_AUTH_COOKIE_MAX_AGE
  setCookie(c, AUTH_COOKIE_NAME, result.accessToken, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  })

  return c.json({ id: result.user.id, name: result.user.name, avatar: result.user.avatar ?? null })
})
