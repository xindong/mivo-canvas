# Maker 项目目录管理复刻 MivoCanvas 实施计划

> **For agentic workers:** 按 Phase 顺序执行,每个 Phase 内先测试后实现(TDD),每个 Phase 结束 commit + 跑门禁。步骤用 checkbox 跟踪。
> 输入文档(执行前必读):
> - `docs/plan/maker-sidebar-replication-inventory.md`(36 项 A/B/C 清单,编号在本计划中引用)
> - `history/research/maker-sidebar-replication-context.md`(maker 调研 + 映射决策 D1-D8)

**Goal:** 把 maker 侧栏的项目/对话目录管理(项目 CRUD、画板/项目右键菜单、画板归类移动、时间标签、折叠持久化)复刻到 mivocanvas,交互与 UI 对齐 maker。

**Architecture:** 项目为一等实体(新 projectsSlice),画板通过既有 `CanvasDocument.projectId` 归属;分组/排序为纯派生模型(projectSidebarModel);右键菜单/确认弹窗自研轻量组件(portal + plain CSS,不引 Radix/sortablejs);persist v9→v10 迁移补时间戳与 projects 字段。

**Tech Stack:** React 19 + Zustand 5(persist/IDB)+ plain CSS(App.css)+ vitest + Playwright e2e(自研 harness)。

**已锁决策(不得偏离):** D1-D8(见 context 档案)+ 置顶不进 v1 / 归档不进 v1 / 「在此项目新建画板」双入口(hover + 右键菜单)/ 侧栏搜索激活(C11)不进 v1,搜索框维持现状死控件。

---

## 硬约束(违反任一 = 打回)

1. **隔离工作树**:主工作树正处于另一工作流的 rebase 冲突态,**严禁触碰**。必须:
   ```bash
   cd "/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas"
   git fetch origin
   git worktree add ../mivocanvas-sidebar-wt -b feat/project-sidebar-management origin/main
   cd ../mivocanvas-sidebar-wt && npm install
   ```
   之后所有操作在 `../mivocanvas-sidebar-wt` 内。
2. **不删除 verifier 钉死标记**:`scripts/verify-debug-logging.mjs:74-88` 要求 `ProjectSidebar.tsx` 含 `settingsMenuItems` / `handleSettingsMenuItem` / `debugLogger.warn('Settings'` 及 5 个 label 字面量。重构侧栏时保留 settings 菜单原样。
3. **contract 测试同步**:`canvasStore.contract.test.ts` 钉死 partialize 字段集与 version;新增 `projects` 字段、v10 必须同步更新该测试(见 Phase 1)。
4. **每个用户可见操作**:debugLogger(成功 log/跳过 warn/失败 error)+ 需要即时反馈的加 toastFeedback(`docs/development-logging.md`)。
5. **不引新 runtime 依赖**(Radix/sortablejs/tailwind 一律不进)。
6. **门禁命令**(每 Phase 结束跑,全绿才 commit):
   ```bash
   npm run build && npm run lint && npm run verify:logging && npx vitest run
   ```
7. **禁改范围**:`src/render/**`、`server/**` 禁改;`src/canvas/**` 默认禁改,**唯一例外**:Phase 1 允许修改 `src/canvas/maskEditGeneration.ts` 的 updatedAt 接线(把直接 canvases 写入改走 patchCanvasDocument 或补 bump),不得改渲染/交互逻辑;聊天/生成相关 store 仅允许 Phase 1 中 updatedAt bump 的最小接线。

---

## Phase 0:工作树就绪 + 基线

- [ ] 按硬约束 1 建工作树,`npm install`
- [ ] 跑一遍门禁命令,记录基线结果(应全绿;若基线即红,停下上报,不得带病开工)
- [ ] Commit 点:无(只验证)

## Phase 1:数据层与迁移(C1 C2 C3 C4 C5 C7 C12,部分 C8)

**Files:**
- Modify: `src/types/mivoCanvas.ts`(CanvasProject 类型 + CanvasDocument 时间戳)
- Create: `src/store/projectsSlice.ts`
- Create: `src/store/projectsSlice.test.ts`
- Modify: `src/store/canvasStore.ts`(CanvasState 扩展 + slice 组装)
- Modify: `src/store/documentSlice.ts`(moveCanvasToProject + 时间戳接线)
- Modify: `src/store/canvasDocumentModel.ts`(updatedAt bump 中枢)
- Modify: `src/store/canvasGenerationHydration.ts`(migrate v10)
- Modify: `src/store/canvasPersistConfig.ts`(version 10 + partialize.projects)
- Modify: `src/store/canvasStore.contract.test.ts`、`src/store/canvasStoreMigrate.test.ts`、`src/store/canvasDocumentModel.test.ts`
- Modify: `src/canvas/maskEditGeneration.ts`(仅将 mask-edit 直接 canvases 写入接入 updatedAt 中枢,见 1d)

### 1a. 类型(C1/C3)

```ts
// src/types/mivoCanvas.ts 新增
export type CanvasProject = {
  id: string
  name: string
  createdAt: string // ISO
}

// CanvasDocument 增加(required,迁移与 normalizeDocument 双重兜底回填):
export type CanvasDocument = {
  title: string
  sourceTemplateId?: DemoSceneId
  projectId?: string
  createdAt: string // ISO
  updatedAt: string // ISO
  nodes: MivoCanvasNode[]
  edges: CanvasEdge[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}
```

### 1b. projectsSlice(C1/C2/C7)

```ts
// src/store/projectsSlice.ts — SliceCreator 模式对齐 documentSlice
export const createProjectId = () => `project-${crypto.randomUUID()}`

// CanvasState 扩展(canvasStore.ts):
//   projects: CanvasProject[]
//   createProject: (name?: string) => string
//   renameProject: (projectId: string, name: string) => void
//   deleteProject: (projectId: string) => void

// 语义:
// createProject(name = 'Untitled Project') → push {id, name, createdAt: now};logCanvas;返回 id
// renameProject → trim 后空串则 warn + no-op;同名允许;logCanvas
// deleteProject → 级联:所有 canvases[*].projectId === projectId 的画板 projectId 置 undefined
//                (画板本体不删、updatedAt 不 bump——归属回落不是内容变更);
//                项目不存在则 warn + no-op;logCanvas 记录回落画板数量
```

TDD:先写 `projectsSlice.test.ts`(创建/重命名空串拒绝/删除级联回落/删除不存在项目 warn),跑红 → 实现 → 跑绿。

### 1c. moveCanvasToProject(C5)

```ts
// documentSlice.ts 新增 action(签名进 CanvasState):
//   moveCanvasToProject: (canvasId: CanvasId, projectId?: string) => void
// 语义:
// - projectId === undefined → 移到 Canvas 区(清 projectId)
// - 目标项目不存在 → warnCanvas + no-op(UI 层 toast)
// - 目标 === 当前归属 → no-op(不 bump)
// - 成功 → 改 projectId 并 bump updatedAt(移动算用户显性操作,对齐 maker move 后 recent 刷新语义);logCanvas
```

### 1d. updatedAt bump 中枢(C4)

`canvasDocumentModel.ts` 的 `patchCanvasDocument` / `patchActiveCanvas`:
- patch 含 `nodes`/`edges`/`tasks`/`title` 任一 → 自动 bump `updatedAt = new Date().toISOString()`
- 仅 `selectedNodeId`/`selectedNodeIds` 的 patch → 不 bump
- 新增可选参数 `options.bumpUpdatedAt?: boolean` 显式覆盖(hydration/normalize 路径传 false)
- `createCanvas`/`duplicateCanvas` 设 `createdAt = updatedAt = now`(duplicate 不继承源时间,C8)
- `normalizeDocument` 对缺失时间戳的文档回填 now(防御旧快照/demo 场景)
- **旁路写入全量收编**(全仓审计直接 `canvases` 写入,已知必须覆盖):
  - `src/canvas/maskEditGeneration.ts`:占位状态(≈47-85)、失败/取消移除(≈145-160)、poll 进度(≈210-232)三处直接 `useCanvasStore.setState` 写 canvases——优先改为 `patchCanvasDocument(..., { nodes/... })`;其中 poll 进度属机器高频更新,传 `bumpUpdatedAt: false`(进度不算用户内容变更);占位落点与失败回滚 bump
  - `canvasDocumentModel.ts` 的 `applySnapshot`(≈402-429)、`rollbackLatestHistoryBaseline`(≈432-481):设置 updatedAt 语义——undo/redo/replaceSnapshot(用户显性操作)bump;hydration/normalize/纯选择恢复传 `bumpUpdatedAt: false`
  - `documentSlice.ts` 的 `resetCurrentScene`(≈404-421):重置为用户显性操作,bump

TDD:`canvasDocumentModel.test.ts` 增补:内容 patch bump / selection-only 不 bump / 显式 false 不 bump / undo·redo·replaceSnapshot·rollbackLatestHistoryBaseline·resetCurrentScene 的 updatedAt 断言 / mask-edit 占位移除与进度路径断言。

### 1e. persist v10(C3/C12)

- `canvasPersistConfig.ts`:`version: 10`;`partialize` 增加 `projects: state.projects`
- **版本常量统一**:提取 `export const CANVAS_PERSIST_VERSION = 10`,persist options 与 `mergeCanvasPersistedState` 共用;当前 `canvasGenerationHydration.ts` 的 merge 内硬编码 `migrate(persistedState, 9)`,若不同步改会导致每次 hydration 按 v9 重跑迁移(重复 warn / 重复孤儿清理)——必须消除硬编码并用测试锁住 merge 调用版本
- `canvasGenerationHydration.ts` `migratePersistedState`:version < 10 时——
  - `projects` 缺失 → `[]`
  - 每个 canvas 缺 `createdAt`/`updatedAt` → 以迁移时刻统一回填
  - 孤儿 projectId(不在 projects 列表)→ 置 undefined + debugLogger.warn(迁移时 projects 必为空,即全部清孤儿;后续版本同规则)
- 更新 `canvasStore.contract.test.ts` 字段集(+`projects`,version 10)与 `canvasStoreMigrate.test.ts`(v9 快照 → v10 断言:projects=[]、时间戳回填、孤儿清理)

- [ ] 全部测试红→绿,门禁全绿
- [ ] Commit:`feat(store): project entity + canvas timestamps + persist v10 migration`

## Phase 2:派生模型与纯逻辑(A1 A2 A3 A4 B1模型 B11 B13逻辑)

**Files:**
- Create: `src/lib/formatSidebarTime.ts` + `src/lib/formatSidebarTime.test.ts`
- Create: `src/app/sidebar/projectSidebarModel.ts` + `src/app/sidebar/projectSidebarModel.test.ts`
- Create: `src/app/sidebar/useCollapsedProjects.ts`

```ts
// formatSidebarTime.ts(A1/A2,移植 maker 规则,中文标签对齐现有 UI):
// <60s → '刚刚';<60m → 'N 分钟';<24h → 'N 小时';<7d → 'N 天';<5w → 'N 周';<12mo → 'N 个月';否则 'N 年'
export const formatSidebarTime = (iso: string, now?: number) => string
export const formatSidebarTimeTitle = (iso: string) => string // 'YYYY-MM-DD HH:mm'

// projectSidebarModel.ts(B1/A3/B11):纯函数,输入 projects + canvases,输出:
export type SidebarProjectGroup = { project: CanvasProject; canvasIds: CanvasId[]; latestActivityAt: string }
export const buildSidebarModel = (
  projects: CanvasProject[],
  canvases: Record<CanvasId, CanvasDocument>,
) => { projectGroups: SidebarProjectGroup[]; standaloneCanvasIds: CanvasId[] }
// 规则:projectId 匹配归组;组内画板按 updatedAt desc;项目按 latestActivityAt(组内最大 updatedAt,空项目用 project.createdAt)desc;
// standalone(无 projectId 或孤儿)按 updatedAt desc;孤儿 projectId 视为 standalone(防御,不在模型里修数据)

// useCollapsedProjects.ts(A4/B13):localStorage key 'mivo.sidebar.collapsedProjects',
// 只存 collapsed 的 project.id 数组,默认展开,读写 try/catch 静默,API:
// { collapsed: Set<string>, toggle(id), setCollapsed(id, boolean) }
```

- [ ] 测试先行(时间边界、排序、空项目、孤儿画板),红→绿,门禁全绿
- [ ] Commit:`feat(sidebar): derived sidebar model + time labels + collapse persistence`

## Phase 3:组件基础设施(B3 C6 C9 C10骨架 B14)

**Files:**
- Create: `src/app/sidebar/ContextMenu.tsx`
- Create: `src/app/sidebar/ConfirmDialog.tsx`
- Create: `src/app/sidebar/EditableName.tsx`(A5)
- Modify: `src/App.css`(菜单/弹窗/rename 样式,复用现有 sidebar 色板与圆角体系)

```tsx
// ContextMenu API(B3/C9):
export type ContextMenuItem =
  | { kind: 'item'; id: string; label: string; icon?: LucideIcon; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: 'submenu'; id: string; label: string; icon?: LucideIcon; items: ContextMenuItem[] }
  | { kind: 'separator'; id: string }
export function ContextMenu(props: { position: { x: number; y: number }; items: ContextMenuItem[]; onClose: () => void })
// 实现要点:createPortal(document.body);position fixed;视口边缘 clamp(右/下溢出翻转);
// Escape + pointerdown 外部关闭;子菜单点击展开(不做 hover 展开);role="menu"/"menuitem";
// 触发方式:行 onContextMenu={e => { e.preventDefault(); setMenu({x: e.clientX, y: e.clientY}) }}

// ConfirmDialog API(C6):
export function ConfirmDialog(props: {
  open: boolean; title: string; description: string
  confirmLabel: string; danger?: boolean
  onConfirm: () => void; onCancel: () => void
})
// portal + backdrop 点击取消 + Escape 取消 + aria-modal + 确认按钮 danger 红色;
// 视觉对齐 maker ConfirmDialog 结构(标题/描述/取消/确认)

// EditableName(A5):
export function EditableName(props: {
  value: string; editing: boolean
  onSubmit: (next: string) => void; onCancel: () => void
})
// 进入编辑聚焦全选;Enter/Blur 提交;Esc 取消;trim 空串 → onCancel;防重复提交(committedRef)
```

- [ ] 门禁全绿(组件此阶段可暂无消费方,允许暂时从 ProjectSidebar 引一个最小挂载点或用测试覆盖,不留 unused export lint 红)
- [ ] Commit:`feat(sidebar): context menu / confirm dialog / inline rename primitives`

## Phase 4:UI 接线(B2 B4 B5 B6 B7 B8 B9 C8 C10)

**Files:**
- Create: `src/app/sidebar/CanvasRow.tsx`、`src/app/sidebar/ProjectRow.tsx`
- Modify: `src/app/ProjectSidebar.tsx`(删硬编码 projectGroups/starterCanvasIds demo 逻辑,改接 buildSidebarModel;保留 settings 区不动)
- Modify: `src/App.css`

接线清单:
- **CanvasRow**(B2/B6/B9):点击打开;双击 → inline rename;右键菜单:`重命名 / 移动到项目 ▸(项目列表 + 移到 Canvas,当前归属 disabled)/ 复制画板 / ─ / 删除(danger)`;行右侧 `<time>` 相对时间 + title 绝对时间(hover 时让位给动作按钮)
- **ProjectRow**(B4/B6/B7/B8):点击折叠/展开;双击名称 → inline rename;hover 显示 `+`(在此项目新建画板);右键菜单:`重命名 / 在此项目新建画板 / ─ / 删除项目(danger)`
- **新建项目**(B7):Projects 段头 `+` → `createProject()` 后立即进入 inline rename
- **新建画板**(B8):三入口共用 handler——Canvas 段头 `+`、顶部 Canvas 复合行 `+`(已有)、项目 hover/菜单(带 projectId);项目内创建后 `loadScene` 打开并展开该项目
- **移动**(B5):`moveCanvasToProject` 成功 → 自动展开目标项目 + toast;失败(项目不存在)→ toast error
- **删除确认**(B10 接线):删除画板 →「删除画板"{title}"?此操作不可撤销。」;删除项目 →「删除项目"{name}"?项目下 N 块画板将移回 Canvas,画板不会被删除。」;`deleteCanvas` 的「至少保留一块」保护触发时 toast 提示
- **折叠**(B13):Projects 段折叠沿用现有 state;项目节点折叠改 `useCollapsedProjects`(project.id 驱动)
- demo 场景画板(starter scenes)自然落入 standalone 区,不再特判 `starterCanvasIds`

- [ ] 手动冒烟:`npm run start:server` + `npm run dev`,过一遍:建项目→重命名→项目内建画板→画板重命名/复制/移动(双向)→删画板→删项目(级联回落)→刷新页面(持久化+折叠态保持)
- [ ] 门禁全绿
- [ ] Commit:`feat(sidebar): project & canvas management UI wiring`

## Phase 5:埋点与 verifier(B12 C14)

- [ ] 逐操作核对:成功 log、跳过 warn、失败 error;用户可感知操作补 toast(创建/重命名可仅 log,删除/移动/复制/失败必 toast)
- [ ] `scripts/verify-debug-logging.mjs` 增补 checks:**不要**机械要求 `projectsSlice.ts` 同文件 log/warn/error 三级齐全(requireLoggerLevels 会逼出假日志)——改为钉具体操作字符串:projectsSlice 至少覆盖 create/rename/delete/missing 的 log/warn;UI 层(Row 组件/ProjectSidebar)钉 `toastFeedback.success|error` 与真实 catch 分支的 `debugLogger.error`(参照现有 requireIncludes 写法)
- [ ] `npm run verify:logging` 全绿
- [ ] Commit:`chore(logging): sidebar management logging + verifier coverage`

## Phase 6:e2e(C13)+ 收口

**Files:**
- Create: `scripts/e2e/scenarios/project-sidebar.mjs`
- Modify: `scripts/e2e/scenarios/index.mjs`(注册)

场景断言(dev/prod 两套拓扑 × 双渲染器均必须过,命令见下;场景写法参照 `shell-sidebar.mjs`):
1. 新建项目 → 侧栏出现,inline rename 提交后名称更新
2. 项目内新建画板 → 画板行出现在项目组内且画布已切换
3. 画板右键 → 菜单出现在鼠标坐标;移动到项目 → 行迁移到目标组;移到 Canvas → 回落
4. 删除画板 → 确认弹窗 → 行消失;最后一块画板删除被拒 → toast
5. 删除项目 → 确认弹窗文案含画板数 → 项目消失、画板回落 standalone
6. 折叠项目 → reload → 折叠态保持;画板列表按 updatedAt 排序(新改动的画板浮顶)
- [ ] 必须实际跑通(两条命令全绿才算过,全矩阵回归留给 e2e 阶段 worker):
  ```bash
  node scripts/e2e-runner.mjs --topology=dev --renderer=both --scenario=project-sidebar
  npm run build && node scripts/e2e-runner.mjs --topology=prod --renderer=both --scenario=project-sidebar
  ```
- [ ] 全量门禁最后一遍
- [ ] Commit:`test(e2e): project sidebar management scenarios`

---

## 验收口径(后续双审/UI 兜底/终审引用)

- SC1 项目 CRUD 全链路可用且持久化(刷新不丢)
- SC2 画板右键菜单四项 + 移动子菜单行为可用;坐标弹出/disabled 态/danger 分区/菜单视觉对齐 maker;v1 子菜单为点击展开(与 maker hover 展开的差异为已接受决策)
- SC3 项目右键菜单三项,删除项目级联回落且弹窗文案明确「不删画板」
- SC4 时间标签与排序按 updatedAt 生效,selection-only 不扰动排序
- SC5 折叠态持久化(只存 collapsed)
- SC6 v9 存量数据迁移无损(画板/节点全保留,时间戳回填)
- SC7 门禁 4 命令 + e2e project-sidebar 场景全绿
- SC8 verify-logging 覆盖新操作,settings 钉死标记未破坏
