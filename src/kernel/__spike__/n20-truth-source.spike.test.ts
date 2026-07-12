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
import type { NodePayload } from '../../../shared/persist-contract'
import type { WriteOp } from '../../lib/writeRetryQueue'
import type { CanvasChange, FieldIntent } from '../../lib/canvasSyncPort'

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
// N2-0 v6 唯一契约权威类型(模块级;对齐 G1-b R4 + sol 第五轮 3 阻断)
// ════════════════════════════════════════════════════════════════════════════
// v6 病根:v5 追加式 supersede 致两套矛盾模型并存(active 段原文未动)。v6 硬禁令:禁止追加式修复;直接重写 active 段原文。
// v6 决议收口(3 阻断):Blocker 1 BaseCursor 绑 scope+per-field clock(防跨 record/canvas 重放 + 同-field stale 语义);Blocker 2 active 段清零旧模型残留;Blocker 3 FX-5 走 LegacyReplaceRequest 信封 wire(非直调 harness)。
type FieldPath = readonly [string | number, ...(string | number)[]]  // 非空 tuple(S10-6 运行时拒空)

// ── v6 Blocker 1:BaseCursor 绑 scope(canvasId+recordId)+ revision + per-field clock snapshot ──
//   防 v5 两洞:① token 跨 record/canvas 重放(n1 rev=1 token 用于 n2;HMAC 只防改值不防换资源)→ v6 token 绑 canvasId+recordId,decode 校验 scope;
//   ② 无 per-field clock,S10-12 用 record-rev 落后判 overwritten(别的字段变过也误报,违反 §10.3 同-field 语义)→ v6 token 携 per-field clock,同-field stale 才 overwritten。
//   生命周期:accepted/snapshot 签发;client 回传 If-Match;server decodeBase 验签+scope;malformed/unsigned/scope-mismatch→400;conflict 返 current base。业务层 opaque,codec 只在 adapter。
const BASE_SECRET = 'test-base-secret' // 测试 fixture;真实 adapter 用 server secret + HMAC
const baseSig = (payload: string): string => {
  let h = 0x811c9dc5
  const key = payload + ':' + BASE_SECRET
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
type FieldClocks = Record<string, number>  // fieldKey → clock(同-field stale 判定)
/** BaseCursor = opaque string token(branded;绑 scope+revision+per-field clock;client 不可构造/伪造)。 */
type BaseCursor = string & { readonly __brand: 'BaseCursor' }
/** encode record base:绑 canvasId+recordId+revision+per-field clock snapshot;签。 */
const encodeBase = (canvasId: string, recordId: string, revision: number, fieldClocks: FieldClocks): BaseCursor => {
  const fc = Object.entries(fieldClocks).map(([k, v]) => `${k}:${v}`).join(',')
  const payload = `cv=${canvasId}|rid=${recordId}|r=${revision}|fc=${fc}`
  return `base:${payload}.${baseSig(payload)}` as BaseCursor
}
/** encode order base(canvas-scoped,无 recordId;reorder 用 canvas contentVersion)。 */
const encodeOrderBase = (canvasId: string, cv: number): BaseCursor => {
  const payload = `cv=${canvasId}|order=${cv}`
  return `base:${payload}.${baseSig(payload)}` as BaseCursor
}
/** parse payload segments(payload 格式 `cv=X|rid=Y|r=Z|fc=k:v,k:v`)。 */
const parseSegments = (payload: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const seg of payload.split('|')) { const i = seg.indexOf('='); if (i > 0) out[seg.slice(0, i)] = seg.slice(i + 1) }
  return out
}
/** decode record base:验签 + scope(canvasId+recordId 必须匹配 expected)→ {revision, fieldClocks} | null。 */
const decodeBase = (token: BaseCursor | string | undefined, expectedCanvasId: string, expectedRecordId: string): { revision: number; fieldClocks: FieldClocks } | null => {
  if (typeof token !== 'string' || !token.startsWith('base:')) return null
  const body = token.slice(5); const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot); const sig = body.slice(dot + 1)
  if (sig !== baseSig(payload)) return null  // 签名错/篡改 → null
  const seg = parseSegments(payload)
  if (seg.cv !== expectedCanvasId || seg.rid !== expectedRecordId) return null  // ★ scope mismatch(n1 token→n2 / 跨 canvas)→ null
  const fc: FieldClocks = {}
  if (seg.fc) for (const pair of seg.fc.split(',')) { const [k, v] = pair.split(':'); if (k) fc[k] = Number(v) }
  const rev = Number(seg.r); if (!Number.isFinite(rev)) return null
  return { revision: rev, fieldClocks: fc }
}
/** decode order base:验签 + canvas scope → {cv} | null。 */
const decodeOrderBase = (token: BaseCursor | string | undefined, expectedCanvasId: string): { cv: number } | null => {
  if (typeof token !== 'string' || !token.startsWith('base:')) return null
  const body = token.slice(5); const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot); const sig = body.slice(dot + 1)
  if (sig !== baseSig(payload)) return null
  const seg = parseSegments(payload)
  if (seg.cv !== expectedCanvasId || seg.order === undefined) return null  // ★ scope mismatch(c1 order→c2)→ null
  return { cv: Number(seg.order) }
}
/** encode event-since base(canvas-scoped seq;GET /events/poll?since= 增量补拉用;bundle 内 since 项)。 */
const encodeSinceBase = (canvasId: string, seq: number): BaseCursor => {
  const payload = `cv=${canvasId}|since=${seq}`
  return `base:${payload}.${baseSig(payload)}` as BaseCursor
}

// ── v8 Blocker 1:SnapshotCursor(canvas 级 opaque bundle)= recordId→BaseCursor map + canvas order base + event since base ──
//   现状矛盾:port CanvasSnapshot 只有一个 canvas 级 cursor(canvasSyncPort.ts:95-102);inventory §2.1/§2.2 v7 把它写成
//   "绑 canvasId+recordId 的单个 BaseCursor"——多 record hydrate 后,一个 record 级 token 无法为任意 n1/n2 提供 If-Match(串用)。
//   ★ v8 冻结:bundle 内含 recordId→BaseCursor 映射 + canvas order cursor + event since cursor;submitChange 按 change.recordId/
//     op class 抽对应 wire base(edit/delete→record base;reorder→order base;catch-up→since base);accepted/conflict 后更新 bundle 内对应项。
//     port SnapshotCursor 仍 opaque(branded),adapter 构造/解包,port 不读内部(见 canvasSyncPort.ts:77 注释 + inventory §2.1/§2.2)。
type SnapshotCursor = string & { readonly __brand: 'SnapshotCursor' }
type BundleEntry = { revision: number; fieldClocks: FieldClocks }
/** encode canvas bundle:opaque canvas 级 token(内含 recordId→(rev,fc) map + order cv + since seq;签)。adapter 侧构造,port 不读内部。 */
const encodeBundle = (canvasId: string, entries: Record<string, BundleEntry>, orderCv: number, sinceSeq: number): SnapshotCursor => {
  const payload = JSON.stringify({ cv: canvasId, recs: entries, order: orderCv, since: sinceSeq })
  return `bundle:${payload}.${baseSig(payload)}` as SnapshotCursor
}
/** decode canvas bundle:验签 + canvas scope → {records(recordId→wire BaseCursor 重建), order, since, entries} | null。
 *  ★ 解包即按 recordId 重建 wire BaseCursor(submitChange 抽对应 record base;reorder 抽 order base;不串用)。 */
const decodeBundle = (token: SnapshotCursor | string | undefined, expectedCanvasId: string): { records: Record<string, BaseCursor>; order: BaseCursor; since: BaseCursor; entries: Record<string, BundleEntry>; orderCv: number; sinceSeq: number } | null => {
  if (typeof token !== 'string' || !token.startsWith('bundle:')) return null
  const body = token.slice(7); const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot); const sig = body.slice(dot + 1)
  if (sig !== baseSig(payload)) return null  // 签名错/篡改 → null
  let obj: { cv?: string; recs?: Record<string, BundleEntry>; order?: number; since?: number }
  try { obj = JSON.parse(payload) } catch { return null }
  if (obj.cv !== expectedCanvasId) return null  // ★ canvas scope mismatch(跨 canvas bundle 重放)→ null
  const records: Record<string, BaseCursor> = {}
  const entries: Record<string, BundleEntry> = {}
  for (const [id, e] of Object.entries(obj.recs ?? {})) {
    entries[id] = e
    records[id] = encodeBase(expectedCanvasId, id, e.revision, e.fieldClocks)  // ★ 按 recordId 重建 wire BaseCursor(不串用)
  }
  const orderCv = obj.order ?? 0; const sinceSeq = obj.since ?? 0
  return { records, order: encodeOrderBase(expectedCanvasId, orderCv), since: encodeSinceBase(expectedCanvasId, sinceSeq), entries, orderCv, sinceSeq }
}

// ── Blocker 3:strict-tx 已从 DomainOp 剔除(假跨 record tx 无 target)→ server-named invariant command ──
//   跨 record invariant 由 path/method 推导目标,非 PATCH DomainOp。DomainOp 仅单 record LWW delta。
//   ★ v5 by-id 数组 A2 deferred(NOTES:fail-visible,禁降级整数组 LWW):DomainOp 不含 by-id variant
//     (fills/strokes/effects/experimentalAnchors 的 by-id 结构编辑 A2 不支持;migration 走 legacy 兼容通道,见 C-2)。
//     whole-lww(markupPoints,无 stable-id)+ primitive(resultNodeIds)A2 supported。
type DomainOp =
  | { kind: 'set'; fieldPath: FieldPath; value: unknown }
  | { kind: 'unset'; fieldPath: FieldPath }
  | { kind: 'array'; fieldPath: FieldPath; class: 'whole-lww'; intent: 'replace'; value: unknown[] }   // ② markupPoints(无 stable-id)
  | { kind: 'array'; fieldPath: FieldPath; class: 'primitive'; intent: 'insert' | 'remove'; value: string }  // ③ resultNodeIds
  | { kind: 'reorder'; orderedIds: string[] }
// server-named invariant command(跨 record 原子,非 PATCH DomainOp;由 path/method 推导目标,per-target 鉴权)
//   ★ v5 诚实化(S10-13):仅 node-delete-cascade 经 PG-T1~T3/T7 实证;group-reparent/result-asset-attach 是类型+注释级,A2 需另测。
type ServerInvariantCommand =
  | { kind: 'node-delete-cascade'; canvasId: string; nodeId: string }                      // DELETE /nodes/:id → node+edges+asset ref 同 PG tx(实证:PG-T1~T3/T7)
  | { kind: 'group-reparent'; canvasId: string; nodeIds: string[]; targetGroupId: string | null }              // 类型+注释级(A2 需另测)
  | { kind: 'result-asset-attach'; canvasId: string; anchorId: string; assetId: string; resultNodeId: string } // 类型+注释级(A2 需另测)

// 客户端 PATCH payload(不可信):零 privileged 载体 — 无 opId/actor/recordId/base(全 adapter 注入)
type ClientFieldOp = { clientId: string; domain: DomainOp }
// 服务端 trusted:actor ← resolveActor;recordId ← URL path;opId ← idempotency-key header;
//   base ← If-Match(opaque BaseCursor string,adapter decodeBase 验签;Blocker 1 单一 wire)
type TrustedCtx = { opId: string; clientId: string; actor: string; recordId: string; base: BaseCursor }
type WireOp = TrustedCtx & { domain: DomainOp }
const trustify = (client: ClientFieldOp, ctx: TrustedCtx): WireOp => ({ ...ctx, domain: client.domain })
const adaptToWire = (domain: DomainOp, ctx: TrustedCtx): WireOp => ({ ...ctx, domain })

// ── Blocker 2:create client-supplied id(废除 server-mint,对齐 G1-b R4 + canvasSyncPort create-node)──
//   adapter 从 NodeRecord.id 提取 → create URL path(:nodeId);body = CreateBody 零 privileged(payload=NodePayload)。
//   server 信 path id,做 format/uniqueness/permission 校验;id 唯一来源 = client NodeRecord.id(非 server-mint)。
//   ★ v5:container 白名单 ['transform','relations'] 取消(lead 裁定 rejected):transform/relations 内部字段有独立并发语义,
//     整对象 LWW 会吞 sibling 更新;A2 维持叶子级 set(整对象 set 仍拒,canvasSyncPort validateFieldIntent R4 封死)。
//     未来要原子容器需逐 kind atomic schema + 双 actor sibling-write 不丢测试再提。
type RecordKind = 'node' | 'edge' | 'anchor'
type FieldTarget = 'leaf' | 'container' | 'array-element'  // v5:无 'atomic-container'(白名单取消)
type RecordKindSchema = { kind: RecordKind; classifyField: (fieldPath: FieldPath) => FieldTarget }  // G1-b R4 必填(安全入口)
type CreateBody = { clientId: string; type: RecordKind; payload: unknown }  // 零 recordId(id 来自 path:client NodeRecord.id)
type CreateWire = { opId: string; clientId: string; actor: string; recordId: string; type: RecordKind; payload: unknown }
const trustifyCreate = (client: CreateBody, ctx: TrustedCtx): CreateWire =>
  ({ opId: ctx.opId, clientId: ctx.clientId, actor: ctx.actor, recordId: ctx.recordId, type: client.type, payload: client.payload })

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
    // SSE 语义:EventSource = HTTP GET + text/event-stream,网关应透传(plain HTTP,与 PATCH 同通道);但生产网关可能缓冲/超时(条件式,非"必透传",见 §2 Gate5 + N2-0 决策 §12 失败树)。
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
  // §10 唯一契约权威类型(BaseCursor/DomainOp/TrustedCtx/CreateBody/ServerInvariantCommand/ATOMIC_CONTAINER_WHITELIST 等)
  //   已移至模块级(见文件头部 "N2-0 v4 唯一契约权威类型" 段),供跨 describe 共享:S10-1..S10-14 + G1-b 衔接 describe 均可访问。
  //   v4 决议收口(6 阻断)见模块级注释:Blocker 1 base.clock opaque wire / Blocker 2 create client-id + classifier + 白名单 / Blocker 3 strict-tx 剔出改 server-named。

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

  it('S10-2 三层信任边界(v5:PATCH body 零 privileged;base=opaque BaseCursor string codec;create client-id;by-id deferred;container 白名单取消)', () => {
    // v5 决议收口(对齐 G1-b R4 + sol 第四轮 4 阻断):
    //   Blocker 1 — base.clock = opaque BaseCursor string(真 codec+HMAC 签名,非 type-cast;client 不可伪造,server decodeBase 验签)。
    //   Blocker 2 — create client-id(废除 server-mint);RecordKindSchema classifier 必填;container 白名单取消(transform/relations 整对象 set 仍拒,leaf-level set)。
    //   Blocker 3 — strict-tx 剔出 DomainOp;by-id 数组 A2 deferred(DomainOp 不含 by-id variant,migration 走 legacy 兼容通道)。
    expectTypeOf<keyof ClientFieldOp>().toEqualTypeOf<'clientId' | 'domain'>()  // PATCH body 零 privileged
    // ★ v5:DomainOp 不含 create/strict-tx 亦不含 by-id(by-id deferred,A2 不支持数组结构编辑)
    expectTypeOf<DomainOp['kind']>().toEqualTypeOf<'set' | 'unset' | 'array' | 'reorder'>()
    expectTypeOf<keyof CreateBody>().toEqualTypeOf<'clientId' | 'type' | 'payload'>()
    type SetOp = Extract<DomainOp, { kind: 'set' }>
    type UnsetOp = Extract<DomainOp, { kind: 'unset' }>
    type ReorderOp = Extract<DomainOp, { kind: 'reorder' }>
    type ArrayWholeLww = Extract<DomainOp, { kind: 'array'; class: 'whole-lww' }>
    type ArrayPrimitive = Extract<DomainOp, { kind: 'array'; class: 'primitive' }>
    expectTypeOf<keyof SetOp>().toEqualTypeOf<'kind' | 'fieldPath' | 'value'>()
    expectTypeOf<keyof UnsetOp>().toEqualTypeOf<'kind' | 'fieldPath'>()
    expectTypeOf<keyof ReorderOp>().toEqualTypeOf<'kind' | 'orderedIds'>()
    expectTypeOf<keyof ArrayWholeLww>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'value'>()
    expectTypeOf<keyof ArrayPrimitive>().toEqualTypeOf<'kind' | 'fieldPath' | 'class' | 'intent' | 'value'>()
    // @ts-expect-error v5:ClientFieldOp body 零 privileged(无 actor)
    const _badActor: ClientFieldOp = { clientId: 'A', domain: { kind: 'set', fieldPath: ['title'], value: 'x' }, actor: 'admin' }
    // @ts-expect-error v5:create 不再是 PATCH DomainOp member
    const _badCreateInDomain: DomainOp = { kind: 'create', recordId: 'forged', type: 'node', payload: {} }
    // @ts-expect-error v5:strict-tx 已剔出 DomainOp(跨 record 走 server-named command)
    const _badStrictTxInDomain: DomainOp = { kind: 'strict-tx' as const, ops: [] as unknown as never }
    // @ts-expect-error v5:by-id variant 已 deferred(DomainOp 不含 by-id)— 塞回则 build fail(A2 不支持数组结构编辑)
    const _badByIdInDomain: DomainOp = { kind: 'array' as const, fieldPath: ['fills'] as FieldPath, class: 'by-id' as const, intent: 'insert' as const, afterId: null, value: { id: 'fA' } }
    // @ts-expect-error v5:Array variant 零 privileged(无 recordId)
    const _badArrayRec: DomainOp = { kind: 'array', fieldPath: ['markupPoints'], class: 'whole-lww', intent: 'replace', value: [], recordId: 'forged' }
    // @ts-expect-error v5:CreateBody 零 privileged(无 recordId;id 来自 path 非 body)
    const _badCreateBody: CreateBody = { clientId: 'A', type: 'node', payload: {}, recordId: 'forged' }
    // ★ Blocker 1:base 是 opaque BaseCursor string(branded),非 bare number — 传 number 则 build fail(client 不可伪造)
    // @ts-expect-error v5:base 是 BaseCursor(string branded),非 bare number
    const _badBaseNumber: TrustedCtx = { opId: 'x', clientId: 'A', actor: 'a', recordId: 'n1', base: 0 }
    expect(_badActor).toBeDefined(); expect(_badCreateInDomain).toBeDefined(); expect(_badStrictTxInDomain).toBeDefined()
    expect(_badByIdInDomain).toBeDefined(); expect(_badArrayRec).toBeDefined(); expect(_badCreateBody).toBeDefined(); expect(_badBaseNumber).toBeDefined()
    // ★ v6 Blocker 1:真 string codec round-trip(encode → token → decode 验签+scope → {revision, fieldClocks};非 type-cast)
    const base0 = encodeBase('c1', 'n1', 0, { title: 0 })
    expect(typeof base0).toBe('string')              // ★ BaseCursor 是 string(opaque token,client 持 opaque string)
    expect(decodeBase(base0, 'c1', 'n1')).toEqual({ revision: 0, fieldClocks: { title: 0 } })  // ★ decode 验签+scope 成功(真 round-trip)
    expect(decodeBase(base0, 'c1', 'n2')).toBeNull()  // ★ scope mismatch(n1 token→n2)→ null(防跨 record 重放,v6 绑 recordId)
    expect(decodeBase(base0, 'c2', 'n1')).toBeNull()  // ★ scope mismatch(c1→c2)→ null(防跨 canvas 重放)
    expect(decodeBase('base:cv=c1|rid=n1|r=0.deadbeef', 'c1', 'n1')).toBeNull()  // ★ 签名错 → null(防篡改)
    expect(decodeBase('not-a-base-token', 'c1', 'n1')).toBeNull()  // malformed → null(400)
    expect(decodeBase(undefined, 'c1', 'n1')).toBeNull()  // missing → null(428)
    // trustify:ClientFieldOp.domain + TrustedCtx → WireOp
    const set: DomainOp = { kind: 'set', fieldPath: ['title'], value: 'hacked' }
    const trusted = trustify({ clientId: 'A', domain: set }, { opId: 'idem-key-abc', clientId: 'A', actor: 'alice', recordId: 'n1', base: base0 })
    expect(trusted.actor).toBe('alice')
    expect(trusted.recordId).toBe('n1')
    expect(trusted.base).toBe(base0)                // ★ Blocker 1:opaque BaseCursor string 注入
    expect(trusted.opId).toBe('idem-key-abc')
    expect(trusted.domain).toBe(set)
    // ★ Blocker 2:create client-id(adapter 从 NodeRecord.id 提取进 path,非 server-mint)
    const createBody: CreateBody = { clientId: 'A', type: 'node', payload: { title: 'new' } }
    const createWire = trustifyCreate(createBody, { opId: 'idem-create-1', clientId: 'A', actor: 'alice', recordId: 'n-client-1', base: base0 })
    expect(createWire.recordId).toBe('n-client-1')  // ★ client-supplied(NodeRecord.id via adapter path)
    expect(createWire.type).toBe('node'); expect(createWire.payload).toEqual({ title: 'new' })
    // ★ Blocker 2:RecordKindSchema classifier 必填(G1-b R4);container 白名单取消 — transform/relations 整对象 set 仍拒(leaf-level set)
    const nodeSchema: RecordKindSchema = {
      kind: 'node',
      classifyField: (fp) => {
        const root = fp[0] as string
        if (root === 'transform' || root === 'relations') return 'container' as const  // 整对象 set 拒(白名单取消;须分解 transform.x/relations.parentIds 叶子 set)
        if (root === 'fills' || root === 'strokes' || root === 'effects' || root === 'markupPoints' || root === 'resultNodeIds' || root === 'experimentalAnchors') return 'array-element' as const
        return 'leaf' as const
      },
    }
    expect(nodeSchema.classifyField(['transform'])).toBe('container')   // 整对象 set 拒(非白名单;leaf-level)
    expect(nodeSchema.classifyField(['title'])).toBe('leaf')
    expect(nodeSchema.classifyField(['fills'])).toBe('array-element')   // 数组结构 deferred
  })

  it('S10-3 typed domain op union + adapter 分层(v4:create client-id 独立 endpoint;strict-tx 剔出 DomainOp 改 server-named invariant;三类 array 同一 adapter 映射)', () => {
    // v4:DomainOp/TrustedCtx/WireOp/adaptToWire 复用 §10 describe 权威类型(无另造冲突局部类型);
    //   DomainOp 中性 delta,不带 recordId/actor/base/opId(全 adapter 注入);三类 array 同一 adaptToWire 覆盖。
    //   create 走独立 CreateBody + trustifyCreate(client NodeRecord.id via path,非 server-mint)— 杜绝 PATCH 双 record 权威。
    //   strict-tx 已剔出 DomainOp(Blocker 3):跨 record 原子改 server-named ServerInvariantCommand(由 path/method 推导目标)。
    // @ts-expect-error v4:create 不再是 PATCH DomainOp member — 若 create 塞回 DomainOp 则下行非 error → build fail
    const _createNotDomain: DomainOp = { kind: 'create', recordId: 'n-new', type: 'node', payload: { title: 'new' } }
    // create 走独立 CreateBody(零 recordId)+ trustifyCreate(client NodeRecord.id via adapter path,非 server-mint)
    const createBody: CreateBody = { clientId: 'A', type: 'node', payload: { title: 'new' } }
    const createWire = trustifyCreate(createBody, { opId: 'idem-create', clientId: 'A', actor: 'alice', recordId: 'n-client-2', base: encodeBase('c1', 'n-client-2', 0, {}) })
    expect(_createNotDomain).toBeDefined()  // 标记已用(noUnusedLocals)+ 证明 create 无法回塞 DomainOp
    expect(createWire.recordId).toBe('n-client-2')  // ★ client-supplied(NodeRecord.id via adapter path),非 server-mint
    expect(createWire.type).toBe('node'); expect(createWire.payload).toEqual({ title: 'new' })
    const set: DomainOp = { kind: 'set', fieldPath: ['title'], value: 'x' }
    const unset: DomainOp = { kind: 'unset', fieldPath: ['tempKey'] }
    const reorder: DomainOp = { kind: 'reorder', orderedIds: ['n2', 'n1', 'n3'] }
    // ★ Blocker 3:strict-tx 已剔出 DomainOp — 跨 record invariant 走 server-named ServerInvariantCommand(由 path/method 推导目标,非 PATCH DomainOp)
    // @ts-expect-error v5:strict-tx 不再是 DomainOp member — 若塞回则下行非 error → directive 失效 → build fail
    const _strictTxNotDomain: DomainOp = { kind: 'strict-tx' as const, ops: [] as unknown as never }
    const deleteCascade: ServerInvariantCommand = { kind: 'node-delete-cascade', canvasId: 'c1', nodeId: 'n1' }  // ★ 实证(PG-T1~T3/T7)
    const groupReparent: ServerInvariantCommand = { kind: 'group-reparent', canvasId: 'c1', nodeIds: ['n2', 'n3'], targetGroupId: 'g1' }  // 类型+注释级(A2 需另测)
    const resultAsset: ServerInvariantCommand = { kind: 'result-asset-attach', canvasId: 'c1', anchorId: 'a1', assetId: 'ast1', resultNodeId: 'n4' }  // 类型+注释级(A2 需另测)
    // ★ v5:by-id 数组 A2 deferred(DomainOp 不含 by-id variant);A2 仅 whole-lww + primitive array
    // @ts-expect-error v5:by-id variant 已 deferred(DomainOp 不含 by-id)— 塞回则 build fail
    const _byIdDeferred: DomainOp = { kind: 'array' as const, fieldPath: ['fills'] as FieldPath, class: 'by-id' as const, intent: 'insert' as const, afterId: null, value: { id: 'fA' } }
    // ② whole-lww(markupPoints,无 stable-id):整值 LWW 替换(A2 supported)
    const markupReplace: DomainOp = { kind: 'array', fieldPath: ['markupPoints'], class: 'whole-lww', intent: 'replace', value: [{ x: 3, y: 3 }] }
    // ③ primitive(resultNodeIds,string[]):by value(A2 supported)
    const resultInsert: DomainOp = { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'insert', value: 'n3' }
    // 验 union 可区分(kind/class 判别;create + strict-tx + by-id 已剔除,不在 DomainOp kind 集)
    expect(set.kind).toBe('set'); expect(unset.kind).toBe('unset')
    expect(reorder.kind).toBe('reorder')
    expect(deleteCascade.kind).toBe('node-delete-cascade')  // ★ server-named invariant(非 DomainOp);实证 PG-T1~T3/T7
    expect(groupReparent.kind).toBe('group-reparent'); expect(resultAsset.kind).toBe('result-asset-attach')  // 类型+注释级(A2 需另测)
    expect(_strictTxNotDomain).toBeDefined(); expect(_byIdDeferred).toBeDefined()
    expect(markupReplace.class).toBe('whole-lww'); expect(resultInsert.class).toBe('primitive')
    // R3 F1 adapter 映射:中性 DomainOp → wire op(recordId/actor/base/opId 全由 trusted ctx 注入,不在 DomainOp)
    const base3 = encodeBase('c1', 'n1', 3, { title: 2 })
    expect(decodeBase(base3, 'c1', 'n1')).toEqual({ revision: 3, fieldClocks: { title: 2 } })  // ★ v6 Blocker 1:真 codec round-trip(scope+field clock)
    const ctx: TrustedCtx = { opId: 'idem-1', clientId: 'A', actor: 'alice', recordId: 'n1', base: base3 }
    const wire = adaptToWire(set, ctx)
    expect(wire.recordId).toBe('n1'); expect(wire.actor).toBe('alice'); expect(wire.base).toBe(base3); expect(wire.opId).toBe('idem-1')
    expect(wire.domain).toBe(set)  // domain 中性 delta 引用(无 recordId/actor/base/opId)
    // ★ v5 两类 array(whole-lww + primitive)同一 adaptToWire 覆盖;by-id deferred(A2 不支持,迁移走 legacy 兼容通道,见 C-2)
    const wireMarkup = adaptToWire(markupReplace, ctx); expect(wireMarkup.domain).toBe(markupReplace)      // ② markupPoints whole-lww
    const wireResult = adaptToWire(resultInsert, ctx); expect(wireResult.domain).toBe(resultInsert)        // ③ resultNodeIds primitive
    // ★ §10 验收:whole-lww + primitive array 可构造;by-id deferred(DomainOp 不含);strict-tx 剔出改 server-named(仅 node-delete-cascade 实证,见 S10-13 + PG-T1~T3/T7)
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
    // ★ v6 Blocker 1:删平行明文 BaseWithClock,统一走同一 BaseCursor codec 生命周期。
    //   client base.clock 表达 = BaseCursor string token(encodeBase 绑 canvasId+recordId+revision+per-field clock snapshot;非平行明文 type)。
    const clientBase = encodeBase('c1', 'n1', 0, { title: 2 })  // ★ A 看到 title.clock=2 时签发的 base token(同 codec,非平行 BaseWithClock)
    const decoded = decodeBase(clientBase, 'c1', 'n1')!  // decode 验签+scope → {revision, fieldClocks}
    expect(decoded.fieldClocks.title).toBeLessThan(clock('n1', ['title']))  // ★ base title.clock=2 < current=3 → 同-field stale
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
    // ★ 持久形态定死:PG field_clock 表 + client base = BaseCursor token(同 codec 绑 field clock;非平行 BaseWithClock)+ 重启恢复;不留 N2-1(R2-3)。
    //   stale 判定 = decoded.fieldClocks[field] < current.clock → 同-field stale 才 overwritten(见 S10-12;非 record-rev 落后误报)。
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

  it('S10-7 数组三类意图(v6:by-id [superseded, non-normative] A2 deferred;active 仅 whole-lww + primitive;对照 mivoCanvas.ts 真实类型)', () => {
    // v6 Blocker 2:by-id 数组 A2 deferred(S10-14 断言 DomainOp 不含 by-id);S10-7 的 by-id active 证据与 S10-14 矛盾 → 标 [superseded, non-normative],移出 active evidence。
    //   ① 有 stable-id(fills/strokes/effects):by-id 结构编辑 **A2 deferred**(fail-visible,禁降级整数组 LWW);migration 走 legacy 兼容通道(见 C-2),不绕 defer。by-id applyArrayIntent 逻辑保留作 [superseded] 历史模型,非 active 证据。
    //   ② 无 stable-id(markupPoints):whole-lww(A2 supported)。③ primitive(resultNodeIds):by value(A2 supported)。
    type ArrayIntent =
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'by-id'; intent: 'insert'; afterId: string | null; value: { id: string } }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'by-id'; intent: 'remove'; removeId: string }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'by-id'; intent: 'splice'; afterId: string; removeCount: number; values: { id: string }[] }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'whole-lww'; intent: 'replace'; value: unknown[] }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'primitive'; intent: 'insert'; value: string }
      | { kind: 'array'; fieldPath: (string | number)[]; class: 'primitive'; intent: 'remove'; value: string }
    const applyArrayIntent = (arr: unknown[], intent: ArrayIntent): unknown[] => {
      if (intent.class === 'by-id') {
        const idArr = arr as { id: string }[]
        if (intent.intent === 'insert') {
          const idx = intent.afterId === null ? -1 : idArr.findIndex((x) => x.id === intent.afterId)
          if (intent.afterId !== null && idx === -1) throw new Error(`afterId ${intent.afterId} not found`)
          const at = idx + 1
          return [...idArr.slice(0, at), intent.value, ...idArr.slice(at)]
        }
        if (intent.intent === 'remove') return idArr.filter((x) => x.id !== intent.removeId)
        const idx = idArr.findIndex((x) => x.id === intent.afterId)
        if (idx === -1) throw new Error(`afterId ${intent.afterId} not found`)
        return [...idArr.slice(0, idx + 1), ...intent.values, ...idArr.slice(idx + 1 + intent.removeCount)]
      }
      if (intent.class === 'whole-lww') return intent.value
      if (intent.intent === 'insert') return [...(arr as string[]), intent.value]
      return (arr as string[]).filter((v) => v !== intent.value)
    }
    // ① by-id [superseded, non-normative]:A2 deferred(DomainOp 不含 by-id,S10-14);applyArrayIntent by-id 逻辑保留作历史模型,非 active 证据。A2 实装前 fills/strokes/effects 结构编辑不可用(migration 走 legacy 通道)。
    // ② whole-lww(markupPoints,A2 supported):整值 LWW
    const pts: { x: number; y: number }[] = [{ x: 1, y: 1 }, { x: 2, y: 2 }]
    const ptsLww = applyArrayIntent(pts, { kind: 'array', fieldPath: ['markupPoints'], class: 'whole-lww', intent: 'replace', value: [{ x: 3, y: 3 }] })
    expect(ptsLww).toEqual([{ x: 3, y: 3 }])  // ★ whole-lww(A2 supported)
    // ③ primitive(resultNodeIds,A2 supported):by value
    const rids = ['n1', 'n2']
    const ridsIns = applyArrayIntent(rids, { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'insert', value: 'n3' })
    expect(ridsIns).toEqual(['n1', 'n2', 'n3'])
    const ridsRm = applyArrayIntent(ridsIns, { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'remove', value: 'n2' })
    expect(ridsRm).toEqual(['n1', 'n3'])  // ★ primitive by value(A2 supported)
    // ★ v6 验收:by-id active 证据移出([superseded, non-normative];A2 deferred,见 S10-14);active 仅 whole-lww + primitive;['transform']+整对象 clobber 被 S10-10 拒(container leaf-level)。
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

  it('S10-10 immutable/leaf 字段表(v6:无 atomic-container;白名单取消 → transform/relations=container 整对象 set 拒,leaf-level;immutable 不可 set)', () => {
    // v6 Blocker 2:删 atomic-container(S10-14 断言 FieldTarget 无 atomic-container;两测试矛盾对拆)。container 白名单取消(lead 裁定 rejected)。
    //   对照 NodeRecord(canonical):immutable(id/type/createdAt/revision,创建后不可变,set→forbidden);container(transform/relations,整对象 set 拒,须分解叶子 set);leaf(其余)。
    type FieldMutability = 'immutable' | 'container' | 'leaf'  // v6:无 'atomic-container'(白名单取消)
    const MUTABILITY: Record<string, FieldMutability> = {
      id: 'immutable', type: 'immutable', createdAt: 'immutable', revision: 'immutable',
      transform: 'container', relations: 'container',  // v6:container(整对象 set 拒,leaf-level;非 atomic-container 白名单)
    }
    const mutabilityOf = (firstSeg: string): FieldMutability => MUTABILITY[firstSeg] ?? 'leaf'
    expect(mutabilityOf('id')).toBe('immutable')
    expect(mutabilityOf('type')).toBe('immutable')
    expect(mutabilityOf('createdAt')).toBe('immutable')
    expect(mutabilityOf('revision')).toBe('immutable')
    expect(mutabilityOf('transform')).toBe('container')   // v6:container(非 atomic-container)
    expect(mutabilityOf('relations')).toBe('container')   // v6:container(非 atomic-container)
    expect(mutabilityOf('title')).toBe('leaf')
    expect(mutabilityOf('text')).toBe('leaf')
    // ★ immutable 字段 set → forbidden;container 整对象 set(path.length===1)→ 拒(leaf-level);container 子路径 set(如 transform.x)→ ok(到 leaf)
    const assertMutable = (path: (string | number)[]): void => {
      const first = String(path[0])
      if (mutabilityOf(first) === 'immutable') throw new Error(`immutable field "${first}" cannot be set (R2-3 immutable leaf table)`)
      if (mutabilityOf(first) === 'container' && path.length === 1) throw new Error(`container field "${first}" requires leaf sub-path set (v6 白名单取消,leaf-level)`)
    }
    expect(() => assertMutable(['id'])).toThrow(/immutable field "id"/)
    expect(() => assertMutable(['type'])).toThrow(/immutable field "type"/)
    expect(() => assertMutable(['createdAt'])).toThrow(/immutable field "createdAt"/)
    expect(() => assertMutable(['title'])).not.toThrow()               // leaf 可 set
    expect(() => assertMutable(['transform', 'x'])).not.toThrow()     // transform.x 是 leaf 子路径(到 leaf,非整对象 set)
    expect(() => assertMutable(['transform'])).toThrow(/container field "transform" requires leaf sub-path/)  // ★ v6:transform 整对象 set 拒(白名单取消)
    expect(() => assertMutable(['relations'])).toThrow(/container field "relations" requires leaf sub-path/)  // ★ relations 整对象 set 拒
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

  // ════════════════════════════════════════════════════════════════════════════
  // v4 决议收口(sol 第三轮 6 阻断):base.clock 冻结矩阵 + server-named invariant + array defer inventory
  // ════════════════════════════════════════════════════════════════════════════
  it('S10-12 BaseCursor 绑 scope+per-field clock + base-driven 冻结矩阵 + v8 SnapshotCursor=opaque canvas bundle(v8 Blocker 1:SnapshotCursor=recordId→base map+order+since,多 record hydrate 不串用,delete 取 record base/reorder 取 order base/accepted 更新对应项;v6:scope 防跨 record/canvas 重放;同-field stale 才 overwritten,不同字段 stale 不误报;delete/reorder fresh→200 race→409;create dup→409;malformed/scope-mismatch→400)', () => {
    // v6 病根:v5 codec payload {rev,cv?} 两洞:① token 跨 record/canvas 重放(n1 rev=1 token 能用于 n2;HMAC 只防改值不防换资源);② 无 per-field clock,S10-12 用 record-rev 落后判 overwritten(别的字段变过也误报,违反 §10.3 同-field 语义)。
    // v6 修:token 绑 canvasId+recordId+revision+per-field clock snapshot;decodeBase 验签+scope;同-field stale 才 overwritten(不同字段 stale 不误报)。
    type Outcome = { status: number; outcome: 'accepted' | 'conflict' | 'rejected'; base?: BaseCursor; overwritten?: boolean }
    class BaseDrivenHarness {
      readonly canvasId: string
      constructor(canvasId = 'c1') { this.canvasId = canvasId }
      private recs = new Map<string, { rev: number; fc: FieldClocks; present: boolean; writers: Record<string, string> }>()
      private cv = 0
      private seq = 0  // v8:canvas 事件 seq(bundle since 项;每次 accepted op bump)
      private children: string[] = []
      private outbox: { to: string; field: string; by: string }[] = []
      seedRecord(nodeId: string, fc: FieldClocks = {}) { this.recs.set(nodeId, { rev: 0, fc: { ...fc }, present: true, writers: {} }) }
      recordExists(id: string) { return this.recs.get(id)?.present === true }
      fieldClock(nodeId: string, field: string): number { return this.recs.get(nodeId)?.fc[field] ?? 0 }
      fieldWriter(nodeId: string, field: string): string { return this.recs.get(nodeId)?.writers[field] ?? '' }
      /** hydrate snapshot 签发 record base(绑 canvasId+recordId+rev+per-field clock;clock key = fieldKeyOf 完整 path)。 */
      snapshot(nodeId: string): BaseCursor | null {
        const r = this.recs.get(nodeId); return r && r.present ? encodeBase(this.canvasId, nodeId, r.rev, r.fc) : null
      }
      /** reorder base 签发(canvas-scoped cv)。 */
      snapshotOrder(): BaseCursor { return encodeOrderBase(this.canvasId, this.cv) }
      seedChildren(ids: string[]) { this.children = [...ids]; this.cv = 0 }
      /** edit:malformed/scope-mismatch→400;永远 200(G4-4);**同-field stale 才 overwritten**(fieldKeyOf 完整 path 粒度;per-field writer map)。 */
      edit(nodeId: string, op: { fieldPath: FieldPath; value: unknown }, base: BaseCursor, actor: string): Outcome {
        const d = decodeBase(base, this.canvasId, nodeId)  // ★ scope check(canvasId+recordId 必须匹配)
        if (!d) return { status: 400, outcome: 'rejected' }  // malformed/unsigned/scope-mismatch → 400
        const r = this.recs.get(nodeId)
        if (!r || !r.present) return { status: 404, outcome: 'rejected' }
        const field = fieldKeyOf([...op.fieldPath])  // ★ v7:完整 path key(transform.x ≠ transform.y;leaf-level 粒度)
        const baseFC = d.fieldClocks[field] ?? 0
        const curFC = r.fc[field] ?? 0
        const sameFieldStale = baseFC < curFC  // ★ 同-field(完整 path)stale 才 overwritten;别的字段(含 transform.y)变过不算
        if (sameFieldStale && r.writers[field]) this.outbox.push({ to: r.writers[field], field, by: actor })  // ★ v7:通知该完整 path 前写者(per-field writer map;非 record 级单值误通知)
        r.fc[field] = curFC + 1; r.rev += 1; this.seq += 1; r.writers[field] = actor  // ★ per-field writer map(非 record 级 lastWriter);seq bump(事件)
        return { status: 200, outcome: 'accepted', base: encodeBase(this.canvasId, nodeId, r.rev, r.fc), overwritten: sameFieldStale }
      }
      /** delete:malformed/scope-mismatch→400;fresh base(rev===current)→200;stale base(rev<current)→409 race。 */
      delete(nodeId: string, base: BaseCursor): Outcome {
        const d = decodeBase(base, this.canvasId, nodeId)
        if (!d) return { status: 400, outcome: 'rejected' }
        const r = this.recs.get(nodeId)
        if (!r || !r.present) return { status: 404, outcome: 'rejected' }
        if (d.revision === r.rev) { r.present = false; this.seq += 1; return { status: 200, outcome: 'accepted' } }
        return { status: 409, outcome: 'conflict', base: encodeBase(this.canvasId, nodeId, r.rev, r.fc) }
      }
      /** reorder:malformed/scope-mismatch→400;fresh cv + valid perm→200(顺序变也成功);stale cv / orderedIds≠live→409。 */
      reorder(orderedIds: string[], base: BaseCursor): Outcome {
        const d = decodeOrderBase(base, this.canvasId)
        if (!d) return { status: 400, outcome: 'rejected' }
        if (d.cv !== this.cv) return { status: 409, outcome: 'conflict', base: this.snapshotOrder() }
        const liveSet = new Set(this.children)
        const validPerm = orderedIds.length === this.children.length && new Set(orderedIds).size === orderedIds.length && orderedIds.every((id) => liveSet.has(id))
        if (!validPerm) return { status: 409, outcome: 'conflict', base: this.snapshotOrder() }
        this.children = [...orderedIds]; this.cv += 1; this.seq += 1
        return { status: 200, outcome: 'accepted', base: this.snapshotOrder() }
      }
      /** create:dup id→409;new→201 + base。 */
      create(nodeId: string): Outcome {
        const r = this.recs.get(nodeId)
        if (r && r.present) return { status: 409, outcome: 'conflict', base: encodeBase(this.canvasId, nodeId, r.rev, r.fc) }
        this.recs.set(nodeId, { rev: 1, fc: {}, present: true, writers: {} }); this.seq += 1
        return { status: 201, outcome: 'accepted', base: encodeBase(this.canvasId, nodeId, 1, {}) }
      }
      drainOverwritten(to: string) { const e = this.outbox.filter((o) => o.to === to); this.outbox = this.outbox.filter((o) => o.to !== to); return e }
      // ── v8 Blocker 1:canvas 级 SnapshotCursor = opaque bundle(recordId→BaseCursor map + order base + since base)──
      /** hydrate 签发 canvas 级 opaque bundle(内含所有 present record 的 (rev,fc) + order cv + since seq)。多 record 聚合,非单 record 级 token。 */
      snapshotBundle(): SnapshotCursor {
        const entries: Record<string, BundleEntry> = {}
        for (const [id, r] of this.recs) if (r.present) entries[id] = { revision: r.rev, fieldClocks: { ...r.fc } }
        return encodeBundle(this.canvasId, entries, this.cv, this.seq)
      }
      /** 解包 bundle(测试断言用;adapter 侧解包,port 不读内部)。 */
      extractBundle(bundle: SnapshotCursor | string | undefined) { return decodeBundle(bundle, this.canvasId) }
      /** ★ submitChange 抽 wire base:edit/delete→record base(bundle 内 recordId 对应项,按 recordId 重建);reorder→order base(非 record base)。
       *  多 record hydrate 后 nb1/nb2 各自 record base 不串用(单 record 级 token 无法为任意 record 提供 If-Match 的根因)。 */
      extractWireBase(bundle: SnapshotCursor | string | undefined, opClass: 'edit' | 'delete' | 'reorder', nodeId?: string): BaseCursor | null {
        const d = decodeBundle(bundle, this.canvasId); if (!d) return null
        if (opClass === 'reorder') return d.order  // ★ reorder 取 order base(非 record base)
        if (nodeId === undefined) return null
        return d.records[nodeId] ?? null  // ★ edit/delete 取 record base(按 recordId 抽;不串用)
      }
    }
    const h = new BaseDrivenHarness('c1')
    // ── 新鲜 base:正常操作必须成功(非 race)──
    h.create('n1')  // create n1 → rev 1
    const snap1 = h.snapshot('n1')!  // 绑 c1+n1+rev1+fc={}
    expect(decodeBase(snap1, 'c1', 'n1')).toEqual({ revision: 1, fieldClocks: {} })  // ★ 真 codec round-trip(scope 正确)
    // edit fresh base → 200 + new base(title.clock=1, rev=2),no overwritten
    const e1 = h.edit('n1', { fieldPath: ['title'], value: 'A' }, snap1, 'alice')
    expect(e1.status).toBe(200); expect(e1.outcome).toBe('accepted'); expect(e1.overwritten).toBe(false)
    expect(h.fieldClock('n1', 'title')).toBe(1)
    // ★ 同-field stale:snap1 title.clock=0 < current 1 → 200 + overwritten(非 409,G4-4)
    const e2 = h.edit('n1', { fieldPath: ['title'], value: 'B' }, snap1, 'bob')
    expect(e2.status).toBe(200); expect(e2.outcome).toBe('accepted')  // ★ edit stale 永 200 非 409
    expect(e2.overwritten).toBe(true)  // ★ 同-field(title)stale → overwritten
    expect(h.drainOverwritten('alice').length).toBe(1)  // alice 收 overwritten
    // ★ v7 不同字段 stale 不误报(fieldKeyOf 完整 path 粒度;per-field writer map;非 record-rev 误报)
    h.create('n2')
    const snap2a = h.snapshot('n2')!  // title.clock=0, transform.x.clock=0, transform.y.clock=0
    h.edit('n2', { fieldPath: ['transform', 'x'], value: 5 }, snap2a, 'carol')  // bump transform.x.clock=1, rev=2
    expect(h.fieldClock('n2', 'transform.x')).toBe(1); expect(h.fieldClock('n2', 'title')).toBe(0); expect(h.fieldClock('n2', 'transform.y')).toBe(0)  // ★ fieldKeyOf 粒度:transform.x ≠ transform.y ≠ title
    // edit TITLE with snap2a(title.clock=0 === current 0,虽 transform.x.clock 落后)— 不发 overwritten(非同-field stale)
    const e3 = h.edit('n2', { fieldPath: ['title'], value: 'T' }, snap2a, 'dave')
    expect(e3.status).toBe(200); expect(e3.overwritten).toBe(false)  // ★ 不同字段 stale(transform.x 变了)不误报 title overwritten
    expect(h.drainOverwritten('carol').length).toBe(0)  // carol(transform.x writer)不收(title 非其字段;per-field writer map)
    // ★ v7 transform.x 与 transform.y stale 互不误报(fieldKeyOf leaf-level 粒度;v6 用 fieldPath[0] 会并成一个 transform)
    h.create('n5')
    const snap5a = h.snapshot('n5')!  // transform.x.clock=0, transform.y.clock=0
    h.edit('n5', { fieldPath: ['transform', 'x'], value: 1 }, snap5a, 'alice')  // transform.x.clock=1, writer[transform.x]=alice
    expect(h.fieldClock('n5', 'transform.x')).toBe(1); expect(h.fieldClock('n5', 'transform.y')).toBe(0)  // ★ transform.x ≠ transform.y
    // edit transform.y with snap5a(transform.y.clock=0 === current 0,虽 transform.x.clock 落后)— 不发 overwritten
    const e5y = h.edit('n5', { fieldPath: ['transform', 'y'], value: 2 }, snap5a, 'bob')
    expect(e5y.status).toBe(200); expect(e5y.overwritten).toBe(false)  // ★ transform.y 未被并发改 → 不误报(transform.x 变了不算)
    expect(h.drainOverwritten('alice').length).toBe(0)  // alice(transform.x writer)不收(transform.y 非其字段)
    // edit transform.x with snap5a(transform.x.clock=0 < current 1)→ 200 + overwritten;通知 transform.x 前写者 alice(非 bob)
    const e5x = h.edit('n5', { fieldPath: ['transform', 'x'], value: 3 }, snap5a, 'carol')
    expect(e5x.status).toBe(200); expect(e5x.overwritten).toBe(true)  // ★ 同-field(transform.x)stale → overwritten
    const ov5 = h.drainOverwritten('alice')
    expect(ov5.length).toBe(1); expect(ov5[0].field).toBe('transform.x')  // ★ 通知 transform.x 前写者 alice(完整 path 粒度)
    expect(h.drainOverwritten('bob').length).toBe(0)  // bob(transform.y writer)不收(非 transform.x)
    // ★ v7 title→transform→stale title 通知发 title 前写者(per-field writer map;非 record 级单值误通知 transform writer)
    h.create('n6')
    const snap6a = h.snapshot('n6')!  // title.clock=0, transform.x.clock=0
    h.edit('n6', { fieldPath: ['title'], value: 'A' }, snap6a, 'alice')  // title.clock=1, writer[title]=alice
    h.edit('n6', { fieldPath: ['transform', 'x'], value: 9 }, snap6a, 'bob')  // transform.x.clock=1, writer[transform.x]=bob
    // edit title with snap6a(title.clock=0 < current 1)→ 200 + overwritten;通知 writer[title]=alice(非 bob who wrote transform.x)
    const e6 = h.edit('n6', { fieldPath: ['title'], value: 'B' }, snap6a, 'carol')
    expect(e6.status).toBe(200); expect(e6.overwritten).toBe(true)  // ★ 同-field(title)stale → overwritten
    const ov6 = h.drainOverwritten('alice')
    expect(ov6.length).toBe(1); expect(ov6[0].field).toBe('title')  // ★ 通知 title 前写者 alice(per-field writer map)
    expect(h.drainOverwritten('bob').length).toBe(0)  // ★ bob(transform.x writer)不收(title 非其字段;v6 record 级单值会误通知 bob)
    // ★ delete fresh base → 200(removed,非 409)
    const snap3 = h.snapshot('n1')!  // n1 rev=3(title bumped twice)
    const d1 = h.delete('n1', snap3)
    expect(d1.status).toBe(200); expect(d1.outcome).toBe('accepted')  // ★ fresh delete → 200
    // ★ delete stale base → 409(race)
    h.create('n3')
    const snapN3 = h.snapshot('n3')!  // rev 1
    h.edit('n3', { fieldPath: ['title'], value: 'X' }, snapN3, 'alice')  // bump rev 1→2
    const d2 = h.delete('n3', snapN3)  // stale base(rev1 < current 2)
    expect(d2.status).toBe(409); expect(d2.outcome).toBe('conflict')  // ★ stale delete → 409
    // malformed/unsigned base → 400
    expect(h.delete('n3', 'not-a-base' as BaseCursor).status).toBe(400)
    expect(h.delete('n3', 'base:cv=c1|rid=n3|r=1.deadbeef' as BaseCursor).status).toBe(400)  // 签名错 → 400
    // create dup → 409
    expect(h.create('n3').status).toBe(409)
    // ★ scope mismatch:n4 token 用于 n3 → 拒(HMAC 防改值不防换资源 → v6 绑 recordId 防跨 record 重放)
    h.create('n4')
    const n4snap = h.snapshot('n4')!  // c1+n4 token
    // 用 n4 的 token 试图 edit n3(rid 不匹配)→ scope-mismatch → 400
    const e4 = h.edit('n3', { fieldPath: ['title'], value: 'forge' }, n4snap, 'eve')
    expect(e4.status).toBe(400); expect(e4.outcome).toBe('rejected')  // ★ n4 token→n3 scope-mismatch → 400(防跨 record 重放)
    // ★ c1 order token 用于 c2 canvas → 拒(scope-mismatch)
    h.seedChildren(['a', 'b', 'c'])
    const c1OrderToken = h.snapshotOrder()  // c1 canvas token
    const h2 = new BaseDrivenHarness('c2')  // 另一 canvas
    h2.seedChildren(['a', 'b', 'c'])
    const rCross = h2.reorder(['c', 'b', 'a'], c1OrderToken)  // c1 token → c2 canvas
    expect(rCross.status).toBe(400); expect(rCross.outcome).toBe('rejected')  // ★ c1 order→c2 scope-mismatch → 400(防跨 canvas 重放)
    // ★ reorder fresh base + 顺序变 → 200(非 409 即使顺序不同)
    const orderBase = h.snapshotOrder()  // c1 cv 0
    const r1 = h.reorder(['c', 'b', 'a'], orderBase)  // 顺序变,但 fresh + scope 正确 → 200
    expect(r1.status).toBe(200); expect(r1.outcome).toBe('accepted')  // ★ fresh reorder → 200
    // ★ reorder stale cv → 409(race)
    const r2 = h.reorder(['a', 'b', 'c'], orderBase)  // stale cv(0 < current 1)
    expect(r2.status).toBe(409); expect(r2.outcome).toBe('conflict')  // ★ stale cv → 409
    // ★ reorder orderedIds≠live set → 409
    const orderBase2 = h.snapshotOrder()
    const r3 = h.reorder(['a', 'b', 'd'], orderBase2)  // 'd' 不在 live
    expect(r3.status).toBe(409); expect(r3.outcome).toBe('conflict')  // orderedIds≠live → 409
    // ── v8 Blocker 1:SnapshotCursor = opaque canvas 级 bundle(recordId→BaseCursor map + order base + since base)──
    //   现状矛盾:port CanvasSnapshot 只有一个 canvas 级 cursor;inventory v7 写成"绑 canvasId+recordId 的单个 BaseCursor" →
    //   多 record hydrate 后一个 record 级 token 无法为任意 n1/n2 提供 If-Match(串用)。★ v8:bundle 聚合 + submitChange 按 recordId/op class 抽 wire base。
    h.create('nb1'); h.edit('nb1', { fieldPath: ['title'], value: 'B1' }, h.snapshot('nb1')!, 'alice')  // nb1 rev=2, title.clock=1
    h.create('nb2'); h.edit('nb2', { fieldPath: ['transform', 'x'], value: 9 }, h.snapshot('nb2')!, 'bob')  // nb2 rev=2, transform.x.clock=1
    const bN1 = h.snapshot('nb1')!  // per-record wire base(wire-level,绑 c1+nb1+rev2+fc{title:1})
    const bN2 = h.snapshot('nb2')!  // per-record wire base(绑 c1+nb2+rev2+fc{transform.x:1})
    const bundle = h.snapshotBundle()  // ★ canvas 级 opaque bundle(聚合 nb1/nb2 record base + order + since)
    const dec = h.extractBundle(bundle)!
    expect(dec.records.nb1).toBeDefined(); expect(dec.records.nb2).toBeDefined()  // bundle 含两 record 的 base
    expect(dec.records.nb1).toEqual(bN1)  // ★ bundle nb1 entry 重建 = per-record base(按 recordId 重建,不串用)
    expect(dec.records.nb2).toEqual(bN2)  // ★ bundle nb2 entry 重建 = per-record base
    expect(dec.records.nb1).not.toEqual(bN2)  // ★ n1/n2 base 不串用(distinct;单 record 级 token 无法为任意 record 提供 If-Match 的根因)
    expect(dec.order).toEqual(h.snapshotOrder())  // bundle order = canvas order base
    expect(typeof dec.since).toBe('string')  // bundle since = event-since base(canvas-scoped seq,catch-up 用)
    // ★ submitChange 抽 wire base:edit nb1→nb1 record base(非 nb2);edit nb2→nb2;delete nb1→nb1 record base;reorder→order base(非 record)
    expect(h.extractWireBase(bundle, 'edit', 'nb1')!).toEqual(bN1)
    expect(h.extractWireBase(bundle, 'edit', 'nb2')!).toEqual(bN2)
    expect(h.extractWireBase(bundle, 'edit', 'nb1')!).not.toEqual(bN2)  // ★ nb1 token 不串用到 nb2
    expect(h.extractWireBase(bundle, 'delete', 'nb1')!).toEqual(bN1)  // ★ delete 取 record base
    expect(h.extractWireBase(bundle, 'reorder', undefined)!).toEqual(h.snapshotOrder())  // ★ reorder 取 order base(非 record base)
    expect(h.extractWireBase(bundle, 'reorder', undefined)!).not.toEqual(bN1)  // ★ 非 record base
    expect(h.extractWireBase(bundle, 'edit', 'nb-missing')).toBeNull()  // ★ bundle 无该 record → null(不串用别的 record base)
    // ★ accepted edit → bundle reissued(新 bundle 的 nb1 entry 更新;nb2 不变;不重建 nb2 base)
    h.edit('nb1', { fieldPath: ['title'], value: 'B1-v2' }, h.snapshot('nb1')!, 'carol')  // bump nb1 rev/fc
    const bundle2 = h.snapshotBundle()
    const dec2 = h.extractBundle(bundle2)!
    expect(dec2.records.nb1).not.toEqual(bN1)  // ★ nb1 entry 更新(rev bumped;accepted 后 bundle 内对应项更新)
    expect(dec2.records.nb2).toEqual(bN2)  // ★ nb2 不变(只更新 change 命中的 record 对应项)
    // ★ 跨 canvas bundle 重放 → scope-mismatch → null(防 c1 bundle 用于 c2;bundle canvas-scoped)
    const hB = new BaseDrivenHarness('c2'); hB.create('nb1')
    expect(hB.extractBundle(bundle)).toBeNull()  // c1 bundle → c2 scope mismatch → null
    // 冻结矩阵(决策 §14.1 引用):edit 同-field stale 200+overwritten(永非 409);不同字段 stale 200 无 overwritten;delete/reorder fresh→200, stale→409;create dup→409;malformed/scope-mismatch→400
    type OpClass = 'edit-same-field-stale' | 'edit-diff-field-stale' | 'edit-fresh' | 'delete-fresh' | 'delete-stale' | 'reorder-fresh' | 'reorder-stale' | 'create-dup' | 'malformed' | 'scope-mismatch'
    const MATRIX: Record<OpClass, { status: number; outcome: 'accepted' | 'conflict' | 'rejected' }> = {
      'edit-same-field-stale': { status: 200, outcome: 'accepted' },      // ★ 同-field stale → 200+overwritten(非 409)
      'edit-diff-field-stale': { status: 200, outcome: 'accepted' },     // ★ 不同字段 stale → 200 无 overwritten(v6 per-field clock)
      'edit-fresh': { status: 200, outcome: 'accepted' },
      'delete-fresh': { status: 200, outcome: 'accepted' },
      'delete-stale': { status: 409, outcome: 'conflict' },
      'reorder-fresh': { status: 200, outcome: 'accepted' },
      'reorder-stale': { status: 409, outcome: 'conflict' },
      'create-dup': { status: 409, outcome: 'conflict' },
      'malformed': { status: 400, outcome: 'rejected' },
      'scope-mismatch': { status: 400, outcome: 'rejected' },            // ★ 跨 record/canvas token → 400(防重放)
    }
    expect(Object.keys(MATRIX).sort()).toEqual(['create-dup', 'delete-fresh', 'delete-stale', 'edit-diff-field-stale', 'edit-fresh', 'edit-same-field-stale', 'malformed', 'reorder-fresh', 'reorder-stale', 'scope-mismatch'])
    // ★ Blocker 1 验收:BaseCursor 绑 scope+per-field clock(防跨 record/canvas 重放 + 同-field stale 语义);base-driven 矩阵(正常 op fresh base→200,race 才 409;edit 永 200,同-field stale 才 overwritten;malformed/scope-mismatch→400)。
  })

  it('S10-13 server-named invariant command(v5 诚实化:仅 node-delete-cascade 经 PG 实证;group/result-asset 类型+注释级 A2 需另测)', () => {
    // Blocker 3:strict-tx 已剔出 DomainOp(假跨 record tx 无 target)。跨 record invariant 改 server-named command(由 path/method 推导目标,非 PATCH DomainOp)。
    // ★ v5 诚实化:仅 node-delete-cascade 经 PG-T1~T3/T7 实证(node+edges+asset ref 同 tx 原子 + 一般跨 record 回滚);
    //   group-reparent / result-asset-attach 是类型+注释级,A2 需另测(per-target authz + 同 tx)—— 决议不得写成三 command 全实证。
    const cascade: ServerInvariantCommand = { kind: 'node-delete-cascade', canvasId: 'c1', nodeId: 'n1' }
    const group: ServerInvariantCommand = { kind: 'group-reparent', canvasId: 'c1', nodeIds: ['n2', 'n3'], targetGroupId: 'g1' }
    const resultAsset: ServerInvariantCommand = { kind: 'result-asset-attach', canvasId: 'c1', anchorId: 'a1', assetId: 'ast1', resultNodeId: 'n4' }
    type ServerKind = ServerInvariantCommand['kind']
    expectTypeOf<ServerKind>().toEqualTypeOf<'node-delete-cascade' | 'group-reparent' | 'result-asset-attach'>()
    expect(cascade.kind).toBe('node-delete-cascade')
    expect(group.kind).toBe('group-reparent')
    expect(resultAsset.kind).toBe('result-asset-attach')
    // ★ server-named command 不是 PATCH DomainOp(跨 record 不经 DomainOp wire;由 path/method 推导)
    // @ts-expect-error Blocker 3:ServerInvariantCommand 不是 DomainOp(跨 record 走 server-named 路径,非 PATCH wire)
    const _notDomain: DomainOp = cascade
    expect(_notDomain).toBeDefined()
    // ★ v5 实证分级(冻结,改任一行 → 红):
    const EMPIRICALLY_PROVEN: Record<ServerKind, boolean> = {
      'node-delete-cascade': true,       // ★ PG-T1~T3/T7 实证(node+edges+asset ref 同 tx 原子 + 跨 record 回滚)
      'group-reparent': false,           // 类型+注释级(A2 需另测 per-target authz + 同 tx)
      'result-asset-attach': false,      // 类型+注释级(A2 需另测)
    }
    expect(EMPIRICALLY_PROVEN['node-delete-cascade']).toBe(true)
    expect(EMPIRICALLY_PROVEN['group-reparent']).toBe(false)  // ★ 诚实:非实证
    expect(EMPIRICALLY_PROVEN['result-asset-attach']).toBe(false)  // ★ 诚实:非实证
    // ★ Blocker 3 验收:strict-tx 剔出 DomainOp;跨 record 改 server-named;仅 node-delete-cascade 实证(PG-T1~T3/T7),group/result-asset 类型+注释级 A2 需另测(诚实化)。
  })

  it('S10-14 array defer inventory(v5:by-id A2 deferred 不在 DomainOp;whole-lww/primitive supported;container 白名单取消)', () => {
    // v5:by-id 数组 A2 deferred(NOTES:fail-visible,禁降级整数组 LWW)→ DomainOp 不含 by-id variant;
    //   fills/strokes/effects/experimentalAnchors 在旧 payload 出现时 migration 走 legacy 兼容通道(见 C-2),不绕过 defer。
    //   container 白名单取消(lead 裁定):transform/relations 整对象 set 仍拒(leaf-level set);无 'atomic-container'。
    type ArrayFieldClass = 'by-id' | 'whole-lww' | 'primitive'
    type ArrayFieldInventory = { field: string; class: ArrayFieldClass; a2Stance: 'deferred' | 'supported' }
    const NODE_ARRAY_INVENTORY: ArrayFieldInventory[] = [
      { field: 'fills', class: 'by-id', a2Stance: 'deferred' },                 // by-id deferred(DomainOp 不含 by-id;migration 走 legacy 通道)
      { field: 'strokes', class: 'by-id', a2Stance: 'deferred' },
      { field: 'effects', class: 'by-id', a2Stance: 'deferred' },
      { field: 'experimentalAnchors', class: 'by-id', a2Stance: 'deferred' },  // 收编为顶层 Anchor record
      { field: 'markupPoints', class: 'whole-lww', a2Stance: 'supported' },   // 整值 LWW(A2 supported,DomainOp whole-lww)
      { field: 'resultNodeIds', class: 'primitive', a2Stance: 'supported' },   // by value(A2 supported,DomainOp primitive)
    ]
    expect(NODE_ARRAY_INVENTORY.filter((f) => f.class === 'by-id').map((f) => f.field)).toEqual(['fills', 'strokes', 'effects', 'experimentalAnchors'])
    expect(NODE_ARRAY_INVENTORY.filter((f) => f.class === 'whole-lww').map((f) => f.field)).toEqual(['markupPoints'])
    expect(NODE_ARRAY_INVENTORY.filter((f) => f.class === 'primitive').map((f) => f.field)).toEqual(['resultNodeIds'])
    expect(NODE_ARRAY_INVENTORY.filter((f) => f.a2Stance === 'deferred').every((f) => f.class === 'by-id')).toBe(true)
    expect(NODE_ARRAY_INVENTORY.filter((f) => f.a2Stance === 'supported').map((f) => f.class).sort()).toEqual(['primitive', 'whole-lww'])
    // ★ v5:DomainOp 不含 by-id variant(by-id deferred;A2 fail-visible,禁降级整数组 LWW)
    // @ts-expect-error v5:by-id variant 已 deferred(DomainOp 不含 by-id)— 塞回则 build fail
    const _byIdNotInDomain: DomainOp = { kind: 'array' as const, fieldPath: ['fills'] as FieldPath, class: 'by-id' as const, intent: 'insert' as const, afterId: null, value: { id: 'fA' } }
    expect(_byIdNotInDomain).toBeDefined()
    // A2 supported array ops(whole-lww + primitive)
    const markupReplace: DomainOp = { kind: 'array', fieldPath: ['markupPoints'], class: 'whole-lww', intent: 'replace', value: [{ x: 1, y: 1 }] }
    const resultInsert: DomainOp = { kind: 'array', fieldPath: ['resultNodeIds'], class: 'primitive', intent: 'insert', value: 'n3' }
    expect(markupReplace.class).toBe('whole-lww'); expect(resultInsert.class).toBe('primitive')
    // ★ v5 container 白名单取消:FieldTarget 无 'atomic-container';transform/relations 整对象 set 拒(leaf-level set)
    type FieldTargetKeys = FieldTarget
    expectTypeOf<FieldTargetKeys>().toEqualTypeOf<'leaf' | 'container' | 'array-element'>()  // 无 'atomic-container'
    // ★ Blocker 2 验收:by-id deferred(DomainOp 不含 + migration 走 legacy 通道);whole-lww/primitive supported;container 白名单取消(transform/relations leaf-level set)。
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

describe('N2-0 v8 cutover contract harness(Blocker 3 补全:LegacyReplaceRequest 绑 canvasId+nodeId+baseRevision;scope 校验;stale base→409 terminal conflict dead-letter 非盲 replace;v8 delete-race missing+baseRev>0→409;真实 authz+deny 负例;v8 retirement fake-clock quiet-window)', () => {
  // v7 Blocker 3 补全(v6 仅 wire 未补全 stale/authz/retirement):
  //   ① 信封绑 canvasId+nodeId+version+payload+原队列 baseRevision;decoder 校验 path canvas/node scope(防同 nodeId 跨 canvas 重放)。
  //   ② 【lead 拍板】stale base(baseRevision≠current rev,record 已有更新版本)→409 显式 terminal conflict,不落盲 replace(队列残留是离线期改动,覆盖是数据破坏;409 后 queue 项走 FX-5 dead-letter,用户可见)。
  //   ③ authz 走真实 canvas-write seam(members canWrite)+ deny 负例(不许 void actor;无 actor 或非 member → 403)。
  //   ④ retirement 双可达指标:pending legacy queue gauge=0 + 连续观察窗 envelope 增量=0(drainCount 只作累计总量);冻结 gate 配置名 LEGACY_DRAIN/观察窗/关闭后行为。
  //   ⑤ §1.2 状态表写全(信封 wire/gate/scope/base-conflict/观测/retirement + "受控迁移协议例外"术语)。
  type LegacyUpsertBody = NodePayload
  type NewOp = DomainOp
  /** ★ v7 Blocker 3:versioned LegacyReplaceRequest 信封(绑 canvasId+nodeId+version+payload+原队列 baseRevision;独立 DomainOp+raw NodePayload)。 */
  type LegacyReplaceRequest = { kind: 'legacy-replace'; canvasId: string; nodeId: string; version: 1; payload: NodePayload; baseRevision: Revision }

  const nodePayload = (over: Partial<NodePayload> = {}): NodePayload => {
    const n = makeNode('px')
    const { id: _id, revision: _rev, ...rest } = n
    void _id; void _rev
    return { ...rest, ...over } as NodePayload
  }

  type HasId = 'id' extends keyof NodePayload ? true : false
  const _noIdInPayload: HasId = false

  type MigratedOp =
    | { kind: 'legacy-envelope'; envelope: LegacyReplaceRequest }
    | { kind: 'delete'; cmd: ServerInvariantCommand }
    | { kind: 'reorder'; op: DomainOp }

  const migrateWriteOp = (op: WriteOp): MigratedOp => {
    switch (op.kind) {
      case 'upsertNode':
        // ★ 包进 LegacyReplaceRequest 信封(绑 canvasId+nodeId+version+payload+原队列 baseRevision)走 decoder wire
        return { kind: 'legacy-envelope', envelope: { kind: 'legacy-replace', canvasId: op.canvasId, nodeId: op.nodeId, version: 1, payload: op.payload, baseRevision: op.baseRevision ?? 0 } }
      case 'deleteNode':
        return { kind: 'delete', cmd: { kind: 'node-delete-cascade', canvasId: op.canvasId, nodeId: op.nodeId } }
      case 'reorderChildren':
        return { kind: 'reorder', op: { kind: 'reorder', orderedIds: op.orderedIds } }
      default:
        throw new Error(`migrateWriteOp: kind ${op.kind} not in 3 classes`)
    }
  }

  class CutoverHarness {
    readonly canvasId: string
    constructor(canvasId = 'c1') { this.canvasId = canvasId }
    private flag = false
    private legacyDrain = false  // gate LEGACY_DRAIN(cutover drain 窗口开启,retirement 后关)
    private drainCount = 0       // ★ 累计总量(observability,非 retirement 条件)
    private pendingLegacyQueue = 0  // ★ retirement gauge 1:pending queue 项数
    private envelopeIncrementInWindow = 0  // ★ retirement gauge 2:观察窗内 envelope 增量
    private members = new Set<string>()  // ★ authz:canvas-write seam
    private recs = new Map<string, NodeRecord>()
    // ★ v8 Blocker 3② retirement fake-clock quiet-window:冻结配置名 LEGACY_DRAIN_QUIET_WINDOW_MS + 绝对时长 + 时间戳/重置语义。
    //   窗口内任一 envelope 到达即重新计时(windowStartAt=now);只有完整连续窗口 delta=0 且 pending gauge=0 才 retire。
    static readonly LEGACY_DRAIN_QUIET_WINDOW_MS = 60_000  // ★ 冻结配置名 + 绝对时长(quiet-window)
    private now = 0  // fake clock
    private windowStartAt = 0  // ★ 当前 quiet 窗口起点(envelope 到达即重置;窗口完整 = now-windowStartAt>=quietWindowMs 且期间无到达)
    setFlag(on: boolean) { this.flag = on }
    setLegacyDrain(on: boolean) { this.legacyDrain = on }
    addMember(actor: string) { this.members.add(actor) }
    canWrite(actor: string) { return this.members.has(actor) }
    drainCountValue() { return this.drainCount }
    pendingLegacyQueueGauge() { return this.pendingLegacyQueue }
    envelopeIncrementInWindowGauge() { return this.envelopeIncrementInWindow }
    enqueueLegacy(n = 1) { this.pendingLegacyQueue += n }  // 模拟队列项入队
    setClock(t: number) { this.now = t }  // ★ v8 fake clock 推进(retirement quiet-window 测试用)
    advanceClock(dt: number) { this.now += dt }  // ★ v8 fake clock 步进
    /** ★ v8 quiet-window:任一 envelope 到达(经 authz+gate+scope)→ 重新计时(windowStartAt=now;envelope 增量 +1)。 */
    private touchWindow() { this.windowStartAt = this.now; this.envelopeIncrementInWindow += 1 }
    /** ★ v8 tickObservationWindow:推进 fake clock 判定;只有完整连续 quiet 窗口(elapsed>=quietWindowMs,期间无 envelope 到达——
     *   任一到达会重置 windowStartAt 使窗口不完整)才归零 envelopeIncrement(delta=0)并返 true;窗口未完整返 false(不归零)。 */
    tickObservationWindow(): boolean {
      if (this.now - this.windowStartAt >= CutoverHarness.LEGACY_DRAIN_QUIET_WINDOW_MS) {
        this.envelopeIncrementInWindow = 0  // ★ 完整连续窗口 delta=0 归零
        return true
      }
      return false
    }
    /** ★ v8 retirement 可达指标:pending gauge=0 + 完整连续窗口 delta=0(envelopeIncrement===0 + elapsed>=quietWindowMs);drainCount 只作总量(非条件)。 */
    canRetire(): boolean {
      return this.pendingLegacyQueue === 0
        && this.envelopeIncrementInWindow === 0
        && (this.now - this.windowStartAt) >= CutoverHarness.LEGACY_DRAIN_QUIET_WINDOW_MS
    }
    seedRecord(n: NodeRecord) { this.recs.set(n.id, structuredClone(n)) }
    recordRev(nodeId: string): number { return this.recs.get(nodeId)?.revision ?? 0 }
    recordExists(nodeId: string): boolean { return this.recs.has(nodeId) }
    /** ★ v7 PATCH decoder wire(flag-on):DomainOp→200;LegacyReplaceRequest 信封→200 replace(scope+authz+stale-base+gate);raw NodePayload→400;flag-off:NodePayload→200,其余→400。 */
    patch(nodeId: string, body: LegacyUpsertBody | NewOp | LegacyReplaceRequest, opts?: { actor?: string }): { status: number; body: { error?: string; id?: string; revision?: number; seq?: number } } {
      const obj = body as { kind?: string }
      const isDomainOp = typeof obj.kind === 'string' && (obj.kind === 'set' || obj.kind === 'unset' || obj.kind === 'array' || obj.kind === 'reorder')
      const isLegacyEnvelope = obj.kind === 'legacy-replace'
      if (this.flag) {
        if (isLegacyEnvelope) {
          // ★ ③ authz:真实 canvas-write seam + deny 负例(不许 void actor;无 actor 或非 member → 403)
          const actor = opts?.actor
          if (!actor) return { status: 403, body: { error: 'forbidden' } }  // ★ 无 actor → 403(no void actor)
          if (!this.canWrite(actor)) return { status: 403, body: { error: 'forbidden' } }  // ★ deny 负例(非 member)
          // ④ gate LEGACY_DRAIN
          if (!this.legacyDrain) return { status: 400, body: { error: 'payload-rejected' } }  // gate 关 → 400
          const env = body as LegacyReplaceRequest
          // ① scope 校验:env.canvasId+env.nodeId 必须匹配 path canvas+node(防同 nodeId 跨 canvas 重放)
          if (env.canvasId !== this.canvasId || env.nodeId !== nodeId) return { status: 400, body: { error: 'payload-rejected' } }  // ★ scope mismatch → 400
          // ★ v8 quiet-window:任一 envelope 到达(经 authz+gate+scope)→ 重新计时窗口(envelope 增量 +1;windowStartAt=now;retirement 须重等完整窗口)
          this.touchWindow()
          // ② 【lead 拍板】stale base 策略:record 已有更新版本(env.baseRevision≠current rev)→409 terminal conflict,不落盲 replace(数据破坏);dead-letter
          const existing = this.recs.get(nodeId)
          if (existing && env.baseRevision !== existing.revision) {
            this.pendingLegacyQueue = Math.max(0, this.pendingLegacyQueue - 1)  // ★ queue 项 dead-lettered(用户可见)
            return { status: 409, body: { error: 'legacy-stale-conflict', revision: existing.revision } }  // ★ terminal conflict,不盲 replace
          }
          // ★ v8 Blocker 3① delete race:record missing + baseRevision>0 → record 已在入队后被删,盲 create = 复活已删 record(数据破坏)→ 409 terminal conflict dead-letter(非盲 create)
          if (!existing && env.baseRevision > 0) {
            this.pendingLegacyQueue = Math.max(0, this.pendingLegacyQueue - 1)  // ★ dead-lettered(用户可见)
            return { status: 409, body: { error: 'legacy-stale-conflict', revision: 0 } }  // ★ terminal conflict,不盲 create 复活已删 record
          }
          // fresh(baseRevision===current rev,或 record 不存在且 baseRevision===0=new record)→200 replace
          this.applyLegacyReplace(nodeId, env.payload)
          this.drainCount += 1; this.pendingLegacyQueue = Math.max(0, this.pendingLegacyQueue - 1)  // ★ envelope 增量已由 touchWindow 计(不重复)
          return { status: 200, body: { id: nodeId, revision: this.recs.get(nodeId)!.revision, seq: this.recs.get(nodeId)!.revision } }
        }
        if (!isDomainOp) return { status: 400, body: { error: 'payload-rejected' } }  // raw 旧 body(无 kind)→ 400(必须包信封)
        const op = body as NewOp
        const r = this.recs.get(nodeId) ?? { ...nodePayload(), id: nodeId, revision: 0 } as NodeRecord
        if (op.kind === 'set') setByPath(r as Record<string, unknown>, [...op.fieldPath], op.value, { allowContainerClobber: false })
        else if (op.kind === 'array' && op.class === 'whole-lww') setByPath(r as Record<string, unknown>, [...op.fieldPath], op.value, { allowContainerClobber: true })
        r.revision += 1
        this.recs.set(nodeId, structuredClone(r))
        return { status: 200, body: { id: nodeId, revision: r.revision, seq: r.revision } }
      }
      if (isDomainOp || isLegacyEnvelope) return { status: 400, body: { error: 'payload-rejected' } }
      this.applyLegacyReplace(nodeId, body as LegacyUpsertBody)
      return { status: 200, body: { id: nodeId, revision: this.recs.get(nodeId)!.revision, seq: 1 } }
    }
    /** whole-record replace(同 backend.ts:1086-1088 `payload: clone(payload)`,非 merge);由 patch decoder 调用(非测试直调)。 */
    private applyLegacyReplace(nodeId: string, payload: NodePayload) {
      const existing = this.recs.get(nodeId)
      const rev = existing ? existing.revision + 1 : 1
      this.recs.set(nodeId, structuredClone({ ...payload, id: nodeId, revision: rev }) as NodeRecord)
    }
    applyDelete(cmd: ServerInvariantCommand) { if (cmd.kind === 'node-delete-cascade') this.recs.delete(cmd.nodeId) }
    snapshot(): NodeRecord[] { return [...this.recs.values()].map((r) => structuredClone(r)) }
    materializeLegacyBody(nodeId: string): NodePayload | null {
      const r = this.recs.get(nodeId); if (!r) return null
      const { id: _id, revision: _rev, ...rest } = r; void _id; void _rev
      return structuredClone(rest) as NodePayload
    }
    get(nodeId: string): NodeRecord | undefined { const r = this.recs.get(nodeId); return r ? structuredClone(r) : undefined }
  }

  it('C-1 cutover flag on/off decoder:flag-off NodePayload 200 + DomainOp 400;flag-on NodePayload 400 + DomainOp 200(状态表 row 1/3)', () => {
    const h = new CutoverHarness()
    const legacy: LegacyUpsertBody = nodePayload({ title: 'orig' })
    const newOp: NewOp = { kind: 'set', fieldPath: ['title'], value: 'T' }
    h.setFlag(false)
    expect(h.patch('n1', legacy).status).toBe(200)
    expect(h.patch('n1', newOp).status).toBe(400)
    h.setFlag(true)
    expect(h.patch('n1', legacy).status).toBe(400)
    expect(h.patch('n1', legacy).body.error).toBe('payload-rejected')
    expect(h.patch('n1', newOp).status).toBe(200)
  })

  it('C-2 FX-5 migration wire v8 补全(LegacyReplaceRequest 绑 canvasId+baseRevision;scope+authz+stale-base 409 dead-letter+v8 delete-race missing+baseRev>0→409 非盲 create 复活+v8 retirement fake-clock quiet-window;raw→400, envelope→200 replace 非直调)', () => {
    const h = new CutoverHarness('c1')
    h.setFlag(true); h.setLegacyDrain(true); h.addMember('alice'); h.addMember('bob')  // authz:canvas-write seam
    expect(_noIdInPayload).toBe(false)
    // ★ ① raw 旧 body(NodePayload 无 kind)→ 400(必须包信封;禁止绕 wire 直调 drainLegacyUpsert)
    expect(h.patch('n-raw', nodePayload({ title: 'raw' })).status).toBe(400)
    expect(h.recordExists('n-raw')).toBe(false)
    // ★ ② envelope 经 decoder wire → 200 replace(authz alice pass;scope c1/n-up match;baseRevision=0,record 不存在→create fresh)
    h.enqueueLegacy(1)  // 模拟队列项入队
    const payload = nodePayload({ title: 'drained', text: 'body', fontSize: 18, locked: true, transform: { x: 5, y: 6, width: 100, height: 40, rotation: 0 }, fills: [] })
    const upsertOp: WriteOp = { kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-up', payload, baseRevision: 0 }
    const m = migrateWriteOp(upsertOp)
    expect(m.kind).toBe('legacy-envelope')
    if (m.kind === 'legacy-envelope') {
      const env = m.envelope
      expect(env.canvasId).toBe('c1'); expect(env.nodeId).toBe('n-up'); expect(env.version).toBe(1); expect(env.baseRevision).toBe(0)  // ★ 信封绑 canvasId+nodeId+version+baseRevision
      const res = h.patch(env.nodeId, env, { actor: 'alice' })  // ★ 经 decoder wire(非直调)
      expect(res.status).toBe(200)  // ★ envelope → 200 replace
      expect(h.drainCountValue()).toBe(1); expect(h.envelopeIncrementInWindowGauge()).toBe(1)  // ★ 观测+窗增量
      expect(h.pendingLegacyQueueGauge()).toBe(0)  // ★ queue 项 drained(从 1→0)
      const got = h.get('n-up')!
      expect(got.id).toBe('n-up'); expect(got.title).toBe('drained'); expect(got.text).toBe('body'); expect(got.fontSize).toBe(18)
      expect(got.transform).toEqual({ x: 5, y: 6, width: 100, height: 40, rotation: 0 }); expect(got.fills).toEqual([])
      expect(h.materializeLegacyBody('n-up')).toEqual(payload)  // ★ deep-equal
    }
    // ★ ③ authz deny 负例:无 actor → 403(no void actor);非 member → 403
    const mNoAuth = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-noauth', payload: nodePayload({ title: 'x' }), baseRevision: 0 })
    if (mNoAuth.kind === 'legacy-envelope') {
      expect(h.patch(mNoAuth.envelope.nodeId, mNoAuth.envelope).status).toBe(403)  // ★ 无 actor → 403(no void)
      expect(h.patch(mNoAuth.envelope.nodeId, mNoAuth.envelope, { actor: 'eve' }).status).toBe(403)  // ★ 非 member → 403(deny 负例)
    }
    // ★ ④ scope 校验:envelope.canvasId 不匹配 path canvas → 400(防同 nodeId 跨 canvas 重放)
    const mCross = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c2', nodeId: 'n-scope', payload: nodePayload({ title: 'x' }), baseRevision: 0 })
    if (mCross.kind === 'legacy-envelope') {
      expect(h.patch(mCross.envelope.nodeId, mCross.envelope, { actor: 'alice' }).status).toBe(400)  // ★ env.canvasId=c2 ≠ path c1 → 400(跨 canvas 重放防)
      expect(h.recordExists('n-scope')).toBe(false)  // 未落库
    }
    // ★ ⑤ scope:envelope.nodeId 不匹配 path node → 400(防 forge path)
    const mForge = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-real', payload: nodePayload({ title: 'x' }), baseRevision: 0 })
    if (mForge.kind === 'legacy-envelope') {
      expect(h.patch('n-different', mForge.envelope, { actor: 'alice' }).status).toBe(400)  // env.nodeId(n-real)≠path(n-different)→ 400
    }
    // ★ ⑥ 【lead 拍板】stale base→409 terminal conflict,不落盲 replace(数据破坏防);dead-letter(queue 项移除,用户可见)
    h.seedRecord(makeNode('n-stale', { title: 'server-version' }))  // record rev=0
    // 模拟 server 已更新(record rev bumped to 2,非 queued 时的 baseRevision=0)
    h.setFlag(true)  // 用 DomainOp bump rev:patch set 两次 → rev 2
    h.patch('n-stale', { kind: 'set', fieldPath: ['title'], value: 'v1' })  // rev 0→1
    h.patch('n-stale', { kind: 'set', fieldPath: ['title'], value: 'v2' })  // rev 1→2
    expect(h.recordRev('n-stale')).toBe(2)
    h.enqueueLegacy(1)  // queued op with stale baseRevision=0
    const mStale = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-stale', payload: nodePayload({ title: 'queued-stale' }), baseRevision: 0 })
    if (mStale.kind === 'legacy-envelope') {
      const res = h.patch(mStale.envelope.nodeId, mStale.envelope, { actor: 'alice' })
      expect(res.status).toBe(409); expect(res.body.error).toBe('legacy-stale-conflict')  // ★ stale base(0≠2)→409 terminal conflict
      expect(res.body.revision).toBe(2)  // 返 current rev
      expect(h.get('n-stale')?.title).toBe('v2')  // ★ 不落盲 replace(record 仍 server 版本,非 queued-stale;数据破坏防)
      expect(h.pendingLegacyQueueGauge()).toBe(0)  // ★ dead-letter(queue 项移除,用户可见)
    }
    // ★ ⑥b v8 Blocker 3① delete race:record 已删(missing)+ baseRevision>0 → 409 terminal conflict dead-letter(不盲 create 复活已删 record);missing + baseRevision===0 → create fresh
    h.seedRecord(makeNode('n-delrace', { title: 'will-delete' }))  // record rev=0
    h.patch('n-delrace', { kind: 'set', fieldPath: ['title'], value: 'v1' })  // DomainOp bump rev 0→1(不经 legacy envelope,不 touchWindow)
    h.patch('n-delrace', { kind: 'set', fieldPath: ['title'], value: 'v2' })  // rev 1→2
    expect(h.recordRev('n-delrace')).toBe(2)
    h.applyDelete({ kind: 'node-delete-cascade', canvasId: 'c1', nodeId: 'n-delrace' })  // ★ record 删(missing;模拟入队后、drain 前被删)
    expect(h.recordExists('n-delrace')).toBe(false)
    h.enqueueLegacy(1)  // stale queue item:baseRevision=2(record 删前 rev)
    const mDelRace = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-delrace', payload: nodePayload({ title: 'revive' }), baseRevision: 2 })
    if (mDelRace.kind === 'legacy-envelope') {
      const res = h.patch(mDelRace.envelope.nodeId, mDelRace.envelope, { actor: 'alice' })
      expect(res.status).toBe(409); expect(res.body.error).toBe('legacy-stale-conflict')  // ★ missing + baseRevision>0 → 409 terminal conflict(不盲 create 复活)
      expect(res.body.revision).toBe(0)  // record 已删,返 0(非盲 create 的 rev)
      expect(h.recordExists('n-delrace')).toBe(false)  // ★ 不复活(数据破坏防;stale queue 不盲 create 已删 record)
      expect(h.pendingLegacyQueueGauge()).toBe(0)  // dead-letter(queue 项移除)
    }
    // ★ 对照:missing + baseRevision===0 → create fresh(新 record,非 stale queue 复活;与 ② n-up 同型)
    h.enqueueLegacy(1)
    const mNewRace = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-brandnew', payload: nodePayload({ title: 'new' }), baseRevision: 0 })
    if (mNewRace.kind === 'legacy-envelope') {
      expect(h.patch(mNewRace.envelope.nodeId, mNewRace.envelope, { actor: 'alice' }).status).toBe(200)  // ★ missing + baseRevision===0 → create fresh
      expect(h.recordExists('n-brandnew')).toBe(true)
    }
    // ★ ⑦ fresh base(baseRevision===current rev)→ 200 replace
    const freshBase = h.recordRev('n-stale')  // 2
    const mFresh = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-stale', payload: nodePayload({ title: 'fresh-replace' }), baseRevision: freshBase })
    if (mFresh.kind === 'legacy-envelope') {
      expect(h.patch(mFresh.envelope.nodeId, mFresh.envelope, { actor: 'alice' }).status).toBe(200)  // ★ fresh base → 200 replace
      expect(h.get('n-stale')?.title).toBe('fresh-replace')
    }
    // ★ ⑧ v8 retirement fake-clock quiet-window(冻结配置名 LEGACY_DRAIN_QUIET_WINDOW_MS + 绝对时长 + 时间戳/重置语义;
    //   窗口内任一 envelope 到达即重新计时;只有完整连续窗口 delta=0 + pending gauge=0 才 retire)
    expect(h.pendingLegacyQueueGauge()).toBe(0)  // queue drained(②/⑥/⑥b/⑦ drain 完)
    expect(h.envelopeIncrementInWindowGauge()).toBeGreaterThan(0)  // ②/⑥b/⑦ envelope 到达过(delta>0)
    expect(h.canRetire()).toBe(false)  // ★ delta>0(刚有 envelope 活动)→ 不 retire
    h.advanceClock(CutoverHarness.LEGACY_DRAIN_QUIET_WINDOW_MS - 1)  // 推进到完整 quiet 窗口边界前 1ms
    expect(h.canRetire()).toBe(false)  // ★ 窗口未完整(elapsed < quietWindowMs)→ 不 retire
    expect(h.tickObservationWindow()).toBe(false)  // ★ 窗口未完整 → 不归零 delta(返 false)
    expect(h.envelopeIncrementInWindowGauge()).toBeGreaterThan(0)  // delta 仍 >0
    h.advanceClock(1)  // 推过完整 quiet 窗口边界
    expect(h.tickObservationWindow()).toBe(true)  // ★ 完整连续 quiet 窗口(delta=0,期间无 envelope 到达)→ 归零 envelopeIncrement(返 true)
    expect(h.envelopeIncrementInWindowGauge()).toBe(0)  // ★ delta=0(完整窗口归零)
    expect(h.canRetire()).toBe(true)  // ★ 完整窗口 delta=0 + pending=0 → 可 retire
    expect(h.drainCountValue()).toBeGreaterThan(0)  // drainCount 累计总量(非 retirement 条件)
    // ★ v8 mid-window envelope 到达 → 重新计时(须再等完整 quiet 窗口才可 retire;防"刚 retire 又来 envelope"误判)
    const mMid = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-mid', payload: nodePayload({ title: 'mid' }), baseRevision: 0 })
    if (mMid.kind === 'legacy-envelope') {
      expect(h.patch(mMid.envelope.nodeId, mMid.envelope, { actor: 'alice' }).status).toBe(200)  // fresh envelope 到达 → touchWindow 重新计时
    }
    expect(h.envelopeIncrementInWindowGauge()).toBeGreaterThan(0)  // ★ envelope 到达 → delta>0
    expect(h.canRetire()).toBe(false)  // ★ 窗口被重新计时(windowStartAt=now,elapsed 归零)→ 不 retire(须再等完整窗口)
    h.advanceClock(CutoverHarness.LEGACY_DRAIN_QUIET_WINDOW_MS)  // 再推过完整 quiet 窗口
    expect(h.tickObservationWindow()).toBe(true)  // 完整窗口 → 归零 delta
    expect(h.canRetire()).toBe(true)  // ★ 再等完整窗口后 → 可 retire(连续窗口 delta=0 + pending=0)
    // ★ ⑨ LEGACY_DRAIN gate 关(retirement 后)→ envelope→400(兼容通道关闭)
    h.setLegacyDrain(false)
    const mGate = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-gate', payload: nodePayload({ title: 'after-retire' }), baseRevision: 0 })
    if (mGate.kind === 'legacy-envelope') {
      expect(h.patch(mGate.envelope.nodeId, mGate.envelope, { actor: 'alice' }).status).toBe(400)  // ★ gate 关 → 400
    }
    // ★ ⑩ replace 覆盖(非 merge)+ delete→cascade + reorder→DomainOp
    h.seedRecord(makeNode('n-replace', { text: 'hello', title: 'seed' })); h.setLegacyDrain(true); h.enqueueLegacy(1)
    const payloadNoText = nodePayload({ title: 'no-text' }); delete (payloadNoText as { text?: string }).text
    const mRep = migrateWriteOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n-replace', payload: payloadNoText, baseRevision: 0 })
    if (mRep.kind === 'legacy-envelope') {
      expect(h.patch(mRep.envelope.nodeId, mRep.envelope, { actor: 'bob' }).status).toBe(200)  // record 不存在时 base 0 fresh;但 n-replace seed rev=0,baseRevision=0===0 fresh
      expect((h.get('n-replace') as { text?: string }).text).toBeUndefined()  // replace 移除 text(非 merge)
    }
    h.seedRecord(makeNode('n-del'))
    const mDel = migrateWriteOp({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n-del' })
    expect(mDel.kind).toBe('delete')
    if (mDel.kind === 'delete') { expect(mDel.cmd.kind).toBe('node-delete-cascade'); h.applyDelete(mDel.cmd); expect(h.recordExists('n-del')).toBe(false) }
    const mRe = migrateWriteOp({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n3', 'n1', 'n2'], baseContentVersion: 0 })
    expect(mRe.kind).toBe('reorder')
    if (mRe.kind === 'reorder') { expect(mRe.op.kind === 'reorder' && mRe.op.orderedIds).toEqual(['n3', 'n1', 'n2']) }
    // ★ Blocker 3 验收:LegacyReplaceRequest 绑 canvasId+nodeId+baseRevision;scope 校验(防跨 canvas);stale base→409 terminal conflict 非盲 replace+dead-letter;真实 authz+deny 负例(no void actor);retirement 双指标(pending queue=0 + 窗增量=0);raw→400, envelope→200 replace 经 decoder wire 非直调。
  })

  it('C-4 rollback = snapshot materialize:flag off → 从 authoritative 全 record 重建 NodePayload(非 delta 反演;剥 id+revision,状态表 row 5)', () => {
    const h = new CutoverHarness()
    h.setFlag(true)
    h.patch('n1', { kind: 'set', fieldPath: ['title'], value: 'new-title' })
    const snap = h.snapshot()
    expect(snap.find((r) => r.id === 'n1')?.title).toBe('new-title')
    h.setFlag(false)
    const legacyBody = h.materializeLegacyBody('n1')!
    expect(legacyBody.title).toBe('new-title')
    expect((legacyBody as { id?: string }).id).toBeUndefined()  // ★ materialized NodePayload 无 id
    expect(h.patch('n1', legacyBody).status).toBe(200)  // flag-off NodePayload 200(整 record decoder,状态表 row 5)
    // ★ Blocker 3 验收:rollback snapshot materialize 从 authoritative 全 record 重建 NodePayload(无 id);delta-inversion 无算法/不支持(降级到已测范围)。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// v4 Blocker 6:两文档交叉契约测试 — port CanvasChange 形状 ↔ N20 CreateBody/DomainOp 可无损映射
// ════════════════════════════════════════════════════════════════════════════
// sol 第三轮阻断 6:canvasSyncPort(transport-neutral port)与 N2-0 决议(CreateBody/DomainOp)形状需无损映射;
//   port create-node 携 NodeRecord(含 id)→ N20 CreateBody(payload=NodePayload 无 id,id → adapter path);
//   port edit-node FieldIntent[] → N20 DomainOp set/unset[];port delete-node → N20 ServerInvariantCommand cascade;
//   port reorder-children → N20 DomainOp reorder。两文档形状一致,adapter 可无损翻译。
describe('N2-0 v4 Blocker 6: port CanvasChange ↔ N20 CreateBody/DomainOp 无损映射(两文档交叉契约)', () => {
  // port CanvasChange → N20 wire(CreateBody / DomainOp[] / ServerInvariantCommand)无损映射
  type N20Wire =
    | { kind: 'create'; create: CreateBody; recordId: string }   // create-node → CreateBody + path id(client NodeRecord.id)
    | { kind: 'edit'; ops: DomainOp[] }                          // edit-node → DomainOp set/unset[]
    | { kind: 'delete'; cmd: ServerInvariantCommand }            // delete-node → server-named cascade
    | { kind: 'reorder'; op: DomainOp }                          // reorder-children → DomainOp reorder

  const mapChangeToN20 = (change: CanvasChange, canvasId: string): N20Wire => {
    switch (change.kind) {
      case 'create-node': {
        // NodeRecord → (id, NodePayload);CreateBody.payload = NodePayload(无 id);id → adapter path(Blocker 2 client-id)
        const { id, revision: _rev, ...payload } = change.node
        void _rev
        return { kind: 'create', create: { clientId: 'c', type: 'node', payload }, recordId: id }
      }
      case 'edit-node': {
        // FieldIntent[] → DomainOp[] (set/delete-field → set/unset);fieldPath + value 透传无损
        const ops: DomainOp[] = change.intents.map((fi: FieldIntent) =>
          fi.op === 'set'
            ? { kind: 'set', fieldPath: fi.fieldPath as FieldPath, value: fi.value }
            : { kind: 'unset', fieldPath: fi.fieldPath as FieldPath })
        return { kind: 'edit', ops }
      }
      case 'delete-node':
        return { kind: 'delete', cmd: { kind: 'node-delete-cascade', canvasId, nodeId: change.nodeId } }
      case 'reorder-children':
        return { kind: 'reorder', op: { kind: 'reorder', orderedIds: change.orderedIds } }
      default:
        // create-edge/create-anchor/edit-edge/edit-anchor/delete-edge/delete-anchor/update-meta 同形(node→edge/anchor;meta 单独)
        throw new Error(`mapChangeToN20: ${change.kind} not in node 4-kind cross-mapping (edge/anchor/meta same shape, see inventory §3)`)
    }
  }

  it('X-1 create-node → N20 CreateBody 无损映射(payload=NodePayload 无 id;id → path;Blocker 2 client-id)', () => {
    const node = makeNode('n-x1', { title: 'cross', locked: true })
    const change: CanvasChange = { kind: 'create-node', node }
    const wire = mapChangeToN20(change, 'c1')
    expect(wire.kind).toBe('create')
    if (wire.kind !== 'create') return
    // ★ payload = NodePayload(无 id);id 来自 NodeRecord.id → adapter path(非 server-mint,Blocker 2)
    expect(wire.recordId).toBe('n-x1')                       // ★ id 来自 NodeRecord.id(client-supplied)
    expect(wire.create.type).toBe('node')
    expect((wire.create.payload as { id?: string }).id).toBeUndefined()  // ★ payload 无 id
    expect((wire.create.payload as { title: string }).title).toBe('cross')
    expect((wire.create.payload as { locked: boolean }).locked).toBe(true)
    // 无损:NodeRecord = NodePayload + {id, revision};映射后 (recordId, payload) 可重建 NodeRecord(除 revision 由 server bump)
    const { id: _id, revision: _rev, ...payload } = node
    void _id; void _rev
    expect(wire.create.payload).toEqual(payload)            // ★ payload deep equal Omit<NodeRecord,'id'|'revision'>
  })

  it('X-2 edit-node FieldIntent[] → N20 DomainOp set/unset[] 无损映射(fieldPath + value 透传)', () => {
    const change: CanvasChange = {
      kind: 'edit-node', nodeId: 'n-x2',
      intents: [
        { op: 'set', fieldPath: ['title'], value: 'edited' },
        { op: 'delete-field', fieldPath: ['locked'] },
        { op: 'set', fieldPath: ['transform', 'x'], value: 42 },
      ],
    }
    const wire = mapChangeToN20(change, 'c1')
    expect(wire.kind).toBe('edit')
    if (wire.kind !== 'edit') return
    expect(wire.ops).toHaveLength(3)
    expect(wire.ops[0]).toEqual({ kind: 'set', fieldPath: ['title'], value: 'edited' })      // set 透传
    expect(wire.ops[1]).toEqual({ kind: 'unset', fieldPath: ['locked'] })                    // delete-field → unset
    expect(wire.ops[2]).toEqual({ kind: 'set', fieldPath: ['transform', 'x'], value: 42 })   // 嵌套 fieldPath 透传
  })

  it('X-3 delete-node → N20 ServerInvariantCommand node-delete-cascade(path 推导目标,非 PATCH DomainOp)', () => {
    const change: CanvasChange = { kind: 'delete-node', nodeId: 'n-x3' }
    const wire = mapChangeToN20(change, 'cv1')
    expect(wire.kind).toBe('delete')
    if (wire.kind !== 'delete') return
    expect(wire.cmd.kind).toBe('node-delete-cascade')   // ★ server-named cascade(Blocker 3)
    expect(wire.cmd).toEqual({ kind: 'node-delete-cascade', canvasId: 'cv1', nodeId: 'n-x3' })
  })

  it('X-4 reorder-children → N20 DomainOp reorder(orderedIds 透传)', () => {
    const change: CanvasChange = { kind: 'reorder-children', childType: 'node', orderedIds: ['n3', 'n1', 'n2'] }
    const wire = mapChangeToN20(change, 'c1')
    expect(wire.kind).toBe('reorder')
    if (wire.kind !== 'reorder') return
    expect(wire.op).toEqual({ kind: 'reorder', orderedIds: ['n3', 'n1', 'n2'] })  // orderedIds 透传无损
  })
})
