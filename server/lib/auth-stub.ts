// server/lib/auth-stub.ts
// SSO 网关方案(feat/auth-sso):身份由 nginx 网关(auth.dsworks.cn)提供 /api/auth/me,
// BFF 不做 OAuth。本模块仅提供 **dev 桩** /api/auth/me 的门控纯函数:无网关时让本地
// dev / e2e 进已登录态,测"缺 key 自动弹面板"等已登录流程。
//
// 桩默认关 —— 必须显式 opt-in(MIVO_DEV_AUTH_STUB=1)且非生产且非 public 才开:
//   1. MIVO_DEV_AUTH_STUB !== '1' → 关(默认关,防"生产忘设 NODE_ENV 就返假登录 dev@local");
//   2. NODE_ENV === 'production' → 硬关(双保险,即便误设 stub=1 也仍关);
//   3. MIVO_PUBLIC === '1' → 关(public 部署绝不允许 dev 桩,身份只由网关提供)。
// 启动日志(server/index.ts)与 /api/auth/me 路由走同一纯函数,日志输出真实桩状态(P1-b)。
//
// 网关契约(实测):
//   未登录:401 {"detail":"Not authenticated"}
//   已登录:200 {"authenticated":true,"username":"...","display_name":"...","is_admin":false,
//               "services":[...,"mivo_canvas"]}

/**
 * dev 桩门控纯函数。读取 env 判断 /api/auth/me dev 桩是否生效。
 * 默认关(opt-in);MIVO_DEV_AUTH_STUB=1 且非 production 且非 public 才开。
 */
export const isDevStubActive = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (env.MIVO_DEV_AUTH_STUB !== '1') return false
  if (env.NODE_ENV === 'production') return false
  if (env.MIVO_PUBLIC === '1') return false
  return true
}
