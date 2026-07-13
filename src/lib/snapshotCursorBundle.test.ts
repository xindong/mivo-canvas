// src/lib/snapshotCursorBundle.test.ts
// A2-S3 item 1 bundle 单测(SC①):多 record hydrate→edit n1/n2 token 不串/增量更新未命中项值不变/非连续 seq/
//   fail-visible 缺项禁借用/reorder 取 order / create 免 base。
// 权威:docs/decisions/n20-truth-source-decision.md §14.7 NOTES(bundle 增量更新 + fail-visible 缺项禁借用 +
//   pending>0 真测)+ inventory §3(submitChange 解包对应 wire base)。

import { describe, expect, it } from 'vitest'
import {
  applyAccepted,
  applyConflict,
  buildBundle,
  extractWireBase,
  getOrderCv,
  getSinceSeq,
  setRecordBase,
  unwrapBundle,
} from './snapshotCursorBundle'
import type { CanvasChange } from './canvasSyncPort'

// 合成 base 字符串(模拟 server encodeBase 签发的 opaque token;client 不验签,只持有/回传)。
const baseOf = (id: string, rev: number): string => `base:fake.${id}.r${rev}.sig`

describe('A2-S3 item 1 — SnapshotCursor bundle (SC①)', () => {
  it('多 record hydrate:edit n1/n2 的 wire base 不串用(各取各的 record base)', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1), n2: baseOf('n2', 1) }, 5, 0)
    const editN1: CanvasChange = { kind: 'edit-node', nodeId: 'n1', intents: [] }
    const editN2: CanvasChange = { kind: 'edit-node', nodeId: 'n2', intents: [] }
    expect(extractWireBase(cursor, editN1)).toBe(baseOf('n1', 1))
    expect(extractWireBase(cursor, editN2)).toBe(baseOf('n2', 1))
    // 不串:n1 的 base ≠ n2 的 base
    expect(extractWireBase(cursor, editN1)).not.toBe(extractWireBase(cursor, editN2))
  })

  it('增量更新:applyAccepted(n1) 后 n2 的 base 值不变(未命中项不动;非整 bundle 重建)', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1), n2: baseOf('n2', 1) }, 5, 10)
    const editN1: CanvasChange = { kind: 'edit-node', nodeId: 'n1', intents: [] }
    const updated = applyAccepted(cursor, editN1, baseOf('n1', 2), 11)
    // n1 base 更新为新值
    expect(extractWireBase(updated, editN1)).toBe(baseOf('n1', 2))
    // n2 base 未命中 → 值不变(toStrictEqual 增量铁证)
    const editN2: CanvasChange = { kind: 'edit-node', nodeId: 'n2', intents: [] }
    expect(extractWireBase(updated, editN2)).toBe(baseOf('n2', 1))
  })

  it('非连续 seq:旧 sinceSeq=5,响应 seq=11 → sinceSeq=11(seq 不要求连续,取 wire 权威值)', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1) }, 3, 5)
    const editN1: CanvasChange = { kind: 'edit-node', nodeId: 'n1', intents: [] }
    const updated = applyAccepted(cursor, editN1, baseOf('n1', 2), 11)
    expect(getSinceSeq(updated)).toBe(11)
    // 缺 seq(响应不带)→ sinceSeq 不动(保留旧值,不归零)
    const updatedNoSeq = applyAccepted(cursor, editN1, baseOf('n1', 2))
    expect(getSinceSeq(updatedNoSeq)).toBe(5)
  })

  it('fail-visible 缺项禁借用:n3 不在 bundle → extractWireBase 返 undefined,不借用 n1/n2 的 base', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1), n2: baseOf('n2', 1) }, 5, 0)
    const editN3: CanvasChange = { kind: 'edit-node', nodeId: 'n3', intents: [] }
    expect(extractWireBase(cursor, editN3)).toBeUndefined()
    // delete 同理:缺 record base → undefined(禁借用)
    const delN3: CanvasChange = { kind: 'delete-node', nodeId: 'n3' }
    expect(extractWireBase(cursor, delN3)).toBeUndefined()
  })

  it('reorder:extractWireBase 取 String(orderCv)(bare contentVersion,parseIfMatch 路径)', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1) }, 7, 0)
    const reorder: CanvasChange = { kind: 'reorder-children', childType: 'node', orderedIds: ['n1', 'n2'] }
    expect(extractWireBase(cursor, reorder)).toBe('7')
    // orderCv=0(未 hydrate contentVersion)→ undefined(fail-visible,不发裸 0 作 If-Match 致 428/400)
    const cursor0 = buildBundle('c1', { n1: baseOf('n1', 1) }, 0, 0)
    expect(extractWireBase(cursor0, reorder)).toBeUndefined()
  })

  it('create:extractWireBase 返 undefined(create 免 base;POST 不带 If-Match)', () => {
    const cursor = buildBundle('c1', {}, 5, 0)
    const createNode: CanvasChange = { kind: 'create-node', node: { id: 'n1', type: 'image', revision: 0 } as never }
    expect(extractWireBase(cursor, createNode)).toBeUndefined()
  })

  it('applyAccepted create:回填新 record 的 base(create 响应签发 base 落入 records)', () => {
    const cursor = buildBundle('c1', {}, 5, 0)
    const createNode: CanvasChange = { kind: 'create-node', node: { id: 'n9', type: 'image', revision: 0 } as never }
    const updated = applyAccepted(cursor, createNode, baseOf('n9', 1), 6)
    const editN9: CanvasChange = { kind: 'edit-node', nodeId: 'n9', intents: [] }
    expect(extractWireBase(updated, editN9)).toBe(baseOf('n9', 1))
    // create→edit 因果:create 后即有 base,后续 edit 不缺命中(§10.8)
  })

  it('applyAccepted delete:移除已删 record 的 base,未命中项保持原值', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1), n2: baseOf('n2', 1) }, 5, 0)
    const deleted = applyAccepted(cursor, { kind: 'delete-node', nodeId: 'n1' }, undefined, 8)
    expect(extractWireBase(deleted, { kind: 'delete-node', nodeId: 'n1' })).toBeUndefined()
    expect(extractWireBase(deleted, { kind: 'edit-node', nodeId: 'n2', intents: [] })).toBe(baseOf('n2', 1))
    expect(getSinceSeq(deleted)).toBe(8)
  })

  it('applyAccepted reorder:orderCv 增量更新(bump 后新 contentVersion);sinceSeq 取响应 seq', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1) }, 5, 10)
    const reorder: CanvasChange = { kind: 'reorder-children', childType: 'node', orderedIds: ['n1'] }
    const updated = applyAccepted(cursor, reorder, undefined, 12, 8)
    expect(getOrderCv(updated)).toBe(8)
    expect(getSinceSeq(updated)).toBe(12)
    // per-record base 不被 reorder 误改
    const editN1: CanvasChange = { kind: 'edit-node', nodeId: 'n1', intents: [] }
    expect(extractWireBase(updated, editN1)).toBe(baseOf('n1', 1))
  })

  it('applyConflict:更新对应 record 的 current base;未命中 record 不动', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1), n2: baseOf('n2', 1) }, 5, 10)
    const delN1: CanvasChange = { kind: 'delete-node', nodeId: 'n1' }
    const conflicted = applyConflict(cursor, delN1, baseOf('n1', 99), 13)
    // n1 current base 更新为 server 返的 current(re-fetch/retry 用)
    expect(extractWireBase(conflicted, delN1)).toBe(baseOf('n1', 99))
    // n2 未命中 → 不动
    const editN2: CanvasChange = { kind: 'edit-node', nodeId: 'n2', intents: [] }
    expect(extractWireBase(conflicted, editN2)).toBe(baseOf('n2', 1))
    // since 取 wire 权威 seq
    expect(getSinceSeq(conflicted)).toBe(13)
  })

  it('setRecordBase:authoritative load 后定点回填单 record base(防常量 cursor 冒充;R2-P1-3)', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1) }, 5, 0)
    const updated = setRecordBase(cursor, 'n2', baseOf('n2', 7))
    const editN2: CanvasChange = { kind: 'edit-node', nodeId: 'n2', intents: [] }
    expect(extractWireBase(updated, editN2)).toBe(baseOf('n2', 7))
    // n1 不动
    const editN1: CanvasChange = { kind: 'edit-node', nodeId: 'n1', intents: [] }
    expect(extractWireBase(updated, editN1)).toBe(baseOf('n1', 1))
  })

  it('unwrapBundle 拒非 bundle cursor(防裸 number/string/array 误当 cursor 透传)', () => {
    expect(unwrapBundle(undefined)).toBeNull()
    expect(unwrapBundle(5 as never)).toBeNull()
    expect(unwrapBundle('base:n1' as never)).toBeNull()
    expect(unwrapBundle([1, 2, 3] as never)).toBeNull()
  })

  it('scope:bundle 携带 canvasId(防跨 canvas 串用;client 不验签但保留 scope 供调用方自检)', () => {
    const cursor = buildBundle('c1', { n1: baseOf('n1', 1) }, 5, 0)
    expect(unwrapBundle(cursor)?.canvasId).toBe('c1')
  })
})
