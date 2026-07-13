// server/lib/baseCursor.test.ts
// A2-S3 item 5 (sol LOW 硬化):fieldClock 编码 JSON 化的铁证——fieldKey 含 `,` `:` `|` `=` 不误拆。
// 权威:docs/decisions/n20-truth-source-decision.md §14.1(fieldKeyOf 完整 path 粒度)+ §14.7 NOTES。
// 旧编码 `fc=k:v,k:v`(join ',' + split ','/':')对含这些字符的 fieldKey 会误拆;新编码 JSON payload 无分隔歧义。

import { describe, expect, it, beforeEach } from 'vitest'
import {
  decodeBase,
  decodeOrderBase,
  decodeSinceBase,
  encodeBase,
  encodeOrderBase,
  encodeSinceBase,
  setBaseCursorSecrets,
} from './baseCursor'

const SECRET = 'test-secret-a2s3-item5'

describe('A2-S3 item 5 — baseCursor fieldClock JSON 编码硬化(fieldKey 含 ,:|= 不误拆)', () => {
  beforeEach(() => {
    setBaseCursorSecrets([SECRET])
  })

  it('fieldKey 含逗号:round-trip 不误拆', () => {
    // fieldKeyOf(['a,b']) = 'a,b'(段本身含逗号);旧编码 `a,b:1` 会被 split(',') 切碎。
    const fc = { 'a,b': 1, normal: 2 }
    const token = encodeBase('c1', 'n1', 5, fc)
    const decoded = decodeBase(token, 'c1', 'n1')
    expect(decoded).not.toBeNull()
    expect(decoded!.fieldClocks['a,b']).toBe(1)
    expect(decoded!.fieldClocks.normal).toBe(2)
  })

  it('fieldKey 含冒号:round-trip 不误拆', () => {
    const fc = { 'transform:x': 3, 'a:b:c': 4 }
    const token = encodeBase('c1', 'n2', 7, fc)
    const decoded = decodeBase(token, 'c1', 'n2')
    expect(decoded!.fieldClocks['transform:x']).toBe(3)
    expect(decoded!.fieldClocks['a:b:c']).toBe(4)
  })

  it('fieldKey 含管道符:round-trip 不误拆(旧 | 分隔会截断)', () => {
    const fc = { 'a|b': 5, 'c|d|e': 6 }
    const token = encodeBase('c1', 'n3', 9, fc)
    const decoded = decodeBase(token, 'c1', 'n3')
    expect(decoded!.fieldClocks['a|b']).toBe(5)
    expect(decoded!.fieldClocks['c|d|e']).toBe(6)
  })

  it('fieldKey 含等号:round-trip 不误拆(旧 indexOf(=) 切错位)', () => {
    const fc = { 'k=v': 7, 'x=y=z': 8 }
    const token = encodeBase('c1', 'n4', 11, fc)
    const decoded = decodeBase(token, 'c1', 'n4')
    expect(decoded!.fieldClocks['k=v']).toBe(7)
    expect(decoded!.fieldClocks['x=y=z']).toBe(8)
  })

  it('fieldKey 含所有特殊字符组合 + 多 field:全量不串', () => {
    const fc = { 'a,b:|c=d': 1, 'normal.field': 2, 'x,y': 3, 'p|q:r=s': 4 }
    const token = encodeBase('canvas-1', 'rec-1', 42, fc)
    const decoded = decodeBase(token, 'canvas-1', 'rec-1')
    expect(decoded!.revision).toBe(42)
    expect(decoded!.fieldClocks).toEqual(fc)
  })

  it('空 fieldClocks:round-trip 安全(无 fc 字段)', () => {
    const token = encodeBase('c1', 'n1', 1, {})
    const decoded = decodeBase(token, 'c1', 'n1')
    expect(decoded!.revision).toBe(1)
    expect(decoded!.fieldClocks).toEqual({})
  })

  it('order base / since base JSON 编码 round-trip', () => {
    const ob = encodeOrderBase('c1', 9)
    expect(decodeOrderBase(ob, 'c1')!.cv).toBe(9)
    const sb = encodeSinceBase('c1', 100)
    expect(decodeSinceBase(sb, 'c1')!.seq).toBe(100)
  })

  it('scope mismatch → null(跨 record/canvas 重放防)', () => {
    const token = encodeBase('c1', 'n1', 1, { x: 1 })
    expect(decodeBase(token, 'c1', 'n2')).toBeNull() // 不同 recordId
    expect(decodeBase(token, 'c2', 'n1')).toBeNull() // 不同 canvasId
  })

  it('篡改/畸形 token → null(验签 + 格式兜底)', () => {
    expect(decodeBase('base:not-a-json.', 'c1', 'n1')).toBeNull()
    expect(decodeBase('base:{}.', 'c1', 'n1')).toBeNull() // 无签名(verify 失败)
    expect(decodeBase('notbase:anything', 'c1', 'n1')).toBeNull()
    expect(decodeBase(undefined, 'c1', 'n1')).toBeNull()
    // 签名被篡改
    const token = encodeBase('c1', 'n1', 1, { x: 1 })
    const tampered = token.slice(0, -2) + 'zz' as never
    expect(decodeBase(tampered, 'c1', 'n1')).toBeNull()
  })
})
