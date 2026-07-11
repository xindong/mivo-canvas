// server/routes/sso-strict.route.test.ts
// G2.1 (cutover §5) 严格 SSO —— 四边界路由级验收 + tasks/assets 走 SSO actor 证明。
//
// 开关 MIVO_SSO_STRICT=1(默认关,生产零变化):缺/错 secret·header → 401,不回退指纹。
// 四边界:①真实网关注入 ②伪造 header ③绕网关直连 ④dev mode;各写预期行为。
// + tasks/assets:严格模式下走 resolveTaskOwner/resolveAssetOwner → resolveActor,
//   缺 proof → 401(不回退指纹),证明"持久化路由全部走 SSO actor"。
//
// env 用 vi.stubEnv + afterEach(vi.unstubAllEnvs) 隔离;默认关时其他路由测试零影响。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import sharp from 'sharp'
import { buildPersistApp, req } from './persistTestApp'
import { app as realApp } from '../app'
import { __resetTaskRegistry } from '../tasks/registry'
import { createAssetRoutes } from './assets'
import { createMemoryAssetBackend } from '../lib/assetStore'
import { resetDecodeGate } from '../lib/decodeGate'
import { ssoAuthErrorHandler } from '../lib/owner'
import type { AppEnv } from '../lib/types'

const GW = 'gw-secret-xyz'
const UNKNOWN_TASK = '00000000-0000-0000-0000-000000000000'

// 最小 assets app(mirror app.ts:top-level onError + createAssetRoutes + memory backend)。
const buildAssetsApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.onError(ssoAuthErrorHandler)
  app.route('/api', createAssetRoutes({ backend: createMemoryAssetBackend() }))
  return app
}

describe('G2.1 严格 SSO —— 四边界(projects 路由,persistTestApp + ssoAuthBoundary)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('① 真实网关注入:严格模式 + 正确网关密钥 + SSO header → 200(actor = SSO user)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await req(app, '/api/projects', {
      headers: { 'x-mivo-gateway-secret': GW, 'x-mivo-auth-user': 'alice' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { projects: unknown[] }).projects).toEqual([])
  })

  it('② 伪造 header:client 带 x-mivo-auth-user 但无/错 x-mivo-gateway-secret → 401', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    // 无网关密钥 header(client 伪造 x-mivo-auth-user 冒充 victim)
    const noSecret = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'victim' } })
    expect(noSecret.status).toBe(401)
    expect((noSecret.body as { error: string }).error).toBe('unauthorized')
    // 错密钥
    const wrongSecret = await req(app, '/api/projects', {
      headers: { 'x-mivo-gateway-secret': 'wrong', 'x-mivo-auth-user': 'victim' },
    })
    expect(wrongSecret.status).toBe(401)
  })

  it('③ 绕网关直连:无 SSO proof → 401(即便未配 MIVO_GATEWAY_SECRET 也不回退指纹)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    // 场景 a:配了密钥但 client 直连 BFF(无任何 header)
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const direct = await req(app, '/api/projects', { headers: {} })
    expect(direct.status).toBe(401)
    // 场景 b:连密钥都没配(部署漏配)→ ssoHeaderSecretOk fail-closed → 401,不回退指纹
    vi.stubEnv('MIVO_GATEWAY_SECRET', '')
    const noConfig = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'attacker' } })
    expect(noConfig.status).toBe(401)
  })

  it('④ dev mode:严格模式 + MIVO_DEV_MODE=1,信任 x-mivo-auth-user 无需网关密钥 → 200', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_DEV_MODE', '1')
    vi.stubEnv('NODE_ENV', 'test') // 确保非 production(isDevMode 生效)
    // 带 header → actor = alice
    const withHeader = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(withHeader.status).toBe(200)
    // 无 header → 稳定 DEV_ACTOR_ID,仍 200(显式 dev mode,非 fallback)
    const noHeader = await req(app, '/api/projects', { headers: {} })
    expect(noHeader.status).toBe(200)
  })

  it('默认关(无 MIVO_SSO_STRICT)→ legacy 指纹 fallback;x-mivo-api-key 跨用户隔离不变', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '')
    const a = await req(app, '/api/projects', { headers: { 'x-mivo-api-key': 'mivo_aaa_user_a' } })
    expect(a.status).toBe(200)
    await req(app, '/api/projects', {
      method: 'POST',
      headers: { 'x-mivo-api-key': 'mivo_aaa_user_a' },
      body: JSON.stringify({ id: 'p1', name: 'P' }),
    })
    const bList = await req(app, '/api/projects', { headers: { 'x-mivo-api-key': 'mivo_bbb_user_b' } })
    expect((bList.body as { projects: unknown[] }).projects).toHaveLength(0)
  })
})

describe('G2.1 —— tasks 路由严格模式走 SSO actor(resolveTaskOwner)', () => {
  beforeEach(() => __resetTaskRegistry())
  afterEach(() => vi.unstubAllEnvs())

  it('严格模式 + 无 SSO proof → GET /api/mivo/tasks/:id 401(不回退指纹)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await realApp.request(`/api/mivo/tasks/${UNKNOWN_TASK}`, { headers: {} })
    expect(res.status).toBe(401)
  })

  it('严格模式 + 正确网关 → GET /api/mivo/tasks/:id 404(通过 SSO 门 → actor=alice → 无此 task)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await realApp.request(`/api/mivo/tasks/${UNKNOWN_TASK}`, {
      headers: { 'x-mivo-gateway-secret': GW, 'x-mivo-auth-user': 'alice' },
    })
    expect(res.status).toBe(404) // 通过 SSO 门(非 401)→ owner=alice → 无此 task → 404
  })
})

describe('G2.1 —— assets 路由严格模式走 SSO actor(resolveAssetOwner)', () => {
  let app: Hono<AppEnv>
  beforeEach(() => {
    app = buildAssetsApp()
    resetDecodeGate()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('严格模式 + 无 SSO proof → POST /api/assets 401(不回退指纹;在 decode 前)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await app.request('/api/assets', { method: 'POST', headers: {} })
    expect(res.status).toBe(401)
  })

  it('严格模式 + 正确网关 → POST /api/assets 200(通过 SSO 门 → actor=alice,真 PNG 落盘)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
    const res = await app.request('/api/assets', {
      method: 'POST',
      headers: { 'x-mivo-gateway-secret': GW, 'x-mivo-auth-user': 'alice' },
      body: form,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body as { assetId: string }).assetId).toBeTruthy()
  })
})
