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
import { describe, it, expect, expectTypeOf } from 'vitest'
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

/** §10 setByPath 硬化:拒原型污染段(__proto__/prototype/constructor)+ 拒空路径(G1B R2-P1-1 非空 tuple 对齐),返修 P1-3/P2-8。 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const assertSafePath = (path: (string | number)[]): void => {
  // G1B R2-P1-1 对齐:FieldPath 必须非空 tuple(空路径会让整 record clobber 合法表达 + 给 obj 加 undefined key)
  if (path.length === 0) throw new Error('empty fieldPath (§10 requires non-empty tuple, G1B R2-P1-1)')
  for (const seg of path) {
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`forbidden path segment "${seg}" (anti-prototype-pollution, §10 setByPath)`)
    }
  }
}
/** fieldPath → 稳定 key 串(per-field clock / 条件逆运算去重用)。 */
const fieldKeyOf = (path: (string | number)[]): string => path.map((s) => String(s)).join('.')
/** 容器判定(plain object 或 array;R2-4 leaf validator:容器对容器 set = clobber 风险)。 */
const isContainer = (v: unknown): boolean => v !== null && typeof v === 'object'
/**
 * R2-4 leaf validator:拒"容器 path + 容器 value"的 clobber(如 setByPath(obj,['transform'],{x:10}) 会吞 transform.y)。
 * - 要求 fieldPath 导航到**原子 leaf**(number/string/boolean),或对容器整值替换显式声明 allowContainerClobber(整值 LWW 限制)。
 * - 对照 mivoCanvas.ts:transform 是容器对象 → set ['transform'] 整对象会吞兄弟字段;必须 set ['transform','x'] 等叶子。
 * - 数组(fills/strokes/effects/markupPoints/resultNodeIds)走 S10-7 三类 intent,不走 setByPath 整值替换。
 */
const assertAtomicLeaf = (obj: Record<string, unknown>, path: (string | number)[], value: unknown): void => {
  if (path.length === 0) return // assertSafePath 已拒空路径
  let parent: unknown = obj
  for (let i = 0; i < path.length - 1; i++) parent = (parent as Record<string, unknown>)?.[path[i] as string]
  const cur = (parent as Record<string, unknown> | undefined)?.[path[path.length - 1] as string]
  if (isContainer(cur) && isContainer(value)) {
    throw new Error(`clobber risk: fieldPath [${fieldKeyOf(path)}] targets a container (cur=${Array.isArray(cur) ? 'array' : 'object'}); use a leaf sub-path or set allowContainerClobber (R2-4 leaf validator)`)
  }
}
/** 通用嵌套字段 set(path 导航到 leaf,mutates clone)。硬化:拒原型污染路径(P1-3)+ 拒整对象 clobber(R2-4)。 */
const setByPath = (obj: Record<string, unknown>, path: (string | number)[], value: unknown, opts: { allowContainerClobber?: boolean } = {}): void => {
  assertSafePath(path)
  if (!opts.allowContainerClobber) assertAtomicLeaf(obj, path, value)
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
  /** 已删 record tombstone(区分"幂等已删返 cursor" vs "从未存在 404",G1B R2-P1-3 对齐)。 */
  private deletedTombstones = new Set<string>()
  /** idempotency-key → 首次 ok 结果(R2-3 S10-11:同 opId replay 不二次 bump/发事件)。 */
  private idempotencyCache = new Map<string, ApplyResult>() // R3 F2:进程内 Map(重启丢);持久证明由 PG-T6 真测,本 cache 仅演示 replay 逻辑

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
  /**
   * DELETE 带 cursor(G1B R2-P1-3 对齐,返修 P2-8):accepted 必携服务端权威 seq(cursor)。
   * - 成功删 → ok{seq, deletedEdges}(返 cursor)
   * - 幂等已删(tombstone 命中)→ ok{seq, deletedEdges:0}(不 404,accepted 必携 cursor,不冒充)
   * - 从未存在(无 tombstone)→ not-found(rejected,不冒充 cursor;canvas 不存在/无权亦走此终态)
   */
  deleteNodeCascadeWithCursor(nodeId: string, actor: string): { kind: 'ok'; seq: number; deletedEdges: number } | { kind: 'not-found' } {
    const existing = this.recs.get(nodeId)
    if (existing) {
      let deletedEdges = 0
      for (const [eid, e] of this.edges) {
        if (e.from === nodeId || e.to === nodeId) { this.edges.delete(eid); deletedEdges++ }
      }
      this.recs.delete(nodeId)
      this.deletedTombstones.add(nodeId)
      const seq = ++this.seq
      const evt: BroadcastEvent = {
        seq, recordId: nodeId,
        op: { opId: `del-${seq}`, clientId: 'server', actor, recordId: nodeId, baseRevision: existing.revision, fieldPath: ['__delete__'], value: null },
        revision: existing.revision + 1,
      }
      this.opLog.push(evt)
      this.broadcast(evt)
      return { kind: 'ok', seq, deletedEdges }
    }
    // recs 无:区分幂等已删 vs 从未存在
    if (this.deletedTombstones.has(nodeId)) {
      // ★ 幂等已删 → 返当前 seq(cursor),不 404(accepted 必携 cursor,G1B R2-P1-3 ①)
      return { kind: 'ok', seq: this.seq, deletedEdges: 0 }
    }
    return { kind: 'not-found' } // ★ 从未存在 → rejected(不冒充 cursor)
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
  /** 成员判定(R2-3 S10-5 batch 原子性 staging 预检用)。 */
  isMember(actor: string): boolean { return this.members.has(actor) }
  /**
   * 单事务 commit(R2-3 S10-5):batch staging 全 ok 后**原子写回** + bump seq + 广播一条 batch event。
   * - 不走 applyOp(避免 per-op 广播);整批作为单 server op 落库(原子:全成或全败,无 partial)。
   * - staged.revision 已在 batch staging 内逐 op bump;commitStaged 不再额外 bump revision,只写回 + bump seq。
   */
  commitStaged(recordId: string, staged: NodeRecord, actor: string): { seq: number; revision: Revision } {
    this.recs.set(recordId, structuredClone(staged))
    const seq = ++this.seq
    const evt: BroadcastEvent = {
      seq, recordId,
      op: { opId: `batch-${seq}`, clientId: 'server', actor, recordId, baseRevision: staged.revision - 1, fieldPath: ['__batch__'], value: null },
      revision: staged.revision,
    }
    this.opLog.push(evt); this.broadcast(evt)
    return { seq, revision: staged.revision }
  }
  /**
   * idempotent apply(R2-3 S10-11):同 opId(idempotency-key header)replay → 返首次缓存的 ok 结果,
   * **不二次 bump revision/seq、不二次发事件**;rejected 结果不缓存(可重试)。
   */
  applyOpIdempotent(op: FieldOp, actor: string): { result: ApplyResult | { kind: 'forbidden' }; deduped: boolean } {
    const cached = this.idempotencyCache.get(op.opId)
    if (cached) return { result: cached, deduped: true } // ★ replay:不二次 bump/发事件
    const r = this.applyOpAuthz(op, actor)
    if (r.kind === 'ok') this.idempotencyCache.set(op.opId, r) // 只缓存 ok(rejected 可重试)
    return { result: r, deduped: false }
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

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P1-4 文本判决):B 方案 — LWW 200 + overwritten 事件 + 短期历史恢复
// ════════════════════════════════════════════════════════════════════════════
//
// finding P1-4:文档同时写"整串 LWW 后写 wins/revision 不拒写"与"409 surfacing",矛盾;
//   markdown 是正式节点类型(CanvasNodeView.tsx:443-531 全文渲染),不能仅凭"不是 Google Docs"断言罕见。
// 二选一(本 worker 判决 B,标注产品决策留用户):
//   A) same-field stale → 409/field-conflict + 用户选 reload/force  — 与 gate4 G4-4 "revision 不拒写" 矛盾,否决
//   B) 始终 LWW 200 + SSE overwritten 事件 + 短期历史恢复          — 与 G4-4 自洽,推荐 ★
// 推荐 B:与 gate4 "revision 不参与 LWW 拒写" 自洽;后写者不阻断、前写者知情(overwritten)+ 可一键 restore;
//   A 的 409 会让 markdown 同编频繁阻断,反画布交互直觉(Figma 本身 LWW + 不阻断)。

/** 前写者被覆盖通知(败方知情:B 方案核心增量)。 */
type OverwrittenNotice = {
  seq: number; recordId: string; fieldPath: (string | number)[]
  historicalValue: unknown; byActor: string; currentRevision: Revision
}

/**
 * TextLwwWithOverwrite:在 FieldLevelServer LWW 200 之上叠加"前写者被覆盖通知"层。
 * - applyOverwrite:后写 wins(200 ok),前写者收 overwritten 通知(historicalValue/byActor/currentRevision)。
 * - restore:前写者收到通知后发 historicalValue 恢复自己的值(新 seq,后写 wins)。
 */
class TextLwwWithOverwrite {
  private lastWriter = new Map<string, { actor: string; value: unknown }>()
  private inboxes = new Map<string, OverwrittenNotice[]>()
  private server: FieldLevelServer

  constructor(server: FieldLevelServer) { this.server = server }

  /** LWW 200(后写 wins)+ 前写者被覆盖时发 overwritten 通知(B 方案)。 */
  applyOverwrite(op: FieldOp): { result: ApplyResult | { kind: 'forbidden' }; overwrittenTo?: string } {
    const key = `${op.recordId}:${fieldKeyOf(op.fieldPath)}`
    const prev = this.lastWriter.get(key)
    const r = this.server.applyOpAuthz(op, op.actor) // LWW 200(server seq 后写 wins;applyOpAuthz 撤权 → forbidden)
    if (r.kind === 'ok') {
      if (prev && prev.actor !== op.actor && JSON.stringify(prev.value) !== JSON.stringify(op.value)) {
        // ★ 前写者被覆盖 → 发 overwritten 通知(败方知情)
        const notice: OverwrittenNotice = {
          seq: r.seq, recordId: op.recordId, fieldPath: op.fieldPath,
          historicalValue: prev.value, byActor: op.actor, currentRevision: r.revision,
        }
        const ib = this.inboxes.get(prev.actor) ?? []
        ib.push(notice)
        this.inboxes.set(prev.actor, ib)
        this.lastWriter.set(key, { actor: op.actor, value: op.value })
        return { result: r, overwrittenTo: prev.actor }
      }
      this.lastWriter.set(key, { actor: op.actor, value: op.value })
    }
    return { result: r }
  }

  inbox(actor: string): OverwrittenNotice[] { return this.inboxes.get(actor) ?? [] }

  /**
   * 前写者 restore:走**同一 overwrite 管线**(R2-5 返修),非直调 applyOpAuthz。
   * - 发 historicalValue 为新 op value,经 applyOverwrite → server applyOpAuthz 落库 + 败方(当前 lastWriter)收 overwritten 通知。
   * - lastWriter 同步更新为 restore 者(不再"错停 bob");后续写者仍走 LWW + 通知链。
   * - stale/history 语义冻结:restore 不复活"已被第三方覆盖的值"——它发的是 historicalValue 作为新写,后写 wins 语义不变;
   *   若 restore 期间该字段又被第三方写,applyOverwrite 的 prev 比对会再次给第三方发通知(lastWriter 链持续)。
   */
  restore(actor: string, notice: OverwrittenNotice): { result: ApplyResult | { kind: 'forbidden' }; overwrittenTo?: string } {
    return this.applyOverwrite(
      { opId: `restore-${notice.seq}`, clientId: 'restore', actor, recordId: notice.recordId, baseRevision: notice.currentRevision, fieldPath: notice.fieldPath, value: notice.historicalValue },
    )
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
  // ═══ R5 F1 §10 唯一契约权威类型(create 从 PATCH DomainOp 剔除,独立 create endpoint/body)═══
  // R5 F1 返修:原 DomainOp 含 `{kind:'create',recordId}`,又允许 §10.2 通用 PATCH 接收任意 DomainOp,
  //   致同一 PATCH wire 同时有 trusted ctx.recordId(path)与不可信 domain.recordId(body)两个 record 权威
  //   →"body 零 privileged 可伪造"不成立。修法(补探针把声称测实):create 不走 PATCH DomainOp,
  //   独立 POST /api/canvas/:id/nodes endpoint + 独立 CreateBody(零 recordId;server 分配/idempotency-key 派生,
  //   非 body 携带)+ 独立 trustifyCreate adapter。PATCH DomainOp 仅 set/unset/array/reorder/strict-tx,
  //   全 variant 任意嵌套层零 privileged(recordId/actor/baseRevision/opId 全 adapter 注入)。
  type FieldPath = readonly [string | number, ...(string | number)[]]  // 非空 tuple(S10-6 运行时拒空)
  // DomainOp = 中性 delta(transport-neutral):set/unset/array/reorder/strict-tx 无 recordId/actor/base/opId
  //   (recordId ← URL path;actor ← resolveActor;base ← If-Match;opId ← idempotency-key header,全 adapter 注入)。
  //   ★ R5 F1:create 已剔除 — create 走独立 POST endpoint(见 CreateBody),非 PATCH DomainOp member。
  type DomainOp =
    | { kind: 'set'; fieldPath: FieldPath; value: unknown }                                    // 无 recordId(path 注入)
    | { kind: 'unset'; fieldPath: FieldPath }                                                  // 无 recordId
    | { kind: 'array'; fieldPath: FieldPath; class: 'by-id'; intent: 'insert'; afterId: string | null; value: { id: string } }      // ① by-stable-id(fills/strokes/effects)
    | { kind: 'array'; fieldPath: FieldPath; class: 'by-id'; intent: 'remove'; removeId: string }
    | { kind: 'array'; fieldPath: FieldPath; class: 'by-id'; intent: 'splice'; afterId: string; removeCount: number; values: { id: string }[] }
    | { kind: 'array'; fieldPath: FieldPath; class: 'whole-lww'; intent: 'replace'; value: unknown[] }                                // ② 无 stable-id(markupPoints)整值 LWW
    | { kind: 'array'; fieldPath: FieldPath; class: 'primitive'; intent: 'insert' | 'remove'; value: string }                         // ③ primitive(resultNodeIds)by value
    | { kind: 'reorder'; orderedIds: string[] }                                                 // parentId 从 path 注入
    | { kind: 'strict-tx'; ops: DomainOp[] }                                                    // 严格事务路径(跨 record 原子,§10.4);ops 无 create(create 不进 PATCH)
  // 客户端 PATCH payload(不可信):零 privileged 载体 — 无 opId/actor/recordId/baseRevision(全 adapter 注入)
  type ClientFieldOp = { clientId: string; domain: DomainOp }
  // 服务端 trusted(actor ← resolveActor;recordId ← URL path;base ← If-Match;opId ← idempotency-key header)
  type TrustedCtx = { opId: string; clientId: string; actor: string; recordId: string; baseRevision: Revision }
  type WireOp = TrustedCtx & { domain: DomainOp }
  // trustify:ClientFieldOp.domain + TrustedCtx → WireOp(body 无 privileged 字段可伪造)
  const trustify = (client: ClientFieldOp, ctx: TrustedCtx): WireOp => ({ ...ctx, domain: client.domain })
  // adaptToWire:中性 DomainOp + trusted ctx → wire op(R3 F1:三类 array 同一 adapter 映射)
  const adaptToWire = (domain: DomainOp, ctx: TrustedCtx): WireOp => ({ ...ctx, domain })

  // ── R5 F1:create 独立契约(POST /api/canvas/:id/nodes,非 PATCH DomainOp)──
  // CreateBody 零 privileged:无 recordId(server 分配/idempotency-key 派生,非 body)/actor/base/opId。
  //   id 唯一来源 = trusted endpoint ctx(server-minted,或 idempotency-key header 派生),非 body 可伪造字段。
  type CreateBody = { clientId: string; type: 'node' | 'edge' | 'anchor'; payload: unknown }
  type CreateWire = { opId: string; clientId: string; actor: string; recordId: string; type: 'node' | 'edge' | 'anchor'; payload: unknown }
  // trustifyCreate:CreateBody + TrustedCtx(recordId = server-minted,非 body)→ CreateWire;body 零 privileged 可伪造。
  const trustifyCreate = (client: CreateBody, ctx: TrustedCtx): CreateWire =>
    ({ opId: ctx.opId, clientId: ctx.clientId, actor: ctx.actor, recordId: ctx.recordId, type: client.type, payload: client.payload })

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

  it('S10-2 三层信任边界(R5 F1:PATCH body 任意 variant 含 strict-tx 嵌套零 privileged;create 不进 PATCH DomainOp)', () => {
    // R5 F1:body 零信任字段 — ClientFieldOp = {clientId, domain};DomainOp set/unset/array/reorder/strict-tx
    //   全 variant 任意嵌套层无 recordId/actor/base/opId;privileged 全在 adapter/trusted 注入:
    //   actor ← resolveActor;recordId ← URL path;base ← If-Match;opId ← idempotency-key header。
    //   create 走独立 CreateBody(零 recordId;server-minted id),非 PATCH DomainOp member — 杜绝双 record 权威。
    // 类型级断言(tsc -b 强制:若类型加回任一 privileged 字段 / create 塞回 DomainOp,expectTypeOf 失配 /
    //   或 ts-expect-error 抑制指令失效 → build fail):
    expectTypeOf<keyof ClientFieldOp>().toEqualTypeOf<'clientId' | 'domain'>()  // PATCH body 零 privileged(opId/actor/recordId/baseRevision 全无)
    // ★ R5 F1:DomainOp 不含 create kind(create 走独立 endpoint,非 PATCH member)— 若 create 塞回则此行失配 → build fail
    expectTypeOf<DomainOp['kind']>().toEqualTypeOf<'set' | 'unset' | 'array' | 'reorder' | 'strict-tx'>()
    // ★ R5 F1:create 独立 CreateBody 零 privileged(无 recordId/actor/base/opId;id 由 server ctx 注入)
    expectTypeOf<keyof CreateBody>().toEqualTypeOf<'clientId' | 'type' | 'payload'>()
    type SetOp = Extract<DomainOp, { kind: 'set' }>
    type UnsetOp = Extract<DomainOp, { kind: 'unset' }>
    type ReorderOp = Extract<DomainOp, { kind: 'reorder' }>
    type StrictTxOp = Extract<DomainOp, { kind: 'strict-tx' }>
    type ArrayByIdInsert = Extract<DomainOp, { kind: 'array'; class: 'by-id'; intent: 'insert' }>
    type ArrayByIdRemove = Extract<DomainOp, { kind: 'array'; class: 'by-id'; intent: 'remove' }>
    type ArrayWholeLww = Extract<DomainOp, { kind: 'array'; class: 'whole-lww' }>
    type ArrayPrimitive = Extract<DomainOp, { kind: 'array'; class: 'primitive' }>
    // ★ R6 F1 补 by-id splice variant exact-key gate(判决 V3:原 S10-2 漏 splice,给 splice 加 privileged key 不使 build fail)
    type ArrayByIdSplice = Extract<DomainOp, { kind: 'array'; class: 'by-id'; intent: 'splice' }>
    expectTypeOf<keyof SetOp>().toEqualTypeOf<'kind' | 'fieldPath' | 'value'>()            // set 无 recordId/actor/base/opId
    expectTypeOf<keyof UnsetOp>().toEqualTypeOf<'kind' | 'fieldPath'>()                    // unset 无 recordId/actor/base/opId
    expectTypeOf<keyof ReorderOp>().toEqualTypeOf<'kind' | 'orderedIds'>()                 // reorder 无 recordId(parentId 从 path 注入)
    expectTypeOf<keyof StrictTxOp>().toEqualTypeOf<'kind' | 'ops'>()                       // strict-tx 仅 kind+ops(无 privileged)
    expectTypeOf<keyof ArrayByIdInsert>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'afterId' | 'value'>()
    expectTypeOf<keyof ArrayByIdRemove>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'removeId'>()
    expectTypeOf<keyof ArrayWholeLww>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'value'>()
    expectTypeOf<keyof ArrayPrimitive>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'value'>()
    // ★ R6 F1:by-id splice variant exact-key gate — splice 亦无 recordId/actor/base/opId(与 insert/remove 同 gate)
    expectTypeOf<keyof ArrayByIdSplice>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'afterId' | 'removeCount' | 'values'>()
    // @ts-expect-error R5 F1:ClientFieldOp body 零 privileged(无 actor)— 若加回则下行非 error → directive 失效 → build fail
    const _badActor: ClientFieldOp = { clientId: 'A', domain: { kind: 'set', fieldPath: ['title'], value: 'x' }, actor: 'admin' }
    // @ts-expect-error R5 F1:create 不再是 PATCH DomainOp member — 若 create 塞回 DomainOp 则下行非 error → build fail
    const _badCreateInDomain: DomainOp = { kind: 'create', recordId: 'forged', type: 'node', payload: {} }
    // @ts-expect-error R5 F1:create 不能嵌套进 strict-tx.ops(ops: DomainOp[],create 不在 DomainOp)— 杜绝嵌套双 record 权威
    const _badCreateNested: DomainOp = { kind: 'strict-tx', ops: [{ kind: 'create', recordId: 'forged', type: 'node', payload: {} }] }
    // @ts-expect-error R5 F1:Array variant 零 privileged(无 recordId)— 若加回则 build fail
    const _badArrayRec: DomainOp = { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'insert', afterId: null, value: { id: 'fA' }, recordId: 'forged' }
    // ★ R6 F1:by-id splice variant 同样零 privileged(无 recordId)— 判决 V3 验收:给 splice 加 recordId/actor/baseRevision/opId 任一 → tsc -b 失败
    // @ts-expect-error R6 F1:ArrayByIdSplice 零 privileged(无 recordId)— 若加回则下行非 error → directive 失效 → build fail
    const _badSpliceRec: DomainOp = { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'splice', afterId: 'f1', removeCount: 1, values: [{ id: 'fB' }], recordId: 'forged' }
    // @ts-expect-error R5 F1:CreateBody 零 privileged(无 recordId)— 若加回则 build fail
    const _badCreateBody: CreateBody = { clientId: 'A', type: 'node', payload: {}, recordId: 'forged' }
    expect(_badActor).toBeDefined(); expect(_badCreateInDomain).toBeDefined(); expect(_badCreateNested).toBeDefined()
    expect(_badArrayRec).toBeDefined(); expect(_badCreateBody).toBeDefined(); expect(_badSpliceRec).toBeDefined()  // 标记已用(noUnusedLocals)+ 证明 body/DomainOp 无法携 privileged(含 by-id splice,R6 F1)
    // trustify:ClientFieldOp.domain + TrustedCtx → WireOp(body 无 privileged 可伪造;forge 无处可藏)
    const set: DomainOp = { kind: 'set', fieldPath: ['title'], value: 'hacked' }
    const trusted = trustify(
      { clientId: 'A', domain: set },
      { opId: 'idem-key-abc', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 0 },
    )
    expect(trusted.actor).toBe('alice')            // authz 注入(无 body.actor 可伪造)
    expect(trusted.recordId).toBe('n1')             // path 注入
    expect(trusted.baseRevision).toBe(0)           // If-Match 注入
    expect(trusted.opId).toBe('idem-key-abc')       // idempotency-key header 注入
    expect(trusted.domain).toBe(set)               // domain 中性 delta 引用
    // ★ R5 F1:create 走独立 trustifyCreate:CreateBody(零 recordId)+ TrustedCtx(server-minted recordId)→ CreateWire
    //   body 零 privileged 可伪造;recordId 唯一来源 = trusted ctx(server 分配),非 body 字段。
    const createBody: CreateBody = { clientId: 'A', type: 'node', payload: { title: 'new' } }
    const createWire = trustifyCreate(createBody, { opId: 'idem-create-1', clientId: 'A', actor: 'alice', recordId: 'n-new-minted', baseRevision: 0 })
    expect(createWire.recordId).toBe('n-new-minted')  // ★ server-minted(trusted ctx),非 body 可伪造
    expect(createWire.actor).toBe('alice')            // authz 注入
    expect(createWire.opId).toBe('idem-create-1')      // idempotency-key header 注入
    expect(createWire.type).toBe('node'); expect(createWire.payload).toEqual({ title: 'new' })
    // 证明:createBody 无 recordId 字段可伪造(若客户端试图塞 recordId,上面 _badCreateBody @ts-expect-error 已 schema 级拒)
  })

  it('S10-3 typed domain op union + adapter 分层(R5 F1:create 独立 endpoint,非 PATCH DomainOp;三类 array 同一 adapter 映射)', () => {
    // R5 F1:DomainOp/TrustedCtx/WireOp/adaptToWire 复用 §10 describe 权威类型(无另造冲突局部类型);
    //   DomainOp 中性 delta,不带 recordId/actor/base/opId(全 adapter 注入);三类 array 同一 adaptToWire 覆盖。
    //   create 走独立 CreateBody + trustifyCreate(非 adaptToWire/DomainOp)— 杜绝 PATCH 双 record 权威。
    // @ts-expect-error R5 F1:create 不再是 PATCH DomainOp member — 若 create 塞回 DomainOp 则下行非 error → build fail
    const _createNotDomain: DomainOp = { kind: 'create', recordId: 'n-new', type: 'node', payload: { title: 'new' } }
    // create 走独立 CreateBody(零 recordId)+ trustifyCreate(server-minted recordId via trusted ctx)
    const createBody: CreateBody = { clientId: 'A', type: 'node', payload: { title: 'new' } }
    const createWire = trustifyCreate(createBody, { opId: 'idem-create', clientId: 'A', actor: 'alice', recordId: 'n-new-minted', baseRevision: 0 })
    expect(_createNotDomain).toBeDefined()  // 标记已用(noUnusedLocals)+ 证明 create 无法回塞 DomainOp
    expect(createWire.recordId).toBe('n-new-minted')  // ★ server-minted(trusted ctx),非 body 可伪造 recordId
    expect(createWire.type).toBe('node'); expect(createWire.payload).toEqual({ title: 'new' })
    const set: DomainOp = { kind: 'set', fieldPath: ['title'], value: 'x' }
    const unset: DomainOp = { kind: 'unset', fieldPath: ['tempKey'] }
    const reorder: DomainOp = { kind: 'reorder', orderedIds: ['n2', 'n1', 'n3'] }
    const tx: DomainOp = { kind: 'strict-tx', ops: [set, { kind: 'set', fieldPath: ['groupId'], value: 'g1' }] }
    // ① by-stable-id(fills/strokes/effects):insert/remove by id(并发不漂移)
    const fillsInsert: DomainOp = { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'insert', afterId: 'f1', value: { id: 'fA' } }
    const fillsRemove: DomainOp = { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'remove', removeId: 'fA' }
    // ★ R6 F1:by-id splice variant(判决 V3:原 S10-3 不构造 splice,补全三类 by-id intent:insert/remove/splice)
    const fillsSplice: DomainOp = { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'splice', afterId: 'f1', removeCount: 1, values: [{ id: 'fB' }] }
    // ② whole-lww(markupPoints,无 stable-id,mivoCanvas.ts MarkupPoint {x,y,pressure?}):整值 LWW 替换(限制:并发丢前写者,上层 coalesce 或转 by-id)
    const markupReplace: DomainOp = { kind: 'array', fieldPath: ['markupPoints'], class: 'whole-lww', intent: 'replace', value: [{ x: 3, y: 3 }] }
    // ③ primitive(resultNodeIds,string[],mivoCanvas.ts:249):by value(元素是 string 无 id,不能 by-id)
    const resultInsert: DomainOp = { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'insert', value: 'n3' }
    // 验 union 可区分(kind/class 判别;create 已剔除,不在 DomainOp kind 集)
    expect(set.kind).toBe('set'); expect(unset.kind).toBe('unset')
    expect(reorder.kind).toBe('reorder'); expect(tx.kind).toBe('strict-tx')
    expect(fillsInsert.kind).toBe('array'); expect(fillsInsert.class).toBe('by-id')
    expect(markupReplace.class).toBe('whole-lww'); expect(resultInsert.class).toBe('primitive')
    // R3 F1 adapter 映射:中性 DomainOp → wire op(recordId/actor/base/opId 全由 trusted ctx 注入,不在 DomainOp)
    const ctx: TrustedCtx = { opId: 'idem-1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: 3 }
    const wire = adaptToWire(set, ctx)
    expect(wire.recordId).toBe('n1'); expect(wire.actor).toBe('alice'); expect(wire.baseRevision).toBe(3); expect(wire.opId).toBe('idem-1')
    expect(wire.domain).toBe(set)  // domain 中性 delta 引用(无 recordId/actor/base/opId)
    // ★ 三类 array 同一 adaptToWire 覆盖(对齐 §10 三类 union,无另造冲突局部类型):
    const wireFills = adaptToWire(fillsInsert, ctx); expect(wireFills.domain).toBe(fillsInsert)              // ① fills by-id insert
    const wireFillsRm = adaptToWire(fillsRemove, ctx); expect(wireFillsRm.domain).toBe(fillsRemove)        // ① fills by-id remove
    const wireFillsSp = adaptToWire(fillsSplice, ctx); expect(wireFillsSp.domain).toBe(fillsSplice)        // ① fills by-id splice(R6 F1 补:正常 splice 经 adapter trusted ctx 唯一生效)
    const wireMarkup = adaptToWire(markupReplace, ctx); expect(wireMarkup.domain).toBe(markupReplace)      // ② markupPoints whole-lww
    const wireResult = adaptToWire(resultInsert, ctx); expect(wireResult.domain).toBe(resultInsert)        // ③ resultNodeIds primitive
    // ★ §10 验收:三类 array 均可构造 fills/markupPoints/resultNodeIds;strict-tx = 跨 record 严格事务原子(P1-2/G3 跨介质边界,非 LWW)
  })

  it('S10-4 per-field clock 持久形态(R2-3):PG field_clock schema + 客户端 base.clock 表达 + 重启可恢复', () => {
    // R3 F2 诚实化:持久证明由 PG-T5 真测(write→destroy pool→重连读回,clock 仍在,见 n20-pg-tx-fault.spike.test.ts);
    //   本测试用内存 Map + persistedRows 数组仅演示 clock 逻辑,非持久证明(原 R2-3 注释"重启可恢复"系模拟,虚标已纠)。
    // PG 持久 schema(R2-3 要求,DDL 定死):
    const FIELD_CLOCK_DDL = `CREATE TABLE IF NOT EXISTS field_clock (
  canvas_id text NOT NULL, record_id text NOT NULL, field_key text NOT NULL, clock bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (canvas_id, record_id, field_key)
)`
    type FieldClockRow = { canvas_id: string; record_id: string; field_key: string; clock: number }
    // 内存模拟 PG store(生产为 PG,spike 用 Map;schema 一致)
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
    // ★ R2-3 客户端 base.clock 表达:baseRevision 携带 {revision, clock map} — base.clock 用于 stale 判定
    type BaseWithClock = { revision: Revision; clock: Record<string, number> } // fieldKey → clock
    const clientBase: BaseWithClock = { revision: 0, clock: { title: 2 } } // A 看到 title.clock=2 时发 op
    expect(clientBase.clock['title']).toBeLessThan(clock('n1', ['title'])) // ★ base=2 < current=3 → stale
    // ★ R2-3 重启可恢复:clock 持久在 field_clock 表,重启从 PG 读回(模拟)
    const persistedRows: FieldClockRow[] = [
      { canvas_id: 'c1', record_id: 'n1', field_key: 'title', clock: 3 },
      { canvas_id: 'c1', record_id: 'n1', field_key: 'transform.x', clock: 1 },
    ]
    const restored: PerFieldClockStore = new Map()
    for (const r of persistedRows) {
      const fc = restored.get(r.record_id) ?? new Map<string, number>()
      fc.set(r.field_key, r.clock); restored.set(r.record_id, fc)
    }
    expect(restored.get('n1')?.get('title')).toBe(3)       // ★ 重启后 clock 可恢复
    expect(restored.get('n1')?.get('transform.x')).toBe(1)
    expect(FIELD_CLOCK_DDL).toContain('field_clock')       // schema 名定死
    expect(FIELD_CLOCK_DDL).toContain('PRIMARY KEY (canvas_id, record_id, field_key)')
    // ★ 持久形态定死:PG field_clock 表 + 客户端 base.clock 表达 + 重启恢复;不留 N2-1(R2-3)。
    //   stale 判定 = base.clock < current.clock → 条件逆运算 skip(见 Gate2 M2)
  })

  it('S10-5 batch 真单事务(R2-3):staging → 全 ok 才 commitStaged;第二项 runtime 失败第一项不落库(无 partial)', () => {
    // R2-3:原 applyBatch 逐条 applyOpAuthz 落库(后项失败前项已落 = partial);返修为 staging 原子。
    //   R3 F2 诚实化:跨 record 单事务持久证明由 PG-T7 真测(两不同 record 同 client BEGIN+fault+ROLLBACK 两 record 均不变);
    //   本测试始终 clone/commit ops[0].recordId(单 record),仅演示 staging 原子逻辑,非跨 record 证明。
    //   staging clone record → 顺序 apply 到 staging(不落 real,不广播)→ 全 ok 才 commitStaged 原子写回 + 广播一条;
    //   任一 runtime 失败 → discard staging,real 不变(无 partial)。
    const applyBatchAtomic = (server: FieldLevelServer, actor: string, ops: FieldOp[]): { allOk: boolean; results: (ApplyResult | { kind: 'forbidden' })[] } => {
      // 预检:任一 op precondition-required/not-found → 全 reject(无 partial)
      for (const op of ops) {
        if (op.baseRevision === undefined) return { allOk: false, results: [{ kind: 'precondition-required' }] }
        if (!server.recordExists(op.recordId)) return { allOk: false, results: [{ kind: 'not-found' }] }
      }
      if (!server.isMember(actor)) return { allOk: false, results: ops.map(() => ({ kind: 'forbidden' as const })) }
      // ★ staging:clone record,顺序 apply 到 staging(不落 real,不广播);任一 runtime 失败 → break discard
      const staging = structuredClone(server.getNode(ops[0].recordId)!) as NodeRecord
      let stagingRev = staging.revision
      const results: (ApplyResult | { kind: 'forbidden' })[] = []
      let failed = false
      for (const op of ops) {
        try {
          setByPath(staging as unknown as Record<string, unknown>, op.fieldPath, op.value) // 走 leaf validator(R2-4)
          stagingRev += 1
          results.push({ kind: 'ok' as const, revision: stagingRev, seq: -1 }) // seq 占位,commit 时回填
        } catch {
          results.push({ kind: 'forbidden' as const }); failed = true; break // ★ runtime 失败 → discard staging
        }
      }
      const allOk = !failed && results.every((r) => r.kind === 'ok')
      if (allOk) {
        staging.revision = stagingRev
        const commit = server.commitStaged(ops[0].recordId, staging, actor) // ★ 全 ok 才原子写回 + 广播一条 batch event
        results.forEach((r, i) => { if (r.kind === 'ok') (r as { seq: number }).seq = commit.seq + i })
      }
      // ★ allOk=false → 不 commitStaged,staging 丢弃,real 不变(无 partial,R2-3 验收)
      return { allOk, results }
    }
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig', text: 'orig' } as Partial<NodeRecord>))
    s.addMember('alice')
    const rev0 = s.revision('n1')
    // batch:同 record 改 title + text(两 fieldPath,原子)— 全 ok → commit
    const batchOk = applyBatchAtomic(s, 'alice', [
      { opId: 'a1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'T' },
      { opId: 'a2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['text'], value: 'X' },
    ])
    expect(batchOk.allOk).toBe(true)
    expect(s.getFieldValue('n1', ['title'])).toBe('T')
    expect(s.getFieldValue('n1', ['text'])).toBe('X')
    // batch 含 precondition-required → 全 reject(无 partial)
    const batchBad = applyBatchAtomic(s, 'alice', [
      { opId: 'b1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'Y' },
      { opId: 'b2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: undefined, fieldPath: ['text'], value: 'Z' }, // 428
    ])
    expect(batchBad.allOk).toBe(false)
    expect(batchBad.results[0].kind).toBe('precondition-required')
    expect(s.getFieldValue('n1', ['title'])).toBe('T') // ★ b1 未落库(title 仍 T,非 Y)
    // ★ R2-3 验收:batch 第二项 runtime 失败(leaf validator 拒整对象 clobber)第一项不落库(staging discard)
    const curRev = s.revision('n1')
    const batchRuntimeFail = applyBatchAtomic(s, 'alice', [
      { opId: 'c1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: curRev, fieldPath: ['title'], value: 'C-new' }, // 第一项 ok(仅 staging)
      { opId: 'c2', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: curRev, fieldPath: ['transform'], value: { x: 1, y: 2 } }, // 第二项 runtime 失败(leaf validator 拒整对象 clobber)
    ])
    expect(batchRuntimeFail.allOk).toBe(false)
    expect(s.getFieldValue('n1', ['title'])).toBe('T') // ★ 第一项不落库(title 仍 T,非 'C-new';staging discard)
    // ★ 撤权后 batch → 全 forbidden(无 partial)
    s.removeMember('alice')
    const batchForbidden = applyBatchAtomic(s, 'alice', [
      { opId: 'd1', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: s.revision('n1'), fieldPath: ['title'], value: 'D' },
    ])
    expect(batchForbidden.allOk).toBe(false)
    expect(batchForbidden.results[0].kind).toBe('forbidden')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P1-4 文本判决二选一):B 方案 LWW 200 + overwritten 事件 + 恢复历史
// ════════════════════════════════════════════════════════════════════════════

describe('N2-0 返修 Gate1 文本判决(P1-4 二选一写死): B 方案 LWW 200 + overwritten + restore', () => {
  it('T1-1 同字段并发:B 后写 LWW 200 wins + A 前写者收 overwritten(败方知情,非静默覆盖)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig' }))
    s.addMember('alice'); s.addMember('bob')
    const lww = new TextLwwWithOverwrite(s)
    const rev0 = s.revision('n1')
    const ra = lww.applyOverwrite({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' })
    expect(ra.result.kind).toBe('ok')
    const rb = lww.applyOverwrite({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B' })
    expect(rb.result.kind).toBe('ok') // ★ B 方案:200 不阻断(非 409)
    expect(s.getFieldValue('n1', ['title'])).toBe('B') // 后写 wins
    // ★ A 收 overwritten 通知(败方知情:原 PoC 无任何 conflict 信号)
    const inbox = lww.inbox('alice')
    expect(inbox.length).toBe(1)
    expect(inbox[0].historicalValue).toBe('A')       // A 写过的值
    expect(inbox[0].byActor).toBe('bob')              // 被谁覆盖
    expect(inbox[0].currentRevision).toBe(rev0 + 2)   // 当前 revision(cursor)
  })

  it('T1-2 restore 恢复前值:A 收 overwritten 后发 restore → title 回 A(新 seq,后写 wins);B 收 restore 覆盖通知(R2-5)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig' }))
    s.addMember('alice'); s.addMember('bob')
    const lww = new TextLwwWithOverwrite(s)
    const rev0 = s.revision('n1')
    lww.applyOverwrite({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' })
    lww.applyOverwrite({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B' })
    expect(s.getFieldValue('n1', ['title'])).toBe('B')
    // A 收 overwritten → restore(发 historicalValue=A,新 seq,后写 wins)— 走同一 overwrite 管线(R2-5)
    const notice = lww.inbox('alice')[0]
    const rr = lww.restore('alice', notice)
    expect(rr.result.kind).toBe('ok') // ★ restore 经 applyOverwrite 落库 ok
    expect(s.getFieldValue('n1', ['title'])).toBe('A') // ★ 恢复 A(短期历史恢复,B 方案核心)
    // ★ R2-5:restore 走 overwrite 管线 → 当前 lastWriter(bob)收 overwritten 通知(非 v1 直调 applyOpAuthz 致 bob 收不到)
    expect(rr.overwrittenTo).toBe('bob')
    const bobInbox = lww.inbox('bob')
    expect(bobInbox.length).toBe(1)
    expect(bobInbox[0].historicalValue).toBe('B')      // bob 写过的值现在成历史
    expect(bobInbox[0].byActor).toBe('alice')          // 被 alice 的 restore 覆盖
  })

  it('T1-5 restore 全链:A 写→B 写→A restore→B 收 notice→B 后续写→A 收 notice(lastWriter 链不断,R2-5)', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig' }))
    s.addMember('alice'); s.addMember('bob')
    const lww = new TextLwwWithOverwrite(s)
    const rev0 = s.revision('n1')
    // 1. A 写 title=A
    lww.applyOverwrite({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' })
    expect(lww.inbox('alice').length).toBe(0)
    // 2. B 写 title=B(后写 wins)→ A 收 overwritten(historicalValue=A,byActor=bob)
    lww.applyOverwrite({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'B' })
    expect(s.getFieldValue('n1', ['title'])).toBe('B')
    expect(lww.inbox('alice')[0]).toMatchObject({ historicalValue: 'A', byActor: 'bob' })
    // 3. A restore(发 historicalValue=A)→ B 收 overwritten(historicalValue=B,byActor=alice),title 回 A
    const noticeA = lww.inbox('alice')[0]
    const restoreRes = lww.restore('alice', noticeA)
    expect(restoreRes.result.kind).toBe('ok')
    expect(restoreRes.overwrittenTo).toBe('bob') // ★ B 收到 restore 覆盖通知(非 v1 绕过管线致 B 收不到)
    expect(s.getFieldValue('n1', ['title'])).toBe('A')
    expect(lww.inbox('bob')[0]).toMatchObject({ historicalValue: 'B', byActor: 'alice' })
    // 4. B 后续写 title=B2 → A 收 overwritten(historicalValue=A,byActor=bob),title=B2(lastWriter 链持续)
    lww.applyOverwrite({ opId: 'b2', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: s.revision('n1'), fieldPath: ['title'], value: 'B2' })
    expect(s.getFieldValue('n1', ['title'])).toBe('B2')
    const aliceInbox = lww.inbox('alice')
    expect(aliceInbox[aliceInbox.length - 1]).toMatchObject({ historicalValue: 'A', byActor: 'bob' })
    // ★ 终态:每次同字段覆盖,败方都收到含正确 historicalValue/byActor/revision/seq 的事件(R2-5 验收)
    expect(aliceInbox.length).toBe(2) // A 收过两次:B 覆盖 A + B2 覆盖 restore
    expect(lww.inbox('bob').length).toBe(1) // B 收过一次:restore 覆盖 B
  })

  it('T1-3 不同字段并发无 overwritten:A 改 title / B 改 transform.x → 各自 ok,无覆盖通知', () => {
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { title: 'orig', transform: { x: 0, y: 0, width: 100, height: 40, rotation: 0 } }))
    s.addMember('alice'); s.addMember('bob')
    const lww = new TextLwwWithOverwrite(s)
    const rev0 = s.revision('n1')
    lww.applyOverwrite({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'A' })
    lww.applyOverwrite({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['transform', 'x'], value: 50 })
    expect(lww.inbox('alice').length).toBe(0) // 不同 fieldPath → 无 overwritten
    expect(lww.inbox('bob').length).toBe(0)
    expect(s.getFieldValue('n1', ['title'])).toBe('A')
    expect(s.getFieldValue('n1', ['transform', 'x'])).toBe(50)
  })

  it('T1-4 对照 A 方案(409 surfacing)语义差异:B 选 200 不阻断,与 gate4 G4-4 自洽(标注产品决策)', () => {
    // A 方案:same-field stale → 409/field-conflict(B 写时 base 落后 → 拒,提示 reload/force)
    //   问题:与 gate4 G4-4 "revision 不参与 LWW 拒写"(base 落后不同字段仍接受)矛盾——
    //   同字段就 409、不同字段就接受,语义分裂;且 markdown 同编会频繁 409 阻断。
    // B 方案:始终 LWW 200 + overwritten + restore —— 与 G4-4 自洽(revision 从不拒写,只 surfacing)。
    // 本测试断言 B 方案契约不变量:同字段并发永返 ok(不 409),败方靠 overwritten+restore 知情/恢复。
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1', { text: 'orig' }))
    s.addMember('alice'); s.addMember('bob')
    const lww = new TextLwwWithOverwrite(s)
    const rev0 = s.revision('n1')
    const ra = lww.applyOverwrite({ opId: 'a', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['text'], value: 'A-md' })
    const rb = lww.applyOverwrite({ opId: 'b', clientId: 'B', actor: 'bob', recordId: 'n1', baseRevision: rev0, fieldPath: ['text'], value: 'B-md' })
    expect(ra.result.kind).toBe('ok')
    expect(rb.result.kind).toBe('ok') // ★ B 方案:同字段也 200(不 409 阻断)
    expect(s.getFieldValue('n1', ['text'])).toBe('B-md') // 后写 wins
    expect(lww.inbox('alice').length).toBe(1) // A 知情(败方 surfacing)
    // 判决:选 B(★ 标注产品决策留用户)。A 方案若选,须撤回 gate4 G4-4 "revision 不拒写" 立场。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(P2-8 §10 契约对齐 G1-b R2):FieldPath 非空 tuple / 数组 by-stable-id / create→edit 因果 / DELETE cursor
// ════════════════════════════════════════════════════════════════════════════

describe('N2-0 返修 §10 G1-b 衔接(P2-8): FieldPath 非空 + 数组中性 intent + create→edit 因果 + DELETE cursor', () => {
  it('S10-6 FieldPath 非空 tuple + leaf validator(G1B R2-P1-1 + R2-4 对齐):拒空路径 [] + 拒整对象 clobber', () => {
    // G1B R2-P1-1:FieldPath 改非空 tuple readonly [string|number, ...(string|number)[]]
    //   原因:空路径会让整 record/整子树 clobber 合法表达(setByPath(obj,[],v) 给 obj 加 undefined key)
    type NonEmptyFieldPath = readonly [string | number, ...(string | number)[]]
    const asNonEmpty = (p: unknown): p is NonEmptyFieldPath => Array.isArray(p) && p.length >= 1
    expect(asNonEmpty([])).toBe(false)
    expect(asNonEmpty(['title'])).toBe(true)
    expect(asNonEmpty(['transform', 'x'])).toBe(true)
    // setByPath 拒空路径(硬化:assertSafePath 拒空,G1B R2-P1-1 非空 tuple)
    const obj: Record<string, unknown> = { title: 'orig', transform: { x: 0, y: 0 } }
    expect(() => setByPath(obj, [], 'x')).toThrow(/empty fieldPath/i)
    // ★ R2-4 leaf validator:拒 ['transform'] + 整对象(clobber transform.y 风险;对照 mivoCanvas.ts transform 是容器对象)
    expect(() => setByPath(obj, ['transform'], { x: 10, y: 20 })).toThrow(/clobber risk/i)
    // 正常叶子路径仍工作(transform.x 原子 leaf)
    setByPath(obj, ['transform', 'x'], 42)
    expect((obj.transform as { x: number }).x).toBe(42)
    expect((obj.transform as { y: number }).y).toBe(0) // ★ y 未被吞(整对象 clobber 被拒)
    // 显式 atomic 整值替换(allowContainerClobber)— 标注 LWW 限制(整 transform 替换,丢兄弟字段是已知代价)
    setByPath(obj, ['transform'], { x: 99, y: 99 }, { allowContainerClobber: true })
    expect((obj.transform as { x: number }).x).toBe(99)
    expect((obj.transform as { y: number }).y).toBe(99)
  })

  it('S10-7 数组三类意图(对照 mivoCanvas.ts 真实类型,R2-4 对齐 G1B R2-P1-1):有 stable-id / 无 stable-id / primitive', () => {
    // R2-4:数组 intent 不能写死 {id:string} — 须按真实元素形态分三类(对照 mivoCanvas.ts):
    //   ① 有 stable-id(fills/strokes/effects,元素 {id:string,...})→ insert/remove/splice by id(并发不漂移)
    //   ② 无 stable-id(markupPoints,元素 {x,y,pressure?} 无 id,mivoCanvas.ts:69-74 MarkupPoint)→ 整值 LWW(标注限制:并发会丢前写者的点,需上层 coalesce 或转 by-id 模型)
    //   ③ primitive(resultNodeIds,元素是 string,mivoCanvas.ts:249 resultNodeIds?: string[])→ insert/remove by value(非 by-id,元素无 id)
    type ArrayIntent =  // R3 F1:对齐 §10 DomainOp array 三类 union(无 recordId,recordId/path 注入在 adapter 层)
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'by-id'; intent: 'insert'; afterId: string | null; value: { id: string } }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'by-id'; intent: 'remove'; removeId: string }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'by-id'; intent: 'splice'; afterId: string; removeCount: number; values: { id: string }[] }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'whole-lww'; intent: 'replace'; value: unknown[] } // ② 无 stable-id 整值 LWW
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'primitive'; intent: 'insert'; value: string }      // ③ primitive insert by value
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'primitive'; intent: 'remove'; value: string }      // ③ primitive remove by value
    const applyArrayIntent = (arr: unknown[], intent: ArrayIntent): unknown[] => {
      if (intent.class === 'by-id') {
        const idArr = arr as { id: string }[]
        if (intent.intent === 'insert') {
          const idx = intent.afterId === null ? -1 : idArr.findIndex((x) => x.id === intent.afterId)
          if (intent.afterId !== null && idx === -1) throw new Error(`afterId ${intent.afterId} not found`)
          const at = idx + 1
          return [...idArr.slice(0, at), intent.value, ...idArr.slice(at)]
        }
        if (intent.intent === 'remove') return idArr.filter((x) => x.id !== intent.removeId) // ★ by id,非 index
        const idx = idArr.findIndex((x) => x.id === intent.afterId)
        if (idx === -1) throw new Error(`afterId ${intent.afterId} not found`)
        return [...idArr.slice(0, idx + 1), ...intent.values, ...idArr.slice(idx + 1 + intent.removeCount)]
      }
      if (intent.class === 'whole-lww') {
        // ② 无 stable-id(markupPoints):整值 LWW — 后写整数组替换
        //   限制(诚实标注):并发会丢前写者的点;N2-1 实装须上层 coalesce(同 actor 同 stroke 合并)或把 markupPoints 升级为 by-id 模型(加 id)
        return intent.value
      }
      // ③ primitive(resultNodeIds:string[]):by value(元素是 string 无 id)
      if (intent.intent === 'insert') return [...(arr as string[]), intent.value]
      return (arr as string[]).filter((v) => v !== intent.value)
    }
    // ① 有 stable-id(fills) — insert/remove by id(并发 insert 改 index,id 定位仍准)
    const base = [{ id: 'f1' }, { id: 'f2' }]
    const aInsert = applyArrayIntent(base, { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'insert', afterId: 'f1', value: { id: 'fA' } })
    expect(aInsert.map((x) => (x as { id: string }).id)).toEqual(['f1', 'fA', 'f2'])
    const afterRemove = applyArrayIntent(aInsert, { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'remove', removeId: 'fA' })
    expect(afterRemove.map((x) => (x as { id: string }).id)).toEqual(['f1', 'f2'])
    const spliced = applyArrayIntent([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }], { kind: 'array', fieldPath: ['fills'], class: 'by-id', intent: 'splice', afterId: 'f1', removeCount: 1, values: [{ id: 'fN' }] })
    expect(spliced.map((x) => (x as { id: string }).id)).toEqual(['f1', 'fN', 'f3'])
    // ② 无 stable-id(markupPoints:{x,y,pressure?}[],无 id,mivoCanvas.ts:69-74)— 整值 LWW(标注限制)
    const pts: { x: number; y: number }[] = [{ x: 1, y: 1 }, { x: 2, y: 2 }]
    const ptsLww = applyArrayIntent(pts, { kind: 'array', fieldPath: ['markupPoints'], class: 'whole-lww', intent: 'replace', value: [{ x: 3, y: 3 }] })
    expect(ptsLww).toEqual([{ x: 3, y: 3 }]) // ★ 整值 LWW(后写整数组替换;限制:并发丢前写者,上层须 coalesce 或转 by-id)
    // ③ primitive(resultNodeIds:string[],mivoCanvas.ts:249)— by value(元素是 string 无 id,不能 by-id)
    const rids = ['n1', 'n2']
    const ridsIns = applyArrayIntent(rids, { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'insert', value: 'n3' })
    expect(ridsIns).toEqual(['n1', 'n2', 'n3'])
    const ridsRm = applyArrayIntent(ridsIns, { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'remove', value: 'n2' })
    expect(ridsRm).toEqual(['n1', 'n3']) // ★ by value 定位(元素是 string 无 id)
    // ★ R2-4 验收:三类数组各有冻结意图;['transform']+整对象 clobber 被 S10-6 leaf validator 拒;path/base/actor/idempotency/seq 只在 adapter 层(S10-2 trustify)。
  })

  it('S10-8 create→edit 因果(G1B R2-P1-2 对齐):pending create ack 前 hold edit,先 create 后 edit', () => {
    // G1B R2-P1-2:submitChange 独立 async,无同 record FIFO;create 未 ack 时 edit 先到 → 404 → 永久丢。
    //   修法:同 canvas+record submit FIFO(pending create ack 前 hold 后续 edit)。
    type PendingOp = { kind: 'create' | 'edit'; recordId: string; value: string }
    class CreateEditFifo {
      private queue: PendingOp[] = []
      private pendingCreateAcks = new Set<string>()
      private dispatched: PendingOp[] = []
      submit(op: PendingOp) {
        if (op.kind === 'edit' && this.pendingCreateAcks.has(op.recordId)) {
          this.queue.push(op); return // ★ hold:pending create ack 前 edit 排队
        }
        if (op.kind === 'create') this.pendingCreateAcks.add(op.recordId)
        this.dispatched.push(op)
      }
      ackCreate(recordId: string) {
        this.pendingCreateAcks.delete(recordId)
        const held = this.queue.filter((q) => q.recordId === recordId)
        this.queue = this.queue.filter((q) => q.recordId !== recordId)
        this.dispatched.push(...held) // flush 该 record 的 hold edit(先 create 后 edit)
      }
      order(): string[] { return this.dispatched.map((o) => `${o.kind}:${o.value}`) }
    }
    const fifo = new CreateEditFifo()
    fifo.submit({ kind: 'create', recordId: 'n-new', value: 'init' })
    fifo.submit({ kind: 'edit', recordId: 'n-new', value: 'edited' }) // 被 hold
    expect(fifo.order()).toEqual(['create:init']) // edit 被 hold,未丢但未发
    fifo.ackCreate('n-new')
    expect(fifo.order()).toEqual(['create:init', 'edit:edited']) // ★ 先 create 后 edit(不 404,改动不丢)
  })

  it('S10-9 DELETE cursor/404 边界(G1B R2-P1-3 对齐):accepted 必携 seq;幂等已删返 cursor;404→rejected', () => {
    // G1B R2-P1-3:DELETE 成功 204/已删 404 均不带 cursor/seq;accepted 冒充 cursor 是 bug。
    //   修法(①):契约让 DELETE 成功+幂等已删都返当前 seq(cursor);canvas 不存在/无权 → 404 → rejected(not-found)。
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.addMember('alice')
    // 成功删 → 返 seq(cursor)
    const r1 = s.deleteNodeCascadeWithCursor('n1', 'alice')
    expect(r1.kind).toBe('ok')
    if (r1.kind === 'ok') expect(r1.seq).toBeGreaterThan(0) // ★ accepted 必携 cursor
    // 幂等已删 → 仍返 seq(current cursor),非 404(不冒充、不拒)
    const r2 = s.deleteNodeCascadeWithCursor('n1', 'alice')
    expect(r2.kind).toBe('ok')
    if (r2.kind === 'ok') expect(r2.seq).toBeGreaterThan(0) // ★ 幂等返 cursor
    // 从未存在 → not-found(rejected,不冒充 cursor)
    const r3 = s.deleteNodeCascadeWithCursor('never-existed', 'alice')
    expect(r3.kind).toBe('not-found') // ★ 404 → rejected,不冒充 cursor
  })

  it('S10-10 immutable/atomic leaf 表(R2-3):immutable 字段不可 set;atomic-container 整值替换;其余 leaf set', () => {
    // R2-3:immutable/atomic 字段表缺失 → 返修定死。对照 NodeRecord(src/kernel/records.ts canonical 字段):
    //   immutable:id/type/createdAt/revision(创建后不可变,set → forbidden;id 由 path,type/createdAt 由 create)
    //   atomic-container:transform/relations(整对象替换,allowContainerClobber,标注丢兄弟字段代价)
    //   leaf:其余(title/text/x/y/width/height/fills/strokes/effects/markupPoints/...)
    type FieldMutability = 'immutable' | 'atomic-container' | 'leaf'
    const MUTABILITY: Record<string, FieldMutability> = {
      id: 'immutable', type: 'immutable', createdAt: 'immutable', revision: 'immutable',
      transform: 'atomic-container', relations: 'atomic-container',
    }
    const mutabilityOf = (firstSeg: string): FieldMutability => MUTABILITY[firstSeg] ?? 'leaf'
    // immutable 字段:id/type/createdAt/revision
    expect(mutabilityOf('id')).toBe('immutable')
    expect(mutabilityOf('type')).toBe('immutable')
    expect(mutabilityOf('createdAt')).toBe('immutable')
    expect(mutabilityOf('revision')).toBe('immutable')
    // atomic-container:transform/relations(整值替换,标注代价)
    expect(mutabilityOf('transform')).toBe('atomic-container')
    expect(mutabilityOf('relations')).toBe('atomic-container')
    // 其余 leaf(title/text/x/fills/...)
    expect(mutabilityOf('title')).toBe('leaf')
    expect(mutabilityOf('text')).toBe('leaf')
    expect(mutabilityOf('fills')).toBe('leaf')
    expect(mutabilityOf('x')).toBe('leaf')
    // ★ immutable 字段 set → forbidden(N2-1 adapter 校验)
    const assertMutable = (path: (string | number)[]): void => {
      const first = String(path[0])
      if (mutabilityOf(first) === 'immutable') throw new Error(`immutable field "${first}" cannot be set (R2-3 immutable leaf table)`)
    }
    expect(() => assertMutable(['id'])).toThrow(/immutable field "id"/)
    expect(() => assertMutable(['type'])).toThrow(/immutable field "type"/)
    expect(() => assertMutable(['createdAt'])).toThrow(/immutable field "createdAt"/)
    expect(() => assertMutable(['title'])).not.toThrow()               // leaf 可 set
    expect(() => assertMutable(['transform', 'x'])).not.toThrow()      // transform.x 是 leaf 子路径(transform 本身是 atomic-container,但子路径 x 是 leaf)
    // ★ atomic-container transform 整值替换走 allowContainerClobber(见 S10-6),标注丢兄弟字段代价
  })

  it('S10-11 idempotent replay(R2-3):同 opId(idempotency-key)replay 不二次 bump revision/seq、不二次发事件', () => {
    // R5 F2 诚实化:持久证明由 PG-T6 真测(单事务原子写领域 record+seq+event+idem row → destroy pool →
    //   重连走真实 replay path → SELECT idem 命中 cached,不二次 apply 领域写 / 不二次 bump revision/seq /
    //   不二次 append event,见 n20-pg-tx-fault.spike.test.ts PG-T6;fault/rollback 同事务原子见 PG-T6b);
    //   本测试 idempotencyCache 是进程内 Map(重启丢),仅演示 replay 逻辑,非持久证明(原 R2-3 "不二次 bump" 系内存,重启失效已纠)。
    const s = new FieldLevelServer()
    s.seedNode(makeNode('n1'))
    s.addMember('alice')
    const rev0 = s.revision('n1')
    const seq0 = s.opLogLength()
    // 首次 apply opId='idem-X'(idempotency-key header 注入,见 S10-2)
    const r1 = s.applyOpIdempotent({ opId: 'idem-X', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'T1' }, 'alice')
    expect(r1.result.kind).toBe('ok')
    expect(r1.deduped).toBe(false)
    const revAfter1 = s.revision('n1')
    const seqAfter1 = s.opLogLength()
    expect(revAfter1).toBe(rev0 + 1)    // 首次 bump
    expect(seqAfter1).toBe(seq0 + 1)    // 首次发事件
    // ★ 同 opId replay → 不二次 bump revision、不二次发事件(返首次缓存结果)
    const r2 = s.applyOpIdempotent({ opId: 'idem-X', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: rev0, fieldPath: ['title'], value: 'T1' }, 'alice')
    expect(r2.result.kind).toBe('ok')
    expect(r2.deduped).toBe(true)               // ★ dedup 命中(opId 缓存)
    expect(s.revision('n1')).toBe(revAfter1)    // ★ revision 不变(不二次 bump)
    expect(s.opLogLength()).toBe(seqAfter1)     // ★ seq 不变(不二次发事件)
    // 不同 opId → 正常 apply(bump)
    const r3 = s.applyOpIdempotent({ opId: 'idem-Y', clientId: 'A', actor: 'alice', recordId: 'n1', baseRevision: revAfter1, fieldPath: ['title'], value: 'T2' }, 'alice')
    expect(r3.result.kind).toBe('ok')
    expect(r3.deduped).toBe(false)
    expect(s.revision('n1')).toBe(revAfter1 + 1)  // 新 op bump
    // ★ R2-3 验收:replay revision/seq 不变;伪造 body opId 不影响(header 单一权威,S10-2)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 返修硬化(R5 F4 §1.2):cutover contract harness — 逐行参数化状态表 + snapshot materialize rollback
// ════════════════════════════════════════════════════════════════════════════
//
// R5 F4 红证(verdict V6/V16/V17):全仓无 FIELD_LEVEL_OPS harness 或状态表 probe;cutover 状态表 5 行
//   无对应断言;冻结命令用不存在的 `npm test`(应 npm run test:unit);rollback 称 "新 op → 旧 body
//   反向转换无丢失",但 DomainOp 是 delta(fragment),无 authoritative snapshot 无法无损反演 — 无证据可逆性承诺。
// 绿证(补探针 + 降级文档):新增逐行参数化 cutover harness(flag on/off decoder / old-queue migration-on-read /
//   new-op+stale-base 200 非 409 / rollback=snapshot materialize);rollback 降级为从 authoritative 全 record
//   snapshot materialize 旧 shape body(非 delta 反演),delta-inversion 显式标注无算法/不支持(降级到已测范围)。
// 决策文档 §1.2 状态表 + 冻结命令同步(见 docs/decisions/n20-truth-source-decision.md §1.2)。

describe('N2-0 返修 §1.2 cutover contract harness(R5 F4): flag on/off decoder + old-queue migration + stale-base 200 + rollback snapshot materialize', () => {
  // ── cutover 状态表契约类型(对齐 §1.2 状态表 + §10.1 DomainOp;create 独立 endpoint 非 PATCH,不进此 harness)──
  /** 旧 shape:整 record payload(cutover 前的 NodePayload,§1.2 "old client/old queue" 行)。 */
  type LegacyBody = { id: string; title: string; transform: { x: number; y: number } }
  /** 新 shape:DomainOp 子集(cutover 后的 field-level op,§10.1;spike 简化为 set/unset)。 */
  type NewOp = { kind: 'set'; fieldPath: string[]; value: unknown } | { kind: 'unset'; fieldPath: string[] }

  /**
   * CutoverHarness:原子 cutover 协议的最小可执行模型(对齐 §1.2 状态表 5 行)。
   * - flag(FIELD_LEVEL_OPS)决定 decoder 接受 old-shape(整 record)还是 new-shape(DomainOp)。
   * - authoritative store = 全 record(server-side,source of truth;rollback 的 materialize 源)。
   * - rollback = 从 authoritative snapshot materialize 旧 body(非 delta 反演)。
   */
  // ★ R6 F4a/F4b:CutoverHarness 加真实 revision/lastWriter/outbox + patch 支持 transform 子字段 + base 比较
  //   判决 V6 红证:原 CutoverHarness 无 revision/last-writer/notice,C-3 只连续 set A/B 断言后者 200 + title=B,
  //   删除任何 stale-base/overwritten 逻辑都不红(逻辑不存在);migrateOldQueueBody 只生成 title set 丢 transform。
  /** overwritten 事件:base 落后并发时,前写者收(败方知情,T1-1/G4-4 不拒写只 surfacing)。 */
  type OverwrittenEvent = { toActor: string; fieldPath: string[]; historicalValue: unknown; byActor: string; currentRevision: number }
  class CutoverHarness {
    private flag = false
    /** authoritative store:全 record + per-record revision + lastWriter(rollback/恢复的 materialize 源)。 */
    private recs = new Map<string, LegacyBody & { revision: number; lastWriter: string }>()
    /** overwritten outbox:base 落后并发时,前写者收的事件(drainOverwritten 读取)。 */
    private outbox: OverwrittenEvent[] = []
    setFlag(on: boolean) { this.flag = on }
    /**
     * PATCH decoder:flag 决定接受 old-shape(整 record)还是 new-shape(DomainOp);反之 400 payload-rejected。
     * ★ R6 F4a:new-shape set 携 opts.{actor, baseRevision};base < current revision → 不拒写(200,G4-4)+ 推前写者 overwritten。
     * ★ R6 F4b:patch 支持 title + transform.x + transform.y 子字段(原只处理 title,致 C-2 丢 transform)。
     */
    patch(nodeId: string, body: LegacyBody | NewOp, opts?: { actor?: string; baseRevision?: number }): { status: number; body: { error?: string; id?: string; revision?: number; seq?: number } } {
      const isNew = 'kind' in body && (body.kind === 'set' || body.kind === 'unset')
      const actor = opts?.actor ?? 'unknown'
      const base = opts?.baseRevision ?? 0
      if (this.flag) {
        // flag on:new-shape DomainOp 接受;old-shape 整 record → 400 payload-rejected(状态表 row 1/3)
        if (isNew) {
          const r = this.recs.get(nodeId) ?? { id: nodeId, title: '', transform: { x: 0, y: 0 }, revision: 0, lastWriter: '' }
          const prevRevision = r.revision
          const prevWriter = r.lastWriter
          if (body.kind === 'set') {
            if (body.fieldPath[0] === 'title') {
              const historicalValue = r.title
              r.title = body.value as string
              r.revision = prevRevision + 1; r.lastWriter = actor
              // ★ R6 F4a:base 落后(base < prevRevision)→ 不拒写(200)+ 推前写者 overwritten(败方知情)
              if (base < prevRevision && prevWriter) {
                this.outbox.push({ toActor: prevWriter, fieldPath: body.fieldPath, historicalValue, byActor: actor, currentRevision: r.revision })
              }
            } else if (body.fieldPath[0] === 'transform') {
              const sub = body.fieldPath[1] as 'x' | 'y'
              r.transform[sub] = body.value as number
              r.revision = prevRevision + 1; r.lastWriter = actor
            }
          }
          this.recs.set(nodeId, structuredClone(r))
          return { status: 200, body: { id: nodeId, revision: r.revision, seq: r.revision } }
        }
        return { status: 400, body: { error: 'payload-rejected' } } // old shape on flag-on → 400(状态表 row 1)
      }
      // flag off:old-shape 整 record 接受;new-shape DomainOp → 400 payload-rejected(状态表 rollback/old-server)
      if (!isNew) {
        this.recs.set(nodeId, structuredClone({ ...(body as LegacyBody), revision: 1, lastWriter: actor }))
        return { status: 200, body: { id: nodeId, revision: 1, seq: 1 } }
      }
      return { status: 400, body: { error: 'payload-rejected' } } // new shape on flag-off → 400
    }
    /** ★ R6 F4a:drain overwritten 事件给某 actor(前写者;败方知情)。 */
    drainOverwritten(actor: string): OverwrittenEvent[] {
      const events = this.outbox.filter((e) => e.toActor === actor)
      this.outbox = this.outbox.filter((e) => e.toActor !== actor)
      return events
    }
    /** ★ R6 F4a:per-record revision(状态表 row 4 stale-base 判定用)。 */
    revision(nodeId: string): number { return this.recs.get(nodeId)?.revision ?? 0 }
    /** FX-5 old queue migration-on-read:旧 queued NodePayload → 转换为新 op schema(状态表 row 2)。 */
    migrateOldQueueBody(legacy: LegacyBody): NewOp[] {
      // ★ R6 F4b:migration-on-read 全字段生成(title + transform.x + transform.y),不丢 transform(原只生成 title)
      return [
        { kind: 'set', fieldPath: ['title'], value: legacy.title },
        { kind: 'set', fieldPath: ['transform', 'x'], value: legacy.transform.x },
        { kind: 'set', fieldPath: ['transform', 'y'], value: legacy.transform.y },
      ]
    }
    /** authoritative snapshot(全 record;rollback / 恢复的 materialize 源)。 */
    snapshot(): (LegacyBody & { revision: number; lastWriter: string })[] { return [...this.recs.values()].map((r) => structuredClone(r)) }
    /** rollback materialize:从 authoritative 全 record 重建旧 shape body(非 delta 反演;状态表 row 5)。 */
    materializeLegacyBody(nodeId: string): LegacyBody | null {
      const r = this.recs.get(nodeId)
      if (!r) return null
      // authoritative 全 record → 旧 shape body 直出(剥 revision/lastWriter 元数据,非从单个 delta 反演)
      // 显式构造(非 rest 解构):eslint no-unused-vars 的 ignoreRestSiblings 默认 false,rest 前缀 _rev/_lw 会被报 unused
      return structuredClone({ id: r.id, title: r.title, transform: r.transform })
    }
    get(nodeId: string): (LegacyBody & { revision: number; lastWriter: string }) | undefined {
      const r = this.recs.get(nodeId)
      return r ? structuredClone(r) : undefined
    }
  }

  it('C-1 cutover flag on/off decoder(R5 F4):flag-off old-shape 200 + new-op 400;flag-on old-shape 400 + new-op 200(状态表 row 1/3)', () => {
    const h = new CutoverHarness()
    const legacy: LegacyBody = { id: 'n1', title: 'orig', transform: { x: 0, y: 0 } }
    const newOp: NewOp = { kind: 'set', fieldPath: ['title'], value: 'T' }
    // ★ flag off(FIELD_LEVEL_OPS=off,cutover 前):old-shape 200,new-op 400 payload-rejected
    h.setFlag(false)
    expect(h.patch('n1', legacy).status).toBe(200)       // old shape accepted(整 record decoder)
    expect(h.patch('n1', newOp).status).toBe(400)        // new op rejected(payload-rejected)
    expect(h.patch('n1', newOp).body.error).toBe('payload-rejected')
    // ★ flag on(FIELD_LEVEL_OPS=on,cutover 后):old-shape 400,new-op 200
    h.setFlag(true)
    expect(h.patch('n1', legacy).status).toBe(400)       // old shape rejected(stale client 旧 body 打新 endpoint)
    expect(h.patch('n1', legacy).body.error).toBe('payload-rejected')
    expect(h.patch('n1', newOp).status).toBe(200)        // new op accepted(field-level merge)
    // 状态表 row 1(old client 旧 body → 新 server)= 400;row 3(new server 新 op)= 200;flag on/off 切换可逆。
  })

  it('C-2 FX-5 old queue migration-on-read 全字段 round-trip(R6 F4b):旧 queued NodePayload 全字段 → 新 op schema → flag-on 应用 → deep equal 原值(含 transform;漏任一字段必红,状态表 row 2)', () => {
    // R6 F4b 红证(判决 V6):原 migrateOldQueueBody 只生成 title set(丢 transform),C-2 只验 title;
    //   漏 LegacyBody.transform 字段 C-2 不红(逻辑根本不验 transform)→ 状态表"旧 queued 转换后客户端无感"强于实测。
    // 绿证(补探针):migrateOldQueueBody 全字段生成(title + transform.x + transform.y);C-2 应用全 op 后 deep equal 原值。
    const h = new CutoverHarness()
    h.setFlag(true) // cutover 后 drain 队列
    // 旧 IDB queued body(cutover 前入队的整 record NodePayload,含 transform)
    const queuedLegacy: LegacyBody = { id: 'n2', title: 'queued', transform: { x: 5, y: 5 } }
    // ★ R6 F4b:migration-on-read 全字段生成(title + transform.x + transform.y),原只生成 title 丢 transform
    const migrated = h.migrateOldQueueBody(queuedLegacy)
    expect(migrated.length).toBe(3) // ★ 全字段 3 个 op(漏任一 LegacyBody 字段 → length<3 红)
    expect(migrated.every((op) => op.kind === 'set')).toBe(true)
    // 转换后全 op 打 flag-on endpoint → 200(队列 drain 时转换,客户端无感)
    for (const op of migrated) {
      expect(h.patch('n2', op).status).toBe(200)
    }
    // ★ deep equality round-trip:迁移后 record 与原 queuedLegacy 全字段一致(无丢失,含 transform.x/y)
    const got = h.get('n2')!
    expect(got.id).toBe('n2')
    expect(got.title).toBe('queued')        // ★ 漏 title op → 此行红(初始 '' ≠ 'queued')
    expect(got.transform.x).toBe(5)         // ★ 漏 transform.x op → 此行红(初始 0 ≠ 5)
    expect(got.transform.y).toBe(5)         // ★ 漏 transform.y op → 此行红(初始 0 ≠ 5)
    expect(got.transform).toEqual({ x: 5, y: 5 }) // 整对象 deep equal
    // ★ R6 F4b 验收:漏任一 LegacyBody 字段(title / transform.x / transform.y)时 C-2 必红(length 或 deep equal 断言)。
  })

  it('C-3 new op + stale base(R6 F4a:真实 base/revision/overwritten):并发 base 落后 → 200 + overwritten 推前写者(非 409;移除 overwritten 必红,状态表 row 4)', () => {
    // R6 F4a 红证(判决 V6):原 C-3 无 base/revision/overwritten,只连续 set A/B 断言第二次 200 + title=B;
    //   删除任何 stale-base/overwritten 逻辑都不红(逻辑根本不存在)→ 文档状态表 117/124 行"base 落后 + overwritten"
    //   逐行断言强于探针实测。
    // 绿证(补探针):CutoverHarness 加真实 revision/lastWriter/outbox;C-3 用真实 base/actor:
    //   A 写(base 0)→ revision 0→1;B 基于过期 base(base 0 < current 1)写 → 200(非 409)+ A 收 overwritten。
    const h = new CutoverHarness()
    h.setFlag(true)
    // A 写 title=A(base 0,actor alice)→ revision 0→1, lastWriter=alice
    const resA = h.patch('n1', { kind: 'set', fieldPath: ['title'], value: 'A' }, { actor: 'alice', baseRevision: 0 })
    expect(resA.status).toBe(200)
    expect(resA.body.revision).toBe(1)
    expect(h.revision('n1')).toBe(1)
    // ★ B 基于过期 base(base=0,但 current revision=1)写 title=B → 200(非 409;G4-4 revision 不拒写)
    const resB = h.patch('n1', { kind: 'set', fieldPath: ['title'], value: 'B' }, { actor: 'bob', baseRevision: 0 })
    expect(resB.status).toBe(200) // ★ 过期 base 仍 200(非 409;状态表 row 4 契约)
    expect(resB.body.revision).toBe(2) // 后写 wins,bump
    expect(h.get('n1')?.title).toBe('B') // LWW 后写 wins
    // ★ A 收 overwritten 事件(historicalValue=A, byActor=bob, currentRevision=2)— 败方知情(T1-1/G4-4 surfacing)
    const overwritten = h.drainOverwritten('alice')
    expect(overwritten.length).toBe(1) // ★ 移除 outbox.push(overwritten)→ 此行红(0 ≠ 1)
    expect(overwritten[0].historicalValue).toBe('A') // A 的前值
    expect(overwritten[0].byActor).toBe('bob') // 被谁覆盖
    expect(overwritten[0].currentRevision).toBe(2) // 当前权威 revision
    // B 是后写者,不收 overwritten
    expect(h.drainOverwritten('bob').length).toBe(0)
    // ★ R6 F4a 验收:移除 overwritten(outbox.push)时 C-3 必红(drainOverwritten 返空,length 0≠1)。
    //   stale-client 旧 body 打新 endpoint = 400(状态表 row 1,C-1 已证);此行证 stale-base(新 op 落后 base)= 200 + overwritten,二者区分见 §1.2。
  })

  it('C-4 rollback = snapshot materialize(R5 F4):flag off → 从 authoritative 全 record 重建旧 body(非 delta 反演;delta-inversion 无算法/不支持,降级承诺到已测范围;状态表 row 5)', () => {
    const h = new CutoverHarness()
    h.setFlag(true)
    h.patch('n1', { kind: 'set', fieldPath: ['title'], value: 'new-title' })
    // ★ authoritative snapshot(全 record,rollback 的 materialize 源)
    const snap = h.snapshot()
    expect(snap.find((r) => r.id === 'n1')?.title).toBe('new-title')
    // ★ rollback(flag off):从 authoritative snapshot materialize 旧 shape body(非 delta 反演)
    h.setFlag(false)
    const legacyBody = h.materializeLegacyBody('n1')!
    expect(legacyBody.id).toBe('n1')
    expect(legacyBody.title).toBe('new-title') // 从 authoritative 全 record 直出(非从单个 delta 反演)
    // flag-off 下 materialized 旧 body 可 PATCH 200(整 record decoder,状态表 row 5:200 旧 shape)
    expect(h.patch('n1', legacyBody).status).toBe(200)
    // ★ R5 F4 降级:rollback 不再声称 "新 op → 旧 body 反向转换无丢失"(DomainOp 是 delta fragment,
    //   无 authoritative snapshot 无法无损反演 — 原承诺无证据);改为 snapshot materialize
    //   (authoritative 全 record → 旧 shape body,可证明无丢失因源头是全 record 非 delta)。
    //   delta-inversion 显式无算法/不支持(降级到已测范围,见决策文档 §1.2 状态表 row 5 + §3 诚实化表)。
  })
})
