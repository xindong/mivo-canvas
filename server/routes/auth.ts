// server/routes/auth.ts
// SSO 网关方案(feat/auth-sso):身份由 nginx 网关(auth.dsworks.cn)提供 /api/auth/me,
// app 不做 OAuth。本文件仅提供 **dev 桩** /api/auth/me:无网关时让本地 dev / e2e 进
// 已登录态,测"缺 key 自动弹面板"等已登录流程。
//
// 桩默认关(opt-in):MIVO_DEV_AUTH_STUB=1 && NODE_ENV !== 'production' && MIVO_PUBLIC !== '1'
// 才开(纯函数见 server/lib/auth-stub.ts,启动日志共用同一函数)。生产环境桩不生效
// (三重保险):
//   1. MIVO_DEV_AUTH_STUB 默认不设 → 关(防"生产忘设 NODE_ENV 就返假登录 dev@local");
//   2. NODE_ENV=production → 硬关(即便误设 stub=1 也仍关);
//   3. MIVO_PUBLIC=1 → 关(public 部署身份只由网关提供)。
// 走到本路由且桩关 = 无网关 misconfig → 返 401 {detail:"Not authenticated"}(对齐网关
// 未登录语义),前端按未登录处理。
//
// 网关契约(实测):
//   未登录:401 {"detail":"Not authenticated"}
//   已登录:200 {"authenticated":true,"username":"zhuzan@xd.com","display_name":"朱赞",
//               "is_admin":false,"services":[...,"mivo_canvas"]}
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { isDevStubActive } from '../lib/auth-stub'

export const authRoute = new Hono<AppEnv>()

// GET /api/auth/me — 生产由网关提供;dev 桩返假已登录用户(字段对齐网关契约)。
// 桩门控纯函数见 server/lib/auth-stub.ts(server/index.ts 启动日志共用)。
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
