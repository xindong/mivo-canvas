// scripts/e2e/harness.contract.test.ts
// SC-15 R2 (probe honesty) — waitForPersistedKv 的诚实性契约测试。
//
// 根因（复审）：waitForPersistedKv 超时后无条件 `return readPersistedKv(page, key)`，
// 返回 key 下任意非空 raw blob —— 即使内容未满足 predicate。SC-15 调用方只写
// `if (!settledChatRaw) throw`，于是 "key 存在但内容仍是 generating" 被判绿，掩盖了
// hydration settle 未 durable 回写 IDB 的真 bug。本契约测试锁住修复后行为：
//   - key 非空但 predicate 永远 false → 超时返回 null（绝不可返回非空 blob）。
//   - predicate 满足 → 返回 blob（真绿路径保留）。
//   - key 不存在（blob null）→ 超时返回 null。
//
// 不启真浏览器：用 fake page 的 evaluate 按 call 奇偶区分 resolvePersistKey（返回
// logical key）与 readPersistedKv 的 IDB 读（返回注入 blob），对轮询循环稳健。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { waitForPersistedKv, resolvePersistKey } from './harness.mjs'

// 每次 readPersistedKv = 2 次 page.evaluate（resolvePersistKey + IDB 读）。奇数次调用
// = resolvePersistKey（返回 logical key = arg）；偶数次 = IDB 读（返回注入 blob）。
const makeFakePage = (blob: string | null) => {
  let call = 0
  const page = {
    evaluate: async (_fn: unknown, arg: unknown) => {
      call += 1
      return (call % 2 === 1) ? arg : blob
    },
  }
  return page as unknown as Parameters<typeof waitForPersistedKv>[0]
}

const isStatus = (raw: string, status: string) => {
  try {
    const p = JSON.parse(raw)
    return p?.state?.messagesByScene?.s?.[0]?.status === status
  } catch {
    return false
  }
}

describe('waitForPersistedKv probe honesty (SC-15 R2)', () => {
  it('key 非空但 predicate 永远 false → 超时返回 null（不得返回非空 blob 制造假绿）', async () => {
    // generating blob — 修复前 helper 超时会把这个 blob 当返回值，调用方 if(!raw) 通过 → 假绿。
    const generatingBlob = JSON.stringify({
      state: { messagesByScene: { s: [{ status: 'generating' }] } },
    })
    const page = makeFakePage(generatingBlob)
    const result = await waitForPersistedKv(
      page,
      'mivo-chat-demo',
      (raw) => isStatus(raw, 'error'), // error predicate — generating blob 永不满足
      { timeout: 80, interval: 10 },
    )
    expect(result).toBeNull() // 诚实 null，不是 generating blob
  })

  it('predicate 满足 → 返回 blob（真绿路径保留）', async () => {
    const errorBlob = JSON.stringify({
      state: { messagesByScene: { s: [{ status: 'error', retryDisabledReason: '局部重绘过期' }] } },
    })
    const page = makeFakePage(errorBlob)
    const result = await waitForPersistedKv(
      page,
      'mivo-chat-demo',
      (raw) => isStatus(raw, 'error'),
      { timeout: 200, interval: 10 },
    )
    expect(result).toBe(errorBlob)
  })

  it('key 不存在（blob null）→ 超时返回 null', async () => {
    const page = makeFakePage(null)
    const result = await waitForPersistedKv(
      page,
      'mivo-chat-demo',
      () => true,
      { timeout: 80, interval: 10 },
    )
    expect(result).toBeNull()
  })
})

// SC-15 R2 P2 (domain-aware probe honesty) — resolvePersistKey fail-closed 契约测试。
//
// 根因（R2 复审 P2）：domain-aware resolvePersistKey 对整个 page.evaluate 用无条件
// try/catch + 静默 `return name`（legacy 裸键），且 domain 已指定但 bridge/getter 缺失
// 时也静默落入 legacy name:uid 分支。探针自身出错会读错误物理键的 stale blob（假绿）
// 或把产品持久化 bug 伪装成探针超时红（误导性红）——本次误诊的同根 silent-failure
// 家族。本契约锁住修复后行为：
//   ① domain 合法 + bridge 正常 → 正确分裂键。
//   ② domain 指定 + bridge 缺失 / getter 缺失 → reject 携 cause（不降级 legacy/raw）。
//   ③ domain 非法 enum → reject。
//   ④ 无 domain → FX-6 name:uid 兼容路径不变（含 bridge 缺失回退 raw name）。
//
// 不启真浏览器：fake page 的 evaluate 直接在 Node 跑 callback（fn(arg)），按测试需要
// 在 globalThis.__MIVO_E2E__ 注入/移除 bridge，验证 browser-side 分支逻辑。每个 it
// 用 beforeEach 清空 bridge 基线、afterEach 还原，避免跨用例污染。

describe('resolvePersistKey domain-aware fail-closed (SC-15 R2 P2)', () => {
  let hadBridge: boolean
  let prevBridge: unknown

  beforeEach(() => {
    hadBridge = '__MIVO_E2E__' in globalThis
    prevBridge = (globalThis as Record<string, unknown>).__MIVO_E2E__
    delete (globalThis as Record<string, unknown>).__MIVO_E2E__
  })

  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    if (hadBridge) g.__MIVO_E2E__ = prevBridge
    else delete g.__MIVO_E2E__
  })

  // fake page: 跑真实 browser-side callback（fn(arg)）在 Node 进程。bridge 由各用例
  // 预先注入 globalThis.__MIVO_E2E__（或保持删除模拟 bridge 缺失）。
  const plainPage = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Parameters<typeof resolvePersistKey>[0]

  it('① domain 合法 + bridge 正常 → 正确分裂键', async () => {
    const g = globalThis as Record<string, unknown>
    g.__MIVO_E2E__ = {
      getCanvasPersistDocumentKey: (n: string) => `${n}:dev@local:document`,
      getCanvasPersistSessionKey: (n: string) => `${n}:dev@local:session`,
    }
    const doc = await resolvePersistKey(plainPage, 'mivo-canvas-demo', { domain: 'document' })
    expect(doc).toBe('mivo-canvas-demo:dev@local:document')
    const sess = await resolvePersistKey(plainPage, 'mivo-canvas-demo', { domain: 'session' })
    expect(sess).toBe('mivo-canvas-demo:dev@local:session')
  })

  it('② domain 指定 + bridge 缺失 → reject 携 cause（不降级 legacy/raw key）', async () => {
    // bridge entirely absent — fresh page / 非 app context。修复前静默回退 legacy 裸键。
    const g = globalThis as Record<string, unknown>
    delete g.__MIVO_E2E__
    await expect(
      resolvePersistKey(plainPage, 'mivo-canvas-demo', { domain: 'document' }),
    ).rejects.toThrow(/domain='document'/)
  })

  it('②b domain 指定 + getter 缺失 → reject 携 cause（不降级 legacy/raw key）', async () => {
    // bridge 存在但 document getter 未接线。修复前静默落入 legacy name:uid 分支。
    const g = globalThis as Record<string, unknown>
    g.__MIVO_E2E__ = { getCanvasPersistSessionKey: (n: string) => `${n}:session` }
    await expect(
      resolvePersistKey(plainPage, 'mivo-canvas-demo', { domain: 'document' }),
    ).rejects.toThrow(/domain='document'/)
  })

  it('③ domain 非法 enum → reject', async () => {
    const g = globalThis as Record<string, unknown>
    g.__MIVO_E2E__ = { getCanvasPersistDocumentKey: () => 'x' }
    await expect(
      resolvePersistKey(plainPage, 'mivo-canvas-demo', { domain: 'canvas' as unknown as 'document' }),
    ).rejects.toThrow(/invalid domain/)
  })

  it('④ 无 domain → FX-6 name:uid 兼容路径不变（含 bridge 缺失回退 raw name）', async () => {
    const g = globalThis as Record<string, unknown>
    // authenticated → namespaced key（FX-6 语义保留）
    g.__MIVO_E2E__ = { getPersistUserId: () => 'dev@local' }
    expect(await resolvePersistKey(plainPage, 'mivo-chat-demo')).toBe('mivo-chat-demo:dev@local')
    // bridge absent / anonymous → raw name（legacy fallback 保留，不变）
    delete g.__MIVO_E2E__
    expect(await resolvePersistKey(plainPage, 'mivo-chat-demo')).toBe('mivo-chat-demo')
  })
})
