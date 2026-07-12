// server/routes/projects.compensation.route.test.ts
// P-6 saga 补偿路由级测试:restore/delete 两步写第二步失败 → pending;幂等重入 attemptCompensation 收敛。
// 驱动真实 projects 路由(POST restored/existing + DELETE),用 InMemoryPermissionBackend 的故障注入钩子
// (__setCompensationFaultForTest)模拟 unRevokeAllForProject/revokeAllForProject 抛错,验"无永久 revoked/active 终态"。
// 后端意图生命周期(pending/done/attemptCount/lastError 等可观察字段)的跨后端等价性见
// server/persist/permissionBackend.contract.dual.test.ts;本文件只验路由编排 saga 的端到端收敛。

import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, req } from './persistTestApp'
import { fingerprintOfPlatformKey } from '../lib/keys'
import type { CompensationIntent } from '../lib/permissions'

describe('/api/projects P-6 saga 补偿(restore/delete 第二步失败可重试收敛)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let permissions: ReturnType<typeof buildPersistApp>['permissions']

  beforeEach(() => {
    ;({ app, permissions } = buildPersistApp())
  })

  const create = async (id: string, name = 'P') =>
    req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, name }) })

  const findIntent = async (projectId: string, op: 'restore' | 'delete'): Promise<CompensationIntent | undefined> =>
    (await permissions.listCompensations(projectId)).find((i) => i.op === op)

  it('restore happy path:DELETE(revoke)→POST restored(unRevoke via saga)→链接恢复 active;restore 意图 done', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-happy')).status).toBe(201)
    const link = await permissions.createShareLink('p-happy', 'view', owner)
    expect((await permissions.resolveShareLink(link.token, 'p-happy'))?.kind).toBe('active')
    // DELETE → softDelete + saga attempt(revoke 跑通)→ 链接 revoked
    expect((await req(app, '/api/projects/p-happy', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(204)
    expect((await permissions.resolveShareLink(link.token, 'p-happy'))?.kind).toBe('revoked')
    // POST restored → saga record+attempt(unRevoke 跑通)→ 链接恢复 active
    const restore = await create('p-happy')
    expect(restore.status).toBe(200)
    expect((await permissions.resolveShareLink(link.token, 'p-happy'))?.kind).toBe('active')
    const ri = await findIntent('p-happy', 'restore')
    expect(ri?.status).toBe('done')
    expect(ri?.attemptCount).toBe(1)
  })

  it('restore saga:unRevoke 抛错 → POST 200 但链接仍 revoked(pending);幂等重入 POST(existing)→ 收敛,链接恢复', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-saga')).status).toBe(201)
    const link = await permissions.createShareLink('p-saga', 'view', owner)
    await req(app, '/api/projects/p-saga', { method: 'DELETE', headers: hdr(KEY_A) }) // 链接 revoked
    expect((await permissions.resolveShareLink(link.token, 'p-saga'))?.kind).toBe('revoked')
    // 注入 unRevoke 步骤故障(下次 attempt 失败 1 次后自减)
    permissions.__setCompensationFaultForTest('restore', 1)
    // POST restored → saga attempt 失败 → 链接仍 revoked;POST 仍 200(项目已恢复,补偿 pending 待收敛)
    const r1 = await create('p-saga')
    expect(r1.status).toBe(200)
    expect((await permissions.resolveShareLink(link.token, 'p-saga'))?.kind).toBe('revoked') // 仍 revoked!
    const ri1 = await findIntent('p-saga', 'restore')
    expect(ri1?.status).toBe('pending')
    expect(ri1?.attemptCount).toBe(1)
    expect(ri1?.lastError).toBeTruthy()
    expect(ri1?.lastAttemptedAt).toBeTruthy()
    // 幂等重入:POST existing → attemptCompensation 收敛(故障已自减)→ 链接最终恢复
    const r2 = await create('p-saga')
    expect(r2.status).toBe(200)
    expect((await permissions.resolveShareLink(link.token, 'p-saga'))?.kind).toBe('active')
    const ri2 = await findIntent('p-saga', 'restore')
    expect(ri2?.status).toBe('done')
    expect(ri2?.attemptCount).toBe(2)
    expect(ri2?.lastError).toBeNull()
  })

  it('delete saga:revoke 抛错 → DELETE 204 但链接仍 active(pending);幂等重入 DELETE(已删)→ 收敛,链接 revoked', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-del')).status).toBe(201)
    const link = await permissions.createShareLink('p-del', 'view', owner)
    expect((await permissions.resolveShareLink(link.token, 'p-del'))?.kind).toBe('active')
    // 注入 revoke 步骤故障(下次 attempt 失败 1 次后自减)
    permissions.__setCompensationFaultForTest('delete', 1)
    // DELETE → softDelete 成功 + saga attempt 失败 → 链接仍 active;DELETE 仍 204(项目已软删,补偿 pending)
    const d1 = await req(app, '/api/projects/p-del', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(d1.status).toBe(204)
    expect((await permissions.resolveShareLink(link.token, 'p-del'))?.kind).toBe('active') // 仍 active!
    const di1 = await findIntent('p-del', 'delete')
    expect(di1?.status).toBe('pending')
    expect(di1?.attemptCount).toBe(1)
    expect(di1?.lastError).toBeTruthy()
    // 幂等重入:DELETE 已删 → attemptCompensation 收敛(故障已自减)→ 链接最终 revoked
    const d2 = await req(app, '/api/projects/p-del', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(d2.status).toBe(204)
    expect((await permissions.resolveShareLink(link.token, 'p-del'))?.kind).toBe('revoked')
    const di2 = await findIntent('p-del', 'delete')
    expect(di2?.status).toBe('done')
    expect(di2?.attemptCount).toBe(2)
    expect(di2?.lastError).toBeNull()
  })

  it('幂等重入无 pending(从未失败)→ nothing-pending,不建意图(无 spurious 补偿)', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-noop')).status).toBe(201)
    await permissions.createShareLink('p-noop', 'view', owner)
    // 普通幂等 POST(existing,从未删过)→ attemptCompensation 无 pending → nothing-pending,不建意图
    const r = await create('p-noop')
    expect(r.status).toBe(200)
    expect(await permissions.listCompensations('p-noop')).toEqual([])
  })

  it('P1-1 record 崩溃(restore):DELETE 级联 marker durable → POST restored record 抛错也被 attempt 据 marker 收敛(不需重试)', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-rec')).status).toBe(201)
    const link = await permissions.createShareLink('p-rec', 'view', owner)
    expect((await permissions.resolveShareLink(link.token, 'p-rec'))?.kind).toBe('active')
    // DELETE → softDelete + attempt delete(revokeAllForProject 置 cascade marker,durable)
    expect((await req(app, '/api/projects/p-rec', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(204)
    expect((await permissions.resolveShareLink(link.token, 'p-rec'))?.kind).toBe('revoked')
    // 注入 record 故障(模拟"第一步提交后、record 前崩溃")。route 已 try/catch 包裹 record → 不阻断主操作。
    permissions.__setRecordFaultForTest('restore', 1)
    // POST restored → ensureCreate 恢复(commit)→ record 抛错(caught)→ attempt 据 cascade_revoked_at marker 自收敛
    const r = await create('p-rec')
    expect(r.status).toBe(200) // record 崩溃不阻断主操作(200 primary-success 语义保留)
    expect((await permissions.resolveShareLink(link.token, 'p-rec'))?.kind).toBe('active') // 据 marker 已收敛!
    const ri = await findIntent('p-rec', 'restore')
    expect(ri?.status).toBe('done') // attempt 自建 pending 并 done(可观察)
    expect(ri?.attemptCount).toBe(1)
  })

  it('P1-1 record 崩溃(delete):softDelete commit 后 record 抛错 → 重入 DELETE(已删)据 marker(active link)收敛', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-recdel')).status).toBe(201)
    const link = await permissions.createShareLink('p-recdel', 'view', owner)
    expect((await permissions.resolveShareLink(link.token, 'p-recdel'))?.kind).toBe('active')
    // 注入 record 故障(softDelete 已 commit,cascade marker 还未置——delete 方向 marker 是 active link)
    permissions.__setRecordFaultForTest('delete', 1)
    // DELETE → softDelete commit + record 抛错(caught)→ attempt delete:无 pending(compensationNeed=true:active link)→ 自建+revoke
    const d1 = await req(app, '/api/projects/p-recdel', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(d1.status).toBe(204)
    expect((await permissions.resolveShareLink(link.token, 'p-recdel'))?.kind).toBe('revoked') // 据 marker(active link)已收敛!
    const di = await findIntent('p-recdel', 'delete')
    expect(di?.status).toBe('done')
  })

  it('P1-1 普通 existing POST 不动手工 revoked link(防误恢复)', async () => {
    const owner = fingerprintOfPlatformKey(KEY_A)
    expect((await create('p-manual')).status).toBe(201)
    const link = await permissions.createShareLink('p-manual', 'view', owner)
    // 用户手工 revoke(cascade_revoked_at 保持 null——非级联)
    await permissions.revokeShareLink(link.id, 'p-manual')
    expect((await permissions.resolveShareLink(link.token, 'p-manual'))?.kind).toBe('revoked')
    // 普通幂等 POST existing(项目从未软删)→ attempt restore:无 cascade marker → nothing-pending,不动手工 revoke
    const r = await create('p-manual')
    expect(r.status).toBe(200)
    expect((await permissions.resolveShareLink(link.token, 'p-manual'))?.kind).toBe('revoked') // 仍 revoked!
    expect(await permissions.listCompensations('p-manual')).toEqual([]) // 不建意图
  })
})
