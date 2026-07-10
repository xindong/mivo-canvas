// src/kernel/persistMigration.test.ts
// T1.2 S4:persist v10→v11 拆三域 — dry-run + migrate ckpt 仪式 + rollback + #164 seed 适配 单测。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.3(checkpointed rollback)+ §4.5(可重建性)。
// FX-6 namespacedKey:anonymous→raw name(本测试 __resetPersistUserId 取 anonymous)。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetPersistUserId } from '../lib/persistUserId'
import { dryRunMigration, migrateV10ToV11, projectToThreeDomain, rollbackFromV11 } from './persistMigration'
import type { PersistedV10Blob, RawStorage } from './persistMigration'

const v10Blob: PersistedV10Blob = {
  canvases: {
    c1: { title: 'c1', nodes: [], edges: [], tasks: [], createdAt: 't', updatedAt: 't' },
    c2: { title: 'c2', nodes: [], edges: [], tasks: [], createdAt: 't', updatedAt: 't' },
  },
  projects: [{ id: 'p1', name: 'p1', createdAt: 't' }],
  sceneId: 'c1',
  selectedNodeId: 'n1',
  selectedNodeIds: ['n1'],
  activeTool: 'select',
  activeStampKind: 'star',
}

// mock raw IDB storage(getItem/setItem/removeItem,async;_db 暴露供断言)。
// 义务 1:cast as RawStorage(brand)——模拟 raw IDB storage(未命名空间化)。migrate/dryRun 内部走
// namespacedKey;FX-6 namespaced adapter 不带 brand 不能传(防 double-namespacing,见防误用测试)。
const makeStorage = (initial: Record<string, string> = {}) => {
  const db = new Map<string, string>(Object.entries(initial))
  const store = {
    getItem: vi.fn((k: string) => Promise.resolve(db.has(k) ? db.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => { db.set(k, v); return Promise.resolve() }),
    removeItem: vi.fn((k: string) => { db.delete(k); return Promise.resolve() }),
    _db: db,
  }
  // cast as RawStorage(brand,义务 1)同时保留 Mock 类型(typeof store)供 mockImplementation 断言。
  return store as unknown as RawStorage & typeof store
}

// mock FX-6 namespaced adapter(无 __rawIdbStorage brand)——义务 1 防误用测试:验证类型层拦住。
const makeNamespacedAdapter = () => ({
  getItem: () => Promise.resolve(null),
  setItem: () => Promise.resolve(),
  removeItem: () => Promise.resolve(),
})

beforeEach(() => __resetPersistUserId()) // anonymous → namespacedKey returns raw name

describe('T1.2 S4 persistMigration — dry-run(零 setItem,lead 硬要求)', () => {
  it('projectToThreeDomain: v10 单 blob → document/session/asset 三域形状', () => {
    const proj = projectToThreeDomain(v10Blob)
    expect(Object.keys(proj.document.canvases)).toEqual(['c1', 'c2'])
    expect(proj.document.projects).toHaveLength(1)
    expect(proj.document.sceneId).toBe('c1')
    expect(proj.session.selectedNodeIds).toEqual(['n1'])
    expect(proj.session.activeTool).toBe('select')
    expect(proj.asset.ready).toBe(false)
  })

  it('dry-run 零 setItem(mock storage 断言写调用为 0)', async () => {
    const storage = makeStorage({ k: JSON.stringify({ state: v10Blob, version: 10 }) })
    const report = await dryRunMigration(storage, 'k')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.getItem).toHaveBeenCalledWith('k')
    expect(report.ok).toBe(true)
    expect(report.sourceVersion).toBe(10)
    expect(report.document.canvasCount).toBe(2)
    expect(report.document.projectCount).toBe(1)
    expect(report.session.selectionCount).toBe(1)
  })

  it('dry-run 空 blob(null)→ ok=false,零 setItem', async () => {
    const storage = makeStorage()
    const report = await dryRunMigration(storage, 'k')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(report.ok).toBe(false)
    expect(report.document.canvasCount).toBe(0)
  })

  it('dry-run selection 计数:selectedNodeIds 优先,回退 selectedNodeId', async () => {
    const blob: PersistedV10Blob = { ...v10Blob, selectedNodeIds: undefined, selectedNodeId: 'n2' }
    const storage = makeStorage({ k: JSON.stringify({ state: blob, version: 10 }) })
    const report = await dryRunMigration(storage, 'k')
    expect(report.session.selectionCount).toBe(1)
  })
})

describe('T1.2 S4 persistMigration — migrate v10→v11 ckpt 仪式(§4.3)', () => {
  it('migrate: ckpt-v10 written BEFORE document/session;split 正确;v10 blob 保留(rollback 兜底)', async () => {
    const v10Envelope = JSON.stringify({ state: v10Blob, version: 10 })
    const storage = makeStorage({ 'mivo-canvas-demo': v10Envelope })
    const setItemOrder: string[] = []
    storage.setItem.mockImplementation((k: string, v: string) => {
      setItemOrder.push(k); storage._db.set(k, v); return Promise.resolve()
    })

    const result = await migrateV10ToV11(storage, 'mivo-canvas-demo')

    expect(result.ok).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(result.ckptKey).toBe('mivo-canvas-demo:ckpt-v10')
    expect(result.documentKey).toBe('mivo-canvas-demo:document')
    expect(result.sessionKey).toBe('mivo-canvas-demo:session')
    // §4.3 仪式:ckpt 在 document/session 之前写
    expect(setItemOrder.indexOf('mivo-canvas-demo:ckpt-v10')).toBeLessThan(setItemOrder.indexOf('mivo-canvas-demo:document'))
    expect(setItemOrder.indexOf('mivo-canvas-demo:document')).toBeLessThan(setItemOrder.indexOf('mivo-canvas-demo:session'))
    // document key:canvases/projects/sceneId + version 11
    const docEnv = JSON.parse(storage._db.get('mivo-canvas-demo:document')!) as { state: { canvases: Record<string, unknown>; projects: unknown[]; sceneId?: string }; version: number }
    expect(Object.keys(docEnv.state.canvases)).toEqual(['c1', 'c2'])
    expect(docEnv.state.projects).toHaveLength(1)
    expect(docEnv.state.sceneId).toBe('c1')
    expect(docEnv.version).toBe(11)
    // session key:selection/tools + version 11
    const sessEnv = JSON.parse(storage._db.get('mivo-canvas-demo:session')!) as { state: { selectedNodeIds?: string[]; activeTool?: string }; version: number }
    expect(sessEnv.state.selectedNodeIds).toEqual(['n1'])
    expect(sessEnv.state.activeTool).toBe('select')
    expect(sessEnv.version).toBe(11)
    // ckpt = raw v10 blob
    expect(storage._db.get('mivo-canvas-demo:ckpt-v10')).toBe(v10Envelope)
    // v10 blob 保留(不删,rollback 兜底)
    expect(storage._db.get('mivo-canvas-demo')).toBe(v10Envelope)
  })

  it('migrate 无 v10 blob(fresh/已迁移)→ skipped=true,零 domain 写', async () => {
    const storage = makeStorage()
    const result = await migrateV10ToV11(storage, 'mivo-canvas-demo')
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
    expect(storage._db.has('mivo-canvas-demo:document')).toBe(false)
    expect(storage._db.has('mivo-canvas-demo:session')).toBe(false)
  })

  it('migrate 失败→rollback:ckpt 恢复 v10 blob + domain key 清(§4.3 第 3 步)', async () => {
    const v10Envelope = JSON.stringify({ state: v10Blob, version: 10 })
    const storage = makeStorage({ 'mivo-canvas-demo': v10Envelope })
    storage.setItem.mockImplementation((k: string, v: string) => {
      if (k === 'mivo-canvas-demo:document') throw new Error('write fail')
      storage._db.set(k, v); return Promise.resolve()
    })

    const result = await migrateV10ToV11(storage, 'mivo-canvas-demo')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('write fail')
    // ckpt 写了(失败前)
    expect(storage._db.get('mivo-canvas-demo:ckpt-v10')).toBe(v10Envelope)
    // v10 blob 从 ckpt 恢复(== ckpt)
    expect(storage._db.get('mivo-canvas-demo')).toBe(v10Envelope)
    // document/session 清(rollback)
    expect(storage._db.has('mivo-canvas-demo:document')).toBe(false)
    expect(storage._db.has('mivo-canvas-demo:session')).toBe(false)
  })

  it('rollback:从 ckpt-v10 恢复 v10 blob + 删 document/session', async () => {
    const v10Envelope = JSON.stringify({ state: v10Blob, version: 10 })
    // post-migrate state: v10 blob 删了(假设), ckpt + document + session 在
    const storage = makeStorage({
      'mivo-canvas-demo:ckpt-v10': v10Envelope,
      'mivo-canvas-demo:document': JSON.stringify({ state: { canvases: {}, projects: [] }, version: 11 }),
      'mivo-canvas-demo:session': JSON.stringify({ state: {}, version: 11 }),
    })
    storage._db.delete('mivo-canvas-demo') // 模拟 v10 blob 已删

    await rollbackFromV11(storage, 'mivo-canvas-demo')

    // v10 blob 从 ckpt 恢复
    expect(storage._db.get('mivo-canvas-demo')).toBe(v10Envelope)
    // document/session 删
    expect(storage._db.has('mivo-canvas-demo:document')).toBe(false)
    expect(storage._db.has('mivo-canvas-demo:session')).toBe(false)
    // ckpt 保留(forensic)
    expect(storage._db.has('mivo-canvas-demo:ckpt-v10')).toBe(true)
  })
})

describe('T1.2 S4 persistMigration — #164 seed 适配(migrate v10→v11 透明跑)', () => {
  it('#164-style v10 seed → migrate 透明拆:document 保 canvases/projects/sceneId,session 保 selection/tools(语义无损)', async () => {
    // #164 表征 seed 形状:canvases(含 active-scene 镜像)+ projects + sceneId + selection
    const seedBlob: PersistedV10Blob = {
      canvases: {
        'scene-a': { title: 'a', nodes: [{ id: 'n1' }], edges: [], tasks: [], createdAt: 't', updatedAt: 't', selectedNodeId: 'n1', selectedNodeIds: ['n1'] },
      },
      projects: [{ id: 'p1', name: 'proj', createdAt: 't' }],
      sceneId: 'scene-a',
      selectedNodeId: 'n1',
      selectedNodeIds: ['n1'],
      activeTool: 'select',
    }
    const storage = makeStorage({ 'mivo-canvas-demo': JSON.stringify({ state: seedBlob, version: 10 }) })
    const result = await migrateV10ToV11(storage, 'mivo-canvas-demo')
    expect(result.ok).toBe(true)
    // document 保 canvases(canvases 里的 selectedNodeId/Ids 是 document 内嵌,不变)
    const docEnv = JSON.parse(storage._db.get('mivo-canvas-demo:document')!) as { state: { canvases: Record<string, { selectedNodeId?: string }>; projects: unknown[]; sceneId?: string } }
    expect(docEnv.state.canvases['scene-a'].selectedNodeId).toBe('n1') // document 内嵌 selection 不变(canvases 里的)
    expect(docEnv.state.projects).toHaveLength(1)
    expect(docEnv.state.sceneId).toBe('scene-a')
    // session 保顶层 selection/tools(DP-1:顶层 selection 迁 session 域)
    const sessEnv = JSON.parse(storage._db.get('mivo-canvas-demo:session')!) as { state: { selectedNodeId?: string; selectedNodeIds?: string[]; activeTool?: string } }
    expect(sessEnv.state.selectedNodeId).toBe('n1')
    expect(sessEnv.state.selectedNodeIds).toEqual(['n1'])
    expect(sessEnv.state.activeTool).toBe('select')
  })
})

describe('T1.2 S5 Greptile 义务 — dry-run 坏 blob 诊断 + raw storage 防误用', () => {
  it('义务 2:dry-run corrupt JSON → ok:false failed 报告(不炸,诊断坏状态)', async () => {
    const storage = makeStorage({ k: '{not valid json' })
    const report = await dryRunMigration(storage, 'k')
    expect(report.ok).toBe(false)
    expect(report.error).toMatch(/corrupt blob/i)
    expect(report.document.canvasCount).toBe(0)
    expect(report.session.selectionCount).toBe(0)
    expect(storage.setItem).not.toHaveBeenCalled() // 仍零 setItem(dry-run 不写)
  })

  it('义务 2:dry-run 空 blob → ok:false 无 error(与 corrupt 区分,不回归)', async () => {
    const storage = makeStorage()
    const report = await dryRunMigration(storage, 'k')
    expect(report.ok).toBe(false)
    expect(report.error).toBeUndefined() // 空 blob 非 corrupt
    expect(report.document.canvasCount).toBe(0)
  })

  it('义务 1:防误用 — FX-6 namespaced adapter 不能传给 migrate/dryRun(类型层拦住 double-namespacing)', async () => {
    // namespaced adapter 无 __rawIdbStorage brand → TS 拒绝(brand 不匹配),拦住 double-namespacing。
    // @ts-expect-error — namespaced adapter 缺 __rawIdbStorage brand,RawStorage 类型层拦住
    await migrateV10ToV11(makeNamespacedAdapter(), 'mivo-canvas-demo')
    // @ts-expect-error — 同上,dryRun 也拦
    await dryRunMigration(makeNamespacedAdapter(), 'k')
  })
})
