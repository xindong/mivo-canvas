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
