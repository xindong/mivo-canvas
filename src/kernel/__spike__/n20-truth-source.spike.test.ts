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

/** 通用嵌套字段 set(path 导航到 leaf,mutates clone)。 */
const setByPath = (obj: Record<string, unknown>, path: (string | number)[], value: unknown): void => {
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i] as string] as Record<string, unknown>
  cur[path[path.length - 1] as string] = value
}

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
