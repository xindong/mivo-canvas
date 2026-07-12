// @vitest-environment node
// server/__tests__/readyz.test.ts
// P0.3 readiness probe 路由测试。/healthz 只表进程活;/readyz 表依赖此刻可用。
// memory backend(默认)下 persist 恒 ok;重点测 asset dir 探写三态:skipped(service 关)/ ok / fail。
// PG ping 的 fail 路径需真实 PG(MIVO_PG_TEST=1,见 backend.pg.test.ts),此处不覆盖——
// memory + asset fail 已能验证 503 路由 + 响应体 shape。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** /readyz 响应体 shape(宽松;只断言用到的字段)。F2 返修:新增 permission 检查项。 */
type ReadyBody = {
  status: string
  persist: { status: string; backend: string }
  permission: { status: string; backend: string }
  // F7 返修:dir 仅 ok/skipped 回显;fail 时不回显(防 public 503 暴露绝对路径)。
  assetDir: { status: string; dir?: string; reason?: string }
}

const savedEnv: Record<string, string | undefined> = {
  MIVO_PERSIST_BACKEND: process.env.MIVO_PERSIST_BACKEND,
  MIVO_PG_PASSWORD: process.env.MIVO_PG_PASSWORD,
  MIVO_ENABLE_ASSET_SERVICE: process.env.MIVO_ENABLE_ASSET_SERVICE,
  MIVO_ASSET_STORE_DIR: process.env.MIVO_ASSET_STORE_DIR,
}

const restoreEnv = () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const loadFreshApp = async () => {
  vi.resetModules()
  return (await import('../app')).app
}

describe('P0.3 /readyz readiness probe', () => {
  let tmpRoot: string

  beforeEach(() => {
    restoreEnv()
    // 默认 memory backend,避免捡到 PG env。
    delete process.env.MIVO_PERSIST_BACKEND
    delete process.env.MIVO_PG_PASSWORD
    tmpRoot = mkdtempSync(join(tmpdir(), 'readyz-'))
  })

  afterEach(() => {
    restoreEnv()
    rmSync(tmpRoot, { recursive: true, force: true })
    vi.resetModules()
  })

  it('asset service 关 → 200,persist ok(memory),permission ok(memory),assetDir skipped', async () => {
    delete process.env.MIVO_ENABLE_ASSET_SERVICE
    const app = await loadFreshApp()
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReadyBody
    expect(body.status).toBe('ok')
    expect(body.persist).toEqual({ status: 'ok', backend: 'memory' })
    expect(body.permission).toEqual({ status: 'ok', backend: 'memory' })
    expect(body.assetDir.status).toBe('skipped')
  })

  it('asset service 开 + 可写目录(预先存在) → 200,assetDir ok,dir 回显配置路径,probe 文件清理无残留', async () => {
    // F1 返修:probe 禁 mkdir——ok 路径要求目录**预先存在**(部署前置建)。旧测试用未建目录靠 mkdir 假绿。
    const dir = join(tmpRoot, 'assets')
    mkdirSync(dir, { recursive: true })
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    process.env.MIVO_ASSET_STORE_DIR = dir
    const app = await loadFreshApp()
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReadyBody
    expect(body.status).toBe('ok')
    expect(body.persist).toEqual({ status: 'ok', backend: 'memory' })
    expect(body.permission).toEqual({ status: 'ok', backend: 'memory' })
    expect(body.assetDir.status).toBe('ok')
    expect(body.assetDir.dir).toBe(dir)
    // F7:probe 文件 finally 清理,无 inode 残留。
    expect(existsSync(join(dir, '.readyz-probe'))).toBe(false)
  })

  it('F1:asset service 开 + 目录不存在 → 503(漏挂载必须 fail,不许自愈建目录),请求后仍不存在', async () => {
    const dir = join(tmpRoot, 'never-created')
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    process.env.MIVO_ASSET_STORE_DIR = dir
    const app = await loadFreshApp()
    const res = await app.request('/readyz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as ReadyBody
    expect(body.status).toBe('degraded')
    expect(body.assetDir.status).toBe('fail')
    expect(body.assetDir.reason).toBe('dir-missing')
    expect(body.assetDir.dir).toBeUndefined() // F7:fail 不回显绝对路径
    // F1 核心:probe 禁 mkdir——请求后目录仍不存在(自愈建目录=假绿,资产会写错盘)。
    expect(existsSync(dir)).toBe(false)
  })

  it('asset service 开 + 不可写目录(父路径是文件) → 503,assetDir fail + 稳定 reason code(不含绝对路径)', async () => {
    // 用一个已存在的文件作为父路径 → stat 抛 ENOTDIR → 'parent-not-dir'。
    const blocker = join(tmpRoot, 'blocker-file')
    writeFileSync(blocker, 'not-a-dir', 'utf8')
    const dir = join(blocker, 'sub')
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    process.env.MIVO_ASSET_STORE_DIR = dir
    const app = await loadFreshApp()
    const res = await app.request('/readyz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as ReadyBody
    expect(body.status).toBe('degraded')
    expect(body.assetDir.status).toBe('fail')
    expect(body.assetDir.reason).toBeTruthy()
    expect(body.assetDir.reason).toBe('parent-not-dir') // F7:稳定 code
    expect(body.assetDir.dir).toBeUndefined() // F7:fail 不回显路径
    expect(body.assetDir.reason).not.toContain(tmpRoot) // F7:reason 不泄露绝对路径
  })

  it('/healthz 仍恒 200(不随 readyz degraded 变) + G1-a F3 persist readiness 回显', async () => {
    const blocker = join(tmpRoot, 'blocker2')
    writeFileSync(blocker, 'x', 'utf8')
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    process.env.MIVO_ASSET_STORE_DIR = join(blocker, 'sub')
    const app = await loadFreshApp()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    // G1-a R2 F3:/healthz 扩展了 persist readiness(backend kind + durable 标志),不随 /readyz degraded 变。
    // 用子集断言(toMatchObject)保留 G1-a F3 扩展 + 不锁死将来可能新增的字段;status ok + persist 形状正确。
    const body = (await res.json()) as { status: string; persist: { backend: string; durable: boolean } }
    expect(body.status).toBe('ok')
    expect(body.persist).toMatchObject({ backend: expect.any(String), durable: expect.any(Boolean) })
  })
})
