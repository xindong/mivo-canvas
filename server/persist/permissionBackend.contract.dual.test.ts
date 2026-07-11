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
} from '../lib/permissions'
import { PgPermissionBackend } from './pgPermissionBackend'

// ── 共享纯契约套件(makeBackend 返 fresh/singleton;resetBackend 清状态;seedProject 供 PG FK;setLinkRevokedAt 测 30 天窗)──
const runPermissionBackendContractSuite = (
  label: string,
  makeBackend: () => PermissionBackend,
  resetBackend: (b: PermissionBackend) => void | Promise<void>,
  seedProject: (b: PermissionBackend, projectId: string, ownerId: string) => void | Promise<void>,
  setLinkRevokedAt: (b: PermissionBackend, linkId: string, revokedAtIso: string) => boolean | Promise<boolean>,
  setCompensationFault: (b: PermissionBackend, op: CompensationOp, throwCount: number) => void,
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

    it('unRevokeAllForProject:仅恢复 30 天窗内的 revoked;超期保持 revoked', async () => {
      const l1 = await b.createShareLink('p1', 'view', 'ownerA')
      const l2 = await b.createShareLink('p1', 'edit', 'ownerA')
      const l3 = await b.createShareLink('p1', 'view', 'ownerA')
      await b.revokeShareLink(l1.id, 'p1') // 窗内(刚 revoke)
      await b.revokeShareLink(l2.id, 'p1')
      await b.revokeShareLink(l3.id, 'p1')
      // l3 超 30 天
      const oldIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      expect(await setLinkRevokedAt(b, l3.id, oldIso)).toBe(true)
      const { count } = await b.unRevokeAllForProject('p1')
      expect(count).toBe(2) // l1/l2 窗内恢复;l3 超期不恢复
      // l3 仍 revoked;l1/l2 活
      const links = await b.listShareLinks('p1')
      const byId = Object.fromEntries(links.map((l) => [l.id, l.revokedAt]))
      expect(byId[l1.id]).toBeNull()
      expect(byId[l2.id]).toBeNull()
      expect(byId[l3.id]).toBeTruthy() // 超 30 天,仍 revoked
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
      await b.revokeShareLink(link.id, 'p1') // 模拟 project 曾软删(链接 revoked)
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
      await b.revokeShareLink(link.id, 'p1')
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
      // 幂等重入 attempt:故障已自减为 0 → step 跑通 → 收敛
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
  (b, op, n) => (b as InMemoryPermissionBackend).__setCompensationFaultForTest(op, n),
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
    (b, op, n) => (b as PgPermissionBackend).__setCompensationFaultForTest(op, n),
  )
})
