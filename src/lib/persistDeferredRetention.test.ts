// persistDeferredRetention.test.ts
// G1-a P1-3 验证:canvas/chat op 在 G1-a executor(只支持 NonCanvasWriteOp)下 drain 后 **留存不删**。
//
// 上一轮 bug:executor 对 canvas/chat 返 terminal → drain deleteWrite 永久删 G1-c/DP-6R 上线前的遗留
// durable 记录,且 toast 让用户"重试"时原 op 已不存在。修法:类型拆分(NonCanvasWriteOp)+ unsupported-retained
// outcome + deferred status(drain 标 deferred 留存,不发请求不删除)。
//
// 验收(逐条对齐 finding P1-3):
//  1. 预置 canvas/chat 队列记录 drain 后仍在且不发请求(executor 返 unsupported-retained,fetch 0 调用)。
//  2. 同 idempotency key 保留(replay 可能——G1-c 升级 executor 后可 replay;key 未变)。
//  3. 无 unsupported 分支调 deleteWrite(drainResult.terminals === 0;records 仍在;pendingCount 含之)。
//  4. 非画布域 op 仍正常 drain success → 删记录(对照:unsupported-retained 不删,success 删)。
//
// A2-S4 Block 4(2026-07-14):三类 legacy 画布域 op(upsertNode/deleteNode/reorderChildren)已迁 §14.3
//   drain-only 兼容通道(migrateLegacyOp + executor 真发 server,见 persistWriteExecutor.test.ts §14.3
//   套件)——不再 unsupported-retained。本文件现只验**非三类画布域 op**(upsertEdge/upsertAnchor/
//   deleteEdge/deleteAnchor)的留存不删(G1-c seam 未接,等 G1-c/N2-0)。

import { describe, expect, it } from 'vitest'
import {
  createWriteQueue,
  __resetWriteQueueDb,
  __dumpWritesForTest,
  __seedWritesForTest,
  type WriteOp,
} from './writeRetryQueue'
import { createAdapterWriteExecutor } from './persistWriteExecutor'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })

/** stub fetch:计数调用(对 canvas/chat op 应为 0;对非画布 op 验 wire)。返 201/200 让非画布 op success。 */
const makeCountingFetch = () => {
  let calls = 0
  const seen: { method: string; path: string }[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    calls += 1
    seen.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(input, 'http://stub').pathname })
    return new Response(JSON.stringify({ id: 'x', revision: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls: () => calls, seen }
}

const makeQueue = (fetch: (input: string, init?: RequestInit) => Promise<Response>) =>
  createWriteQueue({
    executor: createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() }),
    drainIntervalMs: 10 ** 9, // 不让 timer 自动 drain;测试手动 drain
  })

describe('G1-a P1-3 — 非三类画布域 op drain 后留存不删(unsupported-retained;三类已迁 §14.3,chat 已接 wired)', () => {
  it('upsertEdge(非三类)drain 后 status=deferred,fetch 0 调用,records 仍在 + idempotencyKey 保留', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeCountingFetch()
    const queue = makeQueue(fetch)

    // 预置非三类画布域写 op(模拟 G1-c 上线前遗留的 durable 记录;三类 legacy op 已迁 §14.3,不在此列)。
    // 注:appendChatMessage 已 wired(DP-6R P1-1 划归 G1-a),不在 deferred 集合——此处只验非三类 canvas 域写留存。
    const canvasOp: WriteOp = { kind: 'upsertEdge', canvasId: 'c1', edgeId: 'e1', payload: {} as never }
    const id1 = await queue.enqueue(canvasOp)
    const before = await __dumpWritesForTest()
    const canvasKey = before.find((r) => r.id === id1)?.idempotencyKey
    expect(canvasKey).toBeTruthy()

    const result = await queue.drain()

    // canvas 域写:fetch 0 调用(不发请求);terminals === 0(无 unsupported 分支调 deleteWrite)。
    expect(calls()).toBe(0)
    expect(result.terminals).toBe(0)
    expect(result.processed).toBe(1)

    // records 仍在,status=deferred(留存不删)。
    const after = await __dumpWritesForTest()
    const canvasRec = after.find((r) => r.id === id1)
    expect(canvasRec).toBeDefined()
    expect(canvasRec?.status).toBe('deferred')
    expect(canvasRec?.lastError).toContain('G1-c')

    // idempotencyKey 未变(G1-c 升级 executor 后同 key 可 replay)。
    expect(canvasRec?.idempotencyKey).toBe(canvasKey)

    queue.stop()
  })

  it('对照:非画布域 op(createProject)drain success → 删记录(unsupported-retained 不删,success 删)', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeCountingFetch()
    const queue = makeQueue(fetch)

    const id = await queue.enqueue({ kind: 'createProject', name: 'p', id: 'p1' })
    const result = await queue.drain()

    expect(calls()).toBe(1) // 非画布 op 发请求
    expect(result.successes).toBe(1)
    expect(result.terminals).toBe(0)
    const after = await __dumpWritesForTest()
    expect(after.find((r) => r.id === id)).toBeUndefined() // success → 删记录
    queue.stop()
  })

  it('对照:chat op(appendChatMessage)已 wired → drain success 发请求 + 删记录(不再 deferred)', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeCountingFetch()
    const queue = makeQueue(fetch)

    const id = await queue.enqueue({ kind: 'appendChatMessage', canvasId: 'c1', message: { text: 'hi' } })
    const result = await queue.drain()

    expect(calls()).toBe(1) // chat 已 wired → 发 POST 请求(不再 unsupported-retained)
    expect(result.successes).toBe(1)
    const after = await __dumpWritesForTest()
    expect(after.find((r) => r.id === id)).toBeUndefined() // success → 删记录
    queue.stop()
  })

  it('非三类画布域 op(upsertEdge/deleteEdge/deleteAnchor)同样留存(deferred),不调 deleteWrite', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeCountingFetch()
    const queue = makeQueue(fetch)

    // 三类 legacy op(upsertNode/deleteNode/reorderChildren)已迁 §14.3 真发 server,不在此列;
    // 此处只验非三类画布域 op 的留存(G1-c seam 未接)。三个 op 取**不同 resourceKey** 避免 coalesce
    // (edge:c1:e1 / anchor:c1:a1 / anchor:c1:a2),确保 3 条独立记录。
    await queue.enqueue({ kind: 'upsertEdge', canvasId: 'c1', edgeId: 'e1', payload: {} as never })
    await queue.enqueue({ kind: 'upsertAnchor', canvasId: 'c1', anchorId: 'a1', payload: {} as never })
    await queue.enqueue({ kind: 'deleteAnchor', canvasId: 'c1', anchorId: 'a2' })
    const result = await queue.drain()

    expect(calls()).toBe(0)
    expect(result.terminals).toBe(0)
    const after = await __dumpWritesForTest()
    expect(after.length).toBe(3)
    expect(after.every((r) => r.status === 'deferred')).toBe(true)
    queue.stop()
  })
})

describe('A2-S4 Block 4 F1 — gate-blocked 可重试保留 + 定向再激活(deferred 三类→pending)', () => {
  // gate-simulating fetch:gate 关时 PATCH legacy-replace 返 400 gate-closed;开闸后返 200 UpsertResponse。
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const makeGateFetch = () => {
    let gateOpen = false
    let calls = 0
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      calls += 1
      const path = new URL(input, 'http://stub').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'PATCH' && path.startsWith('/api/canvas/') && path.includes('/nodes/')) {
        if (!gateOpen) return json({ error: 'bad-request', message: 'legacy drain gate closed' }, 400)
        return json({ id: 'n1', revision: 5, seq: 1, base: 'b' }, 200)
      }
      return new Response(null, { status: 404 })
    }
    return { fetch, calls: () => calls, openGate: () => { gateOpen = true } }
  }
  const makeQueue = (fetch: (input: string, init?: RequestInit) => Promise<Response>, clock: () => number) =>
    createWriteQueue({
      executor: createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: authHeaders }),
      clock,
      random: () => 0.5, // 确定性 jitter → backoff = capped * 0.75
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      drainIntervalMs: 5_000,
    })

  it('F1-② gate-off → gate-blocked 退避 → 开闸 → 重 drain 成功出队(期间无紧循环:backoff 未到期不重发)', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls, openGate } = makeGateFetch()
    let clockMs = 1000
    const queue = makeQueue(fetch, () => clockMs)
    const id = await queue.enqueue({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { x: 1 } as never })
    // drain 1:gate 关 → gate-blocked + backoff(750ms);processed=1,successes=0
    const r1 = await queue.drain()
    expect(r1.processed).toBe(1)
    expect(r1.successes).toBe(0)
    const after1 = await __dumpWritesForTest()
    const rec1 = after1.find((x) => x.id === id)
    expect(rec1?.status).toBe('gate-blocked')
    expect(rec1?.gateAttempts).toBe(1)
    const callsAfter1 = calls()
    // drain 2:时钟仅推进 100ms(backoff 750ms 未到期)→ gate-blocked 不 due → processed=0,无新请求(无紧循环)
    clockMs += 100
    const r2 = await queue.drain()
    expect(r2.processed).toBe(0)
    expect(calls()).toBe(callsAfter1)
    // 推进过 backoff(→2100 > 1750 nextAttemptAt)+ 开闸 → 重 drain 成功
    clockMs += 1000
    openGate()
    const r3 = await queue.drain()
    expect(r3.processed).toBe(1)
    expect(r3.successes).toBe(1)
    const after3 = await __dumpWritesForTest()
    expect(after3.find((x) => x.id === id)).toBeUndefined()
    queue.stop()
  })

  it('F1-① 历史 deferred 三类(upsertNode)→ recovery pass 定向 flip → gate-on drain 成功出队', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls, openGate } = makeGateFetch()
    openGate()
    const clockMs = 1000
    const queue = makeQueue(fetch, () => clockMs)
    // 模拟 G1-a 时代遗留:直接 seed 一个 deferred 三类记录(旧 executor 标 deferred,从未 drain)。
    await __seedWritesForTest([
      {
        id: 'seed1', idempotencyKey: 'mivo-seed1', userId: 'anonymous',
        op: { kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { x: 1 } as never },
        resourceKey: 'node:c1:n1', createdAt: 500, attempts: 0, nextAttemptAt: 500, status: 'deferred',
      },
    ])
    const r = await queue.drain()
    expect(r.processed).toBe(1)
    expect(r.successes).toBe(1)
    expect(calls()).toBe(1)
    const after = await __dumpWritesForTest()
    expect(after.find((x) => x.id === 'seed1')).toBeUndefined()
    queue.stop()
  })

  it('F1-③ 非三类 deferred(attachAsset 缺 canvasId 形态)→ 不 flip,继续 deferred,0 请求', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls, openGate } = makeGateFetch()
    openGate()
    const clockMs = 1000
    const queue = makeQueue(fetch, () => clockMs)
    // attachAsset(#244 缺 canvasId 形态)deferred → migrateLegacyOp 返 null(非三类)→ recovery 不 flip。
    await __seedWritesForTest([
      {
        id: 'seed2', idempotencyKey: 'mivo-seed2', userId: 'anonymous',
        op: { kind: 'attachAsset', assetId: 'a1', nodeId: 'n1' } as unknown as WriteOp, // legacy IDB 记录缺 canvasId(#244 前);模拟 pre-Block-3 残留
        resourceKey: 'asset-attach:a1:n1', createdAt: 500, attempts: 0, nextAttemptAt: 500, status: 'deferred',
      },
    ])
    const r = await queue.drain()
    expect(r.processed).toBe(0)
    expect(calls()).toBe(0)
    const after = await __dumpWritesForTest()
    expect(after.find((x) => x.id === 'seed2')?.status).toBe('deferred')
    queue.stop()
  })

  it('F1-⑤ #244 守卫与本 block 派发共存:pending 缺 canvasId attachAsset → migrateLegacyOp null → 落 #244 守卫 → deferred,0 fetch(不 migrate/不丢)', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeGateFetch() // gate 状态无关(记录不到 requestJson)
    const clockMs = 1000
    const queue = makeQueue(fetch, () => clockMs)
    // pending 缺 canvasId attachAsset:drain → migrateLegacyOp(attachAsset)=null(非三类,不接走)→
    //   isNonCanvasWriteOp(attachAsset)=true 过 → #244 守卫 !op.canvasId → unsupported-retained → deferred(不 fetch)。
    await __seedWritesForTest([
      {
        id: 'seed3', idempotencyKey: 'mivo-seed3', userId: 'anonymous',
        op: { kind: 'attachAsset', assetId: 'a1', nodeId: 'n1' } as unknown as WriteOp, // 缺 canvasId(legacy 形态)
        resourceKey: 'asset-attach:a1:n1', createdAt: 500, attempts: 0, nextAttemptAt: 500, status: 'pending',
      },
    ])
    const r = await queue.drain()
    expect(r.processed).toBe(1)
    expect(r.terminals).toBe(0) // #244 守卫返 unsupported-retained(非 terminal),不 deleteWrite
    expect(calls()).toBe(0) // #244 守卫在 requestJson 前返 → 0 fetch
    const after = await __dumpWritesForTest()
    expect(after.find((x) => x.id === 'seed3')?.status).toBe('deferred') // unsupported-retained → deferred 留存
    queue.stop()
  })

  it('F1 gate-blocked 不消耗 maxAttempts(attempts 不动;gateAttempts 独立递增;不 dead-letter)', async () => {
    await __resetWriteQueueDb()
    const { fetch } = makeGateFetch() // gate 持续关
    let clockMs = 1000
    const queue = makeQueue(fetch, () => clockMs)
    const id = await queue.enqueue({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { x: 1 } as never })
    await queue.drain() // gate-blocked, gateAttempts=1, attempts=0
    for (let i = 0; i < 3; i++) {
      clockMs += 60_000 // 推进过任何 backoff cap
      await queue.drain()
    }
    const rec = (await __dumpWritesForTest()).find((x) => x.id === id)
    expect(rec?.status).toBe('gate-blocked') // 不 dead-letter(gate 关永不 terminal)
    expect(rec?.attempts).toBe(0) // 不消耗 maxAttempts(transient 计数器不动)
    expect((rec?.gateAttempts ?? 0) >= 2).toBe(true) // gateAttempts 独立递增
    queue.stop()
  })
})
