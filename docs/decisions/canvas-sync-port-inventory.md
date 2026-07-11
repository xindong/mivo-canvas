# 画布 transport-neutral port + 两案契约 inventory(G1-b)

> 状态:**契约冻结 + inventory,不实现 transport**(G1-b,N2-0 决议前)。
> 日期:2026-07-12。
> 范围:计划 `docs/plan/remaining-tasks-cutover-plan.md` §4 Gate1 G1-b + §10 风险表「画布 port 泄漏候选协议细节」。
> 上游真相源:`docs/plan/remaining-tasks-cutover-plan.md` §4/§8(N2-0 决策龙头)、`docs/decisions/platform-architecture-2026-07-07.md`(§6 CRDT-ready、§13.5 per-record revision)、`docs/decisions/record-schema.md`(K40 canonical)、`shared/persist-contract.ts`(现有 Figma-case wire 契约)、`src/lib/serverPersistAdapter.ts`(现有 Figma-case adapter 占位)。
> 源码产物(本批):`src/lib/canvasSyncPort.ts`(port 接口 + 中性游标)、`src/lib/canvasSyncPort.contract.test.ts`(红线自证)。
>
> 本文件目的:供 **N2-0** 逐项对比 **Figma 式(服务端做主 + 属性级 LWW + 实时广播)vs Yjs(Y.Doc + y-protocol)** 两案,并供 **G1-c** 决议后落地**唯一**模型(另一模型不留死接口)。每案列五维:wire / hydrate / retry / conflict / shadow。

---

## 0. TL;DR

1. **port 是 transport-neutral 抽象**:接口 `loadSnapshot / submitChange / subscribe`,只表 record/field 级**域语义**(全量 record upsert + delete + reorder + update-meta),**不**出现任一候选独占的 transport DTO。
2. **中性游标 `SnapshotCursor`**:branded `unknown`。port 永不读其内部;adapter 解释为 Figma 案的 per-record revision bundle / canvas contentVersion,或 Yjs 案的 state-vector / Y.Clock。这是两案 wire 形状根本不同的唯一收敛点。
3. **红线(N2-0 前硬约束)**:port 不含 field-path PATCH body / If-Match revision header / 409 ConflictBody / metaRevision·contentVersion 分名(Figma 独占);不含 Y.Update(Uint8Array)/ state-vector(number[])/ y-protocol frame(Yjs 独占)。出现任一即违约(计划 §10 风险表)。自证见 §4 + `canvasSyncPort.contract.test.ts` 的 `@ts-expect-error`。
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

type CanvasChange =
  | { kind: 'upsert-node'; node: NodeRecord }      // 全量 record;adapter 自行 diff
  | { kind: 'upsert-edge'; edge: EdgeRecord }
  | { kind: 'upsert-anchor'; anchor: AnchorRecord }
  | { kind: 'delete-node'; nodeId: string }
  | { kind: 'delete-edge'; edgeId: string }
  | { kind: 'delete-anchor'; anchorId: string }
  | { kind: 'reorder-children'; childType: 'node' | 'edge' | 'anchor'; orderedIds: string[] }
  | { kind: 'update-meta'; title?: string }       // metaRevision/contentVersion 分名不出现(Figma 独占)

type ChangeOutcome =
  | { kind: 'accepted'; cursor: SnapshotCursor }
  | { kind: 'conflict'; currentCursor: SnapshotCursor; diverging: CanvasChange[] }
  | { kind: 'retryable'; reason: string }

type CanvasSyncEvent =
  | { kind: 'change'; change: CanvasChange; cursor: SnapshotCursor; origin: 'self' | 'remote' }
  | { kind: 'gap'; cursor: SnapshotCursor }       // 断线补拉锚点(adapter 决定 since=revision 还是 sv)
  | { kind: 'revoke'; reason: string }             // N2-2 成员移除/share 撤销限时断流
```

**设计取舍**:
- **全量 record upsert,而非 field-path PATCH**:port 表"node X 的当前态是 N",adapter 决定 diff 粒度(Figma 案 diff 到 field PATCH;Yjs 案逐字段写 Y.Doc)。若 port 直接表 field-path ops → 泄漏 Figma 独占形状,违约。全量 record 是两案公共分母。
- **childType 不含 'chat-message'**:chat 走 DP-6R per-user 重拆,不是共享画布对象(产品拍板"画布共享 / chat 私有")。chat 同步不进本 port。
- **`subscribe` 返 `Promise<Unsubscribe>`**:realtime channel 建立是 async(WS upgrade / SSE open),但不暴露具体 transport。
- **占位 `unwiredCanvasSyncPort`**:fail visibly(`not wired` reject),防误以为已同步(同 `unwiredServerPersistAdapter` 模式)。

---

## 2. 两案契约 inventory(wire / hydrate / retry / conflict / shadow 五维逐项)

> 每维先列 Figma 案(服务端做主 + 属性级 LWW),再列 Yjs 案(Y.Doc + y-protocol),最后点**中性 port 如何同时容纳两案**。N2-0 据此逐项给 go/no-go hard gate。

### 2.1 wire(线上形状)

| | Figma 式(属性 PATCH + 服务端合并) | Yjs 式(Y.Update + y-protocol) |
|---|---|---|
| transport | HTTP REST + SSE/WS 广播合并态 | 双向 WS,y-protocol 帧 |
| 写请求 | `PATCH /api/canvas/:id/nodes/:nid`,body = `NodePayload`(Omit id/revision),`If-Match: <envelope revision>` | `Y.Update`(Uint8Array 二进制)经 WS 推送;无 per-record revision |
| 版本号 | per-record `Revision`(envelope 唯一真相,`shared/persist-contract.ts:31`)+ canvas `metaRevision`/`contentVersion` 分名 | `state-vector`(number[])+ 各 peer clock;无显式 revision |
| 响应 | `UpsertResponse { id, revision }`(post-bump)/ `409 ConflictBody { currentRevision }` | 无 per-op 响应;合并态经广播 Y.Update 回流 |
| 广播 | 服务端合并后 push **合并态**(节点级 PATCH 或全量)给订阅者 | peer 间广播 `Y.Update`,客户端 CRDT 合并 |
| **port 中性容纳** | `submitChange(change, base?)` → adapter 把 `change` diff 到 field PATCH + `If-Match: base.cursor`(adapter cast 游标为 revision)。 | `submitChange(change, base?)` → adapter 把 `change` 逐字段写 Y.Doc → 发 Y.Update。`base` 不用于 If-Match,可忽略(CRDT 无 base 概念)。 |

### 2.2 hydrate(初始化载入)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 全量载入 | `GET /api/canvas/:id` → `GetCanvasResponse`(meta + nodes/edges/anchors envelope,每 record 带 id+revision+orderKey)→ `CanvasSnapshot`(域 record)+ cursor=revision bundle | `GET snapshot`(Y.Doc 序列化或重建)→ `CanvasSnapshot` + cursor=state-vector |
| 增量补拉 | `GET /api/canvas/:id?since=<contentVersion>` 或节点级 `?changedSince` | sv 协议:client 发 sv1 → server 回 sv2 + `Y.Update(since sv1)` |
| cursor 含义 | per-record revision bundle / canvas contentVersion(单数字) | state-vector(number[]),长度 = peer 数 |
| **port 中性容纳** | `loadSnapshot(canvasId, since?)`:`since` 同 brand 透传,adapter 解释为 revision(contentVersion)做增量 GET,或忽略(首拉)。 | `loadSnapshot(canvasId, since?)`:adapter 解释 `since` 为 sv,走 sv 协议补拉。port 不知 since 是 revision 还是 sv。 |

### 2.3 retry(失败/瞬态重试)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 瞬态(5xx/网络) | FX-5 IDB write-retry queue(`src/lib/writeRetryQueue.ts`)按 opId 幂等重放 | WS 断线 → Y.Update 本地累积,重连经 sv 协议自动补发(deterministic merge) |
| 428 缺 base | 重读当前 revision 再带 If-Match 重交 | 无 428 概念(Yjs 无 If-Match) |
| 409 冲突 | **rebase**:读 `currentRevision` → 字段级合并(非重叠各留)→ 重交 | 无 409(CRDT 自合并);但**远端已改写**需刷新视图 |
| 幂等 | `IDEMPOTENCY_KEY_HEADER` + 同 key 同 body 200 既有 / 不同 body 422(`reuse-conflict`) | Y.Update 本身可重复应用(幂等);opId 概念在 CRDT 内建 |
| **port 中性容纳** | `ChangeOutcome.kind = 'retryable'`(瞬态,原样重试)/ `'conflict'`(需 rebase,返 currentCursor + diverging)。 | `ChangeOutcome.kind = 'accepted'`(CRDT 总接受);adapter 可在远端改写时经 `subscribe` push `change(origin=remote)` 让 client 刷新。两案共用 accepted/retryable/conflict 三态。 |

### 2.4 conflict(并发冲突检测/解决)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 检测点 | 服务端(submit 时 If-Match 比对) | 无 submit 期检测(CRDT 总接受) |
| 解决 | 服务端**属性级 LWW**:同节点不同属性各留;同属性后写赢(record-schema §0 revision×LWW 兼容协议见 N2-1) | CRDT 自合并(Y.Text OT / Y.Map LWW per key) |
| 文本同编 | **整串 LWW**(现 record schema 把 text 整串当 LWW 叶子 → 两人同编互吞)→ N2-0 hard gate #1 | Y.Text OT(字符级,不互吞) |
| 跨 record 事务 | node-delete + edge、result-node + asset-ref **走严格事务路径**(非 LWW,record-schema) | CRDT 不保证跨 record 原子(Yjs 事务是 local sync,跨 record invariant 需 wrapper) |
| 多人 undo | 本地 undo 在远端交错语义未定(N2-0 hard gate #2) | Yjs UndoManager 关系 spike 自列未决 |
| **port 中性容纳** | `submitChange` 返 `conflict { currentCursor, diverging }`;`diverging` 是 `CanvasChange[]`(adapter 决定粒度:Figma 案可返整 record 当前态供 rebase;Yjs 案可返空数组,因 CRDT 已合并)。port 不规定"属性级 LWW"还是"Y.Text OT"——那是 N2-0/N2-1 决议,不在 port 面。 | 同上。port 表"变更可能被远端改写",不表"如何合并"。 |

### 2.5 shadow(本地/影子/服务端三态调和)

| | Figma 式 | Yjs 式 |
|---|---|---|
| 三态模型 | local(用户输入)/ shadow(最后已知服务端态)/ server(真相源)——计划 §1 v4 client 三态 | Y.Doc 本身即 local+server **合并态**(CRDT);三态塌缩为**一态 + awareness** |
| shadow compare | diff(local, shadow) → 最小 PATCH;server 接受后 shadow := local | 无 shadow compare(Y.Doc 已合并);只需广播 diff(Y.Update) |
| 不变量 | shadow ≠ local 时存在未确认变更;shadow 是重连后 rebase 基线 | Y.Doc state 是重连后 sv 补拉的基线;无显式 shadow |
| **port 中性容纳** | port 不暴露三态/shadow compare;adapter 内部维护。Figma 案 adapter 持 shadow 做 diff + rebase;Yjs 案 adapter 持 Y.Doc 做合并。port 只表"提交 change → 拿回 outcome / cursor"。 | 同上。port 不知 adapter 是三态还是一态。 |

---

## 3. 两案 → port 方法映射(决议后 G1-c 唯一落地参考)

| port 方法 | Figma 案 adapter(N2-0 选 Figma 时) | Yjs 案 adapter(N2-0 选 Yjs 时) |
|---|---|---|
| `loadSnapshot(id, since?)` | `fetchCanvas`(ServerPersistAdapter)+ 可选 `since=contentVersion` 增量;cursor = revision bundle | `GET /snapshot` 拉序列化 Y.Doc + sv 协议补拉;cursor = state-vector |
| `submitChange(change, base?)` | diff(change)→ `upsertNode/Edge/Anchor`(If-Match: base→revision);409 → `conflict` outcome | apply change → Y.Doc → 发 Y.Update;总 `accepted` outcome |
| `subscribe(id, onEvent)` | SSE/WS 订阅服务端广播合并态 → `change(origin=remote)` + 新 cursor | WS y-protocol peer 广播 → `change(origin=remote)` + 新 cursor;断线 → `gap` 事件 |

**红线再强调**:两案 adapter 都**不**把各自独占形状(field-path PATCH body / Y.Update binary / revision / state-vector)放进 `canvasSyncPort.ts` 的类型定义;只在自己的 adapter 文件(N2-0 决议后、G1-c 落地)内出现。port 侧 `SnapshotCursor` 是 branded `unknown`,adapter 用 `as unknown as SnapshotCursor` 构造,port 侧零 inspection。

---

## 4. 红线自证(grep)

**自证命令**(在 worktree 根跑):

```bash
# 4.1 port 文件不含 Figma 案独占形状
grep -nE 'If-Match|if-match|ConflictBody|metaRevision|contentVersion|"patch"|json.?patch|ops:\s*\[' src/lib/canvasSyncPort.ts
# 期望:无命中(空输出)。

# 4.2 port 文件不含 Yjs 案独占形状
grep -niE 'Y\.Update|Y\.Doc|state-vector|stateVector|y-protocol|Uint8Array' src/lib/canvasSyncPort.ts
# 期望:无命中(空输出;注释里提到的候选名在 contract test 不在 port 本体)。

# 4.3 port 不暴露裸 Revision number 作游标
grep -nE 'SnapshotCursor\s*=\s*(number|number\[\]|Revision)' src/lib/canvasSyncPort.ts
# 期望:无命中(SnapshotCursor = unknown & { __brand })。

# 4.4 contract test 用 @ts-expect-error 钉死负向断言(若误把独占形状加进 union,directive 失效 → tsc 报错)
grep -cE '^\s*//\s*@ts-expect-error' src/lib/canvasSyncPort.contract.test.ts
# 期望:4(4 处负向互锁 directive:Y.Update / state-vector / JSON-Patch / 裸 revision)。
# 注:文件头注释里 prose 提及"@ts-expect-error"不计入 directive,故用 ^\s*//\s*@ts-expect-error 精确匹配 directive 行。
```

**实际跑结果见 §6 回报**。

> 说明:4.1/4.2 的 grep 全量命中均在 `//` / `*` 注释行(解释红线本身),非注释代码行(port 类型定义 / 运行时)零命中——见 §6 回报的"非注释行过滤"自证。port 本体的类型与实现不含任一候选独占 DTO。

---

## 5. N2-0 接口(N2-0 决策龙头需逐项给两案结果 + 证据 + 成本 + go/no-go hard gate)

本 inventory 喂给 N2-0 的 7 项 hard gate(计划 §8 N2-0 原文),port 不预判任一项:

1. **文本同编**:Figma 整串 LWW(互吞)vs Y.Text OT —— 一票否决项。
2. **多人 undo/redo**:Figma 本地 undo × 远端交错未定 vs Yjs UndoManager spike 未决。
3. **跨 record invariant/事务**:Figma 严格事务路径(record-schema)vs Yjs 需 wrapper。
4. **revision × 属性 LWW 兼容协议**:Figma (A) 改 #194 / (B) versioned ops endpoint;Yjs 不适用(CRDT)。
5. **实时 transport + auth spike**:真实 SSO 网关下 WS upgrade 是否放行(两案都需 WS;Figma 可降级 SSE)。
6. **迁移/双协议窗口**:#194 / PG JSONB / FX-5 / stale-client。
7. **事件序号/补拉日志/压缩、权限撤销、性能/存储放大**。

port 的中性设计保证 N2-0 任一决议后,G1-c 只需落一个 adapter,另一模型零死接口。

---

## 6. 本批落地状态

- [x] `src/lib/canvasSyncPort.ts` — port 接口 + 中性游标 + 占位 fail-visible impl(不接线 transport)。
- [x] `src/lib/canvasSyncPort.contract.test.ts` — 4 处 `@ts-expect-error` 红线自证 + 接口面正向断言 + 占位 reject 运行时验。
- [x] 本 inventory 文档(wire/hydrate/retry/conflict/shadow 五维两案齐)。
- [ ] G1-c 实现(N2-0 决议后):落**唯一** adapter,Figma 或 Yjs,另一模型零代码。
- 红线 grep 自证结果:见 §6 回报(全空,无候选独占 DTO 进 port 本体)。
