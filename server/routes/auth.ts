// server/routes/auth.ts
// SSO 网关方案(feat/auth-sso):身份由 nginx 网关(auth.dsworks.cn)提供 /api/auth/me,
// app 不做 OAuth。本文件仅提供 **dev 桩** /api/auth/me:无网关时让本地 dev / e2e 进
// 已登录态,测"缺 key 自动弹面板"等已登录流程。
//
// 生产环境桩不生效(双保险,参考 A-3 思路):
//   1. NODE_ENV=production → 硬关(即便误设 MIVO_DEV_AUTH_STUB=1 也仍关,NODE_ENV 优先);
//   2. 生产由网关盖过 /api/auth/me(nginx 拦截),本路由根本走不到。
// 走到本路由且桩关 = 无网关 misconfig → 返 401 {detail:"Not authenticated"}(对齐网关
// 未登录语义),前端按未登录处理。
//
// 网关契约(实测):
//   未登录:401 {"detail":"Not authenticated"}
//   已登录:200 {"authenticated":true,"username":"zhuzan@xd.com","display_name":"朱赞",
//               "is_admin":false,"services":[...,"mivo_canvas"]}
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'

export const authRoute = new Hono<AppEnv>()

// dev 桩门控:生产(NODE_ENV=production)硬关;dev/test 默认开,可 MIVO_DEV_AUTH_STUB=0 显式关。
const isDevStubActive = (): boolean => {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.MIVO_DEV_AUTH_STUB === '0') return false
  return true
}

// GET /api/auth/me — 生产由网关提供;dev 桩返假已登录用户(字段对齐网关契约)。
authRoute.get('/me', (c) => {
  if (!isDevStubActive()) {
    return c.json({ detail: 'Not authenticated' }, 401)
  }
  return c.json({
    authenticated: true,
    username: 'dev@local',
    display_name: '朱赞（本地）',
    is_admin: false,
    services: ['mivo_canvas'],
    // 预留:同事将来给 /me 加 avatar_url 时前端自动用 <img>;留 null 测首字母兜底。
    avatar_url: null,
  })
})
