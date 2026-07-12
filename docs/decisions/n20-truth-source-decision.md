# N2-0 真相源拍板:Figma 式 vs Yjs(返修重评分 v3,R2 复审返修,decision-complete)

> 状态:**v6 决议收口(sol 第五轮终审 3 阻断修复,等 lead + sol6 第六轮终审)**。v5 被 sol 第五轮判 FAIL(Gate5 闭环;余 3 阻断)。**v6 病根:v5 追加式 supersede 致两套矛盾模型并存(active 段原文未动,测试各自绿)。v6 硬禁令:禁止追加式修复;必须直接重写 active 段原文。历史保留就标 [superseded, non-normative],不再列为当前证据。** v6 收口 3 阻断(见 §14):① BaseCursor 绑 scope(canvasId+recordId)+ per-field clock(防跨 record/canvas 重放 + 同-field stale 才 overwritten,不同字段 stale 不误报);② active 段直接重写清零旧模型残留(:nid/裸 revision/普遍 409 rebase/strict-tx/无 :nodeId create/atomic-container/by-id supported/旧 queue→DomainOps)+ S10-10 删 atomic-container + S10-7 by-id 标 [superseded];③ FX-5 走 LegacyReplaceRequest 信封 wire(raw old body→400, envelope→200 replace,非直调 drainLegacyUpsert;gate/观测/retirement)。NOTES(§14.7):edit stale 永不 409 同-field stale 才 overwritten;BaseCursor 绑 scope+field-clock 业务层 opaque;create 唯一 POST /nodes/:nodeId;leaf-level 无白名单;by-id fail-visible deferred;legacy replace 只走可关闭可观测 drain 通道;server-named 仅 cascade 实证;Gate5 失败树固定。
> 日期:2026-07-13(v6 决议收口)。
> 任务来源:`docs/plan/remaining-tasks-cutover-plan.md` §8 N2-0(7 hard gate,逐字执行)。
> 前置:`docs/spike/n1-yjs-mapping.md`(N1 结论 + Q1-Q10)、`docs/decisions/record-schema.md`、`src/kernel/{docKernel,records,adapters}.ts`、`docs/decisions/platform-architecture-2026-07-07.md`。
> 验证产物(全绿):
> - `src/kernel/__spike__/n20-truth-source.spike.test.ts`(55 tests:15 原 + 18 返修 + 8 补缺 + 3 R2 增 + **v4:3 S10-12/13/14 冻结矩阵/server-named/array defer + CutoverHarness 改真实 WriteOp+NodePayload 四类 + 4 交叉契约 X-1~X-4**)
> - `server/__tests__/n20-sse-route.spike.test.ts`(13 tests,真实 Hono SSE route 集成 + R2-2 live push 5-7 + desiredSize backpressure + R3 F3 authz seam + R5 F3 post-revoke write + **v4:4 网关失败树 5-10~5-13 first-frame/header-strip/short-poll fallback SLO**)
> - `server/__tests__/n20-pg-tx-fault.spike.test.ts`(8 tests,真实 PG transaction fault injection + R2-1 同一 client + R3/R5 F2 持久/跨 record/真实 replay)
>
> **76 pass / 0 skip / 0 fail**(spike 55 + SSE 13 + PG 8;本地 PG port 55443 实跑,PG-T1~T7(含 T6b) 同 client 真 pass);`tsc -b` 0 errors;`eslint` 干净;`npm run build` exit 0;`grep -roE 'yjs|lib0|YEvent|applyUpdate|AbstractType|encodeStateAsUpdate' dist/` **零命中**(yjs 不进生产 bundle)。
>
> **倾向 Figma 式,但措辞降级为"基于现有底座与迁移成本的推荐"(R2 纲)** — 非"七 gate 全 GO 的充分判据";Gate3/7 平局、Gate5 条件式。结论见 §0,被推翻/修正表述见 §3。**v4 收口 6 阻断见 §14。**

---

## 14. v6 决议收口(sol 第五轮终审 3 阻断逐条修复)

> sol 第五轮终审判 FAIL(Gate5 已闭环;余 3 阻断)。**v6 病根:v5 追加式 supersede 致两套矛盾模型并存(active 段原文未动,测试各自绿)。v6 硬禁令:禁止追加式修复;必须直接重写 active 段原文。历史保留就标 [superseded, non-normative],不再列为当前证据。** 3 阻断 + server-named 诚实化 + cross-contract 如下,逐条对应文档段落 + 可运行契约测试佐证。

### 14.1 Blocker 1 — BaseCursor 绑 scope + per-field clock(防跨 record/canvas 重放 + 同-field stale 语义)

- **v5 两洞**:① codec payload {rev,cv?} token 可跨 record/canvas 重放(n1 rev=1 token 能用于 n2;HMAC 只防改值不防换资源);② 无 per-field clock,S10-12 用 record-rev 落后判 overwritten(别的字段变过也误报,违反 §10.3 同-field 语义)。
- **v6 修:token 绑 scope + per-field clock**:`encodeBase(canvasId, recordId, revision, fieldClocks)` → signed opaque token(绑 canvasId+recordId+revision+per-field clock snapshot);`decodeBase(token, expectedCanvasId, expectedRecordId)` 验签 + **scope 校验**(canvasId+recordId 必须匹配 path;scope mismatch→null→400)。order base `encodeOrderBase(canvasId, cv)`(canvas-scoped)。
- **同-field stale 才 overwritten**:edit 比较 `base.fieldClocks[field]` vs `current.fieldClocks[field]`;**同-field stale→200+overwritten**;**不同字段 stale→200 无 overwritten**(v6 per-field clock 修正 v5 record-rev 误报)。edit 永不 409(G4-4)。
- **base-driven 冻结矩阵(承接 v5)**:delete fresh base→200, stale→409;reorder fresh cv→200(顺序变也成功), stale cv/orderedIds≠live→409;create dup→409;malformed/scope-mismatch→400。
- **删 S10-4 平行明文 BaseWithClock**:统一走同一 BaseCursor codec 生命周期(S10-4 client base = `encodeBase` token,非平行 BaseWithClock type)。
- **契约测试佐证**:S10-2(真 codec round-trip + scope mismatch n1→n2/c1→c2→null + 签名错→null + base 非 bare number `@ts-expect-error`)+ **S10-12(BaseDrivenHarness:同-field stale→200+overwritten;不同字段 stale→200 无 overwritten;n4 token→n3 scope-mismatch→400;c1 order→c2 scope-mismatch→400;delete/reorder fresh→200 stale→409;create dup→409;malformed→400)**+ S10-4(删 BaseWithClock,统一 codec)。

### 14.2 Blocker 2 — active 段直接重写清零旧模型残留

- **v6 硬禁令:禁止追加式修复;直接重写 active 段原文**(v5 追加 supersede 致两套并存)。逐处清零旧模型残留:
  - `:nid`/无 `:nodeId` create → 统一 `POST /api/canvas/:id/nodes/:nodeId`(client-id path);
  - 裸 `revision`/`currentRevision` envelope-revision 旧模型 → opaque BaseCursor(绑 scope+field-clock);
  - 普遍 409 rebase → edit stale 永 200+overwritten(非 409 非 rebase);409 仅 delete/reorder stale + create dup;
  - `strict-tx` → 剔出 DomainOp 改 server-named;
  - `atomic-container` → 删(白名单取消,S10-10 改 container 整对象 set 拒,leaf-level);
  - `by-id supported` active 证据 → by-id A2 deferred(S10-7 标 [superseded, non-normative]);
  - 旧 queue→DomainOps → legacy 兼容通道(§14.3)。
- **测试矛盾对拆**:S10-10 删 atomic-container(FieldMutability = 'immutable'|'container'|'leaf',无 atomic-container;transform/relations 整对象 set 拒);S10-7 by-id 标 [superseded, non-normative](by-id active 证据移出,仅 whole-lww + primitive 为 active)。
- **Gate5 §14.5 交叉引用统一到 §14.4**;删 "或 mode=poll" 二选一,只留冻结 route `GET /events/poll?since=`。
- **契约测试佐证**:S10-10(无 atomic-container;transform/relations container 整对象 set 拒)+ S10-7(by-id [superseded];active 仅 whole-lww + primitive)+ S10-14(FieldTarget 无 atomic-container expectTypeOf)。

### 14.3 Blocker 3 — FX-5 走 LegacyReplaceRequest 信封 wire(非直调 drainLegacyUpsert)

- **v5 病根**:C-2 直调 harness 私有 `drainLegacyUpsert`(无 wire)→ 无法同时满足"旧 queue 可 drain"与"raw 旧 body 400"。
- **v6 修:定义 versioned `LegacyReplaceRequest` 信封**(独立于 DomainOp + raw NodePayload):`{ kind: 'legacy-replace'; nodeId; payload: NodePayload; version: 1 }`。升级客户端把旧 WriteOp 包进它走 **专用 decoder branch**(同 PATCH endpoint,decoder 区分 DomainOp/信封/raw body)。
- **decoder wire**:flag-on + DomainOp→200;flag-on + LegacyReplaceRequest→200 replace(LEGACY_DRAIN gate + authz 同 canvas write + envelope.nodeId 必须匹配 path 防 forge + 观测计数 drainCount + retirement 条件 gate 关后→400);**flag-on + raw NodePayload(无 kind)→400**(必须包信封);flag-off + NodePayload→200(legacy upsert)。
- **authz/base/conflict/feature gate/观测/retirement**:authz 同 canvas write;gate `LEGACY_DRAIN`(cutover drain 窗口);观测 drainCount;retirement 条件(drainCount 归零后关 gate,兼容通道关闭,raw body 也 400)。
- **仓库事实**:旧 upsert=replace(`backend.ts:1086-1088`);不翻译为 DomainOps(replace≠field-level;delta-inversion 无算法);不发明 by-id/whole-lww DomainOp 不绕 by-id defer;缺失字段=移除(replace 覆盖,非 unset/merge)。
- **为何不算"双协议窗口"(§1.2 原子 cutover 例外术语边界)**:LegacyReplaceRequest 是 drain-only 临时信封(可关闭可观测,retirement 后消失),非新旧 endpoint 并存窗口;主写路径唯一 DomainOp,信封仅 drain 队列残留。
- **契约测试佐证**:`src/kernel/__spike__/n20-truth-source.spike.test.ts` C-1(flag decoder)+ **C-2(raw old body→400;LegacyReplaceRequest 信封经 decoder wire→200 replace,非直调 drainLegacyUpsert;envelope.nodeId 防 forge→400;LEGACY_DRAIN gate 关→400 retirement;whole-record replace deep-equal;replace 覆盖非 merge;delete→cascade;reorder→DomainOp)**+ C-4(rollback snapshot materialize)。

### 14.4 Gate5 finite short-poll 真模式(v5 闭环,保持)

- **finite poll 真模式**:GET `/api/canvas/:id/events/poll?since=`(冻结 route,无 "或 mode=poll" 二选一)→ 响应 `{events, nextSince}` JSON,**服务端自然结束**(非长流);content-type `application/json`(非 SSE);只含 seq>since 条目。
- **fallback = finite short-poll**(非 "SSE 失败由 SSE fallback" 循环;永不关闭 SSE 流读两帧 cancel 不算 poll)。**失败树(NOTES 保持)**:Gate5 失败只能 调 proxy buffering/read-timeout/flush → finite short-poll → N2-2 blocked。
- **契约测试佐证**:`server/__tests__/n20-sse-route.spike.test.ts` **5-12(GET /events/poll?since= 返 JSON,服务端自然结束,500ms SLO)** + 5-10(首帧 SLO)+ 5-11(header strip→404)+ 5-13(失败树步骤冻结)。

### 14.5 server-named 诚实化(保持)

- 仅 `node-delete-cascade` 经 PG-T1~T3/T7 实证;`group-reparent`/`result-asset-attach` 类型+注释级 A2 需另测。S10-13 `EMPIRICALLY_PROVEN` 分级。

### 14.6 两文档交叉契约(保持)

- port CanvasChange ↔ N20 CreateBody/DomainOp 无损映射(X-1~X4);inventory §5 item 5 网关条件式 + §11 v6 收口。

### 14.7 NOTES 保持(sol 冻结,写进决议供 A2)

- edit stale 永不 409,**同 fieldPath stale 才 overwritten**(不同字段 stale 不误报);BaseCursor 绑 scope+field-clock,业务层 opaque;create 唯一 POST /nodes/:nodeId;leaf-level 无白名单;by-id fail-visible deferred;legacy replace 只走可关闭可观测 drain 通道;server-named 仅 cascade 实证;Gate5 失败树固定。

---

---

## 0. TL;DR(结论先行 + 七 gate 重评分表)

**推荐(基于现有底座与迁移成本;非"七 gate 全 GO 的充分判据"):Figma 式(服务端做主 + 属性级 LWW + REST/SSE 实时广播)。NOT Yjs。NOT 双轨。**

> **R2 复审降级措辞(R2-1/R2-7)**:推荐 Figma 式 **非因"七 gate 全 GO"**,而是基于:① 现有底座本就是 Figma 式(§1.1);② Yjs 移植成本(拆写路径 + 双真相源);③ Gate3/7 平局、Gate5 条件式——非相对 Yjs 的全 GO 优势。Gate1/2/4/6 维持 GO(有真证据)。

推荐理由(诚实缩窄后仍成立,非偏好):
1. **现有底座本就是 Figma 式**:`DocKernel`(record 级 upsert + per-record revision)+ #194 PATCH(If-Match 400/428/409,payload 对 server 不透明)+ `owner.ts` SSO(header 注入 fail-closed)。platform §13.5 明写"Figma 式"。Yjs 是移植外物。
2. **Yjs 移植成本 = 拆已建成的写路径 + 双真相源调和**:N1 §3.1 实证 `revision ↔ Yjs` 双真相源背离;本 spike `antiYjs-坑5` 复现背离、`antiYjs-坑7` 复现 clear+rebuild 吞子字段(§9)。
3. **跨介质/跨 doc 事务:Gate3 平局(R2-1)**:intra-doc/intra-DB 原子两案一致(G3-real-1 真 Yjs doc.transact / PG-T1~T3 同一 client 已验);**跨介质 Figma=saga 补偿非真原子、Yjs=无方案** — 非相对优势(原 v2 "Figma 占优"降为平局)。PG-T3 改名"同库资产元数据"(非跨介质)。
4. **revoke 简单 + 可预测存储控制(非"存储更小"):Gate7 平局(R2-7)**:G7-hard-4 ★真测 Yjs 有 GC 时 bytes 更小(yjsWithGc=58B < figmaCompressed=8637B);G7-hard-1~3 降 ●/○(自建 server 无 Yjs 对照,原标 ★ 虚标)。Figma 真实优势 = revoke 简单(●/○ 设计推理,非 Yjs 对照实证)+ 可预测控制 — 非相对存储优势。
5. **Figma 不依赖 WS 网关验证:Gate5 条件式 GO(R2-2)**:REST+SSE 走 plain HTTP(5-1~9 真验 live push+desiredSize backpressure+gateway-secret authz seam+post-revoke write 拒绝 + **v4 5-10~13 网关失败树**);网关 SSE buffering/超时 = ○条件式留 lead 生产实测(§12 + §14.4),非"无需验证";Yjs y-protocol 需双向 WS(网关 WS 放行亦条件式)。不影响 Figma 选型(**finite short-poll 兜底**,非 SSE-fallback 循环,§14.4)。

| # | hard gate | 判决 | 证据强度 | v1→v3 变化 |
|---|---|---|---|---|
| 1 | 文本同编 | **Figma GO** | ○分析 + ●契约探针(T1-1~5) | 二选一写死 **B**(LWW200+overwritten+restore,**restore 走 overwrite 管线 R2-5**);删"罕见"断言;标注产品决策 |
| 2 | 多人 undo/redo | **Figma GO** | ★真实库对照(M1-M6 真 Y.UndoManager) | 修正 naive inverse bug;条件逆运算语义对齐真 Yjs |
| 3 | 跨 record 事务 | **平局**(R2-1) | ★真实库对照(G3-real)+ ●真实 PG(PG-T 同 client) | intra 原子两案一致;跨介质 Figma=saga 非真原子、Yjs=无方案;PG-T3 改名同库资产元数据;**v2 "Figma 占优"→v3 平局**(诚实) |
| 4 | revision×属性 LWW | **方案 A GO** | ●集成(G4)+ ▲lead 核证 | "零破坏"→"前端未接线但契约/服务端破坏面非零";§1.2 inventory **逐文件 + cutover 拍死**(R2-6) |
| 5 | 实时 transport+auth | **条件式 GO**(R2-2) | ●真实集成(5-1~9 Hono SSE) | G5-1~9 真实 SSE(**live push 5-7 + desiredSize backpressure 5-6 + R3 F3 真实 resolveActor/canAccessCanvas authz seam 5-5(404 no-leak)+ slow-reader 恢复 5-8 + R5 F3 post-revoke write 拒绝 5-9**);网关 SSE buffering = ○条件式留 lead(非"无需验证") |
| 6 | 迁移/双协议窗口 | **Figma GO** | ▲lead 核证 + ○分析 | "无双协议窗口"成立;但"零破坏"推翻 → 破坏面 inventory(§1.2 逐文件)+ cutover 拍死原子方案(R2-6) |
| 7 | seq/补拉/压缩/revoke/存储 | **平局**(R2-7) | ★真实库对照(G7-hard-4)+ ●/○(G7-hard-1~3 自建 server) | G7-hard-1~3 降 ●/○(自建 server 无 Yjs 对照,原 ★ 虚标);G7-hard-4 ★真测 Yjs 更小;优势改为 revoke 简单(●/○ 非对照)+ 可预测控制 — **v2 "Figma GO"→v3 平局** |

**唯一推荐 → G1-c/N2-1 契约 v3(对齐 G1-b R2 + R2-3/R2-4)见 §10;改写 N1 Q1-Q5 见 §11。**

### 0.1 证据强度图例

| 标记 | 含义 | 本决策的此类证据 |
|---|---|---|
| ★ | 真实库对照 | 真实 `yjs` / `Y.UndoManager` / `Y.Doc.transact` / `encodeStateAsUpdate` 跑同矩阵(M1-M6 / G3-real / G7-hard-4 / antiYjs) |
| ● | 集成测试 | 真实 Hono SSE route(5-1~9)/ 真实 PG transaction fault injection(PG-T1~T7(含 T6b))/ FieldLevelServer 集成(G4/G7/S10/T1/C-1~C-4) |
| ▲ | lead 核证生产调用 | lead 已 spot-check 生产代码引用(canvas.ts:450-522 / shared/persist-contract.ts:76 / writeRetryQueue.ts:16-19) |
| ○ | 仍属分析 | 未跑生产网关 / 未压测 20k 渲染;条件式标注,非"无需验证" |

---

## 1. 现有底座事实(对比基线)+ 破坏面 inventory(P1-6 诚实化)

### 1.1 已建成的 Figma 式基础

| 组件 | 文件 | 现状 | Figma 式特征 |
|---|---|---|---|
| DocKernel | `src/kernel/docKernel.ts` | record 级 upsert + 三 Map + per-record revision | 服务端真相 + per-record revision LWW tie-break |
| NodeRecord | `src/kernel/records.ts` | 40 canonical 字段 + revision;`text?` 整串叶子 | 字段扁平可映射 Y.Map —— 但映射≠采用 |
| #194 API 契约 | `server/routes/canvas.ts:450-525` + `server/persist/backend.ts` | `PATCH /api/canvas/:id/nodes/:nodeId` → `upsertChild`;If-Match = opaque BaseCursor(绑 scope+field-clock;400 malformed/428 missing;edit stale→200 非 409);payload 对 server 不透明 | 服务端做主 + If-Match opaque BaseCursor + base-driven 409(仅 delete/reorder stale + create dup) |
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

**定向回归冻结命令**(R2-6 要求可执行命令集合;R5 F4 修正 `npm test`→`npm run test:unit`;项数以 runner 实跑为准,当前 118 pass / 32 skip):

```bash
# 破坏面全量调用面审计(grep 12 文件)
grep -rn 'upsertChild\|validateChildPayload\|NodePayload\|UpsertRequest\|UpsertResponse\|WriteOp.*upsertNode' src/ server/ shared/ --include='*.ts'
# 定向回归测试集(契约 + 集成 + 队列;R5 F4 修正:原 `npm test` 不存在,本仓 script 是 `test:unit` = `vitest run`)
npm run test:unit -- src/lib/serverPersistAdapter.contract.test.ts server/persist/backend.test.ts server/persist/backend.pg.test.ts server/persist/backend.contract.dual.test.ts src/lib/writeRetryQueue.test.ts
```

**措辞修正**:v1 "零破坏面、无迁移窗口" → v3 "**前端主路径未接线(`unwiredServerPersistAdapter`),但契约/服务端破坏面非零(逐文件清单 12 项 + FX-5 队列迁移 + 118 项定向回归)**"。

**cutover 方案拍死(R2-6:选一个,说理由)**:**原子 cutover**(非 versioned endpoint)。理由:
1. **无双协议窗口成立**:#194 `unwiredServerPersistAdapter` 前端未接线 → 原地演进,无新旧 endpoint 并存窗口 → 不付双 endpoint 王税。
2. **单次部署切 schema**:部署带 feature flag(`FIELD_LEVEL_OPS=on`),切 field-level op schema;可切回整 record payload 回滚。
3. **FX-5 队列迁移(v5 Blocker 3:走 legacy 全量 record 兼容通道,非域 DomainOps)**:仓库事实——旧 `upsertChild` = 整 record **REPLACE**(`backend.ts:1086-1088` `payload: clone(payload)`,非 merge)。旧 IDB queued `WriteOp`(upsertNode/deleteNode/reorderChildren,writeRetryQueue:73-99)→ migration 走 **legacy 全量 record 兼容通道**(drain-only,whole-record replace 同 backend.ts;**不翻译为 DomainOps**——replace≠field-level,delta-inversion 无算法;**不发明 by-id/whole-lww DomainOp,不绕 by-id defer**);deleteNode→server-named cascade;reorderChildren→DomainOp reorder。payload = `NodePayload`(Omit<NodeRecord,'id'|'revision'>,**id 不在 payload**,id 来自 WriteOp.nodeId);缺失字段=移除(replace 覆盖,非 unset/merge)。stale client(旧 body)打新 endpoint → 400 `payload-rejected` → refetch(非 409)。
4. **回滚策略**:feature flag 切回 `FIELD_LEVEL_OPS=off` → 整 record payload decoder;rollback 从 authoritative 全 record snapshot materialize 旧 shape body(非 delta 反演;delta-inversion 无算法/不支持,见下注 + spike C-4)。
5. **不选 versioned endpoint 的理由**:方案 B(新增 `POST /nodes/:nodeId/ops` versioned + #194 冻结)付双 endpoint 税,但 #194 前端未接线 → 方案 B 无"不动 #194"收益,纯增成本。

> 注:**"无双协议窗口"仍成立**(原子 cutover + #194 unwired → 原地演进,无双 endpoint 并存);但"零破坏"不成立(逐文件 12 项 + FX-5 迁移 + 118 项回归)。Gate6 判决据此(§2 Gate6)。

**cutover 状态表(R3 唯一可执行协议;契约测试命令 = §1.2 定向回归 + grep 调用面审计,dry-run:grep 调用面审计实跑通过(匹配数以实跑为准,不硬编码) / 5 测试文件全在 / `npm run test:unit` 118 pass 32 skip)**:

| 场景 | flag / 时机 | 客户端发 | 服务端行为 | 状态码 | 客户端动作 |
|---|---|---|---|---|---|
| old client(旧 body)→ 新 server | `FIELD_LEVEL_OPS=on`(cutover 后) | 整 record payload(旧 shape) | `validateChildPayload` 拒(非 `DomainOp` shape) | **400 `payload-rejected`** | refetch 全量 → 重发新 op(非 409 重放) |
| old queue(FX-5 IDB 旧 queued `WriteOp`:upsertNode/deleteNode/reorderChildren) | cutover 后 drain 队列 | 旧 queued `NodePayload`(id 在 WriteOp.nodeId,非 payload) | **legacy 全量 record 兼容通道**(drain-only whole-record replace 同 backend.ts:1086-1088;非 DomainOps;不绕 by-id defer;C-2 deep-equal) | 200 ok(drain 兼容通道) | 客户端无感(队列 drain 时 whole-record replace) |
| new server(新 op schema) | `FIELD_LEVEL_OPS=on` | `DomainOp` / `DomainOp[]` | field-level merge + bump revision/seq | 200 `{id,revision,seq}` | 正常 |
| new op + stale base(并发不同字段) | 运行时 | `DomainOp`(base 落后) | LWW 后写 wins + `overwritten` 推前写者(G4-4 不拒写) | 200 + overwritten(非 409) | 前写者收 overwritten → 可选 `restore` |
| rollback(flag off) | `FIELD_LEVEL_OPS=off` | flag off 切回整 record decoder | 从 **authoritative 全 record snapshot materialize 旧 body**(非 delta 反演;见下注) | 200(旧 shape) | snapshot materialize 旧 body → PATCH 200 |

> **R5 F4 rollback 降级**:原表称 "新 op → 旧 body 反向转换,无丢失"。`DomainOp` 是 delta(fragment),无 authoritative snapshot 无法无损反演完整旧 `NodePayload` — 原承诺无证据(无算法/无 probe)。**降级为 snapshot materialize**:rollback 从 authoritative 全 record snapshot 直接 materialize 旧 shape body(源头是全 record 非 delta,可证明无丢失)。delta-inversion(从单个 delta 反演完整旧 body)显式**无算法/不支持**(降级到已测范围)。spike C-4 验:`materializeLegacyBody` 从 authoritative snapshot 直出旧 body,flag-off PATCH 200。
>
> 全文不再有 "versioned payload 或原子 cutover" / "versioned/原子" 二选一残句;cutover = **原子**(§1.2 拍死)。stale-client(旧 body schema 不匹配)唯一状态码 = **400 `payload-rejected`**;409 revision-conflict 是 #194 envelope 复用码(`parseIfMatch`),新 field-level 协议 G4-4 明确 base 落后不拒写(200),故 stale-client 场景无 409(§1.2 状态表 / §10.2 / §10.9 / §2 Gate6 一致)。
>
> **R5 F4 cutover contract harness**:状态表 5 行逐行参数化探针在 `src/kernel/__spike__/n20-truth-source.spike.test.ts` C-1~C-4:flag on/off decoder(C-1,row 1/3)、old-queue migration-on-read(C-2,row 2)、new-op+stale-base 200 非 409(C-3,row 4,对齐 G4-4/T1-1)、rollback=snapshot materialize(C-4,row 5)。冻结命令已 dry-run:grep 调用面审计实跑通过(匹配数以实跑为准,不硬编码) / 5 测试文件全在;命令修正 `npm test` → `npm run test:unit`(V16/V17 验)。

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
| envelope | **v4 Blocker 1**:If-Match 必填(428)+ 格式校验(400)+ opaque BaseCursor 单一 wire;**409 仅 create/delete/reorder race**(edit stale 永远 200,G4-4);非"409 envelope 不变"歧义 | 双 endpoint 并存 |
| revision 语义 | per-record,每 accepted op bump,**只供 snapshot/catch-up,不参与 LWW 拒写**(`G4-4`) | 同 |
| 生产破坏面 | **前端未接线但契约/服务端破坏面非零**(§1.2:≥12 文件 + FX-5 队列迁移 + 118 项回归) | 不动 #194,新 endpoint 独立上线 |
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
| 网关 WS 不放行时 | SSE 仍可用(plain HTTP);SSE 亦降级时 finite short-poll 兜底(§14.4) | 需 polling fallback,失 CRDT 实时价值 |
| auth 复用 | 复用 #194 SSO header 链(SSE 同链) | WS handshake 需网关注入(未验证) |

**go/no-go**:**条件式 GO(R2-2)**。Figma 式 REST+SSE:5-1~13 真实验证(**live push 5-7 + desiredSize backpressure 5-6 + R3 F3 真实 resolveActor/canAccessCanvas authz seam 5-5(404 no-leak,替代 fake secret)+ slow-reader response body 恢复 5-8 + R5 F3 post-revoke write 拒绝 5-9(真实 seam PATCH write route:bob 撤权 → 404 no-leak + owner 200)**,复用 owner.ts fail-closed 模式;非 v2 直信 x-mivo-auth-user)。**网关 gate 条件式 + v4 失败树**:网关对 `text/event-stream` buffering/超时 = ○条件式留 lead 生产实测(非"任何网关必透传"——生产网关可能缓冲);**v4 Blocker 5 失败树(§14.5)**:首帧延迟超 SLO / header strip → 调 proxy buffering/read-timeout/flush 复测 → 仍失败 → **`?since=seq` short-poll fallback**(SLO 500ms,5-12)或判 N2-2 blocked。**非 "SSE 失败由 SSE fallback" 循环**(fallback = short-poll,5-13)。不影响 Figma 选型(short-poll 兜底),只影响实时性调优。Yjs 依赖 WS 网关放行(亦条件式未验证)。

**未验证项(○条件式,留 lead 生产实测,§12 + §14.4 失败树)**:
1. 生产 SSO 网关是否代理 WS upgrade + 注入 `x-mivo-auth-user`/`x-mivo-gateway-secret`(条件式:做到→N2-2 上 WS 优化;做不到→SSE/short-poll 兜底,**Figma 选型不变**)。
2. SSE 长连接在网关的超时/缓冲/首帧延迟/header strip(5-2 heartbeat 已实现;**v6 失败树 §14.4**:首帧超 SLO 200ms / header strip → 调 proxy buffering/read-timeout/flush 复测 → 仍失败 → finite short-poll `GET /events/poll?since=` SLO 500ms 或判 N2-2 blocked)。
3. 网关对 `text/event-stream` 的 streaming 行为。

→ **这些不标"无需验证",标"条件式":Figma 式有 finite short-poll 兜底不影响选型(§14.4 失败树);只影响 N2-2 是否上 WS 优化。**

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

**成本**:Figma 式 0 双协议窗口(原地演进);但破坏面 inventory(§1.2:≥12 文件 + FX-5 队列迁移 + 118 项回归 + cutover 策略)。Yjs:legacy↔CRDT bridge 翻译规则 + per-canvas flag + 双协议并存窗口。

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
| v2 Gate5 "SSE skeleton replay + 直信 x-mivo-auth-user + 任何网关必透传" | v3 **条件式 GO**(R2-2):live push 5-7 + desiredSize backpressure 5-6 + gateway-secret authz seam 5-5(复用 owner.ts fail-closed)+ R5 F3 post-revoke write 拒绝 5-9;网关 SSE buffering 改条件式(非"必透传") | `5-1~9`(●真实集成) |
| v2 §10 trustify 无 header 参数(opId 实取 body)+ DomainOp 带 recordId + clock 内存 Map + batch 逐条 mutate | v3 **真三层**(R2-3):trustify 注入 idempotency-key header(opId 单一权威,弃 body.opId);DomainOp 中性 delta(无 recordId/actor/base/opId,adapter 注入);clock PG field_clock schema + 客户端 base.clock;batch 真单事务(staging+commitStaged,无 partial);immutable/atomic leaf 表 + idempotent replay | `S10-2/3/4/5/10/11`(●) |
| v2 §10 数组写死 {id:string} + FieldPath 只堵 [] | v3 **三类数组 + leaf validator**(R2-4):by-id(有 stable-id)/whole-lww(无 stable-id markupPoints)/primitive(resultNodeIds string[]);setByPath 拒 ['transform']+整对象 clobber(对照 mivoCanvas.ts:69-74,249) | `S10-6/7`(●) |
| v2 restore 直调 applyOpAuthz(B 收不到 overwritten,lastWriter 错停) | v3 **restore 走 overwrite 管线**(R2-5):败方(当前 lastWriter)收 overwritten;lastWriter 链持续 | `T1-2/T1-5`(●) |
| v2 §1.2 "≥12 文件" + 定向回归无冻结命令 + cutover 二选一未决却称"无双协议窗口" | v3 **逐文件 12 项清单 + 冻结命令(R5 F4 修正 npm run test:unit)+ cutover 拍死原子**(R2-6):无双协议窗口保留(原子 cutover + #194 unwired) | §1.2 inventory(▲lead 核证) |
| v2 Gate7 G7-hard-1~3 标 ★(自建 server 无 Yjs 对照,虚标) | v3 **降 ●/○**(R2-7);仅 G7-hard-4 ★真测;Gate7 重评平局 | `G7-hard-1~3`(●/○)+ `G7-hard-4`(★) |
| v2 隐含"Yjs 无原生 coalescing" | v3 修正:Yjs 有 UndoManager captureTimeout 合并(M5 证两案一致,非"无原生 coalescing") | `M5`(★真 Y.UndoManager) |
| v2 "任何 HTTP 网关必透传 SSE" | v3 改条件式:网关应透传(plain HTTP)但生产可能缓冲/超时(○条件式留 lead 实测) | §2 Gate5 仓库侧分析(R2-2) |
| §1.2 cutover 状态表 5 行无 probe + 冻结命令 `npm test` 不存在 + rollback "delta 反演无丢失"无算法 | **R5 F4**:新增 C-1~C-4 cutover contract harness(逐行参数化状态表);冻结命令修正 `npm run test:unit`(V16/V17 dry-run);rollback 降级为 **snapshot materialize**(authoritative 全 record → 旧 body,非 delta 反演;delta-inversion 显式无算法/不支持) | `C-1~C-4`(●)+ V16/V17 dry-run |

---

## 4-9. PoC 清单与实跑结果(65 tests 全绿)

**文件**:`src/kernel/__spike__/n20-truth-source.spike.test.ts`(48)+ `server/__tests__/n20-sse-route.spike.test.ts`(9)+ `server/__tests__/n20-pg-tx-fault.spike.test.ts`(8)。

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
| S10-3 typed domain op union | P1-3 | §10 | set/unset/array/reorder 可区分;**v4:strict-tx 已剔出 DomainOp**(改 server-named ServerInvariantCommand,S10-13);**create 独立 CreateBody+trustifyCreate(client-id,非 server-mint)** | ● |
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

### 4.4 真实 SSE route 集成(9 tests:5-1~6 R2 + 5-7 R2-2 live push + **5-8 R3 F3 slow-reader 恢复** + **5-9 R5 F3 post-revoke write 拒绝**;5-5 R3 F3 改真实 authz seam)

见 Gate5 §2(5-1 content-type/framing、5-2 heartbeat、5-3 since 补拉、5-4 revoke 断流、5-5 authz **404 no-leak**(R3 F3 真实 seam,原 403 系 fake secret)、5-6 slow consumer 有界 + response body 实收(R3 F3);5-7 live push、5-8 slow-reader 恢复、5-9 post-revoke write 拒绝见 §4.6)。强度 ●。

### 4.5 真实 PG fault injection(8 tests:PG-T1~T4 R2-1 同 client + **PG-T5/T6/T6b/T7 R3/R5 F2 持久/跨 record/真实 replay**,本地 PG 55443 实跑)

见 Gate3 §2(PG-T1 原子提交、PG-T2 fault ROLLBACK、PG-T3 同库资产元数据(R2-1 改名,非跨介质)、PG-T4 无事务 partial 对照;**R5 F2:PG-T6 单事务原子写领域 record+seq+event+idem row → destroy pool → 重连走真实 replay path → SELECT idem 命中 cached,不二次 apply 领域写 / 不二次 bump revision/seq / 不二次 append event;PG-T6b 首次事务 fault → 领域写+idem row 同事务 ROLLBACK(idem row 不落地,重试可重做非误判 dedup)**)。强度 ●。

### 4.6 R2 增补探针(4 tests:3 spike + 1 SSE,R2 返修新增)

| PoC | finding | gate | 断言 | 强度 |
|---|---|---|---|---|
| T1-5 restore 走 overwrite 管线全链(A写→B写→A restore→B收 notice→B后续写→A收 notice) | R2-5 | 1 | `overwrittenTo==='bob' && aliceInbox.length===2 && bobInbox.length===1`(lastWriter 链不断) | ● |
| S10-10 immutable/leaf 字段表 | R2-3 | §10 | `immutable 字段 set→throw;container(transform/relations)整对象 set 拒(leaf-level,无 atomic-container 白名单);其余 leaf set ok`(v6 删 atomic-container) | ● |
| S10-11 idempotent replay | R2-3 | §10 | replay 逻辑(内存 Map)+ **R5 F2:PG-T6 真实领域 replay**(单事务写 record+seq+event+idem row → destroy pool → 重连 replay 同 key 不二次 bump revision/seq/event)+ **PG-T6b fault/rollback**(领域写+idem row 同事务原子) | ● |
| 5-7 SSE live push(建连后 push→response body 实收) | R2-2 | 5 | `chunks 含 'live-value' && op.value==='live-value'`(非建连前 replay) | ● |
| 5-8 slow-reader 恢复(R3 F3) | R3 F3 | 5 | `resumedMax-resumedMin+1 > resumed.length`(response body 观察 seq gap)+ `?since=0 补拉 seq 1..51 全 51 无缺口` | ● |
| 5-9 post-revoke write 拒绝(R5 F3) | R5 F3 | 5 | bob 撤权后 SSE `event: revoke`/close + bob PATCH write 返真实 `404 unknown-canvas` no-leak(非 401/403)+ owner alice write `200`(真实 seam:resolveActor+canAccessCanvas('write')+denyStatus) | ● |

**实跑汇总**:`65 pass / 0 skip / 0 fail`(spike 48 + SSE 9 + PG 8,本地 PG port 55443 实跑 MIVO_PG_TEST=1,PG-T1~T7(含 T6b) 同一 client 真 pass;PG-T5/T6/T6b/T7 真 PG 持久/跨 record/真实 replay;SSE 5-8 slow-reader 恢复 + 5-9 post-revoke write 拒绝)。`tsc -b` 0 errors;`eslint` 干净;`npm run build` exit 0;`grep -roE 'yjs|lib0|YEvent|applyUpdate|AbstractType|encodeStateAsUpdate' dist/` 零命中(yjs 不进生产 bundle)。

---

## 10. G1-c / N2-1 唯一契约草案 v2(对齐 G1-b R2)

> 依据:gate 4 方案 A + gate 5 REST+SSE + gate 7 seq/补拉/压缩/revoke + **G1-b R2 三 finding 对齐**(FieldPath 非空 tuple / 数组 by-stable-id / create→edit 因果 / DELETE cursor)。**唯一契约——选 Yjs 则替换为 Y.Doc 通道,但本决策已否决 Yjs。**

### 10.1 op schema(field-level,走 #194 PATCH envelope;v2 对齐 G1-b R2;**R5 F1:create 独立 endpoint,非 PATCH DomainOp**)

```ts
// DomainOp = 中性 delta(transport-neutral):set/unset/array(whole-lww/primitive)/reorder 无 recordId/actor/base/opId
//   (recordId ← URL path;actor ← resolveActor;base ← If-Match;opId ← idempotency-key header,全 adapter 注入)。
//   ★ v4 Blocker 2:create 已从 PATCH DomainOp 剔除,走独立 POST endpoint(CreateBody);create id = client NodeRecord.id(非 server-mint,废除 R5 F1 server-mint)。
//   ★ v4 Blocker 3:strict-tx 已剔出 DomainOp(假跨 record tx 无 target)→ 跨 record 改 server-named ServerInvariantCommand(由 path/method 推导目标)。
type FieldPath = readonly [string | number, ...(string | number)[]]  // 非空 tuple(G1-b R4-P1-1,S10-6 运行时拒空)

// ★ v5 Blocker 1:base.clock 单一 wire = opaque BaseCursor string(真 codec + 签名,非 type-cast)。
//   生命周期:accepted {id,revision,seq,base} 响应签发 + hydrate snapshot 签发;client 回传 If-Match;conflict 返 current base;malformed/unsigned→400。
type BaseCursor = string & { readonly __brand: 'BaseCursor' }
const encodeBase = (rev: number, cv?: number): BaseCursor => { /* adapter codec:rev→signed opaque token */ } // 签发 from accepted/snapshot
const decodeBase = (token: BaseCursor|string|undefined): { rev: number; cv?: number } | null => { /* adapter codec:验签→{rev,cv}|null(malformed/unsigned/tampered→null→400) */ }

type DomainOp =  // ★ v5:仅单 record LWW delta(set/unset/whole-lww/primitive/reorder);无 strict-tx(改 server-named);无 by-id(A2 deferred,fail-visible)
  | { kind: 'set'; fieldPath: FieldPath; value: unknown }                                   // 无 recordId(path 注入);leaf-level set(container set 拒,白名单取消)
  | { kind: 'unset'; fieldPath: FieldPath }                                                 // 无 recordId
  | { kind: 'array'; fieldPath: FieldPath; class: 'whole-lww'; intent: 'replace'; value: unknown[] }  // ② markupPoints(无 stable-id,A2 supported)
  | { kind: 'array'; fieldPath: FieldPath; class: 'primitive'; intent: 'insert'|'remove'; value: string }  // ③ resultNodeIds(无 stable-id,A2 supported)
  | { kind: 'reorder'; orderedIds: string[] }                                              // parentId 从 path 注入
  // ★ v5 by-id variant 不在 DomainOp(by-id A2 deferred,fail-visible,禁降级整数组 LWW;fills/strokes/effects/experimentalAnchors migration 走 legacy 兼容通道,见 §10.2/§14.3)

// ★ v5 Blocker 3:server-named invariant command(跨 record 原子,非 PATCH DomainOp;由 path/method 推导目标,per-target 鉴权)
//   ★ 诚实化(§14.5):仅 node-delete-cascade 经 PG-T1~T3/T7 实证;group-reparent/result-asset-attach 类型+注释级 A2 需另测。
type ServerInvariantCommand =
  | { kind: 'node-delete-cascade'; canvasId: string; nodeId: string }                      // ★ 实证(PG-T1~T3/T7):node+edges+asset ref 同 tx 原子 + 跨 record 回滚
  | { kind: 'group-reparent'; canvasId: string; nodeIds: string[]; targetGroupId: string|null }  // 类型+注释级(A2 需另测)
  | { kind: 'result-asset-attach'; canvasId: string; anchorId: string; assetId: string; resultNodeId: string }  // 类型+注释级(A2 需另测)
```

**三层信任边界(v5:PATCH body 零 privileged;base=opaque BaseCursor string codec;create client-id;by-id deferred;container 白名单取消)**:
```ts
// 客户端 PATCH payload(不可信):零 privileged 载体 — 无 opId/actor/recordId/base(全 adapter 注入)
type ClientFieldOp = { clientId: string; domain: DomainOp }
// 服务端 trusted:actor ← resolveActor(authz);recordId ← URL path;opId ← idempotency-key header;
//   base ← If-Match(opaque BaseCursor string,adapter decodeBase 验签;v5 Blocker 1 单一 wire + 完整生命周期)
type TrustedCtx = { opId: string; clientId: string; actor: string; recordId: string; base: BaseCursor }
type WireOp = TrustedCtx & { domain: DomainOp }
const trustify = (client: ClientFieldOp, ctx: TrustedCtx): WireOp => ({ ...ctx, domain: client.domain })

// ── v5 Blocker 2:create client-supplied id(废除 server-mint,对齐 G1-b R4 + canvasSyncPort create-node)──
//   adapter 从 NodeRecord.id 提取 → create URL path(:nodeId);body = CreateBody 零 privileged(payload=NodePayload)。
//   server 信 path id,做 format/uniqueness/permission 校验;id 唯一来源 = client NodeRecord.id(非 server-mint)。
//   ★ v5:container 白名单 ['transform','relations'] 取消(lead 裁定 rejected):transform/relations 内部字段有独立并发语义,
//     整对象 LWW 吞 sibling 更新;A2 维持叶子级 set(整对象 set 拒,须分解 transform.x 叶子 set)。无 'atomic-container'(FieldTarget 清理)。
type RecordKind = 'node'|'edge'|'anchor'
type FieldTarget = 'leaf'|'container'|'array-element'  // v5:无 'atomic-container'(白名单取消)
type RecordKindSchema = { kind: RecordKind; classifyField: (fieldPath: FieldPath) => FieldTarget }  // G1-b R4 必填(安全入口,A2 实装前提)
type CreateBody = { clientId: string; type: RecordKind; payload: unknown }  // 零 recordId(id 来自 path:client NodeRecord.id)
type CreateWire = { opId: string; clientId: string; actor: string; recordId: string; type: RecordKind; payload: unknown }
const trustifyCreate = (client: CreateBody, ctx: TrustedCtx): CreateWire =>
  ({ opId: ctx.opId, clientId: ctx.clientId, actor: ctx.actor, recordId: ctx.recordId, type: client.type, payload: client.payload })
// S10-2 类型级 gate(tsc -b 强制):DomainOp['kind'] 不含 'create'/'strict-tx'/'by-id';CreateBody keyof 无 recordId;base 非 bare number;真 codec round-trip。
//   base 非 bare number(@ts-expect-error);create/strict-tx 塞回 DomainOp → @ts-expect-error 失效 → build fail。
```

### 10.2 wire(**v5:base.clock opaque BaseCursor string codec + 完整生命周期;create client-id path;base-driven 409 矩阵;FX-5 走 legacy 兼容通道**)

- `PATCH /api/canvas/:id/nodes/:nodeId` — payload = `DomainOp` 或 `DomainOp[]`(batch 同 record,**原子:全 ok 或全 reject**,S10-5)。**v5:DomainOp 不含 create/strict-tx/by-id**(by-id A2 deferred)→ PATCH body 任意 variant 零 privileged recordId,recordId 仅来自 trusted path ctx。
- `POST /api/canvas/:id/nodes/:nodeId` — **v5 create endpoint(client-id path)**:`:nodeId` = client `NodeRecord.id`(adapter 提取进 path);body = `CreateBody`(零 recordId;payload = `NodePayload`)。server 信 path id,做 format/uniqueness/permission 校验。**废除 server-mint**。经 `trustifyCreate` 注入 trusted ctx。不与 PATCH DomainOp 共 wire。
- **If-Match = `base`(opaque BaseCursor string,真 codec+签名)**:**生命周期**:accepted `{id,revision,seq,base}` 响应签发 base + hydrate snapshot 签发;client 回传 If-Match;server `decodeBase` 验签;malformed/unsigned→400;**conflict 响应返 current base 供 re-fetch**。**必填(428 missing)**。**base-driven 409 矩阵(§14.1)**:edit stale→**永远 200+overwritten**(G4-4,非 409);**delete/reorder fresh base→200**,并发 race(stale base / orderedIds≠live)→409;create dup→409;malformed→400;legacy flag-off old body→400 payload-rejected(非 409,C-1)。
- 响应:`{ id, revision, seq, base }`(`UpsertResponse` 扩 `seq` + `base` BaseCursor;打破 exact type test,契约测试重写)。
- **cutover**:**原子 cutover**(§1.2 拍死)+ **FX-5 走 legacy 全量 record 兼容通道**(旧 upsert=replace,backend.ts:1086-188;不可翻译为 DomainOps → drain-only whole-record replace 同 backend.ts;不发明 by-id/whole-lww DomainOp,不绕 by-id defer;见 §14.3/C-2)+ stale client 旧 body → 400 `payload-rejected`(见 §1.2 状态表)。create endpoint 随 PATCH 一同 cutover。

### 10.3 服务端合并(field-level LWW,非整 record 替换)

- `upsertChild` 演进:`validateChildPayload` 改 field-level op schema 校验(逐 fieldPath 白名单 + **RecordKindSchema classifier 必填,G1-b R4**;拒 unknown,拒空路径 S10-6,拒原型污染 S10-1);merge = 按 `fieldPath` set 叶子(`setByPath` 硬化),**永不 `clear` 整 record**(N1 坑7)。
- revision:每 accepted op bump(per-record);**只供 snapshot/catch-up + legacy cache 校验,不参与 LWW 拒写(G4-4,edit stale 永远 200 非 409,见 §14.1 冻结矩阵)**。
- 同 `fieldPath` 并发:server seq LWW(后者 wins,整串;gate 1 文本 gate 接受)+ **overwritten 事件推前写者**(B 方案,T1-1)。
- 全序 `seq`:per-canvas 单调事件序号(gate 7 `?since=seq` 补拉 + 网关降级时 finite short-poll,见 §14.4)。
- per-field clock:**持久形态定死** PG `field_clock` 表(PG-T5 真测:write→destroy pool→重连读回,clock 仍在;S10-4 演示逻辑,不留 N2-1);**base.clock 单一 wire = opaque BaseCursor**(If-Match 携带,client 不读内部;stale 判定 = server 解码 base.clock < current.clock → 条件逆运算 skip M2,不拒写)。

### 10.4 跨 record invariant = server-named invariant command(非 LWW,非 PATCH strict-tx;**v5 Blocker 3 + 诚实化**)

- **strict-tx 已剔出 DomainOp**(假跨 record tx 无 target)。跨 record invariant 改 **server-named `ServerInvariantCommand`**(由 path/method 推导目标,非 PATCH DomainOp):
  - `node-delete-cascade(nodeId)`:DELETE /nodes/:id → node 删 + edge 级联 + asset ref 清理,**同一 PG 事务原子**。★ **仅此 command 经 PG-T1~T3/T7 实证**(node+edges+asset ref 同 tx + 一般跨 record 回滚;S10-13 + X-3)。
  - `group-reparent(nodeIds, targetGroupId)`:path 推导目标集,per-node 鉴权。★ **类型+注释级,A2 需另测**(非实证)。
  - `result-asset-attach(anchorId, assetId, resultNodeId)`:result+asset ref 同 tx。★ **类型+注释级,A2 需另测**(非实证)。
- delete-vs-update:delete wins,update 落 not-found(G3-2,非 409 重试)。
- **先逐 target authz 再同 PG tx**(NOTES 保持);**二选一写死**:选 server-named(非可鉴权多 target wire);若未来需多 target tx,定义 per-target base/clock wire(非 A2 范围,deferred)。

### 10.5 实时通道(REST + SSE;WS 选作 N2-2 优化;**v5 Blocker 4 finite short-poll 真模式**)

- 写:`PATCH`(#194,已建)。
- 广播:SSE(`/api/canvas/:id/events?since=seq`),plain HTTP,网关**应**透传(非"必透传";生产可能缓冲/超时 = ○条件式),鉴权走 SSO header 链(真实 5-1~6)。
- **finite short-poll 真模式(v5 Blocker 4)**:GET `/api/canvas/:id/events/poll?since=` → 响应 `{events, nextSince}` JSON,**服务端自然结束**(非长流);content-type `application/json`(非 SSE);只含 seq>since 条目。**fallback = finite short-poll**(非 "SSE 失败由 SSE fallback" 循环;永不关闭的 SSE 流读两帧 cancel 不算 poll)。
- **网关失败树(NOTES 保持)**:Gate5 失败只能 ① 调 proxy buffering/read-timeout/flush 复测(首帧 SLO 200ms,5-10)→ ② finite short-poll(500ms SLO,5-12)→ ③ N2-2 blocked(5-13 步骤冻结)。header strip→404 fail-closed(5-11)。
- **overwritten 事件**(B 方案):同 fieldPath 后写 wins 时,前写者收 `{seq, recordId, fieldPath, historicalValue, byActor, currentRevision}`(T1-1);前写者可 `restore`(发 historicalValue,新 seq,T1-2)。
- WS:N2-2 选作低延迟优化(非依赖);**网关 WS 放行 = ○条件式留 lead 生产实测**,不放行则 SSE/finite short-poll 兜底。
- presence:WS(若可用)或 SSE 单独 channel。

### 10.6 权限撤销 / 补拉 / 压缩

- 连接绑 `actor+canvas+authz`;`removeMember`/撤销 share → **断流 + post-revoke 写拒绝**(`applyOpAuthz`→forbidden,G7-hard-3 自建 server,不只断流;**R5 F3:5-9 真实 owner.ts/authz.ts seam PATCH write route 验 bob 撤权 → 404 no-leak + owner 200**,替代仅 G7-hard-3 自建探针)。
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
- **破坏面非零**(§1.2):≥12 文件 + FX-5 队列 migration-on-read(旧 queued body→新 op schema 转换)+ stale client 旧 body 打新 endpoint → 400 `payload-rejected`(非 409 refetch)+ 118 项定向回归 + cutover 策略(原子,§1.2)。
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
| 生产 SSO 网关 WS upgrade 放行 + header 注入 | N2-2(WS 优化)/ Yjs(致命) | **○条件式留 lead 生产网关实测**;做到→N2-2 上 WS 优化;做不到→SSE/short-poll 兜底,**Figma 选型不变** |
| 网关对 `text/event-stream` 缓冲/超时/首帧延迟/header strip | N2-2 SSE | **v5 Blocker 4 失败树(§14.4)**:① lead 实测首帧/连续帧延迟 + heartbeat(5-2)+ 空闲超时 + header 注入/strip 阈值(5-10/5-11,SSE SLO 200ms);② 失败先调 proxy buffering/read-timeout/flush 复测;③ 仍失败 → **finite short-poll** GET /events/poll?since=(JSON 服务端自然结束,SLO 500ms,5-12)或判 N2-2 blocked。**非 "SSE 失败由 SSE fallback" 循环**(fallback=finite short-poll,5-13;永不关闭 SSE 流读两帧 cancel 不算 poll) |
| 20k 节点高频 update 渲染性能 | N2-1/N2-2 | 复用 §12 风险4 的 26.7ms p95 基线,N2-2 做 pan bench(对齐 N1 §4 未验证项) |
| per-field clock 精确 stale 判定 | N2-1 实装 | 持久形态已定死(PG-T5 真测持久;S10-4 演示逻辑);生产加 per-field clock 做精确 stale(契约 §10.3) |
| canvas 文本同段共编真实需求 | 未来 | 若出现,N2-1 后对 `text` 单字段局部引入 OT/CRDT(不拖全局);v2 文本判决 B 已给 overwritten+restore 兜底 |
| #194 cutover 破坏面实际调用面 | gate4/gate6 | ▲lead 已核证 route 注册 + FX-5 payload + shared contract(§1.2);cutover 前补全量调用面审计 + 原子 cutover 策略(§1.2 拍死,非 versioned) |

---

## 13. 与计划/上游对齐(含 G1-b **R4**;v4 对齐冻结源 R4)

- **计划 §8 N2-0 七项 hard gate**:逐项两案 + 证据 + 成本 + go/no-go(§2);文本 gate 判决(§2 gate 1,P1-4 二选一 B);网关 gate 判决(§2 gate 5,○条件式留 lead + §14.4 失败树);唯一推荐 + G1-c/N2-1 契约 v6(§10);改写 N1 Q1-Q5(§11)。✅ decision-complete v6。
- **计划 §4 G1-b/G1-c**:G1-b 两案契约 inventory 冻结为 Figma 式唯一(§10);G1-c 落本契约,无 Yjs 死接口。**v5 对齐 G1-b R4(冻结源已到 R4,决议原写 R2 已纠正)**:FieldPath 非空 tuple(R4-P1-1,S10-6)/ 数组 by-stable-id(R4-P1-1,S10-7;**v5 by-id A2 deferred,DomainOp 不含 by-id**)/ create→edit 因果(R4-P1-2,S10-8)/ DELETE cursor(R4-P1-3,S10-9)/ **classifier 必填(R4-P1-1,RecordKindSchema,S10-2/S10-14)**/ **async submitChange caller-owned retry/rebase(R4-P1-2,对齐 canvasSyncPort R4 状态机)**。trusted actor/base/idempotency/seq 全留 adapter/transport 层(P2-8)。**v5:create client-id(非 server-mint)对齐 canvasSyncPort create-node(携 NodeRecord.id)**;**container 白名单取消(lead 裁定 rejected;A2 leaf-level set;FieldTarget 无 'atomic-container',两文档同规则 §10.1 + inventory §11)**。
- **计划 §8 N2-1**:op schema/field 边界/seq/revision 用途/事务路径 = §10 契约 v4 直接落地。
- **platform §6 CRDT-ready**:映射可行性保留(N1 证);但**采用 Yjs 否决**——CRDT-ready = 字段扁平可映射,不等于必须采 Yjs。属性级 LWW(field-level PATCH)满足"协作肯定要做"的演进不返工承诺。
- **platform §13.5 Figma 式**:与本法一致。

---

## 附:spike 文件结构索引(v4)

- `src/kernel/__spike__/n20-truth-source.spike.test.ts`(**55 tests**;v4 +7:3 S10-12/13/14 + CutoverHarness 改真实 WriteOp/NodePayload + 4 X-1~X-4 交叉契约):
  - 模块级 v5 契约权威类型(BaseCursor string codec/DomainOp 无 by-id/ServerInvariantCommand 诚实分级/TrustedCtx.base/CreateBody client-id/RecordKindSchema;无 ATOMIC_CONTAINER_WHITELIST 白名单取消)
  - `makeNode` fixture + `setByPath`/`getByPath`/`fieldKeyOf`(硬化:拒原型污染 S10-1 + 拒空路径 S10-6 + R2-4 leaf validator 拒整对象 clobber S10-6)
  - `FieldLevelServer`:applyOp/applyOpAuthz/deleteNodeCascade/deleteNodeCascadeWithCursor/pullSinceWithGap/compress/snapshot/addMember/removeMember/storageBytes/staging+commitStaged
  - `CommandUndoStack`+ `ConditionalUndoStack`+ `TextLwwWithOverwrite`
  - G4+G1(5)/ G3(2)+G3-real(3)/ G2(2)+M1-M6(6)/ G7(3)+G7-hard(4)/ G5(1)/ antiYjs(2)/ S10(5)+S10-6~9(4)/ T1(4)+T1-5/ S10-10/S10-11/ C-1~C-4(改真实 WriteOp+NodePayload 四类)/ **S10-12 base.clock 冻结矩阵(Blocker 1)**/ **S10-13 server-named invariant(Blocker 3)**/ **S10-14 array defer+白名单(Blocker 2)**/ **X-1~X-4 交叉契约 port CanvasChange↔N20(Blocker 6)** = **55 tests**
- `server/__tests__/n20-sse-route.spike.test.ts`(**13 tests**;v4 +4:5-10~13 网关失败树):真实 Hono SSE route(content-type/heartbeat/since/revoke/authz/slow-consumer + 5-7 live push + 5-8 slow-reader 恢复 + 5-9 post-revoke write 拒绝;**v4:5-10 首帧延迟 SLO + 5-11 header strip→404 + 5-12 short-poll ?since=seq fallback SLO + 5-13 失败树步骤冻结(Blocker 5,非 SSE-fallback 循环)**)
- `server/__tests__/n20-pg-tx-fault.spike.test.ts`(8 tests):真实 PG transaction fault injection(原子提交/fault ROLLBACK/同库资产元数据/无事务 partial 对照 + PG-T5 field_clock 持久 + PG-T6 真实领域 replay + PG-T6b fault/rollback + **PG-T7 跨 record(server-named cascade 原子,对齐 Blocker 3)**;本地 PG 55443 实跑 MIVO_PG_TEST=1;全部 PG-T 同一 client pool.connect+finally release)
