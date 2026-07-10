// src/kernel/persistMigration.test.ts
// T1.2 S4 预研测试骨架。
// key-independent(已实现,绿):projectToThreeDomain 纯函数 + dry-run 零 setItem(lead 硬要求)。
// FX-6 后填(unskip):ckpt 仪式(migrate v10→v11 + rollbackFromV11)。

import { describe, expect, it, vi } from 'vitest'
import { dryRunMigration, projectToThreeDomain } from './persistMigration'
import type { PersistedV10Blob } from './persistMigration'

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

// mock zustand StateStorage(getItem 返回 seed JSON;setItem 是 spy,断言写调用)。
const makeStorage = (raw: string | null) => ({
  getItem: vi.fn().mockResolvedValue(raw),
  setItem: vi.fn(),
})

describe('T1.2 S4 persistMigration — dry-run(key-independent,已实现)', () => {
  it('projectToThreeDomain: v10 单 blob → document/session/asset 三域形状', () => {
    const proj = projectToThreeDomain(v10Blob)
    expect(Object.keys(proj.document.canvases)).toEqual(['c1', 'c2'])
    expect(proj.document.projects).toHaveLength(1)
    expect(proj.document.sceneId).toBe('c1')
    expect(proj.session.selectedNodeIds).toEqual(['n1'])
    expect(proj.session.activeTool).toBe('select')
    expect(proj.session.activeStampKind).toBe('star')
    expect(proj.asset.ready).toBe(false)
    expect(proj.asset.note).toBe('T1.5')
  })

  it('dry-run 零 setItem(lead 硬要求:mock storage 断言写调用为 0)', async () => {
    const raw = JSON.stringify({ state: v10Blob, version: 10 }) // zustand envelope {state, version}
    const storage = makeStorage(raw)
    const report = await dryRunMigration(storage, 'mivo-canvas-demo')

    // 硬要求:dry-run 路径零 setItem(防未来重构把 dry-run 变真迁移)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.getItem).toHaveBeenCalledWith('mivo-canvas-demo')

    // 报告形状
    expect(report.ok).toBe(true)
    expect(report.sourceVersion).toBe(10)
    expect(report.readKey).toBe('mivo-canvas-demo')
    expect(report.document.canvasCount).toBe(2)
    expect(report.document.projectCount).toBe(1)
    expect(report.document.hasSceneId).toBe(true)
    expect(report.session.selectionCount).toBe(1)
    expect(report.session.hasToolPrefs).toBe(true)
    expect(report.asset.ready).toBe(false)
  })

  it('dry-run 空 blob(null)→ ok=false,仍零 setItem', async () => {
    const storage = makeStorage(null)
    const report = await dryRunMigration(storage, 'mivo-canvas-demo')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(report.ok).toBe(false)
    expect(report.document.canvasCount).toBe(0)
    expect(report.document.projectCount).toBe(0)
  })

  it('dry-run selection 计数:selectedNodeIds 优先,回退 selectedNodeId', async () => {
    const blobWithPrimary: PersistedV10Blob = { ...v10Blob, selectedNodeIds: undefined, selectedNodeId: 'n2' }
    const storage = makeStorage(JSON.stringify({ state: blobWithPrimary, version: 10 }))
    const report = await dryRunMigration(storage, 'k')
    expect(report.session.selectionCount).toBe(1) // selectedNodeId 回退 → 1
  })
})

// ckpt 仪式(FX-6 合入后实现 + unskip):
//   照 kernel-dualtrack-contract §4.3 checkpointed rollback 仪式。
//   FX-6 合入后:seed v10 单 blob to ${BASE}:${userId} → migrateV10ToV11 →
//   断言 ckpt-v10 写在 document/session key 之前;失败回退 ckpt + 删三域 key。
describe.skip('T1.2 S4 persistMigration — ckpt 仪式(FX-6 后填 key 结构细节)', () => {
  it('migrate v10→v11: 先快照 ckpt-v10,再写 document/session(§4.3 仪式)', async () => {
    // FX-6 后:
    // 1. seed v10 单 blob to ${BASE}:${userId}(pre-FX-6 客户端读 'mivo-canvas-demo')。
    // 2. migrateV10ToV11 → assert ckpt-v10 key written BEFORE document/session keys。
    // 3. 若 document/session 写抛错 → ckpt-v10 仍在 + 三域 key 未落/清理。
    expect(true).toBe(true)
  })

  it('rollback: 从 ckpt-v10 恢复单 blob + 删三域 key', async () => {
    // FX-6 后:seed ckpt-v10 + 三域 key → rollbackFromV11 → 单 blob 恢复 + 三域 key 删。
    expect(true).toBe(true)
  })

  it('#164 表征 seed 适配:migrate v10→v11 透明跑(seed v10 单 blob,断言迁移后语义)', async () => {
    // FX-6 后:projectsSlice 表征 seed 保持 v10 单 blob,断言 migrate→v11 后 CRUD 语义不变。
    // 只有该路不通才改 seed 到 v11 形状 + PR 说明(lead 优先级)。
    expect(true).toBe(true)
  })
})
