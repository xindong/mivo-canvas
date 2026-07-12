// @vitest-environment node
// server/__tests__/pgConfig.test.ts
// P0.3 返修 F9:idle timeout=0 文档与实现一致性 + 非法值 fail visibly。
// 覆盖 resolvePersistBackendConfig 的 backend 选择 / 缺密码 fail / idle 三态(0/正数/默认)/ 非法抛错。
import { describe, it, expect } from 'vitest'
import { resolvePersistBackendConfig } from '../persist/pgConfig'

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { MIVO_PERSIST_BACKEND: 'memory' }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete e[k]
    else e[k] = v
  }
  return e
}

const pgEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  env({ MIVO_PERSIST_BACKEND: 'pg', MIVO_PG_PASSWORD: 'secret', ...overrides })

describe('pgConfig: resolvePersistBackendConfig (F9 idle=0 + defaults)', () => {
  it('memory backend: kind=memory, pg=null (生产零变化默认路径)', () => {
    const cfg = resolvePersistBackendConfig(env())
    expect(cfg.kind).toBe('memory')
    expect(cfg.pg).toBeNull()
  })

  it('pg backend 缺 MIVO_PG_PASSWORD → 抛错(fail visibly,不静默降级 memory)', () => {
    expect(() => resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: 'pg' }))).toThrow(/MIVO_PG_PASSWORD/)
  })

  it('F9: idle=0 honored as 0(不超时),不静默回落 30000', () => {
    const cfg = resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '0' }))
    expect(cfg.pg!.idleTimeoutMs).toBe(0)
  })

  it('F9: idle 正数 honored', () => {
    const cfg = resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '45000' }))
    expect(cfg.pg!.idleTimeoutMs).toBe(45000)
  })

  it('F9: idle 未设 → 默认 30000', () => {
    const cfg = resolvePersistBackendConfig(pgEnv())
    expect(cfg.pg!.idleTimeoutMs).toBe(30000)
  })

  it('F9: idle 空串/纯空白 → 视为未设 → 默认 30000', () => {
    expect(resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '   ' })).pg!.idleTimeoutMs).toBe(30000)
  })

  it('F9: idle 负数 → 抛错(fail visibly,不静默回落)', () => {
    expect(() => resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '-5' }))).toThrow(/MIVO_PG_IDLE_TIMEOUT_MS/)
  })

  it('F9: idle 非数字 → 抛错', () => {
    expect(() => resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: 'abc' }))).toThrow(/MIVO_PG_IDLE_TIMEOUT_MS/)
  })

  it('R2-7: idle 小数 0.5 → 抛错(不静默 Math.trunc 截断为 0 = 意外禁用超时)', () => {
    expect(() => resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '0.5' }))).toThrow(/MIVO_PG_IDLE_TIMEOUT_MS/)
  })

  it('R2-7: idle 小数 1.9 → 抛错(不静默截断为 1)', () => {
    expect(() => resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '1.9' }))).toThrow(/MIVO_PG_IDLE_TIMEOUT_MS/)
  })

  it('R2-7: idle 整数字符串 "1" honored(回归:整数不被误拒)', () => {
    expect(resolvePersistBackendConfig(pgEnv({ MIVO_PG_IDLE_TIMEOUT_MS: '1' })).pg!.idleTimeoutMs).toBe(1)
  })

  it('defaults: host/port/db/user/maxConnections/connectionTimeout 兜底值正确', () => {
    const cfg = resolvePersistBackendConfig(pgEnv())
    expect(cfg.pg).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      database: 'mivocanvas',
      user: 'mivo',
      password: 'secret',
      maxConnections: 10,
      connectionTimeoutMs: 5000,
    })
  })

  it('MIVO_PG_HOST_PORT 作为 port 兜底(共享机 5432 被占场景)', () => {
    const cfg = resolvePersistBackendConfig(pgEnv({ MIVO_PG_HOST_PORT: '55442' }))
    expect(cfg.pg!.port).toBe(55442)
  })

  it('MIVO_PG_PORT 优先于 MIVO_PG_HOST_PORT', () => {
    const cfg = resolvePersistBackendConfig(pgEnv({ MIVO_PG_PORT: '55443', MIVO_PG_HOST_PORT: '55442' }))
    expect(cfg.pg!.port).toBe(55443)
  })
})

describe('pgConfig: B0 backend 白名单 fail-fast(非法值启动即拒,不静默落 memory)', () => {
  it('B0: 未设置 MIVO_PERSIST_BACKEND → memory(与现状完全一致)', () => {
    const cfg = resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: undefined }))
    expect(cfg.kind).toBe('memory')
    expect(cfg.pg).toBeNull()
  })

  it('B0: 空串 → memory(与现状完全一致)', () => {
    const cfg = resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: '' }))
    expect(cfg.kind).toBe('memory')
    expect(cfg.pg).toBeNull()
  })

  it('B0: 纯空白 → memory(与现状完全一致;trim 视为未设)', () => {
    const cfg = resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: '   ' }))
    expect(cfg.kind).toBe('memory')
    expect(cfg.pg).toBeNull()
  })

  it('B0: 显式 memory → memory(允许显式声明)', () => {
    const cfg = resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: 'memory' }))
    expect(cfg.kind).toBe('memory')
    expect(cfg.pg).toBeNull()
  })

  it('B0: 显式 pg(带密码)→ pg', () => {
    const cfg = resolvePersistBackendConfig(pgEnv())
    expect(cfg.kind).toBe('pg')
    expect(cfg.pg).not.toBeNull()
  })

  it('B0: typo "PG"(大写)→ 抛错,信息回显原值', () => {
    expect(() => resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: 'PG' }))).toThrow(
      /MIVO_PERSIST_BACKEND 非法值 "PG"/,
    )
  })

  it('B0: typo "postgres" → 抛错', () => {
    expect(() => resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: 'postgres' }))).toThrow(
      /MIVO_PERSIST_BACKEND 非法值 "postgres"/,
    )
  })

  it('B0: typo "Pg "(大小写+尾空格)→ 抛错,信息回显原值(含尾空格)', () => {
    expect(() => resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: 'Pg ' }))).toThrow(
      /MIVO_PERSIST_BACKEND 非法值 "Pg "/,
    )
  })

  it('B0: typo 抛错信息说清合法值(含 "pg" 与 "memory",助运维快速自纠)', () => {
    let msg = ''
    try {
      resolvePersistBackendConfig(env({ MIVO_PERSIST_BACKEND: 'PG' }))
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/"pg"/)
    expect(msg).toMatch(/"memory"/)
  })
})
