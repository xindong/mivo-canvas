// server/routes/e2eReset.ts
// A2-S4 Block 5 F1: e2e persist harness reset 端点(test-only,三重保险 fail-closed)。
//
// mirror server/lib/auth-stub.ts:21-25 三重保险模式(isDevStubActive):
//  1. MIVO_E2E_RESET_TOKEN 设置(非空)——显式 opt-in;
//  2. MIVO_E2E_HARNESS==='1'——专用 sentinel(harness 显式注入;防生产误设 token 就挂载);
//  3. NODE_ENV!=='production'——双保险(即便误设 sentinel+token,生产仍硬关);
//  4. MIVO_PUBLIC!=='1'——public 部署绝不允许 reset(身份只由网关提供,reset 危险)。
// 任一不满足 → 端点不挂载(404 stub,防 SPA fallback)。
//
// 抽纯函数 isE2eResetEnabled + route builder createE2eResetRoute,供测试 6 路 env 驱动 fresh app
// (主 app.ts 是 module-level singleton,env 在加载时读,无法动态重测;route builder 让测试构造 fresh app)。
// 调 sharedPersistBackend.__reset() + sharedPermissionBackend.__reset() 清 owner-scoped 数据
// (memory 同步 void;PG TRUNCATE persist_records + 权限表)。test-only,生产绝不挂载。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import type { PersistBackend } from '../persist/backend'
import type { PermissionBackend } from '../lib/permissions'

/**
 * F1 三重保险挂载条件(mirror auth-stub.ts isDevStubActive)。任一不满足 → 不挂载(404 stub)。
 * 抽纯函数:测试可驱动 6 路 env(unset / production / MIVO_PUBLIC=1 / 缺 sentinel / wrong-token / valid-token)
 * 构造 fresh app 验挂载行为,无需重载主 app singleton。
 */
export const isE2eResetEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.MIVO_E2E_RESET_TOKEN)
  && env.MIVO_E2E_HARNESS === '1'
  && env.NODE_ENV !== 'production'
  && env.MIVO_PUBLIC !== '1'

/**
 * F1 构建 e2e reset route(env-gated;不满足挂载条件 → 404 stub sub-app)。
 * app.ts: `app.route('/api/__e2e/reset', createE2eResetRoute({ persist, permission, env: process.env }))`。
 * 请求须带 x-e2e-reset-token header 匹配 MIVO_E2E_RESET_TOKEN(恒时比较防长度泄漏)。
 */
export const createE2eResetRoute = ({
  persist,
  permission,
  env = process.env,
}: {
  persist: PersistBackend
  permission: PermissionBackend
  env?: NodeJS.ProcessEnv
}): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()
  if (!isE2eResetEnabled(env)) {
    // 不挂载 → 404(防 SPA fallback;mirror asset/sse-probe disabled stub)。
    route.all('/', (c: Context<AppEnv>) => c.notFound())
    return route
  }
  const expectedToken = env.MIVO_E2E_RESET_TOKEN as string
  route.post('/', async (c) => {
    const token = c.req.header('x-e2e-reset-token') ?? ''
    // 恒时比较:两侧先 SHA-256 digest(均固定 32 字节,消除长度泄漏与早返回),再 timingSafeEqual。
    // 与 owner.ts ssoHeaderSecretOk 同策略;test-only token 仍走恒时比较防习惯性短路径。
    const expectedDigest = createHash('sha256').update(expectedToken).digest()
    const gotDigest = createHash('sha256').update(token).digest()
    if (!timingSafeEqual(expectedDigest, gotDigest)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await Promise.all([
      persist.__reset(),
      permission.__reset(),
    ])
    return c.json({ ok: true })
  })
  return route
}
