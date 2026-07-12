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

import { describe, expect, it } from 'vitest'
import { waitForPersistedKv } from './harness.mjs'

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
