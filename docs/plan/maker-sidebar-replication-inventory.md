# Maker 项目目录管理 → MivoCanvas 复刻逐项清单

## 勘误

- 未发现调研档案在 UI/数据层映射上的功能性错漏。maker 侧右键菜单、分组、折叠、时间标签、IPC/SQLite 链路与 mivo 侧 Zustand/IndexedDB 现状均可在源码中核实。
- 仅有一个环境状态差异：调研档案称当前工作树在 `feat/leafer-stamp-native-fx`，本次核实 `git branch --show-current` 为 `main`，但工作树确有大量未提交 Leafer/stamp 相关改动；“后续实现需隔离分支/工作树”的风险判断仍成立。

## A. 可直接拷贝 / 轻改

| 编号 | 功能点 | maker 参考 | mivo 目标文件 | 工作量 | 风险 / 依赖 |
|---|---|---|---|---|---|
| A1 | 相对时间标签 `now / Nm / Nh / Nd / Nw / Nmo / Ny` 与无定时刷新策略 | `apps/desktop/src/renderer/features/cc-agent/lib/formatSidebarTime.ts:31-67` | `src/lib/formatSidebarTime.ts` | S | 依赖 C3 先给 `CanvasDocument.updatedAt` 补齐；mivo 可先用英文短标签，中文文案再接现有 UI 语言策略。 |
| A2 | 完整时间 `title` 文案格式 `YYYY-MM-DD HH:mm` | `apps/desktop/src/renderer/features/cc-agent/lib/formatSidebarTime.ts:110-116` | `src/lib/formatSidebarTime.ts`、`src/app/ProjectSidebar.tsx` | S | 同 A1；输入建议统一存 ISO string，避免本地时区和数字时间戳混用。 |
| A3 | 最近活跃排序比较器：取 `updatedAt` 最大值，项目按 latest desc，画板按 updatedAt desc | `apps/desktop/src/renderer/features/cc-agent/lib/projectGrouping.ts:287-312`、`apps/desktop/src/renderer/features/cc-agent/lib/projectGrouping.ts:508-563` | `src/app/sidebar/projectSidebarModel.ts` 或 `src/app/ProjectSidebar.tsx` | S | 依赖 C3/C4；mivo 没有 `status/userSendAt`，不要照搬 active/archived 排序。 |
| A4 | 项目折叠持久化：localStorage 只存 collapsed，默认展开，写失败静默回退 | `apps/desktop/src/renderer/features/cc-agent/hooks/useCollapsedProjects.ts:22-82`、`apps/desktop/src/renderer/features/cc-agent/hooks/useCollapsedProjects.ts:131-221` | `src/app/sidebar/useCollapsedProjects.ts` | S | key 改为 `mivo.sidebar.collapsedProjects`；id 从 maker `projectKey/workingDir` 改为 mivo `project.id`。 |
| A5 | inline rename 状态机：触发、聚焦全选、Enter/Blur 提交、Esc 取消、防重复提交 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:142-161`、`apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:261-286`、`apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:283-325` | `src/app/sidebar/EditableName.tsx` 或 `src/app/ProjectSidebar.tsx` | M | UI 结构不同但交互逻辑可搬；画板 rename 调现有 `renameCanvas`，项目 rename 调 C1 新 action。 |
| A6 | 鼠标坐标定位右键菜单的核心坐标采集 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:236-241`、`apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:519-524` | `src/app/sidebar/ContextMenu.tsx` | S | 只搬坐标/状态思路；Radix trigger/content 必须按 B3/C5 改成自研 portal。 |
| A7 | “移动到项目”子菜单数据规范化：当前目标禁用、项目列表、移到 Canvas/Dialogue | `apps/desktop/src/renderer/features/cc-agent/sidebar/SessionProjectMoveSubmenu.tsx:17-87` | `src/app/sidebar/MoveCanvasMenu.tsx` | M | `workingDir` 改为 `projectId`；“选择项目文件夹”不进 v1；空项目列表需显示不可用态。 |
| A8 | 菜单视觉 token 抽象：surface、item、separator 三类 | `apps/desktop/src/renderer/features/cc-agent/sidebar/menuStyles.ts:20-36` | `src/App.css`、`src/app/sidebar/ContextMenu.tsx` | S | maker 是 Tailwind class 常量，mivo 需落成 plain CSS class；仅搬视觉结构和尺寸语义。 |

## B. 需重写

| 编号 | 功能点 | maker 参考 | mivo 目标文件 | 工作量 | 风险 / 依赖 |
|---|---|---|---|---|---|
| B1 | 侧栏数据源替换：从硬编码 demo `projectGroups` 改为 `projects + canvases` 派生 | `apps/desktop/src/renderer/features/cc-agent/lib/projectGrouping.ts:375-565`；mivo 现状 `src/app/ProjectSidebar.tsx:64-75`、`src/app/ProjectSidebar.tsx:182-186` | `src/app/ProjectSidebar.tsx`、`src/app/sidebar/projectSidebarModel.ts` | M | 依赖 C1/C3/C5；mivo 是一等 project，不复刻 maker `workingDir` 派生分组。 |
| B2 | 画板右键菜单全项：重命名 / 移动到项目 / 复制画板 / 删除 | `apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:785-910`；mivo 现有 `duplicateCanvas/deleteCanvas/renameCanvas` 在 `src/store/documentSlice.ts:79-189` | `src/app/ProjectSidebar.tsx`、`src/app/sidebar/CanvasRow.tsx` | M | 依赖 C5/C6；删除沿用 `deleteCanvas` 的“至少保留一块”保护，UI 层仍要确认弹窗和 toast。 |
| B3 | Radix 右键菜单改自研 ContextMenu：portal、fixed 坐标、Escape、点外关闭、边界内定位 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:344-451`、`apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:789-815`；mivo portal/点外模式 `src/app/LibraryWorkspace.tsx:496-505`、`src/app/LibraryWorkspace.tsx:1171-1182` | `src/app/sidebar/ContextMenu.tsx`、`src/App.css` | M | mivo 无 Radix；需自己处理焦点、z-index、视口边缘裁切和菜单关闭时机。 |
| B4 | 项目右键菜单全项按 D7：重命名 / 在此项目新建画板 / 删除项目 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:371-449` | `src/app/sidebar/ProjectRow.tsx`、`src/app/ProjectSidebar.tsx` | M | maker 的搜索、本地文件、深链、同步 Codex、全部归档按 D5 不复刻；删除项目是 mivo 新语义，依赖 C7。 |
| B5 | “移动到项目”子菜单：项目列表 + “移到 Canvas” | `apps/desktop/src/renderer/features/cc-agent/sidebar/SessionProjectMoveSubmenu.tsx:33-87`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:1307-1389` | `src/app/sidebar/MoveCanvasMenu.tsx`、`src/store/documentSlice.ts` | M | 依赖 C5；移动后建议自动展开目标项目；失败需回滚 projectId。 |
| B6 | inline rename 接线：画板双击/菜单触发，项目双击/菜单触发 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:224-286`、`apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:313-325`、`apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:560-574` | `src/app/sidebar/CanvasRow.tsx`、`src/app/sidebar/ProjectRow.tsx` | M | 依赖 A5/C1；提交空串应取消或保留原名，不要写空 title/name。 |
| B7 | 新建项目入口：Projects 段头 `+` 从空壳变为创建实体并立即命名 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectsSection.tsx:301-314`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:1131-1142`；mivo 空壳 `src/app/ProjectSidebar.tsx:332-334` | `src/app/ProjectSidebar.tsx`、`src/store/projectsSlice.ts` | S | 依赖 C1；不走 maker 选目录，建议默认名 `Untitled Project` + 立即进入项目 rename。 |
| B8 | 新建画板入口：Canvas 段头、顶部 Canvas `+`、项目 hover/menu “在此项目新建画板” | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/DialogueSection.tsx:223-235`、`apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:325-339`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:1110-1128`；mivo 现有入口 `src/app/ProjectSidebar.tsx:155-158`、`src/app/ProjectSidebar.tsx:280-288`、`src/app/ProjectSidebar.tsx:376-383` | `src/app/ProjectSidebar.tsx`、`src/app/sidebar/ProjectRow.tsx` | S | `createCanvas(title,{projectId})` 已存在；项目内创建后要打开该画板并展开项目。 |
| B9 | 时间标签渲染：画板行右侧 `<time>`、title 绝对时间，hover action 与时间槽互斥 | `apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:699-708` | `src/app/sidebar/CanvasRow.tsx`、`src/App.css` | S | 依赖 A1/A2/C3；窄侧栏要保证 title、time、hover action 不重叠。 |
| B10 | 删除确认弹窗的业务接线：删除画板、删除项目分别给标题/描述/红色确认按钮 | `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx:40-194`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:2019-2047` | `src/app/sidebar/ConfirmDialog.tsx`、`src/app/ProjectSidebar.tsx` | M | 组件本体需新建 C6；删除项目描述必须明确“画板移回 Canvas，不删除画板”。 |
| B11 | 项目/画板排序：项目按最新画板 `updatedAt` desc，项目内画板按 `updatedAt` desc，standalone Canvas 同口径 | `apps/desktop/src/renderer/features/cc-agent/lib/projectGrouping.ts:508-563`、`apps/desktop/src/renderer/features/cc-agent/lib/sidebarProjectSorting.ts:24-58` | `src/app/sidebar/projectSidebarModel.ts` | S | 依赖 C3/C4；v1 不做手动拖拽，不引 `sortablejs`。 |
| B12 | debugLogger / toastFeedback 埋点：所有用户可见状态变更记录 log/warn/error，成功/失败给 toast | maker 示例：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:1253-1263`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:1362-1386`；mivo 规则 `docs/development-logging.md:3-28`、API `src/store/debugLogStore.ts:55-69`、`src/store/toastStore.ts:57-64` | `src/store/projectsSlice.ts`、`src/store/documentSlice.ts`、`src/app/ProjectSidebar.tsx`、`scripts/verify-debug-logging.mjs` | M | `createCanvas/deleteCanvas/renameCanvas` 已有 `logCanvas`，但 UI 层复制/移动/项目 CRUD 还需 toast；失败路径必须 log + toast。 |
| B13 | 项目折叠 UI：Projects 段折叠、项目节点折叠、折叠态持久化 | `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectsSection.tsx:204-237`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:750-758`；mivo 现状 `src/app/ProjectSidebar.tsx:130-137`、`src/app/ProjectSidebar.tsx:317-370` | `src/app/ProjectSidebar.tsx`、`src/app/sidebar/useCollapsedProjects.ts` | S | 依赖 A4；当前 `expandedProjects` 是组件内 demo state，需要改为 project id 驱动。 |
| B14 | 复刻样式落地：菜单、rename input、confirm、hover 新建按钮、行右侧动作 | `apps/desktop/src/renderer/features/cc-agent/sidebar/menuStyles.ts:20-36`、`apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:304-340`、`apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:733-780`；mivo CSS 基础 `src/App.css:929-1173`、`src/App.css:1737-1786`、`src/App.css:2672-2700` | `src/App.css` | M | mivo plain CSS，不可直接贴 Tailwind；要复用现有 sidebar 色板和 8px 内圆角规则。 |

## C. 功能缺失需新建

| 编号 | 功能点 | maker 参考 | mivo 目标文件 | 工作量 | 风险 / 依赖 |
|---|---|---|---|---|---|
| C1 | 项目一等实体与 projects slice：`projects: Project[]`、`createProject`、`renameProject`、`deleteProject` | - | `src/types/mivoCanvas.ts`、`src/store/projectsSlice.ts`、`src/store/canvasStore.ts` | L | 基础依赖；需决定 `Project { id, name, createdAt, updatedAt? }`。建议加 `updatedAt`，排序仍由画板 latest 决定。 |
| C2 | Project ID 生成与默认命名策略 | - | `src/store/nodeFactory.ts`、`src/store/projectsSlice.ts` | S | 避免复用 canvas id 前缀；建议 `project-${...}`。默认名要可预测，重名可允许但 UI 要靠 id 区分。 |
| C3 | `CanvasDocument.createdAt/updatedAt` 字段 + persist v9→v10 迁移 | -；maker 只有 sessions 表时间字段 `apps/desktop/src/main/localDb/schema.ts:172-177` | `src/types/mivoCanvas.ts`、`src/store/canvasDocumentModel.ts`、`src/store/canvasPersistConfig.ts`、`src/store/canvasGenerationHydration.ts`、`src/store/canvasStore.contract.test.ts`、`src/store/canvasStoreMigrate.test.ts` | L | 阻塞 A1/A3/B9/B11；迁移需给所有存量画板补时间，`canvasPersistOptions.version` 从 9 升 10，contract 测试字段集同步。 |
| C4 | updatedAt bump 时机统一：创建、重命名、复制、移动项目、内容变更、导入/生成/删除节点、applySnapshot/rollback | maker 对比：`userSendAt` 与 `updatedAt` 分离 `apps/desktop/src/main/localDb/ipc/sessions.ts:520-527`、`sessionPatchToRow` 刷 `updatedAt` `apps/desktop/src/main/localDb/mapper.ts:256-305` | `src/store/canvasDocumentModel.ts`、`src/store/documentSlice.ts`、`src/store/nodeMutationSlice.ts`、`src/store/nodeCreationSlice.ts`、`src/store/generationSlice.ts` | L | 高风险共享行为；建议集中在 `patchCanvasDocument`/`patchActiveCanvas` 默认 bump，并给 hydration/normalize/selection-only 提供 `bumpUpdatedAt:false`。 |
| C5 | `moveCanvasToProject(canvasId, projectId?)` store action | - | `src/store/documentSlice.ts`、`src/store/canvasStore.ts` | M | 依赖 C1/C3/C4；移动到已删除/不存在项目要 warn + toast；成功后 bump canvas `updatedAt`。 |
| C6 | 自研 ConfirmDialog 组件本体 | maker Radix 实现 `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx:40-194` | `src/app/sidebar/ConfirmDialog.tsx`、`src/App.css` | M | mivo 无 Radix；需 portal、焦点管理、Escape/点外关闭、destructive 按钮样式、aria-modal。 |
| C7 | 删除项目级联：删除项目实体，其下画板回落为 standalone Canvas | - | `src/store/projectsSlice.ts`、`src/store/documentSlice.ts` 或共享 store action | M | 依赖 C1/C5/C6；确认弹窗必须说明不删除画板；删除后清理 localStorage 折叠态。 |
| C8 | 画板复制后的 projectId/时间语义：复制留在原项目，标题加 Copy，打开新画板 | maker 标准菜单有复制链接/导出但无 canvas copy；mivo 现有 `duplicateCanvas` 在 `src/store/documentSlice.ts:79-113` | `src/store/documentSlice.ts`、`src/app/sidebar/CanvasRow.tsx` | S | 现有 `duplicateCanvas` 会复制 `projectId`；需补 `createdAt/updatedAt` 为 now，成功 toast。 |
| C9 | ContextMenu 组件本体与子菜单支持 | maker Radix 子菜单 `apps/desktop/src/renderer/features/cc-agent/sidebar/SessionItem.tsx:481-500` | `src/app/sidebar/ContextMenu.tsx`、`src/app/sidebar/MoveCanvasMenu.tsx` | M | 依赖 B3；子菜单可先 click 展开而非 hover 展开，降低焦点复杂度。 |
| C10 | 画板/项目行组件拆分，避免继续扩张 `ProjectSidebar.tsx` | -；mivo 当前单文件 `src/app/ProjectSidebar.tsx:110-521` | `src/app/sidebar/CanvasRow.tsx`、`src/app/sidebar/ProjectRow.tsx`、`src/app/sidebar/SidebarSection.tsx` | M | 非纯功能但必要；否则右键、rename、confirm、菜单状态会把现有文件推向不可维护。 |
| C11 | Sidebar 搜索输入从死控件变为可过滤项目/画板（建议不阻塞 v1 菜单复刻） | maker 项目菜单搜索 `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx:389-397`；mivo 死输入 `src/app/ProjectSidebar.tsx:269-272` | `src/app/ProjectSidebar.tsx`、`src/app/sidebar/projectSidebarModel.ts` | M | D7 v1 项目菜单不含搜索；建议作为 v1.1，不放进右键菜单首版。 |
| C12 | persist / store contract 单测增补：projects 字段、v10、updatedAt 迁移、delete project cascade、move canvas | - | `src/store/canvasStore.contract.test.ts`、`src/store/canvasStoreMigrate.test.ts`、`src/store/canvasDocumentModel.test.ts` | M | 阻塞合入质量；当前 contract 明确 pin v9 和 partialize 字段集 `src/store/canvasStore.contract.test.ts:140-184`。 |
| C13 | e2e 用例增补：右键菜单、移动、rename、删除确认、折叠持久化、时间排序、迁移 smoke | -；mivo e2e 入口 `scripts/e2e-smoke.mjs:480-512`、scenario 注册 `scripts/e2e/scenarios/index.mjs:26-51`、现有 sidebar 断言 `scripts/e2e/scenarios/shell-sidebar.mjs` | `scripts/e2e/scenarios/project-sidebar.mjs`、`scripts/e2e/scenarios/index.mjs`、`scripts/e2e-smoke.mjs` | L | 需覆盖 dev/prod × dom/leafer；可新增独立 scenario，避免把 `shell-sidebar.mjs` 继续拉长。 |
| C14 | logging verifier 同步：ProjectSidebar / projectsSlice / document actions 必须包含 required logger/toast 路径 | -；mivo verifier `scripts/verify-debug-logging.mjs:74-88` | `scripts/verify-debug-logging.mjs` | S | 依赖 B12；新增功能若只 toast 不 log，会违反项目 invariant。 |

## 开放决策建议

1. `pinnedAt` 不进 v1。理由：v1 的核心风险已经集中在项目实体、persist v10、updatedAt bump、菜单和删除确认；置顶会引入排序优先级、菜单变体、持久字段和 e2e 组合爆炸。当前可先用 latestActivityAt 满足“最近工作”主路径。
2. 归档不进 v1。理由：mivo 画板当前没有 `status`，归档需要 active/archived/all 过滤、取消归档、删除/归档双语义和迁移。v1 只做删除，并保留 `deleteCanvas` 的至少一块保护，产品语义更清楚。
3. “在此项目新建画板”做双入口：项目行 hover `+`/SquarePen + 项目右键菜单项。理由：maker 已验证 hover 入口适合作为高频主操作，菜单项给右键用户可发现性；两者复用同一个 `createCanvas({ projectId })` handler，额外成本低。

## 建议实施顺序

1. 数据层与迁移：C1、C2、C3、C4、C5、C7、C12。先把 Project/Canvas 时间/移动/删除语义稳定下来，避免 UI 先接到临时 shape。
2. 纯逻辑与 selectors：A1、A2、A3、A4、B1、B11、B13。完成分组、排序、折叠、时间标签的可测试模型。
3. 组件基础设施：B3、C6、C9、C10、B14。先建 ContextMenu/ConfirmDialog/Row 组件，再接具体业务菜单。
4. UI 接线：B2、B4、B5、B6、B7、B8、B9、C8。按画板菜单、项目菜单、移动子菜单、rename、新建入口逐个接入。
5. 埋点与反馈：B10、B12、C14。每个用户动作补齐 debugLogger 与 toastFeedback，失败路径先验。
6. e2e 收口：C13。新增 project-sidebar scenario，覆盖 dev/prod × dom/leafer 的关键路径；最后跑 `npm run build`、`npm run lint`、`npm run test:unit`、目标 e2e。
