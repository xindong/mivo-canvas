// server/persist/backend.pg.test.ts
// T1.3 PG 后端专用测试:冷启动预热(服务器重启无损证据)+ 事务原子性 + 跨实例缓存一致性 + P1/P2 并发回归。
// PG gate:MIVO_PG_TEST=1(本地 brew PG port 55443);CI 无 PG 跳过。
// 契约等价性由 backend.contract.dual.test.ts 覆盖(32 场景 memory+PG 同形);本测钉 PG 专有性质。
//
// DB 隔离:本套件用独立 DB `mivocanvas_unit`(默认;env MIVO_PG_UNIT_DB 覆盖),与 backend.contract.dual.test.ts
// 用的 `mivocanvas` 分离——vitest 文件并行下两套件共享 DB + 同 id('p1'/'c1'/'o')会行级污染;独立 DB 根治。
// beforeAll 自动 createdb(若缺);mivo 超级用户(rolcreatedb)本地 brew PG 满足。CI 无 PG 不触发。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { PgPersistBackend } from './pgBackend'
import { PgPermissionBackend } from './pgPermissionBackend'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'

const pgConn = () => ({
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_UNIT_DB || 'mivocanvas_unit',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
  maxConnections: 5,
  idleTimeoutMs: 5000,
})

/** 确保独立 DB 存在(并行隔离用);连到 postgres 库 CREATE DATABASE IF MISSING。 */
async function ensureUnitDb(): Promise<void> {
  const cfg = pgConn()
  const admin = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: 'postgres',
    user: cfg.user,
    password: cfg.password,
    max: 1,
  })
  try {
    const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [cfg.database])
    if (res.rowCount === 0) {
      // CREATE DATABASE 不支持参数化;db 名来自常量/env,非用户输入,字符串拼接安全(已转义双引号防注入)。
      const dbName = String(cfg.database).replace(/"/g, '')
      await admin.query(`CREATE DATABASE "${dbName}"`)
    }
  } finally {
    await admin.end()
  }
}

/** F5 断言用:直接查 canvases 瘦索引表的 is_deleted(绕过缓存,验 DB 事实)。null=行不存在。 */
async function canvasTableIsDeleted(id: string): Promise<boolean | null> {
  const cfg = pgConn()
  const pool = new Pool({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, max: 1 })
  try {
    const r = await pool.query('SELECT is_deleted FROM canvases WHERE id = $1', [id])
    return r.rowCount === 0 ? null : Boolean(r.rows[0].is_deleted)
  } finally {
    await pool.end()
  }
}

;(PG_TEST_ENABLED ? describe : describe.skip)('PgPersistBackend — PG 专有性质', () => {
  let pg: PgPersistBackend
  beforeAll(async () => {
    await ensureUnitDb()
    pg = new PgPersistBackend(pgConn())
    await pg.migrate()
    await pg.ready
  })
  afterAll(async () => {
    if (pg) await pg.destroy()
  })
  beforeEach(async () => {
    await pg.__reset()
  })

  it('冷启动预热(服务器重启无损):写入 → 销毁实例 A → 新实例 B 从 PG 预热 → getProjectOwner 仍返归属', async () => {
    // 实例 A 写入 project + canvas(用独立实例,不碰共享 pg)
    const pgA = new PgPersistBackend(pgConn())
    await pgA.migrate()
    await pgA.ready
    await pgA.ensureCreate('ownerA', 'project', 'p-restart', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pgA.createCanvasWithCollection('ownerA', 'c-restart', { projectId: 'p-restart' }, { method: 'POST', resourceKind: 'canvas' })
    expect(pgA.getProjectOwner('p-restart')?.ownerId).toBe('ownerA')
    expect(pgA.getCanvasOwner('c-restart')?.ownerId).toBe('ownerA')
    // 销毁实例 A(模拟 pm2 restart,内存缓存清空,数据留 PG)
    await pgA.destroy()
    // 实例 B 从同一 PG 起飞(ready 预热从 PG load projects/canvases)
    const pgB = new PgPersistBackend(pgConn())
    await pgB.migrate()
    await pgB.ready
    // 缓存从 PG 重预热:getProjectOwner/getCanvasOwner 仍返归属(服务器重启无损)
    expect(pgB.getProjectOwner('p-restart')?.ownerId).toBe('ownerA')
    expect(pgB.getCanvasOwner('c-restart')?.ownerId).toBe('ownerA')
    expect(pgB.projectLive('ownerA', 'p-restart')).toBe(true)
    // 数据在 PG 仍可读
    const got = await pgB.get('ownerA', 'project', 'p-restart')
    expect(got.kind).toBe('found')
    if (got.kind === 'found') expect(got.record.isDeleted).toBe(false)
    await pgB.destroy()
  })

  it('事务原子性:softDeleteProjectTree 单事务标 project+canvas+collection(无 partial)', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await pg.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
    await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
    const { count } = await pg.softDeleteProjectTree('o', 'p1')
    expect(count).toBe(3) // project + canvas meta + chat-collection
    // 全部 is_deleted=true(单事务,无 partial)
    const proj = await pg.get('o', 'project', 'p1')
    const cv = await pg.get('o', 'canvas', 'c1')
    const coll = await pg.get('o', 'chat-collection', 'c1')
    if (proj.kind === 'found') expect(proj.record.isDeleted).toBe(true)
    if (cv.kind === 'found') expect(cv.record.isDeleted).toBe(true)
    if (coll.kind === 'found') expect(coll.record.isDeleted).toBe(true)
    // children 保持活记录(返修 #2)
    const node = await pg.getChild('o', 'c1', 'node', 'n1')
    if (node.kind === 'found') expect(node.record.isDeleted).toBe(false)
    // 缓存同步:projectLive=false
    expect(pg.projectLive('o', 'p1')).toBe(false)
  })

  it('乐观并发:upsertChild stale base → conflict;正确 base → updated(行影响 0 = 409)', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    const c = await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
    expect(c.kind).toBe('created')
    if (c.kind === 'created') expect(c.record.revision).toBe(0)
    // stale base(99 ≠ 0)→ conflict
    const stale = await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1', v: 1 }, { base: 99, method: 'PATCH', resourceKind: 'node' })
    expect(stale.kind).toBe('conflict')
    if (stale.kind === 'conflict') expect(stale.currentRevision).toBe(0)
    // 正确 base(0)→ updated,revision 1
    const ok = await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1', v: 2 }, { base: 0, method: 'PATCH', resourceKind: 'node' })
    expect(ok.kind).toBe('updated')
    if (ok.kind === 'updated') expect(ok.record.revision).toBe(1)
  })

  it('幂等 replay:同 key 同 body → updated(不 bump);同 key 不同 body → reuse-conflict', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    const fp1 = 'fp-body-A'
    const r1 = await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: fp1 })
    expect(r1.kind).toBe('created')
    // 同 key 同 body → updated(不 bump,返既有)
    const r2 = await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: fp1 })
    expect(r2.kind).toBe('updated')
    if (r2.kind === 'updated') expect(r2.record.revision).toBe(0)
    // 同 key 不同 body → reuse-conflict
    const r3 = await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: 'fp-body-B' })
    expect(r3.kind).toBe('reuse-conflict')
  })

  it('contentVersion 原子 bump:并发子资源写都 bump(不丢)', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // 3 次子资源写入 → contentVersion=3
    await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
    await pg.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' })
    await pg.hardDeleteChild('o', 'c1', 'node', 'n1')
    const cv = await pg.get('o', 'canvas', 'c1')
    if (cv.kind === 'found') expect((cv.record.payload as { contentVersion: number }).contentVersion).toBe(3)
    // metaRevision 不动(子资源写入不 bump metaRevision)
    if (cv.kind === 'found') expect(cv.record.revision).toBe(0)
  })

  // ── 返修 P1+P2 并发回归(真实 Promise.all,审阅者复现脚本翻绿)──────────────────────

  it('P1-1 并发 reorder 同 base:一 ok 一 conflict(SELECT FOR UPDATE 序列化)', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
    await pg.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' })
    // 2 次子资源写 → contentVersion=2(createCanvasWithCollection 不 bump;upsertChild 各 bump 一次)
    const cvBefore = await pg.get('o', 'canvas', 'c1')
    if (cvBefore.kind === 'found') expect((cvBefore.record.payload as { contentVersion: number }).contentVersion).toBe(2)
    // 两个并发 reorder,base=2(当前 cv)。契约(api-surface.md L154/L386 F5):一 ok(cv 3),一 409 conflict。
    const [a, b] = await Promise.all([
      pg.reorderChildren('o', 'c1', 'node', ['n2', 'n1'], { base: 2 }),
      pg.reorderChildren('o', 'c1', 'node', ['n1', 'n2'], { base: 2 }),
    ])
    const okResult = [a, b].find((r) => r.kind === 'ok')
    const conflictResult = [a, b].find((r) => r.kind === 'conflict')
    expect(okResult).toBeDefined()
    expect(conflictResult).toBeDefined()
    if (okResult && okResult.kind === 'ok') expect(okResult.contentVersion).toBe(3)
    // 输家读到的当前 cv 是赢家 bump 后的 3(FOR UPDATE 阻塞至赢家提交后读)
    if (conflictResult && conflictResult.kind === 'conflict') expect(conflictResult.currentContentVersion).toBe(3)
    // orderKey 唯一无重叠(赢家重排生效)
    const list = await pg.listByCanvas('o', 'c1', 'node')
    expect(list.records.map((r) => r.orderKey).sort((x, y) => x - y)).toEqual([0, 1])
  })

  it('P1-2 并发幂等同 key 不同 body:一 created 一 reuse-conflict(输家同事务回滚)', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // 两个并发 ensureCreateChild,同 idem key,不同 body(不同 fingerprint),不同 child id。
    const [a, b] = await Promise.all([
      pg.ensureCreateChild('o', 'c1', 'node', 'nA', { v: 1 }, { method: 'POST', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: 'fpA' }),
      pg.ensureCreateChild('o', 'c1', 'node', 'nB', { v: 2 }, { method: 'POST', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: 'fpB' }),
    ])
    // 契约(N4):一 created,一 reuse-conflict(422 idempotency-key-reuse)
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['created', 'reuse-conflict'])
    // 输家同事务回滚:DB 只剩赢家的一个 node(无 partial 资源泄漏)
    const list = await pg.listByCanvas('o', 'c1', 'node')
    expect(list.records.length).toBe(1)
    expect(['nA', 'nB']).toContain(list.records[0].id)
  })

  it('P1-3 并发同 owner 同 id ensureCreate:一 created 一 existing(无 500 泄漏)', async () => {
    // 两个并发同 owner 同 id 同 body(无 idem key)ensureCreate project。
    const [a, b] = await Promise.all([
      pg.ensureCreate('o', 'project', 'p3', { name: 'P' }, { method: 'POST', resourceKind: 'project' }),
      pg.ensureCreate('o', 'project', 'p3', { name: 'P' }, { method: 'POST', resourceKind: 'project' }),
    ])
    // 契约:一 created(200),一 existing(200)——输家 persist_records INSERT ON CONFLICT DO NOTHING + 重读转 existing,
    // 不再 23505 duplicate key 泄漏成 500。
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['created', 'existing'])
    // 全局索引 + record 一致:只有一个 p3,owner=o,live
    expect(pg.getProjectOwner('p3')?.ownerId).toBe('o')
    expect(pg.projectLive('o', 'p3')).toBe(true)
    const got = await pg.get('o', 'project', 'p3')
    expect(got.kind).toBe('found')
  })

  it('P1-4 fresh DB 启动:migrate-before-warm(删表后 new instance await ready 自迁移,无 42P01)', async () => {
    // 模拟 fresh DB:删全部表(含 kysely_migration 追踪表)
    await pg.__dropAllTables()
    // R2-P2-1:断言 __dropAllTables 真 drop 了 chat_order_revisions(migration 004 新表,曾漏入 drop 列表 →
    // to_regclass 仍在,fresh-DB 实际不 fresh,掩盖 004 CREATE/registry 错误)。修复后应为 false。
    expect(await pg.__tableExists('chat_order_revisions')).toBe(false)
    // new instance,只 await ready(不显式 migrate)—— ready 内部 migrate-before-warm
    const pgFresh = new PgPersistBackend(pgConn())
    // 旧实现:warm() 先 SELECT projects → 空库 42P01 → ready reject。新实现:ready 先 migrate 再 warm。
    await expect(pgFresh.ready).resolves.toBeUndefined()
    // 表已重建,warm 成功:可写可读 + owner 索引正确
    await pgFresh.ensureCreate('o', 'project', 'p-fresh', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    expect(pgFresh.getProjectOwner('p-fresh')?.ownerId).toBe('o')
    const got = await pgFresh.get('o', 'project', 'p-fresh')
    expect(got.kind).toBe('found')
    await pgFresh.destroy()
    // 表已由 pgFresh 重建,后续测试的 beforeEach __reset 可正常 DELETE
  })

  it('P1-5 post-commit 定点 cache mutation:warm 抛错后 get 可读 + owner 索引正确(不可失败)', async () => {
    // 注入 warm 故障(模拟 DB blip)。post-commit 不再调 warm,改用定点内存 mutation(纯 Map.set,不可失败)。
    const pgAny = pg as unknown as { warm: () => Promise<void> }
    const originalWarm = pgAny.warm.bind(pg)
    pgAny.warm = async () => { throw new Error('warm-blip') }
    try {
      // create project:post-commit 定点 mutation,不调 warm → warm 抛错不影响
      const r = await pg.ensureCreate('o', 'project', 'p-fix', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      expect(r.kind).toBe('created')
      expect(pg.getProjectOwner('p-fix')?.ownerId).toBe('o')
      expect(pg.projectLive('o', 'p-fix')).toBe(true)
      const got = await pg.get('o', 'project', 'p-fix')
      expect(got.kind).toBe('found')
      // canvas create 同型
      const c = await pg.createCanvasWithCollection('o', 'c-fix', { projectId: 'p-fix' }, { method: 'POST', resourceKind: 'canvas' })
      expect(c.kind).toBe('created')
      expect(pg.getCanvasOwner('c-fix')?.ownerId).toBe('o')
      // upsert created(project)同型
      const u = await pg.upsert('o', 'project', 'p-upsert', { name: 'U' }, { method: 'PUT', resourceKind: 'project' })
      expect(u.kind).toBe('created')
      expect(pg.getProjectOwner('p-upsert')?.ownerId).toBe('o')
    } finally {
      pgAny.warm = originalWarm
    }
  })

  it('P2-1 并发 append orderKey:3 并发 upsertChild,orderKey 严格递增无撞号', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // 3 并发 upsertChild(不同 id,无 idem key)—— nextOrderKeyInTrx 先锁 canvas meta 行,序列化。
    const results = await Promise.all([
      pg.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' }),
      pg.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' }),
      pg.upsertChild('o', 'c1', 'node', 'n3', { id: 'n3' }, { method: 'PATCH', resourceKind: 'node' }),
    ])
    expect(results.every((r) => r.kind === 'created')).toBe(true)
    // orderKey 严格递增(0,1,2,无撞号;旧实现 MAX+1 无锁 → 两个 orderKey=0)
    const orderKeys = results.map((r) => (r.kind === 'created' ? r.record.orderKey : -1)).sort((a, b) => a - b)
    expect(orderKeys).toEqual([0, 1, 2])
    const list = await pg.listByCanvas('o', 'c1', 'node')
    expect(list.records.map((r) => r.orderKey)).toEqual([0, 1, 2])
  })

  // ── 返修三 F1-F5(第三轮复审:race guard / 幽灵授权索引 / 跨 owner upsert / 并发重建 / 级联瘦索引)──

  it('F1 软删后幂等 replay 真恢复(project + canvas;race guard 不误杀 replay-deleted)', async () => {
    // project:replay-deleted 不再重插 idem key(否则 INSERT DO NOTHING→null→IdempotencyRaceLost→回滚恢复→外层映射 existing,但 DB 仍 is_deleted=true)。
    const oP = { method: 'POST', resourceKind: 'project', idempotencyKey: 'k-p', bodyFingerprint: 'fp-p' }
    expect((await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, oP)).kind).toBe('created')
    await pg.softDeleteProjectTree('o', 'p1')
    // 修复前:返 existing 但 get().isDeleted=true;修复后:restored + isDeleted=false。
    const rp = await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, oP)
    expect(rp.kind).toBe('restored')
    const gp = await pg.get('o', 'project', 'p1')
    expect(gp.kind).toBe('found')
    if (gp.kind === 'found') expect(gp.record.isDeleted).toBe(false)
    // canvas(createCanvasWithCollection replay-deleted;project p2 独立保持 live)
    await pg.ensureCreate('o', 'project', 'p2', { name: 'P2' }, { method: 'POST', resourceKind: 'project' })
    const oC = { method: 'POST', resourceKind: 'canvas', idempotencyKey: 'k-c', bodyFingerprint: 'fpc' }
    expect((await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p2' }, oC)).kind).toBe('created')
    await pg.softDeleteCanvasTree('o', 'c1')
    const rc = await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p2' }, oC)
    expect(rc.kind).toBe('restored')
    const gc = await pg.get('o', 'canvas', 'c1')
    expect(gc.kind).toBe('found')
    if (gc.kind === 'found') expect(gc.record.isDeleted).toBe(false)
  })

  it('F2 tree 方法 no-op/错 owner 不产生幽灵授权索引(缓存信 DB 不信入参)', async () => {
    // missing id → count=0,无幽灵(修复前:getProjectOwner('missing')={ownerId:'ghost'})
    const sp = await pg.softDeleteProjectTree('ghost', 'missing')
    expect(sp.count).toBe(0)
    expect(pg.getProjectOwner('missing')).toBeUndefined()
    expect(pg.__projectCacheEntry('missing')).toBeUndefined()
    const sc = await pg.softDeleteCanvasTree('ghost', 'missing')
    expect(sc.count).toBe(0)
    expect(pg.getCanvasOwner('missing')).toBeUndefined()
    expect(pg.__canvasCacheEntry('missing')).toBeUndefined()
    await pg.restoreProjectTree('ghost', 'missing')
    expect(pg.getProjectOwner('missing')).toBeUndefined()
    await pg.restoreCanvasTree('ghost', 'missing')
    expect(pg.getCanvasOwner('missing')).toBeUndefined()
    // 错 owner 不污染他人索引(alice 的 project/canvas 不被 bob 触动;缓存归属 + live 状态不变)
    await pg.ensureCreate('alice', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('alice', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    const spb = await pg.softDeleteProjectTree('bob', 'p1') // 错 owner,count=0
    expect(spb.count).toBe(0)
    expect(pg.getProjectOwner('p1')?.ownerId).toBe('alice')
    expect(pg.projectLive('alice', 'p1')).toBe(true)
    const scb = await pg.softDeleteCanvasTree('bob', 'c1') // 错 owner,count=0
    expect(scb.count).toBe(0)
    expect(pg.getCanvasOwner('c1')?.ownerId).toBe('alice')
    expect(pg.__canvasCacheEntry('c1')?.isDeleted).toBe(false)
    // 错 owner restore 也不产生幽灵
    await pg.restoreProjectTree('bob', 'p1')
    expect(pg.getProjectOwner('p1')?.ownerId).toBe('alice')
    await pg.restoreCanvasTree('bob', 'c1')
    expect(pg.getCanvasOwner('c1')?.ownerId).toBe('alice')
    expect(pg.__canvasCacheEntry('c1')?.isDeleted).toBe(false)
  })

  it('F3 跨 owner upsert 同 id → exists-other-owner(不跨 owner insert、不覆盖缓存/DB;重启 warm 一致)', async () => {
    await pg.ensureCreate('ownerA', 'project', 'shared', { name: 'A' }, { method: 'POST', resourceKind: 'project' })
    // B upsert 同 id(missing for B)→ exists-other-owner(修复前:返 created + 缓存覆盖成 B + persist_records 进 B 的行,重启 warm 分叉成 A)
    const b = await pg.upsert('ownerB', 'project', 'shared', { name: 'B' }, { method: 'PUT', resourceKind: 'project' })
    expect(b.kind).toBe('exists-other-owner')
    if (b.kind === 'exists-other-owner') expect(b.record.ownerId).toBe('ownerA')
    // 缓存不变
    expect(pg.getProjectOwner('shared')?.ownerId).toBe('ownerA')
    // DB 不变:B 无 record,A record 完好 live
    expect((await pg.get('ownerB', 'project', 'shared')).kind).toBe('missing')
    const a = await pg.get('ownerA', 'project', 'shared')
    expect(a.kind).toBe('found')
    if (a.kind === 'found') expect(a.record.isDeleted).toBe(false)
    // 重启 warm 一致(owner 仍 A)
    const pgB = new PgPersistBackend(pgConn())
    await pgB.migrate()
    await pgB.ready
    expect(pgB.getProjectOwner('shared')?.ownerId).toBe('ownerA')
    await pgB.destroy()
    // canvas 同型(B 用自己 live 的 pB 作父 project,过 F1 parent 检查 → 触达 F3 全局 owner 检查)
    await pg.ensureCreate('ownerA', 'project', 'pA', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('ownerA', 'c-shared', { projectId: 'pA' }, { method: 'POST', resourceKind: 'canvas' })
    await pg.ensureCreate('ownerB', 'project', 'pB', { name: 'PB' }, { method: 'POST', resourceKind: 'project' })
    const bc = await pg.upsert('ownerB', 'canvas', 'c-shared', { projectId: 'pB' }, { method: 'PUT', resourceKind: 'canvas' })
    expect(bc.kind).toBe('exists-other-owner')
    if (bc.kind === 'exists-other-owner') expect(bc.record.ownerId).toBe('ownerA')
    expect(pg.getCanvasOwner('c-shared')?.ownerId).toBe('ownerA')
  })

  it('F4 软删态同 ID 并发重建:稳定一 restored 一 existing(rowCount 定输赢)', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.softDeleteProjectTree('o', 'p1')
    // 修复前:UPDATE 命中一次却双双报 restored(restoreMetaInTrx affected=0 仍返 restored);修复后:rowCount 0 → existing,稳定一 restored 一 existing。
    const [a, b] = await Promise.all([
      pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' }),
      pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' }),
    ])
    expect([a.kind, b.kind].sort()).toEqual(['existing', 'restored'])
    expect(pg.projectLive('o', 'p1')).toBe(true)
    // canvas 同型(createCanvasWithCollection 并发重建软删 canvas;project p2 保持 live)
    await pg.ensureCreate('o', 'project', 'p2', { name: 'P2' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c2', { projectId: 'p2' }, { method: 'POST', resourceKind: 'canvas' })
    await pg.softDeleteCanvasTree('o', 'c2')
    const [ca, cb] = await Promise.all([
      pg.createCanvasWithCollection('o', 'c2', { projectId: 'p2' }, { method: 'POST', resourceKind: 'canvas' }),
      pg.createCanvasWithCollection('o', 'c2', { projectId: 'p2' }, { method: 'POST', resourceKind: 'canvas' }),
    ])
    expect([ca.kind, cb.kind].sort()).toEqual(['existing', 'restored'])
  })

  it('F5 project 级联删/恢复后 canvas 瘦索引(表+缓存)与 DB 一致', async () => {
    await pg.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await pg.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(await canvasTableIsDeleted('c1')).toBe(false)
    // 级联软删:canvas meta(persist_records)+ canvases 瘦索引表 + 缓存 全部 is_deleted=true
    // (修复前:只 set project 缓存,canvases 表/缓存不动 → canvases 表 is_deleted 仍 false、canvasIndex[c1] 仍 false,与 DB persist_records 分叉)
    await pg.softDeleteProjectTree('o', 'p1')
    expect(await canvasTableIsDeleted('c1')).toBe(true)
    expect(pg.__canvasCacheEntry('c1')?.isDeleted).toBe(true)
    const cv = await pg.get('o', 'canvas', 'c1')
    expect(cv.kind).toBe('found')
    if (cv.kind === 'found') expect(cv.record.isDeleted).toBe(true)
    // 级联恢复:全部 is_deleted=false(表+缓存+persist_records 一致)
    await pg.restoreProjectTree('o', 'p1')
    expect(await canvasTableIsDeleted('c1')).toBe(false)
    expect(pg.__canvasCacheEntry('c1')?.isDeleted).toBe(false)
    const cv2 = await pg.get('o', 'canvas', 'c1')
    expect(cv2.kind).toBe('found')
    if (cv2.kind === 'found') expect(cv2.record.isDeleted).toBe(false)
  })
})

// R2-1 [P1]:共享 Pool 预算 + ownsPool destroy 守护断言(PG-gated;CI 无 PG 跳过)。
// 首轮验收要求的"Pool max 总和断言 ≤ 预算 / ownsPool destroy 守护"一条都没写过——本块补齐。
// 不变量(F2 已在 app.ts 实现:persist+permission 共享**一个** Pool 注入两个 backend):
//  - 两 backend 各自 destroy() 是 no-op(ownsPool=false 守护)——不关共享池;
//  - 单 Pool 的 max = conn.maxConnections(Σ = max,非 2×max 叠加);
//  - 共享池在两 backend destroy 后仍可查(prove destroy guard 生效,未被任一 backend 关闭)。
;(PG_TEST_ENABLED ? describe : describe.skip)('R2-1: shared Pool budget + ownsPool destroy guard', () => {
  it('sharedPool 注入两 backend → 各 destroy no-op,共享池仍可查;单池 max=budget(Σ 不叠加)', async () => {
    const cfg = { ...pgConn(), idleTimeoutMs: 5000, connectionTimeoutMs: 5000 }
    const sharedPool = new Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      max: cfg.maxConnections,
      idleTimeoutMillis: cfg.idleTimeoutMs,
      connectionTimeoutMillis: cfg.connectionTimeoutMs,
    })
    try {
      const persist = new PgPersistBackend(cfg, sharedPool)
      const permission = new PgPermissionBackend(cfg, sharedPool)
      await persist.ready
      await permission.ready
      // 各自 destroy:ownsPool=false(注入)→ no-op,不关共享池(否则下面 query 报 'Pool was destroyed')。
      await persist.destroy()
      await permission.destroy()
      // 共享池仍可查 → prove 两 backend 的 destroy 都未销毁它(ownsPool 守护生效)。
      const r = await sharedPool.query('SELECT 1 AS ok')
      expect(r.rows[0].ok).toBe(1)
      // 单 Pool max = 预算(两 backend 共享同一池,Σ max = maxConnections,非 2× 叠加)。
      // pg Pool 把构造参数挂在 .options 上;max 即预算。
      const poolMax = (sharedPool as unknown as { options?: { max?: number } }).options?.max
      expect(poolMax).toBe(cfg.maxConnections)
    } finally {
      await sharedPool.end()
    }
  })
})
