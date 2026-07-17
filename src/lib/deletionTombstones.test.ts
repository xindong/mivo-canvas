// deletionTombstones.test.ts
// Phase 2 归档(决策7/F-B):tombstone parentProjectId + revokeCanvasTombstonesForProject 全生命周期。
// 覆盖 CR-12「tombstone 全生命周期(含 restore 撤销)」——deleteProject 级联写 canvas tombstone(带
// parentProjectId)→ restoreProject 经 revokeCanvasTombstonesForProject 撤销(镜像级联删);直接 deleteCanvas
// 的 tombstone(无 parentProjectId)不被项目恢复撤销。
//
// node env 无 indexedDB → deletionTombstones 降级 memStore(同 writeRetryQueue;跨 pm2-restart 窗口存活,
// 不跨 reload)。本测试经 memStore 验证逻辑,无需 fake-indexeddb。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  recordDeletionTombstone,
  revokeDeletionTombstone,
  revokeCanvasTombstonesForProject,
  clearDeletionTombstone,
  getDeletionTombstones,
  __resetDeletionTombstonesDb,
} from './deletionTombstones'
import { setPersistUserId, __resetPersistUserId } from './persistUserId'

beforeEach(() => {
  __resetDeletionTombstonesDb()
  __resetPersistUserId()
  setPersistUserId('userA')
})

afterEach(() => {
  __resetDeletionTombstonesDb()
  __resetPersistUserId()
})

describe('Phase 2 F-B(决策7):canvas tombstone parentProjectId + revokeCanvasTombstonesForProject', () => {
  it('recordDeletionTombstone(canvas, id, {parentProjectId}) 存 parentProjectId(级联删标记)', async () => {
    await recordDeletionTombstone('canvas', 'c1', { parentProjectId: 'p1' })
    const ids = await getDeletionTombstones('canvas')
    expect(ids.has('c1')).toBe(true)
    // 直接验内部记录的 parentProjectId(经 revoke-by-project 的行为间接证:revoke('p1') 命中 c1)
    await revokeCanvasTombstonesForProject('p1')
    const after = await getDeletionTombstones('canvas')
    expect(after.has('c1')).toBe(false) // parentProjectId='p1' 命中 → 撤销
  })

  it('revokeCanvasTombstonesForProject(p1) 撤销该 project 下所有级联删 canvas tombstone(批量)', async () => {
    await recordDeletionTombstone('canvas', 'c1', { parentProjectId: 'p1' })
    await recordDeletionTombstone('canvas', 'c2', { parentProjectId: 'p1' })
    await recordDeletionTombstone('canvas', 'c3', { parentProjectId: 'p1' })
    await recordDeletionTombstone('canvas', 'cX', { parentProjectId: 'p2' }) // 别的项目,不动
    const before = await getDeletionTombstones('canvas')
    expect(before.size).toBe(4)
    await revokeCanvasTombstonesForProject('p1')
    const after = await getDeletionTombstones('canvas')
    expect(after.has('c1')).toBe(false)
    expect(after.has('c2')).toBe(false)
    expect(after.has('c3')).toBe(false)
    expect(after.has('cX')).toBe(true) // parentProjectId='p2' 不被 p1 撤销
  })

  it('直接 deleteCanvas 的 tombstone(无 parentProjectId)不被 revokeCanvasTombstonesForProject 撤销(保留挡复活)', async () => {
    // 直接删画布(无 parentProjectId)——restoreProject 不该撤销它(用户显式删的画布不应被项目恢复重建)
    await recordDeletionTombstone('canvas', 'cDirect')
    await recordDeletionTombstone('canvas', 'cCascade', { parentProjectId: 'p1' })
    await revokeCanvasTombstonesForProject('p1')
    const after = await getDeletionTombstones('canvas')
    expect(after.has('cCascade')).toBe(false) // 级联删 → 撤销
    expect(after.has('cDirect')).toBe(true) // 直接删(无 parentProjectId)→ 保留挡复活
  })

  it('revokeCanvasTombstonesForProject 不触碰 project tombstone(kind filter)', async () => {
    await recordDeletionTombstone('project', 'p1') // project tombstone(无 parentProjectId)
    await recordDeletionTombstone('canvas', 'c1', { parentProjectId: 'p1' })
    await revokeCanvasTombstonesForProject('p1') // 只撤销 canvas kind
    const projIds = await getDeletionTombstones('project')
    const canvasIds = await getDeletionTombstones('canvas')
    expect(projIds.has('p1')).toBe(true) // project tombstone 不被 canvas-revoke 撤销(由 revokeDeletionTombstone('project') 单独清)
    expect(canvasIds.has('c1')).toBe(false)
  })

  it('restoreProject 全生命周期:deleteProject 级联写 → restoreProject 撤销 project + 子画布 tombstone', async () => {
    // deleteProject 级联:project tombstone + 每个子画布 tombstone(带 parentProjectId)
    await recordDeletionTombstone('project', 'p1')
    await recordDeletionTombstone('canvas', 'c1', { parentProjectId: 'p1' })
    await recordDeletionTombstone('canvas', 'c2', { parentProjectId: 'p1' })
    // 同时有一条直接删的画布(属 p1 但直接删,无 parentProjectId)——restore 不撤销它
    await recordDeletionTombstone('canvas', 'cDirect')

    // restoreProject:撤销 project tombstone(单 op revoke 路径)+ 子画布 tombstone(revoke-by-project)
    await revokeDeletionTombstone('project', 'p1')
    await revokeCanvasTombstonesForProject('p1')

    const projIds = await getDeletionTombstones('project')
    const canvasIds = await getDeletionTombstones('canvas')
    expect(projIds.has('p1')).toBe(false) // project tombstone 撤销
    expect(canvasIds.has('c1')).toBe(false) // 级联子画布撤销
    expect(canvasIds.has('c2')).toBe(false)
    expect(canvasIds.has('cDirect')).toBe(true) // 直接删的保留(restore 不复活显式删的画布)
  })

  it('clearDeletionTombstone(DELETE 终态 success)清当前 tombstone;与 revoke 正交', async () => {
    await recordDeletionTombstone('canvas', 'c1', { parentProjectId: 'p1' })
    await clearDeletionTombstone('canvas', 'c1') // DELETE drain success → 清
    const ids = await getDeletionTombstones('canvas')
    expect(ids.has('c1')).toBe(false)
  })

  it('幂等:revokeCanvasTombstonesForProject 无命中 → no-op(不抛)', async () => {
    await expect(revokeCanvasTombstonesForProject('nonexistent')).resolves.toBeUndefined()
    await expect(revokeCanvasTombstonesForProject('p1')).resolves.toBeUndefined() // 空 store
  })

  it('per-user 隔离:userA 的 canvas tombstone 不被 userB 的 revokeCanvasTombstonesForProject 撤销', async () => {
    setPersistUserId('userA')
    await recordDeletionTombstone('canvas', 'c1', { parentProjectId: 'p1' })
    setPersistUserId('userB')
    await revokeCanvasTombstonesForProject('p1') // userB 视角:无 userA 的 tombstone
    setPersistUserId('userA')
    const ids = await getDeletionTombstones('canvas')
    expect(ids.has('c1')).toBe(true) // userA 的 tombstone 不被 userB 撤销(防跨 owner 误过滤)
  })

  it('旧 tombstone(无 parentProjectId,Phase 1→2 部署窗口期写入)保守不动(缺字段不撤销,依赖回收站兜底)', async () => {
    // 模拟旧 Phase 1 写入的 canvas tombstone(无 parentProjectId)——revoke-by-project 撞不到
    await recordDeletionTombstone('canvas', 'cLegacy')
    await revokeCanvasTombstonesForProject('p1') // 旧 tombstone 无 parentProjectId === p1 → 不命中
    const ids = await getDeletionTombstones('canvas')
    expect(ids.has('cLegacy')).toBe(true) // 保守不动(文档注明的极窄边缘:依赖回收站恢复入口兜底)
  })
})
