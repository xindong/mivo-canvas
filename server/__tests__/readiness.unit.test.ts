// @vitest-environment node
// server/__tests__/readiness.unit.test.ts
// P0.3 返修 F1/F2/F7:直接单测 computeReadiness 聚合逻辑,无需真实 PG/fs(用 mock backend)。
// 覆盖:persist fail / permission fail(F2) / ping throws(F7) → degraded;稳定 reason code 不泄露原始串。
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('R2-1: persist+permission ping 并行(共享池耗尽时总时延≈max,非 serial 叠加 5s+5s=10s)', async () => {
    // 对抗负例:两 backend ping 各 delay 300ms。旧实现依次 await → 600ms;并行(Promise.all)→ ≈300ms。
    const delay = 300
    const slow = { ping: async () => { await new Promise((r) => setTimeout(r, delay)); return { ok: true as const } } }
    const t0 = performance.now()
    const r = await run(slow, slow)
    const elapsed = performance.now() - t0
    expect(r.status).toBe('ok')
    // 并行:elapsed ≈ delay(≤ delay×1.7 给 CI 慢机 slack);串行会 ≥ 2×delay=600ms。
    // 这条直接钉住"共享池耗尽整条 readyz ≤ timeout+容差"——timeout 由 ping 时延模拟。
    expect(elapsed).toBeLessThan(delay * 1.7)
  })

  it('R2-5: persist fail + assetDir ok → degraded,assetDir.dir 脱敏(不回显绝对路径,防 public 503 暴露)', async () => {
    // 对抗负例:sol3 "PG fail + asset ok" 复现——assetDir 探写 ok(status=ok+dir 回显),
    // 但整体 degraded;旧实现回显 dir → public 0.0.0.0 无 auth gate 下 503 body 泄绝对路径。
    const dir = mkdtempSync(join(tmpdir(), 'readyz-sanitize-'))
    try {
      const r = await computeReadiness({
        persist: failBackend as unknown as PersistBackend,
        persistKind: 'pg',
        permission: okBackend as unknown as PermissionBackend,
        permissionKind: 'pg',
        assetDir: dir,
        assetEnabled: true,
        now: 1000,
      })
      expect(r.status).toBe('degraded')
      expect(r.persist.status).toBe('fail')
      expect(r.assetDir.status).toBe('ok') // asset probe 本身 ok
      expect(r.assetDir.dir).toBeUndefined() // R2-5:degraded 时不回显绝对路径
      expect(JSON.stringify(r)).not.toContain(dir) // body 序列化无绝对路径泄漏
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
