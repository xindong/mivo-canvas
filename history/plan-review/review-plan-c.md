# 架构迁移执行计划深审 C：UI/交互等价 + 性能回归 + 部署运维

审查对象：`docs/plan/arch-migration-execution-plan.md`

实跑命令：
- `npm run codemap`：通过，codemap 显示 218 files / 43255 lines。
- `npm run lint`：通过。
- `npm run verify:logging`：通过。

打开并核对的真实产物：
- visual-diff 脚本：`scripts/visual-diff.mjs`
- visual 产物：`test-artifacts/visual-diff/diff-report.json`、`test-artifacts/acceptance-r2/visual-leafer-demo/diff-report.json`、`test-artifacts/acceptance/visual-leafer-rotation/diff-report-rotation.json`、`test-artifacts/acceptance/visual-leafer-brush-stamp/diff-report-brush-stamp.json`、`test-artifacts/acceptance-r2/visual-leafer-markup-text/diff-report-markup-text.json`
- bench 脚本/产物：`scripts/bench/collect.mjs`、`scripts/bench/run-0g-engine-combo-matrix.sh`、`bench/baselines/verify-r2-engine-combo-0g-leafer-20k-2026-07-06.json`、`test-artifacts/acceptance-r2/p2-bench.log`
- body limit 源码：`server/lib/config.ts`、`server/lib/request.ts`、`server/routes/generate.ts`、`server/routes/tasks.ts`

## Findings

### [P0 | `docs/plan/arch-migration-execution-plan.md:16`, `:29`, `:136-140` | UI/交互“零变化”的像素验证不闭环 | 建议修法]

计划把“迁移前后所有功能 e2e `--renderer=both` + visual-diff 像素一致”列为成功定义，但真实 visual-diff 只覆盖固定 canvas shell 截图和少量画布渲染 fixture：默认 demo、rotation、brush-stamp、markup-text。`scripts/visual-diff.mjs` 只支持 `--fixture=rotation|brush-stamp|markup-text|text` 等固定注入场景，产物目录里也只有这些 diff report；没有任何场景打开侧栏菜单、确认弹窗、设置面板、更新日志面板或 chat task card。

真实行为 e2e 覆盖并不等于像素覆盖。当前 `scripts/e2e/scenarios/index.mjs` 实际有 28 个场景，`project-sidebar.mjs`、`changelog.mjs`、`userchip.mjs`、`auto-prompt-settings.mjs`、`chat-generation.mjs` 已覆盖不少行为断言，但 visual-diff 没把这些 UI 状态拍成 baseline。迁移触及 `Sidebar / Chat / Settings / Changelog` 订阅和 hydrate 路径时，计划无法用像素门禁证明“UI/交互零变化”。

缺口清单：
- 侧栏 CRUD：新建项目 inline rename、项目内新建画布、右键移动子菜单、删除画布确认、删除项目 cascade 确认、collapse/reload 后状态。
- Chat task card：running/progress、timeout error、普通 retry、中质量 retry、cancel 后清理、result card。
- 设置面板：authenticated/unauthenticated account 区、API Keys 区、AutoPrompt 首登缺 key、Gateway/Mivo key dialog。
- 更新日志：未读红点、面板打开、轮播箭头/dots、内部滚动、作者分组、关闭后状态。
- 素材库：`LibraryWorkspace` 仍无视觉基线，迁移 `/api/assets` 或 drag payload 时容易 UI 漂移。

建议在 M0/T0.4 明确新增“UI state visual baselines”：复用现有 e2e setup，把上述状态逐个 drive 到稳定态后截图，产出 `test-artifacts/visual-ui/<scenario>/baseline.png` + `diff-report.json`；每个迁移 PR 若触达对应 UI/store/hydrate 路径，必须重跑对应行为 e2e + 对应 UI visual-diff。

### [P1 | `docs/plan/arch-migration-execution-plan.md:76`, `:136-140` | 20k pan p95 基线可复跑，但未进入每 PR 验证关 | 建议修法]

计划引用“20k pan p95 26.7ms”不是臆断。真实产物 `bench/baselines/verify-r2-engine-combo-0g-leafer-20k-2026-07-06.json` 显示 `panGate.worstP95FrameMs=26.7`，DPR1=16.7ms、DPR2=26.7ms；`test-artifacts/acceptance-r2/p2-bench.log` 记录了可复跑命令：

```bash
npm run bench:collect -- --nodes=20000 --dpr=1,2 --runs=3 --renderer=leafer --culling=on --virtualize=on --lod=on --lod-px=32 --skip-drag --port=4190 --date=2026-07-06 --output=bench/baselines/verify-r2-engine-combo-0g-leafer-20k-2026-07-06.json --output-type=engine-combo-0g-r2 --gate-status=pan-gate --note='R2 acceptance retest on main 2026-07-06: leafer + virtualize + culling + lod'
```

缺口在计划门禁：§7 三道验证关只有单测/e2e/visual-diff，没有把 bench 纳入 PR gate。T1.2 内核收口会改 `persistIdbStorage`、document shape、hydrate、store partialize/merge，这些都可能影响 20k replaceSnapshot、render-sync、pan/zoom；若只在里程碑末尾跑一次，回归定位成本会很高。

建议 §7 增加 G4 性能关：凡触及 `src/store`、`src/model`、`src/render`、`src/lib/persistIdbStorage.ts`、hydrate 或 `?kernel=` 路径的 PR，至少跑 20k leafer pan gate，产物落 `test-artifacts/perf/<pr>/...json`。判定规则写死：`panGate.worstP95FrameMs <= 26.7ms` 或者若接受机器噪声则定义明确阈值，例如不超过 10% 且绝对值仍 `<33ms`，并记录 zoom p95 作为非阻塞趋势。

### [P1 | `docs/plan/arch-migration-execution-plan.md:75` | T1.1 备份只写“恢复一次”，没有恢复演练步骤与验收证据 | 建议修法]

T1.1 写了 `pg_dump` cron + 目录快照，并把验收写成“备份跑通并恢复一次”。但全计划只有这一处提到备份/恢复，没有恢复演练步骤、验证命令、恢复目标、RTO/RPO、回滚方式或证据归档要求。迁移后服务端会成为真相源，恢复能力不能只靠一句验收描述。

建议 T1.1 拆出可执行恢复演练清单：
- 用 staging/fresh PG 容器恢复最近一次 `pg_dump`，不要覆盖生产库。
- 恢复 `/AIGC_Group/mivo-canvas-data` 目录快照到临时目录，并校验 asset 引用能 resolve。
- 跑 schema migration + app boot + `/healthz`。
- 用固定测试账号创建项目/画布/图片资产/分享权限，备份后删除，再从备份恢复，校验记录数、关键 checksum、图片可打开、权限仍生效。
- 记录演练时间、备份文件路径、恢复命令、RTO/RPO、失败时回滚步骤到 `history/plan-review` 或运维 runbook。

### [P1 | `docs/plan/arch-migration-execution-plan.md:86`, `CLAUDE.md:102-106`, `src/lib/persistIdbStorage.ts:129-135`, `:162-183` | FX-5 “静默重试队列”方案不足以覆盖 pm2 restart 写入窗口 | 建议修法]

部署拓扑是真实的 `git pull && npm ci && npm run build && pm2 restart mivo-canvas`，pm2 restart 会造成数秒写入失败窗口。当前前端持久化链路 `syncToServer` 只是空预留点；`setItem` 只写 IDB，服务端同步尚未实现。计划仅写“前端写失败静默重试队列”，没有定义 durable queue、上限、退避、幂等、冲突、401/413 行为或用户可见降级。

建议把 FX-5 改成可验收的队列契约：
- 队列持久化到 IndexedDB，并按 `userId` 分区；不能只存在内存，否则 reload/重启窗口会丢。
- 每条 op 带 `opId`、`userId`、`recordId`、`baseRevision`、`clientSeq`、payload hash；服务端按 `opId` 幂等。
- 上限建议：最多 1000 ops 或 50MB，超过后同一 document/scope 合并压缩为最新 snapshot/PATCH；仍超限则停止静默，toast + debug log。
- 退避建议：1s、2s、4s、8s、16s、30s 封顶，加 20% jitter；`online`、`visibilitychange`、启动 hydrate 后立即 flush。
- 5xx/network/offline 入队重试；401/403 暂停并要求重新登录；409 走 revision merge/重新拉取；413 不重试同一 payload，必须拆分节点级 PATCH 或报错。
- “静默”只适用于短暂 5xx/network；超过 30s 或队列超过阈值必须给用户状态提示，避免误以为已保存。

### [P1 | `docs/plan/arch-migration-execution-plan.md:87-88`, `src/store/canvasPersistConfig.ts:18-38`, `src/store/chatStore.ts:836-847`, `src/store/settingsSlice.ts:44-96`, `src/store/authSlice.ts:62-67` | FX-6 换账号隔离与 FX-7 软删语义都过粗，无法直接执行 | 建议修法]

FX-6 目前写“本地 IDB 缓存 key 带 userId 或登出清 IDB”。真实代码里持久化 key 都是全局静态：`mivo-canvas-demo`、`mivo-chat-demo`、`mivo-canvas-settings`；collapse 与 changelog lastRead 仍是 localStorage 全局 key。`authSlice.logout` 只清本地 auth state 并跳 SSO logout，不清任何 IDB/localStorage。更重要的是，账号切换不一定经过应用内 logout：SSO cookie 可在网关侧变化，hydrate `/api/auth/me` 后直接变成另一个 `user.id`。

建议 FX-6 改为“先鉴权后 hydrate”：启动先读 `/api/auth/me`，拿到 `user.id` 后再打开 canvas/chat/settings/user-state/queue 的 user-scoped storage；检测到 `previousUserId !== currentUserId` 时，必须停止 flush 旧队列、卸载旧 store、切换到新用户分区。所有本地缓存 key 包括 canvas/chat/settings/collapsedProjects/changelog lastRead/retry queue 都带 userId；未登录使用临时 anonymous 分区且不得同步到服务端。新增 A 登录创建数据 -> B 登录同浏览器 -> B 看不到 A 的 canvas/chat/key/队列 -> A 再登录数据恢复 的 e2e。

FX-7 目前只写 `is_deleted+保留期` 和“误删可恢复”，没有说明项目删除与画布删除的不同语义。当前 `deleteProject` 是“删除项目实体，画布回落 standalone”，不是 cascade 删除画布；当前 `deleteCanvas` 是硬删画布对象。服务端软删必须明确：
- project delete 是否仍只软删 project 并把 canvases `projectId` 置空，还是进入项目回收站；不要误改现有 UI 语义。
- canvas delete 是否同时软删绑定的 `messagesByScene`、tasks、分享权限、asset refs；恢复时必须恢复 document+chat+asset refs。
- 表结构至少包含 `is_deleted/deleted_at/deleted_by/delete_reason/purge_after`；列表查询默认过滤，owner 可查 trash。
- retention purge job 与 asset refcount 解耦：只有无任何 live/soft-deleted 可恢复引用时才物理删 asset。
- 验收补 e2e/API：删除后列表不可见、直接 GET 返回 404/410、restore 后原 title/nodes/chat/assets/share role 恢复、保留期后 purge 不可恢复。

## 已核实但不单列为阻塞

FX-4 的 1MB JSON 上限风险是真的，不是臆断。`server/lib/config.ts:35` 默认 `jsonRequestMaxBytes = 1024 * 1024`，`server/lib/request.ts:42-46` 的 `readJsonBody` 使用该上限，`server/routes/generate.ts:65` 和 `server/routes/tasks.ts:53` 等路径会把 `RequestBodyTooLargeError` 映射为 413。虽然未来 `/api/canvas` 尚未实现，但如果复用当前 JSON helper 做整画布 PUT，几千节点画布确实会撞 413；计划里的节点级增量 PATCH 方向正确。

## Verdict

REQUIRES_CHANGES
