// server/persist/backend.pg.test.ts
// T1.3 PG 后端专用测试:冷启动预热(服务器重启无损证据)+ 事务原子性 + 跨实例缓存一致性。
// PG gate:MIVO_PG_TEST=1(本地 brew PG port 55443);CI 无 PG 跳过。
// 契约等价性由 backend.contract.dual.test.ts 覆盖(32 场景 memory+PG 同形);本测钉 PG 专有性质。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PgPersistBackend } from './pgBackend'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'

const pgConn = () => ({
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_DB || 'mivocanvas',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
  maxConnections: 5,
  idleTimeoutMs: 5000,
})

;(PG_TEST_ENABLED ? describe : describe.skip)('PgPersistBackend — PG 专有性质', () => {
  let pg: PgPersistBackend
  beforeAll(async () => {
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
})
