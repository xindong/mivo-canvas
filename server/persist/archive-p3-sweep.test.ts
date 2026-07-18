// server/persist/archive-p3-sweep.test.ts
// P3 归档任务线遗留清扫测试(item 1 memory 侧 / item 3 non-reentrant / item 4 CAS jitter 纯函数)。
// PG 侧由 backend.contract.dual.test.ts + backend.pg.test.ts(MIVO_PG_TEST=1)覆盖;此文件仅 memory/纯函数,无 PG 依赖。

import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryPersistBackend,
  ArchivedParentWriteError,
  CanvasWriteReentrancyError,
  type PersistBackend,
} from './backend'
import { casRetryJitterMs } from './pgBackend'

describe('P3 sweep — item 1: restoreCanvasTree parent-archived 守卫(memory)', () => {
  let b: PersistBackend
  beforeEach(() => {
    b = new InMemoryPersistBackend()
  })

  it('opts.payload.projectId 指向 archived project → throw ArchivedParentWriteError(防未来误用)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.archiveProjectTree('o', 'p1')
    // 直接调 public restoreCanvasTree,payload.projectId 指向 archived project → SG-1 守卫 fail-fast
    const probe = b.restoreCanvasTree('o', 'c1', { payload: { projectId: 'p1' } })
    await expect(probe).rejects.toBeInstanceOf(ArchivedParentWriteError)
    await expect(probe).rejects.toThrow(/archived/)
    // getResponse()→ 409 {error:'archived', id:projectId}(供顶层 onError structural 分支;client 经 body.id≠canvasId 区分父归档)
    const err = new ArchivedParentWriteError('p1')
    expect(err.projectId).toBe('p1')
    const res = err.getResponse()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'archived', id: 'p1' })
  })

  it('空 opts + parent archived → throw ArchivedParentWriteError(默认调用形态现也判;零写,canvas/chat-collection 仍 deleted)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
    await b.softDeleteCanvasTree('o', 'c1')
    await b.archiveProjectTree('o', 'p1')
    // 审查方隔离复现序列:softDelete c1 → archive p1 → restore c1(空 opts,最常见调用形态)。
    // 修复前:守卫只读 opts.payload?.projectId,空 opts 不判 → 成功恢复进 archived project(漏洞)。
    // 修复后:effectiveProjectId fallback 读 c1 现存 payload.projectId=p1,p1 archived → fail-fast(零写)。
    const probe = b.restoreCanvasTree('o', 'c1')
    await expect(probe).rejects.toBeInstanceOf(ArchivedParentWriteError)
    // 零写:失败 probe 未触达 restoreCanvasTreeInPlace → c1 canvas meta + chat-collection 仍 soft-deleted
    const cv = await b.get('o', 'canvas', 'c1')
    expect(cv.kind).toBe('found')
    if (cv.kind === 'found') expect(cv.record.isDeleted).toBe(true)
    const cc = await b.get('o', 'chat-collection', 'c1')
    expect(cc.kind).toBe('found')
    if (cc.kind === 'found') expect(cc.record.isDeleted).toBe(true)
  })

  it('空 opts + parent active → 正常恢复(回归,默认调用形态在 active parent 下行为不变)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
    await b.softDeleteCanvasTree('o', 'c1')
    // 空 opts + parent active → 读 c1 现存 payload.projectId=p1,p1 active → 放行,正常恢复(原行为回归不破)
    const { count } = await b.restoreCanvasTree('o', 'c1')
    expect(count).toBe(2)
  })

  it('payload.projectId 指向 active project → 不触发守卫(正常恢复,不误判)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.ensureCreate('o', 'chat-collection', 'c1', {}, { canvasId: 'c1', method: 'POST', resourceKind: 'chat-collection' })
    await b.softDeleteCanvasTree('o', 'c1')
    const { count } = await b.restoreCanvasTree('o', 'c1', { payload: { projectId: 'p1' } })
    expect(count).toBe(2)
  })
})

describe('P3 sweep — item 3: withCanvasWriteGuard non-reentrant 契约(memory)', () => {
  let b: InMemoryPersistBackend
  beforeEach(() => {
    b = new InMemoryPersistBackend()
  })

  it('同步段重入(持锁 mutation 内首 await 前再取同 canvas 锁)→ throw CanvasWriteReentrancyError fail-fast(不死锁)', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // 持锁 mutation 同步段内再次 withCanvasWriteGuard 同 canvas → 同步 throw,防 FIFO promise-chain 互等死锁。
    // 超时受控:若 fail-fast 未触发,reentrancyProbe 永不 settle → vitest 测试超时 fail(回归闸门)。
    const reentrancyProbe = b.withCanvasWriteGuard('o', 'c1', async () => {
      // 同步重入(无 await 在前)→ 进入 withCanvasCritical 时 mutatingSyncCanvasIds 已含 c1 → throw
      return b.withCanvasWriteGuard('o', 'c1', async () => 'inner-should-never-run')
    })
    await expect(reentrancyProbe).rejects.toBeInstanceOf(CanvasWriteReentrancyError)
    await expect(reentrancyProbe).rejects.toThrow(/reentr/i)
    // 守卫抛错后 lock 已释放(mutatingSyncCanvasIds 清,canvasWriteLocks tail 自清)→ 后续合法调用不死锁
    const after = b.withCanvasWriteGuard('o', 'c1', async () => 'ok-after-reentrancy')
    await expect(after).resolves.toBe('ok-after-reentrancy')
  }, 5000) // 超时受控:fail-fast 失效时死锁 → 5s 超时 fail

  it('合法并发(不同 canvas / 串行同 canvas 不同调用方)不误判 reentrancy', async () => {
    await b.ensureCreate('o', 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
    await b.ensureCreate('o', 'canvas', 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await b.ensureCreate('o', 'canvas', 'c2', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // 不同 canvas 并发 → 不互锁,不误判
    const r = await Promise.all([
      b.withCanvasWriteGuard('o', 'c1', async () => 'a'),
      b.withCanvasWriteGuard('o', 'c2', async () => 'b'),
    ])
    expect(r).toEqual(['a', 'b'])
    // 同 canvas 串行(前一个 settle 后再取)→ 不误判(flag 同步段后即清)
    const s1 = await b.withCanvasWriteGuard('o', 'c1', async () => 'x')
    const s2 = await b.withCanvasWriteGuard('o', 'c1', async () => 'y')
    expect([s1, s2]).toEqual(['x', 'y'])
  })
})

describe('P3 sweep — item 4: CAS retry jitter 纯函数', () => {
  it('casRetryJitterMs 返回 [10,50](10-50ms 短 jitter,防并发 CAS 失败者同步雷同重试群)', () => {
    for (let i = 0; i < 2000; i++) {
      const d = casRetryJitterMs()
      expect(d).toBeGreaterThanOrEqual(10)
      expect(d).toBeLessThanOrEqual(50)
    }
  })

  it('rand 注入可观测边界:rand=0 → 10,rand→1 → 50(单调映射,可测试)', () => {
    expect(casRetryJitterMs(() => 0)).toBe(10)
    expect(casRetryJitterMs(() => 0.9999)).toBe(50) // floor(0.9999*41)=floor(40.99)=40 → +10=50
  })
})
