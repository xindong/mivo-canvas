// server/routes/e2eReset.ts
// A2-S4 Block 5 F1-bis: e2e persist harness reset 端点(test-only,全正向 8 条挂载 + PG 白名单下沉 route)。
//
// F1-bis 收口(上一轮 F1 的 NODE_ENV!=='production' 负向判定 + PG 白名单只在 harness 的绕过路径):
//  全正向判定(8 条全满足才挂载,任一不满足 → 404 stub),见 isE2eResetEnabled:
//  1. NODE_ENV === 'test'(正向:只 test 放行;unset/staging/production 一律关)
//  2. MIVO_PUBLIC !== '1'(public 部署绝不允许)
//  3. MIVO_E2E_RESET_TOKEN 非空(显式 opt-in)
//  4. MIVO_E2E_HARNESS === '1'(sentinel,harness 显式注入;非 secret,故需 PG 白名单补)
//  5. MIVO_PERSIST_BACKEND === 'pg'(memory 档 e2e 不挂 reset——重启即清,不受影响)
//  6. MIVO_PG_HOST 为 127.0.0.1/localhost(防连生产远程 PG)
//  7. MIVO_PG_DB === 'mivocanvas_e2e'(与生产名 mivocanvas 硬区隔)
//  8. MIVO_PG_USER === 'mivo_e2e'(与生产名 mivo 硬区隔)
// PG 白名单下沉进 route(不只 harness):防 npm run start:server 设 token+sentinel 直跑生产库
// (生产 MIVO_PG_DB=mivocanvas ≠ mivocanvas_e2e → 校验失败 → 不挂载)。
//
// 抽纯函数 isE2eResetEnabled + route builder createE2eResetRoute,供测试驱动 fresh app 验 8 路负向 + 正向
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
 * F1-bis 全正向挂载条件(8 条全部满足才挂载,任一不满足 → 404 stub)。
 * 上一轮 F1 的 NODE_ENV!=='production' 是负向判定(unset/staging 放行)+ PG 白名单只在 harness
 * (npm run start:server 设 token+sentinel 即可对生产库挂载 reset)——本轮收口:
 *  1. NODE_ENV === 'test'(正向:只 test 放行;unset/staging/production 一律关,mirror auth-stub 负向漏洞)
 *  2. MIVO_PUBLIC !== '1'(public 部署绝不允许)
 *  3. MIVO_E2E_RESET_TOKEN 非空(显式 opt-in)
 *  4. MIVO_E2E_HARNESS === '1'(sentinel,harness 显式注入;非 secret,故需 PG 白名单补)
 *  5. MIVO_PERSIST_BACKEND === 'pg'(memory 档 e2e 不挂 reset——重启即清,不受影响)
 *  6. MIVO_PG_HOST 为 127.0.0.1/localhost(防连生产远程 PG)
 *  7. MIVO_PG_DB === 'mivocanvas_e2e'(与生产名 mivocanvas 硬区隔)
 *  8. MIVO_PG_USER === 'mivo_e2e'(与生产名 mivo 硬区隔)
 * PG 白名单下沉进 route(不只 harness):防 npm run start:server 设 token+sentinel 直跑生产库
 * (生产 MIVO_PG_DB=mivocanvas ≠ mivocanvas_e2e → 校验失败 → 不挂载)。
 * 抽纯函数:测试驱动 fresh app 验 8 路负向 + 正向,无需重载主 app singleton。
 */
export const isE2eResetEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (env.NODE_ENV !== 'test') return false
  if (env.MIVO_PUBLIC === '1') return false
  if (!env.MIVO_E2E_RESET_TOKEN) return false
  if (env.MIVO_E2E_HARNESS !== '1') return false
  if (env.MIVO_PERSIST_BACKEND !== 'pg') return false
  const host = env.MIVO_PG_HOST ?? ''
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  if (env.MIVO_PG_DB !== 'mivocanvas_e2e') return false
  if (env.MIVO_PG_USER !== 'mivo_e2e') return false
  return true
}

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
