// src/kernel/__spike__/yjs-mapping.spike.test.ts
// N1 spike: Yjs ↔ NodeRecord ↔ LeaferJS —— 用真 yjs 验证 docs/decisions/record-schema.md
// 的纸面 CRDT 映射，暴露纸面没想到的坑,为 N2 实时协作立项探路。
//
// 权威:
//  - docs/decisions/record-schema.md(§1 CRDT 映射规则 + §3 嵌套结构细化 + §8 裁决)
//  - docs/decisions/platform-architecture-2026-07-07.md(§6 spike 直接对 Yjs 语义,不自研 LWW;
//    §13.5 revision 是 per-record 硬约束,spike 阶段就要有)
//  - docs/plan/arch-migration-execution-plan.md §4「下一批·协作」N1 行 + §0 成功定义 6
//
// 范围: spike = 证据优先,非生产代码。生产零接线——yjs 仅在此测试内 import,
// 不进 src/kernel 主路径(不接线 store/渲染),yjs 是 devDependency 不进生产 bundle
// (build 产物核验见 docs/spike/n1-yjs-mapping.md §4)。
//
// 四组验证(对应任务 a/b/c/d):
//  A. 代表性 record 无损往返(NodeRecord → Y.Map/Y.Array → 读回 === 原 record,含边界值)
//  B. 节点级并发合并(不同节点 / 同 record 不同字段 / 同字段 LWW 实际行为 + Y.Array 无 move 原语)
//  C. DocKernel 同步器接缝草案(Y.Doc ↔ DocKernel records synchronizer 最小原型 + revision↔Yjs 因果序调和立场)
//  D. LeaferJS 渲染面静态分析(Yjs 变更 → record → node → 投影 → useLeaferSpikeRenderer 数据面无结构性阻碍)

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import { fromRecord } from '../mapping'
import { MemoryDocKernel } from '../docKernel'
import type { NodeRecord } from '../records'

// ─── 通用递归 codec(spike 核心 helper)─────────────────────────────────
// record-schema §1 映射规则:node=Y.Map;有序集合=Y.Array;标量=叶子;子结构=嵌套 Y.Map。
// 这里用**通用递归 codec**(标量→叶子 / array→Y.Array / plain object→Y.Map)实现,
// 而非逐字段手写 schema 表——因为 record-schema §6 要求"无嵌套大 JSON blob",
// 每个嵌套对象都是字段级小对象,递归深度有界(record→generation→maskBounds ≤3 层),
// 通用递归安全。这本身就是一条 spike 发现(见 docs/spike §2 结论 1)。

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** encode:任意 record 值 → Yjs 结构。标量(string/number/boolean/null)→叶子;
 *  array→Y.Array(元素递归);plain object→Y.Map(键递归)。undefined→跳过(absent↔undefined)。 */
function encode(value: unknown): unknown {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>()
    for (const el of value) arr.push([encode(el)])
    return arr
  }
  if (isPlainObject(value)) {
    const map = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      map.set(k, encode(v))
    }
    return map
  }
  return value // scalar(string/number/boolean/null)
}

/** decode:Yjs 结构 → plain value。按 instanceof Y.Map/Y.Array 派发(NOT JSON.stringify——
 *  Y.Map/Y.Array 不是 JSON-serializable,见 §A 的 toJSON 探针)。 */
function decode(value: unknown): unknown {
  if (value instanceof Y.Array) return value.toArray().map(decode)
  if (value instanceof Y.Map) {
    const obj: Record<string, unknown> = {}
    value.forEach((v, k) => {
      obj[k] = decode(v)
    })
    return obj
  }
  return value
}

// ─── writeRecord / readRecord:NodeRecord ↔ per-node Y.Map(挂在 doc.getMap('nodes'))──
// writeRecord:attach + populate 全在**一个 doc.transact 内**——否则 nodesMap.set 会先以
// 空 ymap 触发 observeDeep(同步),resyncAll 读到 revision=undefined 的空 record → upsertNode
// max(0,undefined)=NaN,且 NaN 一旦进 kernel(existing.revision+1=NaN)就再洗不掉(见 §C 修订
// 双真相源测试)。transact 把 attach+全量 set 合成单事务,observer 只在末尾带完整 record 触发一次。
function writeRecord(doc: Y.Doc, record: NodeRecord): void {
  const nodesMap: Y.Map<unknown> = doc.getMap('nodes')
  doc.transact(() => {
    const existing = nodesMap.get(record.id)
    let ymap: Y.Map<unknown>
    if (existing instanceof Y.Map) {
      ymap = existing
      ymap.clear() // 已存在:清 stale 键,再写当前 record 全量字段
    } else {
      ymap = new Y.Map<unknown>()
      nodesMap.set(record.id, ymap)
    }
    for (const [k, v] of Object.entries(record)) {
      if (v === undefined) continue // absent ↔ undefined(toEqual 忽略 undefined 键)
      ymap.set(k, encode(v))
    }
  }, 'spike:writeRecord')
}

function readRecord(doc: Y.Doc, id: string): NodeRecord | undefined {
  const nodesMap: Y.Map<unknown> = doc.getMap('nodes')
  const ymap = nodesMap.get(id)
  if (!(ymap instanceof Y.Map)) return undefined
  return decode(ymap) as NodeRecord
}

// ─── 测试 fixtures ───────────────────────────────────────────────────────
// fullRecord:leader 点名的全部嵌套结构(transform/fills/strokes/effects/asset/relations/
// generation/aiWorkflow/experimentalAnchors/annotationBounds)全填,且每个字符串字段塞
// unicode(中文 + emoji)以测编码往返;判别联合(solid|image fill、shadow|blur effect)各放一例。
const fullRecord: NodeRecord = {
  id: 'n-full',
  type: 'image',
  title: '中文标题 🎨 — unicode & emoji ✨',
  revision: 7,
  transform: { x: 10.5, y: -20, width: 100, height: 50, rotation: 0 },
  fills: [
    { id: 'f-solid', kind: 'solid', color: '#ff0000', opacity: 0.5, visible: true },
    { id: 'f-image', kind: 'image', assetUrl: 'mivo-asset:abc', opacity: 1, visible: true, scaleMode: 'fill' },
  ],
  strokes: [{ id: 's1', color: '#000000', width: 2, style: 'solid', opacity: 1, visible: true }],
  effects: [
    { id: 'e-shadow', kind: 'shadow', color: '#000', x: 1, y: 2, blur: 3, spread: 0, opacity: 0.8, visible: true },
    { id: 'e-blur', kind: 'blur', radius: 4, visible: true },
  ],
  layout: { mode: 'auto', direction: 'horizontal', gap: 8, padding: { top: 1, right: 2, bottom: 3, left: 4 } },
  constraints: { horizontal: 'left', vertical: 'top' },
  asset: { url: 'mivo-asset:abc', mimeType: 'image/png', originalName: '猫.png', sizeBytes: 12345 },
  relations: {
    parentIds: ['n-parent1', 'n-parent2'],
    sectionId: 'sec1',
    targetNodeId: 'n-tgt',
    connectorStart: { nodeId: 'n-a', anchor: 'right', offset: 5 },
    connectorEnd: { nodeId: 'n-b', anchor: 'left' },
  },
  text: 'hello 世界 🌍',
  fontSize: 14,
  textColor: '#333333',
  fontWeight: 400,
  textAlign: 'center',
  textAutoWidth: true,
  markupKind: 'brush',
  markupBrushKind: 'marker',
  markupStampKind: 'heart',
  markupPoints: [{ x: 1, y: 2 }, { x: 3, y: 4, pressure: 0.5 }],
  markupStartArrow: true,
  markupEndArrow: false,
  markupCornerRadius: 2,
  sectionTitleVisible: true,
  sectionLockMode: 'all',
  sectionTemplateId: 'tpl1',
  markdownDisplayMode: 'full',
  imageHasTransparency: true,
  assetSourceDimensions: { width: 800, height: 600 },
  imageCrop: { x: 0, y: 0, width: 100, height: 100 },
  sourceNodeId: 'n-src',
  groupId: 'g1',
  locked: false,
  hidden: false,
  favorited: true,
  generation: {
    prompt: 'a cat 猫 ✨', model: 'gpt-image-2', size: '1024x1024', seed: 42, strength: 0.7,
    taskId: 't1', createdAt: 1700000000,
    maskBounds: { x: 10, y: 20, width: 30, height: 40 },
    maskSourceSize: { width: 1024, height: 1024 },
  },
  aiWorkflow: {
    kind: 'slot', status: 'ready', operation: 'slot-generation', prompt: 'gen 猫',
    sourceNodeIds: ['n-src1', 'n-src2'], anchorNodeId: 'n-anc', slotId: 'slot1',
    placement: 'right', createdAt: 1700000001, progress: 50, stage: 'rendering',
    startedAt: 1700000000,
    // 注:elapsedSec 是 runtime 派生(record-schema §3.8 明确不存),故此处不带——
    // 这是 record vs runtime 的边界,spike 验证它不进 record 也不进 Y.Map。
  },
  experimentalAnchors: [
    { id: 'a1', type: 'point', targetNodeId: 'n-tgt', x: 5, y: 6, instruction: 'redraw 此处', createdAt: 1700000002 },
    { id: 'a2', type: 'box', targetNodeId: 'n-tgt', x: 1, y: 2, width: 10, height: 20, instruction: 'box 区', createdAt: 1700000003, resultNodeIds: ['n-r1', 'n-r2'] },
  ],
  annotationBounds: { x: 0, y: 0, width: 50, height: 50 },
}

// minimalRecord:边界——只必填字段(id/type/title/revision/transform/fills/strokes/effects/relations),
// 全部 optional 缺省(undefined),fills/strokes/effects 为空数组。测"空数组 + optional 缺省"往返。
const minimalRecord: NodeRecord = {
  id: 'n-min', type: 'text', title: '', revision: 0,
  transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  fills: [], strokes: [], effects: [], relations: {},
}

// ────────────────────────────────────────────────────────────────────────────
// A. 代表性 record 无损往返(任务 a)
// ────────────────────────────────────────────────────────────────────────────
describe('N1-A: NodeRecord ↔ Y.Map/Y.Array 无损往返', () => {
  it('full record(全嵌套 + unicode + 判别联合)往返 === 原 record', () => {
    const doc = new Y.Doc()
    writeRecord(doc, fullRecord)
    expect(readRecord(doc, fullRecord.id)).toEqual(fullRecord)
  })

  it('minimal record(空数组 + optional 全缺省)往返 === 原 record', () => {
    const doc = new Y.Doc()
    writeRecord(doc, minimalRecord)
    const back = readRecord(doc, minimalRecord.id)
    expect(back).toEqual(minimalRecord)
    // 边界显式断言:空数组保形状([]而非 undefined),optional 缺省为 undefined
    expect(back?.fills).toEqual([])
    expect(back?.strokes).toEqual([])
    expect(back?.effects).toEqual([])
    expect(back?.relations).toEqual({})
    expect(back?.layout).toBeUndefined()
    expect(back?.generation).toBeUndefined()
    expect(back?.aiWorkflow).toBeUndefined()
    expect(back?.experimentalAnchors).toBeUndefined()
    expect(back?.annotationBounds).toBeUndefined()
  })

  it('边界数值:0 / 负数 / 浮点 / 大整数 往返无损', () => {
    const doc = new Y.Doc()
    const r: NodeRecord = {
      ...minimalRecord, id: 'n-num',
      transform: { x: 0, y: -999, width: 3.14159, height: 9007199254740991, rotation: -0.5 },
      revision: Number.MAX_SAFE_INTEGER,
      fontSize: 0,
    }
    writeRecord(doc, r)
    expect(readRecord(doc, r.id)).toEqual(r)
  })

  it('边界字符串:空串 / 纯中文 / emoji / 四字节代理对 往返无损', () => {
    const doc = new Y.Doc()
    const r: NodeRecord = {
      ...minimalRecord, id: 'n-str', title: '', text: '𓀀𓀁 emoji 🎨 中文 \n\t\\"',
      generation: { prompt: '🐼‍🎄(ZWJ family)', model: '' },
    }
    writeRecord(doc, r)
    expect(readRecord(doc, r.id)).toEqual(r)
  })

  it('PITFALL 探针:Y.Map.toJSON() 对嵌套类型的行为(deep vs shallow)——decode() 是稳健契约', () => {
    // 人们常想用 ymap.toJSON() 作为读 record 的捷径。本探针记录 yjs 13.6.31 的实际行为:
    const doc = new Y.Doc()
    writeRecord(doc, fullRecord)
    const ymap = doc.getMap('nodes').get(fullRecord.id) as Y.Map<unknown>

    // 稳健契约:显式递归 decode 永远全深正确
    expect(decode(ymap)).toEqual(fullRecord)

    // 捷径探针:toJSON 标量层一定 OK
    const json = ymap.toJSON() as Record<string, unknown>
    expect(json.id).toBe(fullRecord.id)
    expect(json.title).toBe(fullRecord.title)
    // 嵌套层:yjs 13.6 的 Y.Map.toJSON() 会递归调用子 Y 类型的 toJSON,故嵌套也深转 plain。
    // 记录此事实:toJSON 在 13.6.31 是深安全的(但 decode() 仍是显式契约——更鲁棒于
    // 未来 yjs 版本变化,且对 undefined 键的语义更清晰)。
    const transformViaToJSON = json.transform
    const isPlain = !(transformViaToJSON instanceof Y.Map) && !(transformViaToJSON instanceof Y.Array)
    expect(isPlain).toBe(true)
    expect(transformViaToJSON).toEqual(fullRecord.transform)
  })

  it('单 record 内多节点共存:两个独立 node Y.Map 同一 Y.Doc 互不串扰', () => {
    const doc = new Y.Doc()
    writeRecord(doc, fullRecord)
    writeRecord(doc, minimalRecord)
    expect(readRecord(doc, fullRecord.id)).toEqual(fullRecord)
    expect(readRecord(doc, minimalRecord.id)).toEqual(minimalRecord)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. 节点级并发合并(任务 b + Y.Array 无 move 原语)
// ────────────────────────────────────────────────────────────────────────────
describe('N1-B: CRDT 并发合并', () => {
  // 公共祖先(base):两节点,docA/docB 各自从 base 起步,分叉后交换 update。
  const makeBase = (): Y.Doc => {
    const base = new Y.Doc()
    writeRecord(base, { ...fullRecord, id: 'node1', title: 'base1' })
    writeRecord(base, { ...minimalRecord, id: 'node2', title: 'base2' })
    return base
  }
  const cloneFrom = (base: Y.Doc): Y.Doc => {
    const d = new Y.Doc()
    Y.applyUpdate(d, Y.encodeStateAsUpdate(base))
    return d
  }

  it('不同节点并发:A 改 node1、B 改 node2,双向 applyUpdate 后两边都留(成功定义 3 CRDT 版)', () => {
    const base = makeBase()
    const docA = cloneFrom(base)
    const docB = cloneFrom(base)
    // A 改 node1.title,B 改 node2.title(分叉后,各自未见对方 op)
    ;(docA.getMap('nodes').get('node1') as Y.Map<unknown>).set('title', 'A-title')
    ;(docB.getMap('nodes').get('node2') as Y.Map<unknown>).set('title', 'B-title')
    // 双向交换(全量 update;base op 幂等重放,仅并发新 op 合并)
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    // 两边收敛:node1.title='A-title',node2.title='B-title',两边一致
    expect(readRecord(docA, 'node1')!.title).toBe('A-title')
    expect(readRecord(docA, 'node2')!.title).toBe('B-title')
    expect(readRecord(docB, 'node1')!.title).toBe('A-title')
    expect(readRecord(docB, 'node2')!.title).toBe('B-title')
  })

  it('同 record 不同字段并发:A 改 transform、B 改 fills,字段级都留', () => {
    const base = makeBase()
    const docA = cloneFrom(base)
    const docB = cloneFrom(base)
    const aNode = docA.getMap('nodes').get('node1') as Y.Map<unknown>
    const bNode = docB.getMap('nodes').get('node1') as Y.Map<unknown>
    // A 重写 transform Y.Map
    aNode.set('transform', encode({ x: 999, y: 888, width: 1, height: 1, rotation: 42 }))
    // B 重写 fills Y.Array
    bNode.set('fills', encode([{ id: 'b-fill', kind: 'solid', color: '#00ff00', opacity: 1, visible: true }]))
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const merged = readRecord(docA, 'node1')!
    expect(merged.transform).toEqual({ x: 999, y: 888, width: 1, height: 1, rotation: 42 })
    expect(merged.fills).toEqual([{ id: 'b-fill', kind: 'solid', color: '#00ff00', opacity: 1, visible: true }])
  })

  it('同嵌套 Y.Map 不同叶子并发:A 改 transform.x、B 改 transform.y,叶子级都留(CRDT 最细粒度)', () => {
    const base = makeBase()
    const docA = cloneFrom(base)
    const docB = cloneFrom(base)
    const aT = (docA.getMap('nodes').get('node1') as Y.Map<unknown>).get('transform') as Y.Map<unknown>
    const bT = (docB.getMap('nodes').get('node1') as Y.Map<unknown>).get('transform') as Y.Map<unknown>
    aT.set('x', 1111)
    bT.set('y', 2222)
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const merged = readRecord(docA, 'node1')!
    expect(merged.transform!.x).toBe(1111)
    expect(merged.transform!.y).toBe(2222)
  })

  it('同字段并发(A/B 各设 node1.title)→ LWW 语义:两边收敛于同一个值(二选一,非混合)', () => {
    const base = makeBase()
    const docA = cloneFrom(base)
    const docB = cloneFrom(base)
    ;(docA.getMap('nodes').get('node1') as Y.Map<unknown>).set('title', 'A-title')
    ;(docB.getMap('nodes').get('node1') as Y.Map<unknown>).set('title', 'B-title')
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const aTitle = readRecord(docA, 'node1')!.title
    const bTitle = readRecord(docB, 'node1')!.title
    // 收敛(CRDT 保证):两边最终一致
    expect(aTitle).toBe(bTitle)
    // LWW:最终值是两者之一(不会是混合/损坏,也不会是 base1)
    expect(['A-title', 'B-title']).toContain(aTitle)
    // 记录实际赢家(spike 发现:yjs Y.Map 同 key 并发 set 的 LWW 由 op ID(clientID,clock)
    // 比较,clientID 是随机的,故赢家跨 run 不固定——N2 不能假设特定一方赢,只能依赖收敛)。
    console.log(`  [N1-B LWW] 同字段并发最终赢家=${aTitle}(A/B 哪个赢取决于 yjs clientID 比较,跨 run 不定)`)
  })

  it('PITFALL:Y.Array 无 move 原语——reorder 须 delete+insert(对 order_key/z-order 的影响)', () => {
    // 必须挂到 doc.getArray:detached new Y.Array() 不持留 op(spike 实测 toArray 返回 [])。
    const doc = new Y.Doc()
    const arr = doc.getArray<unknown>('reorder-test')
    arr.push(['a', 'b', 'c'])
    expect(arr.toArray()).toEqual(['a', 'b', 'c'])
    // 事实:yjs 13.6.31 的 Y.Array 没有 move() 方法(见 node_modules yjs d.ts:仅
    // insert/push/unshift/delete/get/toArray/slice/map/forEach)。reorder 只能 delete+insert。
    expect(typeof (arr as unknown as { move?: unknown }).move).toBe('undefined')
    // 单客户端 reorder [a,b,c]→[b,a,c] 用 delete+insert:
    const aEl = arr.get(0)
    arr.delete(0)
    arr.insert(2, [aEl]) // 把 a 挪到末尾 → [b,c,a]
    expect(arr.toArray()).toEqual(['b', 'c', 'a'])
    // CRDT 语义坑(记录给 spike doc,不在此断言并发结果——并发 reorder 行为见 §3):
    // delete+insert 的"新元素"拿到新 yjs id,与原元素的因果链断裂;两端并发 reorder
    // 同一数组时,合并结果依赖 yjs 对 insert/delete 的因果序裁决,不保证按"移动语义"
    // 保序——这对 order_key/z-order 类业务字段是 N2 必须正面处理的设计点(候选:
    // 显式 order_key 标量叶子 + LWW,或外部 y-protocols 之外的 order CRDT)。
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. DocKernel 同步器接缝草案(任务 c)+ revision↔Yjs 因果序调和立场
// ────────────────────────────────────────────────────────────────────────────
// 最小原型 YDocKernelSync:Y.Doc(节点 Y.Map 集合)↔ MemoryDocKernel。
// 不接线生产 store/渲染;只在此 spike 内验证"同步器接缝"形状 + 暴露 revision 双真相源坑。
//
// ── revision ↔ Yjs 因果序 调和立场(spike 初步立场,N2 立项前须 lead 拍板)──
//  - Yjs 真相:字段级 CRDT 合并,op 带 (clientID,clock) 因果序;同 record 不同字段并发都留,
//    同字段并发 LWW(由 op ID 比较,跨 run 不定)。Yjs 没有"revision"概念,只有因果历史。
//  - DocKernel.revision:per-record 单调计数,服务端乐观并发 LWW tie-break(S5/S6:record.revision
//    >= existing.revision 才接受,否则 stale 拒写)。这是**record 级** LWW,与 Yjs **字段级** 合并语义
//    正交——两者对"什么算冲突"定义不同:Yjs 认为不同字段不算冲突,DocKernel record 级 LWW
//    会把"A 改 transform / B 改 fills"的两次 PATCH 之一判 stale 拒写(丢一字段)。
//  - 调和立场(spike 推荐,非定论):CRDT 同步的 doc,**revision 应是 Yjs 状态的派生值**(
//    如该 record Y.Map 的 op 计数 / 内容 hash / 服务端 state-vector clock),不是独立 LWW 计数器;
//    DocKernel 对 CRDT 路径**不做 upsertNode 的 revision-bump+LWW 拒写**(那条路径只服务
//    legacy record 级 PATCH / 非 CRDT 客户端)。一个 record 要么走 CRDT 路径(Y.Update blob,
//    交换、不拒写),要么走 legacy 路径(record 级 PATCH + revision LWW),不能两条同时仲裁同一
//    record(双仲裁 = 必丢数据)。本原型的 upsertNode 调用会**暴露**这个坑(见下测试)。

class YDocKernelSync {
  readonly yDoc = new Y.Doc()
  private readonly kernel: MemoryDocKernel

  constructor(kernel: MemoryDocKernel) {
    this.kernel = kernel
    // observeDeep 回调不消费 events(只触发 resyncAll),故用零参箭头——既满足
    // observeDeep 的 (events, transaction) => void 签名(少参可赋值),又不在 spike 源码里
    // 引入 yjs d.ts 自带的 any(避开 no-explicit-any)。spike 原型只关心"节点 Y.Map 变了→重读投影"。
    ;(this.yDoc.getMap('nodes') as Y.Map<unknown>).observeDeep(() => this.resyncAll())
  }

  /** 写一条 record 进 Y.Doc(并触发 observer → kernel 反映)。 */
  write(record: NodeRecord): void {
    writeRecord(this.yDoc, record)
  }

  /** 应用远端 Y.Update(服务端/其他 client 推来的 CRDT 增量)。 */
  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.yDoc, update)
  }

  /** 产出可推送的 Y.Update(自 baseVector 之后的增量;不传则全量)。 */
  diffToUpdate(baseVector?: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.yDoc, baseVector)
  }

  getKernel(): MemoryDocKernel {
    return this.kernel
  }

  // spike 原型为简洁起见,observeDeep 触发时全量重读所有 node → upsertNode(非增量;
  // N2 实装须按 Y.YMapEvent.path 增量读改动节点,避免 O(n) per change)。
  private resyncAll(): void {
    const nodesMap: Y.Map<unknown> = this.yDoc.getMap('nodes')
    nodesMap.forEach((ymap) => {
      if (!(ymap instanceof Y.Map)) return
      const record = decode(ymap) as NodeRecord
      // ⚠️ PITFALL(双真相源):此处走 kernel.upsertNode,它会 bump revision(existing.revision+1)。
      // 即 Yjs 路径的 record.revision(=7)进 kernel 后变 8,与 Y.Map 里仍存的 7 **背离**。
      // N2 实装必须 bypass 这条 LWW bump(改 kernel 加 setNodeFromCrdt,或 kernel 降级为
      // Y.Doc 的只读投影)。本 spike 用此暴露坑,不绕过——见下方 'revision 双真相源坑' 测试。
      this.kernel.upsertNode(record)
    })
  }
}

describe('N1-C: DocKernel 同步器接缝 + revision 双真相源坑', () => {
  it('Y.Doc 写入 → observer 触发 → kernel.getNode 反映变更', () => {
    const sync = new YDocKernelSync(new MemoryDocKernel())
    sync.write(fullRecord)
    // 同步器把 Yjs 状态投影进了 kernel(读回字段一致)
    const got = sync.getKernel().getNode(fullRecord.id)!
    expect(got.id).toBe(fullRecord.id)
    expect(got.title).toBe(fullRecord.title)
    expect(got.transform).toEqual(fullRecord.transform)
    expect(got.fills).toEqual(fullRecord.fills)
  })

  it('远端 Y.Update 增量合并 → kernel 反映 CRDT 合并结果(不同字段都留)', () => {
    // 公共祖先:同 §B 的 makeBase/cloneFrom 一样,两端必须从**同一 base 起步**(同一 yjs clientID
    // 的 op)。若各自独立 sync.write(fullRecord),各自会以自己的 clientID 创建 base op,合并时
    // 两条独立 base 的 fills Y.Array 会被当并发新建 → 合并成 [f-solid, b-fill] 之类的怪异并集
    // (spike 实测踩到)。正确做法:写一次 base,encodeStateAsUpdate,两端 applyRemoteUpdate 灌入。
    const base = new Y.Doc()
    writeRecord(base, fullRecord)
    const baseUpdate = Y.encodeStateAsUpdate(base)

    const syncA = new YDocKernelSync(new MemoryDocKernel())
    syncA.applyRemoteUpdate(baseUpdate) // 灌 base → observer → kernel 投影
    const aNode = syncA.yDoc.getMap('nodes').get(fullRecord.id) as Y.Map<unknown>
    aNode.set('transform', encode({ x: 999, y: 888, width: 1, height: 1, rotation: 42 }))

    const syncB = new YDocKernelSync(new MemoryDocKernel())
    syncB.applyRemoteUpdate(baseUpdate)
    const bNode = syncB.yDoc.getMap('nodes').get(fullRecord.id) as Y.Map<unknown>
    bNode.set('fills', encode([{ id: 'b-fill', kind: 'solid', color: '#00ff00', opacity: 1, visible: true }]))

    // 交换 CRDT 增量(全量 update;base op 幂等重放,仅并发新 op 合并)
    syncB.applyRemoteUpdate(syncA.diffToUpdate())
    syncA.applyRemoteUpdate(syncB.diffToUpdate())

    // 两端 kernel 都反映字段级合并(transform from A + fills from B)
    const aRec = syncA.getKernel().getNode(fullRecord.id)!
    const bRec = syncB.getKernel().getNode(fullRecord.id)!
    expect(aRec.transform).toEqual({ x: 999, y: 888, width: 1, height: 1, rotation: 42 })
    expect(aRec.fills).toEqual([{ id: 'b-fill', kind: 'solid', color: '#00ff00', opacity: 1, visible: true }])
    expect(bRec.transform).toEqual({ x: 999, y: 888, width: 1, height: 1, rotation: 42 })
    expect(bRec.fills).toEqual([{ id: 'b-fill', kind: 'solid', color: '#00ff00', opacity: 1, visible: true }])
  })

  it('PITFALL 暴露:kernel.revision 与 Y.Map 里 record.revision 背离(双真相源)', () => {
    const sync = new YDocKernelSync(new MemoryDocKernel())
    sync.write({ ...fullRecord, revision: 7 })
    // 首次写:Y.Map record.revision = 7(kernel 首次 upsert 用 max(0,base)=7,不 bump)
    expect(readRecord(sync.yDoc, fullRecord.id)!.revision).toBe(7)
    expect(sync.getKernel().getNode(fullRecord.id)!.revision).toBe(7)
    // 再改 title → Y.Map revision 仍 7(没人更新它);kernel 走 upsertNode(existing.revision+1)=8
    // → kernel=8 vs Y.Map=7,背离出现!
    ;(sync.yDoc.getMap('nodes').get(fullRecord.id) as Y.Map<unknown>).set('title', 'changed')
    expect(readRecord(sync.yDoc, fullRecord.id)!.revision).toBe(7)
    expect(sync.getKernel().getNode(fullRecord.id)!.revision).toBe(8)
    // 结论:N2 不能让 kernel 自行 bump revision 与 Yjs 并存;立场见文件头注释 +
    // docs/spike/n1-yjs-mapping.md §3(revision 必须是 Yjs 派生值,且 CRDT 路径 bypass LWW 拒写)。
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. LeaferJS 渲染面静态分析(任务 d)
// ────────────────────────────────────────────────────────────────────────────
// 链路:Yjs Y.Map(每节点)→ [readRecord] → NodeRecord → [mapping.fromRecord] → MivoCanvasNode
//      → [render/projection.ts 投影] → renderedNodes → [useEngineSpikeRenderers]
//      → useLeaferSpikeRenderer paint。
//
// 数据面契约(useEngineSpikeRenderers.ts:23-24):visibleNodes/canvasRenderedNodes: MivoCanvasNode[]。
// useLeaferSpikeRenderer.ts:4 import type { MivoCanvasNode };其 paint 入参就是 MivoCanvasNode。
// 即渲染层消费的是 MivoCanvasNode[],**与数据来源无关**(当前来自 canvasStore,N2 换成 Yjs
// 观测到的 store 即可,渲染层零改)。下面用类型级断言钉这条链路类型对齐(无结构性阻碍)。

describe('N1-D: LeaferJS 渲染面静态分析(Yjs→record→node→renderer 无结构性阻碍)', () => {
  it('链路类型对齐:readRecord→NodeRecord→fromRecord→MivoCanvasNode(renderer 输入)', () => {
    const doc = new Y.Doc()
    writeRecord(doc, fullRecord)
    const rec = readRecord(doc, fullRecord.id)!
    // NodeRecord → MivoCanvasNode(fromRecord,src/kernel/mapping.ts 已有 T1.2 64 字段往返)
    const node: MivoCanvasNode = fromRecord(rec)
    // renderer 数据面消费 MivoCanvasNode[](useEngineSpikeRenderers / useLeaferSpikeRenderer)
    const rendererInput: MivoCanvasNode[] = [node]
    expect(rendererInput).toHaveLength(1)
    expect(rendererInput[0].id).toBe(fullRecord.id)
    expect(rendererInput[0].transform).toEqual(fullRecord.transform)
  })
})
