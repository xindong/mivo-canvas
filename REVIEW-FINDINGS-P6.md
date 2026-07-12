# P-6 saga 双审 REQUIRES_CHANGES — finding 全文（lead+sol 共识，2026-07-12）
4 P1 + 1 P2。lead 已核证 P1-1（路由代码形状）/P1-3（FOR UPDATE 空行不锁 + 无唯一约束）。
**lead 已拍板（P1-4 合并顺序，2026-07-12 更新）**：DP-6R 占 `003_chat_per_user` + `004_chat_order_revisions` 已先合 main；本分支 migration 编号定为 **`2026_07_12_005_share_link_compensations`**（key+registry 同步，文件内单 registry 无独立文件名）。矩阵测试两路径：fresh combined（001+002+003+004+005）+ 003+004 已 applied→加 005，均要求 kysely_migration 单调 001<002<003<004<005。（原文写 004 系早于 DP-6R 新增 004_chat_order 的旧裁决，已作废。）

## P1-1 intent 落库前崩溃留永久丢补偿窗口（projects.ts:156-160,291-298）
第一步 persist 提交后 recordCompensation 才执行；record 自身抛错→无 pending。重入不自愈：restore 重试 kind='existing' 只 attempt 不 record；delete 重试 isDeleted 跳过 record。现测试只注入 step fault 未注入 record fault。
修法：intent/desired-state 与第一步同事务落 PersistBackend（outbox 形态），或第一步写可重建的 desired-state marker 由 reconciler 派生补偿。**不许**对所有 POST existing 盲建 restore intent（会把用户手工 revoke 的链接错误恢复）。
验收：softDelete/restore 提交后、record 前注入崩溃 → 重启/重试双向自动收敛；普通 existing POST 不动手工 revoked link。

## P1-2 无自主 retry driver，pending 可永久滞留（permissions.ts:143-149 / index.ts:40-42）
唯一驱动是用户重入。修法：全局 pending claim + 有界后台 sweep（启动恢复 + 周期退避重试）；必须带 desired-state generation/supersede 规则——防 restore-fail→delete 后旧 restore 被晚到后台执行重新开放链接。响应或指标暴露 pending 信号（响应体 compensation 状态字段或 /readyz 类指标，形态你定）。
验收：制造 pending 后零用户请求，故障解除自动 done；restore-fail→delete→晚 retry 与对偶场景，权限终态跟随最新 generation。

## P1-3 并发首建 intent 可重复（pgPermissionBackend.ts:383-409）
空结果 FOR UPDATE 无行可锁；两个并发首建都 INSERT → 多条 pending，attempt 只取 newest，旧 pending 永滞。
修法：partial unique index `UNIQUE(project_id,op) WHERE status='pending'` + INSERT ON CONFLICT/重读赢家（或 advisory lock）。
验收：真 PG Promise.all 并发 record 20 次 → 恰 1 条 pending；done 后下一生命周期可再建。

## P1-4 migration 顺序冲突（migrations.ts:162 vs DP-6R 157）
Kysely 前缀规则下"share 先 chat 后"顺序 corrupted。**执行 lead 拍板（2026-07-12 更新）**：DP-6R 占 003+004 已先合 main，本分支编号 **005**（key+registry 同步）；加迁移矩阵测试两路径：fresh combined（001+002+003+004+005 全量）+ 003/004 已 applied→加 005，migrateToLatest 绿且 kysely_migration 单调（share-先路径因改名后不存在，无需支持）。
验收：矩阵测试绿；与 dp6r 分支 rebase/合并后 registry 单调。

## P2-1 并发 attempt 双 completed + attemptCount 失真（pgPermissionBackend.ts:415-440）
修法：claim/lease（FOR UPDATE SKIP LOCKED 或原子 pending→running）或检查 UPDATE 行数，loser 返 already-claimed/nothing-pending。
验收：并发 attempt 仅一个 claim；attemptCount 与真实 claim 一致。

## sol 已裁不用改
__set*ForTest 测试钩子与仓内惯例一致；200/204 primary-success 语义可保留（前提是 P1-2 的 driver+信号补上）；done→新 pending 生命周期可工作。
