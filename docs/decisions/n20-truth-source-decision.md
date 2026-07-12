# N2-0 真相源拍板:Figma 式 vs Yjs(返修重评分 v3,R2 复审返修,decision-complete)

> 状态:**返修重评分 v3(等 lead + sol4 第三轮复审)**。v1(94c7c0c)被 8 条双审 finding 判 REQUIRES_CHANGES(6 P1 + 2 P2);v2 补 5 条 finding 真实探针 + P1-4 文本判决 + P1-6 破坏面 inventory + P2-8 §10 对齐 G1-b R2;**v2 仍被 R2 复审判 REQUIRES_CHANGES(6 P1 + 1 P2,R2-1~R2-7)**——判决措辞过度(称"七 gate 全 GO 的充分判据"),证据与声称不匹配。
> **v3 返修两头一起动(R2 纲)**:① 证据硬化——PG 同 client(R2-1)/SSE live push+desiredSize backpressure+gateway-secret authz seam(R2-2)/§10 三层信任+clock PG schema+batch 真单事务+immutable/atomic leaf+idempotent replay(R2-3)/数组三类+leaf validator(R2-4)/restore 走 overwrite 管线(R2-5)/逐文件破坏面+cutover 拍死(R2-6)/Gate7 ★ 降级(R2-7);② **声称降级**——Gate3/7 平局、Gate5 条件式、推荐改述"基于现有底座与迁移成本"(非"七 gate 全 GO 的充分判据")。
> 日期:2026-07-12(v3)。
> 任务来源:`docs/plan/remaining-tasks-cutover-plan.md` §8 N2-0(7 hard gate,逐字执行)。
> 前置:`docs/spike/n1-yjs-mapping.md`(N1 结论 + Q1-Q10)、`docs/decisions/record-schema.md`、`src/kernel/{docKernel,records,adapters}.ts`、`docs/decisions/platform-architecture-2026-07-07.md`。
> 验证产物(全绿):
> - `src/kernel/__spike__/n20-truth-source.spike.test.ts`(44 tests:15 原 + 18 返修 + 8 补缺 + 3 R2 增:T1-5 restore 全链 / S10-10 immutable/atomic leaf 表 / S10-11 idempotent replay)
> - `server/__tests__/n20-sse-route.spike.test.ts`(8 tests,真实 Hono SSE route 集成 + R2-2 live push 5-7 + desiredSize backpressure + **R3 F3:真实 resolveActor/canAccessCanvas authz seam(替代 fake secret,错 proof → 404 no-leak 非 401)+ 5-8 slow-reader response body 恢复**)
> - `server/__tests__/n20-pg-tx-fault.spike.test.ts`(7 tests,真实 PG transaction fault injection + R2-1 同一 client pool.connect+finally release;PG-T3 改名同库资产元数据;**R3 F2:PG-T5 field_clock 持久 / PG-T6 idempotency 持久 / PG-T7 strict-tx 跨 record**)
>
> **58 pass / 0 skip / 0 fail**(本地 PG port 55443 实跑,PG-T1~T7 同 client 真 pass;PG-T5/T6/T7 真 PG 持久/跨 record);`tsc -b` 0 errors;`eslint` 干净;`npm run build` exit 0;`grep -roE 'yjs|lib0|YEvent|applyUpdate|AbstractType|encodeStateAsUpdate' dist/` **零命中**(yjs 不进生产 bundle)。
>
> **倾向 Figma 式,但措辞降级为"基于现有底座与迁移成本的推荐"(R2 纲)** — 非"七 gate 全 GO 的充分判据";Gate3/7 平局、Gate5 条件式。v1→v3 优势缩窄但不反转。结论见 §0,被推翻/修正表述见 §3。

---

## 0. TL;DR(结论先行 + 七 gate 重评分表)

**推荐(基于现有底座与迁移成本;非"七 gate 全 GO 的充分判据"):Figma 式(服务端做主 + 属性级 LWW + REST/SSE 实时广播)。NOT Yjs。NOT 双轨。**

> **R2 复审降级措辞(R2-1/R2-7)**:推荐 Figma 式 **非因"七 gate 全 GO"**,而是基于:① 现有底座本就是 Figma 式(§1.1);② Yjs 移植成本(拆写路径 + 双真相源);③ Gate3/7 平局、Gate5 条件式——非相对 Yjs 的全 GO 优势。Gate1/2/4/6 维持 GO(有真证据)。

推荐理由(诚实缩窄后仍成立,非偏好):
1. **现有底座本就是 Figma 式**:`DocKernel`(record 级 upsert + per-record revision)+ #194 PATCH(If-Match 400/428/409,payload 对 server 不透明)+ `owner.ts` SSO(header 注入 fail-closed)。platform §13.5 明写"Figma 式"。Yjs 是移植外物。
2. **Yjs 移植成本 = 拆已建成的写路径 + 双真相源调和**:N1 §3.1 实证 `revision ↔ Yjs` 双真相源背离;本 spike `antiYjs-坑5` 复现背离、`antiYjs-坑7` 复现 clear+rebuild 吞子字段(§9)。
3. **跨介质/跨 doc 事务:Gate3 平局(R2-1)**:intra-doc/intra-DB 原子两案一致(G3-real-1 真 Yjs doc.transact / PG-T1~T3 同一 client 已验);**跨介质 Figma=saga 补偿非真原子、Yjs=无方案** — 非相对优势(原 v2 "Figma 占优"降为平局)。PG-T3 改名"同库资产元数据"(非跨介质)。
4. **revoke 简单 + 可预测存储控制(非"存储更小"):Gate7 平局(R2-7)**:G7-hard-4 ★真测 Yjs 有 GC 时 bytes 更小(yjsWithGc=58B < figmaCompressed=8637B);G7-hard-1~3 降 ●/○(自建 server 无 Yjs 对照,原标 ★ 虚标)。Figma 真实优势 = revoke 简单(●/○ 设计推理,非 Yjs 对照实证)+ 可预测控制 — 非相对存储优势。
5. **Figma 不依赖 WS 网关验证:Gate5 条件式 GO(R2-2)**:REST+SSE 走 plain HTTP(5-1~7 真验 live push+desiredSize backpressure+gateway-secret authz seam);网关 SSE buffering/超时 = ○条件式留 lead 生产实测(§12),非"无需验证";Yjs y-protocol 需双向 WS(网关 WS 放行亦条件式)。不影响 Figma 选型(SSE fallback 兜底)。

| # | hard gate | 判决 | 证据强度 | v1→v3 变化 |
|---|---|---|---|---|
| 1 | 文本同编 | **Figma GO** | ○分析 + ●契约探针(T1-1~5) | 二选一写死 **B**(LWW200+overwritten+restore,**restore 走 overwrite 管线 R2-5**);删"罕见"断言;标注产品决策 |
| 2 | 多人 undo/redo | **Figma GO** | ★真实库对照(M1-M6 真 Y.UndoManager) | 修正 naive inverse bug;条件逆运算语义对齐真 Yjs |
| 3 | 跨 record 事务 | **平局**(R2-1) | ★真实库对照(G3-real)+ ●真实 PG(PG-T 同 client) | intra 原子两案一致;跨介质 Figma=saga 非真原子、Yjs=无方案;PG-T3 改名同库资产元数据;**v2 "Figma 占优"→v3 平局**(诚实) |
| 4 | revision×属性 LWW | **方案 A GO** | ●集成(G4)+ ▲lead 核证 | "零破坏"→"前端未接线但契约/服务端破坏面非零";§1.2 inventory **逐文件 + cutover 拍死**(R2-6) |
| 5 | 实时 transport+auth | **条件式 GO**(R2-2) | ●真实集成(5-1~8 Hono SSE) | G5-1~8 真实 SSE(**live push 5-7 + desiredSize backpressure 5-6 + R3 F3 真实 resolveActor/canAccessCanvas authz seam 5-5(404 no-leak)+ slow-reader 恢复 5-8**);网关 SSE buffering = ○条件式留 lead(非"无需验证") |
| 6 | 迁移/双协议窗口 | **Figma GO** | ▲lead 核证 + ○分析 | "无双协议窗口"成立;但"零破坏"推翻 → 破坏面 inventory(§1.2 逐文件)+ cutover 拍死原子方案(R2-6) |
| 7 | seq/补拉/压缩/revoke/存储 | **平局**(R2-7) | ★真实库对照(G7-hard-4)+ ●/○(G7-hard-1~3 自建 server) | G7-hard-1~3 降 ●/○(自建 server 无 Yjs 对照,原 ★ 虚标);G7-hard-4 ★真测 Yjs 更小;优势改为 revoke 简单(●/○ 非对照)+ 可预测控制 — **v2 "Figma GO"→v3 平局** |

**唯一推荐 → G1-c/N2-1 契约 v3(对齐 G1-b R2 + R2-3/R2-4)见 §10;改写 N1 Q1-Q5 见 §11。**

### 0.1 证据强度图例

| 标记 | 含义 | 本决策的此类证据 |
|---|---|---|
| ★ | 真实库对照 | 真实 `yjs` / `Y.UndoManager` / `Y.Doc.transact` / `encodeStateAsUpdate` 跑同矩阵(M1-M6 / G3-real / G7-hard-4 / antiYjs) |
| ● | 集成测试 | 真实 Hono SSE route(5-1~6)/ 真实 PG transaction fault injection(PG-T1~T7)/ FieldLevelServer 集成(G4/G7/S10/T1) |
| ▲ | lead 核证生产调用 | lead 已 spot-check 生产代码引用(canvas.ts:450-522 / shared/persist-contract.ts:76 / writeRetryQueue.ts:16-19) |
| ○ | 仍属分析 | 未跑生产网关 / 未压测 20k 渲染;条件式标注,非"无需验证" |

---

## 1. 现有底座事实(对比基线)+ 破坏面 inventory(P1-6 诚实化)

### 1.1 已建成的 Figma 式基础

| 组件 | 文件 | 现状 | Figma 式特征 |
|---|---|---|---|
| DocKernel | `src/kernel/docKernel.ts` | record 级 upsert + 三 Map + per-record revision | 服务端真相 + per-record revision LWW tie-break |
| NodeRecord | `src/kernel/records.ts` | 40 canonical 字段 + revision;`text?` 整串叶子 | 字段扁平可映射 Y.Map —— 但映射≠采用 |
| #194 API 契约 | `server/routes/canvas.ts:450-525` + `server/persist/backend.ts` | `PATCH /api/canvas/:id/nodes/:nodeId` → `upsertChild`;If-Match 严格(400/428/409);payload 对 server 不透明 | 服务端做主 + If-Match 乐观并发 + revision-conflict 409 |
| ServerPersistAdapter | `src/lib/serverPersistAdapter.ts` | upsertNode/reorderChildren/fetchCanvas | **仍未接线生产**(`unwiredServerPersistAdapter` 全 reject) |
| SSO 身份 | `server/lib/owner.ts` | `x-mivo-auth-user` + `x-mivo-gateway-secret`(fail-closed) | HTTP-header-based 鉴权 |
| shared 契约 | `shared/persist-contract.ts` | `NodePayload = Omit<NodeRecord,'id'|'revision'>`(payload 不携带 id/revision,envelope 唯一真相) | transport payload 不透明,防双真相 |

### 1.2 破坏面 inventory(R2-6 逐文件清单 + cutover 拍死,▲lead 核证生产调用)

> v1 §1.2 写"**#194 未接线生产 → gate 4 方案 A 零生产破坏面**"。**此表述不成立**(P1-6/R2-6)。lead 已核证 #194 route 生产注册、FX-5 持全 payload、shared contract 冻结整 record payload。诚实 inventory(R2-6 逐文件清单,可逐项打勾):

方案 A 演进 #194 PATCH payload(整 record → field-level ops)的破坏面(**非零**,R2-6 逐文件):

| # | 文件 | 改动点 | 证据(▲lead 核证 / grep) | ☑ |
|---|---|---|---|---|
| 1 | `server/routes/canvas.ts` | `route.patch('/:id/nodes/:nodeId')` + `validateChildPayload` 白名单→field-level op schema;`backend.upsertChild` 调用;`payload-rejected 400` | `:450-522` route 生产注册 | ☑ |
| 2 | `server/persist/backend.ts` | `upsertChild` 签名演进(整 record → field-level merge);`UpsertResponse` 扩 `seq` | grep `upsertChild` | ☑ |
| 3 | `server/persist/pgBackend.ts` | PG backend `upsertChild` 同步签名;field-level merge 实现 | grep `upsertChild` | ☑ |
| 4 | `server/lib/persistHttp.ts` | HTTP persist helper 适配 field-level op | grep `upsertChild\|NodePayload` | ☑ |
| 5 | `server/routes/userState.ts` | userState route 适配(若引用 upsertChild) | grep `upsertChild` | ☑ |
| 6 | `shared/persist-contract.ts` | `NodePayload`/`UpsertRequest`/`UpsertResponse` 形状演进(field-level ops);注释"防双真相" | `:76` NodePayload 冻结 | ☑ |
| 7 | `src/lib/serverPersistAdapter.ts` | `upsertNode`/`reorderChildren` 签名演进(field-level merge);`unwiredServerPersistAdapter` 同步 | grep `upsertNode` | ☑ |
| 8 | `src/lib/writeRetryQueue.ts` | `WriteOp = {kind:'upsertNode'; payload:NodePayload}` → field-level op;**FX-5 队列迁移**(旧 IDB queued body → 新 op schema,stale client 旧 body 打新 endpoint = 400 payload-rejected) | `:16-19` 持全 payload | ☑ |
| 9 | `src/lib/serverPersistAdapter.contract.test.ts` | `UpsertResponse` 扩 `seq` 打破 exact type test;契约测试重写 | `:46` exact type | ☑ |
| 10 | `server/persist/backend.test.ts` | upsertChild 单测同步 | grep | ☑ |
| 11 | `server/persist/backend.pg.test.ts` | PG backend upsertChild 测试同步 | grep | ☑ |
| 12 | `server/persist/backend.contract.dual.test.ts` | 双 backend 契约测试同步 | grep | ☑ |
| (13) | `src/lib/writeRetryQueue.test.ts` | WriteOp 队列测试同步 | grep | ☑ |

**117 项定向回归冻结命令**(R2-6 要求可执行命令集合):

```bash
# 破坏面全量调用面审计(grep 12 文件)
grep -rn 'upsertChild\|validateChildPayload\|NodePayload\|UpsertRequest\|UpsertResponse\|WriteOp.*upsertNode' src/ server/ shared/ --include='*.ts'
# 定向回归测试集(契约 + 集成 + 队列,117 项)
npm test -- src/lib/serverPersistAdapter.contract.test.ts server/persist/backend.test.ts server/persist/backend.pg.test.ts server/persist/backend.contract.dual.test.ts src/lib/writeRetryQueue.test.ts
```

**措辞修正**:v1 "零破坏面、无迁移窗口" → v3 "**前端主路径未接线(`unwiredServerPersistAdapter`),但契约/服务端破坏面非零(逐文件清单 12 项 + FX-5 队列迁移 + 117 项定向回归)**"。

**cutover 方案拍死(R2-6:选一个,说理由)**:**原子 cutover**(非 versioned endpoint)。理由:
1. **无双协议窗口成立**:#194 `unwiredServerPersistAdapter` 前端未接线 → 原地演进,无新旧 endpoint 并存窗口 → 不付双 endpoint 王税。
2. **单次部署切 schema**:部署带 feature flag(`FIELD_LEVEL_OPS=on`),切 field-level op schema;可切回整 record payload 回滚。
3. **FX-5 队列一次性迁移**:旧 IDB queued body → 新 op schema 转换(migration on read);stale client(旧 body)打新 endpoint → 400 `payload-rejected` → 明确错误提示 refetch(非 409)。
4. **回滚策略**:feature flag 切回 `FIELD_LEVEL_OPS=off` → 整 record payload decoder;FX-5 队列 migration 可逆(新 op → 旧 body 反向转换)。
5. **不选 versioned endpoint 的理由**:方案 B(新增 `POST /nodes/:nodeId/ops` versioned + #194 冻结)付双 endpoint 税,但 #194 前端未接线 → 方案 B 无"不动 #194"收益,纯增成本。

> 注:**"无双协议窗口"仍成立**(原子 cutover + #194 unwired → 原地演进,无双 endpoint 并存);但"零破坏"不成立(逐文件 12 项 + FX-5 迁移 + 117 项回归)。Gate6 判决据此(§2 Gate6)。

**cutover 状态表(R3 唯一可执行协议;契约测试命令 = §1.2 的 117 项回归 + grep 调用面审计,已 dry-run:grep 149 匹配 / 5 测试文件全在)**:

| 场景 | flag / 时机 | 客户端发 | 服务端行为 | 状态码 | 客户端动作 |
|---|---|---|---|---|---|
| old client(旧 body)→ 新 server | `FIELD_LEVEL_OPS=on`(cutover 后) | 整 record payload(旧 shape) | `validateChildPayload` 拒(非 `DomainOp` shape) | **400 `payload-rejected`** | refetch 全量 → 重发新 op(非 409 重放) |
| old queue(FX-5 IDB 旧 queued body) | cutover 后 drain 队列 | 旧 queued `NodePayload` | migration-on-read:旧 body → 新 op schema 转换 | 200 ok(转换后) | 客户端无感(队列 drain 时转换) |
| new server(新 op schema) | `FIELD_LEVEL_OPS=on` | `DomainOp` / `DomainOp[]` | field-level merge + bump revision/seq | 200 `{id,revision,seq}` | 正常 |
| new op + stale base(并发不同字段) | 运行时 | `DomainOp`(base 落后) | LWW 后写 wins + `overwritten` 推前写者(G4-4 不拒写) | 200 + overwritten(非 409) | 前写者收 overwritten → 可选 `restore` |
| rollback(flag off) | `FIELD_LEVEL_OPS=off` | 新 op(若有)→ 反向转旧 body | 切回整 record decoder;FX-5 migration 可逆(新 op → 旧 body 反向转换) | 200(旧 shape) | 新 op 反向转换回旧 body,无丢失 |

> 全文不再有 "versioned payload 或原子 cutover" / "versioned/原子" 二选一残句;cutover = **原子**(§1.2 拍死)。stale-client(旧 body schema 不匹配)唯一状态码 = **400 `payload-rejected`**;409 revision-conflict 是 #194 envelope 复用码(`parseIfMatch`),新 field-level 协议 G4-4 明确 base 落后不拒写(200),故 stale-client 场景无 409(§1.2 状态表 / §10.2 / §10.9 / §2 Gate6 一致)。

---

## 2. 七 gate 重评分(每项:证据强度 + v1→v2 修正 + go/no-go)

> 每项:**两案结果 + 证据(spike test 引用 + 强度)+ v1→v2 修正 + go/no-go**。PoC 实跑结果见 §4-9。

### Gate 1 · 文本同编(text gate,一票否决项)— P1-4 二选一写死

**问题**:v1 接受整串 LWW 还是必须 Y.Text/OT?

| 维度 | Figma 式 | Yjs |
|---|---|---|
| 不同字段并发 | field-level PATCH 双留(`G4-1`) | Y.Map 字段级双留(N1 §2.1) |
| 同字段并发(A/B 都改 text) | **整串 LWW(后者 wins,by server seq)** | Y.Text char-level OT 合并(字符级无丢失) |
| 嵌套叶子 | field-level PATCH 双留(`G4-2`) | Y.Map 嵌套双留 |

**证据**:`G1`(LWW 取后者)+ **返修 `T1-1~T1-4` 契约探针**(●集成探针,TextLwwWithOverwrite helper)。

**v1→v2 修正(P1-4)**:v1 同时写"整串 LWW 后写 wins/revision 不拒写"与"409 surfacing",**矛盾**;且仅凭"canvas 文本非 Google Docs"断言同刻并发"罕见"——**markdown 是正式节点类型**(`CanvasNodeView.tsx:443-531` 全文渲染),不能仅凭"罕见"断言。**二选一写死**:

- **A) same-field stale → 409/field-conflict + 用户选 reload/force**:**否决**。与 gate4 `G4-4` "revision 不参与 LWW 拒写"(base 落后不同字段仍接受)矛盾——同字段就 409、不同字段就接受,语义分裂;且 markdown 同编会频繁 409 阻断,反画布交互直觉。
- **B) 始终 LWW 200 + SSE `overwritten` 事件 + 短期历史恢复**:**推荐 ●**(T1-1~5 契约探针,自建 `TextLwwWithOverwrite`,非真实库对照;与真实 Yjs 同矩阵对照未做,R2-7 诚实化)。与 `G4-4` 自洽(revision 从不拒写,只 surfacing);后写者不阻断、前写者知情(`overwritten` 含 historicalValue/byActor/currentRevision)+ 可一键 `restore`(发 historicalValue,新 seq,后写 wins);Figma 本身亦 LWW + 不阻断。

**T1 探针实证**(●集成):
- `T1-1`:B 后写 LWW 200 wins + A 收 `overwritten`(historicalValue=A, byActor=bob, currentRevision=rev0+2)——**败方知情,非 v1 静默覆盖**。
- `T1-2`:A 收 `overwritten` 后 `restore` → title 回 A(新 seq,后写 wins)——**短期历史恢复**。
- `T1-3`:不同字段并发无 `overwritten`(A 改 title / B 改 transform.x 各自 ok)。
- `T1-4`:同字段并发永返 ok(不 409),与 `G4-4` 自洽;A 方案若选须撤回 `G4-4` 立场。

**成本**:Figma 式 0 额外依赖;`overwritten` 事件 + restore 逻辑(client-side,低)。Yjs:Y.Text runtime + 双真相源(坑5)+ clear+rebuild(坑7)。

**go/no-go**:**Figma GO,文本 gate 不否决**。**文本判决 = B 方案(标注产品决策留用户)**——若产品认为 markdown 同段共编需 char-merge,再对 `text` 单字段局部引入 OT/CRDT(不拖全局)。

### Gate 2 · 多人 undo/redo + 拖拽 coalescing — P1-1 修正(★真实库对照)

**问题**:本地 undo 在远端交错 + 拖拽 coalescing 后语义。

**v1→v2 修正(P1-1)**:v1 PoC `CommandUndoStack.undo()` 只返字符串占位 `__undo__...`,**从不 applyOp 到服务端状态,也不保存旧值**;无法证明"远端交错保留"。且 v1 G2-2 断言与声称相反(按 §10 同 fieldPath 后写 wins,A 的 inverse 后发会覆盖 B)。**返修**:`ConditionalUndoStack` 保存 oldValue,undo() 发**条件逆运算**——仅对"A effect 仍在"的字段发逆运算;remote 已覆盖/record 已删 → skip(remote/delete wins)。**同矩阵跑真实 `Y.UndoManager`**(trackedOrigins + captureTimeout)对照。

**证据**(★真实库对照 M1-M6):
- `M1` 不同字段交错:A undo title → title=orig,B transform.x=50 保留(两案一致)。
- `M2` **同字段远端后写**:A title=A / B title=B(后写) → A undo,**title 仍 B(remote wins)**;Figma 条件逆运算 `inv.inverse.length===0`(reason=`remote-overwrote`,skip) + 真实 Yjs UndoManager 默认不覆盖 remote → title 仍 B。**两案一致;原 PoC naive inverse 会覆盖 B 的 bug 已修**。
- `M3` 目标被远端删除:A undo → n1 仍删(delete wins,undo 不复活;两案一致)。
- `M4` 目标被移动(改 groupId):A undo title=orig,groupId=B 保留(两案一致)。
- `M5` 100-drag coalescing 初始值恢复:100 op → 1 undo → x=0(Figma 条件逆运算 + 真实 Yjs captureTimeout 合并,两案一致)。
- `M6` redo 恢复 A 最终值(两案一致)。

**成本**:Figma 式 command 序列化(platform §13.2 / T2.3 `CanvasCommand` 已起步)+ coalescing。Yjs:UndoManager 与 command 栈关系 N1 §7 未列决 + 双真相源。

**go/no-go**:**Figma GO**。条件逆运算语义经真实 `Y.UndoManager` 同矩阵证一致;"远端交错保留"从 v1 分析变为 v2 ★真实库对照证据。

### Gate 3 · 跨 record invariant / 事务 — P1-2 修正(★真实库对照 + ●真实 PG)

**问题**:node-delete+edge、group/frame、result node+asset ref、delete-vs-update 的原子边界。

**v1→v2 修正(P1-2)**:v1 G3 把"CRDT 无原子多 record"写成绝对优势。**真实探针推翻**:`G3-real-1` 证 Yjs 单 Y.Doc `doc.transact` 删 nodes.n1 + edges.e1 → 远端**同一 Transaction 原子可见**(intra-doc 原子)。**正确表述**:intra-doc transact = 原子;**跨 Y.Doc / 跨 PG / 跨文件资产 = 非原子**(与 Figma 跨介质边界同)。`G3-real-2` 证 delete-vs-update 真实 merge:**n1 不复活**(Y.Map 父键 delete vs 子 map.set → delete wins)——v1 "可能 update 复活已删 record"表述推翻;**Figma delete-wins 在此场景非相对 Yjs 的优势**(Yjs 亦 delete wins)。

**证据**:
- ★真实库对照:`G3-real-1`(intra-doc 原子)、`G3-real-2`(delete-vs-update 不复活)、`G3-real-3`(跨 Y.Doc 无共享事务,非原子边界)。
- ●真实 PG(`server/__tests__/n20-pg-tx-fault.spike.test.ts`,本地 PG 55443 实跑):
  - `PG-T1` 原子提交:BEGIN 删 n1+级联 edges + COMMIT → 全删,e3 保留。
  - `PG-T2` fault injection:BEGIN 删 edges + 注入 1/0 + ROLLBACK → n1 与 edges 全在(无 partial)。
  - `PG-T3` **同库资产元数据**(R2-1 改名,非"跨介质"):删 n1 + 减 asset refcount 同事务(同一 client);fault → 两边不动。真跨介质(PG + 文件系统/对象存储)非本探针 — Figma 靠 saga 补偿(非真原子),Yjs 无方案。
  - `PG-T4` 对照:无事务时删 edges 后崩溃 → partial(证明事务必要性)。
- ●FieldLevelServer 集成:`G3-1`(删 n1 → e1/e2 级联删,e3 保留)、`G3-2`(delete wins,update 落 not-found)。

**成本**:Figma 式 server-side PG 事务(可跨多 record/跨表原子,PG-T1~T4 证);Yjs intra-doc 原子(G3-real-1)但**跨 Y.Doc/跨文件资产 非原子**(G3-real-3)——node+edge 跨 canvas、result+asset 跨介质,Yjs 无共享事务。

**go/no-go**:**平局(R2-1)**。intra-doc/intra-DB 原子两案一致(G3-real-1 真 Yjs doc.transact / PG-T1~T3 同一 client pool.connect+finally release 已验);跨介质 Figma=saga 补偿非真原子、Yjs=无方案 — 非相对优势。原 v2 "Figma 占优"降为平局(诚实);PG-T3 改名"同库资产元数据"(非跨介质)。

### Gate 4 · revision × 属性 LWW 兼容协议 — P1-6 诚实化

**问题**:(A) cutover 前受控修订 #194 / (B) 保留严格 endpoint + 新增 versioned ops endpoint。

**v1→v2 修正(P1-6)**:v1 "方案 A 零生产破坏面"**不成立**(§1.2 inventory)。但"无双协议窗口"成立(#194 `unwiredServerPersistAdapter` 未接线 → 原地演进,无双 endpoint 并存)。

| 维度 | 方案 A(受控修订 #194) | 方案 B(严格 endpoint + versioned ops) |
|---|---|---|
| wire 演进 | 原地演进 `PATCH /nodes/:nodeId` payload:整 record → field-level ops | 新增 `POST /nodes/:nodeId/ops`(versioned);#194 冻结 |
| envelope | If-Match 400/428/409 不变(`G4-3` 428) | 双 endpoint 并存 |
| revision 语义 | per-record,每 accepted op bump,**只供 snapshot/catch-up,不参与 LWW 拒写**(`G4-4`) | 同 |
| 生产破坏面 | **前端未接线但契约/服务端破坏面非零**(§1.2:≥12 文件 + FX-5 队列迁移 + 117 项回归) | 不动 #194,新 endpoint 独立上线 |
| 迁移窗口 | 无双协议窗口(原地演进) | 双 endpoint 并存窗口 + 客户端分叉 |

**证据**:`G4-1`(不同字段双留)、`G4-2`(嵌套叶子双留)、`G4-3`(428)、`G4-4`(base 落后不同字段→接受);▲lead 核证 #194 route 注册 + shared contract 冻结 + FX-5 payload(§1.2)。

**成本**:方案 A 改 `validateChildPayload` + `upsertChild`(field-level merge)+ 契约测试 + **FX-5 队列迁移**(旧 body→新 op schema)+ cutover 策略(**原子 cutover**,§1.2 拍死,非 versioned payload)。方案 B 付双 endpoint 税。

**go/no-go**:**方案 A GO**。理由:#194 前端主路径未接线(`unwiredServerPersistAdapter`),**无双协议窗口**成立;方案 B 的"不动 #194"优势在 #194 已上线生产时才成立,目前 #194 前端未接线——方案 B 付双 endpoint 税却无收益。但**破坏面非零**,cutover 已拍死**原子**(§1.2,非 versioned payload/无双 decoder 兼容窗)。方案 A 直接产出 N2-1 契约(§10)。

### Gate 5 · 实时 transport + auth spike(网关 gate)— P1-5 真实 SSE

**v1→v2 修正(P1-5)**:v1 G5-1 只是**内存 callback skeleton**,非真实 SSE/网关/auth spike。计划 §8 明确 N2-0 必须做真实 SSO 网关 transport+auth spike,不能推 N2-2。**返修**:真实 Hono SSE route 集成测试 `5-1~5-6`。

**证据**(●真实集成,`server/__tests__/n20-sse-route.spike.test.ts`,自含 Hono app + ReadableStream):
- `5-1` content-type + framing(`text/event-stream`;`data: {json}\n\n`)。
- `5-2` heartbeat(`: keepalive\n\n` 保活)。
- `5-3` `?since=seq` 补拉(只 replay seq>since)。
- `5-4` revoke 断流(`event: revoke` + 流关闭)。
- `5-5` authz(R3 F3:真实 resolveActor+canAccessCanvas;非 member/错 proof → **404 no-leak**,非 401/403;本仓 SSE seam 无 401)。
- `5-6` slow consumer 有界(backlog 超 MAX_BACKLOG → drop oldest,不 OOM)。

**仓库侧协议/头分析(R2-2)**:`owner.ts` 全 HTTP-header-based(`x-mivo-auth-user` + `x-mivo-gateway-secret` fail-closed);SSE = plain HTTP GET + `text/event-stream`,网关**应**透传(plain HTTP)但生产可能缓冲/超时(○条件式,R2-2,非"任何网关必透传");WS upgrade 需网关注入同链到 handshake。

| 维度 | Figma 式 | Yjs |
|---|---|---|
| 主通道 | REST PATCH(#194)+ SSE 广播(真实 5-1~6) | y-protocol 双向 WS |
| 网关 WS 不放行时 | SSE fallback 仍可用(plain HTTP) | 需 polling fallback,失 CRDT 实时价值 |
| auth 复用 | 复用 #194 SSO header 链(SSE 同链) | WS handshake 需网关注入(未验证) |

**go/no-go**:**条件式 GO(R2-2)**。Figma 式 REST+SSE:5-1~8 真实验证(**live push 5-7 + desiredSize backpressure 5-6 + R3 F3 真实 resolveActor/canAccessCanvas authz seam 5-5(404 no-leak,替代 fake secret)+ slow-reader response body 恢复 5-8**,复用 owner.ts fail-closed 模式;非 v2 直信 x-mivo-auth-user)。**网关 gate 条件式**:网关对 `text/event-stream` buffering/超时 = ○条件式留 lead 生产实测(非"任何网关必透传"——生产网关可能缓冲);不影响 Figma 选型(SSE fallback 兜底),只影响实时性调优。Yjs 依赖 WS 网关放行(亦条件式未验证)。

**未验证项(○条件式,留 lead 生产实测,§12)**:
1. 生产 SSO 网关是否代理 WS upgrade + 注入 `x-mivo-auth-user`/`x-mivo-gateway-secret`(条件式:做到→N2-2 上 WS 优化;做不到→SSE 兜底,**Figma 选型不变**)。
2. SSE 长连接在网关的超时/缓冲策略(5-2 heartbeat 已实现,但生产网关缓冲未测;条件式:必要时加心跳)。
3. 网关对 `text/event-stream` 的 streaming 行为。

→ **这些不标"无需验证",标"条件式":Figma 式有 SSE fallback 兜底不影响选型;只影响 N2-2 是否上 WS 优化。**

### Gate 6 · 迁移 / 双协议窗口 — P1-6 诚实化

**问题**:#194 / PG JSONB / FX-5 / stale-client 迁移。

**v1→v2 修正(P1-6)**:v1 "无双协议窗口 + FX-5 不动 + 零破坏"→ 诚实修正:

| 维度 | Figma 式 | Yjs |
|---|---|---|
| #194 wire 迁移 | 未接线→原地演进为 field-level ops,**无双协议窗口**;但**契约/服务端破坏面非零**(§1.2) | legacy PATCH↔Y.Update bridge + per-canvas flag = 真双协议窗口 |
| PG schema | JSONB payload 不透明(已如此);field-level merge 是 server 逻辑 | Y.Doc state 需新存储形态 |
| FX-5 | **v1 "FX-5 不动"错**:WriteOp 持全 NodePayload(▲lead 核证),旧 IDB queued body 打新 endpoint = 400 `payload-rejected`;需 FX-5 队列迁移 | offline edit 队列与 FX-5 关系需定 |
| stale-client | 旧 body→新 endpoint = **400 `payload-rejected`** → refetch(非 409);新 op + stale base(并发)= 200 + `overwritten`(G4-4 不拒写,非 409)— 两场景区分见 §1.2 状态表 | state-vector 比对 |

**证据**:▲lead 核证 #194 route 注册 + shared contract 冻结 + FX-5 payload(§1.2);`G4-3` 428/409 envelope;`G7-1` ?since=seq 补拉。

**成本**:Figma 式 0 双协议窗口(原地演进);但破坏面 inventory(§1.2:≥12 文件 + FX-5 队列迁移 + 117 项回归 + cutover 策略)。Yjs:legacy↔CRDT bridge 翻译规则 + per-canvas flag + 双协议并存窗口。

**go/no-go**:**Figma GO**(无双协议窗口成立,迁移面小于 Yjs 的双协议窗口;但破坏面非零,须 cutover 策略)。

### Gate 7 · 事件序号 / 补拉日志 / 压缩、权限撤销、性能与存储放大 — P2-7 诚实化(★真实库对照)

**v1→v2 修正(P2-7)**:v1 G7 压缩/断流/存储对比无真实证据;snapshot 是一个数字,截断后 `pullSince(0)` 静默丢前 950 条无 gap 信号;revoke 只删内存 callback,被撤 actor 仍可写;"Y.Doc 全 op log 重放"不准确。**返修**:`G7-hard-1~4`。

**证据**(★真实库对照仅 G7-hard-4;G7-hard-1~3 降 ●/○ 自建 server 无 Yjs 对照,R2-7):
- `G7-hard-1`(●自建) **logFloor + gap 协议**:`pullSinceWithGap(since)`,since<floor → gap=true + snapshot(客户端必须 reset);since>=floor → 增量。**推翻 v1 `pullSince(0)` 静默丢前 950 条**。
- `G7-hard-2`(●自建) **恢复等价**:live A 与崩溃重连 B(经 snapshot+gap 恢复)最终态一致(**无 Yjs 对照,无恢复耗时对比**,R2-7)。
- `G7-hard-3`(●自建) **post-revoke 写拒绝**:`removeMember` 后 `applyOpAuthz` → `forbidden`(**不只断流,还拒写**;推翻 v1"只删内存 callback";**无 Yjs provider revoke 对照**)。
- `G7-hard-4`(★真实 `encodeStateAsUpdate`) **bytes 级存储对比**:同 1000 op 工作量,**yjsWithGc=58B < yjsNoGc=5954B < figmaCompressed=8637B**。

| 维度 | Figma 式 | Yjs |
|---|---|---|
| 事件序号 | per-canvas 单调 seq(`G7-1`) | (clientID,clock);无单一 seq |
| 补拉日志 | `?since=seq` + **logFloor/gap 协议**(`G7-hard-1`) | state-vector 比对 |
| 压缩 | snapshot + truncate opLog(`G7-2`) | Y.Doc snapshot + GC |
| 权限撤销 | 连接绑 actor+canvas;`removeMember`→断流 + **post-revoke 写拒绝**(`G7-hard-3`) | Y.Doc 共享,revocation = doc 级访问控制(更难) |
| 存储放大 | record payload(不透明 JSONB)+ 有界 op log(truncate) | update log(无 GC 无界)+ snapshot + GC 成本 |

**诚实结论(G7-hard-4 推翻 v1 "Figma 存储更小")**:
- Yjs 二进制编码比 Figma JSON opLog **更省字节**(yjsWithGc=58B < figmaCompressed=8637B)。
- Yjs 有 auto-GC(默认 `doc.gc=true`)亦**存储有界**(连续同 key set 旧 item 被 GC)。
- **Figma 真实优势 ≠ "存储更小"**,而是:
  - (a) 显式 server 控制 compress/truncate + 有界 opLog 窗口(可预测,不依赖 GC 时机);
  - (b) revoke 简单(连接绑 actor+canvas,非 doc 级访问控制)。

**成本**:Figma 式 op log + 周期 snapshot+truncate(server 控制)+ revoke 直观。Yjs:Y.Doc GC 复杂(N1 Q3/Q10)+ revoke 难(共享 doc)。

**go/no-go**:**平局(R2-7)**。存储:G7-hard-4 ★真测 Yjs 有 GC 时 bytes 更小(yjsWithGc=58B < figmaCompressed=8637B)——非 Figma 存储优势。revoke:Figma 简单(连接绑 actor+canvas)= ●/○ 设计推理(G7-hard-1~3 自建 server 无 Yjs 对照,原标 ★ 虚标已降);Yjs revoke 难(doc 级访问控制)。恢复:无耗时对比(两案均未跑生产恢复耗时)。**Gate7 平局**:存储 Yjs 优、revoke Figma 优、恢复无对比——非任一方相对全优势。优势从 v1 "存储更小" → v3 "revoke 简单(●/○ 非对照实证)+ 可预测控制"——诚实承认非存储优势。

---

## 3. v1→v3 被推翻/修正表述清单(诚实,R2 增补)

| v1 表述 | v2 修正 | 推翻证据(强度) |
|---|---|---|
| Gate3 "CRDT 无原子多 record"(绝对) | intra-doc transact 原子;跨 doc/PG/文件资产 非原子 | `G3-real-1`(★真 Yjs doc.transact) |
| Gate3 "可能 update 复活已删 record" | Yjs 亦 delete wins;Figma 此场景非相对优势 | `G3-real-2`(★真 Y.Map delete vs 子 map.set) |
| Gate7 "Figma 存储有界、Yjs 无界 → Figma 优" | Yjs 有 GC 时 bytes 更小;优势改为 revoke 简单 + 可预测控制 | `G7-hard-4`(★真 encodeStateAsUpdate) |
| §1.2/Gate4/Gate6 "方案 A 零破坏面" | 前端未接线但契约/服务端破坏面非零(≥12 文件 + FX-5 队列) | ▲lead 核证 #194 route 注册 + FX-5 payload + shared contract |
| Gate6 "FX-5 不动" | FX-5 WriteOp 持全 payload,旧 IDB queued body 打新 endpoint = 400 payload-rejected | `writeRetryQueue.ts:16-19`(▲lead 核证) |
| Gate1 "canvas 文本同刻并发罕见,不否决" | 不能仅凭"罕见"断言(markdown 全文渲染);二选一 B(LWW200+overwritten+restore) | P1-4 + `T1-1~4`(●契约探针) |
| Gate2 PoC naive undo "A inverse 后发覆盖 B" | 条件逆运算:A effect 被 B 取代时 skip(remote wins),对齐真 Yjs | `M2`(★真 Y.UndoManager 对照) |
| Gate2 PoC "undo 返回字符串占位,从不 applyOp" | ConditionalUndoStack 保存 oldValue,undo() 发条件逆运算到服务端 | `M1-M6`(★真 Yjs 同矩阵) |
| Gate5 G5-1 "SSE skeleton(内存 callback)" | 真实 Hono SSE route 集成(content-type/heartbeat/since/revoke/authz/slow-consumer) | `5-1~6`(●真实集成) |
| Gate7 "pullSince(0) 静默返 50 条(丢前 950)" | logFloor + gap 协议显式告警客户端 reset | `G7-hard-1`(●) |
| Gate7 "removeMember 只删内存 callback" | post-revoke applyOpAuthz → forbidden(不只断流) | `G7-hard-3`(●) |
| Gate7 "Y.Doc 全 op log 重放" | 增量 update 不重放全史(Yjs 有 GC) | `G7-hard-4`(★真 encodeStateAsUpdate) |
| §10 FieldOp body 携 actor/recordId/baseRevision | 三层信任边界:body 不信,authz/path/If-Match 覆盖 | `S10-2`(●) |
| §10 opId body+header 双载体 | opId 单一权威载体(idempotency-key header) | `S10-2`(●) |
| §10 无 create/unset/array/reorder/strict-tx | typed domain op union(**R5 F1:create 独立 endpoint,非 PATCH DomainOp member**) | `S10-3`(●) |
| §10 per-field clock 留 N2-1(自相矛盾) | 持久形态定死 PG `field_clock` 表(PG-T5 真测:write→destroy pool→重连读回;S10-4 演示逻辑) | `S10-4`+`PG-T5`(●) |
| §10 batch 无原子性 | batch 预检 + 全 ok 或全 reject(无 partial);跨 record 单事务 PG-T7 真测 | `S10-5`+`PG-T7`(●) |
| §10 FieldPath 允许空 / 无防原型污染 | 非空 tuple + 拒 __proto__/prototype/constructor(对齐 G1-b R2-P1-1) | `S10-1/S10-6`(●) |
| §10 数组无中性 intent | by-stable-id insert/remove/splice(对齐 G1-b R2-P1-1) | `S10-7`(●) |
| §10 create→edit 无因果 | 同 record FIFO(pending create ack 前 hold edit,对齐 G1-b R2-P1-2) | `S10-8`(●) |
| §10 DELETE 无 cursor/404 边界 | accepted 必携 seq;幂等已删返 cursor;404→rejected(对齐 G1-b R2-P1-3) | `S10-9`(●) |
| v2 Gate3 "Figma 占优(跨介质边界)" | v3 **平局**(R2-1):intra 原子两案一致;跨介质 Figma=saga 非真原子、Yjs=无方案;PG-T3 改名同库资产元数据;PG-T 同一 client(pool.connect+finally release) | `PG-T1~T3`(●同 client)+ `G3-real-1`(★) |
| v2 Gate5 "SSE skeleton replay + 直信 x-mivo-auth-user + 任何网关必透传" | v3 **条件式 GO**(R2-2):live push 5-7 + desiredSize backpressure 5-6 + gateway-secret authz seam 5-5(复用 owner.ts fail-closed);网关 SSE buffering 改条件式(非"必透传") | `5-1~7`(●真实集成) |
| v2 §10 trustify 无 header 参数(opId 实取 body)+ DomainOp 带 recordId + clock 内存 Map + batch 逐条 mutate | v3 **真三层**(R2-3):trustify 注入 idempotency-key header(opId 单一权威,弃 body.opId);DomainOp 中性 delta(无 recordId/actor/base/opId,adapter 注入);clock PG field_clock schema + 客户端 base.clock;batch 真单事务(staging+commitStaged,无 partial);immutable/atomic leaf 表 + idempotent replay | `S10-2/3/4/5/10/11`(●) |
| v2 §10 数组写死 {id:string} + FieldPath 只堵 [] | v3 **三类数组 + leaf validator**(R2-4):by-id(有 stable-id)/whole-lww(无 stable-id markupPoints)/primitive(resultNodeIds string[]);setByPath 拒 ['transform']+整对象 clobber(对照 mivoCanvas.ts:69-74,249) | `S10-6/7`(●) |
| v2 restore 直调 applyOpAuthz(B 收不到 overwritten,lastWriter 错停) | v3 **restore 走 overwrite 管线**(R2-5):败方(当前 lastWriter)收 overwritten;lastWriter 链持续 | `T1-2/T1-5`(●) |
| v2 §1.2 "≥12 文件" + 117 项无命令 + cutover 二选一未决却称"无双协议窗口" | v3 **逐文件 12 项清单 + 冻结命令 + cutover 拍死原子**(R2-6):无双协议窗口保留(原子 cutover + #194 unwired) | §1.2 inventory(▲lead 核证) |
| v2 Gate7 G7-hard-1~3 标 ★(自建 server 无 Yjs 对照,虚标) | v3 **降 ●/○**(R2-7);仅 G7-hard-4 ★真测;Gate7 重评平局 | `G7-hard-1~3`(●/○)+ `G7-hard-4`(★) |
| v2 隐含"Yjs 无原生 coalescing" | v3 修正:Yjs 有 UndoManager captureTimeout 合并(M5 证两案一致,非"无原生 coalescing") | `M5`(★真 Y.UndoManager) |
| v2 "任何 HTTP 网关必透传 SSE" | v3 改条件式:网关应透传(plain HTTP)但生产可能缓冲/超时(○条件式留 lead 实测) | §2 Gate5 仓库侧分析(R2-2) |

---

## 4-9. PoC 清单与实跑结果(55 tests 全绿)

**文件**:`src/kernel/__spike__/n20-truth-source.spike.test.ts`(44)+ `server/__tests__/n20-sse-route.spike.test.ts`(8)+ `server/__tests__/n20-pg-tx-fault.spike.test.ts`(7)。

### 4.1 原 PoC(15 tests,v1 已有)

| PoC | gate | 断言 | 强度 |
|---|---|---|---|
| G4-1 不同字段并发 → 双留 | 4+1 | `x===100 && title==='B-title' && rev===rev0+2` | ● |
| G4-2 嵌套叶子并发 → 双留 | 4 | `x===10 && y===20` | ● |
| G1 文本同字段并发 → LWW 取后者 | 1 | `text==='B-text'` | ● |
| G4-3 If-Match missing → 428 | 4 | `kind==='precondition-required'` | ● |
| G4-4 revision 不拒写(base 落后不同字段仍接受) | 4 | `kind==='ok' && x===50` | ● |
| G3-1 node-delete + edge cascade 原子 | 3 | `deletedEdges===2 && edgeCount===1` | ● |
| G3-2 delete-vs-update → delete wins | 3 | `kind==='not-found'` | ● |
| G2-1 拖拽 100 op → coalescing 1 undo | 2 | `depth===1` | ● |
| G2-2 undo 只撤自己,远端交错保留 | 2 | `remoteSeenCount===1 && length===1` | ● |
| G7-1 per-canvas seq + ?since=seq 补拉 | 7 | `missed.length===1 && seq===3` | ● |
| G7-2 snapshot + truncate(1000→50) | 7 | `logKept===50 && logTruncated===950` | ● |
| G7-3 权限撤销断流 | 7 | `received==='__revoke__' && 后续 0` | ● |
| G5-1 SSE=plain HTTP broadcast skeleton | 5 | `stream contains 'seq=1:title'` | ●(v2 升级为真实 5-1~6) |
| antiYjs-坑5 revision↔Yjs 双真相源背离 | — | `Y.Map rev===7 && kernel rev===8` | ★ |
| antiYjs-坑7 writeRecord clear+rebuild 吞子字段 | — | `mergedTransform.y===-20`(B 的 999 丢失) | ★ |

### 4.2 返修硬化探针(18 tests,前任 worker + 本 worker 接续)

| PoC | finding | gate | 断言 | 强度 |
|---|---|---|---|---|
| M1 不同字段交错 → A undo title,transform.x 保留(两案一致) | P1-1 | 2 | `title==='orig' && x===50` | ★ |
| M2 同字段远端后写 → A undo,title 仍 B(remote wins) | P1-1 | 2 | `inv.inverse.length===0(reason=remote-overwrote) && title==='B'` | ★ |
| M3 目标被远端删除 → undo 不复活(delete wins) | P1-1 | 2 | `recordExists('n1')===false` | ★ |
| M4 目标被移动(改 groupId) → A undo title,groupId 保留 | P1-1 | 2 | `title==='orig' && groupId==='g1'` | ★ |
| M5 100-drag coalescing 初始值恢复 | P1-1 | 2 | `x===0`(两案一致) | ★ |
| M6 redo 恢复 A 最终值 | P1-1 | 2 | `title==='A'` | ★ |
| G3-real-1 单 Y.Doc doc.transact 原子(intra-doc) | P1-2 | 3 | `!has('n1') && !has('e1') && has('e2')` | ★ |
| G3-real-2 delete-vs-update 真实 merge(不复活) | P1-2 | 3 | `!has('n1')`(两 doc) | ★ |
| G3-real-3 跨 Y.Doc 无共享事务(非原子) | P1-2 | 3 | `!has(n1,A) && has(e1,B)` | ★ |
| G7-hard-1 logFloor + gap 协议 | P2-7 | 7 | `gap===true(since<floor) && gap===false(since>=floor)` | ● |
| G7-hard-2 恢复等价(live vs 崩溃重连) | P2-7 | 7 | `bN1.revision===aN1.revision` | ● |
| G7-hard-3 post-revoke 写拒绝 | P2-7 | 7 | `kind==='forbidden'` | ● |
| G7-hard-4 bytes 对比(Yjs 有 GC 更小) | P2-7 | 7 | `figmaCompressed<figmaRaw && yjsNoGc>yjsWithGc` | ★ |
| S10-1 setByPath 拒原型污染 | P1-3 | §10 | `toThrow(/forbidden path segment/)` | ● |
| S10-2 三层信任边界 trustify | P1-3 | §10 | `actor==='alice' && recordId==='n1' && base===0`(不信 body) | ● |
| S10-3 typed domain op union | P1-3 | §10 | set/unset/array/reorder/strict-tx 可区分;**create 独立 CreateBody+trustifyCreate(非 DomainOp,R5 F1)** | ● |
| S10-4 per-field clock 持久形态 | P1-3 | §10 | clock 逻辑(内存演示)+ **PG-T5 真持久**(write→destroy pool→重连读回,clock 仍在) | ● |
| S10-5 batch 原子性 | P1-3 | §10 | batch 逻辑(单 record)+ **PG-T7 跨 record**(BEGIN 两 record+fault+ROLLBACK 两 record 均不变) | ● |

### 4.3 补缺探针(8 tests,本 worker)

| PoC | finding | gate | 断言 | 强度 |
|---|---|---|---|---|
| T1-1 同字段并发 LWW 200 + 前写者收 overwritten | P1-4 | 1 | `rb.kind==='ok' && inbox[0].historicalValue==='A'` | ● |
| T1-2 restore 恢复前值 | P1-4 | 1 | `title==='A'(restore 后)` | ● |
| T1-3 不同字段并发无 overwritten | P1-4 | 1 | `inbox.length===0` | ● |
| T1-4 对照 A 方案 409 语义差异(B 与 G4-4 自洽) | P1-4 | 1 | `同字段也 200(不 409)` | ● |
| S10-6 FieldPath 非空 tuple | P2-8 | §10 | `toThrow(/empty fieldPath/)` | ● |
| S10-7 数组中性 intent by-stable-id | P2-8 | §10 | `insert/remove/splice 用 id 非 index` | ● |
| S10-8 create→edit 因果 FIFO | P2-8 | §10 | `order==['create:init','edit:edited']` | ● |
| S10-9 DELETE cursor/404 边界 | P2-8 | §10 | `成功+幂等返 seq;从未存在→not-found` | ● |

### 4.4 真实 SSE route 集成(8 tests:5-1~6 R2 + 5-7 R2-2 live push + **5-8 R3 F3 slow-reader 恢复**;5-5 R3 F3 改真实 authz seam)

见 Gate5 §2(5-1 content-type/framing、5-2 heartbeat、5-3 since 补拉、5-4 revoke 断流、5-5 authz **404 no-leak**(R3 F3 真实 seam,原 403 系 fake secret)、5-6 slow consumer 有界 + response body 实收(R3 F3);5-7 live push、5-8 slow-reader 恢复见 §4.6)。强度 ●。

### 4.5 真实 PG fault injection(7 tests:PG-T1~T4 R2-1 同 client + **PG-T5/T6/T7 R3 F2 持久/跨 record**,本地 PG 55443 实跑)

见 Gate3 §2(PG-T1 原子提交、PG-T2 fault ROLLBACK、PG-T3 同库资产元数据(R2-1 改名,非跨介质)、PG-T4 无事务 partial 对照)。强度 ●。

### 4.6 R2 增补探针(4 tests:3 spike + 1 SSE,R2 返修新增)

| PoC | finding | gate | 断言 | 强度 |
|---|---|---|---|---|
| T1-5 restore 走 overwrite 管线全链(A写→B写→A restore→B收 notice→B后续写→A收 notice) | R2-5 | 1 | `overwrittenTo==='bob' && aliceInbox.length===2 && bobInbox.length===1`(lastWriter 链不断) | ● |
| S10-10 immutable/atomic leaf 表 | R2-3 | §10 | `immutable 字段 set→throw;atomic-container 整值替换(allowContainerClobber);其余 leaf set ok` | ● |
| S10-11 idempotent replay | R2-3 | §10 | replay 逻辑(内存 Map)+ **PG-T6 真持久**(write→destroy→重连 replay 不二次 bump) | ● |
| 5-7 SSE live push(建连后 push→response body 实收) | R2-2 | 5 | `chunks 含 'live-value' && op.value==='live-value'`(非建连前 replay) | ● |
| 5-8 slow-reader 恢复(R3 F3) | R3 F3 | 5 | `resumedMax-resumedMin+1 > resumed.length`(response body 观察 seq gap)+ `?since=0 补拉 seq 1..51 全 51 无缺口` | ● |

**实跑汇总**:`59 pass / 0 skip / 0 fail`(spike 44 + SSE 8 + PG 7,本地 PG port 55443 实跑 MIVO_PG_TEST=1,PG-T1~T7 同一 client 真 pass;PG-T5/T6/T7 真 PG 持久/跨 record;SSE 5-8 slow-reader 恢复)。`tsc -b` 0 errors;`eslint` 干净;`npm run build` exit 0(567ms);`grep -roE 'yjs|lib0|YEvent|applyUpdate|AbstractType|encodeStateAsUpdate' dist/` 零命中(yjs 不进生产 bundle)。

---

## 10. G1-c / N2-1 唯一契约草案 v2(对齐 G1-b R2)

> 依据:gate 4 方案 A + gate 5 REST+SSE + gate 7 seq/补拉/压缩/revoke + **G1-b R2 三 finding 对齐**(FieldPath 非空 tuple / 数组 by-stable-id / create→edit 因果 / DELETE cursor)。**唯一契约——选 Yjs 则替换为 Y.Doc 通道,但本决策已否决 Yjs。**

### 10.1 op schema(field-level,走 #194 PATCH envelope;v2 对齐 G1-b R2;**R5 F1:create 独立 endpoint,非 PATCH DomainOp**)

```ts
// DomainOp = 中性 delta(transport-neutral):set/unset/array/reorder/strict-tx 无 recordId/actor/base/opId
//   (recordId ← URL path;actor ← resolveActor;base ← If-Match;opId ← idempotency-key header,全 adapter 注入)。
//   ★ R5 F1:create 已从 PATCH DomainOp 剔除 — create 走独立 POST endpoint(见 CreateBody),非 PATCH member;
//     杜绝"同一 PATCH wire 同时有 trusted ctx.recordId(path)与不可信 domain.recordId(body)双 record 权威"。
type FieldPath = readonly [string | number, ...(string | number)[]]  // 非空 tuple(G1-b R2-P1-1,S10-6 运行时拒空)

type DomainOp =
  | { kind: 'set'; fieldPath: FieldPath; value: unknown }                                   // 无 recordId(path 注入)
  | { kind: 'unset'; fieldPath: FieldPath }                                                 // 无 recordId
  | { kind: 'array'; fieldPath: FieldPath; class: 'by-id'; intent: 'insert'; afterId: string|null; value: {id:string} }  // ① by-stable-id(fills/strokes/effects)
  | { kind: 'array'; fieldPath: FieldPath; class: 'by-id'; intent: 'remove'; removeId: string }
  | { kind: 'array'; fieldPath: FieldPath; class: 'by-id'; intent: 'splice'; afterId: string; removeCount: number; values: {id:string}[] }
  | { kind: 'array'; fieldPath: FieldPath; class: 'whole-lww'; intent: 'replace'; value: unknown[] }  // ② 无 stable-id(markupPoints)整值 LWW
  | { kind: 'array'; fieldPath: FieldPath; class: 'primitive'; intent: 'insert'|'remove'; value: string }  // ③ primitive(resultNodeIds)by value
  | { kind: 'reorder'; orderedIds: string[] }                                              // parentId 从 path 注入
  | { kind: 'strict-tx'; ops: DomainOp[] }                                                 // 严格事务路径(跨 record 原子,§10.4);ops 无 create
```

**三层信任边界(R5 F1:对齐 spike S10-2/S10-3 权威类型,PATCH body 任意 variant 含 strict-tx 嵌套零 privileged;create 独立 endpoint)**:
```ts
// 客户端 PATCH payload(不可信):零 privileged 载体 — 无 opId/actor/recordId/baseRevision(全 adapter 注入)
type ClientFieldOp = { clientId: string; domain: DomainOp }
// 服务端 trusted(actor ← resolveActor(authz);recordId ← URL path;base ← If-Match;opId ← idempotency-key header 单一权威载体)
type TrustedCtx = { opId: string; clientId: string; actor: string; recordId: string; baseRevision: Revision }
type WireOp = TrustedCtx & { domain: DomainOp }
// trustify:ClientFieldOp.domain + TrustedCtx → WireOp(PATCH body 无 privileged 字段可伪造,S10-2 类型级断言全 variant)
const trustify = (client: ClientFieldOp, ctx: TrustedCtx): WireOp => ({ ...ctx, domain: client.domain })

// ── R5 F1:create 独立契约(POST /api/canvas/:id/nodes,非 PATCH DomainOp)──
// CreateBody 零 privileged:无 recordId(server 分配/idempotency-key 派生,非 body)/actor/base/opId。
//   id 唯一来源 = trusted endpoint ctx(server-minted),非 body 可伪造字段 — 杜绝双 record 权威。
type CreateBody = { clientId: string; type: 'node'|'edge'|'anchor'; payload: unknown }
type CreateWire = { opId: string; clientId: string; actor: string; recordId: string; type: 'node'|'edge'|'anchor'; payload: unknown }
const trustifyCreate = (client: CreateBody, ctx: TrustedCtx): CreateWire =>
  ({ opId: ctx.opId, clientId: ctx.clientId, actor: ctx.actor, recordId: ctx.recordId, type: client.type, payload: client.payload })
// S10-2 类型级 gate(tsc -b 强制):DomainOp['kind'] 不含 'create';CreateBody keyof 无 recordId;
//   全 array variant keyof 无 recordId/actor/base/opId;create 塞回 DomainOp / 嵌套进 strict-tx.ops → @ts-expect-error 失效 → build fail。
```

### 10.2 wire(#194 envelope 不变,payload 演进;cutover 策略见 §1.2;**R5 F1:create 独立 endpoint**)

- `PATCH /api/canvas/:id/nodes/:nodeId` — payload = `DomainOp` 或 `DomainOp[]`(batch 同 record,**原子:全 ok 或全 reject**,S10-5)。**R5 F1:DomainOp 不含 create**(create 走独立 POST,见下)→ PATCH body 任意 variant 零 privileged recordId,recordId 仅来自 trusted path ctx(无双 record 权威)。
- `POST /api/canvas/:id/nodes` — **R5 F1 独立 create endpoint**:body = `CreateBody`(零 recordId;server 分配/idempotency-key 派生 id),经 `trustifyCreate` 注入 server-minted recordId 到 trusted ctx(非 body 可伪造)。不与 PATCH DomainOp 共 wire。
- If-Match: `baseRevision`(400/428/409 复用 #194 `parseIfMatch`;create endpoint 无 :nodeId path,recordId 由 server 注入,baseRevision 为 create 时的 canvas base)。
- 响应:`{ id, revision, seq }`(`UpsertResponse` 扩 `seq`;打破 exact type test,契约测试重写)。
- **cutover**:**原子 cutover**(§1.2 拍死;非 versioned payload,无双 decoder 兼容窗)+ FX-5 队列 migration-on-read + stale client 旧 body → 400 `payload-rejected`(见 §1.2 cutover 状态表)。create endpoint 随 PATCH 一同 cutover(同 feature flag)。

### 10.3 服务端合并(field-level LWW,非整 record 替换)

- `upsertChild` 演进:`validateChildPayload` 改 field-level op schema 校验(逐 fieldPath 白名单,拒 unknown,拒空路径 S10-6,拒原型污染 S10-1);merge = 按 `fieldPath` set 叶子(`setByPath` 硬化),**永不 `clear` 整 record**(N1 坑7)。
- revision:每 accepted op bump(per-record);**只供 snapshot/catch-up + legacy cache 校验,不参与 LWW 拒写**(G4-4)。
- 同 `fieldPath` 并发:server seq LWW(后者 wins,整串;gate 1 文本 gate 接受)+ **overwritten 事件推前写者**(B 方案,T1-1)。
- 全序 `seq`:per-canvas 单调事件序号(gate 7 `?since=seq` 补拉)。
- per-field clock:**持久形态定死** PG `field_clock` 表(PG-T5 真测:write→destroy pool→重连读回,clock 仍在;S10-4 演示逻辑,不留 N2-1);stale 判定 = base.clock < current.clock → 条件逆运算 skip(M2)。

### 10.4 跨 record invariant = 严格事务路径(非 LWW)

- `deleteNodeCascade(nodeId)` 等 server-side 事务:node 删 + edge 级联 + asset ref 清理,**同一 PG 事务原子**(G3-1 + PG-T1~T3 + **PG-T7 跨 record 单事务**真实验证)。
- delete-vs-update:delete wins,update 落 not-found(G3-2,非 409 重试)。
- group/frame、result node+asset ref 同走事务路径(`strict-tx` op)。

### 10.5 实时通道(REST + SSE;WS 选作 N2-2 优化)

- 写:`PATCH`(#194,已建)。
- 广播:SSE(`/api/canvas/:id/events?since=seq`),plain HTTP,网关透传,鉴权走 SSO header 链(真实 5-1~6)。
- **overwritten 事件**(B 方案):同 fieldPath 后写 wins 时,前写者收 `{seq, recordId, fieldPath, historicalValue, byActor, currentRevision}`(T1-1);前写者可 `restore`(发 historicalValue,新 seq,T1-2)。
- WS:N2-2 选作低延迟优化(非依赖);**网关 WS 放行 = ○条件式留 lead 生产实测**,不放行则 SSE 兜底。
- presence:WS(若可用)或 SSE 单独 channel。

### 10.6 权限撤销 / 补拉 / 压缩

- 连接绑 `actor+canvas+authz`;`removeMember`/撤销 share → **断流 + post-revoke 写拒绝**(`applyOpAuthz`→forbidden,G7-hard-3,不只断流)。
- 断线重连:`?since=seq` + **logFloor/gap 协议**(since<floor → gap=true+snapshot 客户端 reset,G7-hard-1)。
- 压缩:周期 snapshot + truncate opLog(G7-2);恢复等价经 snapshot+gap(G7-hard-2)。

### 10.7 DELETE cursor / 404 边界(G1-b R2-P1-3 对齐)

- DELETE 成功 → 返 seq(cursor);幂等已删(tombstone 命中)→ 亦返 seq(不 404,accepted 必携 cursor);canvas 不存在/无权/从未存在 → 404 → rejected(not-found,不冒充 cursor)(S10-9)。

### 10.8 create→edit 因果(G1-b R2-P1-2 对齐;R5 F1:create 走独立 POST endpoint)

- 同 canvas+record submit FIFO:pending create ack 前 hold 后续 edit;ack 后 flush(先 create 后 edit,不 404 丢改动)(S10-8)。
- 真不存在/已删 record 的 edit 仍 rejected(not-found);pending-local-create 的 edit 不走该终态。
- **R5 F1**:create 经独立 `POST /api/canvas/:id/nodes`(CreateBody,非 PATCH DomainOp)提交;submit FIFO 仍按 recordId 排队(ack create 前 hold 同 record 的 PATCH edit)。

### 10.9 迁移 / 双协议窗口 / 破坏面

- **无双协议窗口**(gate 6):#194 前端未接线→原地演进;PG JSONB payload 不透明不动。
- **破坏面非零**(§1.2):≥12 文件 + FX-5 队列 migration-on-read(旧 queued body→新 op schema 转换)+ stale client 旧 body 打新 endpoint → 400 `payload-rejected`(非 409 refetch)+ 117 项定向回归 + cutover 策略(原子,§1.2)。
- stale-client(旧 body 打新 endpoint):**400 `payload-rejected` → refetch**(非 409);409 revision-conflict 是 #194 envelope 复用码(parseIfMatch),新 field-level 协议 G4-4 明确 base 落后不拒写(200),故 stale-client 无 409(见 §1.2 cutover 状态表)。

---

## 11. 改写 N1 Q1-Q5 答案(原 N1 §6 决策清单,本决策覆盖)

| # | N1 原问 | **N2-0 v2 改写答案** |
|---|---|---|
| Q1 | CRDT doc 真相源归属 | **DocKernel(server-persisted record)为唯一真相源;NOT Y.Doc**。理由:现有底座是 Figma 式(§1);Yjs 移植拆写路径 + 双真相源(坑5);gate 3 跨介质事务 Yjs 非原子(G3-real-3)。DocKernel 演进为 field-level merge(gate 4 方案 A),revision 服务端赋值。 |
| Q2 | revision 派生算法 | **revision = per-record 服务端赋值的单调整数(每 accepted op +1)**,非 Yjs state 派生。用途:仅 snapshot/catch-up + legacy cache 校验,**不参与 LWW 拒写**(G4-4)。 |
| Q3 | server 持久化 Y.Doc 形态 | **不适用(不采 Yjs)**:server 持久化 = record payload(PG JSONB,不透明)+ per-canvas op log(seq)+ 周期 snapshot+truncate(G7-2)+ logFloor/gap(G7-hard-1)。无 Y.Doc update log/GC。 |
| Q4 | legacy↔CRDT bridge 翻译规则 | **不适用(无 CRDT 路径)**:legacy = 唯一路径;field-level PATCH 原地演进 #194(gate 6,无 bridge、无双协议窗口;但破坏面非零 §1.2)。 |
| Q5 | order_key/z-order CRDT 策略 | **维持 (b),且经服务端管**(非 Y.Array):`reorderChildren`(#194,If-Match contentVersion + 全等唯一校验 + 重分配 orderKey)。**不用 Y.Array delete+insert**(避 N1 坑3 并发 reorder 不保序)。 |

> Q6-Q10(Y.Array 元素 id、presence、断线重连、chat CRDT、Y.Doc GC)随 Yjs 否决一并 **不适用**;其语义由 Figma 式等价覆盖:presence→SSE/WS channel;断线重连→?since=seq+logFloor/gap 补拉;chat→per-user 独立 collection(DP-6R,非 CRDT);GC→snapshot+truncate。

---

## 12. 未验证项(○条件式,非"无需验证")

| 未验证项 | 影响谁 | 处理(条件式) |
|---|---|---|
| 生产 SSO 网关 WS upgrade 放行 + header 注入 | N2-2(WS 优化)/ Yjs(致命) | **○条件式留 lead 生产网关实测**;做到→N2-2 上 WS 优化;做不到→SSE 兜底,**Figma 选型不变** |
| 网关对 `text/event-stream` 缓冲/超时 | N2-2 SSE | ○条件式:lead 实测,必要时加心跳(5-2 heartbeat 已实现,生产网关缓冲未测) |
| 20k 节点高频 update 渲染性能 | N2-1/N2-2 | 复用 §12 风险4 的 26.7ms p95 基线,N2-2 做 pan bench(对齐 N1 §4 未验证项) |
| per-field clock 精确 stale 判定 | N2-1 实装 | 持久形态已定死(PG-T5 真测持久;S10-4 演示逻辑);生产加 per-field clock 做精确 stale(契约 §10.3) |
| canvas 文本同段共编真实需求 | 未来 | 若出现,N2-1 后对 `text` 单字段局部引入 OT/CRDT(不拖全局);v2 文本判决 B 已给 overwritten+restore 兜底 |
| #194 cutover 破坏面实际调用面 | gate4/gate6 | ▲lead 已核证 route 注册 + FX-5 payload + shared contract(§1.2);cutover 前补全量调用面审计 + 原子 cutover 策略(§1.2 拍死,非 versioned) |

---

## 13. 与计划/上游对齐(含 G1-b R2)

- **计划 §8 N2-0 七项 hard gate**:逐项两案 + 证据 + 成本 + go/no-go(§2);文本 gate 判决(§2 gate 1,P1-4 二选一 B);网关 gate 判决(§2 gate 5,○条件式留 lead);唯一推荐 + G1-c/N2-1 契约 v2(§10);改写 N1 Q1-Q5(§11)。✅ decision-complete v2。
- **计划 §4 G1-b/G1-c**:G1-b 两案契约 inventory 冻结为 Figma 式唯一(§10);G1-c 落本契约,无 Yjs 死接口。**G1-b R2 三 finding 对齐**(§10):FieldPath 非空 tuple(R2-P1-1,S10-6)/ 数组 by-stable-id(R2-P1-1,S10-7)/ create→edit 因果(R2-P1-2,S10-8)/ DELETE cursor(R2-P1-3,S10-9)。trusted actor/base/idempotency/seq 全留 adapter/transport 层(P2-8)。
- **计划 §8 N2-1**:op schema/field 边界/seq/revision 用途/事务路径 = §10 契约 v2 直接落地。
- **platform §6 CRDT-ready**:映射可行性保留(N1 证);但**采用 Yjs 否决**——CRDT-ready = 字段扁平可映射,不等于必须采 Yjs。属性级 LWW(field-level PATCH)满足"协作肯定要做"的演进不返工承诺。
- **platform §13.5 Figma 式**:与本法一致。

---

## 附:spike 文件结构索引

- `src/kernel/__spike__/n20-truth-source.spike.test.ts`(44 tests):
  - `makeNode` fixture + `setByPath`/`getByPath`/`fieldKeyOf`(硬化:拒原型污染 S10-1 + 拒空路径 S10-6 + R2-4 leaf validator 拒整对象 clobber S10-6)
  - `FieldLevelServer`:applyOp/applyOpAuthz(返 forbidden,G7-hard-3)/ deleteNodeCascade / **deleteNodeCascadeWithCursor**(S10-9)/ pullSinceWithGap(logFloor/gap,G7-hard-1)/ compress / snapshot / addMember/removeMember / storageBytes / deletedTombstones / **staging+commitStaged**(R2-3 batch 真单事务 S10-5)
  - `CommandUndoStack`(原 PoC)+ `ConditionalUndoStack`(返修:条件逆运算 P1-1)+ `TextLwwWithOverwrite`(P1-4 B 方案,**restore 走 overwrite 管线全链 R2-5 T1-5**)
  - `yjsMatrixSetup`(真 Yjs UndoManager 同矩阵 helper)
  - G4+G1(5)/ G3(2)+G3-real(3)/ G2(2)+M1-M6(6)/ G7(3)+G7-hard(4)/ G5(1)/ antiYjs(2)/ S10(5)+S10-6~9(4)/ T1(4)+**T1-5(R2-5)**/ **S10-10 immutable/atomic leaf(R2-3)**/ **S10-11 idempotent replay(R2-3)** = **44 tests**
- `server/__tests__/n20-sse-route.spike.test.ts`(8 tests):真实 Hono SSE route(content-type/heartbeat/since/revoke/authz/slow-consumer + **5-7 live push R2-2** + **5-8 slow-reader 恢复 R3 F3**;5-5 真实 resolveActor/canAccessCanvas authz seam)
- `server/__tests__/n20-pg-tx-fault.spike.test.ts`(4 tests):真实 PG transaction fault injection(原子提交/fault ROLLBACK/同库资产元数据(R2-1 改名)/无事务 partial 对照;本地 PG 55443 实跑 MIVO_PG_TEST=1 转 pass;**全部 PG-T 同一 client pool.connect+finally release**)
