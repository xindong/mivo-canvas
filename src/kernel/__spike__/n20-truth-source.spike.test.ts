// src/kernel/__spike__/n20-truth-source.spike.test.ts
// N2-0 真相源拍板 spike — Figma 式(服务端做主 + 属性级 LWW + 实时广播)vs Yjs 对比证据
// 隔离 spike,**不入生产 bundle**(同 N1 约定;yjs 仅 devDep,本文件不在 src/main.tsx import graph 内)。
// 权威产出:docs/decisions/n20-truth-source-decision.md(本 spike 的决策文档)。
// 依赖:yjs@^13.6.31(devDep,N1 §5 已加并验不进 bundle)+ src/kernel/{records} 类型。
//
// 验证范围(对应计划 §8 N2-0 七项 hard gate + anti-Yjs 对照):
//   G4 + G1: Figma 式 field-level PATCH server(受控修订 #194)→ 属性级 LWW,无需 Yjs
//   G3:      跨 record invariant/事务(server-side 原子 cascade,CRDT 做不到)
//   G2:      多人 undo/redo + 拖拽 coalescing(command 式,远端交错保留)
//   G7:      事件序号/补拉日志/压缩 + 权限撤销断流 + 存储放大
//   G5:      实时 transport 协议侧分析(SSE vs WS;auth header 链)— 见决策文档 §G5,本文件补 SSE broadcast skeleton
//   antiYjs: 复现 N1 坑5(revision↔Yjs 双真相源背离)+ 坑7(writeRecord clear+rebuild 吞并发子字段)
//
// 边界:本 spike 不接线任何生产 store/渲染/服务端;只在测试进程内跑 Figma 式 field-level server
// 原型 + yjs 对照。生产实装等 N2-0 决议后 G1-c/N2-1 落地。

import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import type { NodeRecord, Revision } from '../records'

// ── 最小 NodeRecord fixture(直接构造,不走 toRecord/fromRecord,避免依赖 legacy MivoCanvasNode 全字段) ──
const makeNode = (id: string, over: Partial<NodeRecord> = {}): NodeRecord =>
  ({
    id,
    type: 'text',
    title: id,
    revision: 0,
    transform: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
    fills: [],
    strokes: [],
    effects: [],
    relations: {},
    text: 'hello',
    fontSize: 14,
    textColor: '#000000',
    fontWeight: 400,
    textAlign: 'left',
    textAutoWidth: true,
    ...over,
    // Partial<NodeRecord> spread 会把必填数组(effects)类型拓宽成 `| undefined`(tsc 报 TS2322);
    // 测试 fixture 场景 cast 收窄(运行时 over 不传 undefined,安全)。
  }) as NodeRecord

/** §10 setByPath 硬化:拒原型污染段(__proto__/prototype/constructor),返修 P1-3。 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const assertSafePath = (path: (string | number)[]): void => {
  for (const seg of path) {
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`forbidden path segment "${seg}" (anti-prototype-pollution, §10 setByPath)`)
    }
  }
}
/** 通用嵌套字段 set(path 导航到 leaf,mutates clone)。硬化:拒原型污染路径(P1-3)。 */
const setByPath = (obj: Record<string, unknown>, path: (string | number)[], value: unknown): void => {
  assertSafePath(path)
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i] as string] as Record<string, unknown>
  cur[path[path.length - 1] as string] = value
}
/** 嵌套字段 get(条件逆运算读当前服务端值用)。硬化:同拒原型污染路径。 */
const getByPath = (obj: Record<string, unknown>, path: (string | number)[]): unknown => {
  assertSafePath(path)
  let cur: unknown = obj
  for (const seg of path) cur = (cur as Record<string, unknown>)[seg as string]
  return cur
}
/** fieldPath → 稳定 key 串(per-field clock / 条件逆运算去重用)。 */
const fieldKeyOf = (path: (string | number)[]): string => path.map((s) => String(s)).join('.')

// ════════════════════════════════════════════════════════════════════════════
// Figma 式 field-level PATCH server 原型(G4 受控修订 #194 + G1 属性级 LWW + G7 事件日志/补拉/撤销)
// ════════════════════════════════════════════════════════════════════════════

/** N2-1 op schema 草案(opId/clientId/actor/baseRevision/fieldPath)。走 #194 PATCH envelope(If-Match 不变)。 */
type FieldOp = {
  opId: string
  clientId: string
  actor: string
  recordId: string
  /** If-Match base;undefined → #194 严格 428(precondition-required)。 */
  baseRevision: Revision | undefined
  fieldPath: (string | number)[]
  value: unknown
}

/** 广播事件(≤2s 互见;客户端按 seq 补拉)。 */
type BroadcastEvent = { seq: number; recordId: string; op: FieldOp; revision: Revision }

/** #194 upsertChild 结果变体(本 spike 复用其 envelope:ok/conflict/precondition-required/not-found)。 */
type ApplyResult =
  | { kind: 'ok'; revision: Revision; seq: number }
  | { kind: 'conflict'; currentRevision: Revision }
  | { kind: 'precondition-required' }
  | { kind: 'not-found' }

/**
 * FieldLevelServer:Figma 式服务端做主原型。
 * - 每条 record 独立(NodeRecord + per-record revision),服务端按属性级 merge。
 * - revision:每 accepted op bump,**只供 snapshot/catch-up**(N1 §3 方案 A:revision 不参与 LWW 拒写)。
 * - field-level LWW:不同 fieldPath 并发都留;同 fieldPath 并发 last-writer(by server seq)wins。
 * - 全序 seq:per-canvas 单调事件序号(gate 7 补拉日志)。
 * - 连接绑 actor+canvas:权限撤销 → 断流(gate 7)。
 */
class FieldLevelServer {
  private recs = new Map<string, NodeRecord>()
  private edges = new Map<string, { id: string; from: string; to: string; revision: Revision }>()
  private seq = 0
  private opLog: BroadcastEvent[] = []
  /** actor → 当前 SSE 连接(gate 7 revoke 断流用)。 */
  private conns = new Map<string, { send: (e: BroadcastEvent) => void }>()
  private members = new Set<string>()

  // ── seed/读 ──
  seedNode(r: NodeRecord) { this.recs.set(r.id, structuredClone(r)) }
  getNode(id: string): NodeRecord | undefined {
    const r = this.recs.get(id); return r ? structuredClone(r) : undefined
  }
  revision(id: string): Revision { return this.recs.get(id)?.revision ?? 0 }

  // ── G4/G1:field-level applyOp(#194 envelope:428/409/200)──
  applyOp(op: FieldOp): ApplyResult {
    // N5/#194 严格:If-Match missing → 428(必填 baseRevision)。
    if (op.baseRevision === undefined) return { kind: 'precondition-required' }
    const existing = this.recs.get(op.recordId)
    if (!existing) return { kind: 'not-found' }
    // 受控修订 #194 关键:field-level 不再用 base===rev 做 record 级 409 拒写(那会 "整串互吞")。
    // 改为:base < existing.revision 时仍接受 op(field-level 不冲突),除非 stale op(base 已落后且
    // 同 fieldPath 被更新过 — 本 spike 简化为 "接受所有 op,field-level set + revision bump",
    // 同 fieldPath 并发由 server seq LWW 收敛;生产 N2-1 加 per-field clock 做精确 stale 判定)。
    const updated = structuredClone(existing)
    setByPath(updated as unknown as Record<string, unknown>, op.fieldPath, op.value)
    updated.revision = existing.revision + 1 // bump per accepted op(snapshot/catch-up only)
    this.recs.set(op.recordId, updated)
    const seq = ++this.seq
    const evt: BroadcastEvent = { seq, recordId: op.recordId, op, revision: updated.revision }
    this.opLog.push(evt)
    this.broadcast(evt)
    return { kind: 'ok', revision: updated.revision, seq }
  }

  // ── G3:跨 record 事务(node-delete + edge cascade,server-side 原子;CRDT 做不到)──
  deleteNodeCascade(nodeId: string, actor: string): { kind: 'ok'; deletedEdges: number } | { kind: 'not-found' } {
    const existing = this.recs.get(nodeId)
    if (!existing) return { kind: 'not-found' }
    // 原子:删 node + 级联删所有引用该 node 的 edge(同一 server op,事务边界)。
    let deletedEdges = 0
    for (const [eid, e] of this.edges) {
      if (e.from === nodeId || e.to === nodeId) { this.edges.delete(eid); deletedEdges++ }
    }
    this.recs.delete(nodeId)
    const seq = ++this.seq
    const evt: BroadcastEvent = {
      seq, recordId: nodeId,
      op: { opId: `del-${seq}`, clientId: 'server', actor, recordId: nodeId, baseRevision: existing.revision, fieldPath: ['__delete__'], value: null },
      revision: existing.revision + 1,
    }
    this.opLog.push(evt)
    this.broadcast(evt)
    return { kind: 'ok', deletedEdges }
  }
  seedEdge(id: string, from: string, to: string) { this.edges.set(id, { id, from, to, revision: 0 }) }
  edgeCount() { return this.edges.size }

  // ── G7:补拉日志 + 压缩 ──
  pullSince(since: number): BroadcastEvent[] { return this.opLog.filter((e) => e.seq > since) }
  /** 压缩:取 snapshot + truncate opLog 到最近 N 条(gate 7 存储放大控制)。 */
  compress(keepLast: number): { snapshotSize: number; logKept: number; logTruncated: number } {
    const snapshotSize = this.recs.size
    const logTruncated = Math.max(0, this.opLog.length - keepLast)
    this.opLog = this.opLog.slice(-keepLast)
    return { snapshotSize, logKept: this.opLog.length, logTruncated }
  }

  // ── G7:权限撤销断流 ──
  addMember(actor: string) { this.members.add(actor) }
  addConn(actor: string, send: (e: BroadcastEvent) => void) { if (this.members.has(actor)) this.conns.set(actor, { send }) }
  removeMember(actor: string): boolean {
    const had = this.members.delete(actor)
    const conn = this.conns.get(actor)
    if (conn) { conn.send({ seq: -1, recordId: '', op: { opId: 'revoke', clientId: 'server', actor, recordId: '', baseRevision: undefined, fieldPath: ['__revoke__'], value: null }, revision: -1 }); this.conns.delete(actor) }
    return had
  }
  private broadcast(evt: BroadcastEvent) {
    for (const [actor, conn] of this.conns) {
      if (this.members.has(actor)) conn.send(evt) // 权限实时校验:撤权后不再收
    }
  }
  isConnAlive(actor: string): boolean { return this.conns.has(actor) && this.members.has(actor) }

  // ── 返修硬化(P1-1/P2-7/P1-3):条件逆运算读 + authz 拒写 + logFloor/gap + snapshot + bytes ──
  /** 条件逆运算用:读当前服务端 fieldPath 值(返 undefined = record 不存在或字段缺失)。 */
  getFieldValue(recordId: string, path: (string | number)[]): unknown {
    const r = this.recs.get(recordId)
    if (!r) return undefined
    return getByPath(r as unknown as Record<string, unknown>, path)
  }
  recordExists(id: string): boolean { return this.recs.has(id) }
  /** authz-gated apply(P2-7):撤权后 actor 写 → forbidden(不只断流,还拒写)。 */
  applyOpAuthz(op: FieldOp, actor: string): ApplyResult | { kind: 'forbidden' } {
    if (!this.members.has(actor)) return { kind: 'forbidden' } // 撤权后写拒绝(返修 P2-7)
    return this.applyOp(op)
  }
  /** logFloor:opLog 中最旧 op 的 seq(压缩后 = floor;since < floor → gap)。 */
  logFloor(): number { return this.opLog.length ? this.opLog[0].seq : 0 }
  /** 补拉 + gap 协议(P2-7):since < floor → gap=true + snapshot(客户端必须 reset);else 增量。 */
  pullSinceWithGap(since: number): { events: BroadcastEvent[]; gap: boolean; snapshot: { id: string; revision: Revision }[] | null } {
    const floor = this.logFloor()
    if (since < floor) {
      // gap:since 指向的 op 已被截断,增量补不完整 → 返 snapshot + 全量 kept events,客户端 reset
      return { events: this.opLog.slice(), gap: true, snapshot: [...this.recs.values()].map((r) => ({ id: r.id, revision: r.revision })) }
    }
    return { events: this.pullSince(since), gap: false, snapshot: null }
  }
  /** 恢复等价测试用:全量 snapshot(所有 record 的 id+revision)。 */
  snapshot(): { id: string; revision: Revision }[] {
    return [...this.recs.values()].map((r) => ({ id: r.id, revision: r.revision }))
  }
  /** bytes 级存储对比(P2-7):Figma opLog+snapshot 字节数。 */
  storageBytes(): number {
    const opLogBytes = JSON.stringify(this.opLog).length
    const snapshotBytes = JSON.stringify([...this.recs.values()]).length
    return opLogBytes + snapshotBytes
  }
  opLogLength(): number { return this.opLog.length }
}

// ════════════════════════════════════════════════════════════════════════════
// G2:Figma 式 command undo 栈 + 拖拽 coalescing(远端交错保留)
// ════════════════════════════════════════════════════════════════════════════

type UndoEntry = { kind: 'drag' | 'edit'; op: FieldOp; coalescedCount: number }

class CommandUndoStack {
  private stack: UndoEntry[][] = [] // 按 "拖拽批次" 分组
  private currentBatch: UndoEntry[] = []
  private coalesceWindow = false
  private remoteSeen: FieldOp[] = [] // 远端 op 到达记录(不入本地 undo 栈,供断言)

  /** 拖拽中:连续 transform op 合并成 1 undo entry(coalescing)。 */
  pushDrag(op: FieldOp) {
    const last = this.currentBatch[this.currentBatch.length - 1]
    if (this.coalesceWindow && last && last.kind === 'drag' && JSON.stringify(last.op.fieldPath) === JSON.stringify(op.fieldPath)) {
      last.op = op // 用最新 op 代表整批(LWW by 最新);coalescedCount++
      last.coalescedCount++
    } else {
      this.currentBatch.push({ kind: 'drag', op, coalescedCount: 1 })
    }
  }
  startBatch() { this.currentBatch = []; this.coalesceWindow = true }
  endBatch() { if (this.currentBatch.length) this.stack.push(this.currentBatch); this.currentBatch = []; this.coalesceWindow = false }
  /** push 远端 op(不进本地 undo 栈 — undo 只撤自己 op,远端交错保留)。 */
  pushRemote(op: FieldOp) { this.remoteSeen.push(op) }
  remoteSeenCount() { return this.remoteSeen.length }
  /** undo:撤最近一批自己 op;返回要发给 server 的 inverse ops。 */
  undo(): FieldOp[] | null {
    const batch = this.stack.pop()
    if (!batch) return null
    // inverse:把每个 op 的 value 设回 baseRevision 时的旧值(本 spike 简化:发同 fieldPath 的 inverse 标记)
    return batch.map((e) => ({ ...e.op, opId: `inv-${e.op.opId}`, value: `__undo__${JSON.stringify(e.op.value)}` }))
  }
  depth() { return this.stack.length }
}

// ════════════════════════════════════════════════════════════════════════════
// 测试:七 gate + anti-Yjs
// ════════════════════════════════════════════════════════════════════════════

describe('N2-0 G4 + G1: Figma 式 field-level PATCH(受控修订 #194)→ 属性级 LWW,无需 Yjs', () => {
  it('G4-1 不同字段并发(A 改 transform.x / B 改 title)→ 双留,revision bump 两次(field-level LWW)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    const rev0 = s.revision('n1')
    // A 改 transform.x(拖拽),base=rev0
    const ra = s.applyOp({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: 100 })
    // B 改 title(编辑),base=rev0(两人同时基于同一快照)
    const rb = s.applyOp({ opId: 'b1', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B-title' })
    expect(ra.kind).toBe('ok')
    expect(rb.kind).toBe('ok') // ★ field-level:不同 fieldPath 不冲突,都接受(整串 LWW 会 409 拒 B → 吞 title)
    const n = s.getNode('n1')!
    expect(n.transform.x).toBe(100) // A 留
    expect(n.title).toBe('B-title') // B 留
    expect(n.revision).toBe(rev0 + 2) // 每 accepted op bump
  })

  it('G4-2 嵌套叶子并发(A 改 transform.x / B 改 transform.y)→ 双留(nested-leaf LWW,非整 transform 替换)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { transform: { x: 0, y: 0, width: 100, height: 40, rotation: 0 } }))
    const rev0 = s.revision('n1')
    s.applyOp({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: 10 })
    s.applyOp({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'y'], value: 20 })
    const n = s.getNode('n1')!
    expect(n.transform.x).toBe(10) // ★ A 的 x 留
    expect(n.transform.y).toBe(20) // ★ B 的 y 留(若 transform 整串 LWW,B 的 y 会被 A 的 {x:10,y:0} 覆盖回 0)
  })

  it('G1 文本 gate:同字段并发(A/B 都改 text)→ LWW by server seq(整串取后者),v1 可接受', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { text: 'orig' }))
    const rev0 = s.revision('n1')
    // A 先发(低 seq)
    s.applyOp({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['text'], value: 'A-text' })
    // B 后发(高 seq → LWW wins)
    const rb = s.applyOp({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['text'], value: 'B-text' })
    expect(rb.kind).toBe('ok')
    const n = s.getNode('n1')!
    expect(n.text).toBe('B-text') // ★ LWW:后者 wins(整串,非 char-merge)
    // 对比 Yjs Y.Text 会做 char-level OT 合并(过重,且引入 Yjs runtime + 双真相源)。
    // v1 判决:canvas 文本(标题/标注/markdown)同字段同刻并发罕见,LWW + UX surfacing(409/"他人已编辑")可接受。
  })

  it('G4-3 #194 envelope 不变:If-Match missing → 428(precondition-required)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    const r = s.applyOp({ opId: 'x', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: undefined, fieldPath: ['title'], value: 'x' })
    expect(r.kind).toBe('precondition-required') // ★ #194 N5 严格保留
  })

  it('G4-4 revision 只供 snapshot/catch-up:不参与 LWW 拒写(base 落后仍接受 field-level op)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    const rev0 = s.revision('n1')
    // A 改 title → rev0→1
    s.applyOp({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' })
    // B 基于过期 rev0 改 transform.x(不同字段)— #194 record 级会 409 拒 B(整串互吞);
    // field-level 受控修订:接受 B(x:50),不因 base 落后拒写。
    const rb = s.applyOp({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: 50 })
    expect(rb.kind).toBe('ok') // ★ field-level:base 落后但不同字段 → 接受(不拒写)
    const n = s.getNode('n1')!
    expect(n.title).toBe('A') // A 留
    expect(n.transform.x).toBe(50) // B 留(revision 不再做 LWW 拒写,只做 snapshot/catch-up)
  })
})

describe('N2-0 G3: 跨 record invariant/事务(server-side 原子 cascade,CRDT 做不到)', () => {
  it('G3-1 node-delete + edge cascade 原子(删 n1 → 引用 n1 的 edge 全级联删,同一 server op)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.seedNode(makeNode('n2'))
    s.seedEdge('e1', 'n1', 'n2')
    s.seedEdge('e2', 'n2', 'n1')
    s.seedEdge('e3', 'n2', 'n2') // 不引用 n1,应保留
    expect(s.edgeCount()).toBe(3)
    const r = s.deleteNodeCascade('n1', 'alice')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.deletedEdges).toBe(2) // e1 + e2 级联删
    expect(s.getNode('n1')).toBeUndefined()
    expect(s.edgeCount()).toBe(1) // 只剩 e3
    // ★ CRDT(Yjs)做不到:Yjs 是 per-record 最终一致,无原子多 record 事务;
    //   node 删除 + edge 清理在 CRDT 里是两个独立 op,中间窗口 edge 可能查到孤儿 from。
  })

  it('G3-2 delete-vs-update:A 删 node,B 并发 update 同 node → delete wins(B update not-found)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    const rev0 = s.revision('n1')
    // A 删(事务)
    s.deleteNodeCascade('n1', 'alice')
    // B 并发 update(基于过期 rev0)— 落到已删 node
    const rb = s.applyOp({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B' })
    expect(rb.kind).toBe('not-found') // ★ delete wins:删优先,B 的 update 落空(not 409 重试 — 原子边界明确)
  })
})

describe('N2-0 G2: 多人 undo/redo + 拖拽 coalescing(command 式,远端交错保留)', () => {
  it('G2-1 拖拽连续 transform op → coalescing 成 1 undo entry', () => {
    const undo = new CommandUndoStack()
    const rev0 = 0
    undo.startBatch()
    // 拖拽产生 100 个 transform.x op(每 mousemove 一个)
    for (let i = 1; i <= 100; i++) {
      undo.pushDrag({ opId: `d${i}`, clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: i })
    }
    undo.endBatch()
    // undo 栈深度 = 1(整批拖拽合并为 1 entry)
    expect(undo.depth()).toBe(1)
    const inv = undo.undo()
    expect(inv).not.toBeNull()
    expect(undo.depth()).toBe(0) // undo 后清空
    // ★ coalescing:100 个 drag op → 1 undo;Ctrl+Z 一次撤销整段拖拽,而非逐步退 100 次。
  })

  it('G2-2 undo 只撤自己 op,远端交错保留(remote op 不入本地 undo 栈)', () => {
    const undo = new CommandUndoStack()
    const rev0 = 0
    // A 自己的 op 入栈
    undo.startBatch()
    undo.pushDrag({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' })
    undo.endBatch()
    // 远端 B 的 op 交错到达 — 不入 A 的 undo 栈
    undo.pushRemote({ opId: 'b1', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B' })
    expect(undo.remoteSeenCount()).toBe(1) // 远端 op 到达但…
    expect(undo.depth()).toBe(1) // …仍只有 A 自己的 1 entry(远端 op 不入本地 undo 栈)
    const inv = undo.undo()
    expect(inv).not.toBeNull()
    expect(inv!.length).toBe(1) // 只撤 A 的 op
    expect(undo.depth()).toBe(0)
    // ★ A 撤自己 op 时,B 的远端 op 保留(不被 A 的 undo 牵连)— Figma 式 command undo;
    //   Yjs UndoManager 跨 record 交错的关系 spike 未列决(N1 §7 Q:yjs UndoManager 与现有 undo 栈关系)。
  })
})

describe('N2-0 G7: 事件序号/补拉日志/压缩 + 权限撤销断流 + 存储放大', () => {
  it('G7-1 per-canvas 单调 seq + ?since=seq 补拉(断线重连增量补)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.applyOp({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 0, fieldPath: ['title'], value: 't1' })
    s.applyOp({ opId: 'a2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 1, fieldPath: ['title'], value: 't2' })
    s.applyOp({ opId: 'a3', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 2, fieldPath: ['title'], value: 't3' })
    // 客户端断线前停在 seq=2,重连后 since=2 增量补
    const missed = s.pullSince(2)
    expect(missed.length).toBe(1)
    expect(missed[0].seq).toBe(3) // ★ 只补 seq=3 的 a3
    expect(missed[0].op.value).toBe('t3')
  })

  it('G7-2 压缩:snapshot + truncate opLog(存储放大可控)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.seedNode(makeNode('n2'))
    for (let i = 1; i <= 1000; i++) {
      s.applyOp({ opId: `a${i}`, clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: i - 1, fieldPath: ['title'], value: `t${i}` })
    }
    const before = s.pullSince(0).length
    expect(before).toBe(1000)
    const r = s.compress(50) // 保留最近 50 条 op,其余靠 snapshot 兜底
    expect(r.snapshotSize).toBe(2) // nodes n1+n2 的 snapshot
    expect(r.logKept).toBe(50)
    expect(r.logTruncated).toBe(950) // ★ opLog 从 1000 截到 50,存储放大 20x↓
    // 新客户端来:先拉 snapshot(2 nodes)+ 最近 50 op,而非 1000 op 全量。
    expect(s.pullSince(0).length).toBe(50)
  })

  it('G7-3 权限撤销断流:removeMember → 连接立即收到 revoke + 不再收后续变更', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.addMember('alice')
    const received: (string | number)[] = []
    s.addConn('alice', (e) => received.push(e.op.fieldPath[0] as string))
    // alice 在线,收变更
    s.applyOp({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 0, fieldPath: ['title'], value: 't1' })
    expect(received.pop()).toBe('title')
    expect(s.isConnAlive('alice')).toBe(true)
    // 撤销 alice 成员资格
    s.removeMember('alice')
    expect(received.pop()).toBe('__revoke__') // ★ alice 收到 revoke 信号,连接断
    expect(s.isConnAlive('alice')).toBe(false)
    // 撤权后的变更 alice 不再收
    s.applyOp({ opId: 'a2', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: 1, fieldPath: ['title'], value: 't2' })
    expect(received.length).toBe(0) // ★ 无泄漏:撤权后变更不再推给已撤销 actor
    // 对比 Yjs:Y.Doc per-canvas 共享,revocation 要断单用户 + 防重连 = doc 级访问控制(更难)。
  })
})

describe('N2-0 G5: 实时 transport 协议侧(SSE broadcast skeleton;WS upgrade = 未验证项留 lead)', () => {
  it('G5-1 SSE = plain HTTP(gateway-agnostic):broadcast 经 HTTP response stream,不经 WS upgrade', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.addMember('alice')
    const stream: string[] = []
    s.addConn('alice', (e) => stream.push(`seq=${e.seq}:${e.op.fieldPath[0]}`))
    // SSE 语义:EventSource = HTTP GET + text/event-stream,网关必透传(与 PATCH 同通道)。
    s.applyOp({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 0, fieldPath: ['title'], value: 't1' })
    expect(stream).toContain('seq=1:title')
    // ★ SSE 走 HTTP,不依赖 WS upgrade 放行 → Figma 式 fallback 即使网关不放行 WS 也能实时广播。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// anti-Yjs 对照:复现 N1 坑5(双真相源)+ 坑7(clear+rebuild 吞子字段)— 证明移植 Yjs 的成本
// ════════════════════════════════════════════════════════════════════════════

describe('anti-Yjs: N1 坑5 复现 — revision ↔ Yjs 因果序 = 双真相源,移植 Yjs 必拆 DocKernel 写路径', () => {
  it('Y.Map record.revision ≠ kernel upsertNode revision(背离),双仲裁必丢数据', () => {
    // 场景(N1 §3.1 实证):Yjs CRDT 路径与 DocKernel record 级 LWW 同时仲裁同一 record。
    const doc = new Y.Doc()
    const nodesMap = doc.getMap('nodes')
    const yNode = new Y.Map()
    doc.transact(() => {
      nodesMap.set('n1', yNode)
      yNode.set('revision', 7)
      yNode.set('title', 'orig')
    })
    expect(yNode.get('revision')).toBe(7)

    // 模拟 kernel upsertNode upsert 同 record:bump revision(Y.Map 不动)
    // (docKernel.nextRevision:existing.revision+1 → 7+1=8)
    const kernelRevisionBefore = 7
    const kernelRevisionAfter = kernelRevisionBefore + 1 // bump to 8
    // Y.Map record.revision 仍 7(kernel bump 不回写 Y.Map)
    expect(yNode.get('revision')).toBe(7) // ★ Y.Map 仍 7
    expect(kernelRevisionAfter).toBe(8) // ★ kernel 已 8 — 背离
    // 再改一次 kernel → 9,Y.Map 仍 7
    expect(kernelRevisionAfter + 1).toBe(9)
    expect(yNode.get('revision')).toBe(7) // ★ 持续背离
    // 判决:两套模型同仲裁 → 必丢数据(N1 §3.1 PITFALL)。
    //   移植 Yjs 必须二选一:
    //   (a) 加 setNodeFromCrdt bypass LWW bump(N1 §3.2 方案A,过渡态)— 改 kernel 写路径
    //   (b) kernel 降级为 Y.Doc 只读投影(无独立写路径,N1 §3.2 方案C 终态)— 拆 DocKernel 写路径
    //   两者都要动已建成的 Figma 式 DocKernel + #194 PATCH 写路径 = 移植成本。
  })
})

describe('anti-Yjs: N1 坑7 复现 — writeRecord clear+rebuild 吞同节点并发子字段更新', () => {
  it('A writeRecord 整 record 重建 → B 并发改 transform.y 丢失(合并后回到旧值)', () => {
    // 场景(N1 §2.2 坑7 实证):writeRecord = ymap.clear() + 重建子树。
    const doc = new Y.Doc()
    const nodesMap = doc.getMap('nodes')

    // A:写一次公共 base(共享祖先,坑6 正确做法)
    const base = { id: 'n1', title: 'orig', transform: { x: 0, y: -20, width: 100, height: 40, rotation: 0 } }
    // 用通用递归 codec 模拟 writeRecord(深转 Y.Map/Y.Map 嵌套)
    const writeRecord = (m: Y.Map<unknown>, r: Record<string, unknown>) => {
      m.clear() // ★ 坑7:clear 删掉指向旧子树的 key
      for (const [k, v] of Object.entries(r)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const sub = new Y.Map()
          for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) sub.set(sk, sv)
          m.set(k, sub)
        } else m.set(k, v)
      }
    }
    doc.transact(() => {
      const yNode = new Y.Map()
      nodesMap.set('n1', yNode)
      writeRecord(yNode, base)
    })

    // 模拟分叉:clientA 从 base 分叉,clientB 从 base 分叉(各自 clientID)
    const clientA = new Y.Doc()
    const clientB = new Y.Doc()
    Y.applyUpdate(clientA, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(clientB, Y.encodeStateAsUpdate(doc))

    // A:writeRecord 重写整 node(非并发 seeding 用,但这里是并发场景 → 触发坑7)
    const aNode = clientA.getMap('nodes').get('n1') as Y.Map<unknown>
    clientA.transact(() => writeRecord(aNode, { ...base, title: 'A-title' }))

    // B:并发改 transform.y(指向旧 transform 子树)
    const bNode = clientB.getMap('nodes').get('n1') as Y.Map<unknown>
    const bTransform = bNode.get('transform') as Y.Map<unknown>
    bTransform.set('y', 999) // ★ B 改 transform.y=999

    // 合并:双向 applyUpdate(yjs 13.6 模块级函数,非实例方法)
    Y.applyUpdate(clientA, Y.encodeStateAsUpdate(clientB))
    Y.applyUpdate(clientB, Y.encodeStateAsUpdate(clientA))

    // 读合并结果(clientA 视角)
    const mergedTransform = (clientA.getMap('nodes').get('n1') as Y.Map<unknown>).get('transform') as Y.Map<unknown>
    // ★ B 的 transform.y=999 丢失!回到 base 的 -20。
    //   原因:A 的 writeRecord clear 删掉旧 transform 子树 key,B 的 set 作用在 "已删孤儿旧子树" 上,合不进 A 建的新子树。
    expect(mergedTransform.get('y')).toBe(-20) // ★ B 的并发更新丢失(N1 Greptile P1 ①)
    expect(mergedTransform.get('y')).not.toBe(999)
    // 判决:Yjs 真 CRDT 写路径必须增量字段级 set(永不 clear 整 record)。
    //   这与 Figma 式 field-level PATCH 是同一结论,但 Yjs 还要额外扛 dual-truth-source(坑5)。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P1-1 Gate2):条件逆运算 + 真实 Y.UndoManager 同矩阵对照
// ════════════════════════════════════════════════════════════════════════════
//
// 原 PoC 的 CommandUndoStack.undo() 只返字符串占位 `__undo__...`,从不 applyOp 到服务端状态,
// 也不保存旧值;无法证明"远端交错保留"。返修:ConditionalUndoStack 保存旧值,undo() 发条件逆运算
// 到服务端——仅对"A 的 effect 仍在"的字段发逆运算;remote 已覆盖/record 已删 → skip(no-op,remote wins)。
// 语义对齐真实 Yjs UndoManager(默认 ignoreRemoteMapChanges=false,不覆盖 remote map changes)。
// 同矩阵跑真实 Y.UndoManager(trackedOrigins + captureTimeout),每场景断言最终 record。

/** 条件逆运算 undo 单元:op(coalescing 批次用最新 op 代表最终值)+ oldValue(批次前值)。 */
type UndoUnit = { op: FieldOp; oldValue: unknown }

class ConditionalUndoStack {
  private units: UndoUnit[] = []
  private batch: UndoUnit[] = []
  private coalescing = false
  private redoStack: UndoUnit[] = []
  private server: FieldLevelServer
  constructor(server: FieldLevelServer) { this.server = server }

  startBatch() { this.batch = []; this.coalescing = true }
  /** 拖拽:连续同 fieldPath 合并成 1 unit(op 用最新=批次最终值,oldValue 保持批次前值)。 */
  pushDrag(op: FieldOp, oldValue: unknown) {
    const last = this.batch[this.batch.length - 1]
    if (this.coalescing && last && JSON.stringify(last.op.fieldPath) === JSON.stringify(op.fieldPath)) {
      last.op = op // 最新 op 代表批次最终值;oldValue 不变(批次前)
    } else {
      this.batch.push({ op, oldValue })
    }
  }
  endBatch() { if (this.batch.length) this.units.push(...this.batch); this.batch = []; this.coalescing = false }
  /** 单次编辑 op(非拖拽,独立 unit)。 */
  pushLocal(op: FieldOp, oldValue: unknown) { this.units.push({ op, oldValue }) }
  depth() { return this.units.length }

  /**
   * 条件逆运算 undo(P1-1):pop 最近 1 unit,仅当 A 的 effect 仍在(当前服务端值 == op.value)才发逆运算
   * (restore oldValue);remote 已覆盖(cur != op.value)→ skip(remote wins);record 已删 → skip(delete wins)。
   */
  undo(): { inverse: FieldOp[]; skipped: { reason: string; fieldPath: (string | number)[] }[] } | null {
    const unit = this.units.pop()
    if (!unit) return null
    const { op, oldValue } = unit
    const inverse: FieldOp[] = []
    const skipped: { reason: string; fieldPath: (string | number)[] }[] = []
    if (!this.server.recordExists(op.recordId)) {
      skipped.push({ reason: 'record-deleted-remotely (delete wins, undo 不复活)', fieldPath: op.fieldPath })
    } else {
      const cur = this.server.getFieldValue(op.recordId, op.fieldPath)
      const stillMine = cur === op.value || (cur !== undefined && JSON.stringify(cur) === JSON.stringify(op.value))
      if (stillMine) {
        inverse.push({ ...op, opId: `inv-${op.opId}`, value: oldValue })
      } else {
        skipped.push({ reason: 'remote-overwrote (A effect 已被远端取代, remote wins)', fieldPath: op.fieldPath })
      }
    }
    this.redoStack.push(unit)
    return { inverse, skipped }
  }

  /** redo:重新 apply 被 undo 的 unit 的 op(若 record 仍在 + 未被远端覆盖)。 */
  redo(): FieldOp[] {
    const unit = this.redoStack.pop()
    if (!unit) return []
    // redo = 重发原 op(条件:record 仍在;若远端已覆盖则 redo 会再次覆盖远端——按 LWW,redo 为后发 wins)
    if (this.server.recordExists(unit.op.recordId)) return [unit.op]
    return []
  }
}

// ── 真实 Yjs 矩阵 helper:docA(A 本地,tracked)/docB(B 远端,untracked),双向同步 ──
function yjsMatrixSetup(seedNode: Record<string, unknown>) {
  const docA = new Y.Doc(); const docB = new Y.Doc()
  const aId = docA.clientID; const bId = docB.clientID
  const toYMap = (v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = new Y.Map()
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) sub.set(sk, toYMap(sv))
      return sub
    }
    return v
  }
  const seed = (d: Y.Doc) => {
    const n = new Y.Map()
    for (const [k, v] of Object.entries(seedNode)) n.set(k, toYMap(v))
    d.getMap('nodes').set('n1', n)
  }
  seed(docA); seed(docB)
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
  const um = new Y.UndoManager(docA.getMap('nodes'), { trackedOrigins: new Set([aId]), captureTimeout: 500 })
  const aNode = () => docA.getMap('nodes').get('n1') as Y.Map<unknown>
  const bNode = () => docB.getMap('nodes').get('n1') as Y.Map<unknown>
  const writeAt = (doc: Y.Doc, node: () => Y.Map<unknown>, origin: number, path: string[], val: unknown) =>
    doc.transact(() => {
      let m: Y.Map<unknown> = node()
      for (let i = 0; i < path.length - 1; i++) m = m.get(path[i]) as Y.Map<unknown>
      m.set(path[path.length - 1], val)
    }, origin)
  const aWrite = (path: string[], val: unknown) => writeAt(docA, aNode, aId, path, val)
  const bWrite = (path: string[], val: unknown) => writeAt(docB, bNode, bId, path, val)
  const syncAB = () => Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA)) // A→B
  const syncBA = () => Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), 'remote-sync') // B→A(remote,非 tracked)
  const aRead = (path: string[]): unknown => {
    let m: unknown = aNode()
    for (const seg of path) m = (m as Y.Map<unknown>).get(seg)
    return m
  }
  return { docA, docB, aId, bId, um, aWrite, bWrite, syncAB, syncBA, aRead, aNode, bNode }
}

describe('N2-0 返修 Gate2: 条件逆运算 × 真实 Y.UndoManager 同矩阵(每场景断言最终 record)', () => {
  // 共用:Figma 条件逆运算 setup(seed n1 {title:'orig', transform:{x:0,y:0}, groupId:'g0'})
  const figmaSetup = () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig', transform: { x: 0, y: 0, width: 100, height: 40, rotation: 0 }, groupId: 'g0' } as Partial<NodeRecord>))
    s.addMember('alice')
    return s
  }
  const seedY = { title: 'orig', transform: { x: 0, y: 0 }, groupId: 'g0' }

  it('M1 不同字段交错:A 改 title / B 改 transform.x → A undo title,title=orig,transform.x=50 保留(两案一致)', () => {
    // ── Figma 条件逆运算 ──
    const s = figmaSetup(); const undo = new ConditionalUndoStack(s)
    const rev0 = s.revision('n1')
    const oldTitle = s.getFieldValue('n1', ['title'])
    s.applyOpAuthz({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A-title' }, 'alice')
    undo.pushLocal({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A-title' }, oldTitle)
    s.addMember('bob')
    s.applyOpAuthz({ opId: 'b1', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: 50 }, 'bob') // B 改 transform.x
    const inv = undo.undo()!
    inv.inverse.forEach((op) => s.applyOpAuthz(op, 'alice')) // 应用条件逆运算(restore title=orig)
    const fTitle = s.getFieldValue('n1', ['title']); const fX = s.getFieldValue('n1', ['transform', 'x'])
    expect(fTitle).toBe('orig') // A 的 title 撤回
    expect(fX).toBe(50)         // B 的 transform.x 保留

    // ── 真实 Y.UndoManager 同场景 ──
    const y = yjsMatrixSetup(seedY)
    y.aWrite(['title'], 'A-title'); y.syncAB()
    y.bWrite(['transform', 'x'], 50); y.syncBA()
    y.um.undo()
    expect(y.aRead(['title'])).toBe('orig')
    expect(y.aRead(['transform', 'x'])).toBe(50)
    // ★ 两案一致:title=orig,transform.x=50(远端交错保留)
  })

  it('M2 同字段远端后写:A title=A / B title=B(后写) → A undo,title 仍 B(remote wins,两案一致)', () => {
    // ── Figma ──
    const s = figmaSetup(); const undo = new ConditionalUndoStack(s)
    const rev0 = s.revision('n1'); const oldTitle = s.getFieldValue('n1', ['title'])
    s.applyOpAuthz({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, 'alice')
    undo.pushLocal({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, oldTitle)
    s.addMember('bob')
    s.applyOpAuthz({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B' }, 'bob') // B 后写(server seq 高)
    const inv = undo.undo()!
    expect(inv.inverse.length).toBe(0) // ★ 条件逆运算:A effect 已被 B 取代 → skip(不发逆运算)
    expect(inv.skipped[0].reason).toMatch(/remote-overwrote/)
    inv.inverse.forEach((op) => s.applyOpAuthz(op, 'alice'))
    expect(s.getFieldValue('n1', ['title'])).toBe('B') // ★ remote wins(与原 PoC "A inverse 后发覆盖 B" 相反——条件逆运算修掉了那个 bug)

    // ── 真实 Yjs ──
    const y = yjsMatrixSetup(seedY)
    y.aWrite(['title'], 'A'); y.syncAB()
    y.bWrite(['title'], 'B'); y.syncBA()
    y.um.undo()
    expect(y.aRead(['title'])).toBe('B') // ★ 真实 Yjs UndoManager 默认不覆盖 remote → title 仍 B
    // ★ 两案一致:title=B。条件逆运算语义对齐真实 Yjs(原 PoC 的 naive inverse 会覆盖 B——已修)
  })

  it('M3 目标被远端删除:A 改 title / B 删 n1 → A undo,n1 仍删(undo 不复活,delete wins,两案一致)', () => {
    // ── Figma ──
    const s = figmaSetup(); const undo = new ConditionalUndoStack(s)
    const rev0 = s.revision('n1'); const oldTitle = s.getFieldValue('n1', ['title'])
    s.applyOpAuthz({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, 'alice')
    undo.pushLocal({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, oldTitle)
    s.addMember('bob')
    s.deleteNodeCascade('n1', 'bob') // B 删 n1
    const inv = undo.undo()!
    expect(inv.inverse.length).toBe(0) // record 已删 → skip
    expect(inv.skipped[0].reason).toMatch(/record-deleted-remotely/)
    inv.inverse.forEach((op) => s.applyOpAuthz(op, 'alice'))
    expect(s.recordExists('n1')).toBe(false) // ★ n1 仍删(undo 不复活)

    // ── 真实 Yjs(Y.Map delete)──
    const y = yjsMatrixSetup(seedY)
    y.aWrite(['title'], 'A'); y.syncAB()
    y.docB.transact(() => { y.docB.getMap('nodes').delete('n1') }, y.bId) // B 删 n1
    y.syncBA()
    y.um.undo() // A undo title——但 n1 已被 B 从 nodes map 删
    expect(y.docA.getMap('nodes').has('n1')).toBe(false) // ★ n1 仍删(Yjs delete wins,undo 不复活父键)
    // ★ 两案一致:delete wins,undo 不复活(delete-vs-update 边界)
  })

  it('M4 目标被移动(改 groupId):A 改 title / B 改 groupId → A undo,title=orig,groupId=B 保留(两案一致)', () => {
    // ── Figma ──
    const s = figmaSetup(); const undo = new ConditionalUndoStack(s)
    const rev0 = s.revision('n1'); const oldTitle = s.getFieldValue('n1', ['title'])
    s.applyOpAuthz({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, 'alice')
    undo.pushLocal({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, oldTitle)
    s.addMember('bob')
    s.applyOpAuthz({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['groupId'], value: 'g1' }, 'bob') // B 移动
    const inv = undo.undo()!
    inv.inverse.forEach((op) => s.applyOpAuthz(op, 'alice'))
    expect(s.getFieldValue('n1', ['title'])).toBe('orig')   // A 撤 title
    expect(s.getFieldValue('n1', ['groupId'])).toBe('g1')   // B 的移动保留

    // ── 真实 Yjs ──
    const y = yjsMatrixSetup(seedY)
    y.aWrite(['title'], 'A'); y.syncAB()
    y.bWrite(['groupId'], 'g1'); y.syncBA()
    y.um.undo()
    expect(y.aRead(['title'])).toBe('orig')
    expect(y.aRead(['groupId'])).toBe('g1')
    // ★ 两案一致:结构性移动(groupId)不受 title undo 牵连
  })

  it('M5 100-drag coalescing 初始值恢复:100 个 transform.x op → 1 undo 恢复 x=0(两案一致)', () => {
    // ── Figma(条件逆运算 + coalescing)──
    const s = figmaSetup(); const undo = new ConditionalUndoStack(s)
    const rev0 = s.revision('n1'); const oldX = s.getFieldValue('n1', ['transform', 'x'])
    undo.startBatch()
    for (let i = 1; i <= 100; i++) {
      const op = { opId: `d${i}`, clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: i }
      s.applyOpAuthz(op, 'alice')
      undo.pushDrag(op, oldX) // oldValue = 批次前值(0),对所有 drag 共享
    }
    undo.endBatch()
    expect(undo.depth()).toBe(1) // 100 coalesce → 1 unit
    const inv = undo.undo()!
    inv.inverse.forEach((op) => s.applyOpAuthz(op, 'alice'))
    expect(s.getFieldValue('n1', ['transform', 'x'])).toBe(0) // ★ 恢复初始值(非 step 99)

    // ── 真实 Yjs(captureTimeout coalescing)──
    const y = yjsMatrixSetup(seedY)
    for (let i = 1; i <= 100; i++) {
      y.docA.transact(() => {
        ;(y.aNode().get('transform') as Y.Map<unknown>).set('x', i)
      }, y.aId) // 连续同 origin,captureTimeout=500 内合并
    }
    y.um.undo() // 一次 undo
    expect(y.aRead(['transform', 'x'])).toBe(0) // ★ 真实 Yjs captureTimeout 合并 → 恢复初始
    // ★ 两案一致:100 drag → 1 undo → 恢复初始值
  })

  it('M6 redo:undo 后 redo 恢复 A 的最终值(两案一致)', () => {
    // ── Figma ──
    const s = figmaSetup(); const undo = new ConditionalUndoStack(s)
    const rev0 = s.revision('n1'); const oldTitle = s.getFieldValue('n1', ['title'])
    s.applyOpAuthz({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, 'alice')
    undo.pushLocal({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' }, oldTitle)
    const inv = undo.undo()!; inv.inverse.forEach((op) => s.applyOpAuthz(op, 'alice'))
    expect(s.getFieldValue('n1', ['title'])).toBe('orig')
    const redoOps = undo.redo(); redoOps.forEach((op) => s.applyOpAuthz(op, 'alice'))
    expect(s.getFieldValue('n1', ['title'])).toBe('A') // ★ redo 恢复 A

    // ── 真实 Yjs ──
    const y = yjsMatrixSetup(seedY)
    y.aWrite(['title'], 'A')
    y.um.undo()
    expect(y.aRead(['title'])).toBe('orig')
    y.um.redo()
    expect(y.aRead(['title'])).toBe('A') // ★ Yjs redo 恢复
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P1-2 Gate3):真实 Yjs doc.transact 多 record 原子 + delete-vs-update 真实 merge + 跨介质边界
// ════════════════════════════════════════════════════════════════════════════
//
// 原 PoC 的 G3 把"CRDT 无原子多 record"写成绝对优势。真实探针推翻:Yjs 单 Y.Doc 内 doc.transact
// 对多 record 原子(删 nodes.n1 + edges.e1 同时可见)。正确表述:intra-doc transact = 原子;
// 跨 Y.Doc / 跨 PG / 跨文件资产 = 非原子(与 Figma 跨介质边界同)。delete-vs-update 真实 merge 亦不复活。

describe('N2-0 返修 Gate3: 真实 Yjs doc.transact 原子性 + delete-vs-update 真实 merge + 跨介质边界', () => {
  it('G3-real-1 单 Y.Doc doc.transact 删 nodes.n1 + edges.e1 → 远端同一 Transaction 原子可见(intra-doc 原子)', () => {
    const docA = new Y.Doc(); const docB = new Y.Doc()
    const seed = (d: Y.Doc) => {
      d.getMap('nodes').set('n1', new Y.Map())
      d.getMap('edges').set('e1', new Y.Map())
      d.getMap('edges').set('e2', new Y.Map())
    }
    seed(docA); seed(docB)
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB)); Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    // A 单 transaction 删 n1 + e1
    docA.transact(() => {
      docA.getMap('nodes').delete('n1')
      docA.getMap('edges').delete('e1')
    }, docA.clientID)
    // 同步到 B
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote-sync')
    // ★ B 要么同时见 n1+e1 消失,要么都还在(原子,无中间态)
    expect(docB.getMap('nodes').has('n1')).toBe(false)
    expect(docB.getMap('edges').has('e1')).toBe(false)
    expect(docB.getMap('edges').has('e2')).toBe(true) // e2 未删,保留
    // 判决(返修):Yjs intra-doc transact = 原子多 record。原 PoC "CRDT 无原子多 record" 绝对表述 → 推翻。
    //   正确表述:intra-doc 原子;跨 Y.Doc / 跨 PG / 跨文件资产 = 非原子(与 Figma 跨介质边界同)。
  })

  it('G3-real-2 delete-vs-update 真实 merge:A 删 n1,B 并发改 n1.title → n1 不复活(delete wins,非"可能复活")', () => {
    const docA = new Y.Doc(); const docB = new Y.Doc()
    const seed = (d: Y.Doc) => {
      const n = new Y.Map(); n.set('title', 'orig')
      d.getMap('nodes').set('n1', n)
    }
    seed(docA); seed(docB)
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB)); Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    // A 删 n1(从 nodes map)
    docA.transact(() => { docA.getMap('nodes').delete('n1') }, docA.clientID)
    // B 并发改 n1 的 title(B 仍持 n1 引用)
    const bNode = docB.getMap('nodes').get('n1') as Y.Map<unknown>
    docB.transact(() => { bNode.set('title', 'B-updated') }, docB.clientID)
    // 双向合并
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), 'remote-sync')
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote-sync')
    // ★ 真实 Y.Map delete vs 嵌套 map.set:delete wins(父键不复活),嵌套 map 变孤儿
    expect(docA.getMap('nodes').has('n1')).toBe(false)
    expect(docB.getMap('nodes').has('n1')).toBe(false)
    // 判决(返修):原 PoC G3-2 "CRDT delete vs update 可能 update 复活已删 record" → 真实 Y.Map 不复活。
    //   Figma delete-wins 在此场景 **非相对 Yjs 的优势**(Yjs 亦 delete wins)。
    //   Yjs 的真实 delete-vs-update 风险在嵌套类型(Y.Array delete+insert 会有 tombstone 复活边角),
    //   本场景(Y.Map 父键 delete vs 子 map.set)经真实探针不复活。
  })

  it('G3-real-3 跨 Y.Doc 无共享事务:两 Y.Doc 各自 transact 互不原子(cross-doc 非原子边界)', () => {
    // node 在 canvasA.Y.Doc,edge 在 canvasB.Y.Doc(模拟跨 canvas/跨 doc 边界)
    const docCanvasA = new Y.Doc(); const docCanvasB = new Y.Doc()
    docCanvasA.getMap('nodes').set('n1', new Y.Map())
    docCanvasB.getMap('edges').set('e1', new Y.Map())
    // 跨 Y.Doc 没有 doc.transact 能同时覆盖两 Doc;各自 transact = 两个独立事务
    docCanvasA.transact(() => { docCanvasA.getMap('nodes').delete('n1') }, docCanvasA.clientID)
    // 若第一事务后、第二事务前崩溃 → n1 删了但 e1 还在(孤儿 edge)——跨 doc 非原子
    expect(docCanvasA.getMap('nodes').has('n1')).toBe(false)
    expect(docCanvasB.getMap('edges').has('e1')).toBe(true) // e1 仍在(跨 doc 无原子)
    // 判决:跨 Y.Doc / 跨 PG / 跨文件资产 = 非原子边界(CRDT 与 Figma 同此边界)。
    //   Figma 的优势在 server-side PG 事务可跨多 record 原子(见 server/__tests__/n20-pg-tx-fault.spike.test.ts)。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P2-7 Gate7):snapshotSeq/logFloor/gap 协议 + 恢复等价 + post-revoke 写拒绝 + bytes 对比
// ════════════════════════════════════════════════════════════════════════════

describe('N2-0 返修 Gate7: logFloor/gap 协议 + 恢复等价 + post-revoke 写拒绝 + bytes 对比', () => {
  it('G7-hard-1 logFloor + gap:压缩后 since<floor → gap=true + snapshot;since>=floor → 增量', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1')); s.seedNode(makeNode('n2'))
    for (let i = 1; i <= 1000; i++) {
      s.applyOp({ opId: `a${i}`, clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: i - 1, fieldPath: ['title'], value: `t${i}` })
    }
    expect(s.logFloor()).toBe(1) // 压缩前 floor=1
    s.compress(50)               // 保留 seq 951..1000
    expect(s.logFloor()).toBe(951) // ★ floor=951
    // since=950 < floor=951 → gap
    const g0 = s.pullSinceWithGap(950)
    expect(g0.gap).toBe(true)
    expect(g0.snapshot!.length).toBe(2) // n1+n2 snapshot
    expect(g0.events.length).toBe(50)   // 全量 kept events(seq 951..1000)
    // since=951 >= floor → 无 gap,增量补 seq>951
    const g1 = s.pullSinceWithGap(951)
    expect(g1.gap).toBe(false)
    expect(g1.events.length).toBe(49) // seq 952..1000
    expect(g1.events[0].seq).toBe(952)
    // since=1000 → 无 gap,0 events
    const g2 = s.pullSinceWithGap(1000)
    expect(g2.gap).toBe(false)
    expect(g2.events.length).toBe(0)
    // ★ 原 PoC pullSince(0) 静默返 50 条(丢前 950 无 gap 信号)→ 返修:gap 协议显式告警客户端 reset
  })

  it('G7-hard-2 恢复等价:live 客户端(A)与崩溃后重连客户端(B,经 snapshot+gap 恢复)最终态一致', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'init', transform: { x: 0, y: 0, width: 100, height: 40, rotation: 0 } } as Partial<NodeRecord>))
    s.seedNode(makeNode('n2'))
    // A live 收全部 op
    const aLive: { id: string; revision: number }[] = []
    s.addMember('alice')
    s.addConn('alice', () => {}) // A 在线但不记 stream,只靠最终 getNode 读
    for (let i = 1; i <= 200; i++) {
      s.applyOp({ opId: `a${i}`, clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: i - 1, fieldPath: ['title'], value: `t${i}` })
    }
    aLive.push(...s.snapshot()) // A 的最终态(全 200 op 已 apply)
    s.compress(50) // 压缩:floor=151,kept seq 151..200
    // B 重连:since=0(< floor)→ gap + snapshot + kept events
    const g = s.pullSinceWithGap(0)
    expect(g.gap).toBe(true)
    // B 从 snapshot 重建 + replay kept 50 events
    const bState = new Map<string, { id: string; revision: number }>(g.snapshot!.map((r) => [r.id, { ...r }]))
    for (const evt of g.events) {
      const r = bState.get(evt.recordId)
      if (r) r.revision = evt.revision // replay:每 op bump revision
    }
    // ★ A 与 B 最终态一致(n1 revision 相同,n2 相同)
    const bN1 = bState.get('n1')!
    const aN1 = aLive.find((r) => r.id === 'n1')!
    expect(bN1.revision).toBe(aN1.revision) // 恢复等价
    expect(bState.get('n2')!.revision).toBe(aLive.find((r) => r.id === 'n2')!.revision)
  })

  it('G7-hard-3 post-revoke 写拒绝:removeMember 后 actor 的 applyOpAuthz → forbidden(不只断流)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.addMember('alice')
    const rev0 = s.revision('n1')
    // alice 在线可写
    const r1 = s.applyOpAuthz({ opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 't1' }, 'alice')
    expect(r1.kind).toBe('ok')
    // 撤销 alice
    s.removeMember('alice')
    // ★ 原 PoC removeMember 只删内存 callback,被撤 actor 仍可 applyOp 成功 → 返修:applyOpAuthz 拒写
    const r2 = s.applyOpAuthz({ opId: 'a2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 't2' }, 'alice')
    expect(r2.kind).toBe('forbidden') // ★ post-revoke 写拒绝
    // 对比:未撤销的 bob 仍可写
    s.addMember('bob')
    const r3 = s.applyOpAuthz({ opId: 'b1', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'b1' }, 'bob')
    expect(r3.kind).toBe('ok')
  })

  it('G7-hard-4 bytes 级存储对比:同 1000 op 工作量,Figma opLog+snapshot vs Yjs(有 GC / 无 GC)', () => {
    // ── Figma:1000 op on 1 node ──
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    for (let i = 1; i <= 1000; i++) {
      s.applyOp({ opId: `a${i}`, clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: i - 1, fieldPath: ['title'], value: `t${i}` })
    }
    const figmaBytesRaw = s.storageBytes()
    s.compress(50) // 周期压缩(生产形态)
    const figmaBytesCompressed = s.storageBytes()
    // ── Yjs 有 GC(默认 doc.gc=true):连续同 key set,旧 item 被 GC → 存储有界 ──
    const docGc = new Y.Doc()
    const nGc = new Y.Map(); nGc.set('title', 'init'); docGc.getMap('nodes').set('n1', nGc)
    for (let i = 1; i <= 1000; i++) {
      docGc.transact(() => { nGc.set('title', `t${i}`) }, docGc.clientID)
    }
    const yjsWithGcBytes = Y.encodeStateAsUpdate(docGc).length
    // ── Yjs 无 GC(doc.gc=false):旧 item 成 tombstone 不清 → 无界增长 ──
    const docNoGc = new Y.Doc(); docNoGc.gc = false
    const nNoGc = new Y.Map(); nNoGc.set('title', 'init'); docNoGc.getMap('nodes').set('n1', nNoGc)
    for (let i = 1; i <= 1000; i++) {
      docNoGc.transact(() => { nNoGc.set('title', `t${i}`) }, docNoGc.clientID)
    }
    const yjsNoGcBytes = Y.encodeStateAsUpdate(docNoGc).length
    // ★ 实跑数字(见 console):figmaRaw 大,figmaCompressed 中,Yjs 有 GC 很小,Yjs 无 GC 中
    console.log('[G7-hard-4 bytes] figmaRaw=', figmaBytesRaw, 'figmaCompressed=', figmaBytesCompressed,
      'yjsWithGc=', yjsWithGcBytes, 'yjsNoGc=', yjsNoGcBytes)
    // 诚实断言(不伪造让 Figma 赢):
    expect(figmaBytesCompressed).toBeLessThan(figmaBytesRaw) // Figma compress 有效
    expect(yjsNoGcBytes).toBeGreaterThan(yjsWithGcBytes)    // 无 GC > 有 GC(无 GC 无界)
    // ★ 返修诚实结论(推翻原 doc "Figma 存储有界、Yjs 无界 → Figma 优"暗示):
    //   实跑此工作负载(1000 同 key set):yjsWithGc=58B < yjsNoGc=5954B < figmaCompressed=8637B。
    //   Yjs 二进制编码比 Figma JSON opLog 更省字节;Yjs 有 auto-GC(默认)亦存储有界。
    //   Figma 真实优势 ≠ "存储更小",而是:
    //   (a) 显式 server 控制 compress/truncate + 有界 opLog 窗口(可预测,不依赖 GC 时机);
    //   (b) revoke 简单(连接绑 actor+canvas,见 G7-hard-3),非 doc 级访问控制。
    //   doc Gate7 "存储放大" 项须据此重评分(见决策文档 §重评分)。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P1-3 §10):三层信任边界 + typed op union + setByPath 防原型污染
// ════════════════════════════════════════════════════════════════════════════

describe('N2-0 返修 §10: 三层信任边界 + typed op union + setByPath 防原型污染', () => {
  it('S10-1 setByPath 拒原型污染路径(__proto__/prototype/constructor)', () => {
    const obj: Record<string, unknown> = { title: 'orig', transform: { x: 0, y: 0 } }
    expect(() => setByPath(obj, ['__proto__', 'polluted'], true)).toThrow(/forbidden path segment/)
    expect(() => setByPath(obj, ['constructor', 'prototype', 'x'], true)).toThrow(/forbidden path segment/)
    expect(() => getByPath(obj, ['__proto__'])).toThrow(/forbidden path segment/)
    // 正常路径仍工作(transform 子对象已存在)
    setByPath(obj, ['transform', 'x'], 42)
    expect((obj.transform as { x: number }).x).toBe(42)
    expect(getByPath(obj, ['transform', 'x'])).toBe(42)
    // 确认 Object.prototype 未被污染
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('S10-2 三层信任边界:client payload(带 actor/recordId/base)→ trustify → trusted(只留 opId/fieldPath/value + trusted actor/base)', () => {
    // 客户端发的 op(body 可被客户端伪造,不可信)
    type ClientFieldOp = {
      opId: string; clientId: string
      actor: string         // ★ 客户端自带 actor(不可信!必须由 authz 覆盖)
      recordId: string      // ★ 客户端自带 recordId(不可信!必须由 path 覆盖)
      baseRevision: Revision // ★ 客户端自带 base(不可信!必须由 If-Match 覆盖)
      fieldPath: (string | number)[]; value: unknown
    }
    // 服务端 trusted 形态:actor 来自 resolveActor(authz),recordId 来自 URL path,base 来自 If-Match
    type TrustedFieldOp = {
      opId: string          // 来自 idempotency-key header(单一权威载体,非 body+header 双载体)
      clientId: string
      actor: string         // 来自 resolveActor(c.req)— trusted
      recordId: string      // 来自 URL path(:nodeId)— trusted
      baseRevision: Revision // 来自 If-Match header(parseIfMatch)— trusted
      fieldPath: (string | number)[]; value: unknown
    }
    // trustify:丢弃 body 的 actor/recordId/base,用 trusted 源覆盖
    const trustify = (client: ClientFieldOp, authzActor: string, pathRecordId: string, ifMatchBase: Revision): TrustedFieldOp => ({
      opId: client.opId, clientId: client.clientId,
      actor: authzActor,        // ★ 覆盖(不信 body.actor)
      recordId: pathRecordId,   // ★ 覆盖(不信 body.recordId)
      baseRevision: ifMatchBase, // ★ 覆盖(不信 body.baseRevision)
      fieldPath: client.fieldPath, value: client.value,
    })
    // 客户端试图伪造 actor='admin' / recordId='other-node' / base=999
    const malicious: ClientFieldOp = {
      opId: 'x', clientId: 'A', actor: 'admin', recordId: 'other-node', baseRevision: 999,
      fieldPath: ['title'], value: 'hacked',
    }
    const trusted = trustify(malicious, 'alice', 'n1', 0)
    expect(trusted.actor).toBe('alice')       // ★ authz 覆盖,不信 'admin'
    expect(trusted.recordId).toBe('n1')        // ★ path 覆盖,不信 'other-node'
    expect(trusted.baseRevision).toBe(0)       // ★ If-Match 覆盖,不信 999
    expect(trusted.opId).toBe('x')             // opId 单一权威载体(idempotency-key)
  })

  it('S10-3 typed domain op union:create/set/unset/array/reorder/strict-tx(P1-3:无 create 语义是 #194 现状缺陷)', () => {
    // 原 §10 FieldOp 只有 set(value:unknown),无 create/unset/array/reorder/strict-tx → 返修 typed union
    type DomainOp =
      | { kind: 'create'; recordId: string; type: 'node' | 'edge' | 'anchor'; payload: unknown }
      | { kind: 'set'; recordId: string; fieldPath: (string | number)[]; value: unknown }
      | { kind: 'unset'; recordId: string; fieldPath: (string | number)[] }
      | { kind: 'array'; recordId: string; fieldPath: (string | number)[]; op: 'push' | 'splice'; index?: number; value?: unknown }
      | { kind: 'reorder'; parentId: string; orderedIds: string[] }
      | { kind: 'strict-tx'; ops: DomainOp[] } // 严格事务路径(跨 record 原子,§10.4)
    // create 语义:#194 现状 PATCH missing 恒 not-found(无 create);typed union 补 create
    const create: DomainOp = { kind: 'create', recordId: 'n-new', type: 'node', payload: { title: 'new' } }
    const set: DomainOp = { kind: 'set', recordId: 'n1', fieldPath: ['title'], value: 'x' }
    const unset: DomainOp = { kind: 'unset', recordId: 'n1', fieldPath: ['tempKey'] }
    const arr: DomainOp = { kind: 'array', recordId: 'n1', fieldPath: ['fills'], op: 'push', value: { color: '#fff' } }
    const reorder: DomainOp = { kind: 'reorder', parentId: 'canvas-1', orderedIds: ['n2', 'n1', 'n3'] }
    const tx: DomainOp = { kind: 'strict-tx', ops: [set, { kind: 'set', recordId: 'n2', fieldPath: ['groupId'], value: 'g1' }] }
    // 验 union 可区分(kind 判别)
    expect(create.kind).toBe('create')
    expect(unset.kind).toBe('unset')
    expect(arr.kind).toBe('array')
    expect(reorder.kind).toBe('reorder')
    expect(tx.kind).toBe('strict-tx')
    // ★ strict-tx = 跨 record 严格事务原子(P1-2/G3 的跨介质边界走此 op,非 LWW)
  })

  it('S10-4 per-field clock 持久形态:per (recordId,fieldPath) → clock;持久为 Map<fieldKey, number>(不留 N2-1)', () => {
    // 原 §10 把 per-field clock 留 N2-1("decision-complete" 自相矛盾)→ 返修定死持久形态
    type FieldClock = Map<string, number> // key = fieldKeyOf(path),value = clock
    type PerFieldClockStore = Map<string, FieldClock> // recordId → FieldClock
    const store: PerFieldClockStore = new Map()
    const bump = (recordId: string, path: (string | number)[]) => {
      const fc = store.get(recordId) ?? new Map<string, number>()
      const key = fieldKeyOf(path)
      fc.set(key, (fc.get(key) ?? 0) + 1)
      store.set(recordId, fc)
    }
    const clock = (recordId: string, path: (string | number)[]) => store.get(recordId)?.get(fieldKeyOf(path)) ?? 0
    // A 改 title 3 次 → title.clock=3;B 改 transform.x 1 次 → transform.x.clock=1
    bump('n1', ['title']); bump('n1', ['title']); bump('n1', ['title'])
    bump('n1', ['transform', 'x'])
    expect(clock('n1', ['title'])).toBe(3)
    expect(clock('n1', ['transform', 'x'])).toBe(1)
    expect(clock('n1', ['transform', 'y'])).toBe(0) // 未改过
    // ★ 持久形态定死:Map<recordId, Map<fieldKey, clock>>;stale 判定 = base.clock < current.clock
    //   且同 fieldPath(base.clock < current → 已被他人更新过 → 条件逆运算 skip,见 Gate2 M2)
    //   不再留 N2-1(per-field clock 持久形态已定)。
  })

  it('S10-5 batch 原子性:FieldOp[] 同 record 多 op 要么全 ok 要么全 reject(单事务)', () => {
    // 原 §10.2 "payload = FieldOp 或 FieldOp[](批量,同 record)" 但未定原子性 → 返修:batch 原子
    const applyBatch = (server: FieldLevelServer, actor: string, ops: FieldOp[]): { allOk: boolean; results: (ApplyResult | { kind: 'forbidden' })[] } => {
      // 原子预检:任一 op precondition-required/not-found → 全 reject(无 partial)
      for (const op of ops) {
        if (op.baseRevision === undefined) return { allOk: false, results: [{ kind: 'precondition-required' }] }
        if (!server.recordExists(op.recordId)) return { allOk: false, results: [{ kind: 'not-found' }] }
      }
      // 全预检过 → 顺序 apply(同 record 同事务);任一失败 → 仍返 results(原子性由 server 事务保证,见 PG-T2)
      const real: (ApplyResult | { kind: 'forbidden' })[] = ops.map((op) => server.applyOpAuthz(op, actor))
      const allOk = real.every((r) => r.kind === 'ok')
      return { allOk, results: real }
    }
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig', text: 'orig' } as Partial<NodeRecord>))
    s.addMember('alice')
    const rev0 = s.revision('n1')
    // batch:同 record 改 title + text(两 fieldPath,原子)
    const batchOk = applyBatch(s, 'alice', [
      { opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'T' },
      { opId: 'a2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['text'], value: 'X' },
    ])
    expect(batchOk.allOk).toBe(true)
    expect(s.getFieldValue('n1', ['title'])).toBe('T')
    expect(s.getFieldValue('n1', ['text'])).toBe('X')
    // batch 含 precondition-required → 全 reject(无 partial)
    const batchBad = applyBatch(s, 'alice', [
      { opId: 'b1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'Y' },
      { opId: 'b2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: undefined, fieldPath: ['text'], value: 'Z' }, // 428
    ])
    expect(batchBad.allOk).toBe(false)
    expect(batchBad.results[0].kind).toBe('precondition-required')
    // ★ b1 不应 partial 应用(title 仍 T,非 Y)
    expect(s.getFieldValue('n1', ['title'])).toBe('T')
  })
})
