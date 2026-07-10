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
    await b.reorderChildren('o', 'c1', 'node', ['n3', 'n1', 'n2'])
    const list = await b.listByCanvas('o', 'c1', 'node')
    expect(list.records.map((r) => r.id)).toEqual(['n3', 'n1', 'n2'])
    expect(list.records.map((r) => r.orderKey)).toEqual([0, 1, 2])
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
