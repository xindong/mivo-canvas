// src/lib/canvasSyncPort.contract.test.ts
// G1-b port 形状编译期 + 运行期约束(transport-neutral 自证 + 返修 F1/F3 契约测试)。
//
// 自证逻辑(对应计划 §4 G1-b 验收"N2-0 前生产代码无某候选独占的画布 transport DTO"):
// 用 @ts-expect-error 证明 CanvasChange/FieldIntent/SnapshotCursor/RejectionReason 不收候选独占形状
// (Y.Update / JSON-Patch ops / 裸 revision / 裸 state-vector array / 裸 HTTP 码 / RFC6902 op)。
// 负向类型互锁惯例同 serverPersistAdapter.contract.test.ts(F5 baseContentVersion 必填互锁)。
// 运行时也验占位实现 fail visibly(与 unwiredServerPersistAdapter 同型,防误以为已同步)。
//
// 返修(G1-b 双审 REQUIRES_CHANGES,2026-07-12):
//  - F1 契约:field-intent 无损——同 record 不同字段并发两边都留、未编辑字段不被提交、嵌套叶子不整树替换、reorder 有意图。
//  - F3 契约:终态拒绝 outcome 映射(401/403/revoke/400/413/422→rejected;409→conflict;5xx/408/429→retryable;200→accepted),
//    无终态误重试、无假成功(accepted 必携服务端 cursor)。

import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  CanvasChange,
  CanvasSyncPort,
  ChangeOutcome,
  FieldIntent,
  RejectionReason,
  SnapshotCursor,
} from './canvasSyncPort'
import { unwiredCanvasSyncPort } from './canvasSyncPort'

// ── 接口面存在且签名稳定(正向编译期断言)──────────────────────────────────
describe('CanvasSyncPort interface surface (G1-b transport-neutral)', () => {
  it('exposes exactly loadSnapshot / submitChange / subscribe', () => {
    expectTypeOf<CanvasSyncPort>().toHaveProperty('loadSnapshot')
    expectTypeOf<CanvasSyncPort>().toHaveProperty('submitChange')
    expectTypeOf<CanvasSyncPort>().toHaveProperty('subscribe')
  })

  it('CanvasChange is a closed discriminated union of domain kinds (no transport DTO)', () => {
    // 返修 F1:upsert-* 拆为 create-*(全量新 record)+ edit-*(字段级意图);kind 全为域语义,无 'y-update'/'patch' 等候选独占形状。
    type Kinds = CanvasChange['kind']
    expectTypeOf<Kinds>().toEqualTypeOf<
      | 'create-node'
      | 'create-edge'
      | 'create-anchor'
      | 'edit-node'
      | 'edit-edge'
      | 'edit-anchor'
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

  // 返修 F3 红线:RejectionReason 是域枚举,拒裸 HTTP 码(防 transport-code 泄漏进 port 面)。
  it('RejectionReason does NOT accept a raw HTTP status code (no transport-code leak)', () => {
    // @ts-expect-error RejectionReason 是域枚举(unauthorized/forbidden/...);裸 HTTP 数字 401 不可赋(防把 HTTP 码当原因泄漏)
    const _bad: RejectionReason = 401
    void _bad
  })

  // 返修 F1 红线:FieldIntent 是域动词,拒 RFC 6902 JSON-Patch op 形状(防 wire DTO 泄漏进 port 面)。
  it('FieldIntent does NOT accept an RFC 6902 JSON-Patch op shape (no wire-DTO leak)', () => {
    // @ts-expect-error FieldIntent.op 是 'set'|'delete-field'(域动词);RFC6902 'replace' + JSON-Pointer 'path' wire DTO 被拒
    const _bad: FieldIntent = { op: 'replace', path: '/transform/x', value: 5 }
    void _bad
  })
})

// ── 返修 F1:field-intent 无损并发(契约证明)─────────────────────────────
describe('F1: field-level edit intent is lossless under concurrency', () => {
  // 测试内参考 apply:证明 FieldIntent[] 语义在「按 fieldPath 定点 set」下无损。
  // 这是 port 冻结的域语义的参考实现(adapter 各自实现,但语义须与此一致)。
  const applyFieldIntents = <R extends Record<string, unknown>>(base: R, intents: FieldIntent[]): R => {
    const out: Record<string, unknown> = JSON.parse(JSON.stringify(base))
    for (const intent of intents) {
      const path = [...intent.fieldPath]
      let cur: unknown = out
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i]
        cur = (cur as Record<string | number, unknown>)[seg]
      }
      const last = path[path.length - 1]
      if (intent.op === 'set') (cur as Record<string | number, unknown>)[last] = intent.value
      else delete (cur as Record<string | number, unknown>)[last]
    }
    return out as R
  }

  it('edit-node carries only field intents, NOT a whole record (unedited fields cannot be submitted)', () => {
    // F1 核心契约:edit-* 只暴露 nodeId + intents;全量 NodeRecord 不在 payload——未编辑字段根本无法进 wire。
    type EditNode = Extract<CanvasChange, { kind: 'edit-node' }>
    expectTypeOf<keyof EditNode>().toEqualTypeOf<'kind' | 'nodeId' | 'intents'>()
    // create-* 才带全量 record(新 record,无并发覆盖隐患)
    type CreateNode = Extract<CanvasChange, { kind: 'create-node' }>
    expectTypeOf<keyof CreateNode>().toEqualTypeOf<'kind' | 'node'>()
  })

  it('same record, different fields concurrent → BOTH kept (no whole-record clobber)', () => {
    // A 改 transform.x,B 改 title——fieldPath 不交,两条 edit intent 都留痕(对比全量 upsert 的 shadow-diff 误判/回滚)。
    const base = { transform: { x: 0, y: 0 }, title: 'n', fills: [{ id: 'f1' }] }
    const a: FieldIntent[] = [{ op: 'set', fieldPath: ['transform', 'x'], value: 100 }]
    const b: FieldIntent[] = [{ op: 'set', fieldPath: ['title'], value: 'B-title' }]
    // 并发(顺序无关),合并后两边都留:
    const merged = applyFieldIntents(applyFieldIntents(base, a), b)
    expect(merged.transform.x).toBe(100) // A 的字段留
    expect(merged.title).toBe('B-title') // B 的字段留
    expect(merged.transform.y).toBe(0) // 未编辑的嵌套叶子不被替换
    expect(merged.fills).toEqual([{ id: 'f1' }]) // 未编辑的兄弟字段不被触碰
  })

  it('nested leaf set does NOT whole-tree replace (transform.y survives transform.x edit)', () => {
    // spike yjs-mapping.spike.test.ts:376-398 坑7 反例:整 record clear+rebuild 吞了并发的 transform.y=999。
    // field-intent set ['transform','x'] 只定点改叶子——transform.y 保留(坑7 在 field-intent 语义下不成立)。
    const base = { transform: { x: 0, y: 999 } }
    const after = applyFieldIntents(base, [{ op: 'set', fieldPath: ['transform', 'x'], value: 100 }])
    expect(after.transform.x).toBe(100)
    expect(after.transform.y).toBe(999) // NOT swallowed(对比 spike 坑7 全量重写丢 999)
  })

  it('delete-field intent removes a leaf without record deletion', () => {
    // fieldPath delete-field 是字段级删叶子;record 删走 delete-* kind(两件事不混淆)。
    const base = { transform: { x: 0, y: 0 }, title: 'n' }
    const after = applyFieldIntents(base, [{ op: 'delete-field', fieldPath: ['title'] }])
    expect('title' in after).toBe(false)
    expect(after.transform.x).toBe(0) // 兄弟字段不受影响
  })

  it('reorder-children carries full orderedIds (move intent, not Y.Array delete+insert)', () => {
    // orderedIds 表达完整目标序(移动意图);非 Y.Array delete+insert(坑3 并发 reorder 不保序,N2-0 §11 Q5 维持显式 order_key)。
    const reorder: CanvasChange = { kind: 'reorder-children', childType: 'node', orderedIds: ['n2', 'n1', 'n3'] }
    expect(reorder.kind).toBe('reorder-children')
    if (reorder.kind === 'reorder-children') {
      expect(reorder.orderedIds).toEqual(['n2', 'n1', 'n3'])
      expect(reorder.orderedIds).toHaveLength(3)
    }
  })

  it('array-index fieldPath targets a single element (e.g. fills[0].color)', () => {
    // (string|number)[] 域数组:number 段进数组下标——定点改单个 fill 的 color,不整 fills 替换。
    const base = { fills: [{ id: 'f1', color: '#000' }, { id: 'f2', color: '#fff' }] }
    const after = applyFieldIntents(base, [{ op: 'set', fieldPath: ['fills', 0, 'color'], value: '#f00' }])
    expect(after.fills[0].color).toBe('#f00')
    expect(after.fills[1].color).toBe('#fff') // 兄弟元素不受影响
  })
})

// ── 返修 F3:终态拒绝 + 权威 accepted(契约证明)─────────────────────────
describe('F3: terminal rejections + authoritative accepted (no mis-retry, no false success)', () => {
  // 代表性 HTTP→ChangeOutcome 映射(未来 Figma 案 adapter 须实现)。
  // port 本身不定义 HTTP——此映射在 test/adapter 侧,证明 ChangeOutcome 类型能无损表达所有 transport 错误类别。
  // 先例:writeRetryQueue.classifyHttpStatus(src/lib/writeRetryQueue.ts:130-155)的 8 态 WriteOutcome → 此处映射到 port 的 4 态 ChangeOutcome。
  const CURSOR = 'rev-1' as unknown as SnapshotCursor
  const CURRENT = 'rev-2' as unknown as SnapshotCursor

  const mapHttpStatusToOutcome = (status: number, opts: { isDelete?: boolean } = {}): ChangeOutcome => {
    if (status >= 200 && status < 300) return { kind: 'accepted', cursor: CURSOR }
    if (status === 401) return { kind: 'rejected', reason: 'unauthorized' }
    if (status === 403) return { kind: 'rejected', reason: 'forbidden' }
    if (status === 404) return opts.isDelete ? { kind: 'accepted', cursor: CURSOR } : { kind: 'rejected', reason: 'not-found' }
    if (status === 413) return { kind: 'rejected', reason: 'too-large' }
    if (status === 422) return { kind: 'rejected', reason: 'reuse-conflict' }
    if (status === 400) return { kind: 'rejected', reason: 'bad-request' }
    if (status === 409) return { kind: 'conflict', currentCursor: CURRENT, diverging: [] }
    if (status >= 500 || status === 408 || status === 429) return { kind: 'retryable', reason: `http_${status}` }
    return { kind: 'rejected', reason: 'terminal', detail: `http_${status}` }
  }

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [400, 'bad-request'],
    [413, 'too-large'],
    [422, 'reuse-conflict'],
  ])('HTTP %i → rejected(%s), NOT retryable (no terminal mis-retry)', (status, reason) => {
    const o = mapHttpStatusToOutcome(status)
    expect(o.kind).toBe('rejected')
    if (o.kind === 'rejected') expect(o.reason).toBe(reason)
    // 终态拒绝绝不误判为可重试(防无限重试/假复活)
    expect(o.kind).not.toBe('retryable')
    expect(o.kind).not.toBe('accepted')
  })

  it('404 non-delete → rejected(not-found); 404 delete → accepted (delete-vs-update: delete wins)', () => {
    // N2-0 §10.4:delete-vs-update → delete wins;删除后再 delete 返 404 → 幂等 accepted(已删=目标态)。
    const nonDel = mapHttpStatusToOutcome(404)
    expect(nonDel.kind).toBe('rejected')
    if (nonDel.kind === 'rejected') expect(nonDel.reason).toBe('not-found')
    const del = mapHttpStatusToOutcome(404, { isDelete: true })
    expect(del.kind).toBe('accepted')
  })

  it('409 → conflict (concurrent write); returns currentCursor + diverging for rebase', () => {
    const o = mapHttpStatusToOutcome(409)
    expect(o.kind).toBe('conflict')
    if (o.kind === 'conflict') {
      expect(o.currentCursor).toBe(CURRENT)
      expect(o.diverging).toEqual([])
    }
    expect(o.kind).not.toBe('retryable') // 冲突不重试同 op(rebase 而非重放)
  })

  it('transient (5xx/408/429) → retryable (client may retry same change verbatim)', () => {
    for (const s of [500, 502, 503, 408, 429]) {
      const o = mapHttpStatusToOutcome(s)
      expect(o.kind).toBe('retryable')
      if (o.kind === 'retryable') expect(o.reason).toContain(String(s))
    }
  })

  it('200 → accepted WITH server cursor (no false success: accepted requires authoritative cursor)', () => {
    // F3 核心:accepted = 服务端权威 ack,必携服务端回传 cursor;无 cursor 即无 accepted(防本地 echo 误判为已提交)。
    const o = mapHttpStatusToOutcome(200)
    expect(o.kind).toBe('accepted')
    if (o.kind === 'accepted') expect(o.cursor).toBe(CURSOR)
  })

  it('revoke (membership removed / share revoked) → submitChange after revoke maps to rejected(forbidden)', () => {
    // revoke 实时事件经 CanvasSyncEvent.revoke;撤销后再 submitChange → 403 → rejected(forbidden),非重试。
    const o = mapHttpStatusToOutcome(403)
    expect(o.kind).toBe('rejected')
    if (o.kind === 'rejected') expect(o.reason).toBe('forbidden')
    expect(o.kind).not.toBe('retryable')
  })

  // 类型级不变量(编译期)
  it('ChangeOutcome kinds are accepted|conflict|retryable|rejected (rejected disjoint from retryable)', () => {
    expectTypeOf<ChangeOutcome['kind']>().toEqualTypeOf<'accepted' | 'conflict' | 'retryable' | 'rejected'>()
  })

  it('accepted ALWAYS carries a required server cursor (no cursor-less accepted = no false success)', () => {
    type Accepted = Extract<ChangeOutcome, { kind: 'accepted' }>
    expectTypeOf<keyof Accepted>().toEqualTypeOf<'kind' | 'cursor'>()
    expectTypeOf<Accepted['cursor']>().toEqualTypeOf<SnapshotCursor>()
  })

  it('RejectionReason is a closed domain enum (no HTTP number / Yjs frame in the port type)', () => {
    expectTypeOf<RejectionReason>().toEqualTypeOf<
      | 'unauthorized'
      | 'forbidden'
      | 'not-found'
      | 'too-large'
      | 'reuse-conflict'
      | 'bad-request'
      | 'terminal'
    >()
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

  it('rejects submitChange with edit-node field-intent kind (not-wired, no silent success)', async () => {
    // 返修 F1:edit-node 走占位也 fail visibly(防误以为已接线)。
    await expect(
      unwiredCanvasSyncPort.submitChange('c1', {
        kind: 'edit-node',
        nodeId: 'n1',
        intents: [{ op: 'set', fieldPath: ['title'], value: 'x' }],
      }),
    ).rejects.toThrow(/not wired/)
  })

  it('rejects subscribe with not-wired error', async () => {
    await expect(unwiredCanvasSyncPort.subscribe('c1', () => {})).rejects.toThrow(/not wired/)
  })
})
