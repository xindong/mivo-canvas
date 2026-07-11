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

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { InMemoryPersistBackend, fingerprintOfBody, type PersistBackend, type PersistType } from './backend'
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

    it('P1-2:同 actor 同 base 两并发 reorder 一成一败(stale base → conflict,返当前 orderRevision)', async () => {
      await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
      await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm1', { text: '1' }, { method: 'POST', resourceKind: 'chat-message' })
      await b.ensureCreateChild('actorA', 'c1', 'chat-message', 'm2', { text: '2' }, { method: 'POST', resourceKind: 'chat-message' })
      // 两"并发"都 base=0:赢家 ok(rev→1);输家 base=0 !== 1 → conflict(内存同步串行,等价两并发一成一败)。
      const win = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(win.kind).toBe('ok')
      const lose = await b.reorderChildren('actorA', 'c1', 'chat-message', ['m2', 'm1'], { base: 0 })
      expect(lose.kind).toBe('conflict')
      if (lose.kind === 'conflict') expect(lose.currentContentVersion).toBe(1) // 当前 orderRevision=1 供 client rebase
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
}

// ── memory 后端(永远跑)──────────────────────────────────────────────────────────────
runPersistBackendContractSuite('memory PersistBackend', () => new InMemoryPersistBackend(), (b) => b.__reset())

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
})
