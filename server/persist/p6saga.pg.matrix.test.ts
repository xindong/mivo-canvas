// server/persist/p6saga.pg.matrix.test.ts
// P-6 saga 返修 PG 专属验收(P1-3 并发 + P1-4 迁移矩阵)。gate:MIVO_PG_TEST=1。
// 隔离库 mivocanvas_unit_p6saga(lead 指定;与 dual contract suite 的 mivocanvas_unit 分离,防并发 worktree 污染)。
//
// P1-4 矩阵(合并 origin/main 后 combined registry = 001..007):DP-6R 占 003_chat_per_actor + 004_chat_order_revisions,
//  saga 占 005_share_link_compensations + 006_compensation_failed_status + 007_compensation_claim_token。
//  - fresh combined:001..007 全量 migrateToLatest 绿,表/列/索引齐,kysely_migration 精确单调(7 行)。
//  - chat-applied→combined:模拟 001→004 已 tracked,migrateToLatest 追加 005/006/007,kysely_migration 精确单调(001<002<003<004<005<006<007)。
// P1-3:真 PG Promise.all 并发 record 20 次 → 恰 1 条 pending(partial unique + advisory_xact_lock);done 后可再建。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { migrations } from './migrations'
import { PgPermissionBackend } from './pgPermissionBackend'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'

const cfg = {
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_UNIT_DB_P6SAGA || 'mivocanvas_unit_p6saga',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
  maxConnections: 10,
  idleTimeoutMs: 5000,
}

const makeKysely = () =>
  new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: new Pool(cfg) }),
  })

const resetSchema = async (db: Kysely<Record<string, never>>): Promise<void> => {
  await sql`DROP SCHEMA IF EXISTS public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
}

const migrateWith = async (
  db: Kysely<Record<string, never>>,
  subset: Record<string, unknown>,
): Promise<void> => {
  const m = new Migrator({ db, provider: { async getMigrations() { return subset as never } } })
  const r = await m.migrateToLatest()
  if (r.error) throw r.error
}

// R3-F3 矩阵去伪造(2026-07-12 R2 finding 3):原矩阵自造 mChat003/mChatOrder004 并登记为
// 2026_07_12_003_chat_per_user(错名),实际 DP-6R 8aa1f2b 的 registry 名是 2026_07_12_003_chat_per_actor;
// 测试内伪 registry 自洽但未验证实际 combined registry(假阳性)。现改用真实生产 `migrations` registry,
// 禁测试内占位 migration。
// 合并 origin/main 后,combined registry 自然含 003/004/005/006/007(本分支已与 DP-6R 收敛),
// 故 fresh + combined 两路径均在本测试实跑(下方),不再有 merge-time 缺口。

;(PG_TEST_ENABLED ? describe : describe.skip)('P-6 saga PG:迁移矩阵(P1-4)+ 并发(P1-3)', () => {
  it('R3-F3 fresh combined registry:001..007 全量 migrateToLatest 绿,表/列/索引齐,kysely_migration 精确单调', async () => {
    const db = makeKysely()
    await resetSchema(db)
    // 真实生产 combined registry(合并 DP-6R 后):001+002+003+004+005+006+007。禁测试内占位 migration。
    await migrateWith(db, migrations)
    // compensations 表 R3 列(P1-2 generation/claimed + R3-F4 claim_token)
    const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='share_link_compensations' ORDER BY column_name`.execute(db)).rows as { column_name: string }[]
    const names = cols.map((r) => r.column_name)
    expect(names).toContain('generation')
    expect(names).toContain('claimed_at')
    expect(names).toContain('claimed_until')
    expect(names).toContain('claim_token') // R3-F4(007 加列)
    // status CHECK 含 'superseded'(P1-2:005)+ 'failed'(R3-F2:006)
    const chk = (await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='share_link_compensations'::regclass AND contype='c'`.execute(db)).rows as { def: string }[]
    expect(chk.some((r) => r.def.includes('superseded'))).toBe(true)
    expect(chk.some((r) => r.def.includes('failed'))).toBe(true)
    // share_links.cascade_revoked_at(P-6 marker,005 ALTER 加)
    const sl = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='share_links' AND column_name='cascade_revoked_at'`.execute(db)).rows as { column_name: string }[]
    expect(sl).toHaveLength(1)
    // partial unique index
    const idx = (await sql`SELECT indexname FROM pg_indexes WHERE tablename='share_link_compensations'`.execute(db)).rows as { indexname: string }[]
    expect(idx.map((r) => r.indexname)).toContain('uq_compensations_pending_project_op')
    // kysely_migration 精确单调:combined registry 全 7 行(001<002<003<004<005<006<007)
    const applied = (await sql`SELECT name FROM kysely_migration ORDER BY name`.execute(db)).rows as { name: string }[]
    expect(applied.map((r) => r.name)).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_actor',
      '2026_07_12_004_chat_order_revisions',
      '2026_07_12_005_share_link_compensations',
      '2026_07_12_006_compensation_failed_status',
      '2026_07_12_007_compensation_claim_token',
    ])
    // combined registry 确含 003/004(合并 DP-6R 收敛)
    expect(Object.keys(migrations).sort()).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_actor',
      '2026_07_12_004_chat_order_revisions',
      '2026_07_12_005_share_link_compensations',
      '2026_07_12_006_compensation_failed_status',
      '2026_07_12_007_compensation_claim_token',
    ])
    await db.destroy()
  })

  // R3-F3 combined DP-6R 路径(真实 001→004 tracked → 追加 005/006/007):合并 origin/main 后 combined
  //   registry 含 003_chat_per_actor + 004_chat_order_revisions,本测实跑真实 combined。
  it('R3-F3 combined DP-6R 路径:001→004 已 tracked → 追加 005/006/007,kysely_migration 精确单调', async () => {
    const db = makeKysely()
    await resetSchema(db)
    // 模拟 DP-6R 已应用库:先 migrate 真实 001+002+003+004(DP-6R 003/004)
    const dp6rSubset = Object.fromEntries(
      Object.entries(migrations).filter(([k]) => k <= '2026_07_12_004_chat_order_revisions'),
    )
    await migrateWith(db, dp6rSubset)
    let applied = (await sql`SELECT name FROM kysely_migration ORDER BY name`.execute(db)).rows as { name: string }[]
    expect(applied.map((r) => r.name)).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_actor',
      '2026_07_12_004_chat_order_revisions',
    ])
    // 005 表此时不存在(仅 004 applied)
    const before = (await sql`SELECT to_regclass('share_link_compensations') AS r`.execute(db)).rows as { r: string | null }[]
    expect(before[0].r).toBeNull()
    // migrateToLatest 用完整 combined registry:识别 001→004 已 tracked,追加 005/006/007
    await migrateWith(db, migrations)
    applied = (await sql`SELECT name FROM kysely_migration ORDER BY name`.execute(db)).rows as { name: string }[]
    expect(applied.map((r) => r.name)).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_actor',
      '2026_07_12_004_chat_order_revisions',
      '2026_07_12_005_share_link_compensations',
      '2026_07_12_006_compensation_failed_status',
      '2026_07_12_007_compensation_claim_token',
    ])
    // 005 表+列齐(share_link_compensations / cascade_revoked_at / claim_token)
    const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='share_link_compensations' ORDER BY column_name`.execute(db)).rows as { column_name: string }[]
    const names = cols.map((r) => r.column_name)
    expect(names).toContain('generation')
    expect(names).toContain('claim_token')
    expect(names).toContain('claimed_until')
    // share_links.cascade_revoked_at(005 ALTER 加)
    const sl = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='share_links' AND column_name='cascade_revoked_at'`.execute(db)).rows as { column_name: string }[]
    expect(sl).toHaveLength(1)
    await db.destroy()
  })

  describe('P1-3 并发 record(PgPermissionBackend)', () => {
    let backend: PgPermissionBackend
    beforeAll(async () => {
      // 隔离:本库可能被上方 fresh/combined 用例留下 tracked 行,先 reset schema 再建 backend。
      // backend.ready→migrate() 带 combined registry(001..007),clean 库下全量 migrate 无 missing。
      const admin = makeKysely()
      await resetSchema(admin)
      await admin.destroy()
      backend = new PgPermissionBackend(cfg)
      await backend.ready
    })
    afterAll(async () => {
      if (backend) await backend.destroy()
    })

    it('真 PG Promise.all 并发 record 20 次 → 恰 1 条 pending', async () => {
      await backend.__reset()
      await backend.__seedProjectForTest('pconcurrent', 'ownerA')
      await Promise.all(Array.from({ length: 20 }, () => backend.recordCompensation('pconcurrent', 'restore')))
      const pending = await backend.listPendingCompensations('pconcurrent')
      expect(pending).toHaveLength(1)
      expect(pending[0].status).toBe('pending')
      expect(pending[0].generation).toBe(1)
    })

    it('done 后下一生命周期可再建(done/superseded 不占 partial unique 槽)', async () => {
      // 上一用例留下 1 pending;attempt → done
      const r = await backend.attemptCompensation('pconcurrent', 'restore')
      expect(r.kind).toBe('completed')
      expect((await backend.listPendingCompensations('pconcurrent'))).toHaveLength(0)
      // 再 record → 新 pending(partial unique WHERE status='pending' 不阻塞 done 后重建)
      const again = await backend.recordCompensation('pconcurrent', 'restore')
      expect(again.status).toBe('pending')
      expect(again.generation).toBe(2) // 代际递增
    })
  })

  describe('R3-F4 claim fencing(PgPermissionBackend)', () => {
    let backend: PgPermissionBackend
    beforeAll(async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      await admin.destroy()
      backend = new PgPermissionBackend(cfg)
      await backend.ready
    })
    afterAll(async () => { if (backend) await backend.destroy() })

    it('赢家超过 lease → 第二 worker 重 claim+done;旧 worker pre-check/done 失败 → stale-claim(至多一个 completed,attemptCount 一致)', async () => {
      await backend.__reset()
      await backend.__seedProjectForTest('p-fence', 'ownerA')
      await backend.__setProjectDeletedForTest('p-fence', false) // restore desired
      const link = await backend.createShareLink('p-fence', 'view', 'ownerA')
      await backend.revokeAllForProject('p-fence') // cascade marker,link revoked
      await backend.recordCompensation('p-fence', 'restore') // gen1 pending
      // A: claim(token_A)→ 暂停在 side effect 前(await pausePromise,模拟赢家超过 15s lease 暂停)
      let resolvePause!: () => void
      const pausePromise = new Promise<void>((r) => { resolvePause = r })
      backend.__setClaimPauseForTest('restore', () => pausePromise)
      const aPromise = backend.attemptCompensation('p-fence', 'restore')
      // 等 A 完成 claim(claim_token 落库)再继续——claim 是 DB 异步,需轮询到 token 非空
      for (let i = 0; i < 200; i++) {
        const r = await backend.listCompensations('p-fence')
        if (r.find((x) => x.op === 'restore')?.claimToken) break
        await new Promise((rr) => setTimeout(rr, 5))
      }
      // 清 pause(防 B 也暂停)+ 过期 A 的 lease(模拟 >15s,允许 B 重新 claim)
      backend.__clearClaimPauseForTest('restore')
      await backend.__expireClaimLeaseForTest('p-fence', 'restore')
      // B: claim(token_B,A lease 过期)→ pre-check 过 → side effect + done WHERE token_B → completed
      const b = await backend.attemptCompensation('p-fence', 'restore')
      expect(b.kind).toBe('completed')
      expect((await backend.resolveShareLink(link.token, 'p-fence'))?.kind).toBe('active') // B 收敛
      // 释放 A 的 pause;A 恢复 → pre-check(token_A 不再当前/status 已 done)→ stale-claim(不执行副作用、不 mark done)
      resolvePause()
      const a = await aPromise
      expect(a.kind).toBe('stale-claim')
      // 至多一个 completed(B);attemptCount 与真实有效 claim 一致(=1,B bump;A 不 bump)
      const ints = await backend.listCompensations('p-fence')
      const restore = ints.find((i) => i.op === 'restore')!
      expect(restore.attemptCount).toBe(1)
      expect(restore.status).toBe('done')
      expect(restore.claimToken).toBeNull() // done 清 token
    })
  })

  // R3-F5 record 崩溃→重启恢复:现有 route 测试在同一 HTTP 请求内 immediate self-heal(route catch record 错后
  // 立即 attempt),未覆盖"primary persist 提交后、record 前进程退出"的核心窗口。本测真 PG 隔离:
  //   primary 提交 → 销毁实例(不调 record/attempt)→ 重建 backend → 只跑 reconcile+sweep → 无用户重入也收敛。
  //   restore/delete 双向;marker(cascade_revoked_at)与 reconcile 派生是收敛保证。
  describe('R3-F5 record 崩溃→重启恢复(真 PG 双向,无用户重入)', () => {
    beforeAll(async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      await admin.destroy()
    })

    it('delete 方向:softDelete(primary)→销毁→重建→reconcile+sweep 收敛(link revoked)', async () => {
      let backend = new PgPermissionBackend(cfg)
      await backend.ready
      await backend.__seedProjectForTest('p-crash-del', 'ownerA')
      const link = await backend.createShareLink('p-crash-del', 'view', 'ownerA')
      expect((await backend.resolveShareLink(link.token, 'p-crash-del'))?.kind).toBe('active')
      // primary softDelete 提交(is_deleted=true)——不调 record/attempt(模拟 record 前进程退出)
      await backend.__setProjectDeletedForTest('p-crash-del', true)
      // 销毁实例(进程退出);DB 表 share_link_compensations 为空(record 未跑)
      await backend.destroy()
      // 重建 backend(重启)——无任何 intent;只跑 startup reconcile+sweep,无用户重入
      backend = new PgPermissionBackend(cfg)
      await backend.ready
      expect((await backend.listCompensations('p-crash-del'))).toHaveLength(0) // 重启后无 intent
      // reconcile 据 projects.is_deleted=true + active link 派生 pending delete
      const rec = await backend.reconcileFromProjectState()
      expect(rec.deleteRecorded).toBe(1)
      expect(rec.restoreRecorded).toBe(0)
      // sweep 收敛:attempt delete → revokeAll → link revoked
      const sw = await backend.sweepCompensations()
      expect(sw.converged).toBe(1)
      expect(sw.failed).toBe(0)
      expect((await backend.resolveShareLink(link.token, 'p-crash-del'))?.kind).toBe('revoked')
      const ints = await backend.listCompensations('p-crash-del')
      expect(ints.find((i) => i.op === 'delete')!.status).toBe('done')
      await backend.destroy()
    })

    it('restore 方向:restore(primary)→销毁→重建→reconcile+sweep 收敛(link active,依赖 cascade marker)', async () => {
      let backend = new PgPermissionBackend(cfg)
      await backend.ready
      await backend.__seedProjectForTest('p-crash-res', 'ownerA')
      const link = await backend.createShareLink('p-crash-res', 'view', 'ownerA')
      // project 曾软删(级联 revoke,置 cascade marker)+ is_deleted=true
      await backend.revokeAllForProject('p-crash-res')
      await backend.__setProjectDeletedForTest('p-crash-res', true)
      expect((await backend.resolveShareLink(link.token, 'p-crash-res'))?.kind).toBe('revoked')
      // primary restore 提交(is_deleted=false)——不调 record/attempt(模拟 record 前进程退出)
      await backend.__setProjectDeletedForTest('p-crash-res', false)
      await backend.destroy()
      // 重建 backend(重启)
      backend = new PgPermissionBackend(cfg)
      await backend.ready
      expect((await backend.listCompensations('p-crash-res'))).toHaveLength(0)
      // reconcile 据 is_deleted=false + cascade_revoked_at marker 派生 pending restore(marker 是收敛关键)
      const rec = await backend.reconcileFromProjectState()
      expect(rec.restoreRecorded).toBe(1)
      expect(rec.deleteRecorded).toBe(0)
      const sw = await backend.sweepCompensations()
      expect(sw.converged).toBe(1)
      expect(sw.failed).toBe(0)
      expect((await backend.resolveShareLink(link.token, 'p-crash-res'))?.kind).toBe('active') // restore 收敛
      const ints = await backend.listCompensations('p-crash-res')
      expect(ints.find((i) => i.op === 'restore')!.status).toBe('done')
      await backend.destroy()
    })
  })
})
