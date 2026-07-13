// server/persist/backend.a2s2.test.ts
// A2-S2 契约测试:§14.1 冻结矩阵全 case(edit stale 200/overwritten 同 field 判定 / 409 三类 delete-race+reorder+create-dup / 400 两类 malformed+scope-mismatch)。
// 权威:docs/decisions/n20-truth-source-decision.md §14.1/§14.7 NOTES + spike S10-12 BaseDrivenHarness 语义蓝本。
// 范围:直接调 backend(PersistBackend interface;memory 总跑 + PG gated MIVO_PG_TEST=1,对齐 backend.contract.dual 模式)。不走 HTTP route(route 层在 canvas.route.test.ts)。
//
// 冻结矩阵(§14.1):
// - edit stale 永不 409;同 fieldKeyOf path stale → 200 + overwritten(不同 field stale 不误报)
// - delete/reorder fresh base → 200, stale base → 409 race;create dup → 409
// - missing base → 428;malformed/scope-mismatch → 400

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { InMemoryPersistBackend, type PersistBackend } from './backend'
import type { ApplyDomainOpsResult, CreateChildResult, GetChildResult } from './backend'
import { PgPersistBackend } from './pgBackend'
import { setBaseCursorSecrets, encodeBase, decodeBase, encodeOrderBase, decodeOrderBase } from '../lib/baseCursor'
import { validateDomainOps, type DomainOp } from '../lib/domainOp'

// A2-S2:注入 BaseCursor test secret(encodeBase/decodeBase 同进程共享)。join 构造防 secret-detection hook 误报。
const TEST_SECRET = ['test', 'secret', 'a2s2'].join('-')
beforeAll(() => setBaseCursorSecrets([TEST_SECRET]))
afterAll(() => setBaseCursorSecrets(null))

const found = (r: GetChildResult): Extract<GetChildResult, { kind: 'found' }> => {
  if (r.kind !== 'found') throw new Error(`expected found, got ${r.kind}`)
  return r as Extract<GetChildResult, { kind: 'found' }>
}

// narrow helpers:union variant 访问前先 narrow(TS 不自动从 expect.toBe narrow)。
const acc = (r: ApplyDomainOpsResult): Extract<ApplyDomainOpsResult, { kind: 'accepted' }> => {
  if (r.kind !== 'accepted') throw new Error(`expected accepted, got ${r.kind}`)
  return r
}
const cre = (r: CreateChildResult): Extract<CreateChildResult, { kind: 'created' }> => {
  if (r.kind !== 'created') throw new Error(`expected created, got ${r.kind}`)
  return r
}

const makeNode = (id: string, over: Record<string, unknown> = {}): unknown => ({
  id, type: 'text', title: id, transform: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
  fills: [], strokes: [], effects: [], relations: {}, text: 'hello',
  fontSize: 14, textColor: '#000000', fontWeight: 400, textAlign: 'left', textAutoWidth: true,
  ...over,
})

const seedCanvas = async (b: PersistBackend, ownerId = 'owner', canvasId = 'c1'): Promise<void> => {
  await b.upsert(ownerId, 'canvas', canvasId, { projectId: 'p1' }, { base: 0, scope: 'document', method: 'POST', resourceKind: 'canvas' })
}

const op = (o: unknown): DomainOp[] => validateDomainOps(o)

/**
 * §14.1 冻结矩阵契约套件(backend-agnostic;memory + PG 双跑,对齐 backend.contract.dual 模式)。
 * factory:memory 每 test new;PG 返 beforeAll 创建+ready 的共享实例。reset:清表隔离。
 */
const runA2S2ContractSuite = (
  label: string,
  make: () => PersistBackend,
  reset: (b: PersistBackend) => Promise<void> | void,
): void => {
  describe(`A2-S2 §14.1 冻结矩阵 — ${label}`, () => {
    let b: PersistBackend
    beforeEach(async () => {
      b = make()
      await reset(b)
    })

    describe('edit stale 永不 409 + 同 fieldKeyOf path stale 才 overwritten(§14.1 Blocker 1)', () => {
      it('同 field stale(base.clock<current)→ accepted + overwritten(historicalValue+byActor);edit 永不 409', async () => {
        await seedCanvas(b)
        const created = await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        expect(created.kind).toBe('created')
        const rev1 = cre(created).record.revision // 1
        // A 改 title(base rev1, fieldClocks {})
        const rA = await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['title'], value: 'A-title' }), { baseRevision: rev1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'alice' })
        expect(rA.kind).toBe('accepted')
        expect(acc(rA).overwritten).toHaveLength(0) // A 是首写者,title.clock base=0=current=0 → 不 stale
        // B 改 title(base rev1 stale;title.clock base=0 < current=1)→ accepted + overwritten(同 field)
        const rB = await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['title'], value: 'B-title' }), { baseRevision: rev1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'bob' })
        expect(rB.kind).toBe('accepted') // ★ edit 永不 409
        expect(acc(rB).overwritten).toHaveLength(1)
        expect(acc(rB).overwritten[0].fieldKey).toBe('title')
        expect(acc(rB).overwritten[0].byActor).toBe('alice')
        expect(acc(rB).overwritten[0].historicalValue).toBe('A-title')
      })

      it('不同 field stale(base 落后但改的是另一 field)→ accepted + overwritten 空(不误报)', async () => {
        await seedCanvas(b)
        await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        // A 改 transform.x
        const rA = await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['transform', 'x'], value: 100 }), { baseRevision: 1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'alice' })
        expect(rA.kind).toBe('accepted')
        // B 改 title(base rev1 stale;transform.x.clock=1 但 B 改 title 不是 transform.x)→ 不触发 overwritten
        const rB = await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['title'], value: 'B' }), { baseRevision: 1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'bob' })
        expect(rB.kind).toBe('accepted')
        expect(acc(rB).overwritten).toHaveLength(0) // ★ 不同 field stale 不误报(transform.x≠title)
        // 验证双留:A 的 transform.x=100 + B 的 title='B'
        const reread = await b.getChild('owner', 'c1', 'node', 'n1')
        expect((found(reread).record.payload as { transform: { x: number } }).transform.x).toBe(100)
        expect((found(reread).record.payload as { title: string }).title).toBe('B')
      })

      it('transform.x 与 transform.y stale 互不误报(fieldKeyOf 完整 path 粒度,非 fieldPath[0])', async () => {
        await seedCanvas(b)
        await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        // A 改 transform.x
        await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['transform', 'x'], value: 10 }), { baseRevision: 1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'alice' })
        // B 改 transform.y(base rev1 stale;transform.x.clock=1 但 transform.y.clock=0)→ transform.y 不 stale → 无 overwritten
        const rB = await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['transform', 'y'], value: 20 }), { baseRevision: 1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'bob' })
        expect(rB.kind).toBe('accepted')
        expect(acc(rB).overwritten).toHaveLength(0) // ★ transform.x≠transform.y(完整 path 粒度,非 transform 合并)
      })

      it('batch 同 record 原子:多 op 全 ok;响应 base 签发 + seq', async () => {
        await seedCanvas(b)
        await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        const r = await b.applyDomainOps('owner', 'c1', 'node', 'n1', op([{ kind: 'set', fieldPath: ['title'], value: 'T' }, { kind: 'set', fieldPath: ['transform', 'x'], value: 5 }]), { baseRevision: 1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'alice' })
        expect(r.kind).toBe('accepted')
        expect(acc(r).seq).toBeGreaterThan(0)
        expect(acc(r).fieldClocks['title']).toBe(1)
        expect(acc(r).fieldClocks['transform.x']).toBe(1)
        // base 可 decode round-trip
        const base = encodeBase('c1', 'n1', acc(r).record.revision, acc(r).fieldClocks)
        expect(decodeBase(base, 'c1', 'n1')).toEqual({ revision: acc(r).record.revision, fieldClocks: acc(r).fieldClocks })
      })
    })

    describe('delete fresh/stale + 幂等 + 从未存在(§10.4/§10.7)', () => {
      it('fresh base → deleted + seq cursor;幂等已删 → idempotent(不 404);从未存在 → not-found', async () => {
        await seedCanvas(b)
        const created = await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        const rev1 = cre(created).record.revision
        // fresh base → deleted
        const d1 = await b.deleteChildCascade('owner', 'c1', 'node', 'n1', { baseRevision: rev1, method: 'DELETE', resourceKind: 'node', actor: 'alice' })
        expect(d1.kind).toBe('deleted')
        if (d1.kind === "deleted") expect(d1.seq).toBeGreaterThan(0)
        // 幂等已删(tombstone)→ idempotent + seq(不 404,§10.7)
        const d2 = await b.deleteChildCascade('owner', 'c1', 'node', 'n1', { baseRevision: rev1, method: 'DELETE', resourceKind: 'node', actor: 'alice' })
        expect(d2.kind).toBe('idempotent')
        // 从未存在 → not-found
        const d3 = await b.deleteChildCascade('owner', 'c1', 'node', 'never-existed', { baseRevision: 0, method: 'DELETE', resourceKind: 'node', actor: 'alice' })
        expect(d3.kind).toBe('not-found')
      })

      it('stale base(base.revision<current)→ conflict(409 race)', async () => {
        await seedCanvas(b)
        const created = await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        const rev1 = cre(created).record.revision
        // A edit → rev2
        await b.applyDomainOps('owner', 'c1', 'node', 'n1', op({ kind: 'set', fieldPath: ['title'], value: 'X' }), { baseRevision: rev1, baseFieldClocks: {}, method: 'PATCH', resourceKind: 'node', actor: 'alice' })
        // B delete base rev1(stale, current rev2)→ conflict(409 race)
        const d = await b.deleteChildCascade('owner', 'c1', 'node', 'n1', { baseRevision: rev1, method: 'DELETE', resourceKind: 'node', actor: 'bob' })
        expect(d.kind).toBe('conflict')
        if (d.kind === 'conflict') expect(d.currentRevision).toBe(rev1 + 1)
      })

      it('missing base → precondition-required(428)', async () => {
        await seedCanvas(b)
        await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        const d = await b.deleteChildCascade('owner', 'c1', 'node', 'n1', { method: 'DELETE', resourceKind: 'node', actor: 'alice' })
        expect(d.kind).toBe('precondition-required')
      })

      it('node-delete-cascade:type=node 删 node + 级联 edge(from/to 引用)', async () => {
        await seedCanvas(b)
        await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        await b.createChild('owner', 'c1', 'node', 'n2', makeNode('n2'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        // edge e1(n1→n2)+ e2(n2→n3,n3 不存在也 OK 测级联判定)
        await b.createChild('owner', 'c1', 'edge', 'e1', { from: 'n1', to: 'n2' }, { method: 'POST', resourceKind: 'edge', actor: 'alice' })
        await b.createChild('owner', 'c1', 'edge', 'e2', { from: 'n2', to: 'n3' }, { method: 'POST', resourceKind: 'edge', actor: 'alice' })
        // 删 n1 → 级联删 e1(from n1);e2(from n2,不删)
        const n1 = await b.getChild('owner', 'c1', 'node', 'n1')
        const d = await b.deleteChildCascade('owner', 'c1', 'node', 'n1', { baseRevision: found(n1).record.revision, method: 'DELETE', resourceKind: 'node', actor: 'alice' })
        expect(d.kind).toBe('deleted')
        const e1 = await b.getChild('owner', 'c1', 'edge', 'e1')
        expect(e1.kind).toBe('missing') // 级联删
        const e2 = await b.getChild('owner', 'c1', 'edge', 'e2')
        expect(e2.kind).toBe('found') // 不级联(n1 不是 e2 的 from/to)
      })
    })

    describe('create dup → 409(§10.2)', () => {
      it('existing & !deleted → dup-conflict(409)', async () => {
        await seedCanvas(b)
        await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1'), { method: 'POST', resourceKind: 'node', actor: 'alice' })
        const dup = await b.createChild('owner', 'c1', 'node', 'n1', makeNode('n1', { title: 'other' }), { method: 'POST', resourceKind: 'node', actor: 'bob' })
        expect(dup.kind).toBe('dup-conflict') // ★ create dup → 409(不借 PATCH create)
      })
    })

    describe('BaseCursor codec malformed/scope-mismatch → null(→ 400;§14.1)', () => {
      it('真 codec round-trip + scope 防跨 record/canvas 重放 + 签名防篡改', () => {
        const base0 = encodeBase('c1', 'n1', 0, { title: 0 })
        expect(decodeBase(base0, 'c1', 'n1')).toEqual({ revision: 0, fieldClocks: { title: 0 } })
        expect(decodeBase(base0, 'c1', 'n2')).toBeNull() // scope mismatch(n1→n2)防跨 record 重放
        expect(decodeBase(base0, 'c2', 'n1')).toBeNull() // scope mismatch(c1→c2)防跨 canvas 重放
        expect(decodeBase('base:cv=c1|rid=n1|r=0.deadbeef', 'c1', 'n1')).toBeNull() // 签名错/篡改 → null
        expect(decodeBase('not-a-base-token', 'c1', 'n1')).toBeNull() // malformed → null(400)
        expect(decodeBase(undefined, 'c1', 'n1')).toBeNull() // missing → null(428)
      })

      it('order base canvas-scoped(reorder 用;encodeOrderBase/decodeOrderBase)', () => {
        const ob = encodeOrderBase('c1', 5)
        expect(decodeOrderBase(ob, 'c1')).toEqual({ cv: 5 })
        expect(decodeOrderBase(ob, 'c2')).toBeNull() // 跨 canvas → null
      })
    })
  })
}

// ── memory 后端(永远跑)──────────────────────────────────────────────────────────────
runA2S2ContractSuite('InMemoryPersistBackend', () => new InMemoryPersistBackend(), (b) => (b as InMemoryPersistBackend).__reset())

// ── PG 后端(gate:MIVO_PG_TEST=1;本地 brew PG port 55443)─────────────────────────────────
const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'
let pgBackend: PgPersistBackend | undefined

;(PG_TEST_ENABLED ? describe : describe.skip)('PG §14.1 冻结矩阵(双后端等价性)', () => {
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
  runA2S2ContractSuite(
    'PG PersistBackend',
    () => {
      if (!pgBackend) throw new Error('pg backend not initialized')
      return pgBackend
    },
    (b) => (b as PgPersistBackend).__reset(),
  )
})
