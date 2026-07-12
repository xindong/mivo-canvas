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
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assertStrictOwnerMigrationComplete,
  legacyOwnerDetector,
  buildStartupDetectors,
  migrateLegacyOwnersToUsernameForm,
  isLegacyFormOwner,
  type LegacyOwnerDetector,
} from '../lib/owner'
import type { PersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend } from '../lib/permissions'
import {
  createAssetStore,
  createFsAssetBackend,
  type AssetStore,
} from '../lib/assetStore'
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

// ── G2.1 R2-1:owner-migration 启动 gate 三域化(persist + permissions + assets)──────────────
// R2-1(P1):返修前 gate 只收 PersistBackend → persist=0 但 permission/asset 全 legacy 时放行
// (share_links.created_by + AssetRecord.ownerFp/references/uploaders 漏检)。G2.2 若只补 PG persist
// detector 即可绕过其余两域。修法:gate 收三 detector,任一缺失 fail-closed,任一 legacy>0 拒启动。
// InMemory persist/permissions/assets detector 可测;PG 标注随 G2.2。
describe('G2.1 R2-1 — assertStrictOwnerMigrationComplete 三域 gate(persist + permissions + assets)', () => {
  // 三 detector 全用 memory backend(可测);asset store 经 createAssetStore(createMemoryAssetBackend())。
  const buildDetectors = (): {
    persist: PersistBackend
    permissions: InMemoryPermissionBackend
    assets: AssetStore
    detectors: LegacyOwnerDetector[]
  } => {
    const { backend, permissions } = buildPersistApp()
    const assets = createAssetStore(createMemoryAssetBackend())
    return {
      persist: backend,
      permissions,
      assets,
      detectors: [
        legacyOwnerDetector('persist', backend),
        legacyOwnerDetector('permissions', permissions),
        legacyOwnerDetector('assets', assets),
      ],
    }
  }

  it('非 strict + 三域全 legacy → no-op 通过(生产零变化,gate 不检测)', async () => {
    const { persist, permissions, assets, detectors } = buildDetectors()
    await persist.ensureCreate('abcd1234ef567890', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await permissions.createShareLink('px', 'view', '0123456789abcdef')
    await assets.upload(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png', 'fedcba9876543210')
    expect(await persist.countLegacyFormOwners!()).toBe(1)
    expect(await permissions.countLegacyFormOwners!()).toBe(1)
    expect(await assets.countLegacyFormOwners!()).toBe(1)
    await expect(assertStrictOwnerMigrationComplete({}, detectors)).resolves.toBeUndefined()
  })

  it('strict + persist legacy>0 → 拒启动(报具体计数 + 域名)', async () => {
    const { persist, detectors } = buildDetectors()
    await persist.ensureCreate('abcd1234ef567890', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await persist.ensureCreate('0123456789abcdef', 'project', 'p2', {}, { method: 'POST', resourceKind: 'project' })
    expect(await persist.countLegacyFormOwners!()).toBe(2)
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/persist.*legacy-form owner record/s)
  })

  // R2-1 负例组 ①:persist=0 但 permissions(share_links.created_by)有 legacy → 拒启动(返修前放行)
  it('strict + persist=0 + permissions legacy(share_links.created_by 指纹)>0 → 拒启动(R2-1 漏检洞)', async () => {
    const { persist, permissions, detectors } = buildDetectors()
    // persist 已迁移(username 形态),permissions 未迁移(createdBy=指纹)
    await persist.ensureCreate('alice@xd.com', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await permissions.createShareLink('p1', 'view', 'abcd1234ef567890') // createdBy = legacy 指纹
    expect(await persist.countLegacyFormOwners!()).toBe(0)
    expect(await permissions.countLegacyFormOwners!()).toBe(1)
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/permissions.*legacy-form owner record/s)
  })

  // R2-1 负例组 ②:persist=0 但 assets(AssetRecord.ownerFp)有 legacy → 拒启动(返修前放行)
  it('strict + persist=0 + assets legacy(AssetRecord.ownerFp 指纹)>0 → 拒启动(R2-1 漏检洞)', async () => {
    const { persist, assets, detectors } = buildDetectors()
    await persist.ensureCreate('alice@xd.com', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await assets.upload(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png', 'abcd1234ef567890') // ownerFp = 指纹
    expect(await persist.countLegacyFormOwners!()).toBe(0)
    expect(await assets.countLegacyFormOwners!()).toBe(1)
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/assets.*legacy-form owner record/s)
  })

  it('strict + 三域全迁移(username 形态)→ 通过', async () => {
    const { persist, permissions, assets, detectors } = buildDetectors()
    await persist.ensureCreate('alice@xd.com', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await permissions.createShareLink('p1', 'view', 'alice@xd.com') // createdBy = username
    await assets.upload(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png', 'alice@xd.com') // ownerFp = username
    expect(await persist.countLegacyFormOwners!()).toBe(0)
    expect(await permissions.countLegacyFormOwners!()).toBe(0)
    expect(await assets.countLegacyFormOwners!()).toBe(0)
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).resolves.toBeUndefined()
  })

  // R2-1 负例组 ③:任一 detector 缺失(PG G2.2 前未实现 countLegacyFormOwners)→ fail-closed 拒启动
  it('strict + persist detector 缺失(PG stub 无 countLegacyFormOwners)→ fail-closed throws', async () => {
    const stubPersist = { ready: Promise.resolve() } as unknown as PersistBackend
    const { permissions, assets } = buildDetectors()
    const detectors = [
      legacyOwnerDetector('persist', stubPersist), // 无 countLegacyFormOwners
      legacyOwnerDetector('permissions', permissions),
      legacyOwnerDetector('assets', assets),
    ]
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/persist.*countLegacyFormOwners/s)
  })

  it('strict + permissions detector 缺失 → fail-closed throws(任一缺失即拒)', async () => {
    const { persist, assets } = buildDetectors()
    const stubPermissions = { ready: Promise.resolve() } as unknown as InMemoryPermissionBackend
    const detectors = [
      legacyOwnerDetector('persist', persist),
      legacyOwnerDetector('permissions', stubPermissions), // 无 countLegacyFormOwners
      legacyOwnerDetector('assets', assets),
    ]
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/permissions.*countLegacyFormOwners/s)
  })

  it('strict + assets detector 缺失 → fail-closed throws(任一缺失即拒)', async () => {
    const { persist, permissions } = buildDetectors()
    const stubAssets = { upload: () => Promise.resolve() } as unknown as AssetStore
    const detectors = [
      legacyOwnerDetector('persist', persist),
      legacyOwnerDetector('permissions', permissions),
      legacyOwnerDetector('assets', stubAssets), // 无 countLegacyFormOwners
    ]
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/assets.*countLegacyFormOwners/s)
  })

  it('strict + 混合(persist legacy + username)→ 拒启动(只要有 legacy 形态即 no-go)', async () => {
    const { persist, detectors } = buildDetectors()
    await persist.ensureCreate('alice@xd.com', 'project', 'p1', {}, { method: 'POST', resourceKind: 'project' })
    await persist.ensureCreate('abcd1234ef567890', 'project', 'p2', {}, { method: 'POST', resourceKind: 'project' })
    expect(await persist.countLegacyFormOwners!()).toBe(1)
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/persist.*legacy-form owner record/s)
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

// ── G2.1 R2-2:strict proof 前置中间件(body 解析/DB lookup 前统一验 proof)──────────────────
// R2-2(P1):返修前 projects POST 先 readJsonBodyWithFingerprint(非法 body=400)、tasks POST 先
// parseMultipartBody、GET /:id 先 getProjectOwner(已存=401/未知=404 存在性 oracle)再 resolveActor。
// 修法:ssoStrictProofGate 中间件,strict + 无 share token → proof 前置(token-scoped/dev 豁免,legacy no-op)。
// 验收:strict 无 proof 下 known/missing/invalid/oversized body/各 task POST 一律 401,且断言 parser/backend
// 未被调用(spy/计数);route matrix 覆盖标注修正。
describe('G2.1 R2-2 — ssoStrictProofGate 前置 proof(body 解析/DB lookup 前,存在性 oracle 消除)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let backend: ReturnType<typeof buildPersistApp>['backend']
  beforeEach(() => {
    ;({ app, backend } = buildPersistApp())
  })
  afterEach(() => vi.unstubAllEnvs())

  it('strict + 无 proof + POST /api/projects 非法 JSON body → 401(非 400;body 未解析)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    // 非法 JSON body:若 body 先解析则 400 bad-body;前置 proof 后 401(body 不被读)
    const res = await req(app, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this-is-not-json',
    })
    expect(res.status).toBe(401)
    expect((res.body as { error: string }).error).toBe('unauthorized')
  })

  it('strict + 无 proof + POST /api/projects 超 1MB body → 401(非 413;body cap 未触达)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    // 超大 body:若 body 先读则 413;前置 proof 后 401(body 不被读/不触 cap)
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const res = await req(app, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    })
    expect(res.status).toBe(401)
  })

  it('strict + 无 proof + GET /api/projects/:id(known,非 strict seed)→ 401 + backend.getProjectOwner 未调用', async () => {
    // 先非 strict seed(legacy 路径,project 落指纹 owner);再翻 strict GET:
    // 前置 proof → 401 在 getProjectOwner 前(返修前会先查 owner 再 resolveActor 抛 401;现 DB lookup 跳过)
    await req(app, '/api/projects', {
      method: 'POST',
      headers: { 'x-mivo-api-key': 'mivo_aaa_user_a' },
      body: JSON.stringify({ id: 'p-known', name: 'P' }),
    })
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const spy = vi.spyOn(backend, 'getProjectOwner')
    const res = await req(app, '/api/projects/p-known', { headers: {} })
    expect(res.status).toBe(401) // 前置 proof → 401(非 200/404;DB lookup 未触达)
    expect(spy).not.toHaveBeenCalled() // 返修前会调用 getProjectOwner(authzProject 先查 owner)
  })

  it('strict + 无 proof + GET /api/projects/:id(missing)→ 401(非 404;存在性 oracle 消除)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    // missing project:返修前 getProjectOwner 缺失 → 404(泄漏"不存在");前置 proof 后 401(known/missing 一律 401)
    const res = await req(app, '/api/projects/never-existed', { headers: {} })
    expect(res.status).toBe(401)
    expect((res.body as { error: string }).error).toBe('unauthorized')
  })

  it('strict + 无 proof + GET /api/projects/:id → backend.getProjectOwner 未被调用(spy 证 DB lookup 跳过)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const spy = vi.spyOn(backend, 'getProjectOwner')
    await req(app, '/api/projects/any-id', { headers: {} })
    expect(spy).not.toHaveBeenCalled() // 前置 proof → 401 在 DB lookup 前;返修前会调用
  })

  it('strict + 无 proof + GET /api/canvas/:id(missing)→ 401(非 404;canvas 存在性 oracle 消除)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await req(app, '/api/canvas/never-existed', { headers: {} })
    expect(res.status).toBe(401)
  })

  it('strict + 无 proof + GET /api/canvas/:id → backend.getCanvasOwner 未被调用(spy)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const spy = vi.spyOn(backend, 'getCanvasOwner')
    await req(app, '/api/canvas/any-id', { headers: {} })
    expect(spy).not.toHaveBeenCalled()
  })

  // token-scoped 豁免:share token 在 → 不 401(route authz 验 token,公开分享访问)
  it('strict + 无 proof + share token 在 → 非 401(token-scoped 豁免;route authz 验 token → 404 unknown)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await req(app, '/api/projects/some-id', {
      headers: { 'x-mivo-share-token': 'fake-token' },
    })
    expect(res.status).not.toBe(401) // 豁免 → 走 route authz → unknown token → 404 unknown-project
    expect(res.status).toBe(404)
  })

  // dev mode 豁免:strict + dev → 信任 header 无需 proof
  it('strict + dev mode + 无 proof → 200(非 401;dev 豁免,信任 x-mivo-auth-user)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_DEV_MODE', '1')
    vi.stubEnv('NODE_ENV', 'test')
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(res.status).toBe(200) // dev 豁免 → 走 route → resolveActor dev actor → 200 list empty
  })

  // legacy 零变化硬约束:非 strict + 无 proof + 非法 body → 400(body 解析,中间件 no-op)
  it('legacy(非 strict)+ 无 proof + 非法 body → 400(body 先解析;中间件 no-op,零变化)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '')
    const res = await req(app, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mivo-api-key': 'mivo_aaa_user_a' },
      body: 'not-json',
    })
    expect(res.status).toBe(400) // body 解析 → bad-body 400(非 401;中间件 no-op,legacy 行为不变)
  })
})

// ── G2.1 R2-2:tasks 路由 proof 前置(realApp,multipart/JSON body 在 401 前不解析)──────────────
describe('G2.1 R2-2 — tasks 路由 strict proof 前置(realApp,各 task POST 一律 401,body 不解析)', () => {
  beforeEach(() => __resetTaskRegistry())
  afterEach(() => vi.unstubAllEnvs())

  it('strict + 无 proof + POST /api/mivo/tasks/generate 非法 JSON body → 401(非 400;parser 未调用)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await realApp.request('/api/mivo/tasks/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(401) // 前置 proof → 401;返修前 readJsonBody 先解析 → 400
  })

  it('strict + 无 proof + GET /api/mivo/tasks/:id → 401(非 404;task 存在性 oracle 消除)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    const res = await realApp.request('/api/mivo/tasks/00000000-0000-0000-0000-000000000000', {
      headers: {},
    })
    expect(res.status).toBe(401) // 返修前 resolveTaskOwner 先于 getTaskForOwner → 401,但经 multipart/JSON 先;现前置
  })

  it('strict + 无 proof + POST /api/mivo/tasks/edit multipart → 401(multipart parser 未调用)', async () => {
    vi.stubEnv('MIVO_SSO_STRICT', '1')
    vi.stubEnv('MIVO_GATEWAY_SECRET', GW)
    // multipart body:若先解析则进 parseMultipartBody;前置 proof 后 401(body 不解析)
    const form = new FormData()
    form.append('prompt', 'p')
    const res = await realApp.request('/api/mivo/tasks/edit', {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(401)
  })
})

// ── G2.1 R3-F1:service-off 时三域 gate 真实 fs detector(不伪造 0)──────────────────────────────────
// R3-F1(P1)复现:asset service 关闭(MIVO_ENABLE_ASSET_SERVICE=0)时 index.ts 注入 countLegacyFormOwners:()=>0
// 的占位 detector。资产目录是持久目录;过去启用后再关闭/cutover 关闭/稍后重开都可能仍有 legacy ownerFp。
// persist=0、permission=0、磁盘 asset>0 时 strict 可启动(占位 0 跨域绕过)→ 正是 R2-1 要堵的洞。
// 修法:startup gate 始终按配置资产根(resolveAssetStoreDir)构造只读 fs detector,route 是否 mount 与
// 是否扫描数据解耦;目录缺失(ENOENT)→ 0(合法空);其他 fs 错 → 抛 → fail-closed;磁盘有 legacy → 拒启动。
describe('G2.1 R3-F1 — service-off + 配置根预置 legacy asset → strict 启动拒绝(返修前 fake-0 放行)', () => {
  let tmpAssetDir: string
  beforeEach(() => {
    tmpAssetDir = mkdtempSync(join(tmpdir(), 'mivo-g21-f1-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpAssetDir, { recursive: true, force: true })
  })

  it('strict + service off(assetStore=null)+ 配置根预置 legacy AssetRecord.ownerFp → 拒启动(RED:返修前 fake-0 放行)', async () => {
    // 把配置资产根指向 tmp 目录,并预置一条 legacy asset(ownerFp=16-hex 指纹)
    vi.stubEnv('MIVO_ASSET_STORE_DIR', tmpAssetDir)
    const fsStore = createAssetStore(createFsAssetBackend(tmpAssetDir))
    await fsStore.upload(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png', 'abcd1234ef567890')
    expect(await fsStore.countLegacyFormOwners!()).toBe(1) // 磁盘上确有 legacy

    // persist + permissions 干净(0 legacy);service off → assetStore=null(镜像 index.ts 返修前 wiring)
    const { backend: persist, permissions } = buildPersistApp()
    const detectors = buildStartupDetectors({ persist, permissions, assetStore: null })
    // 期望:磁盘有 legacy asset → strict 启动应拒绝。返修前 fake-0 detector 返 0 → gate 放行 → 此断言 FAIL(RED)
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/assets.*legacy-form owner record/s)
  })

  it('strict + service off + 配置根预置 legacy reference.ownerFp + uploader → 拒启动(三处 legacy 全扫)', async () => {
    vi.stubEnv('MIVO_ASSET_STORE_DIR', tmpAssetDir)
    const fsStore = createAssetStore(createFsAssetBackend(tmpAssetDir))
    // 首传以 username 形态(ownerFp=username),再 attach 一个 legacy 指纹 reference
    const { assetId } = await fsStore.upload(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png', 'alice@xd.com')
    expect(assetId).toBeTruthy()
    await fsStore.attach(assetId, 'node-legacy', 'abcd1234ef567890') // legacy reference.ownerFp(16-hex)
    expect(await fsStore.countLegacyFormOwners!()).toBe(1) // reference 指纹计入

    const { backend: persist, permissions } = buildPersistApp()
    const detectors = buildStartupDetectors({ persist, permissions, assetStore: null })
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/assets.*legacy-form owner record/s)
  })

  it('strict + service off + 配置根空(目录缺失)→ 通过(ENOENT→0,合法空;非伪造 0)', async () => {
    // tmpAssetDir 存在但空(无 .meta.json)→ listRecords → [] → 0 → 通过
    vi.stubEnv('MIVO_ASSET_STORE_DIR', tmpAssetDir)
    expect(statSync(tmpAssetDir).isDirectory()).toBe(true)
    const { backend: persist, permissions } = buildPersistApp()
    const detectors = buildStartupDetectors({ persist, permissions, assetStore: null })
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).resolves.toBeUndefined()
  })

  it('strict + service off + 配置根全迁移(username 形态 ownerFp)→ 通过', async () => {
    vi.stubEnv('MIVO_ASSET_STORE_DIR', tmpAssetDir)
    const fsStore = createAssetStore(createFsAssetBackend(tmpAssetDir))
    await fsStore.upload(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png', 'alice@xd.com') // username
    expect(await fsStore.countLegacyFormOwners!()).toBe(0)
    const { backend: persist, permissions } = buildPersistApp()
    const detectors = buildStartupDetectors({ persist, permissions, assetStore: null })
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).resolves.toBeUndefined()
  })
})

// ── G2.1 R3-F1:migrateLegacyOwnersToUsernameForm(persist memory;seed→打桩迁移→strict 可见 + unmapped no-go)──
// R3-F1 验收点 3:补 R2-1 原验收要求的 seed→打桩迁移→strict 可见与 unmapped no-go。
// 返修前 migrateLegacyOwnersToUsernameForm 仍只 throw(G2.1 不实装),相关测试不存在。
// 现 InMemoryPersistBackend 落地真实 rekey(byOwner + idempotencyIndex + globalProject/CanvasOwners);
// PG 三域跨 backend 迁移仍 G2.2(owner.ts 对无该方法 backend 显式抛 not implemented → fail-closed)。
describe('G2.1 R3-F1 — migrateLegacyOwnersToUsernameForm(seed→migrate→strict 可见 + unmapped no-go)', () => {
  it('seed legacy persist → migrate(stub fp→username)→ strict gate 通过 + 数据对 username 可见', async () => {
    const { backend, permissions } = buildPersistApp()
    const fp = 'abcd1234ef567890'
    expect(isLegacyFormOwner(fp)).toBe(true)
    await backend.ensureCreate(fp, 'project', 'p1', { name: 'P1' }, { method: 'POST', resourceKind: 'project' })
    expect(await backend.countLegacyFormOwners!()).toBe(1)

    // 打桩迁移:resolver 把该指纹映射到 SSO username
    const result = await migrateLegacyOwnersToUsernameForm(backend, (f) => (f === fp ? 'alice@xd.com' : undefined))
    expect(result.migrated).toBe(1)
    expect(result.unmapped).toBe(0)
    expect(await backend.countLegacyFormOwners!()).toBe(0) // persist 域迁移完成

    // strict gate 通过(persist 0;permissions/assets memory 干净)
    const assets = createAssetStore(createMemoryAssetBackend())
    const detectors = buildStartupDetectors({ persist: backend, permissions, assetStore: assets })
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors)).resolves.toBeUndefined()

    // strict 可见:数据现归 username ownerId → listByOwner(username) 返回(原指纹 owner 列表空)
    const visible = await backend.listByOwner('alice@xd.com', 'project')
    expect(visible.records).toHaveLength(1)
    expect(visible.records[0].id).toBe('p1')
    expect(visible.records[0].ownerId).toBe('alice@xd.com')
    const stale = await backend.listByOwner(fp, 'project')
    expect(stale.records).toHaveLength(0) // 旧指纹 owner 已无数据
  })

  it('unmapped resolver(指纹无 username 映射)→ {migrated:0, unmapped:1} + strict 仍拒启动(no-go)', async () => {
    const { backend, permissions } = buildPersistApp()
    const fp = '0123456789abcdef'
    await backend.ensureCreate(fp, 'project', 'p1', { name: 'P1' }, { method: 'POST', resourceKind: 'project' })
    expect(await backend.countLegacyFormOwners!()).toBe(1)

    // unmapped:resolver 返 undefined(无映射)→ 该 legacy owner 无法迁移
    const result = await migrateLegacyOwnersToUsernameForm(backend, () => undefined)
    expect(result.migrated).toBe(0)
    expect(result.unmapped).toBe(1)
    expect(await backend.countLegacyFormOwners!()).toBe(1) // 仍 legacy → strict no-go

    const assets = createAssetStore(createMemoryAssetBackend())
    const detectors = buildStartupDetectors({ persist: backend, permissions, assetStore: assets })
    await expect(
      assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors),
    ).rejects.toThrow(/persist.*legacy-form owner record/s)
  })

  it('PG stub(无 migrateLegacyOwnersToUsernameForm)→ 抛 not implemented G2.2(fail-closed)', async () => {
    const stubPg = { ready: Promise.resolve() } as unknown as PersistBackend
    await expect(migrateLegacyOwnersToUsernameForm(stubPg, () => 'alice@xd.com')).rejects.toThrow(/not implemented.*G2\.2/s)
  })

  it('非 strict + legacy persist → migrate 仍可调用(不依赖 strict 开关;G2.2 ops 预迁移用)', async () => {
    const { backend } = buildPersistApp()
    const fp = 'abcd1234ef567890'
    await backend.ensureCreate(fp, 'project', 'p1', { name: 'P1' }, { method: 'POST', resourceKind: 'project' })
    const result = await migrateLegacyOwnersToUsernameForm(backend, (f) => (f === fp ? 'bob@xd.com' : undefined))
    expect(result.migrated).toBe(1)
    expect(await backend.countLegacyFormOwners!()).toBe(0)
    const visible = await backend.listByOwner('bob@xd.com', 'project')
    expect(visible.records).toHaveLength(1)
  })
})
