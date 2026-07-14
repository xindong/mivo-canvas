// server/__tests__/e2eReset.endpoint.test.ts
// A2-S4 Block 5 F1: e2e reset 端点三重保险 6 路 + 真清空验证 + 纯函数。
// 驱动 fresh createE2eResetRoute(主 app.ts 是 module-level singleton,env 在加载时读,
// 无法动态重测;route builder 让测试构造 fresh app 验 6 路 env 挂载行为)。
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { createE2eResetRoute, isE2eResetEnabled } from '../routes/e2eReset'
import { InMemoryPersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend } from '../lib/permissions'

// 全满足挂载条件的 env(token + sentinel + 非 production + 非 public)。
const VALID_ENV: NodeJS.ProcessEnv = {
  MIVO_E2E_RESET_TOKEN: 'e2e-reset-token',
  MIVO_E2E_HARNESS: '1',
  NODE_ENV: 'test',
}

const buildApp = (env: NodeJS.ProcessEnv) => {
  const persist = new InMemoryPersistBackend()
  const permission = new InMemoryPermissionBackend()
  const app = new Hono<AppEnv>()
  app.route('/api/__e2e/reset', createE2eResetRoute({ persist, permission, env }))
  return { app, persist, permission }
}

const reset = async (app: Hono<AppEnv>, token = 'e2e-reset-token') =>
  app.request('/api/__e2e/reset', { method: 'POST', headers: { 'x-e2e-reset-token': token } })

describe('e2e reset endpoint (F1 三重保险挂载 + token 比对)', () => {
  it('valid token + 全满足 → 200 {ok:true}', async () => {
    const { app } = buildApp(VALID_ENV)
    const res = await reset(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('wrong token → 403 forbidden(挂载但 token 不匹配)', async () => {
    const { app } = buildApp(VALID_ENV)
    const res = await reset(app, 'wrong-token')
    expect(res.status).toBe(403)
  })

  it('缺 sentinel(MIVO_E2E_HARNESS 未设)→ 404 不挂载', async () => {
    const { app } = buildApp({ MIVO_E2E_RESET_TOKEN: 'e2e-reset-token', NODE_ENV: 'test' })
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('unset(MIVO_E2E_RESET_TOKEN 未设)→ 404 不挂载', async () => {
    const { app } = buildApp({ MIVO_E2E_HARNESS: '1', NODE_ENV: 'test' })
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('production(NODE_ENV=production)→ 404 双保险硬关', async () => {
    const { app } = buildApp({ MIVO_E2E_RESET_TOKEN: 'e2e-reset-token', MIVO_E2E_HARNESS: '1', NODE_ENV: 'production' })
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('MIVO_PUBLIC=1 → 404 public 部署绝不允许', async () => {
    const { app } = buildApp({ MIVO_E2E_RESET_TOKEN: 'e2e-reset-token', MIVO_E2E_HARNESS: '1', NODE_ENV: 'test', MIVO_PUBLIC: '1' })
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('reset 真清空 persist(塞 project → reset → list 空)', async () => {
    const { app, persist } = buildApp(VALID_ENV)
    await persist.ensureCreate('owner-a', 'project', 'p1', { name: 'smoke' }, { method: 'POST', resourceKind: 'project' })
    const before = await persist.listByOwner('owner-a', 'project')
    expect(before.records).toHaveLength(1)
    const res = await reset(app)
    expect(res.status).toBe(200)
    const after = await persist.listByOwner('owner-a', 'project')
    expect(after.records).toHaveLength(0)
  })

  it('无 x-e2e-reset-token header → 403(空 token 不匹配)', async () => {
    const { app } = buildApp(VALID_ENV)
    const res = await app.request('/api/__e2e/reset', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

describe('isE2eResetEnabled (纯函数三重保险)', () => {
  it('全满足 → true', () => {
    expect(isE2eResetEnabled(VALID_ENV)).toBe(true)
  })
  it('缺 token → false', () => {
    expect(isE2eResetEnabled({ MIVO_E2E_HARNESS: '1', NODE_ENV: 'test' })).toBe(false)
  })
  it('缺 sentinel → false', () => {
    expect(isE2eResetEnabled({ MIVO_E2E_RESET_TOKEN: 'x', NODE_ENV: 'test' })).toBe(false)
  })
  it('production → false', () => {
    expect(isE2eResetEnabled({ MIVO_E2E_RESET_TOKEN: 'x', MIVO_E2E_HARNESS: '1', NODE_ENV: 'production' })).toBe(false)
  })
  it('MIVO_PUBLIC=1 → false', () => {
    expect(isE2eResetEnabled({ MIVO_E2E_RESET_TOKEN: 'x', MIVO_E2E_HARNESS: '1', NODE_ENV: 'test', MIVO_PUBLIC: '1' })).toBe(false)
  })
})
