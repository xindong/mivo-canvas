// @vitest-environment node
// server/__tests__/auth.test.ts
// SSO 网关方案(feat/auth-sso):BFF 只提供 dev 桩 /api/auth/me(生产 /me 由网关提供)。
// 测 dev 桩门控:dev 默认开 / 生产(NODE_ENV=production)硬关 / MIVO_DEV_AUTH_STUB=0 显式关。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const savedEnv: Record<string, string | undefined> = {
  NODE_ENV: process.env.NODE_ENV,
  MIVO_DEV_AUTH_STUB: process.env.MIVO_DEV_AUTH_STUB,
}

const loadFreshApp = async () => {
  vi.resetModules()
  return (await import('../app')).app
}

const restoreEnv = () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe('SSO dev stub /api/auth/me', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.NODE_ENV
    delete process.env.MIVO_DEV_AUTH_STUB
  })
  afterEach(() => {
    restoreEnv()
    vi.resetModules()
  })

  it('dev (NODE_ENV unset) → 200 fake logged-in user (gateway contract shape)', async () => {
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      authenticated: true,
      username: 'dev@local',
      display_name: '朱赞（本地）',
      is_admin: false,
      services: ['mivo_canvas'],
      avatar_url: null,
    })
  })

  it('MIVO_DEV_AUTH_STUB=1 (dev) → 200', async () => {
    process.env.MIVO_DEV_AUTH_STUB = '1'
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authenticated?: boolean }
    expect(body.authenticated).toBe(true)
  })

  it('MIVO_DEV_AUTH_STUB=0 → 401 {detail:"Not authenticated"}', async () => {
    process.env.MIVO_DEV_AUTH_STUB = '0'
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ detail: 'Not authenticated' })
  })

  it('NODE_ENV=production → 401 even with MIVO_DEV_AUTH_STUB=1 (A-3 production double-lock)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MIVO_DEV_AUTH_STUB = '1'
    const app = await loadFreshApp()
    const res = await app.request('/api/auth/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ detail: 'Not authenticated' })
  })
})
