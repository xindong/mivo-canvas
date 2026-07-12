// @vitest-environment node
// server/__tests__/p6saga.readyz.test.ts
// R3-F2: /readyz readiness 探针 — 暴露 saga 补偿 pending/failed 计数。failed>0(超限 dead-letter 未收敛)
// → 503 非绿且外部可见(运维可告警);pending 仅 informational。与 /healthz(liveness=进程活)分离。
// 驱动主 app singleton(测试 env 无 MIVO_PERSIST_BACKEND → memory permission backend)。

import { describe, it, expect, beforeEach } from 'vitest'
import { app, sharedPermissionBackend } from '../app'
import { InMemoryPermissionBackend, COMPENSATION_MAX_SWEEP_ATTEMPTS } from '../lib/permissions'

const mem = (): InMemoryPermissionBackend => sharedPermissionBackend as InMemoryPermissionBackend

describe('/readyz readiness 探针(R3-F2 pending/failed 外部可见)', () => {
  beforeEach(async () => {
    await sharedPermissionBackend.__reset()
  })

  it('无补偿 → 200 ready,X-Compensation-Failed:0', async () => {
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Compensation-Failed')).toBe('0')
    expect(res.headers.get('X-Compensation-Pending')).toBe('0')
    const body = await res.json()
    expect((body as { status: string }).status).toBe('ready')
  })

  it('sweep 超限放弃 → failed>0 → 503 unconverged + X-Compensation-Failed:1(外部可见非绿)', async () => {
    const owner = 'owner-readyz'
    const link = await sharedPermissionBackend.createShareLink('p-rdz', 'view', owner)
    await sharedPermissionBackend.revokeAllForProject('p-rdz') // cascade marker,link revoked
    await sharedPermissionBackend.recordCompensation('p-rdz', 'restore') // gen1 pending
    // 注入 MAX 次故障,逐次 attempt 凑满超限阈值(保持 pending,link 仍 revoked)
    mem().__setCompensationFaultForTest('restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
    for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) {
      await sharedPermissionBackend.attemptCompensation('p-rdz', 'restore')
    }
    const sw = await sharedPermissionBackend.sweepCompensations() // 超限 → failed dead-letter
    expect(sw.failed).toBe(1)
    // link 仍 revoked(未收敛)——外部可见非绿
    expect((await sharedPermissionBackend.resolveShareLink(link.token, 'p-rdz'))?.kind).toBe('revoked')
    const res = await app.request('/readyz')
    expect(res.status).toBe(503)
    expect(res.headers.get('X-Compensation-Failed')).toBe('1')
    expect(res.headers.get('X-Compensation-Pending')).toBe('0')
    const body = await res.json()
    expect((body as { status: string }).status).toBe('unconverged')
    expect((body as { compensations: { failed: number; pending: number } }).compensations).toEqual({ failed: 1, pending: 0 })
  })
})
