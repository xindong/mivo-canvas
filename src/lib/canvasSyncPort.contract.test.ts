// src/lib/canvasSyncPort.contract.test.ts
// G1-b port 形状编译期 + 运行期约束(transport-neutral 自证 + 返修 F1/F3 契约测试 + R2-P1-1/2/3)。
//
// 自证逻辑(对应计划 §4 G1-b 验收"N2-0 前生产代码无某候选独占的画布 transport DTO"):
// 用 @ts-expect-error 证明 CanvasChange/FieldIntent/SnapshotCursor/RejectionReason 不收候选独占形状
// (Y.Update / JSON-Patch ops / 裸 revision / 裸 state-vector array / 裸 HTTP 码 / RFC6902 op)。
// 负向类型互锁惯例同 serverPersistAdapter.contract.test.ts(F5 baseContentVersion 必填互锁)。
// 运行时也验占位实现 fail visibly(与 unwiredServerPersistAdapter 同型,防误以为已同步)。
//
// 返修 R1(G1-b 双审 REQUIRES_CHANGES,2026-07-12):
//  - F1 契约:field-intent 无损——同 record 不同字段并发两边都留、未编辑字段不被提交、嵌套叶子不整树替换、reorder 有意图。
//  - F3 契约:终态拒绝 outcome 映射(401/403/revoke/400/413/422→rejected;409→conflict;5xx/408/429→retryable;200→accepted),
//    无终态误重试、无假成功(accepted 必携服务端 cursor)。
//
// 返修 R2(G1-b 第二轮 REQUIRES_CHANGES,2026-07-12,见 REVIEW-FINDINGS-G1B-R2.md):
//  - R2-P1-1 封死 clobber:FieldPath 非空 tuple(空路径编译期拒)+ validateFieldIntent 拒非原子 set(整对象/整数组 clobber 封死)
//    + A→B/B→A 双向对称。真实 Y.Doc 验证放 spike 侧(yjs-mapping.spike.test.ts,保 yjs 不进生产 bundle)。
//  - R2-P1-2 create→edit 因果:per-record FIFO hold 契约——pending create ack 前 hold 同 record edit/delete,
//    edit 不独立 404;create 终态失败→依赖 edit rejected(dependency-failed,非 not-found);真·不存在 record edit→not-found(边界分开)。
//  - R2-P1-3 404-delete cursor:204/404 缺 cursor 不构造 accepted(防常量冒充);经 loadSnapshot authoritative load 取真实 cursor 后才 accepted;
//    load 返 null(canvas 不存在/无权)→ rejected(forbidden),不误报成功。

import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  CanvasChange,
  CanvasSyncPort,
  ChangeOutcome,
  FieldIntent,
  FieldPath,
  FieldPathTarget,
  FieldSchemaClassifier,
  RejectionReason,
  SnapshotCursor,
} from './canvasSyncPort'
import {
  FieldIntentError,
  unwiredCanvasSyncPort,
  validateFieldIntent,
} from './canvasSyncPort'

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

  // 返修 R2-P1-1:FieldPath 是非空 tuple——空路径 [] 编译期即拒(空路径无定位叶子 = 整 record clobber 的合法重表达,封死)。
  it('R2-P1-1: FieldPath is a NON-EMPTY tuple (empty path rejected at compile time)', () => {
    expectTypeOf<FieldPath>().toEqualTypeOf<readonly [string | number, ...(string | number)[]]>()
    // 多段合法
    const multi: FieldPath = ['fills', 0, 'color']
    expect(multi).toHaveLength(3)
    // 空 [] 编译期拒(下面 @ts-expect-error 钉死)
    // @ts-expect-error 空 fieldPath 不满足非空 tuple 至少 1 段——封死空路径 clobber 表达
    const _empty: FieldPath = []
    void _empty
  })

  it('R2-P1-1: validateFieldIntent + FieldIntentError are exported (domain rule frozen at port)', () => {
    expectTypeOf<typeof validateFieldIntent>().toBeFunction()
    expectTypeOf<FieldIntentError>().toHaveProperty('violation')
    // 返修 R3-P1-1:violation 枚举从 2 key 扩到 5(加 schema-aware 三类:数组元素结构删 / 容器删 / 原子值写容器)。
    expectTypeOf<FieldIntentError['violation']>().toEqualTypeOf<
      | 'empty-field-path'
      | 'non-atomic-parent-set'
      | 'array-element-structure-delete'
      | 'container-delete-field'
      | 'atomic-value-to-container-path'
    >()
    // runtime smoke:非原子 set 抛 FieldIntentError(封死 clobber 表达)
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform'], value: { x: 1 } })).toThrow(FieldIntentError)
  })

  it('R3-P1-1: FieldPathTarget + FieldSchemaClassifier are exported (schema-aware contract surface)', () => {
    // port 对 schema 不透明(FieldIntent.value:unknown),但 validator 可选接受调用方提供的 classifier。
    expectTypeOf<FieldPathTarget>().toEqualTypeOf<'leaf' | 'container' | 'array-element'>()
    expectTypeOf<FieldSchemaClassifier>().toEqualTypeOf<(fieldPath: FieldPath) => FieldPathTarget>()
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
  // 返修 R2-P1-1:apply 前先逐条过 validateFieldIntent(封死 clobber——非原子 set 在此即抛,不进 wire)。
  const applyFieldIntents = <R extends Record<string, unknown>>(base: R, intents: FieldIntent[]): R => {
    for (const intent of intents) validateFieldIntent(intent) // 域级 validator 先校验(封死 clobber)
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

  // ── 返修 R2-P1-1:封死 clobber 负例 + A→B/B→A 双向对称 ──────────────────
  it('R2-P1-1 NEGATIVE: validator rejects empty fieldPath (runtime defense for as-cast bypass)', () => {
    // tuple 编译期已拒空路径;validator 再兜运行时 as 旁路(防 as unknown as FieldIntent 强构造空路径)。
    const empty = { op: 'set', fieldPath: [] as unknown as FieldPath, value: 1 } as FieldIntent
    expect(() => validateFieldIntent(empty)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent(empty)).toThrow(/empty-field-path/)
  })

  it('R2-P1-1 NEGATIVE: set whole OBJECT at parent path is rejected (clobber sealed)', () => {
    // 首审 clobber 可经 {set,['transform'],整对象} 合法重表达——validator 拒非原子 set 封死。
    // 这是 spike 坑7(A 整 record/transform 重写吞 B 的 transform.y=999)在 field-intent 层的等价攻击面。
    const wholeObject: FieldIntent = {
      op: 'set',
      fieldPath: ['transform'],
      value: { x: 1, y: 2, width: 3, height: 4, rotation: 0 },
    }
    expect(() => validateFieldIntent(wholeObject)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent(wholeObject)).toThrow(/non-atomic-parent-set/)
  })

  it('R2-P1-1 NEGATIVE: set whole ARRAY at parent path is rejected (Y.Array clobber sealed)', () => {
    // 整 fills 数组替换 = Y.Array 整树替换,并发下吞 peer 的 insert——与整对象 clobber 同质,一并封死。
    // 数组结构编辑(增/删元素)非 FieldIntent 表达,deferred to N2-0 §10.1;数组叶子编辑(['fills',0,'color'])仍支持。
    const wholeArray: FieldIntent = {
      op: 'set',
      fieldPath: ['fills'],
      value: [{ id: 'f1', color: '#000' }],
    }
    expect(() => validateFieldIntent(wholeArray)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent(wholeArray)).toThrow(/non-atomic-parent-set/)
  })

  it('R2-P1-1 NEGATIVE: set whole array ELEMENT (object) is rejected — must decompose to leaf sets', () => {
    // set ['fills',0] 整对象 = 整元素替换 = 整子树 clobber;须分解为 ['fills',0,'color'] 等原子叶子 set。
    const wholeElement: FieldIntent = {
      op: 'set',
      fieldPath: ['fills', 0],
      value: { id: 'f1', color: '#f00' },
    }
    expect(() => validateFieldIntent(wholeElement)).toThrow(/non-atomic-parent-set/)
  })

  it('R2-P1-1 POSITIVE: atomic leaf sets + delete-field pass validator', () => {
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform', 'x'], value: 100 })).not.toThrow()
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['title'], value: 'n' })).not.toThrow()
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['fills', 0, 'color'], value: '#f00' })).not.toThrow()
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['locked'], value: false })).not.toThrow()
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['meta', 'x'], value: null })).not.toThrow() // null 是原子叶子
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['title'] })).not.toThrow()
  })

  it('R2-P1-1 SYMMETRY: A→B and B→A converge to same merged state for non-overlapping fields', () => {
    // 并发无交叠字段时,合并结果与 apply 顺序无关(交换律)——CRDT 收敛性的域语义投影。
    const base = { transform: { x: 0, y: 0 }, title: 'orig', locked: false }
    const a: FieldIntent[] = [
      { op: 'set', fieldPath: ['transform', 'x'], value: 100 },
      { op: 'set', fieldPath: ['title'], value: 'A' },
    ]
    const b: FieldIntent[] = [
      { op: 'set', fieldPath: ['transform', 'y'], value: 200 },
      { op: 'delete-field', fieldPath: ['locked'] },
    ]
    const ab = applyFieldIntents(applyFieldIntents(base, a), b) // A→B
    const ba = applyFieldIntents(applyFieldIntents(base, b), a) // B→A
    expect(ab).toEqual(ba) // 双向对称收敛
    expect(ab.transform.x).toBe(100) // A 的字段留
    expect(ab.transform.y).toBe(200) // B 的字段留
    expect(ab.title).toBe('A')
    expect('locked' in ab).toBe(false) // B 的 delete 生效
  })
})

// ── 返修 R3-P1-1:schema-aware leaf/container 分类(delete-field + 原子值-to-容器 封死)────
describe('R3-P1-1: schema-aware leaf/container classification (delete-field + atomic-to-container sealed)', () => {
  // 基于 NodeRecord schema 的测试 classifier(records.ts:64-107):
  //  container(对象): transform / relations / layout / constraints / asset / generation / aiWorkflow / annotationBounds / imageCrop / assetSourceDimensions
  //  container(数组): fills / strokes / effects / markupPoints / experimentalAnchors —— 数组字段本身是数组容器;[i] 是 array-element
  //  leaf(标量): id / type / title / revision / text / fontSize / locked / hidden / favorited / ... (optional 可 delete-field)
  // 与 n20 R2-4「数组按 有 stable-id / 无 stable-id / primitive 三类冻结意图」方向对齐(G1-b 只拒,不扩 op 面)。
  const nodeClassifier: FieldSchemaClassifier = (path) => {
    const seg0 = path[0]
    if (typeof seg0 === 'number') return 'array-element' // 防御(顶层不应是 number)
    const containers = ['transform', 'relations', 'layout', 'constraints', 'asset', 'generation', 'aiWorkflow', 'annotationBounds', 'imageCrop', 'assetSourceDimensions']
    const arrays = ['fills', 'strokes', 'effects', 'markupPoints', 'experimentalAnchors']
    const leaves = ['id', 'type', 'title', 'revision', 'text', 'fontSize', 'textColor', 'fontWeight', 'textAlign', 'textAutoWidth', 'markupKind', 'markupBrushKind', 'markupStampKind', 'markupCornerRadius', 'sectionTitleVisible', 'sectionLockMode', 'sectionTemplateId', 'markdownDisplayMode', 'imageHasTransparency', 'sourceNodeId', 'groupId', 'locked', 'hidden', 'favorited', 'markupStartArrow', 'markupEndArrow']
    if (arrays.includes(seg0)) {
      if (path.length === 1) return 'container' // 数组字段本身是数组容器(delete ['fills'] 拒)
      if (path.length === 2 && typeof path[1] === 'number') return 'array-element' // ['fills',0]
      return 'leaf' // ['fills',0,'color']
    }
    if (containers.includes(seg0)) {
      if (path.length === 1) return 'container' // ['transform']
      return 'leaf' // ['transform','x']
    }
    if (leaves.includes(seg0)) return 'leaf'
    return 'leaf' // 未知字段默认 leaf(port 对 schema 不透明,不拦未知)
  }

  it('R3-P1-1 NEGATIVE: delete-field on required container (transform) rejected (whole-subtree delete = clobber)', () => {
    // delete ['transform'] = 删整个 transform Y.Map = 吞并发子字段(transform.y=999),clobber 重表达;封死。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] }, nodeClassifier)).toThrow(/container-delete-field/)
  })

  it('R3-P1-1 NEGATIVE: delete-field on array root container (fills) rejected', () => {
    // delete ['fills'] = 删整个 fills Y.Array = 整子树删除 + 数组结构编辑 deferred;封死。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills'] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills'] }, nodeClassifier)).toThrow(/container-delete-field/)
  })

  it('R3-P1-1 NEGATIVE: delete-field on array element (fills[0]) rejected — unstable index, by-stable-id deferred', () => {
    // delete ['fills',0] 用不稳定 index 表达声称 deferred 的数组 remove,与 n20 §10.1 by-stable-id 方向岔开;封死。
    // 结构性拒(last segment number),无需 classifier;带 classifier 也一致拒。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills', 0] })).toThrow(/array-element-structure-delete/)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills', 0] }, nodeClassifier)).toThrow(/array-element-structure-delete/)
  })

  it('R3-P1-1 NEGATIVE: set atomic value at container path (set [transform]=7) rejected (whole-subtree replace)', () => {
    // set ['transform']=7 = 原子值覆盖整个 transform 容器 = 整子树替换重表达(坑7 的换名面);封死。
    // 注:R2 validator 只拦 set 非原子 value,原子值写容器路径(=7)放行 —— R3 finding 的核心洞。
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform'], value: 7 }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform'], value: 7 }, nodeClassifier)).toThrow(/atomic-value-to-container-path/)
  })

  it('R3-P1-1 NEGATIVE: set atomic value at array element (set [fills,0]=7) rejected — whole-element replace', () => {
    // set ['fills',0]=7 = 原子值覆盖整个元素位置 = 整元素替换重表达(断因果链);封死。
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['fills', 0], value: 7 }, nodeClassifier)).toThrow(/atomic-value-to-container-path/)
  })

  it('R3-P1-1 POSITIVE: delete-field on optional leaf (title/locked) passes with classifier', () => {
    // 合法 optional leaf delete 放行(title/locked 是 optional 叶子,删叶子不吞兄弟字段)。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['title'] }, nodeClassifier)).not.toThrow()
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['locked'] }, nodeClassifier)).not.toThrow()
  })

  it('R3-P1-1 POSITIVE: atomic leaf set at leaf path passes with classifier (transform.x / fills[0].color)', () => {
    // set ['transform','x']=100 / ['fills',0,'color']='#f00' 终点是 leaf,带 classifier 仍放行。
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform', 'x'], value: 100 }, nodeClassifier)).not.toThrow()
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['fills', 0, 'color'], value: '#f00' }, nodeClassifier)).not.toThrow()
  })

  it('R3-P1-1: without classifier, structural defense still rejects array-element delete-field + non-atomic set', () => {
    // 无 classifier(port 对 schema 不透明):只结构性拒——数组元素 delete-field(last number)+ 非原子 set。
    // container delete / 原子值-to-容器 无 schema 不拒(契约:调用方须传 classifier 才做 schema-aware 拒)。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills', 0] })).toThrow(/array-element-structure-delete/)
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform'], value: { x: 1 } })).toThrow(/non-atomic-parent-set/)
    // 无 classifier 时 container delete 不拒(port 不知是 container——契约:调用方传 classifier 才判 leaf/container)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] })).not.toThrow()
  })
})

// ── 返修 F3:终态拒绝 + 权威 accepted(契约证明)─────────────────────────
describe('F3: terminal rejections + authoritative accepted (no mis-retry, no false success)', () => {
  // 代表性 HTTP→ChangeOutcome 映射(未来 Figma 案 adapter 须实现)。
  // port 本身不定义 HTTP——此映射在 test/adapter 侧,证明 ChangeOutcome 类型能无损表达所有 transport 错误类别。
  // 先例:writeRetryQueue.classifyHttpStatus(src/lib/writeRetryQueue.ts:130-155)的 8 态 WriteOutcome → 此处映射到 port 的 4 态 ChangeOutcome。
  const CURSOR = 'rev-1' as unknown as SnapshotCursor
  const CURRENT = 'rev-2' as unknown as SnapshotCursor

  // 返修 R3-P1-3:删 isDelete+404→accepted(常量 CURSOR) 旧 shortcut(delete 路径走 mapDeleteOutcome,
  //   authoritative load 取真实 cursor;此 helper 只表非 delete 的 HTTP→outcome 映射,不再有 isDelete 旁路)。
  const mapHttpStatusToOutcome = (status: number): ChangeOutcome => {
    if (status >= 200 && status < 300) return { kind: 'accepted', cursor: CURSOR }
    if (status === 401) return { kind: 'rejected', reason: 'unauthorized' }
    if (status === 403) return { kind: 'rejected', reason: 'forbidden' }
    if (status === 404) return { kind: 'rejected', reason: 'not-found' }
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

  it('404 non-delete → rejected(not-found) (truly-unknown record edit/patch)', () => {
    // 真·不存在 record 的 edit → 404 → rejected(not-found)(与 pending-local-create 的 edit 区分,见 R2-P1-2 段)。
    const nonDel = mapHttpStatusToOutcome(404)
    expect(nonDel.kind).toBe('rejected')
    if (nonDel.kind === 'rejected') expect(nonDel.reason).toBe('not-found')
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
    // 返修 R2-P1-2:加 'dependency-failed'(create 终态失败时依赖 edit 的 surface,非 not-found)。
    expectTypeOf<RejectionReason>().toEqualTypeOf<
      | 'unauthorized'
      | 'forbidden'
      | 'not-found'
      | 'too-large'
      | 'reuse-conflict'
      | 'bad-request'
      | 'dependency-failed'
      | 'terminal'
    >()
  })

  // ── 返修 R2-P1-3:404-delete cursor 不冒充(authoritative load 方案)────────
  // 真实 DELETE 204(null body)/已删 404 均不带 cursor/seq(server/routes/canvas.ts deleteChild lead 核证);
  // 404 还可能是 canvas 不存在/无权(authz.denyStatus 404 隐藏存在性,server/lib/authz.ts)。
  // 故 delete-* accepted 必经 loadSnapshot authoritative load 取真实 cursor;缺 cursor 的 204/404 不构造 accepted。
  const SERVER_SEQ_42 = 'server-seq-42' as unknown as SnapshotCursor
  const SERVER_SEQ_43 = 'server-seq-43' as unknown as SnapshotCursor

  type LoadResult = { cursor: SnapshotCursor; recordPresent: boolean } | null

  // delete 流程:delete(status) → 若无 cursor,adapter 须做 loadSnapshot authoritative load → 据 load 结果构造 outcome。
  // 返修 R3-P1-3:204/404 + recordPresent 一律 conflict(旧实现只挡 404+present,204+present 落 accepted 假成功);
  //   冻结冲突恢复责任:conflict 时 caller 须重删(adapter 不自动重删)或 load/rebase 后再决策(见下方"重建后重删收敛"测试)。
  const mapDeleteOutcome = (status: number, load: LoadResult): ChangeOutcome => {
    if (load === null) {
      // 无 authoritative cursor:404+null-load = canvas 不存在/无权(authz.denyStatus 404)→ rejected(forbidden);
      // 204+null-load = delete 已成功但 cursor 暂不可得 → retryable(re-load 取 cursor)。**两者皆非 accepted**(无法冒充 cursor)。
      if (status === 404) return { kind: 'rejected', reason: 'forbidden' }
      return { kind: 'retryable', reason: 'cursor-pending-authoritative-load' }
    }
    if (load.recordPresent) {
      // record 仍在 = 并发重建 race → conflict(无论 204 还是 404);delete 目标态未达成,不 accepted。
      // R3-P1-3:旧实现只挡 404+present,204+present 落 accepted 假成功——现一律 conflict(防 204 race 假 accepted)。
      return { kind: 'conflict', currentCursor: load.cursor, diverging: [] }
    }
    // record 已不在 = delete 目标态达成 → accepted,携**真实 load 来的 cursor**(非常量冒充)。
    return { kind: 'accepted', cursor: load.cursor }
  }

  it('R2-P1-3: 204/404 delete WITHOUT authoritative cursor → NOT accepted (cannot fabricate cursor)', () => {
    // 缺 cursor 的 204/404 无法构造 accepted——防测试 helper 用常量 cursor 冒充权威(首审 bug)。
    const del204NoCursor = mapDeleteOutcome(204, null)
    const del404NoCursor = mapDeleteOutcome(404, null)
    expect(del204NoCursor.kind).not.toBe('accepted')
    expect(del404NoCursor.kind).not.toBe('accepted')
  })

  it('R2-P1-3: 204 delete + authoritative load → accepted with REAL server cursor (not a constant)', () => {
    const del = mapDeleteOutcome(204, { cursor: SERVER_SEQ_42, recordPresent: false })
    expect(del.kind).toBe('accepted')
    if (del.kind === 'accepted') expect(del.cursor).toBe(SERVER_SEQ_42) // 真实 load 的 cursor,非常量
  })

  it('R2-P1-3: idempotent delete — 404 + load confirms record gone → accepted with real cursor (delete-vs-update: delete wins)', () => {
    // N2-0 §10.4:delete-vs-update → delete wins;已删再 delete 返 404 → 经 load 确认 record 不在 → accepted(幂等,目标态达成)。
    const del = mapDeleteOutcome(404, { cursor: SERVER_SEQ_43, recordPresent: false })
    expect(del.kind).toBe('accepted')
    if (del.kind === 'accepted') expect(del.cursor).toBe(SERVER_SEQ_43) // 真实 cursor,非冒充
  })

  it('R2-P1-3: unknown canvas / no permission (404 + load returns null) → rejected(forbidden), NOT false success', () => {
    // 404 可能是 canvas 不存在/无权(authz.denyStatus 404 隐藏存在性)——load 返 null 证 canvas 不可达 → 不误报 accepted。
    const del = mapDeleteOutcome(404, null)
    expect(del.kind).toBe('rejected')
    if (del.kind === 'rejected') expect(del.reason).toBe('forbidden')
    expect(del.kind).not.toBe('accepted') // 不误报成功
  })

  it('R2-P1-3: 404 + load sees record still present → conflict (race: record reappeared concurrently)', () => {
    // 404 但 authoritative load 见 record 仍在 → 并发 race(record 被他端重建)→ conflict,非假 accepted。
    const del = mapDeleteOutcome(404, { cursor: SERVER_SEQ_42, recordPresent: true })
    expect(del.kind).toBe('conflict')
    if (del.kind === 'conflict') expect(del.currentCursor).toBe(SERVER_SEQ_42)
  })

  it('R3-P1-3: 204 + load sees record still present → conflict (NOT false accepted — old bug)', () => {
    // 旧实现只挡 404+present,204+present 落 accepted 假成功(204 后 load 又见 record → 旧走最后 return accepted);
    // R3:一律 recordPresent→conflict(204 race 同 404 race 处理),防 204 race 假 accepted。
    const del = mapDeleteOutcome(204, { cursor: SERVER_SEQ_42, recordPresent: true })
    expect(del.kind).toBe('conflict')
    if (del.kind === 'conflict') expect(del.currentCursor).toBe(SERVER_SEQ_42)
    expect(del.kind).not.toBe('accepted') // 不假 accepted(旧 bug:204+present 落 accepted)
  })

  it('R3-P1-3: 重建后重删收敛 — delete race conflict → re-delete → load confirms gone → accepted (conflict recovery)', () => {
    // 冻结冲突恢复责任:conflict 时 caller 须重删(adapter 不自动重删)或 load/rebase;重删后 load 确认 record 不在 → accepted 收敛。
    // 场景:删 n1 → 404 race(record 被并发重建)→ conflict;caller 据 conflict 重删 → 204 + load 确认不在 → accepted(真实 cursor)。
    const raceConflict = mapDeleteOutcome(404, { cursor: SERVER_SEQ_42, recordPresent: true })
    expect(raceConflict.kind).toBe('conflict') // 第一轮:race → conflict(非假 accepted)
    // caller 据 conflict 重删(冲突恢复责任在 caller,非 adapter 自动):
    const reDelete = mapDeleteOutcome(204, { cursor: SERVER_SEQ_43, recordPresent: false })
    expect(reDelete.kind).toBe('accepted') // 第二轮:重删后 record 已不在 → accepted 收敛
    if (reDelete.kind === 'accepted') expect(reDelete.cursor).toBe(SERVER_SEQ_43) // 真实 load cursor,非常量冒充
  })
})

// ── 返修 R2-P1-2:create→edit 同 record 因果(per-record FIFO hold 契约)──────────
describe('R2-P1-2: per-record FIFO causality (pending create holds same-record edit/delete)', () => {
  // 参考 impl(port 冻结的因果契约的可实现性证明,同 applyFieldIntents 的参考性质):
  // submitChange(create-*) pending 期间,同 recordId 的 edit-*/delete-* 被 hold(不独立提交 → 不独立 404)。
  // create ack 后按序 flush;create 终态失败 → 依赖 edit/delete surface rejected(dependency-failed,非 not-found)。
  // 真·不存在 record(无 pending create)的 edit → 直接提交 → rejected(not-found)(与 pending-create 边界分开)。

  const recordIdOf = (c: CanvasChange): string | null => {
    if ('nodeId' in c) return c.nodeId
    if ('edgeId' in c) return c.edgeId
    if ('anchorId' in c) return c.anchorId
    if ('node' in c) return c.node.id
    if ('edge' in c) return c.edge.id
    if ('anchor' in c) return c.anchor.id
    return null
  }
  const isCreateKind = (c: CanvasChange): boolean => c.kind.startsWith('create-')

  // transport: 记录提交序;create(默认)把 rid 加入 known 并 accepted;rejectCreates 时 create→rejected(bad-request)且 rid 不入 known;
  // edit/delete 命中 known→accepted,未知→404 not-found。
  const makeTransport = (opts: { rejectCreates?: boolean } = {}) => {
    const known = new Set<string>()
    const log: CanvasChange[] = []
    const transport = (c: CanvasChange): ChangeOutcome => {
      log.push(c)
      const rid = recordIdOf(c)
      if (rid && isCreateKind(c)) {
        if (opts.rejectCreates) return { kind: 'rejected', reason: 'bad-request' }
        known.add(rid)
        return { kind: 'accepted', cursor: 'create-seq' as unknown as SnapshotCursor }
      }
      if (rid && known.has(rid)) return { kind: 'accepted', cursor: 'edit-seq' as unknown as SnapshotCursor }
      return { kind: 'rejected', reason: 'not-found' }
    }
    return { transport, log }
  }

  // port: per-record FIFO hold。create 期间 pendingRid=rid;同 rid 的 edit/delete 入 held(不提交 transport);
  // ackCreate 由 transport 决定 create outcome,再 flush held(accepted→提交,record 已 known 不 404;rejected→dependency-failed)。
  class FifoRecordPort {
    private readonly transport: (c: CanvasChange) => ChangeOutcome
    private pendingCreate: CanvasChange | null = null
    private pendingRid: string | null = null
    private readonly held: CanvasChange[] = []
    constructor(transport: (c: CanvasChange) => ChangeOutcome) {
      this.transport = transport
    }
    submit(c: CanvasChange): ChangeOutcome | 'held' {
      const rid = recordIdOf(c)
      if (rid && isCreateKind(c)) {
        this.pendingCreate = c
        this.pendingRid = rid
        return 'held' // create in-flight;outcome at ackCreate(transport 决定)
      }
      if (rid && this.pendingRid === rid) {
        this.held.push(c) // held——**不**独立提交 transport(故不独立 404)
        return 'held'
      }
      return this.transport(c) // 无 pending create → 直送(truly-unknown → 404)
    }
    ackCreate(): { create: ChangeOutcome; held: ChangeOutcome[] } {
      const create = this.pendingCreate!
      const createOutcome = this.transport(create) // transport 决定 create outcome(accepted→rid known / rejected→rid 未 known)
      const heldOutcomes = this.held.map((c) =>
        createOutcome.kind === 'accepted'
          ? this.transport(c) // create 成功 → rid 已 known → edit accepted(非 404)
          : ({
              kind: 'rejected',
              reason: 'dependency-failed',
              detail: `create ${createOutcome.kind}`,
            } as ChangeOutcome),
      )
      this.pendingCreate = null
      this.pendingRid = null
      this.held.length = 0
      return { create: createOutcome, held: heldOutcomes }
    }
  }

  // unwrap: submit 返回 'held'|ChangeOutcome;直送场景(无 pending create)断言非 held 并拿到 ChangeOutcome。
  const unwrap = (r: ChangeOutcome | 'held'): ChangeOutcome => {
    if (r === 'held') throw new Error('expected direct outcome, got held')
    return r
  }

  // 测试 mock changes:node 是部分对象,用 `as unknown as CanvasChange` 旁路 record schema(port 契约测试只验调度,不验 record 字段)。
  const mockCreate = (rid: string): CanvasChange =>
    ({ kind: 'create-node', node: { id: rid } }) as unknown as CanvasChange
  const mockEdit = (rid: string): CanvasChange =>
    ({ kind: 'edit-node', nodeId: rid, intents: [{ op: 'set', fieldPath: ['title'], value: 'edited' }] }) as unknown as CanvasChange

  it('edit submitted while create pending is HELD; transport sees create FIRST, edit never 404', () => {
    // 验收:mock 让 edit 可"先发"(submit 调用序 edit 在 create 后但 create 未 ack),adapter 仍先 create 后 edit,
    // 最终 record=初值+编辑,edit 不因"record 尚未落库"独立 404。
    const t = makeTransport()
    const port = new FifoRecordPort(t.transport)
    expect(port.submit(mockCreate('n1'))).toBe('held') // create pending
    expect(port.submit(mockEdit('n1'))).toBe('held') // edit held——transport 此刻未见 edit
    expect(t.log).toEqual([]) // transport 未见任何(create 在 ackCreate 才提交)
    const { create: createOut, held: [editOut] } = port.ackCreate()
    expect(t.log).toEqual([mockCreate('n1'), mockEdit('n1')]) // create 先、edit 后(transport 提交序)
    expect(createOut.kind).toBe('accepted')
    expect(editOut.kind).toBe('accepted') // edit 提交时 rid 已 known → accepted(非 not-found)
    expect(editOut.kind).not.toBe('rejected') // 绝不因 pending-create 走 not-found
  })

  it('create terminally fails → dependent edit rejected(dependency-failed), NOT not-found', () => {
    // create 失败(如 bad-request)→ 依赖 edit 不能进行;surface 为 dependency-failed(非 not-found)。
    const t = makeTransport({ rejectCreates: true })
    const port = new FifoRecordPort(t.transport)
    expect(port.submit(mockCreate('n2'))).toBe('held')
    expect(port.submit(mockEdit('n2'))).toBe('held')
    const { create: createOut, held: [editOut] } = port.ackCreate()
    expect(createOut.kind).toBe('rejected') // create 自身 bad-request
    if (createOut.kind === 'rejected') expect(createOut.reason).toBe('bad-request')
    expect(editOut.kind).toBe('rejected')
    if (editOut.kind === 'rejected') {
      expect(editOut.reason).toBe('dependency-failed') // 非 not-found
      expect(editOut.reason).not.toBe('not-found')
      expect(editOut.detail).toContain('create')
    }
    expect(t.log).toEqual([mockCreate('n2')]) // edit 未进 transport(依赖失败,未提交)
  })

  it('truly-unknown record edit (no pending create) → rejected(not-found) — boundary distinct from pending-create', () => {
    // 验收:从未存在 vs pending-create 两种 404 边界分开断言。此为"从未存在"——直接 404 not-found。
    const t = makeTransport()
    const port = new FifoRecordPort(t.transport)
    const out = unwrap(port.submit(mockEdit('ghost')))
    expect(out.kind).toBe('rejected')
    if (out.kind === 'rejected') expect(out.reason).toBe('not-found')
    expect(t.log).toEqual([mockEdit('ghost')]) // 直送 transport,record 未知 → 404
  })

  it('multiple held edits flush in FIFO call order after create accepted', () => {
    // FIFO:同 record 多条 edit 按 submit 序 flush(create ack 后顺序保持)。
    const t = makeTransport()
    const port = new FifoRecordPort(t.transport)
    const e1 = mockEdit('n3')
    const edit2 = { kind: 'edit-node', nodeId: 'n3', intents: [{ op: 'set', fieldPath: ['title'], value: '2' }] } as unknown as CanvasChange
    expect(port.submit(mockCreate('n3'))).toBe('held')
    expect(port.submit(e1)).toBe('held')
    expect(port.submit(edit2)).toBe('held')
    port.ackCreate()
    // transport 提交序:create 先,然后 e1、edit2 按 submit 序(同引用——toBe Object.is 证 FIFO 序保持)
    expect(t.log.map((c) => (c.kind === 'create-node' ? 'create' : 'edit'))).toEqual(['create', 'edit', 'edit'])
    expect(t.log[1]).toBe(e1) // 第一条 flush 的 edit 是先 submit 的(同对象引用)
    expect(t.log[2]).toBe(edit2) // 第二条 flush 的是后 submit 的(FIFO 序保持)
  })

  it('different recordId edit is NOT held by an unrelated pending create', () => {
    // pending create for n4 不 hold n5 的 edit(因果是 per-record,非全局阻塞)。
    const t = makeTransport()
    const port = new FifoRecordPort(t.transport)
    expect(port.submit(mockCreate('n4'))).toBe('held')
    const other = unwrap(port.submit(mockEdit('n5'))) // 异 record → 直送(但 n5 未知 → 404)
    expect(other.kind).toBe('rejected')
    if (other.kind === 'rejected') expect(other.reason).toBe('not-found') // n5 从未存在 → not-found(非 held)
    expect(t.log).toEqual([mockEdit('n5')]) // n5 edit 直送 transport
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
