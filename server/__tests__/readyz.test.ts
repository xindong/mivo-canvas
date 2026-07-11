// @vitest-environment node
// server/__tests__/readyz.test.ts
// P0.3 readiness probe 路由测试。/healthz 只表进程活;/readyz 表依赖此刻可用。
// memory backend(默认)下 persist 恒 ok;重点测 asset dir 探写三态:skipped(service 关)/ ok / fail。
// PG ping 的 fail 路径需真实 PG(MIVO_PG_TEST=1,见 backend.pg.test.ts),此处不覆盖——
// memory + asset fail 已能验证 503 路由 + 响应体 shape。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** /readyz 响应体 shape(宽松;只断言用到的字段)。 */
type ReadyBody = {
  status: string
  persist: { status: string; backend: string }
  assetDir: { status: string; dir: string; reason?: string }
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

  it('asset service 关 → 200,persist ok(memory),assetDir skipped', async () => {
    delete process.env.MIVO_ENABLE_ASSET_SERVICE
    const app = await loadFreshApp()
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReadyBody
    expect(body.status).toBe('ok')
    expect(body.persist).toEqual({ status: 'ok', backend: 'memory' })
    expect(body.assetDir.status).toBe('skipped')
  })

  it('asset service 开 + 可写目录 → 200,assetDir ok,dir 回显配置路径', async () => {
    const dir = join(tmpRoot, 'assets')
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    process.env.MIVO_ASSET_STORE_DIR = dir
    const app = await loadFreshApp()
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReadyBody
    expect(body.status).toBe('ok')
    expect(body.persist).toEqual({ status: 'ok', backend: 'memory' })
    expect(body.assetDir.status).toBe('ok')
    expect(body.assetDir.dir).toBe(dir)
  })

  it('asset service 开 + 不可写目录(父路径是文件) → 503,assetDir fail + reason', async () => {
    // 用一个已存在的文件作为父路径 → mkdir recursive 抛 ENOTDIR。
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
  })

  it('/healthz 仍恒 200(不随 readyz degraded 变)', async () => {
    const blocker = join(tmpRoot, 'blocker2')
    writeFileSync(blocker, 'x', 'utf8')
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    process.env.MIVO_ASSET_STORE_DIR = join(blocker, 'sub')
    const app = await loadFreshApp()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
