# N2-0 v2 复审 REQUIRES_CHANGES（第二轮，lead+sol4 共识，2026-07-12）
6 P1 + 1 P2。lead 抽核 #1/#2/#3 逐字属实。M1-M6 已闭合别动（复审独立重放通过）。
**复审方总定性（本轮返修的纲）**：Figma 推荐可保留，但必须改述为"基于现有底座与迁移成本的推荐；Gate3/7 平局、Gate5 条件式"——不是"七 gate 全 GO 的充分判据"。为保结论继续加权 = 直接打回。

## R2-1 [P1] PG 探针不保证同一连接 + "跨介质"名不副实（n20-pg-tx-fault:65-107）
pool.query 每次独立借还连接，BEGIN/COMMIT 事务性靠运气；PG-T3 是同库两表非跨介质。
修法：全部 PG-T 改 `const client = await pool.connect()` 同一 client 上执行（finally release）；PG-T3 改名"同库资产元数据"；跨介质（真实文件 fault/补偿）补探针或 Gate3 重评为平局/条件项。
验收：pool max>1 且并发占用其他连接时稳定通过；文档不再称同库两表为跨介质原子。

## R2-2 [P1] SSE 探针无 live 推送、backpressure/authz 断言虚高（n20-sse-route:34-169）
pushEvent 只压 backlog；5-1/5-3 全是建连前 replay；5-6 的"慢消费者"是不驱动 stream 的旁路数组；路由直信 x-mivo-auth-user 未走 gateway-secret 链。
修法：补"建连后 push→客户端 response body 实际收到"测试；基于 desiredSize/有界队列的真实 drain/backpressure；路由复用真实 resolveActor/authz seam；文档把网关 SSE buffering 改为"影响实时 gate 的条件项"。
验收：live broadcast/断线/revoke/伪造 header/slow reader 50+ 事件全部从真实 response body 断言；队列有可执行上界。

## R2-3 [P1] §10 三层信任/幂等/clock/batch 自相矛盾（spike:1135-1254 + doc:363-397）
trustify 无 header 参数、opId 实取 body（与"header 单一载体"矛盾）；DomainOp 带 recordId 直接当 PATCH payload（违反 recordId 取 path）；per-field clock 只是内存 Map、wire 无 base.clock 表达；S10-5 batch 无 rollback（逐条 mutate，后项失败前项已落）；immutable/atomic 字段表与 idempotent replay 缺失。
修法：真三层类型（body 零 actor/recordId/base/opId；opId 由 idempotency header 注入 trusted envelope）；PG 可持久 field-clock schema + 客户端 base 表达；immutable/atomic leaf 表；batch 单事务全成或全败；同 key replay 不二次 bump/不二次发事件。
验收：伪造 body opId 被忽略 header 生效；replay revision/seq 不变；batch 第二项 runtime 失败第一项不落库；重启后 clock 可恢复。

## R2-4 [P1] 与 G1-b R2 未无缝互认（doc:364-386 + spike:1337-1382）
非空 tuple 只堵 []，['transform']+整对象仍可 clobber（缺 leaf validator/atomic leaf 表）；数组 intent 写死 {id:string} 但 markupPoints 元素无 id、resultNodeIds 是 string[]（mivoCanvas.ts:69-74,249）；DomainOp 直接当 wire 违背"中性 delta→adapter 唯一翻译"分层。
修法：全量合法 leaf/atomic paths 清单 + 拒 ['transform'] 负例；数组按 有 stable-id/无 stable-id/primitive 三类冻结意图（或明确整值 LWW 限制）；中性 intent 与 wire op 的 adapter 映射一对一写明。
验收：负例拒整 transform；fills/markupPoints/resultNodeIds 各有并发/翻译测试；path/base/actor/idempotency/seq 只在 adapter 层出现。

## R2-5 [P1] 文本 restore 绕过 overwrite 管线（spike:697-727 + T1-2:1282-1296）
restore 直调 applyOpAuthz 绕开 applyOverwrite → B 收不到 overwritten、lastWriter 错停 bob。
修法：restore 走同一 overwrite 管线 + 冻结其 stale/history 语义；补 A写→B写→A restore→B 收 notice→后续写全链测试。
验收：每次同字段覆盖，败方都收到含正确 historicalValue/byActor/revision/seq 的事件；终态与 lastWriter 一致。

## R2-6 [P1] 破坏面 inventory 未逐文件 + cutover 未拍板（doc:65-86,428-459）
"≥12 文件"没列 12 个；117 项无冻结命令；"versioned vs 原子 cutover"仍二选一未决却同时宣称"无双协议窗口"。
修法：精确文件清单可逐项打勾 + 回归命令集合；**现在拍死一个 cutover 方案**（含兼容窗/FX-5 队列迁移/stale client 报错/回滚）——拍不死就把"无双协议窗口"从结论里删掉。
验收：inventory 可打勾；唯一 cutover 方案；对应契约/队列迁移测试可执行。

## R2-7 [P2] Gate7 ★ 虚标 + §3 清单缺条（doc:226-351 + spike:1002-1114）
G7-hard-1~3 是自建 server 无 Yjs 对照却标 ★；无恢复耗时对比；§3 只 21 条，漏"Yjs 无原生 coalescing 被 M5 推翻"，"任何 HTTP 网关必透传"未修正。
修法：G7-hard-1~3 降级 ●/○；补真实 Yjs provider revoke/reconnect + 同数据 bytes+恢复耗时，或 Gate7 明确平局；§3 补齐 + 网关措辞改条件式。
验收：每个 ★ 都真实库同矩阵；重评分不把未验证比较当相对优势。
