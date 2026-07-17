// server/persist/archive.contract.dual.test.ts
// Phase 2 归档(PR-A):archive/unarchive tree 双后端契约套件(memory + PG)。
// 覆盖:archive/unarchive 原子+幂等、级联归档(archivedByCascade=true)、D3 级联恢复只恢复 cascade 子画布
// (单独归档的不被强制恢复)、includeArchived 列表过滤、D2 create(status:) 落库。
// memory 永远跑;PG gate `MIVO_PG_TEST=1`——CI pg-suite job 已接 PG16 service container 跑 PG 分支
// (见 .github/workflows/ci.yml pg suite required_files,本文件已入白名单);本地无 brew PG(port 55443)时 skip PG describe,内存套件仍必跑。
// 镜像 backend.contract.dual.test.ts 的 makeBackend/resetBackend + PG setup 模式。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { InMemoryPersistBackend, type PersistBackend } from './backend'
import { PgPersistBackend } from './pgBackend'

/** canvas meta payload 内 archivedByCascade(D3 级联归档标记)读取 helper。 */
const cascadeFlag = (r: { payload: unknown }): boolean | undefined =>
  typeof r.payload === 'object' && r.payload !== null ? (r.payload as { archivedByCascade?: boolean }).archivedByCascade : undefined

const rec = async (b: PersistBackend, ownerId: string, type: 'project' | 'canvas', id: string) => {
  const r = await b.get(ownerId, type, id)
  if (r.kind !== 'found') throw new Error(`${type}:${id} not found`)
  return r.record
}

const setup = async (b: PersistBackend, ownerId = 'o', projectId = 'p1', canvasIds = ['c1', 'c2']): Promise<void> => {
  await b.ensureCreate(ownerId, 'project', projectId, { name: 'P' }, { method: 'POST', resourceKind: 'project' })
  for (const cid of canvasIds) {
    await b.createCanvasWithCollection(ownerId, cid, { projectId }, { method: 'POST', resourceKind: 'canvas' })
  }
}

const runArchiveSuite = (
  label: string,
  makeBackend: () => PersistBackend,
  resetBackend: (b: PersistBackend) => void | Promise<void>,
): void => {
  describe(`${label} — Phase 2 归档 archive/unarchive tree`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('archiveCanvasTree:canvas status→archived + archivedByCascade=false(直接归档标记);幂等(重复→0 行,状态不变)', async () => {
      await setup(b)
      const r1 = await b.archiveCanvasTree('o', 'c1')
      expect(r1.count).toBe(1)
      const a1 = await rec(b, 'o', 'canvas', 'c1')
      expect(a1.status).toBe('archived')
      expect(cascadeFlag(a1)).toBe(false)
      // 幂等:重复 archive → 0 行 no-op,status 不变,revision 不再 bump
      const r2 = await b.archiveCanvasTree('o', 'c1')
      expect(r2.count).toBe(0)
      const a2 = await rec(b, 'o', 'canvas', 'c1')
      expect(a2.status).toBe('archived')
      expect(a2.revision).toBe(a1.revision)
    })

    it('unarchiveCanvasTree:status→active;幂等(已 active→0 行 no-op)', async () => {
      await setup(b)
      await b.archiveCanvasTree('o', 'c1')
      const r1 = await b.unarchiveCanvasTree('o', 'c1')
      expect(r1.count).toBe(1)
      expect((await rec(b, 'o', 'canvas', 'c1')).status).toBe('active')
      const r2 = await b.unarchiveCanvasTree('o', 'c1')
      expect(r2.count).toBe(0) // 幂等
    })

    it('archiveProjectTree:级联归档 project + 全部 active 子画布;children archivedByCascade=true', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      const res = await b.archiveProjectTree('o', 'p1')
      expect(res.count).toBeGreaterThan(0)
      expect((await rec(b, 'o', 'project', 'p1')).status).toBe('archived')
      const a1 = await rec(b, 'o', 'canvas', 'c1')
      const a2 = await rec(b, 'o', 'canvas', 'c2')
      expect(a1.status).toBe('archived')
      expect(a2.status).toBe('archived')
      expect(cascadeFlag(a1)).toBe(true) // 级联归档
      expect(cascadeFlag(a2)).toBe(true)
    })

    it('archiveProjectTree:幂等(重复→0 行;已归档子画布不被重触,archivedByCascade 既有值不变)', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.archiveProjectTree('o', 'p1')
      const r2 = await b.archiveProjectTree('o', 'p1')
      expect(r2.count).toBe(0) // 幂等:project 已 archived
    })

    it('D3:unarchiveProjectTree 只恢复 archivedByCascade=true 子画布;用户先前单独归档的不被强制恢复', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      // 先单独归档 c2(archivedByCascade=false)
      await b.archiveCanvasTree('o', 'c2')
      expect(cascadeFlag(await rec(b, 'o', 'canvas', 'c2'))).toBe(false)
      // 归档 project → c1 cascade-archived(true);c2 已 archived,不被重触(flag 仍 false)
      await b.archiveProjectTree('o', 'p1')
      expect(cascadeFlag(await rec(b, 'o', 'canvas', 'c1'))).toBe(true)
      expect(cascadeFlag(await rec(b, 'o', 'canvas', 'c2'))).toBe(false)
      expect((await rec(b, 'o', 'canvas', 'c2')).status).toBe('archived')
      // 恢复 project → c1 恢复(active);c2 不被强制恢复(仍 archived)
      await b.unarchiveProjectTree('o', 'p1')
      expect((await rec(b, 'o', 'project', 'p1')).status).toBe('active')
      expect((await rec(b, 'o', 'canvas', 'c1')).status).toBe('active')
      expect((await rec(b, 'o', 'canvas', 'c2')).status).toBe('archived') // D3:单独归档的留 archived
    })

    it('unarchiveProjectTree:幂等(已 active→0 行)', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.archiveProjectTree('o', 'p1')
      await b.unarchiveProjectTree('o', 'p1')
      const r2 = await b.unarchiveProjectTree('o', 'p1')
      expect(r2.count).toBe(0)
    })

    it('listByOwner 默认排除 archived;includeArchived=true 含 archived(deleted 始终排除)', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      await b.archiveCanvasTree('o', 'c2')
      const def = await b.listByOwner('o', 'canvas')
      expect(def.records.map((r) => r.id)).toEqual(['c1'])
      const all = await b.listByOwner('o', 'canvas', { includeArchived: true })
      expect(all.records.map((r) => r.id).sort()).toEqual(['c1', 'c2'])
    })

    it('listCanvasByProject 默认排除 archived;includeArchived=true 含', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      await b.archiveCanvasTree('o', 'c2')
      const def = await b.listCanvasByProject('o', 'p1')
      expect(def.records.map((r) => r.id)).toEqual(['c1'])
      const all = await b.listCanvasByProject('o', 'p1', { includeArchived: true })
      expect(all.records.map((r) => r.id).sort()).toEqual(['c1', 'c2'])
    })

    it('archiveCanvasTree 不改 is_deleted(归档≠软删;彻底删除仍走 softDelete)', async () => {
      await setup(b)
      await b.archiveCanvasTree('o', 'c1')
      const a = await rec(b, 'o', 'canvas', 'c1')
      expect(a.isDeleted).toBe(false)
      expect(a.status).toBe('archived')
    })

    it('D2:ensureCreate(project, status:archived) 落库 status=archived(combineOps create+archive 语义)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project', status: 'archived' })
      expect((await rec(b, 'o', 'project', 'p1')).status).toBe('archived')
    })

    it('D2:createCanvasWithCollection(status:archived) canvas 落库 status=archived', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas', status: 'archived' })
      expect((await rec(b, 'o', 'canvas', 'c1')).status).toBe('archived')
    })

    it('默认 create(无 status)为 active(非 archived):listByOwner 含之', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      const a = await rec(b, 'o', 'canvas', 'c1')
      expect(a.status).not.toBe('archived')
      const def = await b.listByOwner('o', 'canvas')
      expect(def.records.map((r) => r.id)).toContain('c1')
    })

    // ── SG-1:archived-parent 写入闸门(server 端 defense-in-depth,route → 409 archived)──
    it('SG-1:createCanvasWithCollection → archived 目标 project → parent-archived(不落任何行)', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.archiveProjectTree('o', 'p1')
      const r = await b.createCanvasWithCollection('o', 'c9', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r.kind).toBe('parent-archived')
      expect((await b.get('o', 'canvas', 'c9')).kind).toBe('missing')
    })

    it('SG-1:ensureCreate(canvas) → archived 目标 project → parent-archived', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.archiveProjectTree('o', 'p1')
      const r = await b.ensureCreate('o', 'canvas', 'c9', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r.kind).toBe('parent-archived')
    })

    it('SG-1:upsert(canvas) move → archived 目标 project → parent-archived(canvas 留在原 project)', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.ensureCreate('o', 'project', 'p2', { name: 'P2' }, { method: 'POST', resourceKind: 'project' })
      await b.archiveProjectTree('o', 'p2')
      const c1 = await rec(b, 'o', 'canvas', 'c1')
      const r = await b.upsert('o', 'canvas', 'c1', { projectId: 'p2' }, { base: c1.revision, scope: 'document', method: 'PUT', resourceKind: 'canvas' })
      expect(r.kind).toBe('parent-archived')
      const after = await rec(b, 'o', 'canvas', 'c1')
      expect((after.payload as { projectId?: string }).projectId).toBe('p1')
    })

    it('SG-1:软删 canvas 后 archive project → 重 POST(restore 路径)→ parent-archived(禁向 archived project 复活子画布)', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.softDeleteCanvasTree('o', 'c1')
      await b.archiveProjectTree('o', 'p1')
      const r = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r.kind).toBe('parent-archived')
      const got = await b.get('o', 'canvas', 'c1')
      expect(got.kind === 'found' && got.record.isDeleted).toBe(true) // 未被复活
    })

    it('SG-1:active 目标 project create/move 不受影响(回归)', async () => {
      await setup(b, 'o', 'p1', ['c1'])
      await b.ensureCreate('o', 'project', 'p2', { name: 'P2' }, { method: 'POST', resourceKind: 'project' })
      const r1 = await b.createCanvasWithCollection('o', 'c9', { projectId: 'p2' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r1.kind).toBe('created')
      const c1 = await rec(b, 'o', 'canvas', 'c1')
      const r2 = await b.upsert('o', 'canvas', 'c1', { projectId: 'p2' }, { base: c1.revision, scope: 'document', method: 'PUT', resourceKind: 'canvas' })
      expect(r2.kind).toBe('updated')
    })

    // ── SG-2:archived project 删除 active-child 门禁(route → 409 active-child)──
    it('SG-2:archived project + active 子画布 → softDeleteProjectTree blocked(零写)', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      await b.archiveProjectTree('o', 'p1')
      await b.unarchiveCanvasTree('o', 'c1') // 制造 archived project 下的 active child
      const r = await b.softDeleteProjectTree('o', 'p1')
      expect(r).toEqual({ count: 0, blocked: 'active-child' })
      // 零写:project 与子画布均未被软删
      expect((await rec(b, 'o', 'project', 'p1')).isDeleted).toBe(false)
      expect((await rec(b, 'o', 'canvas', 'c1')).isDeleted).toBe(false)
      expect((await rec(b, 'o', 'canvas', 'c2')).isDeleted).toBe(false)
    })

    it('SG-2:archived project + 纯 archived 子画布 → 整树软删成功', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      await b.archiveProjectTree('o', 'p1')
      const r = await b.softDeleteProjectTree('o', 'p1')
      expect(r.blocked).toBeUndefined()
      expect(r.count).toBeGreaterThan(0)
      expect((await rec(b, 'o', 'project', 'p1')).isDeleted).toBe(true)
      expect((await rec(b, 'o', 'canvas', 'c1')).isDeleted).toBe(true)
      expect((await rec(b, 'o', 'canvas', 'c2')).isDeleted).toBe(true)
    })

    it('SG-2:active project 正常删除(整树软删)语义不变(回归,门禁只针对 archived project)', async () => {
      await setup(b, 'o', 'p1', ['c1', 'c2'])
      const r = await b.softDeleteProjectTree('o', 'p1')
      expect(r.blocked).toBeUndefined()
      expect(r.count).toBeGreaterThan(0)
      expect((await rec(b, 'o', 'project', 'p1')).isDeleted).toBe(true)
      expect((await rec(b, 'o', 'canvas', 'c1')).isDeleted).toBe(true)
      expect((await rec(b, 'o', 'canvas', 'c2')).isDeleted).toBe(true)
    })
  })
}

// ── memory 后端(永远跑)──────────────────────────────────────────────────────────────
runArchiveSuite('memory PersistBackend', () => new InMemoryPersistBackend(), (b) => b.__reset())

// ── PG 后端(gate:MIVO_PG_TEST=1;本地 brew PG port 55443)─────────────────────────────────
const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'
let pgBackend: PgPersistBackend | undefined

;(PG_TEST_ENABLED ? describe : describe.skip)('PG PersistBackend — Phase 2 归档', () => {
  beforeAll(async () => {
    pgBackend = new PgPersistBackend({
      host: process.env.MIVO_PG_HOST || '127.0.0.1',
      port: Number(process.env.MIVO_PG_PORT || 55443),
      database: process.env.MIVO_PG_DB || 'mivocanvas',
      user: process.env.MIVO_PG_USER || 'mivo',
      password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
      maxConnections: 5,
      idleTimeoutMs: 5000,
    })
    await pgBackend.migrate()
    await pgBackend.ready
  })
  afterAll(async () => {
    if (pgBackend) await pgBackend.destroy()
  })
  runArchiveSuite(
    'PG PersistBackend',
    () => {
      if (!pgBackend) throw new Error('pg backend not initialized')
      return pgBackend
    },
    (b) => b.__reset(),
  )

  // migration 010 存量默认 active:DEFAULT 'active' 落新插入行(同 DEFAULT 回填存量行的证明)。
  it('PG migration 010:新插入行(无 status)默认 active;CHECK 约束容纳 active/archived', async () => {
    const b = pgBackend!
    await b.__reset()
    // 新插入行(不显式传 status)→ 列 NOT NULL DEFAULT 'active' → rowToRecord 直读 'active'。
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    expect((await rec(b, 'o', 'project', 'p1')).status).toBe('active')
    // archive 写 'archived' 合法(CHECK 约束 IN ('active','archived') 容纳,不抛)
    await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.archiveCanvasTree('o', 'c1')
    expect((await rec(b, 'o', 'canvas', 'c1')).status).toBe('archived')
  })
})
