// src/lib/canvasSyncPort.ts
// G1-b:transport-neutral 画布 port + 中性游标 + 字段级编辑意图(N2-0 前,不实现 transport)。
// 权威:docs/decisions/canvas-sync-port-inventory.md + docs/plan/remaining-tasks-cutover-plan.md §4 G1-b。
//
// 红线(计划 §10 风险表「画布 port 泄漏候选协议细节」):port 不写任何被某一候选独占的 HTTP transport DTO。
//   - Figma 案独占形状:field-path PATCH body / If-Match revision header / 409 ConflictBody / metaRevision·contentVersion 分名。
//   - Yjs 案独占形状:Y.Update(Uint8Array 二进制)/ state-vector(编码态 Uint8Array,解码态 Map<clientID,clock>)/ y-protocol frame。
// port 只表 record/field 级**域语义**:create(全量新 record)/ edit(字段级意图,fieldPath 域数组)/ delete / reorder / update-meta。
//   两案 adapter 各自翻译:Figma 案 edit→field-path PATCH body + If-Match;Yjs 案 edit→嵌套 Y.Map.set(永不 clear 整 record)。
// 中性游标 SnapshotCursor = branded unknown(port 永不读其内部;adapter 解释为 revision bundle 或 state-vector)。
//
// 返修(G1-b 双审 REQUIRES_CHANGES,2026-07-12,3 条 finding 全部 lead 独立核证):
//   - F1:CanvasChange 由「全量 record upsert」改为「create 全量 + edit 字段级意图」。全量 upsert 在并发下会把
//     远端字段更新误判为本地回滚(base 可选更放大此风险),且 Yjs 案 clear+rebuild 整 record 会吞并发子字段
//     (spike yjs-mapping.spike.test.ts:376-398 坑7 实证:B 改 transform.y=999,A 整 record 重写 → B 的 999 丢失)。
//     fieldPath 是域语义数组 (string|number)[],非 JSON-Patch wire DTO(无 RFC6902 path/ops)——与 N2-0 §10.1
//     FieldOp.fieldPath 同形对齐,两案 adapter 都能消费(fieldPath 是域语义不是 wire)。
//   - F3:ChangeOutcome 加 terminal rejection(RejectionReason 域枚举,不漏 HTTP 码/Yjs frame);冻结 accepted=权威 ack。
//     先例:writeRetryQueue.WriteOutcome 8 态(src/lib/writeRetryQueue.ts:108-116)用域 status 名而非裸 HTTP 码。
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
 * - Yjs 案 adapter 可填 state-vector(编码态 Uint8Array)/ Y.Clock;
 * port 只持有与回传,绝不读其字段。branded 防误把裸 number/string/array 当游标透传(见 contract test)。
 *
 * 注:本类型故意**非** `Revision`(number)也**非** `number[]`(更**非** `Uint8Array`)——那三形分别是
 * Figma/Yjs 独占,出现在 port 面即违约。adapter 用 `value as unknown as SnapshotCursor` 构造,port 侧零 inspection。
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
 * 属性级路径(域语义,**非** wire JSON-Patch pointer)。
 * - `(string | number)[]`:string key 进对象字段,number 进数组下标(如 `['fills', 0, 'color']` / `['transform','x']`)。
 * - 与 N2-0 §10.1 `FieldOp.fieldPath` 同形,但本类型是**域语义**不是 wire DTO:两案 adapter 都能消费——
 *   Figma 案把它翻成 field-path PATCH body 的路径段;Yjs 案按路径逐层 Y.Map.set 嵌套叶子(永不 clear 整子树)。
 * - 故意非 RFC 6902 JSON-Pointer 字符串(`/transform/x`):那是 wire 形状,不出现在 port 面(见 contract test 负向断言)。
 * - ReadonlyArray:意图不可在 adapter 侧原地改(port 冻结后路径不可变)。
 */
export type FieldPath = ReadonlyArray<string | number>

/**
 * 单条字段级编辑意图(对**已存在** record 的叶子操作)。
 * - `set`:在 fieldPath 处写叶子值(对象/数组内部须已存在;全新 record 不在此,走 create-* 全量)。
 * - `delete-field`:移除 fieldPath 处的叶子(**非** record 删除——record 删走 delete-* kind)。
 * - 故意非 RFC 6902 op(`replace`/`add`/`remove`/`copy`/`move`/`test`):那是 wire DTO;此处是域动词。
 *   `value` 用 `unknown` 因 port 对 record schema 不透明(校验在 adapter/server,N10 白名单)。
 */
export type FieldIntent =
  | { op: 'set'; fieldPath: FieldPath; value: unknown }
  | { op: 'delete-field'; fieldPath: FieldPath }

/**
 * 画布变更(port 表**域语义**,不表 wire)。
 *
 * **返修 F1:全量 record upsert → create(全量)+ edit(字段级意图)。**
 * 旧 `upsert-*`(全量 record)有两个并发缺陷:
 *  1. adapter 对 shadow diff 全量 record 时,会把「远端已更新的字段」误判为「本地回滚」(base 可选更放大此风险)。
 *  2. Yjs 案 adapter 若 clear+rebuild 整 record,会吞掉并发子字段更新(spike `yjs-mapping.spike.test.ts:376-398`
 *     坑7 实证:B 改 transform.y=999,A 整 record 重写 → B 的 999 丢失,merged.transform.y 回到 -20)。
 * 故拆分:
 *  - `create-*`:新 record(全量 record 是意图本身;新 record 无并发覆盖隐患,base 不必填)。
 *  - `edit-*`:对**已存在** record 的字段级意图(`intents: FieldIntent[]`)——只提交改动的字段,未编辑字段不入 wire,
 *    嵌套叶子按 fieldPath 定点 set,不整树替换。两案 adapter 各自翻译(见 FieldPath/FieldIntent 注释)。
 *
 * childType 不含 'chat-message':chat 走 DP-6R per-user 重拆,不是共享画布对象(产品拍板"画布共享/chat 私有")。
 */
export type CanvasChange =
  // create:全新 record(全量 record 是意图;新 record 无并发覆盖隐患,base 不必填)。
  | { kind: 'create-node'; node: NodeRecord }
  | { kind: 'create-edge'; edge: EdgeRecord }
  | { kind: 'create-anchor'; anchor: AnchorRecord }
  // edit:对已存在 record 的字段级意图(无损并发:只提交改动字段,嵌套叶子定点 set,不整树替换)。
  | { kind: 'edit-node'; nodeId: string; intents: FieldIntent[] }
  | { kind: 'edit-edge'; edgeId: string; intents: FieldIntent[] }
  | { kind: 'edit-anchor'; anchorId: string; intents: FieldIntent[] }
  // delete:record 级删除(走服务端事务路径 cascade,见 N2-0 §10.4;非 fieldPath delete-field)。
  | { kind: 'delete-node'; nodeId: string }
  | { kind: 'delete-edge'; edgeId: string }
  | { kind: 'delete-anchor'; anchorId: string }
  // reorder:orderedIds 表达完整目标序(移动意图;非 Y.Array delete+insert——见 N2-0 §11 Q5 维持 (b) 显式 order_key)。
  | { kind: 'reorder-children'; childType: 'node' | 'edge' | 'anchor'; orderedIds: string[] }
  // meta:title 字段级(metaRevision/contentVersion 分名不出现,Figma 案独占)。
  | { kind: 'update-meta'; title?: string }

/** 变更来源(subscribe 用,区分本地 echo 与远端广播)。 */
export type ChangeOrigin = 'self' | 'remote'

/**
 * 终态拒绝原因(域枚举,**不漏** HTTP 状态码 / Yjs frame)。
 * 先例:`writeRetryQueue.WriteOutcome` 8 态(src/lib/writeRetryQueue.ts:108-116)用域 status 名而非裸 HTTP 码;
 * 此处同型——adapter 内部把 HTTP 401/403/413/422 等映射到域原因,port 面只见域名,不见数字/wire。
 *
 * 返修 F3:终态拒绝**不可重试**(与 `retryable` 互斥);瞬态(5xx/408/429)才走 `retryable`。
 *  - `unauthorized`:认证过期/无效(401)——调用方重登,非重试同 op。
 *  - `forbidden`:鉴权拒绝/成员被移除/share 撤销(403 / revoke)——非重试。
 *  - `not-found`:目标 record/canvas 已删(404;delete-vs-update → delete wins,见 N2-0 §10.4)。
 *  - `too-large`:payload 超限(413)——非重试同 payload。
 *  - `reuse-conflict`:幂等 key 复用但 body 不同(422)——非重试同 op。
 *  - `bad-request`:校验/schema 失败(400/422 payload)——非重试同 payload。
 *  - `terminal`:其他不可重试(catch-all,detail 描述)。
 */
export type RejectionReason =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'too-large'
  | 'reuse-conflict'
  | 'bad-request'
  | 'terminal'

/**
 * submitChange 的结果(中性,覆盖成功/冲突/瞬态/终态拒绝四类)。
 * - `accepted`:**权威 ack**(服务端真相源已 commit),返新游标。返修 F3 冻结语义:accepted = 服务端权威确认,
 *   **非**「本地已应用」。乐观 echo(本地先应用)是调用方的事,port 不在 outcome 表「local-applied」——
 *   accepted 必须携带服务端回传的 cursor,无 cursor 即无 accepted(防假成功)。Yjs 案 CRDT submit 期无冲突,
 *   adapter 合并后回 cursor 也走 accepted。
 * - `conflict`:base 游标过期/并发改写——返当前游标 + diverging(并发变更清单,adapter 决定粒度;
 *   Figma 案可返 edit-* intents 供 rebase;Yjs 案可返空数组——CRDT 已合并,但仍可表"远端已改写需刷新视图")。
 * - `retryable`:瞬态(网络/服务端 5xx/408/429),客户端可原样重试(不视为冲突,不视为终态拒绝)。
 * - `rejected`:**终态拒绝**(typed RejectionReason,不漏 HTTP 码/Yjs frame)——**不可重试**,
 *   调用方按 reason surfacing(重登/改 payload/放弃),绝不原样重试(防终态误重试)。
 */
export type ChangeOutcome =
  | { kind: 'accepted'; cursor: SnapshotCursor }
  | { kind: 'conflict'; currentCursor: SnapshotCursor; diverging: CanvasChange[] }
  | { kind: 'retryable'; reason: string }
  | { kind: 'rejected'; reason: RejectionReason; detail?: string }

/**
 * subscribe 推送的实时事件(中性)。
 * - change:远端(或本地 echo)变更 + 新游标。
 * - gap:连接断/重连后,客户端需用 cursor 做 catch-up(增量补拉);adapter 决定补拉机制
 *   (Figma 案 GET since=revision/seq;Yjs 案 sv1/sv2 协议——state-vector 编码态是 Uint8Array,非 number[])。
 *   port 不暴露补拉 wire。
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
 * 红线自证见 canvasSyncPort.contract.test.ts(@ts-expect-error 拒 Y.Update/JSON-Patch/裸 revision/裸 state-vector/HTTP 码/JSON-Patch op)。
 */
export interface CanvasSyncPort {
  /**
   * hydrate:载入画布全量快照 + 当前游标。since 非空时 adapter 可走增量(since 同 brand 透传,port 不解释)。
   * null = 画布不存在 / 无访问权(不泄漏存在性,与 ServerPersistAdapter.fetchCanvas 一致)。
   */
  loadSnapshot(canvasId: string, since?: SnapshotCursor): Promise<CanvasSnapshot | null>
  /**
   * 提交一条变更。base 游标可选(供并发判定);返 accepted/conflict/retryable/rejected。
   * 注意:base 是**游标**不是 revision number——revision 是 Figma 案独占,不在 port 面。
   * edit-* 的 intents 携带字段级意图(已 diff 好);adapter 翻译为 field-path PATCH(Figma)或嵌套 Y.Map.set(Yjs)——
   * adapter 不再对全量 record 做 shadow diff(F1:diff 已在 producer 侧完成,intents 即 diff 结果)。
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
