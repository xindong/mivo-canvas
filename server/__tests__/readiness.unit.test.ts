// @vitest-environment node
// server/__tests__/readiness.unit.test.ts
// P0.3 返修 F1/F2/F7:直接单测 computeReadiness 聚合逻辑,无需真实 PG/fs(用 mock backend)。
// 覆盖:persist fail / permission fail(F2) / ping throws(F7) → degraded;稳定 reason code 不泄露原始串。
import { describe, it, expect } from 'vitest'
import { computeReadiness } from '../lib/readiness'
import type { PersistBackend } from '../persist/backend'
import type { PermissionBackend } from '../lib/permissions'

const okBackend = { ping: async () => ({ ok: true as const }) }
const failBackend = {
  ping: async () => ({ ok: false as const, reason: 'ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:55442 — password auth failed for user "mivo"' }),
}
const throwBackend = { ping: async () => { throw new Error('boom: password authentication failed for user mivo') } }

const run = (persist: { ping(): Promise<{ ok: true } | { ok: false; reason: string }> }, permission: { ping(): Promise<{ ok: true } | { ok: false; reason: string }> }) =>
  computeReadiness({
    persist: persist as unknown as PersistBackend,
    persistKind: 'pg',
    permission: permission as unknown as PermissionBackend,
    permissionKind: 'pg',
    assetDir: '/nonexistent-skip-asset',
    assetEnabled: false, // skipped — 不触发 fs,纯测 persist+permission 聚合
    now: 1000,
  })

describe('computeReadiness (F1/F2/F7 单元,无 PG)', () => {
  it('persist ok + permission ok + assetDir skipped → status ok', async () => {
    const r = await run(okBackend, okBackend)
    expect(r.status).toBe('ok')
    expect(r.persist.status).toBe('ok')
    expect(r.permission.status).toBe('ok')
    expect(r.assetDir.status).toBe('skipped')
  })

  it('F2: permission ping fail → degraded(→503),reason 稳定 code,不泄露原始 ECONNREFUSED/host/user 串', async () => {
    const r = await run(okBackend, failBackend)
    expect(r.status).toBe('degraded')
    expect(r.permission.status).toBe('fail')
    expect(r.permission.reason).toBe('pg-unreachable')
    expect(r.permission.reason).not.toContain('ECONNREFUSED')
    expect(r.permission.reason).not.toContain('127.0.0.1')
    expect(r.permission.reason).not.toContain('password')
    expect(r.permission.reason).not.toContain('mivo')
  })

  it('F2: persist ping fail → degraded;permission 仍独立判定(不被 persist 掩盖)', async () => {
    const r = await run(failBackend, okBackend)
    expect(r.status).toBe('degraded')
    expect(r.persist.status).toBe('fail')
    expect(r.persist.reason).toBe('pg-unreachable')
    expect(r.permission.status).toBe('ok')
  })

  it('F7: ping throws → 不向上抛错(不致 500),收敛为 fail + 稳定 code', async () => {
    const r = await run(throwBackend, okBackend)
    expect(r.status).toBe('degraded')
    expect(r.persist.status).toBe('fail')
    expect(r.persist.reason).toBe('pg-unreachable')
    expect(r.persist.reason).not.toContain('password')
  })

  it('F7: persist + permission 同时 fail → degraded,两者各自稳定 code', async () => {
    const r = await run(failBackend, failBackend)
    expect(r.status).toBe('degraded')
    expect(r.persist.status).toBe('fail')
    expect(r.permission.status).toBe('fail')
    expect(r.persist.reason).toBe('pg-unreachable')
    expect(r.permission.reason).toBe('pg-unreachable')
  })
})
