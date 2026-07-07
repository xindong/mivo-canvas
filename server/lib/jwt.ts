// server/lib/jwt.ts
// feat/auth-feishu-login (E1 · 鉴权骨干)
//
// A2: MivoCanvas BFF 不签 JWT(maker server 签发),只验签。用与 maker 共享的
// JWT_SECRET(base64 → Uint8Array,口径对齐 maker config.ts:99-108 与 lib/jwt.ts)
// 校验 maker 颁发的 HS256 access token,取出 { sub(=userId), device }。
//
// 失败(签名错 / 过期 / 结构坏 / 缺字段)一律返回 null —— 调用方(gate / /api/auth/me)
// 统一按「未登录」处理(401),无需区分 expired vs invalid:对用户语义相同(重新登录)。
import { jwtVerify } from 'jose'

export type AccessTokenPayload = {
  // maker signAccessToken({ sub: userId, device: deviceId }) → JWT sub/device claims
  sub: string
  device: string
  // exp(unix 秒);用来给 cookie maxAge 对齐 JWT 实际过期(而非固定 1h)。
  exp?: number
}

export const verifyAccessToken = async (
  token: string,
  secretBytes: Uint8Array,
): Promise<AccessTokenPayload | null> => {
  try {
    const { payload } = await jwtVerify(token, secretBytes, { algorithms: ['HS256'] })
    const sub = typeof payload.sub === 'string' ? payload.sub : ''
    const device = typeof payload.device === 'string' ? payload.device : ''
    if (!sub) return null
    return {
      sub,
      device,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    }
  } catch {
    return null
  }
}
