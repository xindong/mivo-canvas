// deletionTombstones.test.ts
// Phase 2 归档(决策7/F-B):tombstone parentProjectId + revokeCanvasTombstonesForProject 全生命周期。
// 覆盖 CR-12「tombstone 全生命周期(含 restore 撤销)」——deleteProject 级联写 canvas tombstone(带
// parentProjectId)→ restoreProject 经 revokeCanvasTombstonesForProject 撤销(镜像级联删);直接 deleteCanvas
// 的 tombstone(无 parentProjectId)不被项目恢复撤销。
//
// P2-2(三审):import 'fake-indexeddb/auto' 让 node env 有 indexedDB → deletionTombstones 走 IDB 分支(非降级
// memStore)。二审新增的 "IDB stale + mem enriched merge" 测试(deletionTombstones.ts getAllRecords :146-170)
// 在无 fake-indexeddb 时 getAllRecords 直接返 memStore(:144 isIdbAvailable=false),merge 分支永不执行 → 测试
// 名义过但没锁行为(未来改坏 merge 不会红)。加 fake-indexeddb 后 merge 分支真跑:旧实现(IDB key 优先 + 过滤
// 同 key mem)下该测试必红,当前 merge(mem parentProjectId 补进 IDB)下必绿。__resetDeletionTombstonesDb
// 已 async 清 memStore + IDB store.clear()(runVoidTx await oncomplete),beforeEach/afterEach await 确保逐 test 隔离。

import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  recordDeletionTombstone,
  revokeDeletionTombstone,
  revokeCanvasTombstonesForProject,
  clearDeletionTombstone,
  getDeletionTombstones,
  __resetDeletionTombstonesDb,
  __seedTombstoneMemForTest,
} from './deletionTombstones'
import { setPersistUserId, __resetPersistUserId } from './persistUserId'

beforeEach(async () => {
  await __resetDeletionTombstonesDb()
  __resetPersistUserId()
  setPersistUserId('userA')
})

afterEach(async () => {
  await __resetDeletionTombstonesDb()
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

  it('旧 tombstone(无 parentProjectId,Phase 1→2 部署窗口期写入)未被 cascade 再记录 → 保守不动(缺字段不撤销,依赖回收站兜底)', async () => {
    // 模拟旧 Phase 1 写入的 canvas tombstone(无 parentProjectId)——revoke-by-project 撞不到。
    // 注:若后续被 cascade delete 再记录(带 parentProjectId),putRecord 会原子 enrich(见下测);本测覆盖"未被再记录"的旧墓碑。
    await recordDeletionTombstone('canvas', 'cLegacy')
    await revokeCanvasTombstonesForProject('p1') // 旧 tombstone 无 parentProjectId === p1 → 不命中
    const ids = await getDeletionTombstones('canvas')
    expect(ids.has('cLegacy')).toBe(true) // 保守不动(未被 cascade 再记录 → 无 enrich → 依赖回收站恢复入口兜底)
  })

  it('P1-4(forward-compat 返修):旧 tombstone(无 parentProjectId)经 cascade delete 再记录 → 原子 enrich 补 parentProjectId → revoke-by-project 命中', async () => {
    // Phase 1→2 部署窗口期写入的旧 canvas tombstone(无 parentProjectId)。
    await recordDeletionTombstone('canvas', 'cLegacy') // 无 parentProjectId → 新 record
    // 旧 tombstone 此时无 parentProjectId → revoke-by-project 撞不到。
    await revokeCanvasTombstonesForProject('p1')
    expect((await getDeletionTombstones('canvas')).has('cLegacy')).toBe(true) // 仍挡复活
    // 后续 cascade delete 同 canvas(带 parentProjectId)→ putRecord 原子 enrich:existing(无 parent)+ new(parent)
    // → put({...existing, parentProjectId})(不整条覆盖,保留 createdAt/kind/ownerId/resourceId)。
    await recordDeletionTombstone('canvas', 'cLegacy', { parentProjectId: 'p1' })
    // enrich 后,revoke-by-project('p1') 命中(cLegacy 现有 parentProjectId='p1')→ 撤销(restoreProject 可恢复其画布)。
    await revokeCanvasTombstonesForProject('p1')
    expect((await getDeletionTombstones('canvas')).has('cLegacy')).toBe(false)
  })

  it('P2-2(二审降级 seam):IDB enrich tx 失败回落 memStore(带 parent)→ getAllRecords 同 key merge 把 parent 补进 IDB(enrichment 可见,revoke-by-project 命中)', async () => {
    // 构造降级态:IDB 存 stale 无 parent 记录(首次删,无 cascade)+ memStore 存 enriched 带 parent 同 key 记录
    //   (模拟 IDB enrich tx 失败 → catch 回落 memStore)。
    await recordDeletionTombstone('canvas', 'c1') // 首次删,无 parent → IDB {c1, no parent}(memStore 清)
    await __seedTombstoneMemForTest('canvas', 'c1', { parentProjectId: 'p1' }) // 模拟 IDB enrich 失败回落 memStore
    // revokeCanvasTombstonesForProject('p1'):getAllRecords merge → IDB{c1,no parent}+ mem{c1,parent p1} → {c1,parent p1}
    //   → 命中 c1(parentProjectId='p1')→ 撤销。旧实现(getAllRecords 按 key 优先留 IDB + 过滤同 key mem)→
    //   返回 IDB{c1,no parent}→ 不命中 → c1 不撤销 → 恢复的画布被永久隐藏(比复活更糟)。
    await revokeCanvasTombstonesForProject('p1')
    expect((await getDeletionTombstones('canvas')).has('c1')).toBe(false) // merge 后命中 → 撤销
  })

  it('P2-2(IDB write abort + read success):IDB 无记录 + memStore 全 mem 记录(key 不在 IDB)→ getAllRecords 追加 mem-only(merge 不漏)', async () => {
    // 模拟 IDB tx 全失败(新记录回落 memStore,IDB 无此 key)→ getAllRecords 的 mem-only 分支追加(非 merge)。
    await __seedTombstoneMemForTest('canvas', 'cMemOnly', { parentProjectId: 'p2' })
    // IDB 无 cMemOnly → mem-only 追加 → revoke-by-project('p2') 命中
    await revokeCanvasTombstonesForProject('p2')
    expect((await getDeletionTombstones('canvas')).has('cMemOnly')).toBe(false)
  })
})
