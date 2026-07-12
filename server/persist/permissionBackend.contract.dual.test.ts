// server/persist/permissionBackend.contract.dual.test.ts
// T1.4 权限层双后端契约套件:把 PermissionBackend 纯契约场景参数化跑在 memory + PG 两后端上
// (permission-schema.md "swap 不改契约...契约测试从内存换成 PG fixture 重跑")。**等价性核心证据**。
//
// 内存专有故障注入(memory __setLinkRevokedAtForTest 测 30 天窗)留 memory-only(permissions.route.test.ts);
// PG 专有 30 天窗由本套件用 PG __setLinkRevokedAtForTest 验(对偶 helper)。本套件只跑纯契约断言
// (member role 派生/CRUD + share link 全态/跨项目防泄漏/FX-7 级联 + 30 天窗),两后端同形。
//
// PG gate:`MIVO_PG_TEST=1`(本地 brew PG port 55443);CI pg-suite job 真跑;CI 无 PG → 跳过 PG describe,memory 套件仍必跑。
// FK:PG 侧 project_members/share_links.project_id REFERENCES projects(id);beforeEach seed project 行(内存无 FK 不需)。

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import {
  InMemoryPermissionBackend,
  type PermissionBackend,
  type CompensationOp,
  COMPENSATION_MAX_SWEEP_ATTEMPTS,
} from '../lib/permissions'
import { PgPermissionBackend } from './pgPermissionBackend'

// ── 共享纯契约套件(makeBackend 返 fresh/singleton;resetBackend 清状态;seedProject 供 PG FK;setLinkRevokedAt 测 30 天窗)──
const runPermissionBackendContractSuite = (
  label: string,
  makeBackend: () => PermissionBackend,
  resetBackend: (b: PermissionBackend) => void | Promise<void>,
  seedProject: (b: PermissionBackend, projectId: string, ownerId: string) => void | Promise<void>,
  setLinkRevokedAt: (b: PermissionBackend, linkId: string, revokedAtIso: string) => boolean | Promise<boolean>,
  setLinkCascadeRevokedAt: (b: PermissionBackend, linkId: string, iso: string) => boolean | Promise<boolean>,
  setCompensationFault: (b: PermissionBackend, op: CompensationOp, throwCount: number) => void,
  setProjectDeleted: (b: PermissionBackend, projectId: string, isDeleted: boolean) => void | Promise<void>,
  setClaimPause: (b: PermissionBackend, op: CompensationOp, pauseFn: () => Promise<void>) => void,
): void => {
  describe(`${label} — 成员资格:角色派生 + CRUD + 反查`, () => {
    let b: PermissionBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
      await seedProject(b, 'p1', 'ownerA')
      await seedProject(b, 'p2', 'ownerA')
    })

    it('resolveMemberRole:userId===owner → owner(派生);explicit member → role;非成员 → undefined', async () => {
      expect(await b.resolveMemberRole('p1', 'ownerA', 'ownerA')).toBe('owner') // 派生
      expect(await b.resolveMemberRole('p1', 'eve', 'ownerA')).toBe(undefined) // 非成员
      await b.upsertMember('p1', 'bob', 'editor')
      expect(await b.resolveMemberRole('p1', 'bob', 'ownerA')).toBe('editor')
      expect(await b.resolveMemberRole('p1', 'ownerA', 'ownerA')).toBe('owner') // 派生仍 owner,无显式行
    })

    it('listMembers:合成 owner 派生行 + explicit 行(无重复 owner)', async () => {
      await b.upsertMember('p1', 'bob', 'editor')
      await b.upsertMember('p1', 'carol', 'viewer')
      const members = await b.listMembers('p1', 'ownerA')
      const roles = Object.fromEntries(members.map((m) => [m.userId, m.role]))
      expect(roles['ownerA']).toBe('owner') // 派生 owner 行
      expect(roles['bob']).toBe('editor')
      expect(roles['carol']).toBe('viewer')
      expect(members.filter((m) => m.userId === 'ownerA')).toHaveLength(1) // 无重复 owner
    })

    it('upsertMember:create(created=true);再 upsert 改 role(created=false)', async () => {
      const a = await b.upsertMember('p1', 'bob', 'editor')
      expect(a.ok).toBe(true)
      if (a.ok) { expect(a.created).toBe(true); expect(a.member.role).toBe('editor') }
      const c = await b.upsertMember('p1', 'bob', 'viewer')
      expect(c.ok).toBe(true)
      if (c.ok) { expect(c.created).toBe(false); expect(c.member.role).toBe('viewer') }
    })

    it('upsertMember:拒显式 owner role(is-owner)', async () => {
      const r = await b.upsertMember('p1', 'bob', 'owner')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('is-owner')
    })

    it('removeMember:硬删(removed);再删 → not-found', async () => {
      await b.upsertMember('p1', 'bob', 'editor')
      const r = await b.removeMember('p1', 'bob')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.removed.userId).toBe('bob')
      const r2 = await b.removeMember('p1', 'bob')
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.reason).toBe('not-found')
    })

    it('listSharedProjects:返 explicit member 行(不含派生 owner)', async () => {
      await b.upsertMember('p1', 'bob', 'editor')
      await b.upsertMember('p2', 'bob', 'viewer')
      const shared = await b.listSharedProjects('bob')
      const byProject = Object.fromEntries(shared.map((s) => [s.projectId, s.role]))
      expect(byProject['p1']).toBe('editor')
      expect(byProject['p2']).toBe('viewer')
      expect(shared).toHaveLength(2)
    })
  })

  describe(`${label} — 分享链接:全态 + 跨项目防泄漏`, () => {
    let b: PermissionBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
      await seedProject(b, 'p1', 'ownerA')
      await seedProject(b, 'p2', 'ownerA')
    })

    it('createShareLink:token 密码学随机(>20 chars);permission/revokedAt/expiresAt 字段', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      expect(link.token.length).toBeGreaterThan(20)
      expect(link.projectId).toBe('p1')
      expect(link.permission).toBe('view')
      expect(link.createdBy).toBe('ownerA')
      expect(link.revokedAt).toBeNull()
      expect(link.expiresAt).toBeNull()
    })

    it('resolveShareLink:active → {kind,permission};未知 token → undefined;跨项目 → undefined(无泄漏)', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      expect(await b.resolveShareLink(link.token, 'p1')).toEqual({ kind: 'active', permission: 'view' })
      expect(await b.resolveShareLink('nonexistent-token-xxx', 'p1')).toBe(undefined) // 未知 → undefined
      expect(await b.resolveShareLink(link.token, 'p2')).toBe(undefined) // 跨项目 → undefined(无泄漏)
    })

    it('resolveShareLinkByToken:active 返 projectId+permission;未知 → undefined', async () => {
      const link = await b.createShareLink('p1', 'edit', 'ownerA')
      expect(await b.resolveShareLinkByToken(link.token)).toEqual({ kind: 'active', projectId: 'p1', permission: 'edit' })
      expect(await b.resolveShareLinkByToken('nonexistent-token-xxx')).toBe(undefined)
    })

    it('listShareLinks:返 project 全部 links(含 revoked)', async () => {
      const l1 = await b.createShareLink('p1', 'view', 'ownerA')
      const l2 = await b.createShareLink('p1', 'edit', 'ownerA')
      await b.revokeShareLink(l1.id, 'p1')
      const links = await b.listShareLinks('p1')
      expect(links.map((l) => l.id).sort()).toEqual([l1.id, l2.id].sort())
      const revoked = links.find((l) => l.id === l1.id)!
      expect(revoked.revokedAt).toBeTruthy()
    })

    it('revokeShareLink:ok(link.revokedAt 非空);再 revoke → already-revoked', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      const r = await b.revokeShareLink(link.id, 'p1')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.link.revokedAt).toBeTruthy()
      const r2 = await b.revokeShareLink(link.id, 'p1')
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.reason).toBe('already-revoked')
    })

    it('revokeShareLink:未知 linkId → not-found;跨项目 linkId → not-found(无泄漏)', async () => {
      const r = await b.revokeShareLink('nonexistent-link-id', 'p1')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('not-found')
      // p2 的 link 用 p1 URL revoke → not-found(防 A 吊销 B 的 link)
      const p2Link = await b.createShareLink('p2', 'view', 'ownerA')
      const cross = await b.revokeShareLink(p2Link.id, 'p1')
      expect(cross.ok).toBe(false)
      if (!cross.ok) expect(cross.reason).toBe('not-found')
      // 原 p2 link 仍活
      expect((await b.resolveShareLink(p2Link.token, 'p2'))?.kind).toBe('active')
    })

    it('unRevokeShareLink:revoke → un-revoke(ok,revokedAt=null);未 revoke 幂等 ok', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeShareLink(link.id, 'p1')
      const r = await b.unRevokeShareLink(link.id, 'p1')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.link.revokedAt).toBeNull()
      // active link un-revoke 幂等(内存:revokedAt 已 null → ok;PG:UPDATE 返行 → ok)
      const r2 = await b.unRevokeShareLink(link.id, 'p1')
      expect(r2.ok).toBe(true)
    })

    it('unRevokeShareLink:revoke 超 30 天 → window-closed;跨项目 → not-found', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeShareLink(link.id, 'p1')
      // 模拟 revoke 已超 30 天(对偶 helper 直接改 revokedAt)
      const oldIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      expect(await setLinkRevokedAt(b, link.id, oldIso)).toBe(true)
      const r = await b.unRevokeShareLink(link.id, 'p1')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('window-closed')
      // 跨项目 → not-found
      const r2 = await b.unRevokeShareLink(link.id, 'p2')
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.reason).toBe('not-found')
    })
  })

  describe(`${label} — FX-7 级联:revokeAllForProject / unRevokeAllForProject + 30 天窗`, () => {
    let b: PermissionBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
      await seedProject(b, 'p1', 'ownerA')
    })

    it('revokeAllForProject:仅 revoke 活的(已 revoked 不重复计数)', async () => {
      const l1 = await b.createShareLink('p1', 'view', 'ownerA') // 活
      const l2 = await b.createShareLink('p1', 'edit', 'ownerA') // 活
      const l3 = await b.createShareLink('p1', 'view', 'ownerA') // 活 → 先 revoke
      await b.revokeShareLink(l3.id, 'p1') // l3 已 revoked
      const { count } = await b.revokeAllForProject('p1')
      expect(count).toBe(2) // 仅 l1/l2(活的);l3 已 revoked 不重复计数
      // 全部 revoked(l1/l2 被 revokeAll 标记;l3 保持 revoked)
      const links = await b.listShareLinks('p1')
      const byId = Object.fromEntries(links.map((l) => [l.id, l.revokedAt]))
      expect(byId[l1.id]).toBeTruthy()
      expect(byId[l2.id]).toBeTruthy()
      expect(byId[l3.id]).toBeTruthy()
    })

    it('unRevokeAllForProject:仅恢复 30 天窗内 cascade 标记的;超期/手工 revoked 保持 revoked', async () => {
      const l1 = await b.createShareLink('p1', 'view', 'ownerA')
      const l2 = await b.createShareLink('p1', 'edit', 'ownerA')
      const l3 = await b.createShareLink('p1', 'view', 'ownerA')
      // 级联 revoke(project 软删级联 → 置 cascade_revoked_at marker;restore 补偿只动此标记非空的链接)
      const { count: revokedCount } = await b.revokeAllForProject('p1')
      expect(revokedCount).toBe(3)
      // l3 的 cascade marker 超 30 天(对偶 helper 直改 marker 时间;窗判定走 cascade_revoked_at)
      const oldIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      expect(await setLinkCascadeRevokedAt(b, l3.id, oldIso)).toBe(true)
      const { count } = await b.unRevokeAllForProject('p1')
      expect(count).toBe(2) // l1/l2 窗内恢复;l3 超 30 天不恢复
      // l3 仍 revoked;l1/l2 活
      const links = await b.listShareLinks('p1')
      const byId = Object.fromEntries(links.map((l) => [l.id, l.revokedAt]))
      expect(byId[l1.id]).toBeNull()
      expect(byId[l2.id]).toBeNull()
      expect(byId[l3.id]).toBeTruthy() // 超 30 天,仍 revoked
    })

    it('unRevokeAllForProject:不动手工 revoke(cascade_revoked_at IS NULL 永不恢复,防误恢复)', async () => {
      const l1 = await b.createShareLink('p1', 'view', 'ownerA')
      // 手工 revoke(revokeShareLink):置 revoked_at,cascade_revoked_at 保持 null
      await b.revokeShareLink(l1.id, 'p1')
      const { count } = await b.unRevokeAllForProject('p1')
      expect(count).toBe(0) // 手工 revoke 无 cascade marker → restore 补偿不动
      const links = await b.listShareLinks('p1')
      expect(links.find((l) => l.id === l1.id)!.revokedAt).toBeTruthy() // 仍 revoked
    })
  })

  describe(`${label} — P-6 saga 补偿:restore/delete 两步写第二步失败可重试收敛`, () => {
    let b: PermissionBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
      await seedProject(b, 'p1', 'ownerA')
    })

    it('attemptCompensation 无 pending → nothing-pending(不建意图,不跑 step)', async () => {
      const r = await b.attemptCompensation('p1', 'restore')
      expect(r).toEqual({ kind: 'nothing-pending', op: 'restore' })
      expect(await b.listCompensations('p1')).toEqual([])
    })

    it('recordCompensation 建 pending 意图;再 record 同 op 幂等返同一 pending(不重复)', async () => {
      const a = await b.recordCompensation('p1', 'restore')
      expect(a.status).toBe('pending')
      expect(a.attemptCount).toBe(0)
      expect(a.lastError).toBeNull()
      expect(a.lastAttemptedAt).toBeNull()
      const a2 = await b.recordCompensation('p1', 'restore')
      expect(a2.id).toBe(a.id) // 幂等:同 pending 不重复建
      expect(await b.listCompensations('p1')).toHaveLength(1)
    })

    it('restore:record + attempt → completed(unRevoke 级联跑);意图 done,attemptCount=1,链接恢复 active', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // 模拟 project 曾软删(级联 revoke,置 cascade marker)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked')
      await b.recordCompensation('p1', 'restore')
      const r = await b.attemptCompensation('p1', 'restore')
      expect(r.kind).toBe('completed')
      if (r.kind === 'completed') { expect(r.attempts).toBe(1); expect(r.count).toBe(1) }
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active')
      const ints = await b.listCompensations('p1')
      expect(ints[0].status).toBe('done')
      expect(ints[0].attemptCount).toBe(1)
      expect(ints[0].lastError).toBeNull()
      expect(ints[0].lastAttemptedAt).toBeTruthy()
    })

    it('restore:故障注入 unRevoke 抛错 → failed(意图 pending,链接仍 revoked);重试 → completed 收敛(无"永久 revoked"终态)', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // 级联 revoke(置 cascade marker)
      await b.recordCompensation('p1', 'restore')
      setCompensationFault(b, 'restore', 1) // 下次 attempt 的 step 强制失败 1 次(自减)
      const r1 = await b.attemptCompensation('p1', 'restore')
      expect(r1.kind).toBe('failed')
      if (r1.kind === 'failed') { expect(r1.attempts).toBe(1); expect(r1.error).toBeTruthy() }
      // 第二步失败 → 链接仍 revoked(未 unRevoke);意图 pending,可观察字段已更新
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked')
      let ints = await b.listCompensations('p1')
      expect(ints[0].status).toBe('pending')
      expect(ints[0].attemptCount).toBe(1)
      expect(ints[0].lastError).toBeTruthy()
      expect(ints[0].lastAttemptedAt).toBeTruthy()
      // 幂等重入 attempt:故障已自减为 0 → step 跑通 → 收敛(据 cascade marker 恢复)
      const r2 = await b.attemptCompensation('p1', 'restore')
      expect(r2.kind).toBe('completed')
      if (r2.kind === 'completed') expect(r2.attempts).toBe(2)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // 链接最终恢复
      ints = await b.listCompensations('p1')
      expect(ints[0].status).toBe('done')
      expect(ints[0].attemptCount).toBe(2)
      expect(ints[0].lastError).toBeNull()
    })

    it('restore:done 后再 attempt → nothing-pending(不重复跑,无 spurious)', async () => {
      await b.recordCompensation('p1', 'restore')
      await b.attemptCompensation('p1', 'restore') // completed
      const r = await b.attemptCompensation('p1', 'restore') // 已 done → 无 pending
      expect(r).toEqual({ kind: 'nothing-pending', op: 'restore' })
    })

    it('delete:故障注入 revoke 抛错 → failed(链接仍 active);重试 → completed 收敛(链接最终 revoked)', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active')
      // R3-F1: delete primary(softDelete)已提交 → is_deleted=true(delete 是 durable desired state)。
      //   无此步 PG is_deleted 仍 false → gate 判 delete stale(矛盾 restore)→ 误拦。memory no-op(走 hasSuperseded)。
      await setProjectDeleted(b, 'p1', true)
      await b.recordCompensation('p1', 'delete')
      setCompensationFault(b, 'delete', 1)
      const r1 = await b.attemptCompensation('p1', 'delete')
      expect(r1.kind).toBe('failed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // revoke 失败 → 仍 active
      const r2 = await b.attemptCompensation('p1', 'delete')
      expect(r2.kind).toBe('completed')
      if (r2.kind === 'completed') expect(r2.count).toBe(1)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked') // 最终 revoked
      const ints = await b.listCompensations('p1')
      expect(ints[0].status).toBe('done')
    })

    it('listCompensations:newest first;restore + delete 多 op 共存', async () => {
      await b.recordCompensation('p1', 'restore')
      await b.recordCompensation('p1', 'delete')
      const ints = await b.listCompensations('p1')
      expect(ints).toHaveLength(2)
      expect(ints[0].op).toBe('delete') // 后建的 delete 排前(newest first)
      expect(ints[1].op).toBe('restore')
    })

    it('P1-2 supersede:record delete 后,旧 pending restore 被 mark superseded(sweep/attempt 不再处理旧 restore)', async () => {
      await b.recordCompensation('p1', 'restore') // gen1 pending restore
      await b.recordCompensation('p1', 'delete') // gen2 pending delete + supersede restore
      const ints = await b.listCompensations('p1')
      const restore = ints.find((i) => i.op === 'restore')!
      const del = ints.find((i) => i.op === 'delete')!
      expect(restore.status).toBe('superseded')
      expect(del.status).toBe('pending')
      expect(del.generation).toBeGreaterThan(restore.generation)
      // listPending 只返 pending(superseded 不进 pending 信号)
      const pending = await b.listPendingCompensations('p1')
      expect(pending).toHaveLength(1)
      expect(pending[0].op).toBe('delete')
    })

    it('P2-1 并发 attempt:恰一个 claim,输家返 already-claimed(attemptCount 与真实 claim 一致)', async () => {
      // 建 pending restore 意图 + cascade marker(让 attempt 有活可干且 await 点让出并发窗口)
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1')
      await b.recordCompensation('p1', 'restore')
      const [a, b2] = await Promise.all([
        b.attemptCompensation('p1', 'restore'),
        b.attemptCompensation('p1', 'restore'),
      ])
      const outcomes = [a, b2].map((o) => o.kind).sort()
      // 一个 completed(赢家 claim+跑通),一个 already-claimed(输家)
      expect(outcomes).toEqual(['already-claimed', 'completed'])
      const ints = await b.listCompensations('p1')
      // attemptCount 与真实 claim 一致(输家不 bump)
      expect(ints[0].attemptCount).toBe(1)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active')
    })

    it('P1-2 sweep:制造 pending 后(零用户 attempt)→ sweepCompensations 自动 done 收敛', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // cascade marker
      await b.recordCompensation('p1', 'restore') // pending,无人 attempt
      expect((await b.listPendingCompensations('p1'))).toHaveLength(1)
      const r = await b.sweepCompensations()
      expect(r.processed).toBe(1)
      expect(r.converged).toBe(1)
      expect(r.failed).toBe(0)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active')
      const ints = await b.listCompensations('p1')
      expect(ints[0].status).toBe('done')
      expect(await b.listPendingCompensations('p1')).toHaveLength(0)
    })

    // R3-F1 双向晚到 retry 验收(R2 finding 1 核心):晚到的 attemptCompensation(op) 不得仅凭 compensationNeed
    // 重建旧 op intent——那会把更新代际对立 op 的终态翻转回来(已删项目重开链接 / 已恢复项目再吊销)。
    // stale op 必须返回 superseded,不执行副作用;最终链接状态跟随最新代际(primary desired state)。
    // PG: setProjectDeleted 模拟 primary(is_deleted ground truth);memory: no-op(走 hasSuperseded,gen1 被 gen2 supersede)。
    it('R3-F1① restore-fail→delete→晚 restore retry:终态跟随 delete(revoked),不翻转回 active', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // 模拟 project 曾软删(级联 revoke,置 cascade marker;link revoked)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked')
      // restore 首次失败(primary 已 restore → is_deleted=false)
      await setProjectDeleted(b, 'p1', false)
      await b.recordCompensation('p1', 'restore') // gen1 restore pending
      setCompensationFault(b, 'restore', 1)
      const r1 = await b.attemptCompensation('p1', 'restore') // failed(step 故障)
      expect(r1.kind).toBe('failed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked') // 仍 revoked(未 unRevoke)
      // delete 新代际完成(primary softDelete → is_deleted=true);gen2 supersede gen1
      await setProjectDeleted(b, 'p1', true)
      await b.recordCompensation('p1', 'delete')
      const r2 = await b.attemptCompensation('p1', 'delete') // completed(link 已 revoked,count=0)
      expect(r2.kind).toBe('completed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked') // before: revoked(最新代际 delete)
      // 晚到 restore retry —— 必须 NOT 翻转回 active(跟随最新代际 delete)
      const r3 = await b.attemptCompensation('p1', 'restore')
      expect(r3.kind).toBe('superseded') // FIX:不再 completed
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked') // after: 仍 revoked
      // 无副作用:未新建 stale restore 意图(intent 数仍是 delete gen2 + 历史 gen1)
      const ints = await b.listCompensations('p1')
      expect(ints.filter((i) => i.op === 'restore' && i.status === 'pending')).toHaveLength(0)
    })

    it('R3-F1② delete-fail→restore→晚 delete retry:终态跟随 restore(active),不翻转回 revoked', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA') // active
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active')
      // delete 首次失败(primary softDelete → is_deleted=true)
      await setProjectDeleted(b, 'p1', true)
      await b.recordCompensation('p1', 'delete') // gen1 delete pending
      setCompensationFault(b, 'delete', 1)
      const r1 = await b.attemptCompensation('p1', 'delete') // failed(revoke 故障)
      expect(r1.kind).toBe('failed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // 仍 active(revoke 未跑)
      // restore 新代际完成(primary restore → is_deleted=false);gen2 supersede gen1
      await setProjectDeleted(b, 'p1', false)
      await b.recordCompensation('p1', 'restore')
      const r2 = await b.attemptCompensation('p1', 'restore') // completed(link active,无 cascade marker,count=0)
      expect(r2.kind).toBe('completed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // before: active(最新代际 restore)
      // 晚到 delete retry —— 必须 NOT 翻转回 revoked(跟随最新代际 restore)
      const r3 = await b.attemptCompensation('p1', 'delete')
      expect(r3.kind).toBe('superseded') // FIX:不再 completed
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // after: 仍 active
      const ints = await b.listCompensations('p1')
      expect(ints.filter((i) => i.op === 'delete' && i.status === 'pending')).toHaveLength(0)
    })

    // R3-F2 验收:sweep 超限放弃 → 'failed' dead-letter(不再伪装 done);listFailedCompensations 可见;
    //   getCompensationCounts 暴露 pending+failed;failed 不占 partial unique 槽 → 新 primary record 可重开收敛。
    it('R3-F2: sweep 超限放弃 → failed dead-letter(非 done);counts 暴露;重开路径收敛', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // cascade marker,link revoked(模拟 project 曾软删)
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked')
      // restore primary(is_deleted=false;memory no-op)
      await setProjectDeleted(b, 'p1', false)
      await b.recordCompensation('p1', 'restore') // gen1 pending
      // 注入 10 次故障,逐次 attempt 凑满 MAX_SWEEP_ATTEMPTS(每次失败 bump attemptCount,保持 pending,link 仍 revoked)
      setCompensationFault(b, 'restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
      for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) {
        const r = await b.attemptCompensation('p1', 'restore')
        expect(r.kind).toBe('failed')
      }
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked') // 仍错误(未收敛)
      // sweep:attemptCount(10) >= MAX → 放弃标 failed(R3-F2:不再 done)
      const sw = await b.sweepCompensations()
      expect(sw.failed).toBe(1)
      const ints = await b.listCompensations('p1')
      expect(ints[0].status).toBe('failed')
      expect(ints[0].lastError).toBeTruthy()
      expect(ints.filter((i) => i.status === 'done')).toHaveLength(0) // 关键:无假 done
      // listFailedCompensations 可见(可告警的未收敛事实)
      expect(await b.listFailedCompensations('p1')).toHaveLength(1)
      const counts = await b.getCompensationCounts()
      expect(counts.failed).toBe(1)
      expect(counts.pending).toBe(0)
      // 重开路径:故障已自减为 0(failed 行不占 partial unique 槽)→ 新 primary record 新 pending → attempt 收敛
      const again = await b.recordCompensation('p1', 'restore') // gen2 新 pending(failed gen1 不阻塞)
      expect(again.status).toBe('pending')
      expect(again.generation).toBe(2)
      const r = await b.attemptCompensation('p1', 'restore') // 故障已清 → completed
      expect(r.kind).toBe('completed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // 收敛
      // R5-F2 闭环:重开并 completed 后,旧 failed 历史行不再计入当前未收敛 → counts.failed=0(可用性恢复)。
      //   未修复:旧 failed 永久计入 → counts.failed=1(永久 503,即使已由新 generation 收敛)。
      const counts2 = await b.getCompensationCounts()
      expect(counts2.pending).toBe(0)
      expect(counts2.failed).toBe(0) // FIX:重开收敛后 failed 归零(readiness 恢复)
    })

    // R5-F2 闭环(R4 verdict Step 8 暴露的 P1 阻断):dead-letter 后即使重开新 generation 并收敛,旧 failed
    //   历史行仍永久计入 getCompensationCounts → /readyz 永久 503。修复:新 generation record 时把同 project
    //   较旧 failed 标 superseded(保留历史于 listCompensations,不计当前未收敛)。验收三态:failed→reopen→completed→恢复。
    it('R5-F2 闭环:failed→reopen gen2→completed→counts.failed=0(可用性恢复,历史仍可审计)', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // cascade marker,link revoked
      await setProjectDeleted(b, 'p1', false) // restore desired
      await b.recordCompensation('p1', 'restore') // gen1 pending
      // dead-letter:MAX 次故障 → sweep 超限放弃 → failed
      setCompensationFault(b, 'restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
      for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) {
        await b.attemptCompensation('p1', 'restore')
      }
      const sw = await b.sweepCompensations()
      expect(sw.failed).toBe(1)
      const countsBefore = await b.getCompensationCounts()
      expect(countsBefore.failed).toBe(1) // dead-letter 未收敛
      expect(countsBefore.pending).toBe(0)
      // 故障解除 → 重开 gen2(record 时把旧 failed gen1 标 superseded)→ attempt completed
      const again = await b.recordCompensation('p1', 'restore')
      expect(again.generation).toBe(2)
      const countsMid = await b.getCompensationCounts()
      expect(countsMid.failed).toBe(0) // 旧 failed 已被新 generation supersede,不计当前
      expect(countsMid.pending).toBe(1) // gen2 在途
      const r = await b.attemptCompensation('p1', 'restore')
      expect(r.kind).toBe('completed')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // 收敛
      // 恢复:counts.failed=0(不再 503);历史仍可审计(listCompensations 含 failed→superseded 行)
      const countsAfter = await b.getCompensationCounts()
      expect(countsAfter.failed).toBe(0)
      expect(countsAfter.pending).toBe(0)
      const ints = await b.listCompensations('p1')
      const gen1 = ints.find((i) => i.generation === 1)!
      expect(gen1.status).toBe('superseded') // 历史保留,但不再计为 failed
      expect(ints.filter((i) => i.status === 'failed')).toHaveLength(0) // 当前无 failed
    })

    it('R5-F2 重开再失败仍 503:gen2 重开→再 dead-letter → counts.failed=1(仅最新 failed 计数)', async () => {
      await b.createShareLink('p1', 'view', 'ownerA') // 建 link 供级联 revoke(本测只验 counts,不解析 link)
      await b.revokeAllForProject('p1')
      await setProjectDeleted(b, 'p1', false)
      await b.recordCompensation('p1', 'restore') // gen1
      setCompensationFault(b, 'restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
      for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) await b.attemptCompensation('p1', 'restore')
      await b.sweepCompensations() // gen1 failed
      expect((await b.getCompensationCounts()).failed).toBe(1)
      // 重开 gen2(record supersede gen1 failed)→ gen2 也失败(故障未解除)
      setCompensationFault(b, 'restore', COMPENSATION_MAX_SWEEP_ATTEMPTS) // gen2 仍故障
      await b.recordCompensation('p1', 'restore') // gen2 pending,supersede gen1
      expect((await b.getCompensationCounts()).failed).toBe(0) // gen1 已 supersede,gen2 在途
      for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) await b.attemptCompensation('p1', 'restore')
      const sw2 = await b.sweepCompensations() // gen2 failed
      expect(sw2.failed).toBe(1)
      const counts = await b.getCompensationCounts()
      expect(counts.failed).toBe(1) // 仅 gen2(最新 failed)计数;gen1 已 superseded 不重复计
      expect(counts.pending).toBe(0)
    })

    it('R5-F2 多 project:仅未收敛 project 计 failed;p1 重开收敛后 failed=0,p2 不受影响', async () => {
      await seedProject(b, 'p2', 'ownerA')
      // p1 dead-letter
      const link1 = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1')
      await setProjectDeleted(b, 'p1', false)
      await b.recordCompensation('p1', 'restore')
      setCompensationFault(b, 'restore', COMPENSATION_MAX_SWEEP_ATTEMPTS)
      for (let i = 0; i < COMPENSATION_MAX_SWEEP_ATTEMPTS; i++) await b.attemptCompensation('p1', 'restore')
      await b.sweepCompensations() // p1 gen1 failed
      // p2 正常完成(无 dead-letter)
      const link2 = await b.createShareLink('p2', 'view', 'ownerA')
      await b.revokeAllForProject('p2')
      await setProjectDeleted(b, 'p2', false)
      await b.recordCompensation('p2', 'restore')
      const r2 = await b.attemptCompensation('p2', 'restore')
      expect(r2.kind).toBe('completed')
      expect((await b.resolveShareLink(link2.token, 'p2'))?.kind).toBe('active')
      let counts = await b.getCompensationCounts()
      expect(counts.failed).toBe(1) // 仅 p1
      expect(counts.pending).toBe(0)
      // p1 重开收敛 → failed 归零(p2 从未 failed)
      const again = await b.recordCompensation('p1', 'restore')
      expect(again.generation).toBe(2)
      const r1 = await b.attemptCompensation('p1', 'restore')
      expect(r1.kind).toBe('completed')
      expect((await b.resolveShareLink(link1.token, 'p1'))?.kind).toBe('active')
      counts = await b.getCompensationCounts()
      expect(counts.failed).toBe(0) // p1 收敛后全局 failed=0
      expect(counts.pending).toBe(0)
    })

    // R5-F1 TOCTOU(R4 加压暴露的 P1 阻断):durable desired state 在 claim 后、side effect 前翻转
    //   (primary ensureCreate/softDelete 先于 recordCompensation 提交 → 两步写固有窗口:primary 提交后、
    //    record 前崩溃/延迟)→ 旧 op 不得执行副作用;须 superseded 返回,终态跟随最新 durable desired state。
    //   复现:claim(token_A)→ 暂停 → 翻转 is_deleted(primary 已提交、record 前崩溃)→ 释放 → 旧 worker 须不执行副作用。
    //   PG:claim 是已提交 UPDATE,暂停后用 __setProjectDeletedForTest 翻 projects.is_deleted(另一连接提交);
    //     修复后 critical trx SELECT...FOR UPDATE 重读 is_deleted → stale → 不执行副作用。
    //   memory:claim 同步置 token 后暂停(__setClaimPauseForTest);__setProjectDeletedForTest 翻 memory is_deleted map;
    //     修复后 claim 后重读 is_deleted → stale → 不执行副作用。双向(restore/delete)对偶。
    it('R5-F1① restore TOCTOU:claim 后 is_deleted 翻 true → superseded,不 unRevoke,link 仍 revoked', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeAllForProject('p1') // 级联 revoke(置 cascade marker),link revoked
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked')
      // restore primary 已提交(is_deleted=false;memory 注入,PG 翻 projects.is_deleted)
      await setProjectDeleted(b, 'p1', false)
      await b.recordCompensation('p1', 'restore') // gen1 pending restore
      // A: claim(token_A)→ 暂停在 side effect 前(模拟 primary 在 record 前崩溃的 TOCTOU 窗口)
      let resolvePause!: () => void
      const pausePromise = new Promise<void>((r) => { resolvePause = r })
      setClaimPause(b, 'restore', () => pausePromise)
      const aPromise = b.attemptCompensation('p1', 'restore')
      // 等 claim_token 落库(memory 同步即有;PG claim 是异步 UPDATE,需轮询)
      for (let i = 0; i < 200; i++) {
        const r = await b.listCompensations('p1')
        if (r.find((x) => x.op === 'restore')?.claimToken) break
        await new Promise((rr) => setTimeout(rr, 5))
      }
      // 翻转 durable desired state:primary delete 已提交(is_deleted=true),但 record 前崩溃 → 无 delete intent
      await setProjectDeleted(b, 'p1', true)
      // 释放 pause;A 恢复 —— 修复后须 superseded(不执行 unRevoke);未修复则 completed(把已删项目 link 翻 active)
      resolvePause()
      const a = await aPromise
      expect(a.kind).toBe('superseded') // FIX:不再 completed
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('revoked') // link 仍 revoked(未 unRevoke)
      const ints = await b.listCompensations('p1')
      const restore = ints.find((i) => i.op === 'restore')!
      expect(restore.status).toBe('superseded')
      expect(restore.attemptCount).toBe(0) // 不 bump(未执行副作用)
    })

    it('R5-F1② delete TOCTOU:claim 后 is_deleted 翻 false → superseded,不 revoke,link 仍 active', async () => {
      const link = await b.createShareLink('p1', 'view', 'ownerA')
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active')
      // delete primary 已提交(is_deleted=true)
      await setProjectDeleted(b, 'p1', true)
      await b.recordCompensation('p1', 'delete') // gen1 pending delete
      let resolvePause!: () => void
      const pausePromise = new Promise<void>((r) => { resolvePause = r })
      setClaimPause(b, 'delete', () => pausePromise)
      const aPromise = b.attemptCompensation('p1', 'delete')
      for (let i = 0; i < 200; i++) {
        const r = await b.listCompensations('p1')
        if (r.find((x) => x.op === 'delete')?.claimToken) break
        await new Promise((rr) => setTimeout(rr, 5))
      }
      // primary restore 已提交(is_deleted=false),record 前崩溃 → 无 restore intent;旧 delete 不得把 link 翻 revoked
      await setProjectDeleted(b, 'p1', false)
      resolvePause()
      const a = await aPromise
      expect(a.kind).toBe('superseded') // FIX:不再 completed
      expect((await b.resolveShareLink(link.token, 'p1'))?.kind).toBe('active') // link 仍 active(未 revoke)
      const ints = await b.listCompensations('p1')
      const del = ints.find((i) => i.op === 'delete')!
      expect(del.status).toBe('superseded')
      expect(del.attemptCount).toBe(0)
    })
  })
}

// ── memory 后端(永远跑)──────────────────────────────────────────────────────────────
runPermissionBackendContractSuite(
  'memory PermissionBackend',
  () => new InMemoryPermissionBackend(),
  (b) => b.__reset(),
  // memory 无 FK → seedProject no-op
  () => {},
  (b, id, iso) => (b as InMemoryPermissionBackend).__setLinkRevokedAtForTest(id, iso),
  (b, id, iso) => (b as InMemoryPermissionBackend).__setLinkCascadeRevokedAtForTest(id, iso),
  (b, op, n) => (b as InMemoryPermissionBackend).__setCompensationFaultForTest(op, n),
  // memory 无 projects 表 → R5-F1:__setProjectDeletedForTest 现已实(memory projectDeleted map),与 PG 对偶
  (b, pid, d) => (b as InMemoryPermissionBackend).__setProjectDeletedForTest(pid, d),
  (b, op, fn) => (b as InMemoryPermissionBackend).__setClaimPauseForTest(op, fn),
)

// ── PG 后端(gate:MIVO_PG_TEST=1;本地 brew PG port 55443)─────────────────────────────────
const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'
let pgPermBackend: PgPermissionBackend | undefined

;(PG_TEST_ENABLED ? describe : describe.skip)('PG PermissionBackend(双后端等价性)', () => {
  beforeAll(async () => {
    pgPermBackend = new PgPermissionBackend({
      host: process.env.MIVO_PG_HOST || '127.0.0.1',
      port: Number(process.env.MIVO_PG_PORT || 55443),
      database: process.env.MIVO_PG_UNIT_DB || 'mivocanvas_unit',
      user: process.env.MIVO_PG_USER || 'mivo',
      password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
      maxConnections: 5,
      idleTimeoutMs: 5000,
    })
    await pgPermBackend.migrate()
    await pgPermBackend.ready
  })
  afterAll(async () => {
    if (pgPermBackend) await pgPermBackend.destroy()
  })
  runPermissionBackendContractSuite(
    'PG PermissionBackend',
    () => {
      if (!pgPermBackend) throw new Error('pg permission backend not initialized')
      return pgPermBackend
    },
    (b) => b.__reset(),
    (b, pid, owner) => (b as PgPermissionBackend).__seedProjectForTest(pid, owner),
    (b, id, iso) => (b as PgPermissionBackend).__setLinkRevokedAtForTest(id, iso),
    (b, id, iso) => (b as PgPermissionBackend).__setLinkCascadeRevokedAtForTest(id, iso),
    (b, op, n) => (b as PgPermissionBackend).__setCompensationFaultForTest(op, n),
    (b, pid, d) => (b as PgPermissionBackend).__setProjectDeletedForTest(pid, d),
    (b, op, fn) => (b as PgPermissionBackend).__setClaimPauseForTest(op, fn),
  )
})
