# 画布 transport-neutral port + 两案契约 inventory(G1-b)

> 状态:**契约冻结 + inventory,不实现 transport**(G1-b,N2-0 决议前)。
> 日期:2026-07-12(返修版:纠 Yjs 五维事实错误 + 反映 F1 字段级意图 + F3 终态拒绝)。
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
type FieldPath = ReadonlyArray<string | number>                     // 域语义路径,非 RFC6902 JSON-Pointer
type FieldIntent =
  | { op: 'set'; fieldPath: FieldPath; value: unknown }
  | { op: 'delete-field'; fieldPath: FieldPath }

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
type RejectionReason =
  | 'unauthorized' | 'forbidden' | 'not-found' | 'too-large'
  | 'reuse-conflict' | 'bad-request' | 'terminal'   // 域名,不漏 HTTP 码/Yjs frame

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
| **port 中性容纳** | `submitChange(change, base?)` → adapter 把 `edit-*` intents 翻成 field-path PATCH body(fieldPath 段直接对应,**无需 diff**)+ `If-Match: base→revision`;`create-*` → POST 全量。 | `submitChange(change, base?)` → adapter 把 `edit-*` intents 按 fieldPath 逐层 Y.Map.set 嵌套叶子(**永不 clear 整 record**,避坑7);`create-*` seeding 全量 Y.Map。`base` 不用于 If-Match(CRDT 无 base 概念,可忽略)。 |

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
# 期望:6(6 处负向互锁 directive:Y.Update / state-vector array / JSON-Patch kind / 裸 revision / 裸 HTTP 码(RejectionReason)/ RFC6902 op(FieldIntent))。
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
5. **实时 transport + auth spike**:真实 SSO 网关下 WS upgrade 是否放行。**Figma 式 REST+SSE 走 plain HTTP,网关必透传,不需 WS**(§2.1 + N2-0 §2 gate 5);**Yjs 需双向 WS y-protocol**(网关 WS 放行=未验证项,留 lead 生产实测)。~~原句"两案都需 WS"与 §2.1 Figma 式 REST+SSE 矛盾,已纠。~~
6. **迁移/双协议窗口**:#194 / PG JSONB / FX-5 / stale-client。
7. **事件序号/补拉日志/压缩、权限撤销、性能/存储放大**。

port 的中性设计保证 N2-0 任一决议后,G1-c 只需落一个 adapter,另一模型零死接口。

---

## 6. 本批落地状态

- [x] `src/lib/canvasSyncPort.ts` — port 接口 + 中性游标 + **返修 F1 字段级意图**(create/edit 拆分 + FieldPath/FieldIntent)+ **返修 F3 终态拒绝**(RejectionReason + accepted 权威 ack)+ 占位 fail-visible impl(不接线 transport)。
- [x] `src/lib/canvasSyncPort.contract.test.ts` — 6 处 `@ts-expect-error` 红线自证 + 接口面正向断言 + **F1 field-intent 无损并发契约**(同 record 不同字段双留 / 未编辑字段不提交 / 嵌套叶子不整树替换 / reorder 有意图 / 数组下标定点)+ **F3 终态拒绝 outcome 映射契约**(401/403/revoke/400/413/422→rejected;409→conflict;5xx/408/429→retryable;200→accepted;无终态误重试/无假成功)+ 占位 reject 运行时验。
- [x] 本 inventory 文档(**返修 F2 纠 Yjs 五维事实** + 反映 F1/F3 类型)。
- [ ] G1-c 实现(N2-0 决议后):落**唯一** adapter,Figma 或 Yjs,另一模型零代码。
- 红线 grep 自证结果:见 §7 回报。

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
- HTTP 404 非删→rejected(not-found);404 删→accepted(delete-vs-update: delete wins)
- HTTP 409 → conflict(返 currentCursor + diverging 供 rebase),NOT retryable
- HTTP 5xx/408/429 → retryable(原样重试)
- HTTP 200 → accepted WITH server cursor(无假成功:accepted 必携 cursor)
- revoke(成员移除)→ submitChange 后 403 → rejected(forbidden),NOT retryable
- 类型级:ChangeOutcome kinds = accepted|conflict|retryable|rejected(rejected 与 retryable 不交)
- 类型级:accepted keyof 只有 kind|cursor(cursor 必填,非 optional)
- 类型级:RejectionReason 闭合域枚举(无 HTTP number/Yjs frame)
- 红线:RejectionReason 拒裸 HTTP 码 401(`@ts-expect-error`)

### 7.4 实跑结果

- `tsc -b` / `eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts` / `vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` 全绿——见 lead 复审可复跑的命令与输出(本 worker 已实跑,§7.5)。

### 7.5 实跑命令与输出摘录

(lead 复审可在此 worktree 复跑:`cd _tmp/worktrees/g1b-port && <cmd>`)

- `npx tsc -b` → exit 0(无类型错)。
- `npx eslint src/lib/canvasSyncPort.ts src/lib/canvasSyncPort.contract.test.ts` → exit 0(无 lint 错)。
- `npx vitest run src/lib/canvasSyncPort.contract.test.ts src/kernel/__spike__/yjs-mapping.spike.test.ts` → 全绿(port contract + yjs spike 两文件无回归)。
- 红线 grep §4.1-§4.4:非注释代码行零命中候选独占 DTO;`@ts-expect-error` directive 计数 = 6。
