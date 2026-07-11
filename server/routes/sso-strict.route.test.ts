// server/routes/sso-strict.route.test.ts
// G2.1 (cutover §5) 严格 SSO —— 四边界路由级验收 + tasks/assets 走 SSO actor 证明。
//
// 开关 MIVO_SSO_STRICT=1(默认关,生产零变化):缺/错 secret·header → 401,不回退指纹。
// 四边界:①(进程内模拟)网关注入 ②伪造 header ③绕网关直连 ④dev mode;各写预期行为。
//
// F3 返修:① 原名"真实网关注入"误导——本用例是**进程内模拟**(client 带正确 secret+任意 username
// 即被当网关,服务端无法区分),非真实网关实测。真实网关四项集成验收清单见
// docs/runbook/g21-strict-sso-runbook.md §真实网关验收(待 lead 生产实测,翻 strict 硬前置)。
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
import {
  ssoAuthErrorHandler,
  isDevMode,
  validateSsoConfig,
  isLegacyFormOwner,
  assertStrictOwnerMigrationComplete,
} from '../lib/owner'
import type { PersistBackend } from '../persist/backend'
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

  it('① (进程内模拟)网关注入:严格模式 + 正确网关密钥 + SSO header → 200(actor = SSO user)——非真实网关实测,部署假设见 runbook §真实网关验收', async () => {
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

// ── G2.1 返修 F2:isDevMode 三重保险(纯函数,负向全补)──────────────────────────────
// F2 复现洞:原 isDevMode = `MIVO_DEV_MODE==='1' && NODE_ENV!=='production'` →
// strict+dev+MIVO_PUBLIC=1+NODE_ENV=staging → true → 任意 x-mivo-auth-user 冒充(200)。
// 修法:mirror auth-stub.ts:21-25 三重(opt-in + MIVO_PUBLIC=1 恒 false + NODE_ENV 正向枚举)。
describe('G2.1 返修 F2 — isDevMode 三重保险(纯函数,负向全补)', () => {
  it('opt-in 缺失(MIVO_DEV_MODE 未设)→ false(默认关)', () => {
    expect(isDevMode({ NODE_ENV: 'development' })).toBe(false)
    expect(isDevMode({ NODE_ENV: 'test' })).toBe(false)
    expect(isDevMode({ NODE_ENV: 'production' })).toBe(false)
  })

  it('MIVO_PUBLIC=1 + dev + 任意 NODE_ENV → false(public 恒关,堵 F2 冒充洞)', () => {
    // 原 bug:staging+dev+public → true(冒充)。三重保险后全 false。
    for (const nodeEnv of ['development', 'test', 'production', 'staging', 'qa', '', undefined]) {
      const env: NodeJS.ProcessEnv = { MIVO_DEV_MODE: '1', MIVO_PUBLIC: '1' }
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv
      expect(isDevMode(env)).toBe(false)
    }
  })

  it('production/staging/qa/空 NODE_ENV + dev(非 public)→ false(正向枚举仅 dev/test 放行)', () => {
    for (const nodeEnv of ['production', 'staging', 'qa', '', undefined]) {
      const env: NodeJS.ProcessEnv = { MIVO_DEV_MODE: '1' }
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv
      expect(isDevMode(env)).toBe(false)
    }
  })

  it('development/test + dev(非 public)→ true(唯一放行路径)', () => {
    expect(isDevMode({ MIVO_DEV_MODE: '1', NODE_ENV: 'development' })).toBe(true)
    expect(isDevMode({ MIVO_DEV_MODE: '1', NODE_ENV: 'test' })).toBe(true)
  })

  it('legacy 字面量验证:原 `NODE_ENV!==production` 在 staging 放行,新实现不放行', () => {
    // 旧实现:staging !== 'production' → true(漏洞)。新实现:staging ∉ {development,test} → false。
    expect(isDevMode({ MIVO_DEV_MODE: '1', NODE_ENV: 'staging' })).toBe(false)
  })
})

describe('G2.1 返修 F2 — validateSsoConfig 把 MIVO_PUBLIC=1 当生产边界告警', () => {
  it('public + dev mode → 告警(public 即生产边界;isDevMode 已恒 false)', () => {
    const w = validateSsoConfig({ MIVO_PUBLIC: '1', MIVO_DEV_MODE: '1', NODE_ENV: 'development' })
    expect(w.some((s) => s.includes('MIVO_DEV_MODE=1') && s.includes('production boundary'))).toBe(true)
  })

  it('非 public + 非 production NODE_ENV → 无告警(非生产边界,no-op)', () => {
    expect(validateSsoConfig({ NODE_ENV: 'development' })).toEqual([])
    expect(validateSsoConfig({ MIVO_DEV_MODE: '1', NODE_ENV: 'development' })).toEqual([])
  })

  it('public + strict + 无 gateway secret → fail-closed 告警', () => {
    const w = validateSsoConfig({ MIVO_PUBLIC: '1', MIVO_SSO_STRICT: '1' })
    expect(w.some((s) => s.includes('MIVO_SSO_STRICT=1') && s.includes('MIVO_GATEWAY_SECRET unset'))).toBe(true)
  })
})

// ── G2.1 返修 F2:isDevMode 双保险路由级负向(public+dev 不冒充)──────────────────────
describe('G2.1 返修 F2 — isDevMode 路由级负向(strict+dev 各绕过组合 → 401)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })
  afterEach(() => vi.unstubAllEnvs())

  it('strict + MIVO_PUBLIC=1 + dev + development + 无 proof → 401(public 恒关 dev)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_DEV_MODE', '1')
    vi.stubEnv('MIVO_PUBLIC', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(res.status).toBe(401) // isDevMode=false(public 恒关)→ 严格生产 → 无 proof → 401,不冒充
  })

  it('strict + dev + staging(非 public)→ 401(正向枚举不放行 staging)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_DEV_MODE', '1')
    vi.stubEnv('NODE_ENV', 'staging')
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(res.status).toBe(401) // isDevMode=false(staging 非枚举)→ 严格生产 → 401
  })

  it('strict + dev + 空 NODE_ENV(非 public)→ 401(正向枚举不放行空值)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_DEV_MODE', '1')
    vi.stubEnv('NODE_ENV', '')
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(res.status).toBe(401) // isDevMode=false(空值非枚举)→ 严格生产 → 401
  })

  it('strict + dev + production(非 public)→ 401(production 恒关 dev)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_DEV_MODE', '1')
    vi.stubEnv('NODE_ENV', 'production')
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(res.status).toBe(401)
  })
})

// ── G2.1 返修 F1:owner-migration 启动 gate(机器判定,非文字约定)──────────────────
describe('G2.1 返修 F1 — assertStrictOwnerMigrationComplete 启动 gate', () => {
  it('非 strict + legacy 数据 → no-op 通过(生产零变化)', async () => {
    const { backend } = buildPersistApp()
    await backend.ensureCreate('abcd1234ef567890', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    expect(isLegacyFormOwner('abcd1234ef567890')).toBe(true)
    expect(await backend.countLegacyFormOwners()).toBe(1)
    // 非 strict → gate no-op(不检测 legacy)
    await expect(assertStrictOwnerMigrationComplete({}, backend)).resolves.toBeUndefined()
  })

  it('strict + legacy 形态 owner 数据>0 → 拒启动(throws,报具体计数)', async () => {
    const { backend } = buildPersistApp()
    await backend.ensureCreate('abcd1234ef567890', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await backend.ensureCreate('0123456789abcdef', 'project', 'p2', {}, { method: 'POST', resourceKind: 'project' })
    expect(await backend.countLegacyFormOwners()).toBe(2)
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, backend)).rejects.toThrow(
      /legacy-form owner record/,
    )
  })

  it('strict + 迁移后(username 形态)→ 通过(模拟迁移:re-seed 为 username owner)', async () => {
    const { backend } = buildPersistApp()
    // 模拟 G2.2 迁移完成:数据以 username ownerId 落库(email-style,非 16-hex)
    await backend.ensureCreate('alice@xd.com', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    expect(isLegacyFormOwner('alice@xd.com')).toBe(false)
    expect(await backend.countLegacyFormOwners()).toBe(0)
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, backend)).resolves.toBeUndefined()
  })

  it('strict + backend 无 countLegacyFormOwners(PG G2.2 前未实现)→ fail-closed throws', async () => {
    // PG backend(G2.2 前)未实现 countLegacyFormOwners → strict 启动 fail-closed 拒启动(安全)。
    const stubBackend = { ready: Promise.resolve() } as unknown as PersistBackend
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, stubBackend)).rejects.toThrow(
      /countLegacyFormOwners/,
    )
  })

  it('strict + 混合(legacy + username)→ 拒启动(只要有 legacy 形态即 no-go)', async () => {
    const { backend } = buildPersistApp()
    await backend.ensureCreate('alice@xd.com', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await backend.ensureCreate('abcd1234ef567890', 'project', 'p2', {}, { method: 'POST', resourceKind: 'project' })
    expect(await backend.countLegacyFormOwners()).toBe(1)
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, backend)).rejects.toThrow(
      /legacy-form owner record/,
    )
  })
})

// ── G2.1 返修 F4:secret 恒时比较(SHA-256 + timingSafeEqual)────────────────────────
describe('G2.1 返修 F4 — ssoHeaderSecretOk 恒时比较(纯函数)', () => {
  // 间接经 resolveActor 验证:strict + 正确/错误/异长 secret 的 401/200 行为。
  let app: ReturnType<typeof buildPersistApp>['app']
  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })
  afterEach(() => vi.unstubAllEnvs())

  it('strict + 等长错 secret → 401(恒时,不泄漏)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW) // 'gw-secret-xyz'
    const res = await req(app, '/api/projects', {
      headers: { 'x-mivo-gateway-secret': 'gw-secret-aaa', 'x-mivo-auth-user': 'alice' }, // 等长 13 chars,错
    })
    expect(res.status).toBe(401)
  })

  it('strict + 异长错 secret → 401(SHA-256 digest 等长,无长度泄漏)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await req(app, '/api/projects', {
      headers: { 'x-mivo-gateway-secret': 'short', 'x-mivo-auth-user': 'alice' }, // 异长
    })
    expect(res.status).toBe(401)
  })

  it('strict + 正确 secret → 200(通过门)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await req(app, '/api/projects', {
      headers: { 'x-mivo-gateway-secret': GW, 'x-mivo-auth-user': 'alice' },
    })
    expect(res.status).toBe(200)
  })
})
