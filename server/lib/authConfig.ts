// server/lib/authConfig.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// A2 身份依赖 maker server: MivoCanvas BFF 不自建用户体系,登录经 maker
// /api/auth/login 拿 JWT(httpOnly cookie),BFF 用共享 JWT_SECRET 验签。
// 本文件集中读取鉴权相关 env,惰性求值(每次调用读 process.env)以便测试
// 覆盖,口径对齐 server/lib/config.ts 的 getEnvConfig()。
//
// 环境变量(均参见 .env.example):
//   JWT_SECRET              (必填,启用鉴权) base64,与 maker server 共享,用于验 maker JWT
//                                                  + 签名 oauth state cookie
//   MAKER_SERVER_URL        (必填) maker server 基址,如 http://localhost:3333
//   MIVO_FEISHU_APP_ID      (必填) 飞书应用 App ID(与 maker 同一个应用)
//   MIVO_FEISHU_SCOPE       (可选) OAuth scope,默认 "contact:user.email:readonly"(身份最小集)
//   MIVO_OAUTH_REDIRECT_URI (可选) BFF 回调绝对 URL;缺省按请求 origin 推导
//   MIVO_DEV_AUTH_ENABLED   (可选) =1 开 /api/auth/dev-login(DEV-only,生产不设)
//   MIVO_COOKIE_SECURE      (可选) =1/0 强制 cookie Secure 标志;缺省按 MIVO_PUBLIC 推导

export type AuthConfig = {
  // base64 编码的 JWT 共享密钥原始值;空串表示未配置(鉴权关闭,本地 dev 默认)。
  jwtSecretRaw: string
  // 解码后的字节,直接喂给 jose jwtVerify(口径对齐 maker config.ts:99-108)。
  // null = 解码失败 / 解码为空字节。
  jwtSecretBytes: Uint8Array | null
  // A-1 fail-closed:JWT_SECRET 原始值非空但解码为空/非法 → 视为「配置非法」而非「未配置」。
  // 启动层 process.exit(1)(任何模式);gate 层对受保护路径一律 401(防御纵深,供 env 变更后的测试)。
  jwtSecretMisconfigured: boolean
  // maker server 基址(去尾斜杠),用于 /api/auth/login / /api/auth/dev-login
  // / /api/auth/logout / /api/user/me 代理。
  makerServerUrl: string
  feishuAppId: string
  feishuScope: string
  // BFF OAuth 回调绝对 URL;空串表示按请求 origin 推导(/api/auth/callback)。
  oauthRedirectUri: string
  devAuthEnabled: boolean
  // A-3 生产双保险:MIVO_PUBLIC=1 或 NODE_ENV=production 时为 true,
  // /api/auth/dev-login 无条件 404(优先级高于 devAuthEnabled)。
  isProduction: boolean
  // cookie Secure 标志:生产(MIVO_PUBLIC=1)默认 true,本地默认 false;可被 MIVO_COOKIE_SECURE 覆盖。
  cookieSecure: boolean
}

const base64ToBytes = (raw: string): Uint8Array | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Node Buffer.from(str,'base64') 对非法字符是 lenient(跳过而非抛错),故 try/catch 兜底
  // 但真正区分点在 bytes.length:0 字节 = 无有效密钥内容。
  try {
    const bytes = new Uint8Array(Buffer.from(trimmed, 'base64'))
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

export const getAuthConfig = (): AuthConfig => {
  const jwtSecretRaw = process.env.JWT_SECRET ?? ''
  const jwtSecretBytes = base64ToBytes(jwtSecretRaw)
  const isPublic = process.env.MIVO_PUBLIC === '1'
  const cookieSecureOverride = process.env.MIVO_COOKIE_SECURE
  const cookieSecure =
    cookieSecureOverride !== undefined ? cookieSecureOverride === '1' : isPublic
  return {
    jwtSecretRaw,
    jwtSecretBytes,
    // 原始值非空但解码得 null = 配置非法(无效 base64 / 解码空字节)。
    jwtSecretMisconfigured: jwtSecretRaw.trim().length > 0 && jwtSecretBytes === null,
    makerServerUrl: (process.env.MAKER_SERVER_URL ?? '').replace(/\/$/, ''),
    feishuAppId: process.env.MIVO_FEISHU_APP_ID ?? '',
    // 身份最小集:open_id/name/avatar 随 base userinfo 返回,email 需显式申请。
    // web clientType 在 maker 侧走 lenient 分支,不校验完整 scope,故无需申请 docx/bitable 等数据 scope。
    feishuScope: process.env.MIVO_FEISHU_SCOPE ?? 'contact:user.email:readonly',
    oauthRedirectUri: process.env.MIVO_OAUTH_REDIRECT_URI ?? '',
    devAuthEnabled: process.env.MIVO_DEV_AUTH_ENABLED === '1',
    isProduction: isPublic || process.env.NODE_ENV === 'production',
    cookieSecure,
  }
}

// A-1 启动层 fail-closed 校验:返回非空错误信息 = 启动应 abort(index.ts 调 process.exit)。
// 纯函数(读传入 cfg/env),便于单测不引子进程。两类致命:
//   1. JWT_SECRET 配置非法(任何模式)—— 用户想开鉴权却配坏,静默 no-op = 把「配了但非法」
//      当「未配」放行,危险;必须 abort 让运维第一时间发现。
//   2. MIVO_PUBLIC=1 但既无 MIVO_BFF_TOKEN 又无有效 JWT_SECRET —— 公网裸奔,abort。
export const startupAuthError = (
  cfg: AuthConfig = getAuthConfig(),
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  if (cfg.jwtSecretMisconfigured) {
    return (
      '[mivo-bff] FATAL: JWT_SECRET is set but is not valid base64 / decodes to empty bytes. ' +
      'Refusing to start. Fix JWT_SECRET (base64, same value as maker JWT_SECRET) or unset it.'
    )
  }
  const bffToken = env.MIVO_BFF_TOKEN?.trim() ?? ''
  if (env.MIVO_PUBLIC === '1' && !bffToken && !cfg.jwtSecretBytes) {
    return (
      '[mivo-bff] FATAL: MIVO_PUBLIC=1 requires MIVO_BFF_TOKEN or JWT_SECRET to be set. ' +
      'Refusing to bind on 0.0.0.0 without an access gate.'
    )
  }
  return null
}
