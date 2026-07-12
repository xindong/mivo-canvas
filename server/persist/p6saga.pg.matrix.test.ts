// server/persist/p6saga.pg.matrix.test.ts
// P-6 saga 返修 PG 专属验收(P1-3 并发 + P1-4 迁移矩阵)。gate:MIVO_PG_TEST=1。
// 隔离库 mivocanvas_unit_p6saga(lead 指定;与 dual contract suite 的 mivocanvas_unit 分离,防并发 worktree 污染)。
//
// P1-4 矩阵(lead 2026-07-12 拍板:DP-6R 占 003_chat_per_user + 004_chat_order_revisions,本分支 005;share-先路径不存在无需支持):
//  - fresh combined:001+002+003+004+005 全量 migrateToLatest 绿,表/列/索引齐,kysely_migration 单调。
//  - chat-applied→combined:模拟 003+004 已 tracked,migrateToLatest 追加 005,kysely_migration 单调(001<002<003<004<005)。
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

// 模拟 DP-6R 的两条 migration(本分支 registry 无它们;矩阵证明 003→004→005 字典序无冲突):
//  003_chat_per_user / 004_chat_order_revisions —— 占位表,等价形态让 migrator tracked 进 kysely_migration。
const mChat003 = {
  async up(d: Kysely<Record<string, never>>): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS chat_per_user_messages (id text primary key, project_id text)`.execute(d)
  },
  async down(): Promise<void> {},
}
const mChatOrder004 = {
  async up(d: Kysely<Record<string, never>>): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS chat_order_revisions (id text primary key, project_id text, revision integer)`.execute(d)
  },
  async down(): Promise<void> {},
}

;(PG_TEST_ENABLED ? describe : describe.skip)('P-6 saga PG:迁移矩阵(P1-4)+ 并发(P1-3)', () => {
  it('P1-4 fresh combined:001+002+003+004+005 migrateToLatest 绿,表/列/索引齐,kysely_migration 单调', async () => {
    const db = makeKysely()
    await resetSchema(db)
    // fresh combined:本分支 001+002+005 + 模拟 DP-6R 003+004,全量 migrateToLatest(证明 005 在 003+004 之后无冲突)。
    const combined = {
      '2026_07_11_001_initial_persist_schema': migrations['2026_07_11_001_initial_persist_schema'],
      '2026_07_11_002_permissions_schema': migrations['2026_07_11_002_permissions_schema'],
      '2026_07_12_003_chat_per_user': mChat003,
      '2026_07_12_004_chat_order_revisions': mChatOrder004,
      '2026_07_12_005_share_link_compensations': migrations['2026_07_12_005_share_link_compensations'],
    }
    await migrateWith(db, combined)
    // compensations 表新列
    const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='share_link_compensations' ORDER BY column_name`.execute(db)).rows as { column_name: string }[]
    const names = cols.map((r) => r.column_name)
    expect(names).toContain('generation')
    expect(names).toContain('claimed_at')
    expect(names).toContain('claimed_until')
    // status CHECK 含 'superseded'(返修 P1-2 新增;PG12+ 用 pg_get_constraintdef,consrc 已移除)
    const chk = (await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='share_link_compensations'::regclass AND contype='c'`.execute(db)).rows as { def: string }[]
    expect(chk.some((r) => r.def.includes('superseded'))).toBe(true)
    // share_links.cascade_revoked_at(P-6 marker)
    const sl = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='share_links' AND column_name='cascade_revoked_at'`.execute(db)).rows as { column_name: string }[]
    expect(sl).toHaveLength(1)
    // partial unique index
    const idx = (await sql`SELECT indexname FROM pg_indexes WHERE tablename='share_link_compensations'`.execute(db)).rows as { indexname: string }[]
    expect(idx.map((r) => r.indexname)).toContain('uq_compensations_pending_project_op')
    // kysely_migration 单调:001<002<003<004<005(share-先路径不存在)
    const applied = (await sql`SELECT name FROM kysely_migration ORDER BY name`.execute(db)).rows as { name: string }[]
    expect(applied.map((r) => r.name)).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_user',
      '2026_07_12_004_chat_order_revisions',
      '2026_07_12_005_share_link_compensations',
    ])
    // 三表共存(005 在 003+004 之后 apply,无顺序冲突)
    const coexist = (await sql`SELECT table_name FROM information_schema.tables WHERE table_name IN ('chat_per_user_messages','chat_order_revisions','share_link_compensations') ORDER BY table_name`.execute(db)).rows as { table_name: string }[]
    expect(coexist.map((r) => r.table_name)).toEqual(['chat_order_revisions', 'chat_per_user_messages', 'share_link_compensations'])
    await db.destroy()
  })

  it('P1-4 chat-applied→combined:模拟 003+004 已 tracked,migrateToLatest 追加 005,kysely_migration 单调', async () => {
    const db = makeKysely()
    await resetSchema(db)
    const m1 = migrations['2026_07_11_001_initial_persist_schema']
    const m2 = migrations['2026_07_11_002_permissions_schema']
    // 模拟 DP-6R 已合 main 的状态:001+002+003+004 已 tracked。
    const regDp6r = {
      '2026_07_11_001_initial_persist_schema': m1,
      '2026_07_11_002_permissions_schema': m2,
      '2026_07_12_003_chat_per_user': mChat003,
      '2026_07_12_004_chat_order_revisions': mChatOrder004,
    }
    await migrateWith(db, regDp6r)
    // 再 migrateToLatest(全 registry 含 003+004+005)→ 005 应用(003+004 已 tracked 不重跑)。
    //   注:003+004 不在本分支 registry 里 → Kysely "missing migration" 检查会拒绝;故路径用 regWithChatOrderAnd005。
    const regWithChatOrderAnd005 = {
      ...regDp6r,
      '2026_07_12_005_share_link_compensations': migrations['2026_07_12_005_share_link_compensations'],
    }
    await migrateWith(db, regWithChatOrderAnd005)
    const applied = (await sql`SELECT name FROM kysely_migration ORDER BY name`.execute(db)).rows as { name: string }[]
    // registry 单调:001 < 002 < 003-chat < 004-chat-order < 005-share(share-先路径不存在,无需支持)
    expect(applied.map((r) => r.name)).toEqual([
      '2026_07_11_001_initial_persist_schema',
      '2026_07_11_002_permissions_schema',
      '2026_07_12_003_chat_per_user',
      '2026_07_12_004_chat_order_revisions',
      '2026_07_12_005_share_link_compensations',
    ])
    // 占位 chat 两表与 compensations 表共存(005 在 003+004 之后 apply,无顺序冲突)
    const coexist = (await sql`SELECT table_name FROM information_schema.tables WHERE table_name IN ('chat_per_user_messages','chat_order_revisions','share_link_compensations') ORDER BY table_name`.execute(db)).rows as { table_name: string }[]
    expect(coexist.map((r) => r.table_name)).toEqual(['chat_order_revisions', 'chat_per_user_messages', 'share_link_compensations'])
    await db.destroy()
  })

  describe('P1-3 并发 record(PgPermissionBackend)', () => {
    let backend: PgPermissionBackend
    beforeAll(async () => {
      // 隔离:Path A/B 在本库(mivocanvas_unit_p6saga)留下 003+004 tracked 在 kysely_migration,
      // 而 P1-3 backend.ready→migrate() 只带本分支 registry {001,002,005} → "missing migration" 抛错
      // → beforeAll fail → 用例被 skip(原前任 worker 矩阵未跑过此隔离,latent bug)。
      // 故先 reset schema(清 kysely_migration 追踪表),再建 backend(migrate 重建 001+002+005,无 missing)。
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
})
