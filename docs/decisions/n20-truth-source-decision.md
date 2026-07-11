# N2-0 真相源拍板:Figma 式 vs Yjs(决策龙头,decision-complete)

> 状态:**spike 决策文档(等 lead + gpt-5.6-sol/xhigh 双审)**。
> 日期:2026-07-12。
> 任务来源:`docs/plan/remaining-tasks-cutover-plan.md` §8 N2-0(7 项 hard gate,逐字执行)。
> 前置:`docs/spike/n1-yjs-mapping.md`(N1 结论 + Q1-Q10)、`docs/decisions/record-schema.md`(§1 CRDT 映射 + §8 裁决)、`src/kernel/{docKernel,records,adapters}.ts`(现有底座)、`docs/decisions/platform-architecture-2026-07-07.md`(§6 CRDT-ready + §13.5 Figma 式归属)。
> 验证产物:`src/kernel/__spike__/n20-truth-source.spike.test.ts`(**15 tests 全绿,test body ~14ms;tsc -b + eslint + `npm run build` 全绿;yjs 在 `dist/` 零命中,不进生产 bundle**)。
>
> **倾向 Figma 式,以对比证据为准** — 结论见 §0,证据见 §2-§8。

---

## 0. TL;DR(结论先行 + 七 gate 判决表)

**唯一推荐:Figma 式(服务端做主 + 属性级 LWW + REST/SSE 实时广播)。NOT Yjs。NOT 双轨。**

理由(以对比证据为准,非偏好):
1. **现有底座本就是 Figma 式**:`DocKernel`(record 级 upsert + per-record revision LWW tie-break)+ #194 PATCH(If-Match 400/428/409,payload 对 server 不透明)+ `serverPersistAdapter`(**仍未接线生产**,observation 11585 确认)+ `owner.ts` SSO(header 注入 `x-mivo-auth-user`+`x-mivo-gateway-secret` fail-closed)。platform §13.5 明写"Figma 式,节点级合并"。Yjs 是移植外物。
2. **Yjs 移植成本 = 拆已建成的写路径 + 双真相源调和**:N1 §3.1 实证 `revision ↔ Yjs` 双真相源立即背离(Y.Map 7 vs kernel 8);方案 A 要加 `setNodeFromCrdt` bypass LWW,方案 C 要 DocKernel 降级为 Y.Doc 只读投影——两者都动已建成的 DocKernel + #194 写路径。本 spike `antiYjs-坑5` 复现背离、`antiYjs-坑7` 复现 clear+rebuild 吞并发子字段(见 §9)。
3. **属性级 LWW ≠ Yjs**:field-level PATCH(N2-1 op schema,走 #194 envelope)即属性级 LWW,处理"同节点不同字段并发双留"——这是画布核心场景,**无需 Yjs**。Y.Text 的 char-level OT 对 canvas 文本(标题/标注/markdown)是过重。本 spike `G4-1/G4-2` 实证不同字段/嵌套叶子双留(见 §4)。
4. **CRDT 做不到跨 record 事务**:node-delete+edge cascade、result-node+asset ref、delete-vs-update 的原子边界,Figma 式走 server-side 事务路径(N2-1 "严格事务路径,非 LWW");Yjs CRDT 是 per-record 最终一致,**无原子多 record**。本 spike `G3-1/G3-2` 实证(见 §5)。
5. **Yjs 被 WS 网关卡,Yjs 不被卡**:Figma 式 REST+SSE 走 plain HTTP,任何网关必透传;Yjs y-protocol 需双向 WS,网关不放行 WS upgrade 则需 polling fallback(失 CRDT 实时价值)。网关 WS 是否放行 = **未验证项留 lead 生产实测**(§7)。Figma 式不依赖此验证。

| # | hard gate | Figma 式 | Yjs | 判决 | 一票否决 |
|---|---|---|---|---|---|
| 1 | 文本同编 | v1 整串 LWW(同字段并发取后者)+ field-level PATCH(不同字段双留);UX surfacing | Y.Text char-merge(过重) | **Figma GO** | 文本 gate **不否决**(canvas 文本同刻并发罕见) |
| 2 | 多人 undo/redo | command undo + 拖拽 coalescing + 选择性撤(远端交错保留) | Yjs UndoManager(关系 N1 §7 未列决) | **Figma GO** | — |
| 3 | 跨 record invariant/事务 | server-side 事务 cascade(delete+edge、result+asset、delete-vs-update) | CRDT 无原子多 record | **Figma GO**(CRDT 失此 gate) | — |
| 4 | revision × 属性 LWW 兼容 | **(A) 受控修订 #194**:PATCH payload 演进为 field-level ops,envelope 不变;revision 每 op bump,只供 snapshot/catch-up | (B) 严格 endpoint + versioned ops endpoint | **Figma + 方案 A GO** | — |
| 5 | 实时 transport + auth | REST+SSE(plain HTTP,网关透传);WS 选作优化 | y-protocol 需双向 WS(网关不放行→polling 失 CRDT 价值) | **Figma GO**;网关 WS = **未验证项留 lead** | 网关 gate 对 Yjs 不利(Yjs 被 WS 卡) |
| 6 | 迁移/双协议窗口 | #194 未接线→原地演进,无双协议窗口;PG JSONB payload 不透明;FX-5 留客户端重试 | legacy PATCH↔Y.Update bridge + per-canvas CRDT flag = 真双协议窗口 | **Figma GO**(无双协议窗口) | — |
| 7 | 序号/补拉/压缩/撤销/存储放大 | per-canvas 单调 seq + ?since=seq + snapshot+truncate;revoke 断流 actor+canvas;存储有界 | Y.Doc update log + GC(Q3/Q10 无界);revoke = doc 级访问控制(更难);存储放大 | **Figma GO**(revoke 简单 + 存储有界) | — |

**唯一推荐 → G1-c/N2-1 契约草案见 §10;改写 N1 Q1-Q5 见 §11。**

---

## 1. 现有底座事实(对比基线)

### 1.1 已建成的 Figma 式基础

| 组件 | 文件 | 现状 | Figma 式特征 |
|---|---|---|---|
| DocKernel | `src/kernel/docKernel.ts` | record 级 upsert(`upsertNode` bump `existing.revision+1`),三 Map(nodes/edges/anchors)+ documentMeta | 服务端真相 + per-record revision LWW tie-break(S2 注释:S5/S6 加乐观并发 `record.revision >= existing.revision` 否则 stale 拒写) |
| NodeRecord | `src/kernel/records.ts` | 40 canonical 字段 + revision;`text?` 整串叶子(LWW) | 字段扁平,可无损映射 Y.Map/Y.Array(record-schema §1)——但**映射≠采用** |
| #194 API 契约 | `server/routes/canvas.ts:450-525` + `server/persist/backend.ts` | `PATCH /api/canvas/:id/nodes/:nodeId` → `upsertChild`;If-Match 严格(400/428/409);payload 对 server 不透明(除 canvas meta contentVersion) | 服务端做主 + If-Match 乐观并发 + revision-conflict 409 + reuse-conflict 422 |
| ServerPersistAdapter | `src/lib/serverPersistAdapter.ts` | `upsertNode(canvasId, node, baseRevision?)` + `reorderChildren(...,baseContentVersion)` + `fetchCanvas`→metaRevision/contentVersion 分名 | **仍未接线生产**(`unwiredServerPersistAdapter` 全 reject;observation 11585 确认) |
| SSO 身份 | `server/lib/owner.ts` | `x-mivo-auth-user`(SSO username,maker user id)+ `x-mivo-gateway-secret`(网关注入,客户端不可构造,fail-closed) | header 注入鉴权,**HTTP-header-based**(WS upgrade 亦需网关注入同链) |
| 归属/共享 | platform §13.5 | `projects/project_members/share_links`;Figma 式无预定义团队;并发编辑=节点级合并(每 record revision,同节点才冲突) | **明写"Figma 式"** |

### 1.2 关键事实(决定性)

- **#194 未接线生产**(`unwiredServerPersistAdapter` 全 reject):**gate 4 方案 A(受控修订 #194)零生产破坏面**——演进 PATCH payload 为 field-level ops,无生产客户端会破,只更新契约测试。这压倒方案 B(严格 endpoint + 新增 versioned ops)的双 endpoint 迁移税。
- **DocKernel 写路径已成型**:`upsertNode` 内 bump revision,record 级整替换。Yjs 移植需 **bypass LWW(`setNodeFromCrdt`)或降级 DocKernel 为 Y.Doc 只读投影**(N1 §3.2 方案 A/C)——动已建成写路径。
- **yjs 已在 devDependencies**(`yjs@^13.6.31`,N1 §5 加):本 spike 复用,不新增依赖;yjs **不进生产 bundle**(本 spike `npm run build` + grep `dist/` 零命中,复验 N1 §5 结论)。

---

## 2. 七 gate 逐项判决

> 每项:**两案结果 + 证据(spike test 引用)+ 成本 + go/no-go**。PoC 实跑结果见 §9。

### Gate 1 · 文本同编(text gate,一票否决项)

**问题**:v1 接受整串 LWW(现 record-schema §2.6 把 `text` 当 LWW 叶子,两人同编整串互吞)还是必须 Y.Text/OT?

| 维度 | Figma 式 | Yjs |
|---|---|---|
| 不同字段并发(A 改 title / B 改 text) | field-level PATCH 双留(`G4-1` 实证) | Y.Map 字段级双留(N1 §2.1) |
| 同字段并发(A/B 都改 text) | **整串 LWW(后者 wins,by server seq)**;UX surfacing(409/"他人已编辑,重载?") | **Y.Text char-level OT 合并**(字符级无丢失) |
| 嵌套叶子(A 改 transform.x / B 改 transform.y) | field-level PATCH 双留(`G4-2` 实证) | Y.Map 嵌套叶子双留(N1 §2.1) |

**证据**:`n20-truth-source.spike.test.ts` `G1` 测试——A/B 都改 `text`,LWW 取后者(`B-text` wins);对比 Y.Text 会 char-merge(过重)。

**成本**:
- Figma 式:0 额外依赖(field-level PATCH 即 N2-1 op schema);UX surfacing 成本(409 body 含 `currentRevision`,client 提示重载)。
- Yjs:引入 yjs runtime 进生产 + Y.Text 双真相源调和(坑5)+ clear+rebuild 写路径坑(坑7)。

**go/no-go**:**Figma GO**。**文本 gate 不否决**——理由:
1. **MivoCanvas 文本不是协作文档**:text 字段 = 节点标题/标注/markdown 块,**非 Google Docs 式同段共编**;两人同刻并发同一 text 字段是罕见边缘场景。
2. **field-level PATCH 已解 common case**:不同字段并发双留(`G4-1`),只有"同一 text 字段同刻并发"才整串 LWW——此边缘 v1 接受 + UX 提示,不引入 Yjs。
3. **Figma 本身亦非全 OT**:Figma multiplayer 对属性树是 LWW/linear merge;text 节点字符级同步是其自研引擎,非通用 CRDT。MivoCanvas v1 不复刻此投入。
4. **翻盘条件明确**:若未来出现"多人同段长文本共编"真实场景(如 markdown 协作撰写),再对 `text` 单字段引入 OT/CRDT 层(局部,不拖全局)。

**判决**:**v1 整串 LWW 可接受,文本 gate 放行 Figma 式;不构成 Yjs 一票否决**。

### Gate 2 · 多人 undo/redo + 拖拽 coalescing

**问题**:本地 undo 在远端交错 + 拖拽 coalescing 后语义(只撤自己 op 时远端后写如何保留)。

| 维度 | Figma 式 | Yjs |
|---|---|---|
| undo 模型 | **command 式**(platform §13.2:undo 从快照式渐进换 command 式) | Yjs UndoManager(与现有 command 栈关系 N1 §7 未列决) |
| 拖拽 coalescing | `G2-1` 实证:100 个 drag op → 1 undo entry(Ctrl+Z 一次撤整段) | Yjs 无原生 coalescing,需自建 |
| 远端交错 | `G2-2` 实证:remote op 不入本地 undo 栈,undo 只撤自己 op,远端 op 保留 | Yjs UndoManager 跨 record 交错关系未列决(N1 §7) |

**证据**:`G2-1`(coalescing 100→1)、`G2-2`(remote op 不入栈,undo 只撤自己 1 entry,远端 B 的 op 保留)。

**成本**:
- Figma 式:command 序列化(platform §13.2 已在计划,T2.3 `CanvasCommand` 已起步)+ coalescing 逻辑(client-side,低)。
- Yjs:UndoManager 与 command 栈关系需立项(N1 §7 明列未决)+ 双真相源(undo 跨 Y.Doc/kernel 边界)。

**go/no-go**:**Figma GO**。command 式 undo 与 platform §13.2 / T2.3 已有方向一致;Yjs UndoManager 增未决项。

### Gate 3 · 跨 record invariant / 事务

**问题**:node-delete+edge、group/frame、result node+asset ref、delete-vs-update 的原子边界。

| 维度 | Figma 式 | Yjs |
|---|---|---|
| node-delete + edge cascade | `G3-1` 实证:server-side `deleteNodeCascade` 同一 op 删 node + 级联删引用 edge(事务边界) | CRDT 无原子多 record:node 删 + edge 清理是两独立 op,中间窗口 edge 可查到孤儿 from |
| delete-vs-update | `G3-2` 实证:A 删 + B 并发 update → delete wins(B 落 not-found,非 409 重试) | CRDT delete vs update 是 op 因果序裁决,可能 update 复活已删 record |
| group/frame 原子 | server-side 事务:group 删 → 成员解组原子 | CRDT 难表达 |
| result node + asset ref | 事务:生图结果落 node + asset ref + refcount 增,原子 | CRDT 无事务,refcount 竞态 |

**证据**:`G3-1`(删 n1 → e1/e2 级联删,e3 保留)、`G3-2`(delete wins,update 落 not-found)。

**成本**:
- Figma 式:server-side 事务路径(N2-1 "严格事务路径,非 LWW");PG 已有事务能力(backend.ts `upsertChild` 内可扩事务)。
- Yjs:**无法表达原子多 record**——CRDT 是 per-record 最终一致,这是 CRDT 与 Figma 式的**根本能力差**。

**go/no-go**:**Figma GO**(CRDT 失此 gate,非否决项但根本性能力差)。

### Gate 4 · revision × 属性 LWW 兼容协议

**问题**:(A) cutover 前受控修订 #194 / (B) 保留严格 endpoint + 新增 versioned ops endpoint。

| 维度 | 方案 A(受控修订 #194) | 方案 B(严格 endpoint + versioned ops) |
|---|---|---|
| wire 演进 | 原地演进 `PATCH /nodes/:nodeId` payload:整 record → field-level ops(`{opId,clientId,actor,baseRevision,recordId,fieldPath,value}`) | 新增 `POST /nodes/:nodeId/ops`(versioned);#194 PATCH 冻结不动 |
| envelope | If-Match 400/428/409 不变(`G4-3` 实证 428);revision-conflict 语义演进为 field-aware | 双 endpoint 并存 |
| revision 语义 | per-record,每 accepted op bump,**只供 snapshot/catch-up,不参与 LWW 拒写**(`G4-4` 实证 base 落后仍接受不同字段 op) | 同 |
| 生产破坏面 | **#194 未接线生产**(`unwiredServerPersistAdapter` 全 reject)→ 零生产破坏,只更新契约测试 | 不动 #194,新 endpoint 独立上线 |
| 迁移窗口 | 无双协议窗口(原地演进) | 双 endpoint 并存窗口 + 客户端分叉 |
| 契约测试 | 改 #194 contract test(payload schema + field-level 断言) | 新 endpoint 新 contract test,#194 不动 |

**证据**:`G4-1`(不同字段双留)、`G4-2`(嵌套叶子双留)、`G4-3`(If-Match missing→428)、`G4-4`(base 落后不同字段→接受,revision 不拒写)。

**成本**:
- 方案 A:改 #194 `validateChildPayload`(整 record 白名单 → field-level op schema 校验)+ `upsertChild`(整 record 替换 → field-level merge);契约测试更新。**无新 endpoint、无双协议窗口**。
- 方案 B:新 endpoint + 双 endpoint 并存 + 客户端分叉判断 + 迁移窗口治理。

**go/no-go**:**方案 A GO**。理由:**#194 未接线生产,零破坏面**;方案 B 的"不动 #194"优势在 #194 已上线生产时才成立,目前 #194 仍是 `unwiredServerPersistAdapter`——方案 B 付双 endpoint 税却无收益。方案 A 直接产出 N2-1 契约(§10)。

### Gate 5 · 实时 transport + auth spike(网关 gate)

**问题**:真实 SSO 网关下 WS upgrade 是否放行;两案各自 fallback。

**仓库侧协议/头分析(本 spike 范围内可定)**:
- 鉴权链(`server/lib/owner.ts`):`x-mivo-auth-user`(SSO username)+ `x-mivo-gateway-secret`(网关注入,客户端不可构造,fail-closed:无密钥→任何模式不信任 SSO header)。**全 HTTP-header-based**。
- WS upgrade 是 HTTP GET + `Upgrade: websocket`;要让 BFF 鉴权 WS,网关须在 WS handshake headers 注入同链(`x-mivo-auth-user` + `x-mivo-gateway-secret`)。**网关是否代理 WS upgrade + 注入 header = 未验证项,留 lead 生产网关实测**(本 spike 不连生产网关)。
- SSE(EventSource)= plain HTTP GET + `text/event-stream`;**任何 HTTP 网关必透传**(与 PATCH 同通道),鉴权走同 header 链(或 `?token` query + 网关注入,EventSource 原生不支持自定义 header,需 polyfill 或 query token)。

| 维度 | Figma 式 | Yjs |
|---|---|---|
| 主通道 | REST PATCH(#194,已建)+ SSE 广播(`G5-1` skeleton) | y-protocol 双向 WS(`y-websocket`/`y-protocols`) |
| 网关 WS 不放行时 | **SSE fallback 实时广播仍可用**(plain HTTP);WS 仅作低延迟优化 | 需 `y-signal-http` polling fallback,**失 CRDT 实时合并价值**(退化为本轮已否决的 polling) |
| auth 复用 | 复用 #194 SSO header 链(SSE 走 HTTP,同链) | WS handshake 需网关注入同链到 upgrade 请求(未验证) |
| presence | SSE 单独 channel 或 WS(选作优化) | y-protocols presence(依赖 WS) |

**证据**:`G5-1`(SSE broadcast skeleton,经 HTTP response stream,不经 WS upgrade)。

**成本**:
- Figma 式:SSE 服务端实现(BFF 单实例起步,合并 P0.3 连接预算);WS 作 N2-2 优化项,非依赖。
- Yjs:y-websocket server runtime + WS 鉴权 + 网关 WS 放行依赖;不放行→polling 退化为已否决方案。

**go/no-go**:**Figma 式 REST+SSE GO**。**网关 gate 判决**:**Figma 式不依赖 WS 网关验证**(SSE 走 HTTP 必透传);**Yjs 依赖 WS 网关放行**(未验证项)→ 网关 gate 对 Yjs 不利、对 Figma 式中性。

**未验证项(留 lead 生产实测)**:
1. 生产 SSO 网关是否代理 WS upgrade + 注入 `x-mivo-auth-user`/`x-mivo-gateway-secret` 到 handshake;
2. SSE 长连接在网关的超时/缓冲策略(是否需心跳保活);
3. 网关对 `text/event-stream` 的 streaming 行为(有无缓冲聚合)。

→ **这些不影响选型(Figma 式有 SSE fallback 兜底),只影响 N2-2 是否上 WS 优化**。lead 在 N2-2 前做生产网关 WS 实测即可。

### Gate 6 · 迁移 / 双协议窗口

**问题**:#194 / PG JSONB / FX-5 / stale-client 的迁移。

| 维度 | Figma 式 | Yjs |
|---|---|---|
| #194 wire 迁移 | **未接线→原地演进为 field-level ops**,无双协议窗口(方案 A) | legacy PATCH ↔ Y.Update bridge + per-canvas CRDT flag(Q4 翻译规则) = 真双协议窗口 |
| PG schema | JSONB payload 不透明(已如此);field-level merge 是 server 逻辑,非 schema 变更 | Y.Doc state 序列化(update log + snapshot)需新存储形态 |
| FX-5 | 客户端 durable 写失败重试队列(IDB,PR #200)留作"提交 intent 的网络失败重试",非执行队列(计划 §7 D-1+D-2 已纠类别) | offline edit 队列与 FX-5 关系(N1 §6 Q8)需定 |
| stale-client | 409 revision-conflict → refetch + 重放(§10 契约) | state-vector 比对 + 增量拉(N1 §6 Q8) |

**证据**:#194 `unwiredServerPersistAdapter`(未接线)+ `G4-3` 428/409 envelope + `G7-1` ?since=seq 补拉。

**成本**:
- Figma 式:0 双协议窗口(原地演进 #194);PG JSONB 不动;FX-5 不动;stale-client 走 409 重载(已有)。
- Yjs:legacy↔CRDT bridge 翻译规则(Q4:整 record 替换会退化 CRDT 细粒度,字段级 diff 才保)+ per-canvas flag + 双协议并存窗口治理。

**go/no-go**:**Figma GO**(无双协议窗口,迁移面最小)。

### Gate 7 · 事件序号 / 补拉日志 / 压缩、权限撤销、性能与存储放大

| 维度 | Figma 式 | Yjs |
|---|---|---|
| 事件序号 | per-canvas 单调 seq(`G7-1` 实证) | Y.Doc op 的 (clientID,clock);无单一 "seq" |
| 补拉日志 | `?since=seq` 增量补(`G7-1` 实证:断线重连只补 missed) | state-vector 比对 + 增量拉(N1 §6 Q8) |
| 压缩 | `snapshot + truncate opLog`(`G7-2` 实证:1000 op→保留 50,存储 20x↓) | Y.Doc snapshot + GC(N1 §6 Q3/Q10,无界增长须 GC) |
| 权限撤销 | 连接绑 actor+canvas+authz;`removeMember`→断流 + 不再收变更(`G7-3` 实证) | Y.Doc per-canvas 共享,revocation = 断单用户 + 防重连 = **doc 级访问控制(更难)** |
| 性能 | field-level merge server-side(按 fieldPath,不整 record);SSE 轻量 | Y.Doc applyUpdate 全 op log 重放;高频 update 触发 React 重渲染未压测(N1 §4 未验证项) |
| 存储放大 | record payload(不透明 JSONB)+ 有界 op log(truncate) | update log(无 GC 无界)+ snapshot + GC 成本 |

**证据**:`G7-1`(seq 补拉)、`G7-2`(压缩 1000→50)、`G7-3`(revoke 断流 + 撤权后变更不推)。

**成本**:
- Figma 式:op log + 周期 snapshot+truncate(简单,server 控制);revoke 直观(连接绑 actor+canvas)。
- Yjs:Y.Doc GC 复杂(N1 Q3/Q10 未决);revoke 难(共享 doc);存储放大(update log + snapshot + GC)。

**go/no-go**:**Figma GO**(revoke 简单 + 存储有界 + 无未压测渲染路径)。

---

## 3. 七 gate 汇总判决表(见 §0,此处不重复)

→ 见 §0 判决表。**全部 7 gate 倾 Figma 式**;文本 gate 不否决;网关 gate 对 Yjs 不利(留 lead 实测但不影响 Figma 选型)。

---

## 4-8. (并入 §2 各 gate 小节,不单列)

---

## 9. PoC 清单与实跑结果

**文件**:`src/kernel/__spike__/n20-truth-source.spike.test.ts`(隔离,不入生产 bundle;同 N1 约定,`yjs` 仅 devDep)。

| PoC | gate | 断言 | 实跑 |
|---|---|---|---|
| G4-1 不同字段并发(A transform.x / B title)→ 双留 | 4+1 | `n.transform.x===100 && n.title==='B-title' && revision===rev0+2` | ✅ 1ms |
| G4-2 嵌套叶子并发(A transform.x / B transform.y)→ 双留 | 4 | `x===10 && y===20`(非整 transform 替换) | ✅ 0ms |
| G1 文本同字段并发(A/B 都改 text)→ LWW 取后者 | 1 | `n.text==='B-text'`(整串,非 char-merge) | ✅ 0ms |
| G4-3 If-Match missing → 428 | 4 | `r.kind==='precondition-required'`(#194 envelope 不变) | ✅ 0ms |
| G4-4 revision 不拒写(base 落后不同字段仍接受) | 4 | `rb.kind==='ok' && n.title==='A' && n.transform.x===50` | ✅ 0ms |
| G3-1 node-delete + edge cascade 原子 | 3 | `deletedEdges===2 && edgeCount===1 && getNode('n1')===undefined` | ✅ 0ms |
| G3-2 delete-vs-update → delete wins | 3 | `rb.kind==='not-found'` | ✅ 0ms |
| G2-1 拖拽 100 op → coalescing 1 undo entry | 2 | `depth===1 && undo()!==null && length===1` | ✅ 0ms |
| G2-2 undo 只撤自己,远端交错保留 | 2 | `remoteSeenCount===1 && depth===1 && undo().length===1` | ✅ 0ms |
| G7-1 per-canvas seq + ?since=seq 补拉 | 7 | `missed.length===1 && seq===3` | ✅ 0ms |
| G7-2 snapshot + truncate(1000→50) | 7 | `snapshotSize===2 && logKept===50 && logTruncated===950` | ✅ 7ms |
| G7-3 权限撤销断流 + 不再收变更 | 7 | `received==='__revoke__' && isConnAlive===false && 后续 received.length===0` | ✅ 0ms |
| G5-1 SSE=plain HTTP broadcast skeleton | 5 | `stream contains 'seq=1:title'` | ✅ 0ms |
| antiYjs-坑5 revision↔Yjs 双真相源背离 | — | `Y.Map rev===7 && kernel rev===8`(持续背离) | ✅ 2ms |
| antiYjs-坑7 writeRecord clear+rebuild 吞子字段 | — | `mergedTransform.y===-20`(B 的 999 丢失) | ✅ 1ms |

**实跑汇总**:`15 tests 全绿`,`Test Files 1 passed`,Duration 168-187ms,test body ~14ms。`tsc -b` + `eslint` + `npm run build` 全绿(exit 0);`grep -roE 'yjs|lib0|YEvent|applyUpdate|AbstractType|encodeStateAsUpdate' dist/` **零命中**(yjs 不进生产 bundle)。

---

## 10. G1-c / N2-1 唯一契约草案(决议后直接落地,无第二模型死接口)

> 依据:gate 4 方案 A + gate 5 REST+SSE + gate 7 seq/补拉/压缩/revoke。**这是唯一契约——选 Yjs 则替换为 Y.Doc 通道,但本决策已否决 Yjs,故此契约唯一。**

### 10.1 op schema(field-level,走 #194 PATCH envelope)

```ts
type FieldOp = {
  opId: string            // 幂等键(复用 #194 idempotency-key 链路)
  clientId: string        // 客户端实例 id(拖拽 coalescing + undo 关联)
  actor: string           // SSO user id(owner.ts 链)
  recordId: string        // 目标 record id(node/edge/anchor)
  baseRevision: Revision // If-Match base(#194 N5:missing→428,invalid→400)
  fieldPath: (string | number)[]  // 属性级路径,如 ['transform','x'] / ['text'] / ['title']
  value: unknown          // 叶子值;__delete__ 标记 = 删除(record 级走 §10.4 事务路径)
}
```

### 10.2 wire(#194 envelope 不变,payload 演进)

- `PATCH /api/canvas/:id/nodes/:nodeId` — payload = `FieldOp` 或 `FieldOp[]`(批量,同 record)。
- If-Match: `baseRevision`(400/428/409 复用 #194 `parseIfMatch` + `revision-conflict` body)。
- 响应:`{ id, revision, seq }`(`UpsertResponse` 扩 `seq`)。

### 10.3 服务端合并(field-level LWW,非整 record 替换)

- `upsertChild` 演进:`validateChildPayload` 改 field-level op schema 校验(逐 fieldPath 白名单,拒 unknown);merge = 按 `fieldPath` set 叶子(本 spike `setByPath` 原型),**永不 `clear` 整 record**(N1 坑7)。
- revision:每 accepted op bump(per-record);**只供 snapshot/catch-up + legacy cache 校验,不参与 LWW 拒写**(gate 4 `G4-4`)。
- 同 `fieldPath` 并发:server seq LWW(后者 wins,整串;gate 1 文本 gate 接受)。
- 全序 `seq`:per-canvas 单调事件序号(gate 7 `?since=seq` 补拉)。

### 10.4 跨 record invariant = 严格事务路径(非 LWW)

- `deleteNodeCascade(nodeId)` 等 server-side 事务:node 删 + edge 级联 + asset ref 清理,同一 PG 事务原子(gate 3 `G3-1`)。
- delete-vs-update:delete wins,update 落 not-found(gate 3 `G3-2`,非 409 重试)。
- group/frame、result node+asset ref 同走事务路径。

### 10.5 实时通道(REST + SSE;WS 选作 N2-2 优化)

- 写:`PATCH`(#194,已建)。
- 广播:SSE(`/api/canvas/:id/events?since=seq`),plain HTTP,网关透传,鉴权走 SSO header 链(gate 5 `G5-1`)。
- WS:N2-2 选作低延迟优化(非依赖);**网关 WS 放行 = 留 lead 生产实测**,不放行则 SSE 兜底。
- presence:WS(若可用)或 SSE 单独 channel。

### 10.6 权限撤销 / 补拉 / 压缩

- 连接绑 `actor+canvas+authz`;`removeMember`/撤销 share → 断流 + 后续变更不推(gate 7 `G7-3`)。
- 断线重连:`?since=seq` 增量补(gate 7 `G7-1`)。
- 压缩:周期 snapshot + truncate opLog(gate 7 `G7-2`)。

### 10.7 迁移 / 双协议窗口

- **无**(gate 6):#194 未接线→原地演进;PG JSONB payload 不透明不动;FX-5 留客户端重试;stale-client 409→refetch。

---

## 11. 改写 N1 Q1-Q5 答案(原 N1 §6 决策清单,本决策覆盖)

| # | N1 原问 | N1 spike 倾向 | **N2-0 改写答案** |
|---|---|---|---|
| Q1 | CRDT doc 真相源归属 | (a) Y.Doc 为唯一真相,DocKernel 降投影 | **反转**:**DocKernel(server-persisted record)为唯一真相源;NOT Y.Doc**。理由:现有底座是 Figma 式(§1),Yjs 移植拆写路径 + 双真相源(坑5);gate 3 跨 record 事务 CRDT 做不到。DocKernel 演进为 field-level merge(gate 4 方案 A),revision 派生但服务端赋值。 |
| Q2 | revision 派生算法 | (a) Y.Map op 计数 (b) state-vector clock (c) 内容 hash | **不适用 Yjs 派生**:**revision = per-record 服务端赋值的单调整数(每 accepted op +1)**,非 Yjs state 派生。用途:仅 snapshot/catch-up + legacy cache 校验,**不参与 LWW 拒写**(gate 4 `G4-4`)。 |
| Q3 | server 持久化 Y.Doc 形态 | (a) update log (b) snapshot (c) 两者+GC | **不适用(不采 Yjs)**:server 持久化 = record payload(PG JSONB,不透明,已如此)+ per-canvas op log(seq)+ 周期 snapshot+truncate(gate 7 `G7-2`)。无 Y.Doc update log/GC。 |
| Q4 | legacy↔CRDT bridge 翻译规则 | 整 record 替换 vs 字段级 diff | **不适用(无 CRDT 路径)**:legacy = 唯一路径;field-level PATCH 原地演进 #194(gate 6,无 bridge、无双协议窗口)。 |
| Q5 | order_key/z-order CRDT 策略 | (b) 显式 order_key 标量+LWW | **维持 (b),且经服务端管**(非 Y.Array):`reorderChildren`(#194 已建,If-Match contentVersion + 全等唯一校验 + 重分配 orderKey)。**不用 Y.Array delete+insert**(避 N1 坑3 并发 reorder 不保序)。 |

> Q6-Q10(Y.Array 元素 id、presence、断线重连、chat CRDT、Y.Doc GC)随 Yjs 否决一并 **不适用**;其语义由 Figma 式等价覆盖:presence→SSE/WS channel;断线重连→?since=seq 补拉;chat→per-user 独立 collection(DP-6R,非 CRDT);GC→snapshot+truncate。

---

## 12. 未验证项 / 留 lead

| 未验证项 | 影响谁 | 处理 |
|---|---|---|
| 生产 SSO 网关 WS upgrade 放行 + header 注入 | N2-2(WS 优化)/ Yjs(致命) | **留 lead 生产网关实测**;Figma 式有 SSE fallback 兜底,不影响 N2-0 选型 |
| 网关对 `text/event-stream` 缓冲/超时 | N2-2 SSE | lead 实测,必要时加心跳 |
| 20k 节点高频 update 渲染性能 | N2-1/N2-2 | 复用 §12 风险4 的 26.7ms p95 基线,N2-2 做 pan bench(对齐 N1 §4 未验证项) |
| per-field clock 精确 stale 判定 | N2-1 实装 | 本 spike 简化为 server seq LWW;生产加 per-field clock(契约 §10.3 预留) |
| canvas 文本同段共编真实需求 | 未来 | 若出现,N2-1 后对 `text` 单字段局部引入 OT/CRDT(不拖全局) |

---

## 13. 与计划/上游对齐

- **计划 §8 N2-0 七项 hard gate**:逐项两案 + 证据 + 成本 + go/no-go(§2);文本 gate 判决(§2 gate 1,不否决);网关 gate 判决(§2 gate 5,留 lead);唯一推荐 + G1-c/N2-1 契约(§10);改写 N1 Q1-Q5(§11)。✅ decision-complete。
- **计划 §4 G1-b/G1-c**:G1-b 两案契约 inventory 冻结为 Figma 式唯一(§10);G1-c 落本契约,无 Yjs 死接口。
- **计划 §8 N2-1**:op schema/field 边界/seq/revision 用途/事务路径 = §10 契约直接落地。
- **platform §6 CRDT-ready**:映射可行性保留(N1 证);但**采用 Yjs 否决**——CRDT-ready = 字段扁平可映射,不等于必须采 Yjs。属性级 LWW(field-level PATCH)满足"协作肯定要做"的演进不返工承诺。
- **platform §13.5 Figma 式**:与本法一致。

---

## 附:spike 文件结构索引

`src/kernel/__spike__/n20-truth-source.spike.test.ts`:
- `makeNode` fixture + `setByPath` 嵌套字段 set
- `FieldLevelServer`:field-level applyOp(#194 envelope)+ deleteNodeCascade(事务)+ pullSince/compress(补拉/压缩)+ addMember/removeMember(addConn/revoke 断流)
- `CommandUndoStack`:pushDrag(coalescing)+ pushRemote(不入栈)+ undo(选择性撤自己)
- G4+G1(5 tests)/ G3(2)/ G2(2)/ G7(3)/ G5(1)/ antiYjs 坑5+坑7(2) = **15 tests 全绿**
