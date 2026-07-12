# 画布 transport-neutral port + 两案契约 inventory(G1-b)

> 状态:**契约冻结 + inventory,不实现 transport**(G1-b,N2-0 决议前)。
> 日期:2026-07-12(R1 返修:纠 Yjs 五维事实 + F1 字段级意图 + F3 终态拒绝;R2 返修:封死 clobber + create→edit 因果 + 404-delete authoritative-load cursor,见 §8;R3 返修:schema-aware 容器/数组封死 + retryable/conflict 所有权 + per-key 状态机 + delete race 全封,见 §9;R4 返修:classifier 必填(安全入口不静默降级)+ async submitChange 状态机(删 ackCreate,caller-owned retry/rebase 经公开入口闭环),见 §10;旧 R2/R3 sync submit/ackCreate 与可选 classifier 段已被 R4 supersede)。
> 范围:计划 `docs/plan/remaining-tasks-cutover-plan.md` §4 Gate1 G1-b + §10 风险表「画布 port 泄漏候选协议细节」。
> 上游真相源:`docs/plan/remaining-tasks-cutover-plan.md` §4/§8(N2-0 决策龙头)、`docs/decisions/platform-architecture-2026-07-07.md`(§6 CRDT-ready、§13.5 per-record revision)、`docs/decisions/record-schema.md`(K40 canonical)、`shared/persist-contract.ts`(现有 Figma-case wire 契约)、`src/lib/serverPersistAdapter.ts`(现有 Figma-case adapter 占位)、`node_modules/yjs/dist/src/utils/encoding.d.ts`(Yjs state-vector 真实签名)、`src/kernel/__spike__/yjs-mapping.spike.test.ts`(Yjs 映射 spike 实证)、`src/lib/writeRetryQueue.ts`(WriteOutcome 8 态先例)。
> 源码产物(本批):`src/lib/canvasSyncPort.ts`(port 接口 + 中性游标 + 字段级意图)、`src/lib/canvasSyncPort.contract.test.ts`(红线自证 + F1/F3 契约)。
>
> 本文件目的:供 **N2-0** 逐项对比 **Figma 式(服务端做主 + 属性级 LWW + 实时广播)vs Yjs(Y.Doc + y-protocol)** 两案,并供 **G1-c** 决议后落地**唯一**模型(另一模型不留死接口)。每案列五维:wire / hydrate / retry / conflict / shadow。

---

## 0. TL;DR

1. **port 是 transport-neutral 抽象**:接口 `loadSnapshot / submitChange / subscribe`,只表 record/field 级**域语义**(`create-*` 全量新 record / `edit-*` 字段级意图 / `delete-*` / `reorder-children` / `update-meta`),**不**出现任一候选独占的 transport DTO。
2. **中性游标 `SnapshotCursor`**:branded `unknown`。port 永不读其内部;adapter 解释为 Figma 案的 per-record revision bundle / canvas contentVersion,或 Yjs 案的 state-vector(编码态 `Uint8Array`)/ Y.Clock。这是两案 wire 形状根本不同的唯一收敛点。
3. **红线(N2-0 前硬约束)**:port 不含 field-path PATCH body / If-Match revision header / 409 ConflictBody / metaRevision·contentVersion 分名(Figma 独占);不含 Y.Update(Uint8Array)/ state-vector(Uint8Array 编码 / `Map<clientID,clock>` 解码)/ y-protocol frame(Yjs 独占)。出现任一即违约(计划 §10 风险表)。自证见 §4 + `canvasSyncPort.contract.test.ts` 的 `@ts-expect-error`。
4. **不实现 transport**:仅冻结接口 + 类型 + 占位 fail-visible impl。N2-0 决议后 G1-c 落地唯一 adapter,另一模型零死接口。
5. **两案根本差异在 wire/conflict/shadow 三维**(hydrate/retry 可经 adapter 翻译收敛):Figma 案服务端是**权威合并点**(409 冲突 + rebase + 三态 shadow);Yjs 案客户端 Y.Doc 本身即**合并态**(CRDT 自合并 + sv 补拉 + 一态)。N2-0 的 hard gate(文本同编 / undo / 跨 record 事务 / 网关 ws)决定取舍。

---

## 1. port 接口签名(冻结,见 `src/lib/canvasSyncPort.ts`)

```ts
interface CanvasSyncPort {
  loadSnapshot(canvasId: string, since?: SnapshotCursor): Promise<CanvasSnapshot | null>
  submitChange(canvasId: string, change: CanvasChange, base?: SnapshotCursor): Promise<ChangeOutcome>
  subscribe(canvasId: string, onEvent: (e: CanvasSyncEvent) => void): Promise<Unsubscribe>
}

type SnapshotCursor = unknown & { readonly __brand: 'SnapshotCursor' } // branded,opaque

// 返修 F1:全量 upsert → create(全量)+ edit(字段级意图)
// 返修 R2-P1-1:FieldPath 改非空 tuple(封死空路径 clobber)+ validateFieldIntent 拒非原子 set(封死整子树 clobber)
// 返修 R3-P1-1:加 schema-aware 分类(FieldSchemaClassifier),拒 delete-field 到 container / set 原子值到容器路径
// 返修 R4-P1-1(当前态,见 §10.1):classifier 从可选改**必填**(安全入口不可静默降级);结构性校验拆到显式命名的低层 validateFieldIntentStructural
type FieldPath = readonly [string | number, ...(string | number)[]]   // 非空 tuple,域语义路径,非 RFC6902 JSON-Pointer
type FieldPathTarget = 'leaf' | 'container' | 'array-element'           // R3-P1-1:路径终点类别(标量/对象容器/数组元素)
type FieldSchemaClassifier = (fieldPath: FieldPath) => FieldPathTarget   // R4-P1-1:必填(安全入口),调用方/adapter 提供(port 对 schema 不透明)
type FieldIntent =
  | { op: 'set'; fieldPath: FieldPath; value: unknown }
  | { op: 'delete-field'; fieldPath: FieldPath }
// validateFieldIntentStructural(intent):低层结构性 validator(**非安全入口**)——
//   拒空路径 / 拒非原子 set(整对象·整数组 clobber 封死)/ 拒数组元素 delete-field(last segment number,by-stable-id deferred)。
//   不依赖 schema,故**不拒** schema-aware clobber(container/array-element 路径上 leaf op)——调用方明示用 structural 即知无 schema 防线。
// validateFieldIntent(intent, classify: FieldSchemaClassifier):**安全入口**域级 validator(port 冻结,非 transport impl)——
//   先过 validateFieldIntentStructural,再以**必填** classifier 拒:delete-field 到 container(整子树删)、set 原子值到 container/array-element 路径(整子树替换)。
//   classifier 省略或传非函数 = 编译期 tsc error + 运行时显式抛错(双重不可绕过);安全入口永不静默降级到无 schema 校验。
//   FieldIntentViolation 枚举:empty-field-path / non-atomic-parent-set / array-element-structure-delete /
//   container-delete-field / atomic-value-to-container-path(R3-P1-1 扩 2→5 key)。
//   数组结构编辑(增/删元素)不在 FieldIntent,deferred to N2-0 §10.1(与 n20 R2-4 三类数组方向对齐);数组叶子编辑(['fills',0,'color'])仍支持。

type CanvasChange =
  | { kind: 'create-node'; node: NodeRecord }      // 全量新 record(新 record 无并发覆盖隐患)
  | { kind: 'create-edge'; edge: EdgeRecord }
  | { kind: 'create-anchor'; anchor: AnchorRecord }
  | { kind: 'edit-node'; nodeId: string; intents: FieldIntent[] }   // 字段级意图(只提交改动字段)
  | { kind: 'edit-edge'; edgeId: string; intents: FieldIntent[] }
  | { kind: 'edit-anchor'; anchorId: string; intents: FieldIntent[] }
  | { kind: 'delete-node'; nodeId: string }
  | { kind: 'delete-edge'; edgeId: string }
  | { kind: 'delete-anchor'; anchorId: string }
  | { kind: 'reorder-children'; childType: 'node' | 'edge' | 'anchor'; orderedIds: string[] }
  | { kind: 'update-meta'; title?: string }       // metaRevision/contentVersion 分名不出现(Figma 独占)

// 返修 F3:加 terminal rejection(域枚举)+ 冻结 accepted=权威 ack
// 返修 R2-P1-2:加 'dependency-failed'(create 终态失败时依赖 edit 的 surface,非 not-found)
type RejectionReason =
  | 'unauthorized' | 'forbidden' | 'not-found' | 'too-large'
  | 'reuse-conflict' | 'bad-request' | 'dependency-failed' | 'terminal'   // 域名,不漏 HTTP 码/Yjs frame

type ChangeOutcome =
  | { kind: 'accepted'; cursor: SnapshotCursor }                          // 权威 ack(非 local-applied)
  | { kind: 'conflict'; currentCursor: SnapshotCursor; diverging: CanvasChange[] }
  | { kind: 'retryable'; reason: string }
  | { kind: 'rejected'; reason: RejectionReason; detail?: string }       // 终态,不可重试

type CanvasSyncEvent =
  | { kind: 'change'; change: CanvasChange; cursor: SnapshotCursor; origin: 'self' | 'remote' }
  | { kind: 'gap'; cursor: SnapshotCursor }       // 断线补拉锚点(adapter 决定 since=revision 还是 sv)
  | { kind: 'revoke'; reason: string }             // N2-2 成员移除/share 撤销限时断流
```

**设计取舍**:
- **返修 F1:create(全量)+ edit(字段级意图),而非全量 record upsert**:旧 `upsert-*` 在并发下有两个缺陷——(1) adapter 对 shadow diff 全量 record 时,会把「远端已更新的字段」误判为「本地回滚」(base 可选更放大此风险);(2) Yjs 案 adapter 若 clear+rebuild 整 record,会吞并发子字段(spike `yjs-mapping.spike.test.ts:376-398` 坑7 实证:B 改 transform.y=999,A 整 record 重写 → B 的 999 丢失)。故拆 `create-*`(新 record,全量是意图,无并发覆盖)+ `edit-*`(字段级意图,只提交改动字段)。`FieldPath` 是域语义数组 `(string|number)[]`,与 N2-0 §10.1 `FieldOp.fieldPath` 同形——**非** RFC 6902 JSON-Patch pointer 字符串(那是 wire DTO,不出现在 port 面)。两案 adapter 都能消费:Figma 案 edit→field-path PATCH body;Yjs 案 edit→嵌套 Y.Map.set(永不 clear 整子树)。**不取 before/after 对**:before/after 翻倍 payload 且仍需 adapter diff before→after 才得 fieldPath,把 diff 推回 adapter(重陷 shadow-diff 误判);typed field intent 让 diff 在 producer 侧显式完成,intents 即 diff 结果。
- **childType 不含 'chat-message'**:chat 走 DP-6R per-user 重拆,不是共享画布对象(产品拍板"画布共享 / chat 私有")。chat 同步不进本 port。
- **`subscribe` 返 `Promise<Unsubscribe>`**:realtime channel 建立是 async(WS upgrade / SSE open),但不暴露具体 transport。
- **返修 F3:`ChangeOutcome` 加 `rejected` 终态 + `RejectionReason` 域枚举**:先例 `writeRetryQueue.WriteOutcome` 8 态(`src/lib/writeRetryQueue.ts:108-116`)用域 status 名而非裸 HTTP 码。`accepted` 冻结为**权威 ack**(非 local-applied);accepted 必携服务端 cursor(无 cursor 即无 accepted,防假成功)。
- **占位 `unwiredCanvasSyncPort`**:fail visibly(`not wired` reject),防误以为已同步(同 `unwiredServerPersistAdapter` 模式)。

---

## 2. 两案契约 inventory(wire / hydrate / retry / conflict / shadow 五维逐项)

> 每维先列 Figma 案(服务端做主 + 属性级 LWW),再列 Yjs 案(Y.Doc + y-protocol),最后点**中性 port 如何同时容纳两案**。
> **返修 F2 纠错**:Yjs 列原 `state-vector(number[])` / "长度=peer 数" / "Yjs 无 per-record revision" 等陈述与 `node_modules/yjs/dist/src/utils/encoding.d.ts:14-15,19` 实际签名 + spike `yjs-mapping.spike.test.ts:408-420` revision↔Yjs 双真相源坑 不符,已逐维纠正。不确定项标 **待 PoC** 而非既定事实。

### 2.1 wire(线上形状)

| | Figma 式(属性 PATCH + 服务端合并) | Yjs 式(Y.Update + y-protocol) |
|---|---|---|
| transport | HTTP REST + SSE/WS 广播合并态 | 双向 WS,y-protocol 帧 |
| 写请求 | `PATCH /api/canvas/:id/nodes/:nid`,body = `NodePayload`(Omit id/revision),`If-Match: <envelope revision>` | `Y.Update`(**Uint8Array 二进制**,见 `encoding.d.ts:9-10` `applyUpdate(doc, update: Uint8Array)`)经 WS 推送 |
| 版本号 | per-record `Revision`(envelope 唯一真相,`shared/persist-contract.ts:31`)+ canvas `metaRevision`/`contentVersion` 分名 | state-vector——**编码态 = `Uint8Array`**(`encoding.d.ts:19` `encodeStateVector(doc): Uint8Array`),**解码态 = `Map<clientID,clock>`**(`encoding.d.ts:14-15` `readStateVector/decodeStateVector: Map<number, number>`)。**非 `number[]`**。无显式 revision——但 K40 per-record revision 硬约束 + Yjs 因果序 = 双真相源坑(见 §2.4/§2.5) |
| 响应 | `UpsertResponse { id, revision }`(post-bump)/ `409 ConflictBody { currentRevision }` | 无 per-op 响应;合并态经广播 `Y.Update`(Uint8Array)回流 |
| 广播 | 服务端合并后 push **合并态**(节点级 PATCH 或全量)给订阅者 | peer 间广播 `Y.Update`(Uint8Array),客户端 CRDT 合并 |
| **port 中性容纳** | `submitChange(change, base?)` → adapter 把 `edit-*` intents 翻成 field-path PATCH body(fieldPath 段直接对应,**无需 diff**)+ `If-Match: base→revision`;`create-*` → POST 全量。 | `submitChange(change, base?)` → adapter 按 fieldPath 段类型逐层导航(**分开**):<br>**Y.Map**(对象字段):`ymap.set(key, encode(value))`——string 段进对象键,逐层下钻,永不 clear 整子树(避坑7);<br>**Y.Array**(数组字段):number 段进下标,**索引漂移**——并发 insert/delete 会移位,故数组叶子编辑走 `arr.get(i)` 取子 Y.Map 再 `.set('color', ...)` 定点(不整 arr 替换);数组**结构**编辑(增/删元素)无中性 FieldIntent(无 `move` 原语,delete+insert 断因果链,spike `:355-374`),deferred to N2-0 §10.1。<br>**delete 语义**:`Y.Map.delete(key)` 删对象键(与 JS `delete` 同形);`Y.Array.delete(i)` 删元素(**≠** JS `delete arr[i]`——后者留 sparse hole,前者真移除并缩短数组;reference helper 的 JS delete 在数组上留 hole ≠ Y.Array.delete,故域语义须由 Yjs adapter 直译,不经 JS helper 自证)。<br>`create-*` seeding 全量 Y.Map。`base` 不用于 If-Match(CRDT 无 base 概念,可忽略)。 |

### 2.2 hydrate(初始化载入)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 全量载入 | `GET /api/canvas/:id` → `GetCanvasResponse`(meta + nodes/edges/anchors envelope,每 record 带 id+revision+orderKey)→ `CanvasSnapshot`(域 record)+ cursor=revision bundle | `GET snapshot`(Y.Doc 序列化或重建)→ `CanvasSnapshot` + cursor=state-vector(**Uint8Array**) |
| 增量补拉 | `GET /api/canvas/:id?since=<contentVersion>` 或节点级 `?changedSince` | sv 协议:client 发 sv1(**Uint8Array**)→ server 回 sv2(**Uint8Array**)+ `Y.Update(since sv1)`(**Uint8Array**);**两端都是字节流,非 `number[]`** |
| cursor 含义 | per-record revision bundle / canvas contentVersion(单数字) | state-vector——**编码态 Uint8Array / 解码态 `Map<clientID,clock>`**(clientID→clock)。**非 `number[]`,长度 ≠ peer 数**(是编码字节流,长度由 clientID 数 + clock 大小编码决定) |
| **port 中性容纳** | `loadSnapshot(canvasId, since?)`:`since` 同 brand 透传,adapter 解释为 revision(contentVersion)做增量 GET,或忽略(首拉)。 | `loadSnapshot(canvasId, since?)`:adapter 解释 `since` 为 sv(Uint8Array)走 sv 协议补拉。port 不知 since 是 revision 还是 sv。 |

### 2.3 retry(失败/瞬态重试)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 瞬态(5xx/网络) | FX-5 IDB write-retry queue(`src/lib/writeRetryQueue.ts`)按 opId 幂等重放 | WS 断线 → Y.Update 本地累积,重连经 sv 协议自动补发(CRDT deterministic merge) |
| 428 缺 base | 重读当前 revision 再带 If-Match 重交 | 无 428 概念(Yjs 无 If-Match) |
| 409 冲突 | **rebase**:读 `currentRevision` → 字段级合并(非重叠各留)→ 重交 | 无 409(CRDT 自合并);但**远端已改写**需刷新视图 |
| 幂等 | `IDEMPOTENCY_KEY_HEADER` + 同 key 同 body 200 既有 / 不同 body 422(`reuse-conflict`) | Y.Update 本身可重复应用(幂等);op 概念在 CRDT 内建(op ID = `(clientID,clock)` 唯一标识) |
| **port 中性容纳** | `ChangeOutcome.kind = 'retryable'`(瞬态,原样重试)/ `'conflict'`(需 rebase,返 currentCursor + diverging)/ `'rejected'`(终态,如 401/403/413/422payload,见 §1 RejectionReason)。 | `ChangeOutcome.kind = 'accepted'`(CRDT 总接受);adapter 可在远端改写时经 `subscribe` push `change(origin=remote)` 让 client 刷新。瞬态(WS 抖动)走 `retryable`;终态(权限撤销等)走 `rejected`。两案共用 accepted/conflict/retryable/rejected 四态。 |

### 2.4 conflict(并发冲突检测/解决)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 检测点 | 服务端(submit 时 If-Match 比对) | 无 submit 期检测(CRDT 总接受) |
| 解决 | 服务端**属性级 LWW**:同节点不同属性各留;同属性后写赢(record-schema §0 revision×LWW 兼容协议见 N2-1) | CRDT 自合并(Y.Text OT 字符级 / Y.Map LWW per key;op ID `(clientID,clock)` 比较,**跨 run 不定**——spike `:350-352`) |
| 文本同编 | **整串 LWW**(现 record schema 把 text 整串当 LWW 叶子 → 两人同编互吞)→ N2-0 hard gate #1 | Y.Text OT(字符级,不互吞) |
| 跨 record 事务 | node-delete + edge、result-node + asset-ref **走严格事务路径**(非 LWW,record-schema / N2-0 §10.4) | CRDT **不保证**跨 record 原子(Yjs 事务是 local sync,跨 record invariant 需 wrapper)——**有证据**:spike `:408-420` revision↔Yjs 双仲裁=必丢数据 |
| **全量 record diff 陷阱** | (Figma 案无此坑:PATCH 是 field-level) | Yjs 案 adapter 若 `writeRecord` clear+rebuild 整 record,会吞并发子字段——**有证据**:spike `:376-398` 坑7 实证 transform.y=999 被整 record 重写吞掉。故 port 改 `edit-*` field-intent 逼 adapter 按 fieldPath 增量 set,不整 record 替换 |
| 多人 undo | 本地 undo 在远端交错语义未定(N2-0 hard gate #2) | Yjs UndoManager 关系 spike 自列未决 |
| Y.Array reorder | (`reorderChildren` #194 已建,显式 order_key + LWW;非 Y.Array) | Yjs 13.6.31 的 Y.Array **无 `move()` 原语**(spike `:355-374` d.ts 实证只有 insert/push/unshift/delete/get/toArray 等),reorder 须 delete+insert;两端并发 reorder 不保证按"移动语义"保序——对 order_key/z-order 是 N2 必须正面处理的设计点 |
| **port 中性容纳** | `submitChange` 返 `conflict { currentCursor, diverging }`;`diverging` 是 `CanvasChange[]`(adapter 决定粒度:Figma 案可返 `edit-*` intents 供 rebase;Yjs 案可返空数组,因 CRDT 已合并)。port 不规定"属性级 LWW"还是"Y.Text OT"——那是 N2-0/N2-1 决议,不在 port 面。 | 同上。port 表"变更可能被远端改写",不表"如何合并"。 |

### 2.5 shadow(本地/影子/服务端三态调和)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 三态模型 | local(用户输入)/ shadow(最后已知服务端态)/ server(真相源)——计划 §1 v4 client 三态 | Y.Doc 本身即 local+server **合并态**(CRDT);三态塌缩为**一态 + awareness** |
| shadow compare | diff(local, shadow) → 最小 PATCH;server 接受后 shadow := local | 无 shadow compare(Y.Doc 已合并);只需广播 diff(Y.Update) |
| 不变量 | shadow ≠ local 时存在未确认变更;shadow 是重连后 rebase 基线 | Y.Doc state 是重连后 sv 补拉的基线;无显式 shadow |
| revision 派生 | per-record revision 是服务端赋值单调整数(envelope 唯一真相,§13.5) | **待 PoC**(非既定事实):spike `:408-420` 立"revision 应是 Yjs 状态派生值(op 计数 / 内容 hash / sv clock),非独立 LWW 计数器"——派生算法未 PoC,N2-0 §11 Q2 改写为"选 Figma 则 revision = 服务端赋值,不适用 Yjs 派生" |
| **port 中性容纳** | port 不暴露三态/shadow compare;adapter 内部维护。Figma 案 adapter 持 shadow 做 diff + rebase(F1 后 diff 已在 producer 侧完成,intents 即 diff 结果,adapter 不再 shadow-diff 全量 record);Yjs 案 adapter 持 Y.Doc 做合并。port 只表"提交 change → 拿回 outcome / cursor"。 | 同上。port 不知 adapter 是三态还是一态。 |

---

## 3. 两案 → port 方法映射(决议后 G1-c 唯一落地参考)

| port 方法 | Figma 案 adapter(N2-0 选 Figma 时) | Yjs 案 adapter(N2-0 选 Yjs 时) |
|---|---|---|
| `loadSnapshot(id, since?)` | `fetchCanvas`(ServerPersistAdapter)+ 可选 `since=contentVersion` 增量;cursor = revision bundle | `GET /snapshot` 拉序列化 Y.Doc + sv 协议补拉;cursor = state-vector(Uint8Array) |
| `submitChange(change, base?)` | `create-*`→POST 全量;`edit-*` intents→field-path PATCH body(fieldPath 段直接对应)+ `If-Match: base→revision`;409→`conflict` outcome;401/403/413/422/400→`rejected`(域 reason) | `create-*` seeding 全量 Y.Map;`edit-*` intents→按 fieldPath 逐层 Y.Map.set(永不 clear 整子树);总 `accepted` outcome |
| `subscribe(id, onEvent)` | SSE/WS 订阅服务端广播合并态 → `change(origin=remote)` + 新 cursor | WS y-protocol peer 广播 → `change(origin=remote)` + 新 cursor;断线 → `gap` 事件 |

**红线再强调**:两案 adapter 都**不**把各自独占形状(field-path PATCH body / Y.Update binary / revision / state-vector)放进 `canvasSyncPort.ts` 的类型定义;只在自己的 adapter 文件(N2-0 决议后、G1-c 落地)内出现。port 侧 `SnapshotCursor` 是 branded `unknown`,adapter 用 `as unknown as SnapshotCursor` 构造,port 侧零 inspection。`FieldPath` 是域语义数组,**非** wire JSON-Pointer——两案 adapter 都能消费(fieldPath 是域语义不是 wire)。

---

## 4. 红线自证(grep)

**自证命令**(在 worktree 根跑):

```bash
# 4.1 port 文件不含 Figma 案独占形状(非注释代码行)
grep -nE 'If-Match|if-match|ConflictBody|metaRevision|contentVersion|"patch"|json.?patch|ops:\s*\[' src/lib/canvasSyncPort.ts
# 期望:命中均在 `//` 注释行(解释红线本身);非注释代码行零命中(port 类型定义/运行时不含这些)。

# 4.2 port 文件不含 Yjs 案独占形状(非注释代码行)
grep -niE 'Y\.Update|Y\.Doc|state-vector|stateVector|y-protocol|Uint8Array' src/lib/canvasSyncPort.ts
# 期望:命中均在 `//` 注释行(解释红线/Yjs 事实);非注释代码行零命中。
# 注:state-vector 在注释里以正确形态(Uint8Array 编码 / Map 解码)出现,纠正旧版 number[] 错误。

# 4.3 port 不暴露裸 Revision number 作游标
grep -nE 'SnapshotCursor\s*=\s*(number|number\[\]|Revision)' src/lib/canvasSyncPort.ts
# 期望:无命中(SnapshotCursor = unknown & { __brand })。

# 4.4 contract test 用 @ts-expect-error 钉死负向断言(若误把独占形状加进 union,directive 失效 → tsc 报错)
grep -cE '^\s*//\s*@ts-expect-error' src/lib/canvasSyncPort.contract.test.ts
# 期望:7(R2 返修后)。
#   - 6 处红线候选独占形状互锁(不变):Y.Update / state-vector array / JSON-Patch kind / 裸 revision / 裸 HTTP 码(RejectionReason)/ RFC6902 op(FieldIntent)。
#   - +1 处 R2-P1-1 空路径 tuple 互锁:空 `[]` fieldPath 不满足非空 tuple `readonly [string|number, ...]`——封死空路径 clobber 表达。
# 注:文件头注释里 prose 提及"@ts-expect-error"不计入 directive,故用 ^\s*//\s*@ts-expect-error 精确匹配 directive 行。
```

**实际跑结果见 §7 回报**。

> 说明:4.1/4.2 的 grep 全量命中均在 `//` / `*` 注释行(解释红线本身 + 纠正后的 Yjs 事实),非注释代码行(port 类型定义 / 运行时)零命中——见 §7 回报的"非注释行过滤"自证。port 本体的类型与实现不含任一候选独占 DTO。

---

## 5. N2-0 接口(N2-0 决策龙头需逐项给两案结果 + 证据 + 成本 + go/no-go hard gate)

本 inventory 喂给 N2-0 的 7 项 hard gate(计划 §8 N2-0 原文),port 不预判任一项:

1. **文本同编**:Figma 整串 LWW(互吞)vs Y.Text OT —— 一票否决项。
2. **多人 undo/redo**:Figma 本地 undo × 远端交错未定 vs Yjs UndoManager spike 未决。
3. **跨 record invariant/事务**:Figma 严格事务路径(record-schema / §10.4)vs Yjs 需 wrapper(CRDT 无原子多 record,spike `:408-420` 实证)。
4. **revision × 属性 LWW 兼容协议**:Figma (A) 改 #194 / (B) versioned ops endpoint;Yjs 不适用(CRDT)。
5. **实时 transport + auth spike**:真实 SSO 网关下 WS upgrade 是否放行。**Figma 式 REST+SSE 走 plain HTTP,网关应透传(条件式,非"必透传";生产可能缓冲/超时 → v4 N2-0 §14.5 失败树 + short-poll fallback),不需 WS**(§2.1 + N2-0 §2 gate 5 + §14.5);**Yjs 需双向 WS y-protocol**(网关 WS 放行=未验证项,留 lead 生产实测)。~~原句"网关必透传"与 N2-0 Gate5 条件式矛盾,已纠(v4 Blocker 6 对齐)。~~
6. **迁移/双协议窗口**:#194 / PG JSONB / FX-5 / stale-client。
7. **事件序号/补拉日志/压缩、权限撤销、性能/存储放大**。

port 的中性设计保证 N2-0 任一决议后,G1-c 只需落一个 adapter,另一模型零死接口。

---

## 6. 本批落地状态

- [x] `src/lib/canvasSyncPort.ts` — port 接口 + 中性游标 + **返修 F1 字段级意图**(create/edit 拆分 + FieldPath/FieldIntent)+ **返修 F3 终态拒绝**(RejectionReason + accepted 权威 ack)+ 占位 fail-visible impl(不接线 transport)。**返修 R2**:FieldPath 非空 tuple + `validateFieldIntent` 域级 validator(封死非原子 set clobber)+ `dependency-failed` reason + submitChange 因果/authoritative-load 契约 doc。
- [x] `src/lib/canvasSyncPort.contract.test.ts` — **7 处 `@ts-expect-error`** 红线自证(6 候选独占形状互锁 + 1 R2-P1-1 空路径 tuple 互锁)+ 接口面正向断言 + **F1 field-intent 无损并发契约**(同 record 不同字段双留 / 未编辑字段不提交 / 嵌套叶子不整树替换 / reorder 有意图 / 数组下标定点)+ **F3 终态拒绝 outcome 映射契约**(401/403/revoke/400/413/422→rejected;409→conflict;5xx/408/429→retryable;200→accepted;无终态误重试/无假成功)+ **R2-P1-1 负例**(空路径/整对象/整数组 set 被拒)+ **A→B/B→A 双向对称** + **R2-P1-2 per-record FIFO 因果参考 impl**(pending create hold edit / create-fail→dependency-failed / 真·unknown→not-found 边界分开)+ **R2-P1-3 delete authoritative-load**(204/404 缺 cursor 不构造 accepted / 经 load 取真实 cursor / load null→rejected) + 占位 reject 运行时验。
- [x] `src/kernel/__spike__/yjs-mapping.spike.test.ts` — **R2-P1-1 真 Y.Doc 验证**(嵌套叶子 set / 数组叶子 set / A↔B 双向对称收敛 / 整对象·整数组 set 被 validator 拒)——复用 spike encode/decode codec,测试在 spike 侧保 yjs 不进生产 bundle。
- [x] 本 inventory 文档(**返修 F2 纠 Yjs 五维事实** + 反映 F1/F3 类型 + **返修 R2**:Y.Map/Y.Array 分开 / 因果契约 / authoritative-load cursor / @ts-expect-error=7 + **返修 R4**:§1 classifier 必填 + structural 低层分层 / §8.2·§9.2 sync submit·ackCreate 段标 R4 supersede / §10 R4 变更段逐项映射两条 finding)。
- [ ] G1-c 实现(N2-0 决议后):落**唯一** adapter,Figma 或 Yjs,另一模型零代码。
- 红线 grep 自证结果:见 §7.5 + §8.4 回报。

---

## 7. 返修回报(G1-b 双审 REQUIRES_CHANGES,2026-07-12)

### 7.1 Finding 1 [P1] 全量 record upsert 无法无损承载字段编辑意图(canvasSyncPort.ts:62)

**问题核证**:旧 `CanvasChange` 只有 `upsert-*`(全量 record),`base?` 可选。adapter 对 shadow diff 全量 record 时,并发下会把远端字段更新误判为本地回滚;Yjs 案 clear+rebuild 整 record 吞并发子字段(spike `yjs-mapping.spike.test.ts:376-398` 坑7 实证 transform.y=999 丢失)。

**修法选择**:**(a) typed field intent**(非 (b))。理由:
1. (a) 从根上消去 shadow-diff 误判:intents 即 diff 结果(producer 侧已 diff),adapter 不再对全量 record 做 shadow-diff。
2. (a) 与 N2-0 §10.1 `FieldOp.fieldPath` 草案对齐(typed field intent 显然更贴合);`FieldPath = (string|number)[]` 是**域语义**(fieldPath 是域语义不是 wire),两案 adapter 都能消费——Figma 案 edit→field-path PATCH body;Yjs 案 edit→嵌套 Y.Map.set(永不 clear 整子树,直接规避坑7)。
3. (b) 保留全量 record + base 必填只补了并发判定的"锚",但**无损承载字段编辑意图**的根本问题没解——adapter 仍要 diff 全量 record 才得 fieldPath,shadow-diff 误判依旧。且 base 必填与"Yjs 案 CRDT 无 base 概念"相悖。
4. 不取 before/after 对:翻倍 payload + 仍需 adapter diff(重陷误判);typed field intent 让 diff 显式在 producer 侧完成。
5. **不违反红线**:fieldPath 是域语义数组,非 RFC 6902 JSON-Pointer 字符串(`/transform/x`)、非 `ops:[...]`——contract test `@ts-expect-error` 钉死 RFC6902 op 形状被拒。

**落地**:`CanvasChange` 拆 `create-*`(全量新 record,无并发覆盖)+ `edit-*`(nodeId + intents: FieldIntent[]);新增 `FieldPath`/`FieldIntent` 类型;`create-*` 才带全量 NodeRecord(edit-* 的 keyof 只有 kind/nodeId/intents,contract test 钉死无 `node` 字段)。

**契约测试清单**(`canvasSyncPort.contract.test.ts` F1 段):
- kind union 闭合(create/edit/delete/reorder/update-meta,无 transport DTO)
- edit-node 只暴露 nodeId + intents(**未编辑字段不被提交**:keyof 钉死无 `node`)
- 同 record 不同字段并发两边都留(transform.x + title 双留,y/fills 不被替换)
- 嵌套叶子 set 不整树替换(transform.y 在 transform.x 编辑后存活——对比 spike 坑7 丢失)
- delete-field 删叶子不删 record(兄弟字段不受影响)
- reorder-children 携 orderedIds(移动意图,非 Y.Array delete+insert)
- 数组下标 fieldPath 定点改单元素(fills[0].color,兄弟元素不受影响)
- 红线:FieldIntent 拒 RFC6902 op(`@ts-expect-error`)

### 7.2 Finding 2 [P1] inventory 的 Yjs 事实错误(canvas-sync-port-inventory.md:73)

**问题核证**:原 §2 五维 Yjs 列有五处事实错:
1. `:73` state-vector 写成 `number[]`——错(实际 encodeStateVector 返 `Uint8Array`,解码态 `Map<clientID,clock>`,见 `encoding.d.ts:14-15,19`)。
2. `:84` "长度 = peer 数"——错(state-vector 是编码字节流,长度由 clientID 数 + clock 大小编码决定,非 peer 数)。
3. `:73` "Yjs 无 per-record revision"——掩盖 K40 revision 硬约束 + Yjs 因果序双真相源坑(spike `:408-420`:revision↔Yjs 双仲裁=必丢数据)。
4. `:168` "两案都需 WS"——与 §2.1 Figma 式 REST+SSE + N2-0 §2 gate 5(plain HTTP)矛盾。
5. 全量 record diff / Y.Array reorder / revision 派生被当成既定事实,实为**待 PoC**。

**修法**:以仓内 yjs spike + `encoding.d.ts` + `shared/persist-contract.ts` 逐行重写 Yjs 五维:
- §2.1 wire:Y.Update = Uint8Array(`encoding.d.ts:9-10`);state-vector 编码态 Uint8Array(`:19`)/ 解码态 Map<clientID,clock>(`:14-15`);每维附文件:行引用。
- §2.2 hydrate:sv 协议两端都是 Uint8Array 字节流(非 number[]);cursor = 编码 Uint8Array / 解码 Map。
- §2.4 conflict:CRDT 自合并 op ID (clientID,clock) 跨 run 不定(spike `:350-352`);跨 record 事务 CRDT 做不到(spike `:408-420` 有证据);全量 record diff 陷阱(spike `:376-398` 坑7 有证据);Y.Array 无 move 原语(spike `:355-374` d.ts 有证据)。
- §2.5 shadow:revision 派生标 **待 PoC**(spike `:408-420` 立场,非定论);N2-0 §11 Q2 改写为选 Figma 则不适用 Yjs 派生。
- §5 item 5:纠"两案都需 WS"→"Figma 式 REST+SSE 不需 WS(plain HTTP);Yjs 需双向 WS(网关放行=未验证)"。
- 全量 record diff / Y.Array reorder / revision 派生 三项标 **有证据/待 PoC** 而非既定事实。

**验收**:五维每格可追溯(附 `encoding.d.ts:行` / `spike:行` / `persist-contract.ts:行` 引用);不再与 K40 revision 硬约束(spike `:408-420`)/ §2.1 Figma REST+SSE 矛盾。

### 7.3 Finding 3 [P2] ChangeOutcome 缺终态拒绝,accepted 确认层级未定义(canvasSyncPort.ts:82)

**问题核证**:旧 `ChangeOutcome` 只有 accepted/conflict/retryable 三态——缺 validation/authz/not-found/413/422 终态;仓内先例 `writeRetryQueue.ts:108-116` 已有 8 态(success/conflict/too-large/unauthorized/reuse-conflict/rejected/transient/terminal)。accepted 未冻结是"本地已应用"还是"服务端权威确认"。

**修法**:
1. 加 `rejected` 终态 outcome:`{ kind: 'rejected'; reason: RejectionReason; detail?: string }`。
2. 新增 `RejectionReason` 域枚举(unauthorized/forbidden/not-found/too-large/reuse-conflict/bad-request/terminal)——**typed,不泄漏 HTTP 码/Yjs frame**(域名而非裸数字;先例同 `writeRetryQueue.WriteOutcome` 用域 status 名)。
3. 冻结 `accepted` = **权威 ack**(服务端真相源已 commit),**非** local-applied;accepted 必携服务端回传 cursor(无 cursor 即无 accepted,防假成功)。乐观 echo 是调用方的事,port 不在 outcome 表 local-applied。
4. 终态拒绝与 retryable 互斥(防终态误重试);瞬态(5xx/408/429)才走 retryable。

**契约测试清单**(`canvasSyncPort.contract.test.ts` F3 段):
- HTTP 401/403/400/413/422 → rejected(对应域 reason),NOT retryable(无终态误重试)
- HTTP 404 非删→rejected(not-found);404 删**不直接 accepted**(R2-P1-3:204/404 均无 cursor,须 authoritative load 取真实 cursor 后才 accepted;缺 cursor 不构造 accepted,防常量冒充)
- HTTP 409 → conflict(返 currentCursor + diverging 供 rebase),NOT retryable
- HTTP 5xx/408/429 → retryable(原样重试)
- HTTP 200 → accepted WITH server cursor(无假成功:accepted 必携 cursor)
- revoke(成员移除)→ submitChange 后 403 → rejected(forbidden),NOT retryable
- 类型级:ChangeOutcome kinds = accepted|conflict|retryable|rejected(rejected 与 retryable 不交)
- 类型级:accepted keyof 只有 kind|cursor(cursor 必填,非 optional)
- 类型级:RejectionReason 闭合域枚举(无 HTTP number/Yjs frame;R2-P1-2 加 'dependency-failed')
- 红线:RejectionReason 拒裸 HTTP 码 401(`@ts-expect-error`)

### 7.4 实跑结果

- `tsc -b` / `eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts` / `vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` 全绿——见 lead 复审可复跑的命令与输出(本 worker 已实跑,§7.5)。

### 7.5 实跑命令与输出摘录

(lead 复审可在此 worktree 复跑:`cd _tmp/worktrees/g1b-port && <cmd>`)

- `npx tsc -b` → exit 0(无类型错)。
- `npx eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts` → exit 0(无 lint 错)。
- `npx vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → 全绿(port contract + yjs spike 两文件无回归)。
- 红线 grep §4.1-§4.4:非注释代码行零命中候选独占 DTO;`@ts-expect-error` directive 计数 = 6(**R2 前**;R2 后见 §8.4)。

---

## 8. 第二轮返修回报(G1-b R2 REQUIRES_CHANGES,2026-07-12,见 REVIEW-FINDINGS-G1B-R2.md)

> 三条 P1 全部 lead 逐条核证。R1(F1/F2/F3)闭合不动;红线 6 处互锁保持(未改 1 字),新增 1 处 R2-P1-1 空路径 tuple 互锁 → 总 7。

### 8.1 R2-P1-1 封死 clobber(canvasSyncPort.ts FieldPath/FieldIntent + validator)

**问题核证**:`FieldPath=ReadonlyArray` 允许 `[]`;`value:unknown` 允许 `{op:'set',fieldPath:['transform'],value:整对象}`——首审 clobber(整子树替换)可重新合法表达(spike 坑7:A 整 transform 重写吞 B 的 transform.y=999 在 field-intent 层的等价攻击面)。数组整值替换(fills)同理吞并发 insert。inventory 统一写"逐层 Y.Map.set"与 spike 真实 codec(对象 Y.Map / 数组 Y.Array)不符。

**修法选择**:**(a) FieldPath 非空 tuple + (b) `validateFieldIntent` 域级 validator 拒非原子 set** + **(c) 数组结构编辑 deferred to N2-0 §10.1**(非补中性 intent)。理由:
1. 非空 tuple `readonly [string|number, ...(string|number)[]]` 编译期拒空路径(空 `[]` 无定位叶子 = 整 record clobber 的合法重表达);+1 `@ts-expect-error` 互锁钉死(总数 6→7,红线 6 不变)。
2. validator 拒 `set` 的非原子 value(对象/数组 = 整子树替换 = 坑7 clobber 的合法重表达)——**封死**;合法编辑须分解为原子叶子 set(`['transform','x']` 非 `['transform']` 整对象)。这是 port 冻结的**域级**规则(transport-neutral),非 transport impl——validator 只检 `typeof value`,无候选独占 DTO,不违红线。
3. 数组三选(补中性 intent / 明确整值 LWW 限制 / reject):选 **reject 整数组 set(同整对象一并封死)+ 数组结构编辑 deferred**。理由:补 insert/remove/splice-by-stable-id 会扩 FieldIntent op 面(且需处理无 id 数组如 markupPoints/parentIds 的 by-id 难题),bleed into N2-0 §10.1 FieldOp 设计——超出 G1-b "freeze + 不扩 op 面、保 6 互锁" 范围。数组**叶子**编辑(`['fills',0,'color']` 原子 set)仍支持;数组**结构**编辑(增/删元素)留 N2-0 §10.1。`delete-field` 删任意非空路径字段(显式移除,非静默 clobber)放行。
4. 不违红线:validator 是域级 `typeof` 检查,不含 If-Match/Y.Update 等候选独占形状;grep §4.1-§4.2 非注释行零命中。

**inventory 分开写 Y.Map/Y.Array**(§2.1 port-中性容纳 Yjs 列):Y.Map(对象字段)逐层 `set` 永不 clear 整子树;Y.Array(数组字段)number 段进下标有**索引漂移**,数组叶子走 `arr.get(i).set('color',...)` 定点;`Y.Array.delete(i)` ≠ JS `delete arr[i]`(后者留 sparse hole)——故域语义须由 Yjs adapter 直译,不经 JS helper 自证。

**落地**:`FieldPath` 改非空 tuple;新增 `validateFieldIntent`/`FieldIntentError`/`FieldIntentViolation`;contract test 6 处 @ts-expect-error 不变 + 1 处空路径互锁;spike 加真 Y.Doc 验证(见 §8.4)。

**验收**(contract + spike):
- NEGATIVE:空路径 `[]` 编译期拒(`@ts-expect-error`)+ 运行时 validator 拒 `empty-field-path`。
- NEGATIVE:`set ['transform']` 整对象被拒(`non-atomic-parent-set`);`set ['fills']` 整数组被拒;`set ['fills',0]` 整元素被拒。
- POSITIVE:原子叶子 set(`['transform','x']`/`['title']`/`['fills',0,'color']`/`['locked']`=false/`['meta','x']`=null)+ `delete-field` 放行。
- SYMMETRY:A→B 与 B→A 收敛同态(非重叠字段交换律)。
- 真 Y.Doc(spike):嵌套叶子 set(transform.x 改后 y 存活,对比坑7 丢 y)+ 数组叶子 set(fills[0].color 改后 fills[1] 存活)+ A↔B 双向交换 update 两端收敛两边都留 + 兄弟叶子存活 + 整对象/整数组 set 被 validator 拒。

### 8.2 R2-P1-2 create→edit 因果(per-record FIFO hold 契约)

**问题核证**:`submitChange` 独立 async,无同 record FIFO/依赖/batch;create 未 ack 时 edit 先到 → Figma REST 404 → 按 F3 规则 rejected(not-found) → 用户"新建即拖动"的改动永久丢。Yjs 本地因果序天然保留 → 两案在 port 语义不等价。并发同 ID create winner 未定义。

**修法选择**:**per-(canvasId,recordId) FIFO hold**(非 batch/dependency-id)。理由:
1. FIFO hold 不扩 API 面(无新参数 / 无 batch id 暴露给调用方),匹配"中性"——`base?` 游标已足以表并发判定,因果序由 port 内部 hold 保证。batch/dependency-id 会给 port 面引入新 wire 概念(batch id / dep graph),违"transport-neutral + 不扩接口"。
2. 两案 adapter 都可实现:Figma 案同 record 串行 PATCH + hold(create ack 前 hold edit);Yjs 案 Y.Doc 本地因果序天然保(create 的 Y.Map.set 与后续叶子 set 同事务/同因果链,无 404 概念)。
3. 边界分开:pending-local-create 的 edit **不**走 rejected(not-found)——经 FIFO hold,create ack 后 flush;真·不存在 record(从未创建/已被他端删)的 edit 仍 rejected(not-found)——两边界分开断言。
4. create 终态失败(create rejected/conflict/retryable 中的 rejected)→ 依赖 edit surface 为 rejected(**dependency-failed**,新增 RejectionReason)——非 not-found(record 不是"不存在"而是"创建失败"),非重试(重试须先修 create)。

> **⚠ 已被 R4-P1-2 supersede(2026-07-12,见 §10.2)**:以下「落地」+「验收」段使用的 sync `ackCreate flush` / `ackCreate 后 transport 见 [create, edit]` 参考 impl 已被 R4-P1-2 改写为 async `submitChange(canvasId, change, base?)` 状态机(in-flight duplicate 直送 transport / awaiting-retry 经公开入口 retry / 终态才 settle held;删 `ackCreate` 不再重发旧 create)。本段保留作 R2-P1-2 历史回报,不再作为可执行契约;当前态见 §10.2 + §1 submitChange 签名。

**落地**(已被 R4-P1-2 supersede):submitChange doc 冻结 FIFO 契约;`RejectionReason` 加 `dependency-failed`;contract test 加 `FifoRecordPort` 参考 impl(transport 决定 create outcome,port hold 同 record edit/delete,ackCreate flush)。

**验收**(已被 R4-P1-2 supersede,contract 参考 impl):
- edit 在 create pending 时被 HELD(transport 未见 edit);ackCreate 后 transport 见 [create, edit](create 先,edit 后);edit outcome accepted(非 not-found)。
- create rejectCreates → 依赖 edit rejected(dependency-failed),非 not-found;edit 未进 transport。
- 真·unknown record edit(无 pending create)→ rejected(not-found) 直送 transport(边界分开)。
- 多条 held edit 按 submit 序 flush(FIFO,同对象引用 `toBe` 证)。
- 异 record edit 不被无关 pending create hold(per-record 非全局)。

### 8.3 R2-P1-3 404-delete cursor(authoritative load 方案)

**问题核证**:真实 DELETE 成功 204(null body)/已删 404 均不带 cursor/seq(`server/routes/canvas.ts:524-541` deleteChild lead 核证);测试 helper 用常量 `CURSOR` 冒充权威 accepted。404 还可能是 canvas 不存在/无权(`server/lib/authz.ts` `denyStatus` 返 404 隐藏存在性)。

**修法选择**:**② 404/204 后做 authoritative loadSnapshot 取真实 cursor + 确认目标态再 accepted**(非 ① DELETE 契约带 seq / 非 ③ 降级 rejected 或 noop)。理由:
1. ② 用现有 port 方法(loadSnapshot),**今天可实现**(当前 route 204/404 无 cursor,② 不要求改 route);① 需 route 返回 seq,属 n20-fix worker 的 §10 领域(本 worker 不碰 route/§10 文档);③ rejected(not-found)误导(删除达成了目标态却报失败)/ noop outcome 扩 ChangeOutcome 面。
2. ② 保 F3 不变量"accepted 必携服务端权威 cursor":缺 cursor 的 204/404 **不**构造 accepted(防常量冒充);经 loadSnapshot 取真实 cursor 后才 accepted(幂等 delete:load 确认 record 不在 → accepted 携真实 cursor)。
3. ② 正确处理 404 歧义:load 返 null(canvas 不存在/无权,denyStatus 404)→ rejected(forbidden),不误报成功;load 见 record 仍在(并发重建 race)→ conflict。
4. 不向 n20-fix worker 的 §10 提契约要求(只有选 ① 才需标 G1-c/N2-1 契约;选 ② 无需)。未来若 G1-c/N2-1 让 DELETE 返回 seq,adapter 可省去此次 load(优化项,非本 freeze 范围)。

**落地**:contract test 删 `404-delete→accepted(常量 CURSOR)` 冒充;改 `mapDeleteOutcome(status, loadResult)`——缺 cursor 的 204/404 不构造 accepted;经 load 取真实 cursor 后 accepted;load null→rejected(forbidden);load 见 record 在→conflict。submitChange doc 冻结 authoritative-load 契约。

**验收**(contract):
- 204/404 delete **无** authoritative cursor → NOT accepted(无法冒充)。
- 204 + load cursor → accepted(REAL loaded cursor,非常量)。
- 幂等 404 + load 确认 record 不在 → accepted(真实 cursor,delete-vs-update delete wins)。
- 404 + load null(canvas 不存在/无权)→ rejected(forbidden),不误报成功。
- 404 + load 见 record 仍在 → conflict(race)。
- 真实 route `canvas.ts` deleteChild 未改(204 null / 404 无 cursor 事实保留);N2-0 §10 文档未碰(n20-fix worker 管)。

### 8.4 实跑结果(R2)

(lead 复审可在此 worktree 复跑:`cd _tmp/worktrees/g1b-port && <cmd>`)

- `npx tsc -b` → No errors found(exit 0)。
- `npx eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → No issues found(exit 0)。
- `npx vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → PASS (73) FAIL (0)(50 contract + 23 spike,含 R2 新增 5 例真 Y.Doc + 负例/对称/因果/delete-load)。
- 红线 grep §4.1-§4.4:非注释代码行零命中候选独占 DTO(§4.1/§4.2 全命中均在 `//`/`*` 注释行);`@ts-expect-error` directive 计数 = **7**(6 红线候选独占形状互锁不变 + 1 R2-P1-1 空路径 tuple 互锁)。
- transport-neutral 自证:port 文件不含 If-Match/ConflictBody/metaRevision/contentVersion/JSON-Patch/Y.Update/Y.Doc/state-vector/Uint8Array 的非注释代码行(全在注释解释红线)。

---

## 9. 第三轮返修回报(G1-b R3 REQUIRES_CHANGES,2026-07-12,见 REVIEW-FINDINGS-G1B-R3.md)

> 三条 P1(lead+sol7 共识)。R1/R2 闭合项不动:FieldPath 非空 tuple / 整对象·整数组 set 负例 / A↔B 真 Y.Doc 收敛 / 红线 0 候选独占 DTO / `@ts-expect-error`=7(6 红线 + 1 R2 空路径 tuple)——一字不回退。

### 9.1 R3-P1-1 schema-aware 容器/数组元素封死(delete-field + 原子值-to-容器)

**问题核证**:R2 validator 只拦 `set` 非原子 value;delete-field 全放行——`delete ['transform']`(删整个 transform Y.Map = 吞并发 transform.y,clobber 换名重表达)、`delete ['fills']`(删整个 Y.Array)、`delete ['fills',0]`(用不稳定 index 表达声称 deferred 的数组 remove,与 n20 §10.1 by-stable-id 方向岔开)均放行;`set ['transform']=7`(原子值覆盖整个容器路径 = 整子树替换,坑7 的另一换名面)也放行。spike helper 数值末段直 `Y.Array.delete(index)`。

> **⚠ 部分已被 R4-P1-1 supersede(2026-07-12,见 §10.1)**:本「修法选择」把 `FieldSchemaClassifier` 设为**可选**("不传时只结构性拒"),导致省略 classifier 时 `delete ['transform']`/`['fills']`/`set ['transform']=7` 等四负例原漏洞原样通过(安全入口静默降级)。R4-P1-1 已把 classifier 改为**必填**(安全入口不可静默降级:省略即 tsc error + 运行时防御兜 as-cast 旁路)+ 结构性校验拆到显式命名的低层 `validateFieldIntentStructural`(非安全入口)。本段保留作 R3-P1-1 历史回报;当前态见 §10.1 + §1 签名。下方理由 1/2 的结构性拒与 schema-aware 拒语义仍有效,仅 classifier 从可选变必填。

**修法选择**(可选 classifier 已被 R4-P1-1 改必填 supersede):**schema-aware leaf/container/array-element 分类**(可选 `FieldSchemaClassifier`,port 对 schema 不透明故 classifier 由调用方/adapter 提供;不传时只结构性拒)。理由:
1. 结构性拒(无需 schema):数组元素 delete-field(last segment 是 number)→ 拒 `array-element-structure-delete`(by-stable-id deferred to N2-0 §10.1,无需 schema 判)。
2. schema-aware 拒(有 classifier):container 路径上的 `delete-field` → 拒 `container-delete-field`(整子树删 = clobber 重表达);container/array-element 路径上的 `set`(原子值)→ 拒 `atomic-value-to-container-path`(整子树替换)。
3. 合法 optional leaf delete 放行(`delete ['title']`/`['locked']`——删叶子不吞兄弟字段);原子叶子 set 在 leaf 路径放行(`['transform','x']`/`['fills',0,'color']`)。
4. 不扩 op 面、不违红线:`FieldPathTarget`/`FieldSchemaClassifier` 是域类型(非候选独占 DTO);`FieldIntentViolation` 枚举 2→5 key;`@ts-expect-error`=7 不变。

**与 n20 §10.1 对齐点**(inventory §2.1 已注明 + 本 §9.1 再钉):数组结构编辑(增/删元素)非 FieldIntent 表达,deferred to N2-0 §10.1 by-stable-id(与 n20 R2-4「数组按 有 stable-id / 无 stable-id / primitive 三类冻结意图」方向对齐);G1-b 只拒(封死 clobber 换名面),不扩 op 面,N2-0 决议后由真 schema 驱动 classifier。

**落地**(可选 classify 参数已被 R4-P1-1 改必填 + 拆 structural 低层 supersede,见 §10.1):`validateFieldIntent` 加可选 `classify` 参数;新增 `FieldPathTarget`/`FieldSchemaClassifier` 类型;`FieldIntentViolation` 枚举扩 5 key;contract test +7 负例/正例(无 classifier 结构性拒 + 有 classifier schema-aware 拒 + 合法 leaf 放行);spike +3 真 Y.Doc 并发危害证(delete 整 transform 吞 transform.y=999 / delete fills[0] 按 index 删错元素 / validator 拒之有据)。

**验收**(contract + spike):
- NEGATIVE:`delete ['transform']`/`['fills']`(container)被拒 `container-delete-field`;`delete ['fills',0]`(array-element)被拒 `array-element-structure-delete`;`set ['transform']=7`/`['fills',0]=7`(原子值-to-容器)被拒 `atomic-value-to-container-path`。
- POSITIVE:`delete ['title']`/`['locked']`(optional leaf)放行;`set ['transform','x']`/`['fills',0,'color']`(leaf)放行。
- 无 classifier:结构性拒数组元素 delete-field + 非原子 set;container delete 不拒(契约:调用方传 classifier 才做 schema-aware 拒)。
- 真 Y.Doc(spike):delete 整 transform Y.Map 吞并发 transform.y=999(危害证,validator 拒之有据);delete fills[0] 按 index 删在并发 insert 下删错元素(by-index 漂移,by-stable-id deferred 之据)。

### 9.2 R3-P1-2 retryable/conflict 所有权 + per-key 状态机(FifoRecordPort 参考 impl)

> **⚠ 以下「问题核证」描述的 R3 旧 sync `submit`/`ackCreate` 参考 impl bug(`FifoRecordPort.ackCreate` 把 conflict/retryable 统一 dependency-failed、单槽覆盖、`submit(c)` 无 canvasId)已被 R4-P1-2 改 async `submitChange` 状态机解决(删 `ackCreate`、per-key Map、caller 经公开入口 retry/rebase)。本段保留作 R3-P1-2 历史问题回报;当前态见 §10.2。**

**问题核证**(描述的是 R3 时 sync ackCreate 参考 impl 的 bug,已被 R4-P1-2 解决,见 §10.2):doc(canvasSyncPort.ts submitChange doc)说 create conflict/retryable 时 held edits 继续等收敛;参考 impl `FifoRecordPort.ackCreate` 把所有 non-accepted(含 conflict/retryable)统一 dependency-failed + 清队列——与 doc 矛盾(conflict/retryable 时 held 被错误清空,edit 丢)。单槽 `pendingCreate`/`pendingRid`(非 per-(canvasId,recordId) Map),并发第二 create 覆盖第一(第一的 held 丢或被直送 404)。`submit(c)` 无 canvasId,异 canvas 同 recordId 碰撞。缺测试:retryable/conflict、同 ID 双 create、异 canvas 同 recordId、多 pending、最终 record state 断言。

> **⚠ 部分已被 R4-P1-2 supersede(2026-07-12,见 §10.2)**:本「修法选择」+「落地」+「验收」段使用的 sync `submit(canvasId, c)` / `ackCreate(canvasId, rid)` 参考 impl 接口已被 R4-P1-2 改写为 async `submitChange(canvasId, change, base?)` 状态机(删 `ackCreate` 不再重发旧 create;caller 经公开入口交新 change/base 推进 pending entry;in-flight duplicate 直送 transport;awaiting-retry retry 经公开入口;终态才 settle held)。本段保留作 R3-P1-2 历史回报,不再作为可执行契约。下方理由 1(所有权冻结)、2(per-key Map)、3(create race 直送)的语义仍有效,仅 sync submit/ackCreate 接口签名被 async submitChange 取代;当前态见 §10.2 + §1 submitChange 签名。

**修法选择**(sync submit/ackCreate 接口已被 R4-P1-2 改 async submitChange supersede):**per-(canvasId,recordId) Map 状态机 + 仅终态 rejected 才 dependency-failed**(conflict/retryable 非终态 → held 继续等,不清队列)。理由:
1. 所有权冻结:caller 拿到 create 的 conflict/retryable outcome 后 **owns** retry/rebase——adapter **不**自动重试 create(自动重试会与 caller rebase 意图冲突);held edits 的 outcome 在 create 终态收敛后才 settle(accepted→flush / rejected→dependency-failed)。这是 doc 已有语义("create conflict/retryable 时 held edits 继续等 create 收敛")的 impl 补齐。
2. per-key Map:`pending = Map<key, {create, held[]}>`,`key = ${canvasId}::${rid}`——并发第二 create(不同 rid)各自 pending 不 clobber;异 canvas 同 recordId 不碰撞。`submit(canvasId, c)`/`ackCreate(canvasId, rid)` 带 canvasId。
3. 同 (canvas,rid) 待定 create 期间再来 create = create race:port 直送 transport(likely reuse-conflict 422),**不** clobber 第一个 pending 的 held。
4. 仅终态 rejected → dependency-failed + 清 key(非 not-found);conflict/retryable → `held: []`(尚未 settle),key 保留,caller 可再次 ackCreate(create 经重试终态收敛后 held 才 settle)。

**落地**(sync submit/ackCreate 接口已被 R4-P1-2 改 async submitChange supersede,见 §10.2):`FifoRecordPort` 改 per-key Map;`makeTransport` 加 `createOutcomes` 序列(建模 conflict→accept / retryable→accept 收敛);`submit`/`ackCreate` 带 canvasId;contract test 5 原 R2 测试签名更新 + 8 新矩阵测试。submitChange doc 加 R3-P1-2 所有权冻结段。

**验收**(sync submit/ackCreate 矩阵已被 R4-P1-2 async submitChange 矩阵 supersede,见 §10.2;contract 矩阵):
- NEGATIVE:create conflict → held **不**清(`held: []`,非 dependency-failed);caller rebase 后再次 ackCreate → accepted → held flush(非丢)。
- NEGATIVE:create retryable 跨多次重试 held 持续等(不清队列、不 dependency-fail);收敛 accepted 后 held flush;retryable→终态 rejected 时 held 才 dependency-failed(所有权:caller 放弃重试)。
- NEGATIVE:并发第二 create(不同 rid)不 clobber 第一 pending 的 held(edit-n20 在 n21 create 后仍 held,n20 ack 后 flush accepted)。
- NEGATIVE:异 canvas 同 recordId 不碰撞(CV/nX 与 CV2/nX 各自 pending,各自 ack 后 edit flush)。
- POSITIVE:多 pending(不同 rid)独立 FIFO flush;duplicate create(同 key)直送 transport reuse-conflict 不 clobber 第一 pending;终态 record state 断言(create + edit 叠加,非仅 transport log)。

### 9.3 R3-P1-3 delete race 全封 + 旧 shortcut 删除

**问题核证**:R2 `mapDeleteOutcome` 只挡 `404 + recordPresent`→conflict;`204 + recordPresent`(204 后 load 又见 record = 并发重建 race)落最后 `return accepted` → 假成功。旧 `mapHttpStatusToOutcome` 的 `isDelete+404→accepted(常量 CURSOR)` shortcut 分支仍在(与 R2 authoritative-load 方案矛盾)。conflict 的 `diverging:[]` 恢复责任未冻结。

**修法选择**:**204/404 + recordPresent 一律 conflict + 删旧 shortcut + 冲突恢复责任在 caller**。理由:
1. 一律 `recordPresent→conflict`(无论 204 还是 404):delete 目标态未达成(record 被并发重建)→ conflict,不假 accepted(防 204 race 假成功,与 404 race 同处理)。
2. 删 `mapHttpStatusToOutcome` 的 `isDelete` 参数 + `isDelete+404→accepted` 分支(delete 路径走 `mapDeleteOutcome`,authoritative load 取真实 cursor;此 helper 只表非 delete 的 HTTP→outcome 映射)。
3. 冲突恢复责任在 **caller**(据 conflict 重删 or load/rebase 后再决策)——adapter **不**自动重删(自动重删会与 caller rebase 意图冲突);"重建后重删收敛"路径(delete race conflict → caller 重删 → load 确认 record 不在 → accepted)由 caller 驱动。

**落地**:`mapDeleteOutcome` 改 `if (load.recordPresent) → conflict`(不限 404);`mapHttpStatusToOutcome` 删 `isDelete` 参数 + 404→rejected(not-found);contract test +2(204+present→conflict 防旧 bug、重建后重删收敛)。submitChange doc 加 R3-P1-3 段。

**验收**(contract):
- NEGATIVE:204 + load recordPresent → conflict(非 accepted,防旧 bug:旧 204+present 落 accepted 假成功)。
- POSITIVE:重建后重删收敛——race conflict → caller 重删 → 204 + load 确认不在 → accepted(真实 load cursor)。
- 旧 shortcut(`isDelete+404→accepted`)已删(`mapHttpStatusToOutcome` 无 isDelete 参数,404→rejected)。

### 9.4 实跑结果(R3)

(lead 复审可在此 worktree 复跑:`cd _tmp/worktrees/g1b-port && <cmd>`)

- `npx tsc -b` → No errors found(exit 0)。
- `npx eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → No issues found(exit 0)。
- `npx vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → PASS (95) FAIL (0)(含 R3 新增:R3-P1-1 +7 contract + 3 spike / R3-P1-2 +8 矩阵 / R3-P1-3 +2)。
- 红线 grep §4.1-§4.4:非注释代码行零命中候选独占 DTO;`@ts-expect-error` directive 计数 = **7**(6 红线候选独占形状互锁不变 + 1 R2-P1-1 空路径 tuple 互锁,R3 不新增互锁)。
- 通过项不回退:FieldPath 非空 tuple / 整对象·整数组 set 负例 / A↔B 真 Y.Doc 收敛 / 红线 0 候选独占 DTO / directive=7——R3 一字未动。

---

## 10. 第四轮返修回报(G1-b R4 REQUIRES_CHANGES,2026-07-12,见 REVIEW-FINDINGS-G1B-R4.md;R5 复审代码通过,仅 inventory 同步阻断)

> 两条 P1(lead 复审判决)。R1/R2/R3 闭合项不动:FieldPath 非空 tuple / 整对象·整数组 set 负例 / A↔B 真 Y.Doc 收敛 / 红线 0 候选独占 DTO / `@ts-expect-error`=7——一字不回退。
> **R4 supersede 范围**:R3-P1-1 的「可选 classifier」契约(§9.1 修法/落地)与 R3-P1-2 / R2-P1-2 的 sync `submit`/`ackCreate` 参考 impl(§9.2 / §8.2 落地/验收)已被 R4 改写——当前态以本 §10 + §1 签名为准;旧 R2/R3 段保留作历史回报,不再作为可执行契约。
> **本轮提交**:`a4da409`(R4-P1-1 classifier 必填 + structural 拆分)+ `8789903`(R4-P1-2 async submitChange 状态机 + 删 ackCreate),均在 `src/lib/canvasSyncPort.ts` 及契约测试内;inventory 同步在本文件 §1 + 本 §10(本轮文档 commit)。

### 10.1 R4-P1-1 schema classifier 必填(安全入口不可静默降级)

**问题核证**:R3 把 `FieldSchemaClassifier` 设为可选("不传时只结构性拒"),导致省略 classifier 时 `delete ['transform']`/`['fills']`/`['fills',0]`/`set ['transform']=7` 四负例原漏洞原样通过(旧测试甚至钉死 `not.toThrow`)。安全入口静默降级到无 schema 校验,是 R3-P1-1 的核心残留洞。

**修法选择**:**classifier 必填 + structural 拆到低层显式命名函数**(非保留可选 + 文档警告)。理由:
1. 必填 = 编译期省略即 tsc error(类型签名 `classify: FieldSchemaClassifier` 非可选)+ 运行时防御兜 `as` cast 旁路(非函数 classifier → 显式抛 `validateFieldIntent: schema classifier is required`)。双重不可绕过,安全入口永不静默降级。
2. 结构性校验(空路径 / 非原子 set / 数组元素 delete-field——均无需 schema)拆到显式命名的低层 `validateFieldIntentStructural`,供调用方明示"只要结构性校验"时使用;此函数**非安全入口**,不拒 schema-aware clobber(container/array-element 路径上 leaf op)。
3. 安全入口 `validateFieldIntent(intent, classify)` = 先过 `validateFieldIntentStructural`,再以必填 classifier 拒 container/array-element 路径上的 leaf op(`set` 原子值 → `atomic-value-to-container-path`;`delete-field` 到 container → `container-delete-field`)。四负例经安全入口(任何合法公开调用 = 带 classifier)必拒。
4. 不扩 op 面、不违红线:`FieldSchemaClassifier`/`FieldPathTarget` 仍是域类型(非候选独占 DTO);`FieldIntentViolation` 枚举 5 key 不变;`@ts-expect-error` directive 仍恰 7(未增减)。

**契约变化映射**(R3-P1-1 → R4-P1-1,对应提交 `a4da409`):
- §1 `FieldSchemaClassifier` 注释:"可选"→"必填(安全入口)"。
- §1 `validateFieldIntent(intent, classify?)` → `validateFieldIntent(intent, classify: FieldSchemaClassifier)`(classifier 必填)。
- §1 新增 `validateFieldIntentStructural(intent)` 低层函数(结构性校验,**非安全入口**,不拒 schema-aware clobber)。
- §9.1 修法选择/落地里的"可选 classifier"表述:已被本节 supersede,当前态 classifier 必填。

**验收**(contract test R4-P1-1 段 + 独立对抗实测,R5 步骤 5-6):
- NEGATIVE:四负例(`delete ['transform']`/`['fills']`/`['fills',0]`/`set ['transform']=7`)经安全入口(带 classifier)全拒;传 `undefined` 绕过 classifier 显式抛错。
- POSITIVE:optional leaf delete(`delete ['title']`)、array leaf set(`set ['fills',0,'color']`)放行。
- structural 低层:拒空路径/非原子 set/数组元素 delete-field,但**不拒** schema-aware clobber(明示非安全入口)。
- 红线:`@ts-expect-error` directive 仍恰 7(未增减)。
- 独立对抗实测:`vite-node` 直调公开 validator(不复用 Vitest 断言),四 clobber 形态全抛 `FieldIntentError`;合法 leaf 放行。

### 10.2 R4-P1-2 caller-owned retry/rebase 经公开 async submitChange 闭环

**问题核证**:R3 的 `FifoRecordPort` sync `submit`/`ackCreate` 重发**旧** entry.create(adapter 自动重试 stale create),无 caller 提交 rebased create/new base 接管 pending entry 的路径;conflict→accepted 测试靠预编排 `createOutcomes` 队列假收敛。caller-owned retry/rebase 语义未真正闭环。

**修法选择**:**改 FifoRecordPort 为 async `submitChange(canvasId, change, base?)` 同形参考**(非保留 sync submit/ackCreate + 文档警告)。理由:
1. 公开入口同形:参考 port 与 `CanvasSyncPort.submitChange` 同形为 async `submitChange(canvasId, change, base?)`,caller 经此**唯一**入口推进 pending entry(retry)或并发提交(duplicate)——不再有 sync `ackCreate` 重发旧 create 的旁路。
2. phase 区分:`in-flight`(create 已交 transport 待 outcome)期间,同 key 并发 create = **duplicate**,直送 transport(likely reuse-conflict),**不** clobber 第一 pending 的 held;`awaiting-retry`(create 拿到 conflict/retryable,caller owns retry/rebase)期间,caller 再次经公开 `submitChange` 交**新** change/base 推进原 pending entry(retry,非新 pending)。
3. base 透传 transport 区分 old/new base:旧 base 仍 conflict、新 base 才 accepted——caller 提交 rebased create/new base 经同一 `change` 参数接管 pending entry(`base` 参数表并发判定锚点;即任务口径 `submitChange(canvasId, retriedOrRebasedCreate, base?)`,`retriedOrRebasedCreate` 是 caller retry/rebase 时 `change` 参数的语义角色)。
4. held edit settle 时机:held edit 在 create **终态**(accepted→flush / rejected→dependency-failed)才 settle;conflict/retryable(非终态)held 继续等,不清队列(adapter 不自动重试 create,与 R3-P1-2 所有权冻结一致)。
5. 删 `ackCreate`:不再重发旧 create;caller-owned retry/rebase 经公开 `submitChange` 闭环。

**契约变化映射**(R3-P1-2 / R2-P1-2 → R4-P1-2,对应提交 `8789903`):
- §1 `submitChange` 签名:本就 async(`Promise<ChangeOutcome>`),R4 让参考 impl 与之同形,删 sync `ackCreate` 旁路。
- §8.2 落地/验收里的 `ackCreate flush` / `ackCreate 后 transport 见 [create, edit]` / `rejectCreates` 表述:已被本节 supersede,当前态为 async `submitChange` 状态机(in-flight duplicate / awaiting-retry retry / 终态 settle held)。
- §9.2 修法选择/落地/验收里的 `submit(canvasId, c)` / `ackCreate(canvasId, rid)` / `再次 ackCreate` 表述:已被本节 supersede,同上。

**验收**(contract test R4-P1-2 段,13 项矩阵,R5 步骤 7):
- NEGATIVE:in-flight 期间同 key duplicate create 直送 transport(likely reuse-conflict),不 clobber 第一 pending 的 held。
- NEGATIVE:awaiting-retry 期间 caller 经公开 `submitChange` 交新 change/base 推进原 pending entry(非新 pending);旧 base 仍 conflict、新 base 才 accepted。
- NEGATIVE:create retryable 跨多次重试 held 持续等(不清队列、不 dependency-fail);收敛 accepted 后 held flush;retryable→终态 rejected 时 held 才 dependency-failed(所有权:caller 放弃重试)。
- POSITIVE:多 pending(不同 rid)独立 FIFO flush;终态 record state 断言(create + edit 叠加,非仅 transport log)。
- 公开入口同形:参考 port `submitChange(canvasId, change, base?)` 与 `CanvasSyncPort.submitChange` 签名一致。

### 10.3 实跑结果(R4 + R5 复审)

(lead 复审可在此 worktree 复跑:`cd _tmp/worktrees/g1b-port && <cmd>`)

- `npx vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → 2 files passed;**100 tests passed、0 failed**(R4-P1-1 段 5 tests + R4-P1-2 段 13 tests,含 R1/R2/R3 全部不回退)。
- `npx tsc -b` / `npm run build` → exit 0(2925 modules transformed;classifier 必填签名 + FieldPath 非空 tuple + 全部类型红线通过 TS 校验)。
- `npx eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts` / `npm run lint` → exit 0(无 lint 回退)。
- 红线 grep §4.1-§4.4:非注释代码行零命中候选独占 DTO;`@ts-expect-error` directive 恰 **7**(6 红线候选独占形状互锁 + 1 R2-P1-1 空路径 tuple 互锁,R4 不新增互锁)。
- 独立对抗实测(R5 步骤 5):`vite-node` 直调公开 validator,四 clobber 形态全抛 `FieldIntentError`;传 `undefined` 绕过 classifier 显式抛错;合法 leaf(`delete ['title']` / `set ['fills',0,'color']`)放行。
- inventory 同步(本轮文档 commit):§1 签名改 classifier 必填 + 新增 `validateFieldIntentStructural` 低层;§8.2/§9.1/§9.2 旧 sync `submit`/`ackCreate` 或可选 classifier 段标 R4 supersede;本 §10 逐项映射两条 R4 finding → 契约变化。`rg -n "ackCreate" docs/decisions/canvas-sync-port-inventory.md` 命中均在明确标注的 R2/R3 历史/已废弃说明里(§8.2/§9.2,均带 supersede 标注)。

---

## 11. v4 决议收口(对齐 N2-0 §14;sol 第三轮 6 阻断交叉影响)

> N2-0 v4 决议(§14)对 port 契约的交叉影响 + 两文档同规则对齐。

### 11.1 Blocker 2 — container 整替换白名单(两文档同规则,提案供再审)

- **统一规则**:container set 一般禁止(G1-b port `validateFieldIntent` 拒 `non-atomic-parent-set`);**显式原子容器白名单 `['transform', 'relations']` 允许整替换**(原子容器 = 整对象作单位,非逐字段 merge)。
- **N2-0 侧**:DomainOp `set ['transform'] = {x,y}` 允许(白名单);server `validateChildPayload` 用 `RecordKindSchema` classifier 判 container + 查白名单放行。
- **port 侧(G1-b)**:当前 `validateFieldIntent` 拒所有 container set(R4,无白名单);**v4 提案**:classifier 返回 `'atomic-container'`(白名单 transform/relations)时放行 set 整对象。**这是 A2 实装时的 port validator 演进项,提案供 lead 再审**(本 freeze 不改 validator 行为,保 `@ts-expect-error`=7 + seam reject 现状;spike `ATOMIC_CONTAINER_WHITELIST` + S10-14 已演示提案方向)。
- **不许两套并存**:N2-0 决议 §10.1 + 本 inventory §1 同规则(transform/relations 白名单),见 `src/kernel/__spike__/n20-truth-source.spike.test.ts` `ATOMIC_CONTAINER_WHITELIST` + S10-14。

### 11.2 Blocker 6 — 两文档交叉契约(port CanvasChange ↔ N20 CreateBody/DomainOp 无损映射)

- **交叉契约测试**:`src/kernel/__spike__/n20-truth-source.spike.test.ts` X-1~X-4(import port `CanvasChange`/`FieldIntent` ↔ N20 `CreateBody`/`DomainOp`/`ServerInvariantCommand`):
  - X-1 `create-node`(NodeRecord 含 id)→ N20 `CreateBody`(payload=NodePayload 无 id;id → adapter path;Blocker 2 client-id)
  - X-2 `edit-node` FieldIntent[] → N20 DomainOp set/unset[](fieldPath + value 透传无损)
  - X-3 `delete-node` → N20 `ServerInvariantCommand` node-delete-cascade(Blocker 3 server-named)
  - X-4 `reorder-children` → N20 DomainOp reorder(orderedIds 透传)
- **两文档形状一致**:port CanvasChange 与 N20 wire 无损可映射,adapter 翻译零丢失。

### 11.3 Blocker 6 — 网关条件式对齐(§5 item 5 已纠)

- §5 item 5 "网关必透传" → "网关应透传(条件式,非必透传;生产可能缓冲/超时 → N2-0 §14.5 失败树 + short-poll fallback)"。与 N2-0 §2 Gate5 + §14.5 一致。

### 11.4 Blocker 2 — create client-id 对齐(canvasSyncPort create-node 已携 id)

- port `CanvasChange.create-node` 携 `NodeRecord`(含 id);N2-0 v4 `CreateBody` id = client `NodeRecord.id`(废除 server-mint)。两文档一致:create id 来自 client(adapter 提取进 path),非 server-mint。见 X-1 交叉契约。

### 11.5 Blocker 2 — 对齐 G1-b R4(决议原写 R2 已纠)

- N2-0 §13 改 "G1-b R2" → "G1-b R4"(冻结源已到 R4:classifier 必填 + structural 拆分 + async submitChange caller-owned retry/rebase 状态机)。port 当前态 = R4(§10 已述),两文档对齐 R4。
