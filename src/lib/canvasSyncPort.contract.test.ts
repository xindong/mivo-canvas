// src/lib/canvasSyncPort.contract.test.ts
// G1-b port 形状编译期 + 运行期约束(transport-neutral 自证 + 返修 F1/F3 契约测试 + R2-P1-1/2/3 + R3-P1-1/2/3)。
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
//
// 返修 R3(G1-b 第三轮 REQUIRES_CHANGES,2026-07-12,见 REVIEW-FINDINGS-G1B-R3.md,lead+sol7 共识):
//  - R3-P1-1 schema-aware 容器/数组封死:validateFieldIntent 加可选 FieldSchemaClassifier,拒 delete-field 到
//    container、set 原子值到 container/array-element 路径;结构性拒数组元素 delete-field(last number,无需 schema)。
//    新增 FieldPathTarget/FieldSchemaClassifier 类型;FieldIntentViolation 枚举 2→5 key;+7 负例/正例 + spike 真 Y.Doc 并发危害证。
//  - R3-P1-2 retryable/conflict 所有权 + per-key 状态机:FifoRecordPort 参考 impl 改 per-(canvasId,recordId) Map
//    (旧单槽并发第二 create 覆盖第一)+ submit/ackCreate 带 canvasId(异 canvas 同 recordId 不碰撞)+ 仅终态 rejected
//    → dependency-failed 清队列(conflict/retryable 非终态 → held 继续等,caller owns retry/rebase)。+8 矩阵测试
//    (conflict/retryable 保持、retryable→rejected 放弃、并发第二 create 不 clobber、异 canvas 不碰撞、多 pending、
//    duplicate create 直送、终态 record state 断言非仅 transport log)。
//  - R3-P1-3 delete race 全封:mapDeleteOutcome 一律 recordPresent→conflict(旧只挡 404+present,204+present 落 accepted
//    假成功);删 mapHttpStatusToOutcome 的 isDelete+404→accepted 旧 shortcut;冻结冲突恢复责任在 caller。+2 测试。
//
// 返修 R4(G1-b 第四轮 REQUIRES_CHANGES,2026-07-12,2 条 P1 见 REVIEW-FINDINGS-G1B-R4.md,lead 复审判决):
//  - R4-P1-1 schema classifier 必填(安全入口不可静默降级):R3 可选 classifier 让省略时四负例原漏洞原样通过
//    (旧 line 388 钉死 not.toThrow)。R4:validateFieldIntent classifier 改必填(编译期 + 运行时双重不可绕过);
//    结构性校验拆到显式命名的低层 validateFieldIntentStructural(非安全入口,不拒 schema-aware clobber)。
//    删 line 388 bug 断言;+5 R4 测试(四负例经安全入口必拒 / classifier-bypass 抛错 / structural 低层不拒 clobber / optional leaf + 数组 leaf set 放行)。
//  - R4-P1-2 caller-owned retry/rebase 经公开 submitChange 闭环:R3 sync submit/ackCreate 重发旧 create(adapter 自动重试 stale);
//    R4 改 FifoRecordPort async submitChange(canvasId, change, base?) 同形参考:phase 区分 retry(推进 pending)/duplicate(直送);
//    base 透传 transport 区分 old/new base;held edit 在 create 终态才 settle;删 ackCreate。+矩阵测试改写。

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
  validateFieldIntentStructural,
} from './canvasSyncPort'
// F2-ter(T2.2 Block 2 五轮):消灭手写 nodeClassifier,改用 shared classifyFieldPathBySchema(单一真相源)。
import { classifyFieldPathBySchema } from '../../shared/persist-contract.ts'

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
    // runtime smoke:非原子 set 抛 FieldIntentError(封死 clobber 表达)。
    // R4:结构性校验走 validateFieldIntentStructural(非原子 set 是结构性规则,无需 schema classifier)。
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['transform'], value: { x: 1 } })).toThrow(FieldIntentError)
  })

  it('R3-P1-1: FieldPathTarget + FieldSchemaClassifier are exported (schema-aware contract surface)', () => {
    // port 对 schema 不透明(FieldIntent.value:unknown),但 validator 可选接受调用方提供的 classifier。
    expectTypeOf<FieldPathTarget>().toEqualTypeOf<'leaf' | 'container' | 'array-element' | 'array-field'>()
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
  // 返修 R4-P1-1:F1 参考 apply 用叶子 op(无 schema-aware clobber 面),走低层 validateFieldIntentStructural
  //   (结构性:非原子 set / 空路径 / 数组元素 delete 在此即抛);安全入口 validateFieldIntent 需 classifier,见 R4 段。
  const applyFieldIntents = <R extends Record<string, unknown>>(base: R, intents: FieldIntent[]): R => {
    for (const intent of intents) validateFieldIntentStructural(intent) // 结构性 validator 先校验(封死 clobber)
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
  // R4:这些是结构性规则(空路径/非原子 set——不依赖 schema),走低层 validateFieldIntentStructural;
  //   schema-aware 负例(container-delete/atomic-to-container)见 R3/R4 段(带 nodeClassifier)。
  it('R2-P1-1 NEGATIVE: validator rejects empty fieldPath (runtime defense for as-cast bypass)', () => {
    // tuple 编译期已拒空路径;validator 再兜运行时 as 旁路(防 as unknown as FieldIntent 强构造空路径)。
    const empty = { op: 'set', fieldPath: [] as unknown as FieldPath, value: 1 } as FieldIntent
    expect(() => validateFieldIntentStructural(empty)).toThrow(FieldIntentError)
    expect(() => validateFieldIntentStructural(empty)).toThrow(/empty-field-path/)
  })

  it('R2-P1-1 NEGATIVE: set whole OBJECT at parent path is rejected (clobber sealed)', () => {
    // 首审 clobber 可经 {set,['transform'],整对象} 合法重表达——validator 拒非原子 set 封死。
    // 这是 spike 坑7(A 整 record/transform 重写吞 B 的 transform.y=999)在 field-intent 层的等价攻击面。
    const wholeObject: FieldIntent = {
      op: 'set',
      fieldPath: ['transform'],
      value: { x: 1, y: 2, width: 3, height: 4, rotation: 0 },
    }
    expect(() => validateFieldIntentStructural(wholeObject)).toThrow(FieldIntentError)
    expect(() => validateFieldIntentStructural(wholeObject)).toThrow(/non-atomic-parent-set/)
  })

  it('R2-P1-1 NEGATIVE: set whole ARRAY at parent path is rejected (Y.Array clobber sealed)', () => {
    // 整 fills 数组替换 = Y.Array 整树替换,并发下吞 peer 的 insert——与整对象 clobber 同质,一并封死。
    // 数组结构编辑(增/删元素)非 FieldIntent 表达,deferred to N2-0 §10.1;数组叶子编辑(['fills',0,'color'])仍支持。
    const wholeArray: FieldIntent = {
      op: 'set',
      fieldPath: ['fills'],
      value: [{ id: 'f1', color: '#000' }],
    }
    expect(() => validateFieldIntentStructural(wholeArray)).toThrow(FieldIntentError)
    expect(() => validateFieldIntentStructural(wholeArray)).toThrow(/non-atomic-parent-set/)
  })

  it('R2-P1-1 NEGATIVE: set whole array ELEMENT (object) is rejected — must decompose to leaf sets', () => {
    // set ['fills',0] 整对象 = 整元素替换 = 整子树 clobber;须分解为 ['fills',0,'color'] 等原子叶子 set。
    const wholeElement: FieldIntent = {
      op: 'set',
      fieldPath: ['fills', 0],
      value: { id: 'f1', color: '#f00' },
    }
    expect(() => validateFieldIntentStructural(wholeElement)).toThrow(/non-atomic-parent-set/)
  })

  it('R2-P1-1 POSITIVE: atomic leaf sets + delete-field pass validator', () => {
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['transform', 'x'], value: 100 })).not.toThrow()
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['title'], value: 'n' })).not.toThrow()
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['fills', 0, 'color'], value: '#f00' })).not.toThrow()
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['locked'], value: false })).not.toThrow()
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['meta', 'x'], value: null })).not.toThrow() // null 是原子叶子
    expect(() => validateFieldIntentStructural({ op: 'delete-field', fieldPath: ['title'] })).not.toThrow()
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
  // F2-ter(T2.2 Block 2 五轮):消灭手写 nodeClassifier,改用 shared classifyFieldPathBySchema(单一真相源,与生产/transport 同实现)。
  //   行为差异(lead 裁定 P2-2):fills/strokes/effects(required 根数组)从旧 'array-field'(delete 放行)升 'container'
  //   (delete/set 都拒)——line 369 delete ['fills'] 由 POSITIVE 翻 NEGATIVE(见下)。其余断言(transform container /
  //   aiWorkflow.sourceNodeIds array-field / fills[0] array-element / optional leaf delete)行为一致。
  const nodeClassifier: FieldSchemaClassifier = (path) => classifyFieldPathBySchema('node', path)

  it('R3-P1-1 NEGATIVE: delete-field on required container (transform) rejected (whole-subtree delete = clobber)', () => {
    // delete ['transform'] = 删整个 transform Y.Map = 吞并发子字段(transform.y=999),clobber 重表达;封死。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] }, nodeClassifier)).toThrow(/container-delete-field/)
  })

  // F2-ter(T2.2 Block 2 五轮):delete ['fills'] 翻 NEGATIVE——fills 是 required 根数组,schema classifier 返 'container'
  //   (非旧手写 'array-field');required 根数组不可整体删(整子树删 = clobber 重表达,与 transform 同质;server 侧
  //   validateChildPayload dam 兜底保证 payload 合法)。set ['fills'] 仍拒(下方 ③(B′) NEGATIVE regression);
  //   optional 数组 child(aiWorkflow.sourceNodeIds)delete 仍合法(下条 POSITIVE 不变)。
  it('③(B′) NEGATIVE (F2-ter flip): delete-field on required root array (fills) rejected — container-delete-field', () => {
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills'] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills'] }, nodeClassifier)).toThrow(/container-delete-field/)
  })

  it('③(B′) POSITIVE: delete-field on array child of container (aiWorkflow.sourceNodeIds) is legal', () => {
    // aiWorkflow(容器)含 sourceNodeIds(数组 child)无法整体删的契约缺口修复:数组 child → array-field → delete 合法。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['aiWorkflow', 'sourceNodeIds'] }, nodeClassifier)).not.toThrow()
  })

  it('③(B′) NEGATIVE regression: set whole array (fills) still rejected — clobber defense intact (line 277-285)', () => {
    // set ['fills']=[whole] = 整数组替换 = clobber 吞 peer insert,封死(③(B′) 仅开 delete 方向,set 维持)。
    // 非原子 value(structural non-atomic-parent-set)+ 原子值到数组路径(atomic-value-to-container-path)均拒。
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['fills'], value: [{ id: 'f1' }] })).toThrow(/non-atomic-parent-set/)
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['fills'], value: 'not-array' }, nodeClassifier)).toThrow(/atomic-value-to-container-path/)
  })

  it('R3-P1-1 NEGATIVE: delete-field on array element (fills[0]) rejected — unstable index, by-stable-id deferred', () => {
    // delete ['fills',0] 用不稳定 index 表达声称 deferred 的数组 remove,与 n20 §10.1 by-stable-id 方向岔开;封死。
    // 结构性拒(last segment number),无需 classifier;低层 validateFieldIntentStructural 与安全入口 validateFieldIntent(带 classifier)均一致拒。
    expect(() => validateFieldIntentStructural({ op: 'delete-field', fieldPath: ['fills', 0] })).toThrow(/array-element-structure-delete/)
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
    expect(() => validateFieldIntentStructural({ op: 'delete-field', fieldPath: ['fills', 0] })).toThrow(/array-element-structure-delete/)
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['transform'], value: { x: 1 } })).toThrow(/non-atomic-parent-set/)
    // structural 低层入口不拒 container delete(需 schema);安全入口 validateFieldIntent 才拒(见 R4)。
    expect(() => validateFieldIntentStructural({ op: 'delete-field', fieldPath: ['transform'] })).not.toThrow()
  })
})

// ── 返修 R4-P1-1:schema classifier 必填(安全入口不可静默降级)+ structural 拆分 ──────────
// R4 finding:R3 把 classifier 设为可选,导致省略 classifier 时 delete ['transform']/['fills']/set ['transform']=7
// 原漏洞原样通过(旧测试 line 388 甚至钉死 not.toThrow)。R4 让 schema 分类成为不可省略的校验前提:
//  - validateFieldIntent(intent, classify: FieldSchemaClassifier)classifier **必填** = 安全入口(结构 + schema-aware)。
//  - validateFieldIntentStructural(intent) = 低层结构校验(空路径/非原子 set/数组元素 delete);
//    显式命名 "Structural" 标明它**非安全入口**——不拒 schema-aware clobber(container/array-element 路径上 leaf op)。
// 验收:1) 四负例经安全入口(任何合法公开调用 = 带 classifier)必拒;2) 省略 classifier 编译期 + 运行时双重显式失败;
//       3) optional leaf delete + 数组 leaf set 继续放行。
describe('R4-P1-1: classifier REQUIRED + structural split (safe entry cannot silently degrade)', () => {
  // F2-ter(T2.2 Block 2 五轮):消灭手写 nodeClassifier,改用 shared classifyFieldPathBySchema(单一真相源,与 R3 同实现)。
  //   本 describe 四负例(delete ['transform']/['fills']/['fills',0]、set ['transform']=7)经 shared classifier 全拒
  //   (transform/fills=container,fills[0]=array-element);optional leaf delete + 数组 leaf set 放行不变。
  const nodeClassifier: FieldSchemaClassifier = (path) => classifyFieldPathBySchema('node', path)

  it('R4-P1-1 RED→GREEN: validateFieldIntentStructural exported (low-level structural, NOT a safe entry)', () => {
    // 拆分:结构性校验(空路径/非原子 set/数组元素 delete)独立成 validateFieldIntentStructural,单参 intent。
    // 显式命名 "Structural" 标明它非安全入口——不拒 schema-aware clobber(见下);安全入口 validateFieldIntent 才拒。
    expectTypeOf<typeof validateFieldIntentStructural>().toBeFunction()
    // 运行时 smoke:structural 入口存在且可调用(原子叶子 set 放行)。
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['transform', 'x'], value: 100 })).not.toThrow()
  })

  it('R4-P1-1 RED→GREEN: omitting classifier on safe entry FAILS (compile-time required + runtime defense)', () => {
    // 验收 2:省略 schema 校验显式失败。classifier 是必填参数(编译期:省略即 tsc error);
    // 运行时防御兜 `as` cast 旁路(undefined / 非函数)→ 显式抛错(安全入口永不静默降级到无 schema 校验)。
    // 与 empty-field-path 运行时防御(line 185)同型:tuple 类型可 as-cast 旁路,运行时再兜。
    expect(() =>
      validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] }, undefined as unknown as FieldSchemaClassifier),
    ).toThrow(/classifier/)
  })

  it('R4-P1-1: four clobber negatives rejected by SAFE ENTRY validateFieldIntent (with classifier)', () => {
    // 验收 1:四负例(任何合法公开调用 = 经安全入口 validateFieldIntent + classifier)必拒:
    //  delete ['transform'](container-delete-field)、delete ['fills'](container-delete-field)、
    //  delete ['fills',0](array-element-structure-delete)、set ['transform']=7(atomic-value-to-container-path)。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['transform'] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills'] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['fills', 0] }, nodeClassifier)).toThrow(FieldIntentError)
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['transform'], value: 7 }, nodeClassifier)).toThrow(FieldIntentError)
  })

  it('R4-P1-1: structural-only entry does NOT reject schema-aware clobber (low-level, explicitly not a safe entry)', () => {
    // validateFieldIntentStructural 只拒结构性(空路径/非原子 set/数组元素 delete);
    // container-delete / atomic-to-container 需 schema,structural 不拒(故非安全入口——调用方明示用 structural 即知无 schema 防线)。
    expect(() => validateFieldIntentStructural({ op: 'delete-field', fieldPath: ['transform'] })).not.toThrow()
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['transform'], value: 7 })).not.toThrow()
    // 但结构性三态仍拒(与安全入口一致):
    expect(() => validateFieldIntentStructural({ op: 'delete-field', fieldPath: ['fills', 0] })).toThrow(/array-element-structure-delete/)
    expect(() => validateFieldIntentStructural({ op: 'set', fieldPath: ['transform'], value: { x: 1 } })).toThrow(/non-atomic-parent-set/)
  })

  it('R4-P1-1: optional leaf delete + array leaf set still PASS at safe entry (with classifier)', () => {
    // 验收 3:合法 optional leaf delete 放行(title 是 optional 叶子);数组 leaf set 放行(['fills',0,'color'] 终点 leaf)。
    expect(() => validateFieldIntent({ op: 'delete-field', fieldPath: ['title'] }, nodeClassifier)).not.toThrow()
    expect(() => validateFieldIntent({ op: 'set', fieldPath: ['fills', 0, 'color'], value: '#f00' }, nodeClassifier)).not.toThrow()
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
    // PR-C1 CR-6:加 'archived'(archived canvas 写返 409 `{error:'archived'}`,与 revision-conflict 区分)。
    expectTypeOf<RejectionReason>().toEqualTypeOf<
      | 'unauthorized'
      | 'forbidden'
      | 'not-found'
      | 'too-large'
      | 'reuse-conflict'
      | 'bad-request'
      | 'dependency-failed'
      | 'archived'
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

// ── 返修 R2-P1-2 / R3-P1-2 / R4-P1-2:create→edit 同 record 因果(per-key FIFO hold + caller-owned retry/rebase)──
describe('R2-P1-2 / R3-P1-2 / R4-P1-2: per-key FIFO causality (async submitChange + caller-owned retry/rebase)', () => {
  // 参考 impl(port 冻结的因果契约的可实现性证明,同 applyFieldIntents 的参考性质):
  // submitChange(create-*) in-flight 期间,同 (canvasId,recordId) 的 edit-*/delete-* 被 hold(不独立提交 → 不独立 404)。
  // create 终态 accepted → 按序 flush held;create 终态 rejected → 依赖 edit/delete surface rejected(dependency-failed,非 not-found)。
  // 真·不存在 record(无 pending create)的 edit → 直接提交 → rejected(not-found)(与 pending-create 边界分开)。
  //
  // 返修 R3-P1-2(冻结 retryable/conflict 所有权 + per-key 状态机;3 bug 闭合):
  //   bug1 旧 ackCreate 把所有 non-accepted(含 conflict/retryable)统一 dependency-failed + 清队列,与 doc 矛盾
  //       → 改:仅终态 rejected → dependency-failed + 清 key;conflict/retryable(非终态)→ held 继续等(不清 key)。
  //   bug2 旧单槽 pendingCreate/pendingRid:并发第二 create 覆盖第一(丢 held)→ 改 per-(canvasId,recordId) Map。
  //   bug3 旧 submit 无 canvasId:异 canvas 同 recordId 碰撞 → 改 submit(canvasId, change)。
  //   所有权冻结:caller 拿到 create 的 conflict/retryable outcome 后 owns retry/rebase(caller 决定,非 adapter 自动);
  //   held edits 的 outcome 在 create 终态收敛后才 settle(accepted→flush / rejected→dependency-failed)。
  //
  // 返修 R4-P1-2(caller-owned retry/rebase 经公开 submitChange 闭环;2 bug 闭合,见 REVIEW-FINDINGS-G1B-R4.md):
  //   bug4 旧 ackCreate 重发**旧** entry.create(this.transport(entry.create))——adapter 自动重试 stale create,
  //       无 caller 提交 rebased create/new base 接管 pending entry 的路径。conflict→accepted 测试靠预编排 outcome
  //       队列假收敛(第二次"ack"返 accepted,但发的还是旧 create,未传新 base)。→ 改:async submitChange(canvasId, change, base?)
  //       同形参考:retry 经**公开 submitChange 入口**(同 key 再提交)推进 pending attempt,非 ackCreate 重发旧 create。
  //   bug5 旧 submit 对同 key 第二次 create 走 duplicate-create 直送,**不关联**原 held 队列;retryable/conflict 后
  //       无 caller 提交 rebased create 接管原 pending entry 的路径。→ 改:phase(in-flight vs awaiting-retry)区分
  //       retry(推进 pending attempt)与 duplicate(in-flight 期间并发,直送 transport);base 透传 transport 区分
  //       old/new base(旧 base 仍 conflict、新 base 才 accepted);held edit 在 create 终态才 settle。删 ackCreate。

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

  // async transport: 记录提交序 + base;known 按 `${canvasId}::${rid}` keying(异 canvas 同 rid 不碰撞 +
  //   同 canvas 同 rid duplicate 检测)。create outcome 决策:baseAware(base===acceptBase→accepted,否则 conflict)
  //   优先;次 createOutcomes 队列(按 rid,shift 一个/次,建模 conflict→accept / retryable→accept 收敛序列);
  //   再次 rejectCreates;默认 accepted(known.add)。duplicate create(known.has)→ reuse-conflict。edit 命中 known→accepted,未知→not-found。
  type AsyncTransport = (canvasId: string, c: CanvasChange, base?: SnapshotCursor) => Promise<ChangeOutcome>
  const makeAsyncTransport = (opts: {
    rejectCreates?: boolean
    createOutcomes?: Record<string, ChangeOutcome[]>
    baseAware?: { acceptBase: SnapshotCursor; conflictCursor: SnapshotCursor }
  } = {}): { transport: AsyncTransport; log: CanvasChange[]; bases: (SnapshotCursor | undefined)[] } => {
    const known = new Set<string>() // `${canvasId}::${rid}`
    const log: CanvasChange[] = []
    const bases: (SnapshotCursor | undefined)[] = []
    const queues: Record<string, ChangeOutcome[]> = Object.fromEntries(
      Object.entries(opts.createOutcomes ?? {}).map(([k, v]) => [k, [...v]]),
    )
    const transport: AsyncTransport = async (canvasId, c, base) => {
      log.push(c)
      bases.push(base)
      const rid = recordIdOf(c)
      const k = `${canvasId}::${rid}`
      if (rid && isCreateKind(c)) {
        if (known.has(k)) return { kind: 'rejected', reason: 'reuse-conflict' } // duplicate(同 canvas+rid 已创建)
        if (opts.baseAware) {
          if (base === opts.baseAware.acceptBase) {
            known.add(k)
            return { kind: 'accepted', cursor: 'create-seq' as unknown as SnapshotCursor }
          }
          // 旧 base / 无 base → conflict(告 caller rebase 到 conflictCursor)
          return { kind: 'conflict', currentCursor: opts.baseAware.conflictCursor, diverging: [] as CanvasChange[] }
        }
        const q = queues[rid]
        if (q && q.length > 0) {
          const o = q.shift() as ChangeOutcome
          if (o.kind === 'accepted') known.add(k)
          return o
        }
        if (opts.rejectCreates) return { kind: 'rejected', reason: 'bad-request' }
        known.add(k)
        return { kind: 'accepted', cursor: 'create-seq' as unknown as SnapshotCursor }
      }
      if (rid && known.has(k)) return { kind: 'accepted', cursor: 'edit-seq' as unknown as SnapshotCursor }
      return { kind: 'rejected', reason: 'not-found' }
    }
    return { transport, log, bases }
  }

  // port: per-(canvasId,recordId) async FIFO hold。create 期间该 key pending(phase in-flight);同 key 的
  //   edit/delete 入 held(不提交 transport,返 Promise,create 终态 settle 时 resolve)。
  //   retry:phase awaiting-retry(caller 拿 conflict/retryable 后)时,同 key 再 submitChange(create, base)→ 推进
  //     pending attempt(替换 create/base,phase→in-flight,重发 transport);非 duplicate shortcut。
  //   duplicate:phase in-flight(create 仍在途)时,同 key 再 submitChange(create)→ 直送 transport(reuse-conflict),
  //     不触碰 pending(第一个 attempt 的 held 保留)。phase 区分 retry vs duplicate = attempt identity/idempotency 语义。
  //   settleCreate:accepted→flush held(rid 已 known,非 not-found)+ 清 key;rejected→held dependency-failed + 清 key;
  //     conflict/retryable(非终态)→ held 继续等,phase→awaiting-retry,不清 key(caller retry 后再 settle)。
  class FifoRecordPort {
    private readonly transport: AsyncTransport
    private readonly pending = new Map<
      string,
      {
        phase: 'in-flight' | 'awaiting-retry'
        create: CanvasChange
        base?: SnapshotCursor
        held: Array<{ change: CanvasChange; resolve: (o: ChangeOutcome) => void }>
      }
    >()
    constructor(transport: AsyncTransport) {
      this.transport = transport
    }

    private keyOf(canvasId: string, rid: string): string {
      return `${canvasId}::${rid}`
    }

    async submitChange(canvasId: string, change: CanvasChange, base?: SnapshotCursor): Promise<ChangeOutcome> {
      const rid = recordIdOf(change)
      if (!rid) {
        // reorder/update-meta(无 rid)→ 直送
        return this.transport(canvasId, change, base)
      }
      const key = this.keyOf(canvasId, rid)
      if (isCreateKind(change)) {
        const existing = this.pending.get(key)
        if (existing) {
          if (existing.phase === 'in-flight') {
            // DUPLICATE:create 仍在途,caller 不知 pending attempt → 直送 transport(likely reuse-conflict 422);
            // 不触碰 pending(第一个 attempt 的 held 保留,不被 clobber)。
            return this.transport(canvasId, change, base)
          }
          // RETRY:phase awaiting-retry(caller 拿 conflict/retryable 后 owns retry/rebase)→ 推进 pending attempt:
          // 替换 create/base,phase→in-flight,重发 transport(含新 base)。经公开 submitChange 入口,非 ackCreate 重发旧 create。
          existing.phase = 'in-flight'
          existing.create = change
          existing.base = base
          const outcome = await this.transport(canvasId, change, base)
          return this.settleCreate(canvasId, rid, outcome)
        }
        // FIRST create → pending, in-flight
        const entry = {
          phase: 'in-flight' as const,
          create: change,
          base,
          held: [] as Array<{ change: CanvasChange; resolve: (o: ChangeOutcome) => void }>,
        }
        this.pending.set(key, entry)
        const outcome = await this.transport(canvasId, change, base)
        return this.settleCreate(canvasId, rid, outcome)
      }
      // edit/delete
      const entry = this.pending.get(key)
      if (entry) {
        // held:create pending(无论 in-flight / awaiting-retry)→ edit/delete 入 held,create 终态 settle 时 resolve。
        return new Promise<ChangeOutcome>((resolve) => {
          entry.held.push({ change, resolve })
        })
      }
      // 无 pending create → 直送(truly-unknown → 404 not-found)
      return this.transport(canvasId, change, base)
    }

    private async settleCreate(canvasId: string, rid: string, createOutcome: ChangeOutcome): Promise<ChangeOutcome> {
      const key = this.keyOf(canvasId, rid)
      const entry = this.pending.get(key)
      if (!entry) return createOutcome
      if (createOutcome.kind === 'accepted') {
        // 终态:flush held(FIFO 序,rid 已 known → edit accepted,非 not-found)+ 清 key
        this.pending.delete(key)
        for (const h of entry.held) {
          const o = await this.transport(canvasId, h.change, undefined)
          h.resolve(o)
        }
        return createOutcome
      }
      if (createOutcome.kind === 'rejected') {
        // 终态:held surface dependency-failed(非 not-found)+ 清 key
        this.pending.delete(key)
        for (const h of entry.held) {
          h.resolve({ kind: 'rejected', reason: 'dependency-failed', detail: 'create rejected' })
        }
        return createOutcome
      }
      // conflict / retryable(非终态)→ held 继续等;phase→awaiting-retry,不清 key(caller retry 后再 settle)
      entry.phase = 'awaiting-retry'
      return createOutcome
    }
  }

  // 测试 mock changes:node 是部分对象,用 `as unknown as CanvasChange` 旁路 record schema(port 契约测试只验调度,不验 record 字段)。
  const CV = 'cv1' // 主测试 canvas(异 canvas 测试用 CV2)
  const mockCreate = (rid: string): CanvasChange =>
    ({ kind: 'create-node', node: { id: rid } }) as unknown as CanvasChange
  const mockEdit = (rid: string, value = 'edited'): CanvasChange =>
    ({ kind: 'edit-node', nodeId: rid, intents: [{ op: 'set', fieldPath: ['title'], value }] }) as unknown as CanvasChange

  // outcome 常量(复用;makeAsyncTransport 深拷队列,对象本体共享只读不互相影响):
  const CURSOR_CREATE = 'create-seq' as unknown as SnapshotCursor
  const retryableOutcome: ChangeOutcome = { kind: 'retryable', reason: 'http_503' }
  const acceptedCreate: ChangeOutcome = { kind: 'accepted', cursor: CURSOR_CREATE }
  const rejectedBad: ChangeOutcome = { kind: 'rejected', reason: 'bad-request' }

  it('edit submitted while create in-flight is HELD; transport sees create FIRST, edit never 404', async () => {
    // 验收:create in-flight(submitChange 未 await)期间 submit edit → edit held(transport 未见 edit);
    // await create(accepted)→ flush held edit(rid 已 known → accepted,非 not-found)。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const createP = port.submitChange(CV, mockCreate('n1')) // create in-flight(transport 已见 create,未 await)
    const editP = port.submitChange(CV, mockEdit('n1')) // edit held——transport 此刻未见 edit
    expect(t.log).toEqual([mockCreate('n1')]) // transport 仅见 create(edit held 未提交)
    const createOut = await createP // create accepted → flush held edit
    const editOut = await editP
    expect(t.log).toEqual([mockCreate('n1'), mockEdit('n1')]) // create 先、edit 后(transport 提交序)
    expect(createOut.kind).toBe('accepted')
    expect(editOut.kind).toBe('accepted') // edit 提交时 rid 已 known → accepted(非 not-found)
    expect(editOut.kind).not.toBe('rejected') // 绝不因 pending-create 走 not-found
  })

  it('create terminally fails → dependent edit rejected(dependency-failed), NOT not-found', async () => {
    // create 失败(如 bad-request)→ 依赖 edit 不能进行;surface 为 dependency-failed(非 not-found)。
    const t = makeAsyncTransport({ rejectCreates: true })
    const port = new FifoRecordPort(t.transport)
    const createP = port.submitChange(CV, mockCreate('n2')) // in-flight
    const editP = port.submitChange(CV, mockEdit('n2')) // held
    const createOut = await createP // create rejected(bad-request)
    const editOut = await editP
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

  it('truly-unknown record edit (no pending create) → rejected(not-found) — boundary distinct from pending-create', async () => {
    // 验收:从未存在 vs pending-create 两种 404 边界分开断言。此为"从未存在"——直接 404 not-found。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const out = await port.submitChange(CV, mockEdit('ghost')) // 无 pending → 直送 transport → not-found
    expect(out.kind).toBe('rejected')
    if (out.kind === 'rejected') expect(out.reason).toBe('not-found')
    expect(t.log).toEqual([mockEdit('ghost')]) // 直送 transport,record 未知 → 404
  })

  it('multiple held edits flush in FIFO call order after create accepted', async () => {
    // FIFO:同 record 多条 edit 按 submit 序 flush(create 终态后顺序保持)。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const e1 = mockEdit('n3')
    const edit2 = { kind: 'edit-node', nodeId: 'n3', intents: [{ op: 'set', fieldPath: ['title'], value: '2' }] } as unknown as CanvasChange
    const createP = port.submitChange(CV, mockCreate('n3'))
    const e1P = port.submitChange(CV, e1)
    const e2P = port.submitChange(CV, edit2)
    await createP // create accepted → flush e1、edit2(FIFO 序)
    await e1P
    await e2P
    // transport 提交序:create 先,然后 e1、edit2 按 submit 序(同引用——toBe Object.is 证 FIFO 序保持)
    expect(t.log.map((c) => (c.kind === 'create-node' ? 'create' : 'edit'))).toEqual(['create', 'edit', 'edit'])
    expect(t.log[1]).toBe(e1) // 第一条 flush 的 edit 是先 submit 的(同对象引用)
    expect(t.log[2]).toBe(edit2) // 第二条 flush 的是后 submit 的(FIFO 序保持)
  })

  it('different recordId edit is NOT held by an unrelated pending create', async () => {
    // pending create for n4 不 hold n5 的 edit(因果是 per-record,非全局阻塞)。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const createP = port.submitChange(CV, mockCreate('n4')) // n4 in-flight
    const other = await port.submitChange(CV, mockEdit('n5')) // 异 record → 直送(但 n5 未知 → 404)
    expect(other.kind).toBe('rejected')
    if (other.kind === 'rejected') expect(other.reason).toBe('not-found') // n5 从未存在 → not-found(非 held)
    expect(t.log.some((c) => recordIdOf(c) === 'n5')).toBe(true) // n5 edit 直送 transport(非 held)
    await createP // cleanup(n4 create settle)
  })

  // ── R4-P1-2 新增矩阵:caller-owned retry/rebase 经公开 submitChange 闭环 + retryable/duplicate 区分 ──

  it('R4-P1-2: conflict→retry(new base)→accepted via PUBLIC submitChange; old base still conflict, new base only accepted', async () => {
    // bug4/bug5 闭合:旧 ackCreate 重发旧 create(adapter 自动重试 stale),无 caller 提交 rebased create/new base 接管 pending;
    // 旧 conflict→accepted 测试靠预编排 outcome 队列假收敛。R4:retry 经**公开 submitChange** 入口,带新 base,推进 pending attempt。
    const OLD = 'rev-1' as unknown as SnapshotCursor
    const NEW = 'rev-2' as unknown as SnapshotCursor
    const t = makeAsyncTransport({ baseAware: { acceptBase: NEW, conflictCursor: NEW } })
    const port = new FifoRecordPort(t.transport)
    const create = mockCreate('n60')
    const edit = mockEdit('n60')
    // 验收 1 + 2:conflict → retry(old base 仍 conflict)→ retry(new base 才 accepted),经公开 submitChange。
    const o1 = await port.submitChange(CV, create, OLD)
    expect(o1.kind).toBe('conflict') // 旧 base → conflict(非终态,phase→awaiting-retry)
    const editP = port.submitChange(CV, edit) // edit held(create awaiting-retry,pending 仍在)
    const o2 = await port.submitChange(CV, create, OLD) // retry(同 key,phase awaiting-retry)→ 推进 attempt,旧 base 仍 conflict
    expect(o2.kind).toBe('conflict')
    const o3 = await port.submitChange(CV, create, NEW) // retry,新 base → accepted(终态收敛)
    expect(o3.kind).toBe('accepted')
    // 验收 3:held edit 在 create 终态收敛后 settle,record 终态正确(create 成功 + edit 叠加)。
    const editOut = await editP
    expect(editOut.kind).toBe('accepted') // edit 在 create 收敛后 flush(非丢、非 dependency-failed)
    expect(editOut.kind).not.toBe('rejected')
    // base 透传:t.bases 记录 4 次 transport 调用的 base(3 次 create:OLD/OLD/NEW + 1 次 edit flush:undefined)
    expect(t.bases).toEqual([OLD, OLD, NEW, undefined])
  })

  it('R4-P1-2: retryable verbatim retry closes loop via PUBLIC submitChange (no new base, same change)', async () => {
    // 验收 4:retryable(瞬态 5xx)caller 原样重试(同 create,无新 base)经同一公开 submitChange 闭环;
    // phase awaiting-retry 时再 submitChange(同 key)→ retry(推进 attempt),非 duplicate(区分:retry 在 awaiting-retry,duplicate 在 in-flight)。
    const t = makeAsyncTransport({ createOutcomes: { n61: [retryableOutcome, retryableOutcome, acceptedCreate] } })
    const port = new FifoRecordPort(t.transport)
    const create = mockCreate('n61')
    const edit = mockEdit('n61')
    const o1 = await port.submitChange(CV, create) // 第一次:retryable(非终态)
    expect(o1.kind).toBe('retryable')
    const editP = port.submitChange(CV, edit) // edit held(phase awaiting-retry)
    const o2 = await port.submitChange(CV, create) // 原样 retry(同 create,无 base)→ retryable
    expect(o2.kind).toBe('retryable')
    const o3 = await port.submitChange(CV, create) // 原样 retry → accepted(终态收敛)
    expect(o3.kind).toBe('accepted')
    const editOut = await editP // held edit 在收敛后 flush
    expect(editOut.kind).toBe('accepted')
  })

  it('R4-P1-2: create retryable then TERMINALLY rejected → held dependency-failed (ownership: caller gives up retry)', async () => {
    // 所有权冻结:caller 拿 retryable 后放弃重试(create 持续返 retryable 后终态转 rejected);
    // create 终态 rejected → 此时 held 才 dependency-failed + 清 key(之前 retryable 时 held 一直等)。
    const t = makeAsyncTransport({ createOutcomes: { n62: [retryableOutcome, rejectedBad] } })
    const port = new FifoRecordPort(t.transport)
    const createP = port.submitChange(CV, mockCreate('n62'))
    const editP = port.submitChange(CV, mockEdit('n62'))
    const o1 = await createP
    expect(o1.kind).toBe('retryable') // 非终态:held 等待
    const retryP = port.submitChange(CV, mockCreate('n62')) // caller retry → 终态转 rejected
    const o2 = await retryP
    expect(o2.kind).toBe('rejected') // 终态
    const editOut = await editP
    expect(editOut.kind).toBe('rejected')
    if (editOut.kind === 'rejected') expect(editOut.reason).toBe('dependency-failed') // 此时才 dependency-failed
  })

  it('R3-P1-2 NEGATIVE: concurrent second create (different rid) does NOT clobber first pending held edits (per-key Map)', async () => {
    // bug2:旧单槽 pendingRid:submit(create-n21) 覆盖 pendingRid=n20→n21;submit(edit-n20) 见 pendingRid≠n20 → 直送 → 404(edit 丢)。
    // 新 per-key Map:n20、n21 各自 pending;edit-n20 仍 held;n20 settle 后 edit flush accepted(未被 n21 clobber)。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const createP20 = port.submitChange(CV, mockCreate('n20'))
    const editP20 = port.submitChange(CV, mockEdit('n20')) // n20 的 edit held
    const createP21 = port.submitChange(CV, mockCreate('n21')) // 第二个 create(不同 rid)→ 各自 pending,不 clobber
    const editP21 = port.submitChange(CV, mockEdit('n21'))
    const r21 = await createP21 // 先 settle n21(序无关)
    expect(r21.kind).toBe('accepted')
    expect((await editP21).kind).toBe('accepted')
    const r20 = await createP20 // 再 settle n20:n20 的 edit **仍** held 中(未被 clobber)
    expect(r20.kind).toBe('accepted')
    expect((await editP20).kind).toBe('accepted') // n20 的 edit 没丢
  })

  it('R3-P1-2 NEGATIVE: same recordId in different canvases do NOT collide (per-(canvasId,recordId) key)', async () => {
    // bug3:旧 submit 无 canvasId,同 rid 不同 canvas 共用单槽 pendingRid → 互相 clobber(create 丢、held 错位)。
    // 新 key=`${canvasId}::${rid}` + transport known 同 keying:CV/nX 与 CV2/nX 各自 pending,互不影响。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const CV2 = 'cv2'
    const createP1 = port.submitChange(CV, mockCreate('nX')) // c1 create nX
    const editP1 = port.submitChange(CV, mockEdit('nX')) // c1 edit nX held
    const createP2 = port.submitChange(CV2, mockCreate('nX')) // c2 create nX(同 rid,异 canvas)→ 各自 pending
    const editP2 = port.submitChange(CV2, mockEdit('nX')) // c2 edit nX held
    const r1 = await createP1 // settle c1/nX → c1 edit flush;c2/nX 仍 pending
    expect(r1.kind).toBe('accepted')
    expect((await editP1).kind).toBe('accepted')
    const r2 = await createP2 // settle c2/nX → c2 edit flush(独立于 c1)
    expect(r2.kind).toBe('accepted')
    expect((await editP2).kind).toBe('accepted')
  })

  it('R3-P1-2: multiple pending creates (different rids) flush independently in FIFO order', async () => {
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const e1 = mockEdit('n30')
    const e2a = mockEdit('n31', 'a')
    const e2b = mockEdit('n31', 'b')
    const createP30 = port.submitChange(CV, mockCreate('n30'))
    const e1P = port.submitChange(CV, e1)
    const createP31 = port.submitChange(CV, mockCreate('n31'))
    const e2aP = port.submitChange(CV, e2a)
    const e2bP = port.submitChange(CV, e2b)
    await createP31 // 先 settle n31(两个 held edit FIFO 序)
    expect((await e2aP).kind).toBe('accepted')
    expect((await e2bP).kind).toBe('accepted')
    await createP30 // 再 settle n30
    expect((await e1P).kind).toBe('accepted')
  })

  it('R4-P1-2: duplicate create same (canvas,rid) while first IN-FLIGHT → direct to transport (reuse-conflict), first pending NOT clobbered', async () => {
    // 同 (canvas,rid) create 仍在途(in-flight)时再来 create = create race(duplicate,caller 不知 pending attempt);
    // port 直送 transport(reuse-conflict 422),不触碰 pending(第一个 attempt 的 held 保留)。
    // 区分 retry:retry 在 phase awaiting-retry(caller 拿非终态后),duplicate 在 phase in-flight(create 仍在途)。
    const t = makeAsyncTransport()
    const port = new FifoRecordPort(t.transport)
    const createP = port.submitChange(CV, mockCreate('n40')) // 第一个 create in-flight(未 await)
    const editP = port.submitChange(CV, mockEdit('n40')) // edit held
    const dup = await port.submitChange(CV, mockCreate('n40')) // 第二个 create(同 key,phase in-flight)→ 直送 transport → reuse-conflict
    expect(dup.kind).toBe('rejected')
    if (dup.kind === 'rejected') expect(dup.reason).toBe('reuse-conflict')
    const createOut = await createP // 第一个 pending 未被 clobber:settle 后 edit flush accepted
    expect(createOut.kind).toBe('accepted')
    expect((await editP).kind).toBe('accepted')
  })

  it('R4-P1-2: final record STATE asserted (create + edit applied), not just transport log', async () => {
    // 终态断言:不仅看 transport.log 序,更断言最终 record 状态 = create 初值 + 编辑叠加。
    // record-store transport:create 写入 record(含 title),edit 改 title 字段;settle 后断言 store record.title='edited-title'。
    const store = new Map<string, { title: string }>() // key: `${canvasId}::${rid}`
    const transport: AsyncTransport = async (canvasId, c) => {
      const rid = recordIdOf(c)
      const k = `${canvasId}::${rid}`
      if (rid && isCreateKind(c)) {
        if (store.has(k)) return { kind: 'rejected', reason: 'reuse-conflict' }
        const node = (c as { node: { id: string; title: string } }).node
        store.set(k, { title: node.title })
        return { kind: 'accepted', cursor: 'create-seq' as unknown as SnapshotCursor }
      }
      if (rid && store.has(k) && c.kind === 'edit-node') {
        const intent = (c as { intents: { op: 'set'; fieldPath: readonly (string | number)[]; value: string }[] }).intents[0]
        if (intent.fieldPath[0] === 'title') store.get(k)!.title = intent.value
        return { kind: 'accepted', cursor: 'edit-seq' as unknown as SnapshotCursor }
      }
      return { kind: 'rejected', reason: 'not-found' }
    }
    const port = new FifoRecordPort(transport)
    const createN50 = { kind: 'create-node', node: { id: 'n50', title: 'init-title' } } as unknown as CanvasChange
    const editN50 = { kind: 'edit-node', nodeId: 'n50', intents: [{ op: 'set', fieldPath: ['title'], value: 'edited-title' }] } as unknown as CanvasChange
    const createP = port.submitChange(CV, createN50)
    const editP = port.submitChange(CV, editN50)
    const r = await createP // accepted → flush edit
    const editOut = await editP
    expect(r.kind).toBe('accepted')
    expect(editOut.kind).toBe('accepted')
    expect(store.get(`${CV}::n50`)!.title).toBe('edited-title') // 终态:record = 初值 + 编辑(非仅 log 有 edit)
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
