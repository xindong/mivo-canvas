// server/persist/backend.test.ts
// T1.3 PersistBackend 内存实现不变量(返修 #1/#5/#6/#7/#10)。
// 覆盖:project 全局唯一(#1)、contentVersion bump(#5)、orderKey/reorder(#6)、
// 原子 tree 软删回滚(#7)、幂等 fingerprint(#10)。

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryPersistBackend, fingerprintOfBody, type PersistBackend, type PersistType } from './backend'

describe('InMemoryPersistBackend — 返修 #1 project 全局唯一', () => {
  let b: PersistBackend
  beforeEach(() => {
    b = new InMemoryPersistBackend()
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

describe('InMemoryPersistBackend — 返修 #5 contentVersion bump', () => {
  let b: PersistBackend
  const rec = async (b: PersistBackend, type: PersistType, id: string) => {
    const r = await b.get('o', type, id)
    if (r.kind !== 'found') throw new Error(`${type}:${id} not found`)
    return r.record
  }
  beforeEach(() => {
    b = new InMemoryPersistBackend()
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

describe('InMemoryPersistBackend — 返修 #6 orderKey + reorder', () => {
  let b: PersistBackend
  beforeEach(() => {
    b = new InMemoryPersistBackend()
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
    // F5:base 必填——3 次 child 写入 bump contentVersion → 3;reorder 带 base=3(无冲突)。
    await b.reorderChildren('o', 'c1', 'node', ['n3', 'n1', 'n2'], { base: 3 })
    const list = await b.listByCanvas('o', 'c1', 'node')
    expect(list.records.map((r) => r.id)).toEqual(['n3', 'n1', 'n2'])
    expect(list.records.map((r) => r.orderKey)).toEqual([0, 1, 2])
  })

  it('F5:reorderChildren base 必填——不传 base 编译失败(@ts-expect-error 负向类型互锁;纯类型层,不实际运行)', () => {
    // F5 seam 必填:不传 opts(缺 base)或传空 opts(缺 base key)→ TS 编译错误;@ts-expect-error 钉住
    // (若有人改回 optional,此 directive 失效 → "Unused @ts-expect-error" 编译报错)。用箭头包裹仅类型层触发,不实际调用(runtime opts undefined 会崩)。
    // @ts-expect-error base is required (F5 seam mandatory — missing opts)
    const _noOpts = (b2: PersistBackend) => b2.reorderChildren('o', 'c1', 'node', ['n1'])
    // @ts-expect-error base is required (F5 seam mandatory — empty opts missing base)
    const _emptyOpts = (b2: PersistBackend) => b2.reorderChildren('o', 'c1', 'node', ['n1'], {})
    void _noOpts
    void _emptyOpts
  })

  it('F5:reorderChildren stale base → conflict;base 匹配 → ok', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.upsertChild('o', 'c1', 'node', 'n1', { id: 'n1' }, { method: 'PATCH', resourceKind: 'node' }) // cv → 1
    // stale base(0 ≠ current 1)→ conflict(两并发一成一 409 语义保留)
    const stale = await b.reorderChildren('o', 'c1', 'node', ['n1'], { base: 0 })
    expect(stale.kind).toBe('conflict')
    // correct base(1 = current)→ ok
    const ok = await b.reorderChildren('o', 'c1', 'node', ['n1'], { base: 1 })
    expect(ok.kind).toBe('ok')
  })
})

describe('InMemoryPersistBackend — 返修 #7 原子 tree 软删/恢复', () => {
  let b: InMemoryPersistBackend
  const rec = async (type: PersistType, id: string) => {
    const r = await b.get('o', type, id)
    if (r.kind !== 'found') throw new Error(`${type}:${id} not found`)
    return r.record
  }
  beforeEach(() => {
    b = new InMemoryPersistBackend()
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
    // children 保持活记录(不标软删)
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

  it('注入故障 → 全回滚(softDeleteCanvasTree 原子性)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
    const before = await rec('canvas', 'c1')
    // 注入:bucket.set 第 2 次调用 throw,并立即恢复 origSet(让 catch 回滚能成功)
    const bucket = (b as unknown as { bucket: (o: string) => Map<string, unknown> }).bucket('o')
    const origSet = bucket.set
    let calls = 0
    bucket.set = function (k: string, v: unknown) {
      calls++
      if (calls === 2) {
        bucket.set = origSet // 恢复,让 catch 内回滚 set 不被拦截
        throw new Error('injected fault')
      }
      return origSet.call(this, k, v)
    }
    await expect(b.softDeleteCanvasTree('o', 'c1')).rejects.toThrow('injected fault')
    bucket.set = origSet
    // 回滚:canvas meta 保持未删(before state)
    const after = await rec('canvas', 'c1')
    expect(after.isDeleted).toBe(before.isDeleted)
    expect(after.revision).toBe(before.revision)
  })
})

describe('InMemoryPersistBackend — 返修 #10 幂等复合 key + fingerprint', () => {
  let b: PersistBackend
  beforeEach(() => {
    b = new InMemoryPersistBackend()
  })

  it('幂等 key 作用域 owner+method+resourceKind+key:跨 type 不串', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    const fp = fingerprintOfBody({ payload: { id: 'x1' } })
    const n = await b.upsertChild('o', 'c1', 'node', 'x1', { id: 'x1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: fp })
    expect(n.kind).toBe('created')
    const e = await b.upsertChild('o', 'c1', 'edge', 'x1', { id: 'x1' }, { method: 'PATCH', resourceKind: 'edge', idempotencyKey: 'k1', bodyFingerprint: fp })
    expect(e.kind).toBe('created') // 跨 type 不串
    const n2 = await b.upsertChild('o', 'c1', 'node', 'x1', { id: 'x1' }, { method: 'PATCH', resourceKind: 'node', idempotencyKey: 'k1', bodyFingerprint: fp })
    expect(n2.kind).toBe('updated') // 回放既有
  })

  it('fingerprint 存入 record', async () => {
    const fp = fingerprintOfBody({ name: 'P' })
    const r = await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project', idempotencyKey: 'k1', bodyFingerprint: fp })
    if (r.kind === 'created') expect(r.record.fingerprint).toBe(fp)
  })
})

describe('InMemoryPersistBackend — 返修三 F1 canvas parent live + F4 canvas 全局唯一', () => {
  let b: PersistBackend
  beforeEach(() => {
    b = new InMemoryPersistBackend()
  })

  it('F4:canvas 跨 owner 同 id → exists-other-owner(与 project 同模式);同 owner 幂等 existing;globalCanvasOwners 不覆盖', async () => {
    await b.ensureCreate('oA', 'project', 'pA', { name: 'PA' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('oB', 'project', 'pB', { name: 'PB' }, { method: 'POST', resourceKind: 'project' })
    // A 创建 canvas c1(under pA,live)
    const a1 = await b.ensureCreate('oA', 'canvas', 'c1', { projectId: 'pA' }, { method: 'POST', resourceKind: 'canvas' })
    expect(a1.kind).toBe('created')
    // 同 owner 同 id → existing(幂等,不 bump)
    const a2 = await b.ensureCreate('oA', 'canvas', 'c1', { projectId: 'pA' }, { method: 'POST', resourceKind: 'canvas' })
    expect(a2.kind).toBe('existing')
    // B 同 id c1(under pB)→ exists-other-owner(全局唯一)
    const b1 = await b.ensureCreate('oB', 'canvas', 'c1', { projectId: 'pB' }, { method: 'POST', resourceKind: 'canvas' })
    expect(b1.kind).toBe('exists-other-owner')
    if (b1.kind === 'exists-other-owner') expect(b1.record.ownerId).toBe('oA')
    // globalCanvasOwners 不覆盖:getCanvasOwner('c1') 仍 oA
    expect(b.getCanvasOwner('c1')?.ownerId).toBe('oA')
  })

  it('F1:canvas 父 project 软删 → parent-not-live(禁独立 child create/restore);restoreProjectTree 后 live', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(b.projectLive('o', 'p1')).toBe(true)
    // 软删 project p1(cascade 软删 canvas c1)
    await b.softDeleteProjectTree('o', 'p1')
    expect(b.projectLive('o', 'p1')).toBe(false)
    // F1:POST canvas c1(under deleted p1)→ parent-not-live(不独立 restore)
    const r1 = await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r1.kind).toBe('parent-not-live')
    // F1:POST 新 canvas c2(under deleted p1)→ parent-not-live
    const r2 = await b.ensureCreate('o', 'canvas', 'c2', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r2.kind).toBe('parent-not-live')
    // restoreProjectTree 后 project live → c1 已被整树恢复 → ensureCreate c1 → existing(不再 parent-not-live)
    await b.restoreProjectTree('o', 'p1')
    expect(b.projectLive('o', 'p1')).toBe(true)
    const r3 = await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r3.kind).toBe('existing')
  })
})

describe('InMemoryPersistBackend — 返修四 F1 createCanvasWithCollection 原子 + barrier(TOCTOU orphan)', () => {
  let b: InMemoryPersistBackend
  const rec = async (type: PersistType, id: string) => {
    const r = await b.get('o', type, id)
    if (r.kind !== 'found') throw new Error(`${type}:${id} ${r.kind}`)
    return r.record
  }
  beforeEach(() => {
    b = new InMemoryPersistBackend()
  })

  it('F1 barrier:canvas meta 已建+collection 未建+project 软删 → primitive parent-not-live,树内零 live orphan', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    // 模拟 OLD 两段流程的中间态:canvas meta 已建,collection 未建(直接 ensureCreate canvas,无 collection)
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // 并发 DELETE project:cascade 软删 canvas c1(collection 不存在,未触)
    await b.softDeleteProjectTree('o', 'p1')
    // NEW primitive:parent not live → 拒绝(不创建 live orphan collection)
    const r = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r.kind).toBe('parent-not-live')
    // 不变量:树内零 live orphan——chat-collection 不存在(missing),canvas c1 仍 soft-deleted(非 live)
    expect((await b.get('o', 'chat-collection', 'c1')).kind).toBe('missing')
    const canvas = await b.get('o', 'canvas', 'c1')
    expect(canvas.kind).toBe('found')
    if (canvas.kind === 'found') expect(canvas.record.isDeleted).toBe(true)
  })

  it('F1:parent live → createCanvasWithCollection 原子建 canvas+collection(both live);idempotent existing/restored', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    const r1 = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r1.kind).toBe('created')
    // canvas + collection both live(原子同建)
    expect((await b.get('o', 'canvas', 'c1')).kind).toBe('found')
    const coll1 = await b.get('o', 'chat-collection', 'c1')
    expect(coll1.kind).toBe('found')
    if (coll1.kind === 'found') expect(coll1.record.isDeleted).toBe(false)
    // idempotent same call → existing(collection 仍 live,不重建)
    const r2 = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r2.kind).toBe('existing')
    // softDeleteCanvasTree → POST c1 → restored(canvas+collection restored together,无 orphan)
    await b.softDeleteCanvasTree('o', 'c1')
    expect((await rec('canvas', 'c1')).isDeleted).toBe(true)
    expect((await rec('chat-collection', 'c1')).isDeleted).toBe(true)
    const r3 = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r3.kind).toBe('restored')
    expect((await rec('canvas', 'c1')).isDeleted).toBe(false)
    expect((await rec('chat-collection', 'c1')).isDeleted).toBe(false)
  })

  it('F1 原子性:fault on collection-create → rollback canvas meta(无 partial,无 live orphan)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    // 注入:bucket.set 第 2 次调用(collection create)throw,并立即恢复 origSet(让 catch 回滚能成功)
    const bucket = (b as unknown as { bucket: (o: string) => Map<string, unknown> }).bucket('o')
    const origSet = bucket.set
    let calls = 0
    bucket.set = function (k: string, v: unknown) {
      calls++
      if (calls === 2) {
        bucket.set = origSet
        throw new Error('injected fault')
      }
      return origSet.call(this, k, v)
    }
    await expect(b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })).rejects.toThrow('injected fault')
    bucket.set = origSet
    // 回滚:canvas meta 未建 + collection 未建 + globalCanvasOwners 未设(无 partial,无 live orphan)
    expect((await b.get('o', 'canvas', 'c1')).kind).toBe('missing')
    expect((await b.get('o', 'chat-collection', 'c1')).kind).toBe('missing')
    expect(b.getCanvasOwner('c1')).toBeUndefined()
  })

  it('F1 返修五 restored 同步临界区:queueMicrotask(softDeleteProjectTree) 无法在临界区中间插入 → 零 live orphan', async () => {
    // 预置:c1 live + collection live,然后 softDeleteCanvasTree(c1 + collection isDeleted),parent project p1 仍 live。
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.softDeleteCanvasTree('o', 'c1')
    expect((await rec('canvas', 'c1')).isDeleted).toBe(true)
    expect((await rec('chat-collection', 'c1')).isDeleted).toBe(true)

    // 塞 microtask:模拟并发 DELETE project(softDeleteProjectTree cascade 软删 project + 其 canvas + chat-collection)。
    let microRan = false
    queueMicrotask(() => { b.softDeleteProjectTree('o', 'p1'); microRan = true })

    // 调 restored:返修五同步临界区(restoreCanvasWithCollectionCritical,无 await 缝)→ microtask 无法在临界区
    // 中间插入;临界区同步完成时 c1+collection live、parent 仍 live。await 让 microtask 在函数返回后执行:
    // softDeleteProjectTree cascade 软删 c1+collection。零 live orphan(c1+collection 最终 isDeleted,非 live orphan)。
    // 旧实现(restored 路径有 await restoreCanvasTree)会让 microtask 在 restore 中间执行 → cascade 后 ensureCollectionLive
    // 又恢复 collection live under deleted project = live orphan(本测试断言 collection isDeleted===true 钉死该回归)。
    const r = await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    expect(r.kind).toBe('restored')
    await Promise.resolve() // 确保 queueMicrotask 已 drain
    expect(microRan).toBe(true)
    expect(b.projectLive('o', 'p1')).toBe(false)
    const c1 = await b.get('o', 'canvas', 'c1')
    if (c1.kind === 'found') expect(c1.record.isDeleted).toBe(true)
    const coll = await b.get('o', 'chat-collection', 'c1')
    if (coll.kind === 'found') expect(coll.record.isDeleted).toBe(true) // 零 live orphan(非 ensureCollectionLive 恢复的 live)
  })

  it('F1 返修五 restored 临界区 fault 注入(globalCanvasOwners.set 后 throw)→ 全索引回滚(canvas meta + collection + globalCanvasOwners + idempotencyIndex)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas', idempotencyKey: 'k1', bodyFingerprint: 'fp1' })
    await b.softDeleteCanvasTree('o', 'c1') // c1 + collection isDeleted;globalCanvasOwners('c1')='o' 保留;idemIndex('k1') 指向 canvas record
    const beforeCanvas = await rec('canvas', 'c1')
    const beforeColl = await rec('chat-collection', 'c1')
    const idemIdx = (b as unknown as { idempotencyIndex: Map<string, { envelopeKey: string; fingerprint: string }> }).idempotencyIndex
    const beforeIdem = idemIdx.get('o:POST:canvas:k1')
    expect(beforeIdem).toBeDefined()
    expect(b.getCanvasOwner('c1')?.ownerId).toBe('o')

    // 注入:globalCanvasOwners.set throw(在 restoreCanvasTreeInPlace + ensureCollectionLive 之后,setIdemIndex 之前)。
    const gco = (b as unknown as { globalCanvasOwners: Map<string, string> }).globalCanvasOwners
    const origSet = gco.set.bind(gco)
    gco.set = function () {
      gco.set = origSet // 恢复,让 catch 内回滚 set 不被拦截
      throw new Error('injected fault')
    } as Map<string, string>['set']

    // replay-deleted 命中 → restored 临界区;globalCanvasOwners.set throw → 全索引回滚。
    await expect(b.createCanvasWithCollection('o', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas', idempotencyKey: 'k1', bodyFingerprint: 'fp1' })).rejects.toThrow('injected fault')
    gco.set = origSet

    // 全索引回滚:canvas meta + collection 恢复 isDeleted(无 live orphan);globalCanvasOwners 回滚(仍 'o');idemIndex 回滚(envelopeKey + fingerprint 不变)。
    const afterCanvas = await rec('canvas', 'c1')
    expect(afterCanvas.isDeleted).toBe(true)
    expect(afterCanvas.revision).toBe(beforeCanvas.revision) // 未 bump(回滚到 pre-state)
    const afterColl = await rec('chat-collection', 'c1')
    expect(afterColl.isDeleted).toBe(true)
    expect(afterColl.revision).toBe(beforeColl.revision)
    expect(b.getCanvasOwner('c1')?.ownerId).toBe('o') // globalCanvasOwners 回滚
    const afterIdem = idemIdx.get('o:POST:canvas:k1')
    expect(afterIdem).toEqual(beforeIdem) // idempotencyIndex 回滚(envelopeKey + fingerprint 不变)
  })
})
