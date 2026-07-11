# N1 Spike:Yjs ↔ record schema ↔ LeaferJS 映射验证

> 状态:**spike(证据优先,非生产代码)**。N1 任务包交付。
> 日期:2026-07-11。
> 任务来源:`docs/plan/arch-migration-execution-plan.md` §4「下一批·协作」N1(已授权)+ §0 成功定义 6。
> 权威上游:`docs/decisions/record-schema.md`(§1 CRDT 映射规则 + §3 嵌套细化 + §8 裁决)、`docs/decisions/platform-architecture-2026-07-07.md`(§6 spike 直接对 Yjs 语义,不自研 LWW;§13.5 revision per-record 硬约束)。
> 验证产物:`src/kernel/__spike__/yjs-mapping.spike.test.ts`(**18 tests 全绿,test body 合计 ~60ms,远低于 2s gate**)。
> 依赖变更:`yjs@^13.6.31` 入 devDependencies(不进生产 bundle,见 §5 核验)。
> Greptile review:3 条 P1 全量吸收(增量投影修 zombie+revision 放大;clear+rebuild 坑补测;见 §2.2 坑5/坑7)。

---

## 0. TL;DR(结论先行)

1. **record-schema.md 的纸面映射用真 yjs 跑通了**——代表性 NodeRecord(全嵌套 + unicode + 判别联合)无损往返 Y.Map/Y.Array;CRDT 字段级合并成立(不同节点 / 同 record 不同字段 / 嵌套叶子级并发都留;同字段并发 LWW 收敛)。**成功定义 6(CRDT-ready)通过。**
2. **纸面没写、真跑暴露的 7 条坑**(§2):通用递归 codec 可行(因 schema 本就扁平无大 JSON blob);`Y.Map.toJSON()` 深安全但有 caveat;**`Y.Array` 无 move 原语 → order_key/z-order 须 delete+insert,并发 reorder 语义需 N2 正面处理**;detached YType 不持留 op;**revision↔Yjs 因果序是双真相源,CRDT 路径必须 bypass kernel 的 LWW bump,否则必丢数据**;两端独立建 base 合并会产生怪异并集(必须共享公共祖先);**`writeRecord` 的 clear+rebuild 是 record 级替换,并发时吞同节点子字段更新(Greptile P1 ①,N2 写路径必须增量字段级 set,永不 clear 整 record)**。
3. **revision 调和立场(§3)**:CRDT doc 的 `revision` 必须是 Yjs 状态的**派生值**,不是独立 LWW 计数器;一个 record 要么走 CRDT 路径(Y.Update,交换即合并不拒写),要么走 legacy 路径(record 级 PATCH + revision LWW),**不能双仲裁**。
4. **渲染面(§4)**:Yjs → record → node → projection → `useLeaferSpikeRenderer` 链路**无结构性阻碍**;N2 的 wiring 点在 store 层(把数据源从 canvasStore 换成 Yjs 观测投影),渲染层零改。
5. **没有发现 record-schema.md 映射的真错误**——纸面映射正确,spike 只是补了"纸面没说但实跑会踩"的实现细节坑。无需改决策文档。

---

## 1. 验证范围与方法

spike 不接线任何生产 store/渲染/服务端,只在本测试文件内 `import * as Y from 'yjs'`,用一个**通用递归 codec**(标量→叶子 / array→`Y.Array` / plain object→`Y.Map`)把 `NodeRecord` 写进 `Y.Doc.getMap('nodes')[id]` 的 per-node `Y.Map`,再读回对比。通用递归可行是因为 record-schema §6 要求"无嵌套大 JSON blob",每个嵌套对象(transform/asset/relations/generation/aiWorkflow/...)都是字段级小对象,递归深度有界(record→generation→maskBounds ≤3 层)。

四组验证(对应任务 a/b/c/d):

| 组 | 验证项 | 结果 |
|---|---|---|
| A | 代表性 record 无损往返(full 全嵌套 + minimal 空数组/optional 缺省 + 边界数值 + unicode/emoji + 多节点共存 + toJSON 探针) | 6/6 ✅ |
| B | CRDT 并发合并(不同节点 / 同 record 不同字段 / 嵌套叶子级 / 同字段 LWW / Y.Array 无 move / **writeRecord clear+rebuild 吞字段**) | 6/6 ✅ |
| C | DocKernel 同步器接缝(Y.Doc→kernel 投影 + 远端 update 合并 + revision 双真相源坑暴露 + **删除投影 + 增量投影无 revision 放大**) | 5/5 ✅ |
| D | LeaferJS 渲染面静态分析(链路类型对齐) | 1/1 ✅ |

---

## 2. 映射验证结论(顺畅 / 有坑)

### 2.1 顺畅(往返无损 + CRDT 合并成立)

| 字段类型 | 映射(record-schema §1/§3) | 实跑结论 |
|---|---|---|
| 纯标量(number/string/boolean/enum) | `Y.Map` 叶子,LWW | ✅ 往返无损;0/负数/浮点/`MAX_SAFE_INTEGER`/空串/中文/emoji/四字节代理对均无损 |
| 子结构对象(transform/asset/relations/generation/aiWorkflow/annotationBounds/layout/constraints/maskBounds/maskSourceSize/imageCrop/assetSourceDimensions/connectorStart/connectorEnd) | 嵌套 `Y.Map` | ✅ 通用递归深转;`toEqual` 逐字段通过 |
| 有序集合(fills/strokes/effects/markupPoints/experimentalAnchors) | `Y.Array<Y.Map>`,元素按稳定 id | ✅ 往返无损;空数组 `[]` 保形状(非 undefined);判别联合(solid\|image fill、shadow\|blur effect)靠 `kind` 叶子保判别,通用 codec 透明保留全键 |
| 字符串数组(parentIds/sourceNodeIds/resultNodeIds) | `Y.Array<string>` | ✅ 往返无损 |
| id/type | 不可变叶子 | ✅ 作叶子 set(不变更即可;真正"不可变"语义靠应用层不写,Yjs 不强制) |
| revision | per-record 叶子 | ✅ 往返无损;但与 kernel LWW 的关系是坑(§2.2 坑5/§3) |

**CRDT 合并(成功定义 3)**:
- 不同节点并发(A 改 node1、B 改 node2)→ 双向 `applyUpdate` 后两边都留。✅
- 同 record 不同字段并发(A 改 transform、B 改 fills)→ 字段级都留。✅
- 嵌套 `Y.Map` 不同叶子并发(A 改 transform.x、B 改 transform.y)→ **叶子级都留(CRDT 最细粒度)**。✅
- 同字段并发(A/B 各设 node1.title)→ LWW:两边收敛于同一个值(二选一,非混合/损坏)。✅ 收敛是 CRDT 保证;**具体赢家由 yjs op ID(clientID,clock)比较决定,clientID 随机故跨 run 不定——N2 不能假设特定一方赢,只能依赖收敛**。

### 2.2 有坑(spike 暴露,纸面未写)

**坑1:通用递归 codec 可行 = 一条发现,不是坑。** record-schema §1 逐字段定了映射规则(node=Y.Map / 有序集合=Y.Array / 标量=叶子 / 子结构=嵌套 Y.Map),但没说"能否用一个通用递归 codec 不写逐字段 schema 表"。spike 证实**可以**——因为 schema 本就符合 §6"扁平 + 小嵌套对象",通用递归(dispatch on `instanceof Y.Map/Y.Array`)安全。这降低了 N2 codec 实现成本(无需维护逐字段映射表)。但 caveat:通用 codec 要求值里**不能有大 JSON blob**(否则递归把 blob 拆成 Y.Map 叶子,既慢又丧失 blob 整体性)——这正是 §6 禁止的,已自洽。

**坑2:`Y.Map.toJSON()` 在 yjs 13.6.31 是深安全的,但不能替代显式 `decode()`。** 探针测试:`ymap.toJSON()` 会递归调用子 Y 类型的 `toJSON`,故嵌套 `Y.Map`/`Y.Array` 也深转 plain(scalars + nested 都 OK)。可作为读 record 捷径,但 caveats:① `toJSON()` 对空 `Y.Map` 返回 `{}`、对 undefined 键语义不直观;② 未来 yjs 版本若改 `toJSON` 语义会静默破;③ 显式 `decode()` 是稳定契约,N2 实装仍应走 `decode()`,`toJSON()` 仅做只读快路径。

**坑3(leader 点名):`Y.Array` 无 move 原语 → order_key/z-order 须 delete+insert。** yjs 13.6.31 的 `Y.Array` 方法仅 `insert/push/unshift/delete/get/toArray/slice/map/forEach`——**没有 `move()`**。reorder `[a,b,c]→[b,c,a]` 只能 `delete(0)+insert(2,[a])`。CRDT 语义坑:delete+insert 的"新元素"拿到**新 yjs id**,与原元素的因果链断裂;两端并发 reorder 同一数组时,合并结果依赖 yjs 对 insert/delete 的因果序裁决,**不保证按"移动语义"保序**(可能出现重复/丢失/乱序)。对 `order_key`/z-order 类业务字段,这是 **N2 必须正面处理的设计点**(候选:显式 `order_key` 标量叶子 + LWW;或外部 y-protocols 之外的 order CRDT;或接受 Y.Array 现状并约束"z-order 改动不并发")。

**坑4:detached `Y.Array`/`Y.Map` 不持留 op。** `new Y.Array()` 未挂进 `Y.Doc` 时,`push`/`set` 的 op 不会持久(spike 实测 `toArray()` 返回 `[]`)。所有 Y.Type 必须 `doc.getMap()/doc.getArray()` 或经 `nodesMap.set(key, ytype)` 挂进 Doc 才有效。N2 实装注意:不要"先 new 再 populate 再 attach",要在 `doc.transact` 内 attach+populate 原子完成。

**坑5(leader 点名,N2 最大坑):revision ↔ Yjs 因果序 = 双真相源。** 详见 §3。spike 原型已从"全量 resyncAll"升级为"增量投影(按 `event.path` 只动改动节点)",修掉 Greptile P1 ③——**无关节点的 kernel revision 不再被牵连递增**(测试 `无关节点 revision 不再被递增` 断言:改 nA 只 bump kernel nA,nB 不动)。但**改动节点自身的 kernel revision 仍与 Yjs 背离**(kernel `upsertNode` bump vs Y.Map record.revision 不变——测试 `revision 双真相源坑` 仍实证 7→8 背离),这条**根本坑不在 spike 修**,须 N2 加 `setNodeFromCrdt` bypass LWW 或 kernel 降级为 Y.Doc 只读投影。

**坑6:两端独立建 base 合并会产生怪异并集。** 若两端各自 `writeRecord(fullRecord)`(各用自己的 yjs clientID 创建 base op),合并时两条独立 base 的 `fills` `Y.Array` 会被当并发新建 → 合并成 `[f-solid, b-fill]` 之类并集(spike 实测踩到)。正确做法:写一次公共 base,`encodeStateAsUpdate`,两端 `applyUpdate` 灌入(共享同一 clientID 的 base op),分叉后再改。N2 sync 协议必须保证"公共祖先"语义(initial sync 拉服务端全量 state,后续交换 diff)。

**坑7(Greptile P1 ①):`writeRecord` 的 clear+rebuild 是 record 级替换,并发时吞同节点子字段更新。** `writeRecord` 的 `ymap.clear()` 删掉指向旧子树(transform Y.Map)的 key,再用旧值建新子树;若 B 并发改旧 transform 子树的叶子,该 set 作用在"已删孤儿旧子树"上,合不进 A 建的新子树 → B 的子字段更新丢失。spike 实测:A 用 writeRecord 重写 node1、B 并发改 `transform.y=999`,合并后 `transform.y` 回到 fullRecord 的 -20(B 的 999 丢失)。**结论**:`writeRecord` 仅限**非并发 seeding**(往空 Y.Doc 一次性灌 record);**N2 真 CRDT 写路径必须增量字段级 `set`(只 set 改动 key,永不 `clear` 整 record)**——§B 同 record 不同字段测试直接 `aNode.set('transform', ...)` 那样。注:Y.Doc 节点删除的 kernel 投影已补(增量 observer 顶层 `delete` key→`kernel.deleteNode`,Greptile P1 ②,zombie 修复,测试 `删除投影` 覆盖)。

---

## 3. revision ↔ Yjs 因果序 调和候选方案(spike 初步立场,N2 立项前须 lead 拍板)

### 3.1 两套并发模型的根本分歧

| 维度 | Yjs CRDT | DocKernel.revision(record-schema §13.5) |
|---|---|---|
| 真相粒度 | **字段级**(同 record 不同字段并发都留) | **record 级**(整 record 一次 upsert,带 revision) |
| 因果载体 | op 的 `(clientID, clock)`;无 "revision" 概念 | per-record 单调整数,服务端乐观并发 LWW tie-break |
| 冲突定义 | 同字段才算冲突(LWW by op ID);不同字段不冲突 | 同 record 任何并发都算冲突(后到 PATCH 拒前到,整 record 取后者) |
| 拒写 | 不拒写(交换即合并) | S5/S6:`record.revision >= existing.revision` 才接受,否则 stale 拒写 |

**冲突**:`Yjs` 认为"A 改 transform / B 改 fills"不冲突(都留);`DocKernel` record 级 LWW 会把两次 PATCH 之一判 stale 拒写(**丢一字段**)。两套模型对"什么算冲突"定义不同——若同时仲裁同一 record,必丢数据。spike 测试 `PITFALL 暴露` 实证:Y.Map 里 `record.revision=7`,经同步器 `upsertNode` 后 kernel revision 被 bump 成 8(Y.Map 仍 7),再改一次 kernel→9、Y.Map 仍 7——**revision 双真相源立即背离**。

### 3.2 候选方案

**方案 A(spike 推荐,过渡态):Y.Doc 为 CRDT doc 唯一真相源,DocKernel 降级为只读投影 + legacy 兼容层。**
- CRDT 路径:client ↔ server 交换 `Y.Update` blob;server 持久化 Y.Doc state(update log 或 snapshot);`server.applyUpdate(blob)` 无拒写,交换即合并。
- `revision` 派生:`record.revision` = server 从 Yjs state 派生的单调值(候选:该 record Y.Map 的 op 计数 / state-vector clock / 内容 hash)。**只用于** legacy 非 CRDT client 的 cache 校验 + "请刷新"提示,**不用于 LWW 拒写**。
- legacy 路径:非 CRDT client 走 record 级 PATCH + revision LWW(现有 S5/S6)。server 把 legacy PATCH **翻译成 Y.Update** 应用到 Y.Doc(bridge),翻译规则见决策清单 §6-Q4。
- 一条 record 要么 CRDT 路径要么 legacy 路径,**不双仲裁**(用 per-canvas flag 标记该 doc 是否 CRDT-synced)。
- kernel 改造:加 `setNodeFromCrdt(record)`(bypass LWW bump + 拒写,直接写 canonical + 派生 revision),或 kernel 降级为 `Y.Doc` 的纯读投影(无独立写路径)。

**方案 B(不推荐):双轨并存,server record-level LWW 不变,CRDT 只在 client 间 best-effort 合并。**
- 简单但语义割裂:client 间 CRDT 合并的细粒度改动到 server 又被 record 级 LWW 抹平(同 record 不同字段两次 PATCH,后到拒前到)。字段级 CRDT 在 server 边被废。
- 不适合 MivoCanvas:画布多人共改同节点不同字段是核心场景,语义割裂不可接受。

**方案 C(终态):完全 server-side Yjs(per-canvas `Y.Doc` + y-protocols/y-websocket)。**
- server 跑 yjs,每个 canvas 一个 `Y.Doc`,client 走 y-protocols;`revision` 退化成 Yjs state-vector snapshot 标识。
- 最彻底但引入 server 端 yjs 运行时 + websocket 长连接 + presence 通道。是 N2"真做实时协作"的终态。

**spike 立场**:A 阶段(过渡,revision 派生 + CRDT 路径 bypass LWW)→ C 阶段(终态,server-side yjs)。N2 立项即定 A,后续演进到 C。**核心硬约束:CRDT 路径绝不能让 `kernel.upsertNode` 的 revision-bump+LWW 拒写参与仲裁。**

---

## 4. LeaferJS 渲染面静态分析(任务 d)

链路:`Yjs Y.Map(每节点)→ [readRecord] → NodeRecord → [mapping.fromRecord] → MivoCanvasNode → [render/projection.ts 投影] → renderedNodes → [useEngineSpikeRenderers] → useLeaferSpikeRenderer paint`。

- **数据面契约**:`useEngineSpikeRenderers.ts:23-24` 的 `visibleNodes`/`canvasRenderedNodes: MivoCanvasNode[]`;`useLeaferSpikeRenderer.ts:4` `import type { MivoCanvasNode }`,paint 入参即 `MivoCanvasNode`。渲染层消费的是 `MivoCanvasNode[]`,**与数据来源无关**。
- **类型级断言(spike 测试 §D)**:`readRecord(doc, id) → NodeRecord` → `fromRecord(rec) → MivoCanvasNode` → `MivoCanvasNode[]` 链路类型对齐(tsc -b 通过,无结构性类型阻碍)。
- **结论**:渲染层**零改**。N2 的 wiring 点在 store 层——把 `canvasStore` 的 document 数据源替换成"Yjs 观测 → NodeRecord → fromRecord → MivoCanvasNode"的投影 store(或让 `canvasStore` 的 documentSlice 订阅 Y.Doc update)。`useLeaferSpikeRenderer.ts:20` 的 `useCanvasStore` 耦合点是 selection/editing 态(session 域,非 document 域),本就不随 Yjs document CRDT 走,无阻碍。
- **未验证项(诚实标注)**:未真渲染(任务要求只静态分析)。Yjs 高频 update 触发 React 重渲染的性能路径(observeDeep → setState → paint 节流)未压测;N2 须做 20k 节点 pan bench(对齐 §12 风险4 的 26.7ms p95 基线)。

---

## 5. yjs 不进生产 bundle 核验(边界要求)

- `yjs@^13.6.31` 加入 `devDependencies`(非 `dependencies`)。
- yjs 在仓库内**仅**被 `src/kernel/__spike__/yjs-mapping.spike.test.ts` import(全仓 grep 确认);该文件是 `.test.ts`,不在生产入口 `src/main.tsx` 的 import graph 内。
- `npm run build`(`tsc -b && vite build`)实跑成功(857ms,exit 0),产出 `dist/`。
- grep 核验:`grep -roE "yjs|lib0|YEvent|applyUpdate|AbstractType|encodeStateAsUpdate" dist/` **零命中**——production bundle 内无 yjs/lib0 任何标识符。
- 故 yjs 不进生产 bundle,符合"spike = 证据优先,生产零接线"边界。

---

## 6. N2 立项前必须拍的决策清单

| # | 决策点 | 选项 / spike 倾向 | 影响面 |
|---|---|---|---|
| Q1 | CRDT doc 真相源归属 | (a) Y.Doc(server-persisted) 为唯一真相,DocKernel 降投影 **(spike 倾向 a)** (b) DocKernel record 仍为真相,Yjs 仅 client 间 | 决定 server schema 形态 + kernel 改造量 |
| Q2 | `revision` 派生算法 | (a) record Y.Map op 计数 (b) state-vector clock (c) 内容 hash | legacy cache 校验 + 非幂等冲突检测语义 |
| Q3 | server 持久化 Y.Doc 形态 | (a) update log(可重放) (b) 周期 snapshot (c) 两者 + GC | 重启恢复 + 长期增长控制 |
| Q4 | legacy↔CRDT bridge 翻译规则 | legacy PATCH → Y.Update 时:整 record 替换(简单,字段级 CRDT 退化) vs 字段级 diff(保 CRDT 细粒度) | 决定 legacy client 是否拖累 CRDT 语义 |
| Q5 | order_key/z-order CRDT 策略 | (a) 接受 Y.Array delete+insert 现状,约束 z-order 不并发 (b) 显式 order_key 标量+LWW **(spike 倾向 b)** (c) 引外部 order CRDT | 画布层级排序的并发正确性 |
| Q6 | Y.Array 元素 id 稳定性 | 元素增删按 Y.Array position 还是另建 id→position 索引(record-schema 假设元素带稳定 id,但 Y.Array 本身按 position) | fills/strokes/effects 并发增删语义 |
| Q7 | presence 通道选型 | y-protocols/y-presence vs 自建;走 user 域(§13.1)不进 document CRDT | 他人光标/选区实现 |
| Q8 | 断线重连 / offline edit | state-vector 比对 + 增量拉取;offline edit 队列(与 FX-5 写失败重试队列关系) | 弱网/离线协作可用性 |
| Q9 | chat 消息 CRDT 形态 | Y.Array<Y.Map> 与 nodes 同 Y.Doc 还是独立 Y.Doc(per-canvas)(DP-6/D6) | chat 协作粒度 + GC |
| Q10 | Y.Doc 增长控制 / GC | 何时 snapshot + 清 op log;与 server 存储成本的关系 | 长期运维 |

---

## 7. 不在 N1 范围(N2 做什么)

N1 只验证映射 + 暴露坑,不做:
- 实时 presence / 多人光标 / 选区同步(§6-Q7)。
- server 端 yjs 运行时 + y-protocols/y-websocket 接入(§3 方案 C)。
- store 层接线(把 canvasStore documentSlice 换成 Yjs 观测投影)。
- legacy↔CRDT bridge 实现(§6-Q4)。
- order_key/z-order 的 CRDT 方案落地(§6-Q5)。
- 20k pan p95 性能压测(§4 未验证项)。
- chat 消息 CRDT(§6-Q9)。
- yjs UndoManager 与现有 undo 栈(command 式,roadmap D7)的关系。

N1 的产出(spike 测试 + 本文档 + yjs devDep)为 N2 立项提供:映射可行性证据 + 坑清单 + 决策清单。N2 立项前须先拍 §6 的 Q1-Q5(尤其 Q1 真相源归属 + Q5 order_key 策略),否则实装会返工。

---

## 附:spike 测试文件结构索引

`src/kernel/__spike__/yjs-mapping.spike.test.ts`:
- 通用递归 codec:`encode`/`decode`/`writeRecord`(seeding 用,clear+rebuild 非 CRDT 写路径,见坑7)/`readRecord`(attach+populate 须在 `doc.transact` 内原子,见坑4/坑5)
- `fullRecord`(全嵌套 + unicode + 判别联合)/`minimalRecord`(空数组 + optional 全缺省)fixtures
- §A 6 tests / §B 6 tests(+writeRecord clear+rebuild 吞字段)/ §C 5 tests(YDocKernelSync 增量投影原型 + revision 双真相源坑 + 删除投影 + 无 revision 放大)/ §D 1 test
- **18 tests 全绿**;tsc -b + eslint 全绿;test body ~60ms。
