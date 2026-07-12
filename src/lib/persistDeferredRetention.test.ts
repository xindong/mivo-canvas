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

import { describe, expect, it } from 'vitest'
import { createWriteQueue, __resetWriteQueueDb, __dumpWritesForTest, type WriteOp } from './writeRetryQueue'
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

describe('G1-a P1-3 — canvas 域写 op drain 后留存不删(unsupported-retained;chat 已接 wired 不在此列)', () => {
  it('upsertNode drain 后 status=deferred,fetch 0 调用,records 仍在 + idempotencyKey 保留', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeCountingFetch()
    const queue = makeQueue(fetch)

    // 预置 canvas 域写 op(模拟 G1-c 上线前遗留的 durable 记录)。
    // 注:appendChatMessage 已 wired(DP-6R P1-1 划归 G1-a),不在 deferred 集合——此处只验 canvas 域写留存。
    const canvasOp: WriteOp = { kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: {} as never }
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

  it('reorderChildren / deleteNode / upsertEdge 等 canvas 域 op 同样留存(deferred),不调 deleteWrite', async () => {
    await __resetWriteQueueDb()
    const { fetch, calls } = makeCountingFetch()
    const queue = makeQueue(fetch)

    await queue.enqueue({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1', 'n2'], baseContentVersion: 0 })
    await queue.enqueue({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' })
    await queue.enqueue({ kind: 'upsertEdge', canvasId: 'c1', edgeId: 'e1', payload: {} as never })
    const result = await queue.drain()

    expect(calls()).toBe(0)
    expect(result.terminals).toBe(0)
    const after = await __dumpWritesForTest()
    expect(after.length).toBe(3)
    expect(after.every((r) => r.status === 'deferred')).toBe(true)
    queue.stop()
  })
})
