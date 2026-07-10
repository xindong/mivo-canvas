// src/kernel/rollbackTrigger.test.ts
// T1.2 S6c:rollbackFromV11 触发口子单测——成功 / 无 ckpt / 失败三路径 + reportRollbackResult 日志/toast + 防误触。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.3(checkpointed rollback)。
// 边界:不碰 rollbackFromV11 本体(只测包装 triggerRollbackFromV11)。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetPersistUserId } from '../lib/persistUserId'
import type { RawStorage } from './persistMigration'
import { triggerRollbackFromV11, reportRollbackResult, runRollbackWithConfirm } from './rollbackTrigger'
import type { RollbackTriggerResult } from './rollbackTrigger'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'

// mock raw IDB storage(同 persistMigration.test.ts makeStorage 形状:getItem/setItem/removeItem async + _db)。
// cast as RawStorage(brand,义务 1)同时保留 Mock 类型(typeof store)供 mockImplementation 断言。
const makeStorage = (initial: Record<string, string> = {}) => {
  const db = new Map<string, string>(Object.entries(initial))
  const store = {
    getItem: vi.fn((k: string) => Promise.resolve(db.has(k) ? db.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => { db.set(k, v); return Promise.resolve() }),
    removeItem: vi.fn((k: string) => { db.delete(k); return Promise.resolve() }),
    _db: db,
  }
  return store as unknown as RawStorage & typeof store
}

const v10Envelope = JSON.stringify({
  state: { canvases: { c1: { title: 'c1' } }, projects: [{ id: 'p1', name: 'p1', createdAt: 't' }], sceneId: 'c1' },
  version: 10,
})
const v11Document = JSON.stringify({ state: { canvases: {}, projects: [], sceneId: 'c1' }, version: 11 })
const v11Session = JSON.stringify({ state: { activeTool: 'select' }, version: 11 })

beforeEach(() => __resetPersistUserId()) // anonymous → namespacedKey returns raw name(与 persistMigration.test.ts 同)

describe('T1.2 S6c rollbackTrigger — triggerRollbackFromV11 三路径', () => {
  it('成功路径:ckpt-v10 存在 → rollbackFromV11 恢复 v10 blob + 清 domain key → outcome=success', async () => {
    // post-migrate 状态:ckpt 在,v11 domain key 在,v10 单 blob 已删(模拟迁移后)
    const storage = makeStorage({
      'mivo-canvas-demo:ckpt-v10': v10Envelope,
      'mivo-canvas-demo:document': v11Document,
      'mivo-canvas-demo:session': v11Session,
    })
    storage._db.delete('mivo-canvas-demo')

    const result = await triggerRollbackFromV11('mivo-canvas-demo', storage)

    expect(result.outcome).toBe('success')
    expect(result.baseKey).toBe('mivo-canvas-demo')
    expect(result.ckptKey).toBe('mivo-canvas-demo:ckpt-v10')
    expect(result.error).toBeUndefined()
    // rollbackFromV11 副作用(§4.3 第 3 步):v10 blob 从 ckpt 恢复;document/session 删
    expect(storage._db.get('mivo-canvas-demo')).toBe(v10Envelope)
    expect(storage._db.has('mivo-canvas-demo:document')).toBe(false)
    expect(storage._db.has('mivo-canvas-demo:session')).toBe(false)
    // ckpt 保留(forensic)
    expect(storage._db.has('mivo-canvas-demo:ckpt-v10')).toBe(true)
  })

  it('无 ckpt 路径:ckpt-v10 不存在 → outcome=no-ckpt(仍清 domain key,rollbackFromV11 idempotent)', async () => {
    const storage = makeStorage({
      'mivo-canvas-demo:document': v11Document,
      'mivo-canvas-demo:session': v11Session,
    }) // 无 ckpt-v10

    const result = await triggerRollbackFromV11('mivo-canvas-demo', storage)

    expect(result.outcome).toBe('no-ckpt')
    expect(result.ckptKey).toBe('mivo-canvas-demo:ckpt-v10')
    expect(result.error).toBeUndefined()
    // rollbackFromV11 在 ckpt 缺席时仍删 domain key(无 ckpt 不恢复 v10 blob)
    expect(storage._db.has('mivo-canvas-demo:document')).toBe(false)
    expect(storage._db.has('mivo-canvas-demo:session')).toBe(false)
  })

  it('失败路径:storage.removeItem 抛 → outcome=failure + error,不向上抛(trigger 兜底)', async () => {
    const storage = makeStorage({
      'mivo-canvas-demo:ckpt-v10': v10Envelope,
      'mivo-canvas-demo:document': v11Document,
    })
    storage.removeItem.mockImplementation(() => Promise.reject(new Error('idb down')))

    const result = await triggerRollbackFromV11('mivo-canvas-demo', storage)

    expect(result.outcome).toBe('failure')
    expect(result.error).toMatch(/idb down/)
  })

  it('失败路径:ckpt 预读抛 → outcome=failure + "ckpt read failed"(不盲调 rollbackFromV11)', async () => {
    const storage = makeStorage()
    storage.getItem.mockImplementation(() => Promise.reject(new Error('read fail')))

    const result = await triggerRollbackFromV11('mivo-canvas-demo', storage)

    expect(result.outcome).toBe('failure')
    expect(result.error).toMatch(/ckpt read failed/)
    expect(result.error).toMatch(/read fail/)
    // 预读炸 → 不调 rollbackFromV11(避免盲调)→ removeItem 未触发
    expect(storage.removeItem).not.toHaveBeenCalled()
  })
})

describe('T1.2 S6c rollbackTrigger — reportRollbackResult 日志 + toast 落点', () => {
  beforeEach(() => vi.clearAllMocks())

  it('success → debugLogger.log + toastFeedback.success', () => {
    const logSpy = vi.spyOn(debugLogger, 'log')
    const toastSpy = vi.spyOn(toastFeedback, 'success')
    const result: RollbackTriggerResult = {
      outcome: 'success',
      baseName: 'mivo-canvas-demo',
      baseKey: 'mivo-canvas-demo',
      ckptKey: 'mivo-canvas-demo:ckpt-v10',
    }
    reportRollbackResult(result)
    expect(logSpy).toHaveBeenCalledWith('Kernel Rollback', expect.stringContaining('rollback ok'))
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('回滚'))
  })

  it('no-ckpt → debugLogger.warn + toastFeedback.warn', () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    const toastSpy = vi.spyOn(toastFeedback, 'warn')
    const result: RollbackTriggerResult = {
      outcome: 'no-ckpt',
      baseName: 'mivo-canvas-demo',
      baseKey: 'mivo-canvas-demo',
      ckptKey: 'mivo-canvas-demo:ckpt-v10',
    }
    reportRollbackResult(result)
    expect(warnSpy).toHaveBeenCalledWith('Kernel Rollback', expect.stringContaining('no ckpt'))
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('无回滚快照'))
  })

  it('failure → debugLogger.error + toastFeedback.error', () => {
    const errSpy = vi.spyOn(debugLogger, 'error')
    const toastSpy = vi.spyOn(toastFeedback, 'error')
    const result: RollbackTriggerResult = {
      outcome: 'failure',
      baseName: 'mivo-canvas-demo',
      baseKey: 'mivo-canvas-demo',
      ckptKey: 'mivo-canvas-demo:ckpt-v10',
      error: 'boom',
    }
    reportRollbackResult(result)
    expect(errSpy).toHaveBeenCalledWith('Kernel Rollback', expect.stringContaining('boom'))
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('回滚失败'))
  })
})

describe('T1.2 S6c rollbackTrigger — runRollbackWithConfirm 防误触 + 编排', () => {
  beforeEach(() => vi.clearAllMocks())

  it('裸调(无 confirm)→ no-op + warn log + warn toast,返回 null,不碰 storage', async () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    const toastSpy = vi.spyOn(toastFeedback, 'warn')
    const storage = makeStorage({ 'mivo-canvas-demo:ckpt-v10': v10Envelope })

    const result = await runRollbackWithConfirm({}, storage)

    expect(result).toBeNull()
    expect(storage.removeItem).not.toHaveBeenCalled() // 未触发 rollback
    expect(warnSpy).toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalled()
  })

  it('confirm:true → 触发 rollback + 报告 + 返回 result(成功路径,串联 trigger→report)', async () => {
    vi.spyOn(debugLogger, 'log') // 吞 success log(下面断言 result)
    const storage = makeStorage({
      'mivo-canvas-demo:ckpt-v10': v10Envelope,
      'mivo-canvas-demo:document': v11Document,
    })

    const result = await runRollbackWithConfirm({ confirm: true }, storage)

    expect(result?.outcome).toBe('success')
    expect(storage.removeItem).toHaveBeenCalled() // 触发了 rollback 清 domain key
  })

  it('confirm:false(显式)→ 等同裸调,no-op + warn', async () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn')
    const storage = makeStorage({ 'mivo-canvas-demo:ckpt-v10': v10Envelope })

    const result = await runRollbackWithConfirm({ confirm: false }, storage)

    expect(result).toBeNull()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })
})
