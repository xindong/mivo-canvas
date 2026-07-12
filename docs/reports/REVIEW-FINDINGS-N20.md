# N2-0 双审 REQUIRES_CHANGES — finding 全文（lead+sol 共识，2026-07-12）

判决：REQUIRES_CHANGES。8 条 finding（6 P1 + 2 P2）。lead 已逐条抽核证实。
总定性：Figma 式可能仍是正确终选，但当前文档把未验证假设写成决定性事实；证据硬化 + 诚实重评分后才可作为 G1-c/N2-1 契约来源。

## P1-1 Gate2 undo PoC 未证明"远端交错保留"，且 Yjs 对照事实错误（spike test :177,:328-345）
- CommandUndoStack 只证"远端 op 不入栈"；inverse 从未 applyOp 到服务端状态；不保存旧值（undo() 返回字符串占位）；G2-2 不断言最终 title。按 §10 同 fieldPath 后写 wins，A 的 inverse 后发会覆盖 B——恰与声称相反。
- Yjs UndoManager 原生有 captureTimeout/stopCapturing 合并 + trackedOrigins 只撤本地（node_modules/yjs/dist/src/utils/UndoManager.d.ts:15-24；README:1163-1289 明写默认不覆盖 remote map changes）。sol 实跑真实 Yjs：A 写 title=A、B 后写 title=B，A undo 后 title 仍 B。
- 修法：用真实 document/server 状态实现 conditional inverse 并测试矩阵：不同字段交错/同字段远端后写/目标被远端删除/目标被移动/100 drag coalescing 初始值恢复/redo；同矩阵跑真实 Y.UndoManager 对照。每场景断言最终 record。

## P1-2 Gate3 用错误的 Yjs 事务/delete 事实制造优势（doc :111）
- Yjs 可在单 transaction 内改多个顶层 record（README:865-870 doc.transact）；sol 真实探针：单 transaction 删 nodes.n1+edges.e1，远端同一 Transaction 原子可见；delete-vs-update 并发双向 merge 后 n1 均不存在，无复活。
- PoC 未覆盖 group/frame、result-node+asset-ref、PG/文件资产跨介质原子性；Figma 侧"同步函数执行完"≠PG transaction 原子可回滚。
- 修法：区分"同一 Y.Doc 内 transaction 原子"与"跨 Y.Doc/PG/文件资产一致性"；真实 Yjs transaction 并发测试 + 真实 PG transaction fault injection + asset saga 边界，同矩阵比较；删除"必复活/完全做不到"表述。

## P1-3 §10 契约违反 #194 单一真相与可信身份边界（doc :256-267）
- FieldOp body 重复携带 actor/recordId/baseRevision：actor 必须由 resolveActor/authz 派生（信任 body.actor 绕过 owner.ts:84-98 可信网关链）；recordId 从 URL path；base 只从 If-Match（shared/persist-contract.ts:10-15 冻结"If-Match 为 revision base 唯一来源"）。
- opId 与 idempotency-key header 双载体未定一致性；prototype 不去重，重复 op 二次 bump。missing record 恒 not-found，无 create 语义（现 #194 PATCH missing 可 create）。fieldPath+value:unknown 无 typed union/immutable 规则/unset/array 语义/batch 原子性；setByPath 不防原型污染路径。per-field clock 留 N2-1 与"decision-complete"自相矛盾。UpsertResponse 扩 seq 打破 exact type test（serverPersistAdapter.contract.test.ts:46）。
- 修法：冻结三层（client payload / trusted server metadata / event envelope）；typed domain op union（create/set/unset/array/reorder/strict-tx）；immutable/atomic 字段表；per-field clock 持久形态；batch 原子性；idempotent replay；完整 outcome。

## P1-4 文本判决 LWW/409/revision 规则互相矛盾，"罕见"无产品证据（doc :70）
- 文档同时写"整串 LWW 后写 wins/revision 不拒写"与"409 surfacing"；G1 test stale 写返回 ok 静默覆盖，无任何代码返回 conflict。markdown 是正式节点类型（CanvasNodeView.tsx:443-531 全文渲染），不能仅凭"不是 Google Docs"断言罕见。
- 修法：二选一写死——A) same-field stale → 409/field-conflict + 用户选 reload/force；B) 始终 LWW 200 + SSE overwritten 事件 + 恢复历史。补使用证据与翻盘阈值。测试覆盖双方响应/最终值/败方提示/恢复。

## P1-5 Gate5 不是真实 SSE/网关/auth spike（spike test :400-411）
- G5-1 只是内存 callback。计划 :120-129 明确 N2-0 必须做真实 SSO 网关 transport+auth spike，不能推 N2-2。
- 修法：至少真实 Hono SSE route 集成测试（content-type/framing/heartbeat/since 补拉/revoke 断流/authz/slow consumer 有界）；真实网关双浏览器实测留 lead 但必须列为选型条件项——做不到就把结论标"条件式 blocked"而非"无需验证"。

## P1-6 方案 A"零破坏、无迁移窗口"不成立（doc :53）
- unwired 只证前端未接线；#194 route 生产注册（canvas.ts:450-522），shared contract 冻结 body={payload:NodeRecord}；FieldOp 演进将改 UpsertRequest/NodePayload/validator/双 backend/route/adapter/retry queue（≥12 文件、117 项定向回归）。FX-5 WriteOp 持久化完整 payload（writeRetryQueue.ts:49-80）——旧 IDB queued body 打新 endpoint 是 400 payload-rejected 不是 409 refetch，文档"FX-5 不动"错。
- 修法：完整破坏面 inventory + 生产调用证据；证明不了零调用就选 versioned endpoint/payload 或设计原子 cutover（新旧 decoder 兼容窗、FX-5 队列迁移、stale client 明确错误、回滚策略）；措辞改"前端主路径未接线，但契约/服务端破坏面非零"。

## P2-7 Gate7 压缩/断流/存储对比无真实证据（spike test :146-170）
- snapshot 是一个数字；截断后 since=0 静默丢前 950 条无 gap 信号；revoke 只删内存 callback，被撤 actor 仍可写；"Y.Doc 全 op log 重放"不准确（增量 update 不重放全史）。
- 修法：snapshotSeq/logFloor + since<floor→gap/snapshot 协议；crash/restart 恢复；真实断流+重连 authz+post-revoke 写拒绝；两案同数据规模 bytes/恢复耗时对比。

## P2-8 与 G1-b 衔接忽略被阻塞的 full-record port（doc :337）
- G1-b CanvasChange 是全量 record（其 P1 正在返修），无法无损产生 field intent；把 FieldOp 塞进 port 又违反 transport-neutral 红线。
- 修法：N2-0 明确 G1-b 返修契约——port 携带中性 typed domain delta，Figma adapter 唯一翻译成 FieldOp；trusted actor/base/idempotency/seq 全留 adapter/transport 层。与 g1b-fix worker 的返修方向对齐（其包已收到同方向指示）。
