// server/persist/key-separator.test.ts
// A8②-2 持久层/任务层 复合 key NUL 分隔符不变量。
// 背景:recordKey/idemIndexKey(backend.ts)与 idemIndexKey(registry.ts)原用 ':' 分隔,
// 段内若含 ':' 会产生歧义(split 还原段数错误)。现改 NUL('\u0000')分隔 → 段内含 ':' 也可
// 被 split 精确还原,碰撞-proof。这些 key 是进程内 InMemory Map key(不落 PG TEXT/IDB),
// 故 NUL 安全(PG TEXT 拒 NUL,但本层不经 PG;PG 后端用独立列无分隔符)。

import { describe, it, expect } from 'vitest'
import { recordKey, idemIndexKey as backendIdemIndexKey } from './backend'
import { idemIndexKey as registryIdemIndexKey } from '../tasks/registry'

const NUL = '\u0000'

describe('A8②-2 NUL 分隔符复合 key — 碰撞-proof 不变量', () => {
  it('recordKey:段内含 ":" 也可被 NUL split 精确还原(无歧义)', () => {
    // 段内含 ':' —— ':' 分隔下 split(':') 会得 4 段(歧义,无法还原原 3 段);NUL 下仍恰好 3 段。
    const key = recordKey('a:b', 'canvas', 'c:d')
    expect(key.split(NUL)).toEqual(['a:b', 'canvas', 'c:d'])
    expect(key.includes(NUL)).toBe(true)
  })

  it('recordKey:不同逻辑段集合必产生不同 key(碰撞-proof)', () => {
    // 两组段在 ':' 分隔下会碰撞(都拼成 'a:b:canvas:c');NUL 下必不同。
    //   recordKey('a:b','canvas','c') → ':' 下 'a:b:canvas:c'
    //   recordKey('a','b:canvas','c')... 但 type 枚举约束不含 ':';故取可含 ':' 的 ownerId/id 段:
    const k1 = recordKey('a:b', 'canvas', 'c')
    const k2 = recordKey('a', 'canvas', 'b') // 不同 (ownerId, id) tuple
    expect(k1).not.toBe(k2)
  })

  it('backend idemIndexKey:4 段含 ":" 可被 NUL split 精确还原', () => {
    const key = backendIdemIndexKey('a:b', 'POST', 'canvas', 'k:x')
    expect(key.split(NUL)).toEqual(['a:b', 'POST', 'canvas', 'k:x'])
  })

  it('backend idemIndexKey:段内 ":" 不与分隔符歧义(ownerId 含 ":" vs idempotencyKey 含 ":")', () => {
    // 两组不同逻辑段,':' 分隔下可能撞(取决于段内容);NUL 下必不同。
    const k1 = backendIdemIndexKey('owner:x', 'POST', 'canvas', 'k1')
    const k2 = backendIdemIndexKey('owner', 'POST', 'canvas', 'x:k1') // ownerId/idempotencyKey 均不同
    expect(k1).not.toBe(k2)
    expect(k1.split(NUL)).toHaveLength(4)
    expect(k2.split(NUL)).toHaveLength(4)
  })

  it('registry idemIndexKey:2 段含 ":" 可被 NUL split 精确还原', () => {
    // ownerFp 实际是 16hex(不含 ':'),idempotencyKey 是调用方自由串可能含 ':';NUL 保证无歧义。
    const key = registryIdemIndexKey('abc123def456abc1', 'client-key:with:colon')
    expect(key.split(NUL)).toEqual(['abc123def456abc1', 'client-key:with:colon'])
  })

  it('registry idemIndexKey:不同 (ownerFp, idempotencyKey) 必不同 key(防跨 owner 碰撞 → billing leak)', () => {
    // 旧 ':' 分隔:('a:b','c') 与 ('a','b:c') 都拼 'a:b:c' → 第二个 createTask 误命中第一个(碰撞)。
    // NUL 分隔下两者必不同,createTask 第二个 created=true(不误命中)。
    const k1 = registryIdemIndexKey('a:b', 'c')
    const k2 = registryIdemIndexKey('a', 'b:c')
    expect(k1).not.toBe(k2) // NUL 下必不同(旧 ':' 下两者相同 → 碰撞)
  })
})
