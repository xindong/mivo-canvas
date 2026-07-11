// src/lib/canvasSyncPort.ts
// G1-b:transport-neutral 画布 port + 中性游标(N2-0 前,不实现 transport)。
// 权威:docs/decisions/canvas-sync-port-inventory.md + docs/plan/remaining-tasks-cutover-plan.md §4 G1-b。
//
// 红线(计划 §10 风险表「画布 port 泄漏候选协议细节」):port 不写任何被某一候选独占的 HTTP transport DTO。
//   - Figma 案独占形状:field-path PATCH body / If-Match revision header / 409 ConflictBody / metaRevision·contentVersion 分名。
//   - Yjs 案独占形状:Y.Update(Uint8Array 二进制)/ state-vector(number[] 时钟向量)/ y-protocol frame。
// port 只表 record/field 级**域语义**(NodeRecord 全量 upsert + delete + reorder);两案 adapter 各自翻译。
// 中性游标 SnapshotCursor = branded unknown(port 永不读其内部;adapter 解释为 revision bundle 或 state-vector)。
//
// 不接线(N2-0 决议前 G1-c 不落地实现):本文件只冻结接口 + 类型,无 runtime 实现。
// unwiredCanvasSyncPort 占位即失败(Karpathy 规则 12:fail visibly, not silently)——防误以为已同步。
//
// 命名/互锁惯例同 src/lib/serverPersistAdapter.ts(T1.3 契约冻结面);本接口是它之上的 transport-neutral 抽象,
// N2-0 选 Figma 时由 ServerPersistAdapter(+ SSE/WS 广播)实现,选 Yjs 时由 Y.Doc + y-protocol WS 实现。

import type { AnchorRecord, EdgeRecord, NodeRecord } from '../kernel/records'

/**
 * 中性版本游标(port 不解释其内部结构)。
 * - Figma 案 adapter 可填 per-record revision bundle / canvas contentVersion;
 * - Yjs 案 adapter 可填 state-vector / Y.Clock;
 * port 只持有与回传,绝不读其字段。branded 防误把裸 number/string/array 当游标透传(见 contract test)。
 *
 * 注:本类型故意**非** `Revision`(number)也**非** `number[]`——那两形分别是 Figma/Yjs 独占,
 * 出现在 port 面即违约。adapter 用 `value as unknown as SnapshotCursor` 构造,port 侧零 inspection。
 */
export type SnapshotCursor = unknown & { readonly __brand: 'SnapshotCursor' }

/**
 * 画布元快照(port 不携带 metaRevision/contentVersion 分名——那是 Figma 案独占;此处统一 updatedAt + 游标)。
 * projectId/createdAt 不可变;title 可经 'update-meta' 改;updatedAt 由 adapter 派生。
 */
export type CanvasMetaSnapshot = {
  title: string
  projectId: string
  createdAt: string
  updatedAt: string
}

/**
 * 画布全量快照(loadSnapshot 返回;hydrate 用)。children 用域 record(NodeRecord/EdgeRecord/AnchorRecord,
 * K40 canonical),**不**用 wire payload(NodePayload 那种 Omit id/revision 的 transport 形状属 Figma 案独占,
 * 不出现在 port 面)。cursor 是 hydrate 后做增量补拉/并发判定的中性锚点。
 */
export type CanvasSnapshot = {
  canvasId: string
  meta: CanvasMetaSnapshot
  nodes: NodeRecord[]
  edges: EdgeRecord[]
  anchors: AnchorRecord[]
  cursor: SnapshotCursor
}

/**
 * 画布变更(port 表**域语义**,不表 wire)。
 * 全量 record upsert——adapter 自行 diff 到 field-patch(Figma 案)或逐字段写 Y.Doc(Yjs 案)。
 * 故意的:不出现 JSON-Patch `ops` / Y.Update 二进制 / If-Match revision——那些是候选独占形状。
 *
 * childType 不含 'chat-message':chat 走 DP-6R per-user 重拆,不是共享画布对象(产品拍板"画布共享/chat 私有")。
 */
export type CanvasChange =
  | { kind: 'upsert-node'; node: NodeRecord }
  | { kind: 'upsert-edge'; edge: EdgeRecord }
  | { kind: 'upsert-anchor'; anchor: AnchorRecord }
  | { kind: 'delete-node'; nodeId: string }
  | { kind: 'delete-edge'; edgeId: string }
  | { kind: 'delete-anchor'; anchorId: string }
  | { kind: 'reorder-children'; childType: 'node' | 'edge' | 'anchor'; orderedIds: string[] }
  | { kind: 'update-meta'; title?: string }

/** 变更来源(subscribe 用,区分本地 echo 与远端广播)。 */
export type ChangeOrigin = 'self' | 'remote'

/**
 * submitChange 结果(中性,覆盖三案可能性)。
 * - accepted:已接受,返新游标(Yjs 案几乎总 accepted——CRDT submit 期无冲突;Figma 案 PATCH 成功后 accepted)。
 * - conflict:base 游标过期/并发改写——返当前游标 + diverging(并发变更清单,adapter 决定粒度;
 *   Figma 案可返整 record 当前 revision 供 rebase;Yjs 案可返空数组——CRDT 已合并,但仍可表"远端已改写需刷新视图")。
 * - retryable:瞬态(网络/服务端 5xx),客户端可原样重试(不视为冲突)。
 */
export type ChangeOutcome =
  | { kind: 'accepted'; cursor: SnapshotCursor }
  | { kind: 'conflict'; currentCursor: SnapshotCursor; diverging: CanvasChange[] }
  | { kind: 'retryable'; reason: string }

/**
 * subscribe 推送的实时事件(中性)。
 * - change:远端(或本地 echo)变更 + 新游标。
 * - gap:连接断/重连后,客户端需用 cursor 做 catch-up(增量补拉);adapter 决定补拉机制
 *   (Figma 案 GET since=revision;Yjs 案 state-vector sv1/sv2 协议)。port 不暴露补拉 wire。
 * - revoke:权限撤销(成员移除/share 撤销),连接应限时断开(N2-2 验收硬要求)。
 */
export type CanvasSyncEvent =
  | { kind: 'change'; change: CanvasChange; cursor: SnapshotCursor; origin: ChangeOrigin }
  | { kind: 'gap'; cursor: SnapshotCursor }
  | { kind: 'revoke'; reason: string }

/** unsubscribe 句柄。 */
export type Unsubscribe = () => void

/**
 * CanvasSyncPort:画布变更 transport-neutral port(G1-b)。
 * 上层(画布 store / hydrate / retry 队列 / shadow reconciliation)只依赖此接口;N2-0 决议后 G1-c 落地**唯一** adapter:
 *   - 选 Figma → ServerPersistAdapter(HTTP PATCH + If-Match)+ SSE/WS 广播合并态;
 *   - 选 Yjs  → Y.Doc + y-protocol over WS(snapshot + Y.Update + state-vector 全在 adapter 内)。
 *
 * 不实现 transport:loadSnapshot/submitChange/subscribe 的具体 wire 形状不在本接口出现,只表域语义 + 中性游标。
 * 红线自证见 canvasSyncPort.contract.test.ts(@ts-expect-error 拒 Y.Update/JSON-Patch/裸 revision/裸 state-vector)。
 */
export interface CanvasSyncPort {
  /**
   * hydrate:载入画布全量快照 + 当前游标。since 非空时 adapter 可走增量(since 同 brand 透传,port 不解释)。
   * null = 画布不存在 / 无访问权(不泄漏存在性,与 ServerPersistAdapter.fetchCanvas 一致)。
   */
  loadSnapshot(canvasId: string, since?: SnapshotCursor): Promise<CanvasSnapshot | null>
  /**
   * 提交一条变更。base 游标可选(供并发判定);返 accepted/conflict/retryable。
   * 注意:base 是**游标**不是 revision number——revision 是 Figma 案独占,不在 port 面。
   */
  submitChange(canvasId: string, change: CanvasChange, base?: SnapshotCursor): Promise<ChangeOutcome>
  /**
   * 订阅实时事件。返回 unsubscribe(异步——realtime channel 建立是 async:WS upgrade / SSE open)。
   * origin='self' 表本地 echo,='remote' 表远端广播。adapter 决定 transport(WS/SSE),port 不暴露。
   */
  subscribe(canvasId: string, onEvent: (event: CanvasSyncEvent) => void): Promise<Unsubscribe>
}

const notWired = (method: string): Promise<never> =>
  Promise.reject(new Error(`CanvasSyncPort.${method} not wired (G1-b port freeze; N2-0 decision + G1-c implementation pending)`))

/**
 * 占位实现:满足接口,fail visibly,绝不静默成功(防误以为已同步——与 unwiredServerPersistAdapter 同型)。
 * N2-0 决议 + G1-c 实现时换真 adapter。
 */
export const unwiredCanvasSyncPort: CanvasSyncPort = {
  loadSnapshot: () => notWired('loadSnapshot'),
  submitChange: () => notWired('submitChange'),
  subscribe: () => notWired('subscribe'),
}
