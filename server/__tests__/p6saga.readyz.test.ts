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

  it('无补偿 → 200 ok,X-Compensation-Failed:0', async () => {
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Compensation-Failed')).toBe('0')
    expect(res.headers.get('X-Compensation-Pending')).toBe('0')
    const body = await res.json()
    // 健康态 status='ok'(与 P0.3 readyz.test.ts 的 ok/degraded 方案统一;saga merge 时 P0.3 为底座)。
    expect((body as { status: string }).status).toBe('ok')
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

  // R5-F2 闭环(R4 verdict Step 8 暴露的 P1 阻断):dead-letter 后重开新 generation 并收敛,旧 failed 历史行
  //   仍永久计入 counts → /readyz 永久 503(可用性不可恢复)。修复:新 generation record 时把同 project 较旧
  //   failed 标 superseded → counts.failed 归零 → /readyz 恢复 200。三态验收:503→reopen→completed→200。
  it('R5-F2 闭环:failed→503→reopen gen2→completed→/readyz 恢复 200(不再永久 503)', async () => {
    const owner = 'owner-readyz-closure'
    const link = await sharedPermissionBackend.createShareLink('p-closure', 'view', owner)
    await sharedPermissionBackend.revokeAllForProject('p-closure') // cascade marker,link revoked
    await sharedPermissionBackend.recordCompensation('p-closure', 'restore') // gen1 pending
    mem().__setCompensationFaultForTest('restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
    for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) {
      await sharedPermissionBackend.attemptCompensation('p-closure', 'restore')
    }
    await sharedPermissionBackend.sweepCompensations() // gen1 dead-letter
    expect((await sharedPermissionBackend.resolveShareLink(link.token, 'p-closure'))?.kind).toBe('revoked') // 未收敛
    const before = await app.request('/readyz')
    expect(before.status).toBe(503) // dead-letter → 非绿
    // 故障解除 → 重开 gen2(record supersede 旧 failed)→ attempt completed → link 收敛
    const again = await sharedPermissionBackend.recordCompensation('p-closure', 'restore')
    expect(again.generation).toBe(2)
    const r = await sharedPermissionBackend.attemptCompensation('p-closure', 'restore')
    expect(r.kind).toBe('completed')
    expect((await sharedPermissionBackend.resolveShareLink(link.token, 'p-closure'))?.kind).toBe('active') // 收敛
    // 恢复:/readyz 200(旧 failed 已 superseded,不计当前未收敛)
    const after = await app.request('/readyz')
    expect(after.status).toBe(200)
    expect(after.headers.get('X-Compensation-Failed')).toBe('0')
    expect(after.headers.get('X-Compensation-Pending')).toBe('0')
    const afterBody = await after.json()
    expect((afterBody as { status: string }).status).toBe('ok')
  })

  it('R5-F2 重开再失败仍 503:gen2 重开→再 dead-letter → /readyz 仍非绿(仅最新 failed 计数)', async () => {
    const owner = 'owner-readyz-refail'
    const link = await sharedPermissionBackend.createShareLink('p-refail', 'view', owner)
    await sharedPermissionBackend.revokeAllForProject('p-refail')
    await sharedPermissionBackend.recordCompensation('p-refail', 'restore') // gen1
    mem().__setCompensationFaultForTest('restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
    for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) await sharedPermissionBackend.attemptCompensation('p-refail', 'restore')
    await sharedPermissionBackend.sweepCompensations() // gen1 dead-letter
    expect((await app.request('/readyz')).status).toBe(503)
    // 重开 gen2(故障未解除)→ 再 dead-letter
    await sharedPermissionBackend.recordCompensation('p-refail', 'restore') // gen2,supersede gen1
    expect((await app.request('/readyz')).status).toBe(200) // gen2 在途,旧 failed 已 superseded
    mem().__setCompensationFaultForTest('restore', COMPENSATION_MAX_SWEEP_ATTEMPTS) // gen2 仍故障(故障未解除)
    for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) await sharedPermissionBackend.attemptCompensation('p-refail', 'restore')
    await sharedPermissionBackend.sweepCompensations() // gen2 dead-letter
    expect((await sharedPermissionBackend.resolveShareLink(link.token, 'p-refail'))?.kind).toBe('revoked') // 仍未收敛
    const res = await app.request('/readyz')
    expect(res.status).toBe(503) // gen2 failed → 又非绿
    expect(res.headers.get('X-Compensation-Failed')).toBe('1') // 仅 gen2(最新 failed),gen1 已 superseded
  })
})
