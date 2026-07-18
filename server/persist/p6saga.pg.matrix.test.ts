// server/persist/p6saga.pg.matrix.test.ts
// P-6 saga 返修 PG 专属验收(P1-3 并发 + P1-4 迁移矩阵)。gate:MIVO_PG_TEST=1。
// 隔离库 mivocanvas_unit_p6saga(lead 指定;与 dual contract suite 的 mivocanvas_unit 分离,防并发 worktree 污染)。
//
// P1-4 矩阵(合并 origin/main 后 combined registry = 001..010):DP-6R 占 003_chat_per_actor + 004_chat_order_revisions,
//  saga 占 005_share_link_compensations + 006_compensation_failed_status + 007_compensation_claim_token,
//  G2.2 占 008_g22_owner_rekey_audit(COMMENT fail-closed 审计标记,本分支 A1 落地)。
//  - fresh combined:001..010 全量 migrateToLatest 绿,表/列/索引齐,kysely_migration 精确单调(10 行)。
//  - chat-applied→combined:模拟 001→004 已 tracked,migrateToLatest 追加 005/006/007/008/009/010,kysely_migration 精确单调(001<...<010)。
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
// 合并 origin/main 后,combined registry 自然含 003/004/005/006/007/008/009(本分支已与 DP-6R 收敛),
// 故 fresh + combined 两路径均在本测试实跑(下方),不再有 merge-time 缺口。

;(PG_TEST_ENABLED ? describe : describe.skip)('P-6 saga PG:迁移矩阵(P1-4)+ 并发(P1-3)', () => {
  it('R3-F3 fresh combined registry:001..010 全量 migrateToLatest 绿,表/列/索引齐,kysely_migration 精确单调', async () => {
    const db = makeKysely()
    await resetSchema(db)
    // 真实生产 combined registry(合并 DP-6R + G2.2 后):001+002+003+004+005+006+007+008+009+010。禁测试内占位 migration。
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
    // Phase 2 归档(010_archive_status_column):persist_records/projects/canvases 三表各加 status 列
    //   (TEXT NOT NULL DEFAULT 'active',CHECK (status IN ('active','archived')),对齐 migrations.ts:247-251 ARCHIVE_STATUS_SCHEMA)。
    //   "表/列/索引齐"扩展:status 列在三表均存在 + DEFAULT 'active' + CHECK 含 active/archived。
    for (const t of ['persist_records', 'projects', 'canvases'] as const) {
      const sc = (await sql`SELECT column_default FROM information_schema.columns WHERE table_name=${t} AND column_name='status'`.execute(db)).rows as { column_default: string | null }[]
      expect(sc).toHaveLength(1)
      expect(sc[0].column_default).toMatch(/active/)
      const schk = (await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=${t}::regclass AND contype='c'`.execute(db)).rows as { def: string }[]
      expect(schk.some((r) => r.def.includes('active') && r.def.includes('archived'))).toBe(true)
    }
    // CR-6 缺口1(011_node_reverse_lookup_index):node 全局反查部分索引存在(findNodeOwners 查询路径)。
    const nodeIdx = (await sql`SELECT indexname FROM pg_indexes WHERE tablename='persist_records' AND indexname='idx_persist_node_by_id'`.execute(db)).rows as { indexname: string }[]
    expect(nodeIdx).toHaveLength(1)
    // CR-6 P2-2(012_canvas_reverse_lookup_index):chat actor≠canvas owner 时守卫只能按
    // (type='canvas',id) 全局定位；部分索引令裸 id 查询定点，避免 persist_records 全扫。
    const canvasIdx = (await sql`SELECT indexname FROM pg_indexes WHERE tablename='persist_records' AND indexname='idx_persist_canvas_by_id'`.execute(db)).rows as { indexname: string }[]
    expect(canvasIdx).toHaveLength(1)
    await sql`
      INSERT INTO persist_records(id,owner_id,canvas_id,type,scope,revision,order_key,is_deleted,status,payload)
      SELECT 'n-plan-' || g::text, 'plan-owner', 'c-plan', 'node', 'document', 0, g, false, 'active', '{}'::jsonb
      FROM generate_series(1, 2000) AS g
    `.execute(db)
    await sql`
      INSERT INTO persist_records(id,owner_id,canvas_id,type,scope,revision,order_key,is_deleted,status,payload)
      VALUES('c-plan','canvas-owner',NULL,'canvas','document',0,0,false,'active','{}'::jsonb)
    `.execute(db)
    await sql`ANALYZE persist_records`.execute(db)
    const explain = (await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN (COSTS OFF)
      SELECT is_deleted, status FROM persist_records
      WHERE type='canvas' AND id='c-plan' FOR UPDATE
    `.execute(db)).rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(explain).toContain('Index Scan using idx_persist_canvas_by_id')
    expect(explain).toContain("Index Cond: (id = 'c-plan'::text)")
    // kysely_migration 精确单调:combined registry 全 12 行(001<...<010<011<012)
    const applied = (await sql`SELECT name FROM kysely_migration ORDER BY name`.execute(db)).rows as { name: string }[]
    expect(applied.map((r) => r.name)).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_actor',
      '2026_07_12_004_chat_order_revisions',
      '2026_07_12_005_share_link_compensations',
      '2026_07_12_006_compensation_failed_status',
      '2026_07_12_007_compensation_claim_token',
      '2026_07_12_008_g22_owner_rekey_audit',
      '2026_07_13_009_field_clock_canvas_seq_tombstones',
      '2026_07_17_010_archive_status_column',
      '2026_07_18_011_node_reverse_lookup_index',
      '2026_07_18_012_canvas_reverse_lookup_index',
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
      '2026_07_12_008_g22_owner_rekey_audit',
      '2026_07_13_009_field_clock_canvas_seq_tombstones',
      '2026_07_17_010_archive_status_column',
      '2026_07_18_011_node_reverse_lookup_index',
      '2026_07_18_012_canvas_reverse_lookup_index',
    ])
    await db.destroy()
  })

  // R3-F3 combined DP-6R 路径(真实 001→004 tracked → 追加 005/006/007/008/009/010):合并 origin/main 后 combined
  //   registry 含 003_chat_per_actor + 004_chat_order_revisions,本测实跑真实 combined。
  it('R3-F3 combined DP-6R 路径:001→004 已 tracked → 追加 005/006/007/008/009/010,kysely_migration 精确单调', async () => {
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
    // migrateToLatest 用完整 combined registry:识别 001→004 已 tracked,追加 005/006/007/008/009/010/011
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
      '2026_07_12_008_g22_owner_rekey_audit',
      '2026_07_13_009_field_clock_canvas_seq_tombstones',
      '2026_07_17_010_archive_status_column',
      '2026_07_18_011_node_reverse_lookup_index',
      '2026_07_18_012_canvas_reverse_lookup_index',
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
      // backend.ready→migrate() 带 combined registry(001..010),clean 库下全量 migrate 无 missing。
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

  // R5-F1 TOCTOU 加压(R4 verdict Step 7 复现):两个独立真 PG backend(各自独立连接池)barrier 复现
  //   "primary durable desired state 已提交、new intent 尚未 record"的真实 saga 窗口,并发 N 轮零翻转。
  //   A(backend A)claim restore 后暂停在 side effect 前;B(backend B,独立 pool)提交 primary delete
  //   (is_deleted=true)但不 record(模拟 record 前崩溃);释放 A → 修复后 critical trx SELECT...FOR UPDATE
  //   重读 is_deleted=true → stale → superseded,不执行 unRevoke,link 保持 revoked。双向(restore/delete)N 轮。
  describe('R5-F1 TOCTOU 加压(两独立真 PG backend,N 轮零翻转)', () => {
    let backendA: PgPermissionBackend
    let backendB: PgPermissionBackend
    beforeAll(async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      await admin.destroy()
      backendA = new PgPermissionBackend(cfg)
      backendB = new PgPermissionBackend(cfg)
      await Promise.all([backendA.ready, backendB.ready])
    })
    afterAll(async () => {
      await Promise.all([backendA.destroy(), backendB.destroy()])
    })

    it('restore 方向 N 轮:A claim→B 翻 is_deleted=true→A 须 superseded,link 仍 revoked(零翻转)', async () => {
      const N = 5
      for (let round = 0; round < N; round++) {
        const pid = `p-toctou-res-${round}`
        await backendA.__reset()
        await backendA.__seedProjectForTest(pid, 'ownerA')
        const link = await backendA.createShareLink(pid, 'view', 'ownerA')
        await backendA.revokeAllForProject(pid) // cascade marker,link revoked
        await backendA.__setProjectDeletedForTest(pid, false) // restore desired
        await backendA.recordCompensation(pid, 'restore') // gen1 pending
        // A: claim(token_A)→ 暂停在 side effect 前
        let resolvePause!: () => void
        const pausePromise = new Promise<void>((r) => { resolvePause = r })
        backendA.__setClaimPauseForTest('restore', () => pausePromise)
        const aPromise = backendA.attemptCompensation(pid, 'restore')
        // 等 A 的 claim_token 落库(claim 是异步 UPDATE)
        for (let i = 0; i < 200; i++) {
          const r = await backendA.listCompensations(pid)
          if (r.find((x) => x.op === 'restore')?.claimToken) break
          await new Promise((rr) => setTimeout(rr, 5))
        }
        // B(独立 pool)提交 primary delete(is_deleted=true),不 record(模拟 record 前崩溃)
        await backendB.__setProjectDeletedForTest(pid, true)
        // 释放 A;A 恢复 → 修复后 critical trx 重读 is_deleted=true → superseded
        resolvePause()
        const a = await aPromise
        expect(a.kind).toBe('superseded') // 不执行副作用,不报 completed
        expect((await backendA.resolveShareLink(link.token, pid))?.kind).toBe('revoked') // link 仍 revoked(零翻转)
        const ints = await backendA.listCompensations(pid)
        const restore = ints.find((i) => i.op === 'restore')!
        expect(restore.status).toBe('superseded')
        expect(restore.attemptCount).toBe(0) // 不 bump
        backendA.__clearClaimPauseForTest('restore')
      }
    })

    it('delete 方向 N 轮:A claim→B 翻 is_deleted=false→A 须 superseded,link 仍 active(零翻转)', async () => {
      const N = 5
      for (let round = 0; round < N; round++) {
        const pid = `p-toctou-del-${round}`
        await backendA.__reset()
        await backendA.__seedProjectForTest(pid, 'ownerA')
        const link = await backendA.createShareLink(pid, 'view', 'ownerA') // active
        await backendA.__setProjectDeletedForTest(pid, true) // delete desired
        await backendA.recordCompensation(pid, 'delete') // gen1 pending
        let resolvePause!: () => void
        const pausePromise = new Promise<void>((r) => { resolvePause = r })
        backendA.__setClaimPauseForTest('delete', () => pausePromise)
        const aPromise = backendA.attemptCompensation(pid, 'delete')
        for (let i = 0; i < 200; i++) {
          const r = await backendA.listCompensations(pid)
          if (r.find((x) => x.op === 'delete')?.claimToken) break
          await new Promise((rr) => setTimeout(rr, 5))
        }
        // B 提交 primary restore(is_deleted=false),不 record
        await backendB.__setProjectDeletedForTest(pid, false)
        resolvePause()
        const a = await aPromise
        expect(a.kind).toBe('superseded')
        expect((await backendA.resolveShareLink(link.token, pid))?.kind).toBe('active') // link 仍 active(零翻转)
        const ints = await backendA.listCompensations(pid)
        const del = ints.find((i) => i.op === 'delete')!
        expect(del.status).toBe('superseded')
        expect(del.attemptCount).toBe(0)
        backendA.__clearClaimPauseForTest('delete')
      }
    })
  })

  // R6 锁序 deadlock barrier(2026-07-12 R5 verdict Step 4 暴露的 P2 阻塞):
  //   recordCompensation 先 UPDATE supersede 持 compensation 行锁,再 INSERT 新 generation 触发 FK(project_id
  //   REFERENCES projects(id))对 project 请求 KEY SHARE;attemptCompensation critical section 先持 project
  //   FOR UPDATE 后持 compensation FOR UPDATE——反向锁环,真 PG 确定性触发 40P01 deadlock。修法:record 开头
  //   先锁 project FOR UPDATE,统一 project→compensation 锁序,消除环。
  //   本测双事务 barrier 确定性交错:c1(raw,镜像 attempt critical 的 project→gen1 锁序)持 project FOR UPDATE,
  //   等 1000ms 让 c2(真 backend.recordCompensation 生产代码)进入"持 gen1 + INSERT 阻塞于 project"稳态;
  //   c1 再请求 gen1 FOR UPDATE——旧代码成环→40P01(红),修复后 c2 先阻于 project→gen1 无人持→c1 取得+提交→
  //   c2 随后取得 project→supersede+INSERT,无 deadlock(绿)。c1 设 deadlock_timeout=200ms 加速检测。
  //   最终收敛(真 backend sweep):primary delete 提交(is_deleted=true)→仅最新 gen2 done、gen1 superseded、
  //   link 跟随 is_deleted 翻 revoked。memory 单线程无真锁→无 deadlock 风险,本测 PG-only。
  describe('R6 锁序 deadlock barrier:record ↔ attempt 反向锁环(真 PG 双事务确定性交错)', () => {
    let backend: PgPermissionBackend
    let barrierPool: Pool
    beforeAll(async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      await admin.destroy()
      backend = new PgPermissionBackend(cfg)
      await backend.ready
      barrierPool = new Pool({ ...cfg, max: 2 })
    })
    afterAll(async () => {
      if (backend) await backend.destroy()
      if (barrierPool) await barrierPool.end()
    })

    it('record 与 attempt 确定性交错无 40P01;最终仅最新 generation 完成,link 跟随 projects.is_deleted', async () => {
      const pid = 'p-r6-deadlock'
      await backend.__reset()
      await backend.__seedProjectForTest(pid, 'ownerA')
      await backend.__setProjectDeletedForTest(pid, false) // restore desired(对立 op=delete 才 supersede gen1)
      const link = await backend.createShareLink(pid, 'view', 'ownerA') // active link(无 cascade marker)
      expect((await backend.resolveShareLink(link.token, pid))?.kind).toBe('active')
      await backend.recordCompensation(pid, 'restore') // gen1 pending restore(c2 record delete 的 supersede 目标)
      const gen1 = (await backend.listCompensations(pid)).find((i) => i.op === 'restore' && i.generation === 1)!
      expect(gen1.status).toBe('pending')

      // 两条 raw pg 连接:c1 镜像 attempt critical 锁序(持 project→请求 gen1);c2 仅作 projectHeld 信号桥,
      //   真正的 record 侧由 backend.recordCompensation 生产代码驱动(测真代码,非 raw 重放)。
      const c1 = await barrierPool.connect()
      let signalProject!: () => void
      const projectHeld = new Promise<void>((r) => { signalProject = r })

      // c1 = attempt critical section 锁序镜像:先 SELECT project FOR UPDATE(持 project 行锁),等待 c2(record)
      //   进入"持 gen1(supersede UPDATE)+ INSERT 阻塞于 project"稳态,再 SELECT gen1 FOR UPDATE 构造反向环。
      //   修复后 record 先阻于 project(FIX SELECT...FOR UPDATE)→ gen1 无人持 → c1 取得 gen1 + 提交 → 无 deadlock。
      const c1Promise = (async () => {
        try {
          await c1.query("SET deadlock_timeout = '200ms'") // 加速 OLD 代码 deadlock 检测(200ms 触发)
          await c1.query('BEGIN')
          await c1.query('SELECT is_deleted FROM projects WHERE id = $1 FOR UPDATE', [pid])
          signalProject() // project 行锁已持,放行 c2
          // 等 c2(真 record)进入稳态:旧代码→supersede 持 gen1 + INSERT 阻塞于 c1 的 project;新代码→阻塞于 project。
          await new Promise((r) => setTimeout(r, 1000))
          await c1.query('SELECT id FROM share_link_compensations WHERE id = $1 FOR UPDATE', [gen1.id])
          await c1.query('COMMIT')
          return { side: 'attempt' as const, ok: true, code: null as string | null }
        } catch (e: unknown) {
          await c1.query('ROLLBACK').catch(() => {})
          const code = (e as { code?: string } | undefined)?.code ?? null
          return { side: 'attempt' as const, ok: code === null, code }
        } finally {
          c1.release()
        }
      })()

      // c2 = 真生产代码 backend.recordCompensation(pid, 'delete'):advisory → [FIX: project FOR UPDATE] →
      //   supersede gen1(持 compensation 行锁)→ INSERT gen2(FK KEY SHARE→project)。测真代码锁序。
      const c2Promise = (async () => {
        await projectHeld // 等 c1 先持 project,构造反向环前提
        try {
          await backend.recordCompensation(pid, 'delete')
          return { side: 'record' as const, ok: true, code: null as string | null }
        } catch (e: unknown) {
          const code = (e as { code?: string } | undefined)?.code ?? null
          return { side: 'record' as const, ok: code === null, code }
        }
      })()

      const [r1, r2] = await Promise.all([c1Promise, c2Promise])
      // 核心断言:无 40P01 deadlock(旧代码:一侧 40P01 → 红;修复:两侧均成功 → 绿)
      const deadlock = r1.code === '40P01' || r2.code === '40P01'
      expect(deadlock, `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`).toBe(false)
      // 两侧不得有非 deadlock 的意外错误
      const unexpected = [r1, r2].filter((r) => !r.ok && r.code !== '40P01')
      expect(unexpected, `unexpected=${JSON.stringify(unexpected)}`).toHaveLength(0)

      // 最终收敛(真 backend 驱动):primary delete 已提交 → sweep 收敛 gen2 done、gen1 superseded、link revoked。
      await backend.__setProjectDeletedForTest(pid, true)
      const sw = await backend.sweepCompensations()
      expect(sw.failed).toBe(0)
      const ints = await backend.listCompensations(pid)
      const gen2 = ints.find((i) => i.op === 'delete' && i.generation === 2)
      const gen1Final = ints.find((i) => i.op === 'restore' && i.generation === 1)
      expect(gen2?.status).toBe('done') // 仅最新 generation 完成
      expect(gen1Final?.status).toBe('superseded') // 旧代际被取代(非 done)
      // link 跟随 projects.is_deleted(true → revoked):delete sweep 的 revokeAll 副作用把 active link 翻 revoked
      expect((await backend.resolveShareLink(link.token, pid))?.kind).toBe('revoked')
    }, 30000)
  })

  // R8 形状守卫(PgPermissionBackend.ready migrate 后 information_schema 校验)。
  // 防:运维误建残缺表(如已删 002 死草案形态)→ 005 CREATE TABLE IF NOT EXISTS 跳过不补列,
  // kysely_migration 仍标 005 applied → migrateToLatest no-op → 表残缺。ready 阶段 fail-closed 拒启动
  // (ready reject → index.ts start() 的 Promise.all([persist.ready, permission.ready]) reject →
  // start().catch → console.error('[mivo-bff] startup failed:', err) + process.exit(1),同 G2.1 startup gate)。
  describe('R8 形状守卫:残缺表/退化 CHECK → ready 必抛带列名;完整表 → ready 绿', () => {
    it('RED 列缺失:002 死草案形态 + 完整 migrateToLatest(005 跳过不补列,006/007 跑)→ ready 抛含 generation/claimed_at/claimed_until', async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      // 先建 projects(补偿表 FK 引用;001 CREATE TABLE IF NOT EXISTS 跳过,同形态无冲突)。
      await sql`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, is_deleted BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(admin)
      // 002 死草案形态(见已删 002_compensations.sql):缺 generation/claimed_at/claimed_until/claim_token,status CHECK 只 pending/done。
      await sql`
        CREATE TABLE share_link_compensations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          op TEXT NOT NULL CHECK (op IN ('restore','delete')),
          status TEXT NOT NULL CHECK (status IN ('pending','done')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_attempted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(admin)
      // 完整 migrateToLatest:005 CREATE TABLE IF NOT EXISTS 跳过(表已存在,不补 generation/claimed_at/claimed_until);
      //   006 ALTER CHECK 加 superseded/failed;007 ADD COLUMN IF NOT EXISTS claim_token(补回 claim_token)。
      await migrateWith(admin, migrations)
      await admin.destroy()

      const broken = new PgPermissionBackend(cfg)
      let thrown: unknown
      try {
        await broken.ready
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(Error)
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      expect(msg).toContain('share_link_compensations')
      expect(msg).toMatch(/missing columns/i)
      expect(msg).toContain('generation')
      expect(msg).toContain('claimed_at')
      expect(msg).toContain('claimed_until')
      // claim_token 被 007 ADD COLUMN IF NOT EXISTS 补回 → 不在缺失列中(仅 generation/claimed_at/claimed_until 缺)。
      await broken.destroy()
    })

    it('RED status CHECK 退化:列齐但 CHECK 只 pending/done → ready 抛含 superseded/failed', async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      await migrateWith(admin, migrations) // 完整 001..010 → 13 列齐 + status CHECK 4 值
      // 退化 status CHECK:DROP 006 的 4 值约束,重建为只 pending/done(模拟 006 未跑/被回退)。
      await sql`ALTER TABLE share_link_compensations DROP CONSTRAINT IF EXISTS share_link_compensations_status_check`.execute(admin)
      await sql`ALTER TABLE share_link_compensations ADD CONSTRAINT share_link_compensations_status_check CHECK (status IN ('pending','done'))`.execute(admin)
      await admin.destroy()

      const broken = new PgPermissionBackend(cfg)
      let thrown: unknown
      try {
        await broken.ready
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(Error)
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      expect(msg).toContain('status CHECK')
      expect(msg).toMatch(/missing values/i)
      expect(msg).toContain('superseded')
      expect(msg).toContain('failed')
      await broken.destroy()
    })

    it('GREEN:reset + 完整 migrate → 13 列齐 + status CHECK 4 值 → ready 绿', async () => {
      const admin = makeKysely()
      await resetSchema(admin)
      await admin.destroy()
      const full = new PgPermissionBackend(cfg)
      await expect(full.ready).resolves.toBeUndefined()
      await full.destroy()
    })
  })
})
