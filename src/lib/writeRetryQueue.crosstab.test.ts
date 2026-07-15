// src/lib/writeRetryQueue.crosstab.test.ts
// P2-2(T2.2 Block 2 五轮复审)cross-tab 验收测试。命中「META 单次失败、writes 随后成功」真窗口:
//   旧 nextSeq(META RMW)+ putWrite(writes put)是两笔独立事务,seqHighWater 仅进程内 → tab A META tx 一次失败但
//   writes put 成功 → record 以 seq=N 落 IDB durable 而 META 停 N-1(stale);tab B(新 realm,seqHighWater=0)从 stale
//   META 再发 seq=N → durable 撞号 → [detach,attach] 误排 → B ref 永久残留。旧 stubIdbTxThrows(全 tx throw)未命中
//   此窗口(writes tx 也 throw,record 根本不落 IDB,测不到「META 失败、writes 成功」的 partial-failure)。
//
//   修法(lead 裁定选项①):nextSeqAndPutWrite 把「读/增 META seq + put writes record」合进同一 [META_STORE, STORE_NAME]
//   readwrite tx——META RMW 失败则整 tx 回滚,writes record 不落 IDB(降级 memStore,seq=seqHighWater+1 仅进程内,
//   不与 durable 撞号)。
//
// 隔离策略:本文件**不静态 import writeRetryQueue**(仅 import type),全程 vi.resetModules + 动态 import 构造两
//   独立 module realm(各持私有 seqHighWater / memStore / dbPromise),共享同一 fake-indexeddb(via `import 'fake-indexeddb/auto'`
//   一次性置 globalThis)。one-shot META-tx abort:覆写 IDBDatabase.prototype.transaction,首个 storeNames 含 META_STORE
//   的 tx 同步 abort(后续 writes-only / combined tx 放行)。装在 realm A __resetWriteQueueDb 之后(resetDb 的 clearMetaStore
//   会触发 meta tx,故 spy 须装在它之后,免得 fault 被 resetDb 消费)。
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { WriteExecutor, WriteOp, WriteOutcome } from './writeRetryQueue'

const META_STORE = 'meta' // writeRetryQueue 私有常量(未 export;用字面量对齐 META_STORE = 'meta')
const API_KEY = 'mivo_aaa_user_a'

const attachBOp: WriteOp = { kind: 'attachAsset', canvasId: 'c1', assetId: 'B', nodeId: 'n1' }
const detachBOp: WriteOp = { kind: 'detachAsset', canvasId: 'c1', assetId: 'B', nodeId: 'n1' }

const refTrackingExecutor = (): { fn: WriteExecutor; calls: WriteOp[]; refs: Map<string, number> } => {
  const calls: WriteOp[] = []
  const refs = new Map<string, number>()
  const fn = vi.fn(async (op: WriteOp): Promise<WriteOutcome> => {
    calls.push(op)
    if (op.kind === 'attachAsset') refs.set(op.assetId, (refs.get(op.assetId) ?? 0) + 1)
    else if (op.kind === 'detachAsset') refs.set(op.assetId, (refs.get(op.assetId) ?? 0) - 1)
    return { status: 'success' }
  }) as unknown as WriteExecutor
  return { fn, calls, refs }
}

// 装一次性 META-tx 故障注入:覆写 IDBDatabase.prototype.transaction,首个 storeNames 含 META_STORE 的 tx 同步
//   throw(transaction 失败)。返回 restore(还原 prototype)。throw 对齐既有 stubIdbTxThrows 风格(同步、确定性;
//   不依赖 fake-idb abort 微任务序)。runMultiStoreTx 的 `db.transaction()` 在 Promise executor 内 throw → Promise
//   reject → nextSeqAndPutWrite catch → fallback memStore(record 不落 IDB)。writes-only tx(putWrite/getAllWrites)不含
//   meta → 不触发 → 「META 失败、writes 成功」真窗口(旧代码 putWrite 独立 writes-only tx 在 buggy 下会成功落 IDB)。
const installOneShotMetaFault = (): (() => void) => {
  const proto = IDBDatabase.prototype as unknown as {
    transaction: (names: string | string[], mode: IDBTransactionMode) => IDBTransaction
  }
  const realTransaction = proto.transaction
  let used = false
  proto.transaction = function (this: IDBDatabase, names: string | string[], mode: IDBTransactionMode): IDBTransaction {
    const arr = Array.isArray(names) ? names : [names]
    if (!used && arr.includes(META_STORE)) {
      used = true
      throw new Error('P2-2 one-shot META-tx fault injection')
    }
    return realTransaction.call(this, names, mode)
  }
  return () => { proto.transaction = realTransaction }
}

describe('P2-2(T2.2 Block 2 五轮)cross-tab META-fault → durable collision prevention', () => {
  it('两 realm 共享 fake-indexeddb:tab A META tx 单次失败 → fallback record 不落 IDB;tab B durable seq 全异 + [attach,detach] + ref=0', async () => {
    const exec = refTrackingExecutor()

    // ── realm A(新 module realm):先 setup + resetDb(spy 尚未装 → resetDb 的 clearMetaStore 不消费 fault)。
    vi.resetModules()
    const modA = await import('./writeRetryQueue')
    const persistA = await import('./persistUserId')
    persistA.setPersistUserId(API_KEY)
    await modA.__resetWriteQueueDb()
    const qA = modA.createWriteQueue({ executor: exec.fn, clock: () => 1000, random: () => 0.5 })

    // 装一次性 META-tx 故障(spy 在 resetDb 之后,免被 clearMetaStore 消费)。
    const restore = installOneShotMetaFault()
    try {
      await qA.enqueue(detachBOp) // combined [meta,writes] tx 首个含 meta(spy 装后)→ throw → fallback memStore(★ record 不落 IDB)

      // ── realm B(新 module realm,fresh seqHighWater=0,共享 IDB;不 resetDb 以保留 IDB 空状态做断言)。
      vi.resetModules()
      const modB = await import('./writeRetryQueue')
      const persistB = await import('./persistUserId')
      persistB.setPersistUserId(API_KEY)

      // ★ fix 证据(命中真窗口):tab A 的 fallback record 未落 IDB durable。realm B dump = IDB(空)+ realm B memStore(空)= []。
      //   旧代码:nextSeq META tx throw 但 putWrite(独立 writes-only tx,不含 meta)→ one-shot fault 不触发 → record 落
      //   IDB seq=1 → realm B dump 见 1 条(然后 tab B 从 stale META 再发 seq=1 撞号)。此处断言 [] 即证 fallback record 未落 IDB。
      const durableAfterFault = await modB.__dumpWritesForTest()
      expect(durableAfterFault).toEqual([])

      // ── realm B enqueue attach B + detach B(均 combined tx,fault 已消费 → 成功;durable seq 全异)。
      const qB = modB.createWriteQueue({ executor: exec.fn, clock: () => 1000, random: () => 0.5 })
      await qB.enqueue(attachBOp) // META cur=0(stale,A 的 throw 未推进)→ nextVal=max(1, 0+1)=1 durable,META=1
      await qB.enqueue(detachBOp) // META cur=1 → nextVal=max(2, 2)=2 durable,META=2
      const durableBeforeDrain = await modB.__dumpWritesForTest()
      const durableSeqs = durableBeforeDrain.map((r) => r.seq ?? 0).sort((a, b) => a - b)
      // ★ durable seq 全异:attach B=1,detach B=2。旧代码会含 tab A 的 detach B seq=1(撞号)→ durableSeqs=[1,1,2] 非全异。
      expect(durableSeqs).toEqual([1, 2])

      // ── realm B drain 共享 IDB → 按 seq [attach(1), detach(2)] + B ref=0(逆序 [detach,attach] 则 B=1 stale)。
      const r = await qB.drain()
      expect(r.processed).toBe(2)
      expect(exec.calls.map((o) => o.kind)).toEqual(['attachAsset', 'detachAsset'])
      expect(exec.refs.get('B') ?? 0).toBe(0)
    } finally {
      restore()
      vi.resetModules()
    }
  })
})
