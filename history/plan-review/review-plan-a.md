# 架构迁移执行计划评审 A：数据模型 / 序列化 / 服务端 schema / CRDT-ready

审查对象：`docs/plan/arch-migration-execution-plan.md`

实跑命令：
- `npm run codemap`：通过。
- `npm run lint`：通过。
- `npx tsc -b --noEmit`：通过。

抽查核对：
- `history/conn-matrix/zone-store-model.md:66-78` 关于 `canvasPersistConfig` 8 字段属实：`src/store/canvasPersistConfig.ts:29-38` 只 partialize `canvases/projects/sceneId/selectedNodeId/selectedNodeIds/activeTool/brushStyle/activeStampKind`。
- `history/conn-matrix/zone-store-model.md:81-82` 关于瞬态字段属实：`src/store/canvasStateTypes.ts:65-82` 中 `nodes/edges/tasks/clipboard*/history*` 等运行态字段不直接 partialize。
- `history/conn-matrix/zone-store-model.md:33` 关于 compact 删除字段属实：`src/store/canvasDocumentModel.ts:76-91` 删除 `asset/fills/relations/strokes/transform`，仅 rotation 非零时保留 `transform`。
- `history/conn-matrix/README.md:29` 关于 `syncToServer` 空接线点属实：`src/lib/persistIdbStorage.ts:129-135` 是空实现，`src/lib/persistIdbStorage.ts:178-183` 仅写 IDB，服务端同步还是注释。
- `history/conn-matrix/README.md:18` 关于同步 generate/edit 未带 authHeaders 属实：`src/lib/mivoImageClient.ts:130-138` 只发 `Content-Type`，`src/lib/mivoImageClient.ts:160-178` multipart 无 auth headers；`enhance` 才在 `src/lib/mivoImageClient.ts:192-200` 展开 `authHeaders()`。
- `history/conn-matrix/zone-store-model.md:43-46` 关于 chat persist/settle 属实：`src/store/chatStore.ts:842-856` partialize `messagesByScene/selectedModel/paramOverrides`，merge 时重置 `isBusy:false` 并 settle expired messages。

## Findings

### [严重度 P1 | 位置 `docs/plan/arch-migration-execution-plan.md:75-77`, `src/types/mivoCanvas.ts:252-340`, `src/types/mivoCanvas.ts:397-445` | 问题 | 建议修法]

计划把 T1.2 验收写成“records 扁平化 + 每 record `revision`，Doc 无损映射 Y.Map/Y.Array”，但没有给出 record schema，按现有真实结构无法直接验收。

当前 `MivoCanvasNode` 不是单层 record：`transform/fills/strokes/effects/layout/constraints/asset/relations/generation/aiWorkflow/experimentalAnchors/annotationBounds` 都是嵌套对象或数组；`CanvasDocument` 还包含 `tasks` 与文档内 `selectedNodeId(s)`。`compactNodeForPersist` 目前会丢弃规范化的 `asset/fills/relations/strokes/transform`，依赖 legacy flat 字段再 normalize，这说明“运行时 V2 形状”和“持久化形状”本身已经不是一个 schema。

建议在 M1 前新增一张 record schema 表，至少定义：
- `canvas_record` / `node_record` / `edge_record` / `task_record` / `chat_message_record` / `anchor_record` 的 id、parent、scope、revision、deleted 标记。
- 嵌套数组的映射策略：`fills/strokes/effects/markupPoints/experimentalAnchors/aiWorkflow.sourceNodeIds/parentIds` 是拆 child records、Y.Array，还是明确作为同 record payload 里的同节点冲突域。
- `tasks` 是否仍属于 document record；如果是，给 task 独立 revision，否则跨设备会把 running/failed settle 语义变成整 canvas 冲突。

### [严重度 P1 | 位置 `docs/plan/arch-migration-execution-plan.md:52`, `docs/plan/arch-migration-execution-plan.md:75-77`, `docs/decisions/platform-architecture-2026-07-07.md:238-242` | 问题 | 建议修法]

DP-5（节点 payload `jsonb` 整存 vs 拆列）仍是开放项，但 T1.1 起库、T1.2 内核、T1.3 API 都依赖它，不能边实现边拍。

推荐方案：**typed envelope columns + `payload jsonb`，不要全量拆列**。列化字段保留 `id/canvas_id/type/revision/scope/is_deleted/created_at/updated_at`，再按查询和权限需要抽 `project_id/owner_id/section_id/z_order` 等少量索引字段；节点类型私有属性放 `payload jsonb`，由应用层按 command/patch 做 CAS revision 检查。

理由：当前节点类型多且字段高度可选，全拆列会让 migration 和后续节点总线成本爆炸；但纯 JSONB 大 blob 也不能假装字段级 CRDT。第一版的并发承诺是“不同 record 保留、同 record 冲突”，因此 SQL 侧用 record revision 做冲突检测即可。若要为后续 Yjs 更贴近铺路，必须把 `fills/anchors/effects` 这类多项集合升级成 child records 或 Y.Array，而不是让 SQL JSONB 自己承担 merge。

### [严重度 P1 | 位置 `docs/plan/arch-migration-execution-plan.md:96`, `src/canvas/actions/canvasActionTypes.ts:21-40`, `src/canvas/actions/canvasActionTypes.ts:48-155`, `src/canvas/actions/canvasActionModel.ts:153-208` | 问题 | 建议修法]

T2.3 写“action 补可序列化格式（无闭包/Blob）”，但真实 `canvasActionModel` 不是 command log，而是 UI 菜单模型：`CanvasActionItem.onClick` 是闭包，`CanvasActionRuntime` 挂满 UI callbacks、store functions、Promise action、React/lucide icon component。直接序列化这层不可行。

最难序列化的 3 类 action：
- `import-asset`：`src/canvas/actions/canvasActionModel.ts:457-464` 与 `:862` 调 `onImportAssetAt` 或切 import tool，后续进入 File picker / drag-drop；必须先 `/api/assets` 入库拿 `assetId`，再发 `addImportedFileNode` command。
- `select-area-edit` / mask edit：`src/canvas/actions/canvasActionModel.ts:167-173` 只启动 overlay；真正提交会携带 mask/source Blob。应拆成 UI session intent 与最终 `requestImageEdit` command。
- generation/edit 系列：`src/canvas/actions/canvasActionModel.ts:110-150`、`:555-600` 调 async store action；底层 `CanvasGenerationOptions` 含 `referenceFiles?: File[]` 和 `signal?: AbortSignal`（`src/store/canvasStateTypes.ts:49-57`），`MivoEditRequest` 含 `image/mask/reference` Blob（`src/types/generation.ts:74-89`）。

建议把 `CanvasActionItem` 明确改名/定位为 UI action，不进入 command log；新增独立 `CanvasCommand` discriminated union，只允许 JSON 参数和 assetId/taskId 引用。Blob/File/AbortSignal/下载/打开面板/编辑 overlay 都放在 effect 层或 session 层，command 只记录最终文档变更或服务端任务请求。

### [严重度 P1 | 位置 `docs/plan/arch-migration-execution-plan.md:76`, `docs/plan/arch-migration-execution-plan.md:80`, `src/store/canvasPersistConfig.ts:18-38`, `src/store/canvasGenerationHydration.ts:67-238` | 问题 | 建议修法]

计划同时写了 T1.2 “persist 大版本迁移；dry-run+回滚”与 T1.6 “不做迁移器，手动导出/导入”。这两句话如果不拆清，会导致执行时有人把本地 IDB schema 迁移也省掉。

现状 `mivo-canvas-demo` v10 的 8 字段同时混了 document、user、session：`canvases/projects` 是 document，`sceneId/activeTool/brushStyle/activeStampKind` 是 user，`selectedNodeId(s)` 待 DP-1。`migratePersistedState` 还负责 v6/v8/v9/v10 兼容、demo project relink、orphan project cleanup 和 hydration settle。M1 拆 DocKernel / SessionStore / user-state 时必须迁移这些本地结构，否则会丢最近画布、工具偏好、项目归属或选择态。

建议把迁移分成两类并写进计划：
- 必做：client local persist migration，从 v10 单 blob 拆到 document/user/session store，带 fixtures、dry-run、回滚路径、userId cache key。
- 可不做：历史用户数据批量导入服务端 migration，按 T1.6 走手动 JSON 导出/导入。

### [严重度 P1 | 位置 `docs/plan/arch-migration-execution-plan.md:77-79`, `history/conn-matrix/README.md:11-25`, `docs/decisions/p4-schema-spike.md:136-144`, `server/app.ts:45-64` | 问题 | 建议修法]

4 个新 API 的大方向正交，但资源边界仍有遗漏：
- Chat history：连接矩阵把 `messagesByScene` 归 document，P4 schema spike 明确“随 canvas 服务端化，但作为独立集合，不嵌入 canvas 文档主体”。计划只写 `/api/canvas`，没有定义 `/api/canvas/:id/messages` 或 `canvas_messages` 子资源。
- 分享与权限：T1.4 需要 owner/editor/viewer、邀请、分享链接，但 T1.3 的 `/api/projects` / `/api/canvas` 没写 `project_members`、`share_links` 的 API 归属。权限不能等后补，因为架构文档要求第一版就校验。
- User-state：矩阵 15 行里除了 `sceneId/activeTool/brushStyle/stampKind`，还有 changelog lastRead、sidebar collapse、chat selectedModel/paramOverrides、草稿等 user scope；计划只写“偏好”，schema 不足以执行。
- Keys：连接矩阵建议两把 key 继续前端 strict IDB；计划没有把“不迁 keys 到 user-state”写成约束，容易被误并入 `/api/user-state`。

建议补一节“API resource schema skeleton”：`/api/canvas/:id/records`、`/api/canvas/:id/messages`、`/api/projects/:id/members`、`/api/projects/:id/share-links`、`/api/user-state` key namespace、`/api/assets/:id`，并明确现有 `/api/mivo/*` 和 `/api/auth` 保持原边界。

### [严重度 P2 | 位置 `docs/plan/arch-migration-execution-plan.md:48`, `src/store/canvasDocumentModel.ts:93-98`, `src/store/canvasPersistConfig.ts:29-38` | 问题 | 建议修法]

DP-1 已识别选择态双写，但 T1.2 的验收没有把它落成 schema 约束。现状选择态既在顶层 `selectedNodeId/selectedNodeIds` partialize，又随 `canvases[scene].selectedNodeIds` 进入文档 compact persist。

建议在 M1 schema 中明确：选择态不属于 document record；从服务端文档 schema 移除 `selectedNodeId(s)`，迁移时只回填到 session 或 user-state。否则协作时 selection 会污染 document revision。

## Verdict

REQUIRES_CHANGES

必须改的条目：P1 finding 1、2、3、4、5。P2 finding 6 可随 DP-1 一并收口，但不能在 M1 实现时继续双写。
