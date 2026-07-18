// server/persist/backend.contract.dual.test.ts
// T1.3 双后端契约套件:把 PersistBackend 纯契约场景参数化跑在 memory + PG 两后端上
// (api-surface §6 "swap 不改契约...契约测试从内存换成 PG fixture 重跑")。**等价性核心证据**。
//
// 内存专有故障注入(monkey-patch bucket.set / globalCanvasOwners / idempotencyIndex,backend.test.ts)
// 测的是内存实现的快照回滚机制,不能跑在 PG 上——留在 backend.test.ts(memory-only);
// PG 原子性由 backend.pg.test.ts 用事务回滚验证(等效证据)。本套件只跑纯契约断言
// (kind/revision/orderKey/cross-canvas/cascade/contentVersion/idempotency/F1/F4),两后端同形。
//
// PG gate:`MIVO_PG_TEST=1`(本地 brew PG,见 docs/decisions/pg-backend-schema.md §7);CI 无 PG → 跳过 PG describe,内存套件仍必跑。

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { ArchivedCanvasWriteError, InMemoryPersistBackend, fingerprintOfBody, type PersistBackend, type PersistType } from './backend'
import { PgPersistBackend } from './pgBackend'

// ── 共享纯契约套件(makeBackend 返 fresh/singleton;resetBackend 清状态)────────────────────
const runPersistBackendContractSuite = (
  label: string,
  makeBackend: () => PersistBackend,
  resetBackend: (b: PersistBackend) => void | Promise<void>,
): void => {
  describe(`${label} — 返修 #1 project 全局唯一`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('同 owner 同 id → existing(幂等);跨 owner 同 id → exists-other-owner', async () => {
      const a1 = await b.ensureCreate('ownerA', 'project', 'p1', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
      expect(a1.kind).toBe('created')
      const a2 = await b.ensureCreate('ownerA', 'project', 'p1', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
      expect(a2.kind).toBe('existing')
      const b1 = await b.ensureCreate('ownerB', 'project', 'p1', { name: 'PB' }, { method: 'POST', resourceKind: 'project' })
      expect(b1.kind).toBe('exists-other-owner')
      if (b1.kind === 'exists-other-owner') expect(b1.record.ownerId).toBe('ownerA')
    })

    it('getProjectOwner 返全局归属(授权 seam 用)', async () => {
      await b.ensureCreate('ownerA', 'project', 'p1', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
      expect(b.getProjectOwner('p1')?.ownerId).toBe('ownerA')
      expect(b.getProjectOwner('missing')).toBeUndefined()
    })
  })

  describe(`${label} — 返修 #5 contentVersion bump`, () => {
    let b: PersistBackend
    const rec = async (b: PersistBackend, type: PersistType, id: string) => {
      const r = await b.get('o', type, id)
      if (r.kind !== 'found') throw new Error(`${type}:${id} not found`)
      return r.record
    }
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('子资源 upsert/hardDelete bump canvas meta contentVersion(不动 metaRevision)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      const cv = await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(cv.kind).toBe('created')
      if (cv.kind === 'created') expect(cv.record.revision).toBe(0)
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1', type: 'image' }, { method: 'PATCH', resourceKind: 'node' })
      const after1 = await rec(b, 'canvas', 'c1')
      expect((after1.payload as { contentVersion: number }).contentVersion).toBe(1)
      expect(after1.revision).toBe(0)
      await b.hardDeleteChild('o', 'c1', 'node', 'n1')
      const after2 = await rec(b, 'canvas', 'c1')
      expect((after2.payload as { contentVersion: number }).contentVersion).toBe(2)
      expect(after2.revision).toBe(0)
    })
  })

  describe(`${label} — 返修 #6 orderKey + reorder`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('append 分配递增 orderKey;listByCanvas ORDER BY orderKey', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n3', { id: 'n3' }, { method: 'PATCH', resourceKind: 'node' })
      const list = await b.listByCanvas('o', 'c1', 'node')
      expect(list.records.map((r) => r.id)).toEqual(['n1', 'n2', 'n3'])
      expect(list.records.map((r) => r.orderKey)).toEqual([0, 1, 2])
    })

    it('reorder 持久化 orderKey;list 反映新顺序', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n3', { id: 'n3' }, { method: 'PATCH', resourceKind: 'node' })
      await b.reorderChildren('o', 'c1', 'node', ['n3', 'n1', 'n2'], { base: 3 })
      const list = await b.listByCanvas('o', 'c1', 'node')
      expect(list.records.map((r) => r.id)).toEqual(['n3', 'n1', 'n2'])
      expect(list.records.map((r) => r.orderKey)).toEqual([0, 1, 2])
    })

    it('F5:reorderChildren stale base → conflict;base 匹配 → ok', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      const stale = await b.reorderChildren('o', 'c1', 'node', ['n1'], { base: 0 })
      expect(stale.kind).toBe('conflict')
      const ok = await b.reorderChildren('o', 'c1', 'node', ['n1'], { base: 1 })
      expect(ok.kind).toBe('ok')
    })

    it('F5:reorderChildren orderedIds 缺/多 → bad mismatch;重复 → bad duplicate', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' })
      // live set = {n1,n2}(cv=2);bad 分支先于 base 冲突检查,base 取正确值避免 noise。
      const m = await b.reorderChildren('o', 'c1', 'node', ['n1'], { base: 2 })
      expect(m.kind === 'bad' ? m.reason : '').toBe('mismatch')
      const d = await b.reorderChildren('o', 'c1', 'node', ['n1', 'n1', 'n2'], { base: 2 })
      expect(d.kind === 'bad' ? d.reason : '').toBe('duplicate')
    })
  })

  describe(`${label} — 返修 #7 原子 tree 软删/恢复`, () => {
    let b: PersistBackend
    const rec = async (type: PersistType, id: string) => {
      const r = await b.get('o', type, id)
      if (r.kind !== 'found') throw new Error(`${type}:${id} not found`)
      return r.record
    }
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('softDeleteCanvasTree 标 canvas meta + chat-collection(children 保持活记录)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      const { count } = await b.softDeleteCanvasTree('o', 'c1')
      expect(count).toBe(2)
      expect((await rec('canvas', 'c1')).isDeleted).toBe(true)
      expect((await rec('chat-collection', 'c1')).isDeleted).toBe(true)
      const node = await b.getChild('o', 'c1', 'node', 'n1')
      expect(node.kind).toBe('found')
      if (node.kind === 'found') expect(node.record.isDeleted).toBe(false)
    })

    it('restoreCanvasTree 原子恢复 canvas meta + chat-collection', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
      await b.softDeleteCanvasTree('o', 'c1')
      const { count } = await b.restoreCanvasTree('o', 'c1')
      expect(count).toBe(2)
      expect((await rec('canvas', 'c1')).isDeleted).toBe(false)
      expect((await rec('chat-collection', 'c1')).isDeleted).toBe(false)
    })

    it('softDeleteProjectTree 标 project + canvas meta + chat-collection(原子)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      const { count } = await b.softDeleteProjectTree('o', 'p1')
      expect(count).toBe(3)
      expect((await rec('project', 'p1')).isDeleted).toBe(true)
      expect((await rec('canvas', 'c1')).isDeleted).toBe(true)
      expect((await rec('chat-collection', 'c1')).isDeleted).toBe(true)
      const node = await b.getChild('o', 'c1', 'node', 'n1')
      if (node.kind === 'found') expect(node.record.isDeleted).toBe(false)
    })

    // P3 item 5:ensureCreate(project deleted) 走 restore helper(projectStateInTrx 锁 + restoreProjectTreeInTrx)。
    //   非语义优化(同事务内复用上游已取的 projectState,不再重复 projectStateInTrx)→ 功能非回归:deleted project
    //   ensureCreate 仍返 restored + project/子 canvas/chat-collection 全部 live。memory/PG 双后端对称(PG 侧走
    //   新 preProjectState 复用路径,memory 侧无 projectStateInTrx,逻辑等价)。
    it('P3 item 5: ensureCreate(deleted project) → restored(非语义优化非回归,both backends)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
      await b.softDeleteProjectTree('o', 'p1')
      // deleted project ensureCreate → restore helper 跑通(返 restored,非 existing/created)
      const r = await b.ensureCreate('o', 'project', 'p1', { name: 'P2' }, { method: 'POST', resourceKind: 'project' })
      expect(r.kind).toBe('restored')
      expect((await rec('project', 'p1')).isDeleted).toBe(false)
      expect((await rec('canvas', 'c1')).isDeleted).toBe(false)
      expect((await rec('chat-collection', 'c1')).isDeleted).toBe(false)
    })
  })

  describe(`${label} — 返修 #10 幂等复合 key + fingerprint`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('幂等 key 作用域 owner+method+resourceKind+key:跨 type 不串', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      const fp = fingerprintOfBody({ payload: { id: 'x1' } })
      const n = await b.upsertChild('o', 'c1', 'node', 'x1', { id: 'x1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: fp })
      expect(n.kind).toBe('created')
      const e = await b.upsertChild('o', 'c1', 'edge', 'x1', { id: 'x1' }, { method: 'PATCH', resourceKind: 'edge', idempotencyKey: 'k1', bodyFingerprint: fp })
      expect(e.kind).toBe('created')
      const n2 = await b.upsertChild('o', 'c1', 'node', 'x1', { id: 'x1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: fp })
      expect(n2.kind).toBe('updated')
    })

    it('fingerprint 存入 record(结果回填)', async () => {
      const fp = fingerprintOfBody({ name: 'P' })
      const r = await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project', idempotencyKey: 'k1', bodyFingerprint: fp })
      if (r.kind === 'created') expect(r.record.fingerprint).toBe(fp)
    })
  })

  describe(`${label} — 返修三 F1 canvas parent live + F4 canvas 全局唯一`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('F4:canvas 跨 owner 同 id → exists-other-owner;同 owner 幂等 existing;globalCanvasOwners 不覆盖', async () => {
      await b.ensureCreate('oA', 'project', 'pA', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('oB', 'project', 'pB', { name: 'PB' }, { method: 'POST', resourceKind: 'project' })
      const a1 = await b.ensureCreate('oA', 'canvas', 'c1', { projectId: 'pA' }, { method: 'POST', resourceKind: 'canvas' })
      expect(a1.kind).toBe('created')
      const a2 = await b.ensureCreate('oA', 'canvas', 'c1', { projectId: 'pA' }, { method: 'POST', resourceKind: 'canvas' })
      expect(a2.kind).toBe('existing')
      const b1 = await b.ensureCreate('oB', 'canvas', 'c1', { projectId: 'pB' }, { method: 'POST', resourceKind: 'canvas' })
      expect(b1.kind).toBe('exists-other-owner')
      if (b1.kind === 'exists-other-owner') expect(b1.record.ownerId).toBe('oA')
      expect(b.getCanvasOwner('c1')?.ownerId).toBe('oA')
    })

    it('F1:canvas 父 project 软删 → parent-not-live;restoreProjectTree 后 live', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(b.projectLive('o', 'p1')).toBe(true)
      await b.softDeleteProjectTree('o', 'p1')
      expect(b.projectLive('o', 'p1')).toBe(false)
      const r1 = await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r1.kind).toBe('parent-not-live')
      const r2 = await b.ensureCreate('o', 'canvas', 'c2', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r2.kind).toBe('parent-not-live')
      await b.restoreProjectTree('o', 'p1')
      expect(b.projectLive('o', 'p1')).toBe(true)
      const r3 = await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r3.kind).toBe('existing')
    })
  })

  describe(`${label} — 返修四 F1 createCanvasWithCollection 原子 + barrier(TOCTOU orphan)`, () => {
    let b: PersistBackend
    const rec = async (type: PersistType, id: string) => {
      const r = await b.get('o', type, id)
      if (r.kind !== 'found') throw new Error(`${type}:${id} ${r.kind}`)
      return r.record
    }
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('F1 barrier:canvas meta 已建+project 软删 → primitive parent-not-live,树内零 live orphan', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.softDeleteProjectTree('o', 'p1')
      const r = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r.kind).toBe('parent-not-live')
      expect((await b.get('o', 'chat-collection', 'c1')).kind).toBe('missing')
      const canvas = await b.get('o', 'canvas', 'c1')
      expect(canvas.kind).toBe('found')
      if (canvas.kind === 'found') expect(canvas.record.isDeleted).toBe(true)
    })

    it('F1:parent live → createCanvasWithCollection 原子建 canvas+collection(both live);idempotent existing/restored', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      const r1 = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r1.kind).toBe('created')
      expect((await b.get('o', 'canvas', 'c1')).kind).toBe('found')
      const coll1 = await b.get('o', 'chat-collection', 'c1')
      expect(coll1.kind).toBe('found')
      if (coll1.kind === 'found') expect(coll1.record.isDeleted).toBe(false)
      const r2 = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r2.kind).toBe('existing')
      await b.softDeleteCanvasTree('o', 'c1')
      expect((await rec('canvas', 'c1')).isDeleted).toBe(true)
      expect((await rec('chat-collection', 'c1')).isDeleted).toBe(true)
      const r3 = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      expect(r3.kind).toBe('restored')
      expect((await rec('canvas', 'c1')).isDeleted).toBe(false)
      expect((await rec('chat-collection', 'c1')).isDeleted).toBe(false)
    })
  })

  describe(`${label} — DP-6R chat per-actor(私有 + 不 bump 共享 cv + 删/恢复不串)`, () => {
    let b: PersistBackend
    const canvasRec = async () => {
      const r = await b.get('o', 'canvas', 'c1')
      if (r.kind !== 'found') throw new Error('canvas c1 missing')
      return r.record
    }
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('两 actor 同 canvas 拥同 messageId 各自独立(per-actor namespace);listByCanvas 只见自己', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      // 两 actor 各 POST 同 id 'm1'(per-actor namespace:PK=(actor,'chat-message','m1'))
      const aA = await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: 'A' }, { method: 'POST', resourceKind: 'chat-message' })
      expect(aA.kind).toBe('created')
      const aB = await b.ensureCreateChild('actorB', 'c1', 'chat-message', 'm1', { text: 'B' }, { method: 'POST', resourceKind: 'chat-message' })
      expect(aB.kind).toBe('created') // 同 id 不撞(per-actor)
      // 各自 GET 只见自己 + payload 不串
      const listA = await b.listByCanvas('actorA', 'c1', 'chat-message')
      const listB = await b.listByCanvas('actorB', 'c1', 'chat-message')
      expect(listA.records.map((r) => r.id)).toEqual(['m1'])
      expect(listB.records.map((r) => r.id)).toEqual(['m1'])
      expect((listA.records[0].payload as { text: string }).text).toBe('A')
      expect((listB.records[0].payload as { text: string }).text).toBe('B')
      // canvas owner('o')GET chat → 空(owner 自己没写过 chat;旧 owner chat 才在 'o' 名下,见下条)
      expect((await b.listByCanvas('o', 'c1', 'chat-message')).records).toHaveLength(0)
    })

    it('chat 写入不 bump 共享 canvas contentVersion(node 写入仍 bump)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      const cv0 = (await canvasRec()).payload as { contentVersion?: number }
      expect(cv0.contentVersion ?? 0).toBe(0)
      // chat 写入(actor)→ 不 bump 共享 cv
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: 'hi' }, { method: 'POST', resourceKind: 'chat-message' })
      const cv1 = (await canvasRec()).payload as { contentVersion?: number }
      expect(cv1.contentVersion ?? 0).toBe(0) // chat 不 bump
      // node 写入(canvas owner)→ bump 共享 cv
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      const cv2 = (await canvasRec()).payload as { contentVersion?: number }
      expect(cv2.contentVersion ?? 0).toBe(1) // node bump
      // PATCH/DELETE chat 也不 bump
      await b.upsertChild('actorA', 'c1', 'chat-message', 'm1', { text: 'edit' }, { method: 'PATCH', resourceKind: 'chat-message', base: 0 })
      await b.hardDeleteChild('actorA', 'c1', 'chat-message', 'm1')
      const cv3 = (await canvasRec()).payload as { contentVersion?: number }
      expect(cv3.contentVersion ?? 0).toBe(1) // chat edit/delete 不 bump,node 的 cv 保留
    })

    it('hardDeleteChild 只删 actor 自己的(非己 msgId → deleted=false,不触他人)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: 'A' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorB', 'c1', 'chat-message', 'm1', { text: 'B' }, { method: 'POST', resourceKind: 'chat-message' })
      // actorB 删 'm1'(actorB 的)→ deleted=true;actorA 的 m1 不受影响
      const delB = await b.hardDeleteChild('actorB', 'c1', 'chat-message', 'm1')
      expect(delB.deleted).toBe(true)
      expect((await b.listByCanvas('actorA', 'c1', 'chat-message')).records).toHaveLength(1) // A 的 m1 在
      expect((await b.listByCanvas('actorB', 'c1', 'chat-message')).records).toHaveLength(0) // B 的删了
      // actorA 删 'mX'(不存在于 A)→ deleted=false
      const delMiss = await b.hardDeleteChild('actorA', 'c1', 'chat-message', 'mX')
      expect(delMiss.deleted).toBe(false)
    })

    it('P1-2:reorderChildren chat per-actor 独立 orderRevision compare+bump;不 bump 共享 cv;A/B 互不冲突', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorB', 'c1', 'chat-message', 'm1', { text: 'B1' }, { method: 'POST', resourceKind: 'chat-message' })
      // node 写一次 bump 共享 cv → 1(chat 不 bump cv);chat orderRevision 仍 0(初始,与共享 cv 解耦)。
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      const cvBefore = (((await canvasRec()).payload) as { contentVersion?: number }).contentVersion ?? 0
      expect(cvBefore).toBe(1)
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(0) // chat orderRevision 初始 0,非共享 cv
      // actorA reorder 自己的 [m1,m2]→[m2,m1](base=0=chat orderRevision,**非**共享 cv=1)→ ok,bump orderRevision→1
      const r = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(r.kind).toBe('ok')
      if (r.kind === 'ok') expect(r.contentVersion).toBe(1) // bump 后 chat orderRevision=1
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(1)
      // 共享 cv 未被 chat reorder 改(仍 1)
      const cvAfter = (((await canvasRec()).payload) as { contentVersion?: number }).contentVersion ?? 0
      expect(cvAfter).toBe(cvBefore)
      // actorA 顺序变了;actorB 不受影响(仍 [m1])
      expect((await b.listByCanvas('actorA', 'c1', 'chat-message')).records.map((r) => r.id)).toEqual(['m2', 'm1'])
      expect((await b.listByCanvas('actorB', 'c1', 'chat-message')).records.map((r) => r.id)).toEqual(['m1'])
      // actorB reorder 自己的 [m1](base=0=actorB 的 orderRevision,A 的 bump 不影响 B 独立 cursor)→ ok
      expect(await b.getChatOrderRevision('actorB', 'c1')).toBe(0)
      const rB = await b.reorderChildren('actorB', 'c1', 'chat-message', ['m1'], { base: 0 })
      expect(rB.kind).toBe('ok')
      if (rB.kind === 'ok') expect(rB.contentVersion).toBe(1) // B 独立 cursor bump→1
    })

    it('R2-P1-1:同 actor 同 base 真 Promise.all 并发 reorder——kinds 恰为 {ok, conflict}(双后端一致)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      // R2-P1-1:真并发(Promise.all,非顺序 await)。两同 base=0:赢家 CAS 抢中(rev→1);输家 CAS 见 rev=1≠0 → conflict。
      // PG 单语句 INSERT...ON CONFLICT WHERE revision=base 经 PK arbiter 串行;memory 同步临界区。kinds 恰 {ok, conflict}。
      const [r1, r2] = await Promise.all([
        b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 }),
        b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 }),
      ])
      expect([r1.kind, r2.kind].sort()).toEqual(['conflict', 'ok'])
      const loser = r1.kind === 'conflict' ? r1 : r2
      if (loser.kind === 'conflict') expect(loser.currentContentVersion).toBe(1) // 当前 orderRevision=1 供 client rebase
    })

    it('R2-P1-1:缺行(stale base≠0)→ conflict,不 INSERT(双后端一致;防 PG 缺行 INSERT 无条件成功)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      // 无前置 reorder → chat_order_revisions 缺行,equiv current=0。client 持 stale base=7(误以为有人 reorder 过)。
      // 双后端契约:缺行 + base≠0 → conflict(current=0),绝不 INSERT——否则 PG 缺行无条件 INSERT→ok,与 memory 分歧。
      const r = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 7 })
      expect(r.kind).toBe('conflict')
      if (r.kind === 'conflict') expect(r.currentContentVersion).toBe(0)
      // orderRevision 仍 0(未 INSERT 未 bump)
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(0)
    })

    it('R2-P1-1 附带:orderRevision 软删/恢复 保留不复位(防 ABA);restore 后 stale base 仍 conflict,base=current 仍 ok', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      // reorder → rev=1
      const r1 = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(r1.kind).toBe('ok')
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(1)
      // 软删 canvas(meta + chat-collection 标删;chat-message 活记录不动;chat_order_revisions **保留不复位**)
      await b.softDeleteCanvasTree('o', 'c1')
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(1) // 不复位(防 ABA:不回 0)
      // 恢复 canvas → orderRevision 仍 1
      await b.restoreCanvasTree('o', 'c1')
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(1)
      // 防 ABA:stale base=0(来自软删前)不复活 → conflict(current=1≠0)
      const rStale = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(rStale.kind).toBe('conflict')
      // 正确 base=1 → ok(bump→2)
      const rOk = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m1', 'm2'], { base: 1 })
      expect(rOk.kind).toBe('ok')
      if (rOk.kind === 'ok') expect(rOk.contentVersion).toBe(2)
    })

    it('R2-P1-2:listChatWithOrderRevision 返回自洽 (rev, messages) 对——reorder 前后各自自洽(双后端契约)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      // 初始:自洽对 (rev=0, [m1,m2])
      const before = await b.listChatWithOrderRevision('actorA', 'c1')
      expect(before.orderRevision).toBe(0)
      expect(before.records.map((r) => r.id)).toEqual(['m1', 'm2'])
      // reorder → rev=1, [m2,m1]
      const r1 = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(r1.kind).toBe('ok')
      // reorder 后:自洽对 (rev=1, [m2,m1])——不出现 torn(rev 配错序)。
      // memory 同步临界区(两读间无 await 让出)与 PG 单事务 REPEATABLE READ 快照均保证自洽;
      // 真并发 barrier(在两读之间确定性暂停并提交 reorder)见 PG 专有套件——不在此用普通 Promise.all 冒充。
      const after = await b.listChatWithOrderRevision('actorA', 'c1')
      expect(after.orderRevision).toBe(1)
      expect(after.records.map((r) => r.id)).toEqual(['m2', 'm1'])
    })

    it('P1-2:node 写 bump 共享 cv 不使 chat reorder 误 409(解耦);chat reorder 不 bump 共享 cv', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      // client A 读到 chat orderRevision=0;期间 node 写多次 bump 共享 cv(1,2,3)。
      expect(await b.getChatOrderRevision('actorA', 'c1')).toBe(0)
      await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n2', { id: 'n2' }, { method: 'PATCH', resourceKind: 'node' })
      await b.upsertChild('o', 'c1', 'node', 'n3', { id: 'n3' }, { method: 'PATCH', resourceKind: 'node' })
      expect((((await canvasRec()).payload) as { contentVersion?: number }).contentVersion ?? 0).toBe(3)
      // chat reorder base=0(orderRevision)仍 ok——node 写 bump 共享 cv 不触 chat orderRevision → 不误 409。
      const r = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(r.kind).toBe('ok')
      // 反向:chat reorder 不 bump 共享 cv(仍 3,非 4)
      expect((((await canvasRec()).payload) as { contentVersion?: number }).contentVersion ?? 0).toBe(3)
    })

    it('P2-1:chat PATCH strict-update——非己/不存在 msgId → not-found(不 create 己方副本);带 If-Match 也不借 PATCH create', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: 'A' }, { method: 'POST', resourceKind: 'chat-message' })
      // actorB strict-update PATCH 'mX'(B 名下不存在)→ not-found,B collection 不新增副本
      const bPatch = await b.upsertChild('actorB', 'c1', 'chat-message', 'mX', { text: 'B-copy' }, { method: 'PATCH', resourceKind: 'chat-message', strictUpdate: true })
      expect(bPatch.kind).toBe('not-found')
      expect((await b.listByCanvas('actorB', 'c1', 'chat-message')).records).toHaveLength(0)
      // actorA strict-update PATCH 自己的 m1 base=0 → updated(正确 revision)
      const aPatch = await b.upsertChild('actorA', 'c1', 'chat-message', 'm1', { text: 'A-edit' }, { method: 'PATCH', resourceKind: 'chat-message', base: 0, strictUpdate: true })
      expect(aPatch.kind).toBe('updated')
      // 带 If-Match(base=0)也不能借 PATCH create——strictUpdate 优先,不存在的 mY 仍 not-found
      const withBase = await b.upsertChild('actorB', 'c1', 'chat-message', 'mY', { text: 'B-copy2' }, { method: 'PATCH', resourceKind: 'chat-message', base: 0, strictUpdate: true })
      expect(withBase.kind).toBe('not-found')
      expect((await b.listByCanvas('actorB', 'c1', 'chat-message')).records).toHaveLength(0)
    })

    it('删/恢复画布不串 actor collection:per-actor chat-message 活记录不动,restore 后各见自己', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'mA', { text: 'A' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorB', 'c1', 'chat-message', 'mB', { text: 'B' }, { method: 'POST', resourceKind: 'chat-message' })
      // 软删 canvas → canvas meta + chat-collection(under 'o')标删;per-actor chat-message 活记录不动
      await b.softDeleteCanvasTree('o', 'c1')
      expect((await canvasRec()).isDeleted).toBe(true)
      // per-actor chat 仍在(活记录,随父级不可见靠 canvas 软删 + route authz)
      expect((await b.listByCanvas('actorA', 'c1', 'chat-message', { includeDeleted: true })).records.map((r) => r.id)).toEqual(['mA'])
      expect((await b.listByCanvas('actorB', 'c1', 'chat-message', { includeDeleted: true })).records.map((r) => r.id)).toEqual(['mB'])
      // restore canvas → 各 actor chat 仍各自在,不串
      await b.restoreCanvasTree('o', 'c1')
      expect((await b.listByCanvas('actorA', 'c1', 'chat-message')).records.map((r) => r.id)).toEqual(['mA'])
      expect((await b.listByCanvas('actorB', 'c1', 'chat-message')).records.map((r) => r.id)).toEqual(['mB'])
    })
  })

  // ── CR-6 缺口1(PR-A #266 backlog):findNodeOwners 全局反查(assets legacy detach 的权威归属来源)──
  describe(`${label} — CR-6 缺口1:findNodeOwners node 全局反查`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })

    it('返回 node 权威归属(ownerId/canvasId/isDeleted);未知 id → [];跨 owner 撞名 → 各返一条', async () => {
      await b.ensureCreate('ownerA', 'project', 'pA', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('ownerA', 'cA', { projectId: 'pA' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('ownerA', 'cA', 'node', 'n-shared', { type: 'image' }, { method: 'POST', resourceKind: 'node' })
      await b.ensureCreate('ownerB', 'project', 'pB', { name: 'PB' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('ownerB', 'cB', { projectId: 'pB' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('ownerB', 'cB', 'node', 'n-shared', { type: 'image' }, { method: 'POST', resourceKind: 'node' })
      const rs = await b.findNodeOwners('n-shared')
      expect(rs).toHaveLength(2)
      expect(rs).toContainEqual({ ownerId: 'ownerA', canvasId: 'cA', isDeleted: false })
      expect(rs).toContainEqual({ ownerId: 'ownerB', canvasId: 'cB', isDeleted: false })
      expect(await b.findNodeOwners('n-nonexistent')).toEqual([])
      // 物理删(deleteChildCascade)后不再命中(node/edge/anchor 硬删,无软删残留)。
      await b.deleteChildCascade('ownerA', 'cA', 'node', 'n-shared', { baseRevision: 0, method: 'DELETE', resourceKind: 'node', actor: 'ownerA' })
      const after = await b.findNodeOwners('n-shared')
      expect(after).toEqual([{ ownerId: 'ownerB', canvasId: 'cB', isDeleted: false }])
    })
  })

  // ── CR-6 缺口2(PR-A #266 backlog):TOCTOU 检查时守卫——archived 判定收进写入原子边界──
  // route authz(check-time)与 backend 写入(write-time)之间的窗口由本守卫封死:写入时刻 canvas 已
  // archived-live → throw ArchivedCanvasWriteError(顶层 onError → 409 archived)。PG 事务内 FOR UPDATE
  // canvas 行与 archive tree 的 UPDATE 串行化;memory 同步临界区判定与 mutation 间无 await 让出点,等效。
  describe(`${label} — CR-6 缺口2:TOCTOU 写入时守卫(archived → throw;per-canvas 粒度)`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = makeBackend()
      await resetBackend(b)
    })
    const seed = async (): Promise<void> => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('o', 'c1', 'node', 'n1', { type: 'image' }, { method: 'POST', resourceKind: 'node' })
    }

    it('archived canvas:全部子写方法 + canvas meta upsert 均 throw;unarchive 后恢复可写', async () => {
      await seed()
      await b.archiveCanvasTree('o', 'c1')
      await expect(b.upsertChild('o', 'c1', 'node', 'n1', { type: 'image' }, { method: 'PATCH', resourceKind: 'node', base: 0 })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.ensureCreateChild('o', 'c1', 'node', 'n2', { type: 'image' }, { method: 'POST', resourceKind: 'node' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.createChild('o', 'c1', 'node', 'n3', { type: 'image' }, { method: 'POST', resourceKind: 'node', actor: 'o' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.applyDomainOps('o', 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 't' }], { baseRevision: 0, method: 'PATCH', resourceKind: 'node', actor: 'o' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.deleteChildCascade('o', 'c1', 'node', 'n1', { baseRevision: 0, method: 'DELETE', resourceKind: 'node', actor: 'o' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.reorderChildren('o', 'c1', 'node', ['n1'], { base: 0 })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.hardDeleteChild('o', 'c1', 'node', 'n1')).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.legacyReplaceDrain('o', 'c1', 'node', 'n1', { payload: { type: 'image' }, baseRevision: 0 }, { method: 'PATCH', resourceKind: 'node', actor: 'o' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      await expect(b.upsert('o', 'canvas', 'c1', { projectId: 'p1', title: 'x' }, { base: 0, canvasId: null, method: 'PUT', resourceKind: 'canvas' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      // chat-message(per-actor 私有)同样封死(chat POST/PATCH/DELETE 路由均 authz 'write')。
      await expect(b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: 'x' }, { method: 'POST', resourceKind: 'chat-message' })).rejects.toBeInstanceOf(ArchivedCanvasWriteError)
      // 守卫抛出前零副作用:n1 未被改动(revision 仍 0),n2/n3 未创建。
      const n1 = await b.getChild('o', 'c1', 'node', 'n1')
      expect(n1.kind).toBe('found')
      if (n1.kind === 'found') expect(n1.record.revision).toBe(0)
      expect(await b.findNodeOwners('n2')).toEqual([])
      // unarchive → 写恢复(守卫只锁 archived-live 态)。
      await b.unarchiveCanvasTree('o', 'c1')
      const w = await b.upsertChild('o', 'c1', 'node', 'n1', { type: 'image' }, { method: 'PATCH', resourceKind: 'node', base: 0 })
      expect(w.kind).toBe('updated')
    })

    it('守卫错误自带 409 archived JSON 映射(getResponse 契约,顶层 ssoAuthErrorHandler structural 分支直接消费)', async () => {
      await seed()
      await b.archiveCanvasTree('o', 'c1')
      const err = await b
        .upsertChild('o', 'c1', 'node', 'n1', { type: 'image' }, { method: 'PATCH', resourceKind: 'node', base: 0 })
        .then(() => undefined)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ArchivedCanvasWriteError)
      const res = (err as ArchivedCanvasWriteError).getResponse()
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'archived', id: 'c1' })
    })

    it('manage/tree 路径不受守卫影响:archived canvas 可 softDelete(彻底删除);deleted(status 仍 archived)后子写放行(isDeleted 优先,不 false-409)', async () => {
      await seed()
      await b.archiveCanvasTree('o', 'c1')
      // DELETE(manage,彻底删除)是 CR-6 放行面——守卫不得拦 tree 方法。
      const del = await b.softDeleteCanvasTree('o', 'c1')
      expect(del.count).toBeGreaterThan(0)
      // canvas isDeleted=true(status 仍 'archived')→ 守卫放行(对齐 resolveCanvasAccess isDeleted 先于 archived
      // 的判定顺序;deleted canvas 的子写可达性由 route authz 兜 404,backend 不越位 409)。
      const r = await b.upsertChild('o', 'c1', 'node', 'n1', { type: 'image' }, { method: 'PATCH', resourceKind: 'node', base: 0 })
      expect(r.kind).toBe('updated')
    })

    it('per-canvas 粒度:c1 archived 不影响同 owner c2 子写', async () => {
      await seed()
      await b.createCanvasWithCollection('o', 'c2', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.archiveCanvasTree('o', 'c1')
      const r = await b.ensureCreateChild('o', 'c2', 'node', 'n-c2', { type: 'image' }, { method: 'POST', resourceKind: 'node' })
      expect(r.kind).toBe('created')
    })
  })
}

// ── memory 后端(永远跑)──────────────────────────────────────────────────────────────
runPersistBackendContractSuite('memory PersistBackend', () => new InMemoryPersistBackend(), (b) => b.__reset())

describe('memory PersistBackend — P2-1 external mutation canvas critical section', () => {
  const callbackFirst = async (archive: (b: InMemoryPersistBackend) => Promise<unknown>): Promise<void> => {
    const b = new InMemoryPersistBackend()
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    let entered!: () => void
    let release!: () => void
    const atMutation = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    let mutations = 0
    const guarded = b.withCanvasWriteGuard('o', 'c1', async () => {
      entered()
      await held
      mutations += 1
    })
    await atMutation
    let archiveSettled = false
    const archiving = archive(b).finally(() => { archiveSettled = true })
    await Promise.resolve()
    expect(archiveSettled).toBe(false)
    release()
    await Promise.all([guarded, archiving])
    expect(mutations).toBe(1)
    const canvas = await b.get('o', 'canvas', 'c1')
    expect(canvas.kind).toBe('found')
    if (canvas.kind === 'found') expect(canvas.record.status).toBe('archived')
  }

  it('guard callback first → archiveCanvasTree waits, terminal order mutation→archived', async () => {
    await callbackFirst((b) => b.archiveCanvasTree('o', 'c1'))
  })

  it('guard callback first → archiveProjectTree waits on child canvas, terminal order mutation→archived', async () => {
    await callbackFirst((b) => b.archiveProjectTree('o', 'p1'))
  })
})

// ── PG 后端(gate:MIVO_PG_TEST=1;本地 brew PG port 55443)─────────────────────────────────
const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'
let pgBackend: PgPersistBackend | undefined

;(PG_TEST_ENABLED ? describe : describe.skip)('PG PersistBackend(双后端等价性)', () => {
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
  runPersistBackendContractSuite(
    'PG PersistBackend',
    () => {
      if (!pgBackend) throw new Error('pg backend not initialized')
      return pgBackend
    },
    (b) => b.__reset(),
  )

  // R2-P1-2 真并发 barrier:torn pair 回归的确定性证据(PG 专有;memory 同步临界区无 await 让出点,barrier 无意义)。
  // barrier 在 listChatWithOrderRevision 的 messages SELECT 完成、orderRevision SELECT 开始之间暂停,
  // 期间提交 reorder,确定性命中 READ COMMITTED 的撕裂窗口;REPEATABLE READ snapshot 自洽不撕裂。
  describe('R2-P1-2 真并发 barrier(torn pair 回归;PG 专有)', () => {
    let b: PgPersistBackend
    beforeEach(async () => {
      b = pgBackend!
      await b.__reset()
      // 清空 barrier 旋钮防同实例其他用例泄漏(共享 pgBackend 单例)。
      b.__listChatTornPairTestHooks.afterMessages = undefined
      b.__listChatTornPairTestHooks.isolationLevel = undefined
    })
    afterEach(() => {
      b.__listChatTornPairTestHooks.afterMessages = undefined
      b.__listChatTornPairTestHooks.isolationLevel = undefined
    })

    /** 两读之间确定性暂停的 latch:afterMessages 信号 reached 后等 release;test 在窗口内提交 reorder。 */
    const makeBarrier = () => {
      let release = () => {}
      let signalReached = () => {}
      const reached = new Promise<void>((r) => {
        signalReached = r
      })
      const releaseP = new Promise<void>((r) => {
        release = r
      })
      return {
        afterMessages: async () => {
          signalReached() // messages SELECT 已完成,list 在 orderRevision SELECT 前暂停
          await releaseP // 等 test 在窗口内提交 reorder 后释放
        },
        reached,
        release: () => release(),
      }
    }

    /** 公共 setup:[m1,m2] rev=0 → 首次 reorder → rev=1 [m2,m1](barrier 期间将提交第二次 reorder → rev=2, [m1,m2])。 */
    const setupReordered = async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      const r1 = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(r1.kind).toBe('ok')
    }

    it('green:REPEATABLE READ + barrier——list 自洽(snapshot 冻结于 messages SELECT,见 pre-reorder)', async () => {
      await setupReordered()
      const barrier = makeBarrier()
      b.__listChatTornPairTestHooks.afterMessages = barrier.afterMessages
      // 启动 list:messages SELECT 完成(=[m2,m1],snapshot 冻结)→ barrier 暂停于 orderRevision SELECT 前。
      const listP = b.listChatWithOrderRevision('actorA', 'c1')
      await barrier.reached
      // 窗口内提交第二次 reorder(base=1 → rev=2, [m1,m2])——独立事务,不阻塞 list 的 ACCESS SHARE。
      const r2 = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m1', 'm2'], { base: 1 })
      expect(r2.kind).toBe('ok')
      if (r2.kind === 'ok') expect(r2.contentVersion).toBe(2)
      // 释放 list → orderRevision SELECT 见 snapshot 冻结值 rev=1(pre-reorder)。
      barrier.release()
      const list = await listP
      // 自洽 pre-state:(rev=1, [m2,m1])。不出现 torn (rev=2, [m2,m1])(旧 messages 配新 rev 会绕过乐观锁)。
      expect(list.orderRevision).toBe(1)
      expect(list.records.map((r) => r.id).join(',')).toBe('m2,m1')
    })

    it('red-detector:READ COMMITTED + barrier——list 出现 torn pair(旧 messages + 新 rev;barrier 非空转)', async () => {
      await setupReordered()
      const barrier = makeBarrier()
      b.__listChatTornPairTestHooks.afterMessages = barrier.afterMessages
      b.__listChatTornPairTestHooks.isolationLevel = 'read committed' // 强制回归态(production 永不设)
      const listP = b.listChatWithOrderRevision('actorA', 'c1')
      await barrier.reached
      // 窗口内提交第二次 reorder → rev=2, [m1,m2]。
      const r2 = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m1', 'm2'], { base: 1 })
      expect(r2.kind).toBe('ok')
      barrier.release()
      const list = await listP
      const ids = list.records.map((r) => r.id).join(',')
      // READ COMMITTED:messages SELECT 见 pre([m2,m1]),orderRevision SELECT 见 post(rev=2)→ torn pair。
      // 此断言通过 = barrier 真在两读之间暂停并让 reorder 提交介入;若 barrier 空转则必得 (1,[m2,m1]) 或 (2,[m1,m2])。
      expect(list.orderRevision).toBe(2)
      expect(ids).toBe('m2,m1')
    })

    it('稳定性:REPEATABLE READ + barrier 连续 20 次零波动(自洽 pre-state)', async () => {
      for (let i = 0; i < 20; i++) {
        await b.__reset()
        await setupReordered()
        const barrier = makeBarrier()
        b.__listChatTornPairTestHooks.afterMessages = barrier.afterMessages
        const listP = b.listChatWithOrderRevision('actorA', 'c1')
        await barrier.reached
        await b.reorderChildren('actorA', 'c1', 'chat-message', ['m1', 'm2'], { base: 1 })
        barrier.release()
        const list = await listP
        expect(list.orderRevision).toBe(1)
        expect(list.records.map((r) => r.id).join(',')).toBe('m2,m1')
      }
    })
  })
})
