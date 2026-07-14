// server/__tests__/e2eReset.endpoint.test.ts
// A2-S4 Block 5 F1-bis: e2e reset 端点全正向挂载(8 条全满足)+ PG 白名单下沉 route。
// 驱动 fresh createE2eResetRoute(主 app.ts 是 module-level singleton,env 在加载时读,
// 无法动态重测;route builder 让测试构造 fresh app 验 8 路负向 + 正向)。
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { createE2eResetRoute, isE2eResetEnabled } from '../routes/e2eReset'
import { InMemoryPersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend } from '../lib/permissions'

// 全白名单 env(8 条全满足):NODE_ENV=test + 非 public + token + sentinel + pg backend + loopback host
// + mivocanvas_e2e 库 + mivo_e2e 用户。MIVO_PUBLIC 未设(undefined !== '1' 满足)。
const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  MIVO_E2E_RESET_TOKEN: 'e2e-reset-token',
  MIVO_E2E_HARNESS: '1',
  MIVO_PERSIST_BACKEND: 'pg',
  MIVO_PG_HOST: '127.0.0.1',
  MIVO_PG_DB: 'mivocanvas_e2e',
  MIVO_PG_USER: 'mivo_e2e',
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

// 工具:克隆 VALID_ENV 并覆盖指定键(其余保留全白名单)。
const variant = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...VALID_ENV }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

describe('e2e reset endpoint (F1-bis 全正向挂载 + PG 白名单下沉 route)', () => {
  it('正向:全白名单 + valid token → 200 {ok:true}', async () => {
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

  it('无 x-e2e-reset-token header → 403(空 token 不匹配)', async () => {
    const { app } = buildApp(VALID_ENV)
    const res = await app.request('/api/__e2e/reset', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  // ── F1-bis 负向:8 条任一不满足 → 404 不挂载 ──
  it('NODE_ENV unset → 404(正向判定:只 test 放行)', async () => {
    const { app } = buildApp(variant({ NODE_ENV: undefined }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('NODE_ENV=staging → 404(正向:staging 不放行)', async () => {
    const { app } = buildApp(variant({ NODE_ENV: 'staging' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('NODE_ENV=production → 404(双保险硬关)', async () => {
    const { app } = buildApp(variant({ NODE_ENV: 'production' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('MIVO_PUBLIC=1 → 404(public 部署绝不允许)', async () => {
    const { app } = buildApp(variant({ MIVO_PUBLIC: '1' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('缺 sentinel(MIVO_E2E_HARNESS 未设)→ 404', async () => {
    const { app } = buildApp(variant({ MIVO_E2E_HARNESS: undefined }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('缺 token(MIVO_E2E_RESET_TOKEN 未设)→ 404', async () => {
    const { app } = buildApp(variant({ MIVO_E2E_RESET_TOKEN: undefined }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('MIVO_PERSIST_BACKEND=memory → 404(memory 档不挂 reset,重启即清)', async () => {
    const { app } = buildApp(variant({ MIVO_PERSIST_BACKEND: 'memory' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('MIVO_PERSIST_BACKEND unset → 404(非 pg 不挂)', async () => {
    const { app } = buildApp(variant({ MIVO_PERSIST_BACKEND: undefined }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('生产 DB 名 MIVO_PG_DB=mivocanvas → 404(防直连生产库)', async () => {
    const { app } = buildApp(variant({ MIVO_PG_DB: 'mivocanvas' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('生产 user 名 MIVO_PG_USER=mivo → 404(防直连生产库)', async () => {
    const { app } = buildApp(variant({ MIVO_PG_USER: 'mivo' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('非 loopback host MIVO_PG_HOST=10.0.0.5 → 404(防连远程 PG)', async () => {
    const { app } = buildApp(variant({ MIVO_PG_HOST: '10.0.0.5' }))
    const res = await reset(app)
    expect(res.status).toBe(404)
  })

  it('MIVO_PG_HOST unset → 404(未设 host 不挂,防误连)', async () => {
    const { app } = buildApp(variant({ MIVO_PG_HOST: undefined }))
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
})

describe('isE2eResetEnabled (纯函数全正向 + PG 白名单)', () => {
  it('全白名单 → true', () => {
    expect(isE2eResetEnabled(VALID_ENV)).toBe(true)
  })
  it('NODE_ENV unset → false', () => {
    expect(isE2eResetEnabled(variant({ NODE_ENV: undefined }))).toBe(false)
  })
  it('NODE_ENV=staging → false', () => {
    expect(isE2eResetEnabled(variant({ NODE_ENV: 'staging' }))).toBe(false)
  })
  it('NODE_ENV=production → false', () => {
    expect(isE2eResetEnabled(variant({ NODE_ENV: 'production' }))).toBe(false)
  })
  it('MIVO_PUBLIC=1 → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_PUBLIC: '1' }))).toBe(false)
  })
  it('缺 token → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_E2E_RESET_TOKEN: undefined }))).toBe(false)
  })
  it('缺 sentinel → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_E2E_HARNESS: undefined }))).toBe(false)
  })
  it('MIVO_PERSIST_BACKEND=memory → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_PERSIST_BACKEND: 'memory' }))).toBe(false)
  })
  it('生产 DB 名 → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_PG_DB: 'mivocanvas' }))).toBe(false)
  })
  it('生产 user 名 → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_PG_USER: 'mivo' }))).toBe(false)
  })
  it('非 loopback host → false', () => {
    expect(isE2eResetEnabled(variant({ MIVO_PG_HOST: '10.0.0.5' }))).toBe(false)
  })
})
