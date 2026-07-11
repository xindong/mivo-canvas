// src/lib/canvasSyncPort.contract.test.ts
// G1-b port 形状编译期约束(transport-neutral 自证)。
//
// 自证逻辑(对应计划 §4 G1-b 验收"N2-0 前生产代码无某候选独占的画布 transport DTO"):
// 用 @ts-expect-error 证明 CanvasChange union 不收候选独占形状(Y.Update / JSON-Patch ops),
// SnapshotCursor 不收裸 revision number / 裸 state-vector array(防泄漏 Figma/Yjs 独占形)。
// 负向类型互锁惯例同 serverPersistAdapter.contract.test.ts(F5 baseContentVersion 必填互锁)。
// 运行时也验占位实现 fail visibly(与 unwiredServerPersistAdapter 同型,防误以为已同步)。

import { describe, it, expect, expectTypeOf } from 'vitest'
import type { CanvasChange, CanvasSyncPort, SnapshotCursor } from './canvasSyncPort'
import { unwiredCanvasSyncPort } from './canvasSyncPort'

// ── 接口面存在且签名稳定(正向编译期断言)──────────────────────────────────
describe('CanvasSyncPort interface surface (G1-b transport-neutral)', () => {
  it('exposes exactly loadSnapshot / submitChange / subscribe', () => {
    expectTypeOf<CanvasSyncPort>().toHaveProperty('loadSnapshot')
    expectTypeOf<CanvasSyncPort>().toHaveProperty('submitChange')
    expectTypeOf<CanvasSyncPort>().toHaveProperty('subscribe')
  })

  it('CanvasChange is a closed discriminated union of domain kinds (no transport DTO)', () => {
    type Kinds = CanvasChange['kind']
    expectTypeOf<Kinds>().toEqualTypeOf<
      | 'upsert-node'
      | 'upsert-edge'
      | 'upsert-anchor'
      | 'delete-node'
      | 'delete-edge'
      | 'delete-anchor'
      | 'reorder-children'
      | 'update-meta'
    >()
  })

  it('SnapshotCursor is opaque (branded) — port never reads its internals', () => {
    // 正向:游标只能经 cast 构造,不能裸赋(下面负向断言证裸值被拒)。
    const cursor = 42 as unknown as SnapshotCursor
    expectTypeOf<SnapshotCursor>().not.toEqualTypeOf<number>()
    expectTypeOf<SnapshotCursor>().not.toEqualTypeOf<number[]>()
    void cursor
  })
})

// ── 红线:port 不接受候选独占形状(@ts-expect-error 负向类型互锁)─────────────
describe('red-line: candidate-monopolized shapes are rejected by the port type', () => {
  it('Yjs Y.Update(Uint8Array binary)is not a CanvasChange', () => {
    // @ts-expect-error 'y-update' kind 不在 CanvasChange union —— Yjs 独占形状被拒(若误加进 union 此 directive 失效 → 编译报错)
    const _yUpdate: CanvasChange = { kind: 'y-update', update: new Uint8Array() }
    void _yUpdate
  })

  it('Yjs state-vector(number[])is not assignable to SnapshotCursor directly', () => {
    // @ts-expect-error SnapshotCursor branded 不收裸数组(防 Yjs state-vector 当游标透传泄漏进 port)
    const _sv: SnapshotCursor = [1, 2, 3]
    void _sv
  })

  it('Figma JSON-Patch ops array is not a CanvasChange', () => {
    // @ts-expect-error 'patch' kind 不在 CanvasChange union —— Figma field-path PATCH 独占形状被拒(单行让错落在 directive 下一行)
    const _jsonPatch: CanvasChange = { kind: 'patch', ops: [{ op: 'replace', path: '/transform/x', value: 5 }] }
    void _jsonPatch
  })

  it('Figma bare revision number is not assignable to SnapshotCursor directly', () => {
    // @ts-expect-error SnapshotCursor branded 不收裸 number(防 Figma If-Match revision 当游标透传泄漏进 port)
    const _rev: SnapshotCursor = 42
    void _rev
  })
})

// ── 占位实现 fail visibly(运行时,防静默成功)──────────────────────────────
describe('unwiredCanvasSyncPort (fail visibly, not silent success)', () => {
  it('rejects loadSnapshot with not-wired error', async () => {
    await expect(unwiredCanvasSyncPort.loadSnapshot('c1')).rejects.toThrow(/not wired/)
  })

  it('rejects submitChange with not-wired error', async () => {
    await expect(
      unwiredCanvasSyncPort.submitChange('c1', { kind: 'delete-node', nodeId: 'n1' }),
    ).rejects.toThrow(/not wired/)
  })

  it('rejects subscribe with not-wired error', async () => {
    await expect(unwiredCanvasSyncPort.subscribe('c1', () => {})).rejects.toThrow(/not wired/)
  })
})
