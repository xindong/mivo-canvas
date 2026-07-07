# Maker 项目目录管理 → MivoCanvas 复刻:调研档案 + Lead 映射评估

> 生成:2026-07-06。来源:2 个 GPT-5.5 high 只读调研 worker(research-ui / research-data)+ Lead(Fable)对 mivo 现状摸底。
> maker 仓:/Users/praise/AI-Agent/Claude/projects/Project XDMaker
> mivo 仓:/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas

## A. maker 侧调研结论(UI 层,research-ui)

### 组件层级
CCAgentSidebarUpper → ExpandedView → { PinnedSection / ProjectsSection / DialogueSection } 
ProjectsSection → UnclassifiedSection + SortableList<ProjectNode> → ProjectNode → ProjectSessionEntryList → SessionItem
DialogueSection → SessionEntryList → SessionItem

### 关键文件(maker 仓相对路径)
- apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx —— 父装配:数据筛选、分组、全部动作回调(handleCreateProject:1131 / handleCreateDialogue:1144 / handleMoveSession:1307 / handleRename:1246 / handleTogglePin:1282 / handleArchiveAllInProject:1708)
- sidebar/sections/ProjectsSection.tsx —— 项目段(段头 + 新建项目按钮:301;项目列表溢出「显示全部 N 项」:222,383;拖拽排序:156-188)
- sidebar/sections/ProjectNode.tsx —— 项目节点(右键菜单:346;inline rename:136-161;hover「在此目录新建会话」SquarePen:329;子会话列表:453)
- sidebar/sections/DialogueSection.tsx —— 对话段(排序菜单 recency/time/title:46-126;新对话:223;「最多 N 条+显示全部」:241)
- sidebar/SessionItem.tsx —— 会话行(右键菜单三变体:816/844/864;双击重命名:313;hover Archive 4s 行内 Confirm 胶囊:712-772;时间标签:174,699)
- sidebar/SessionProjectMoveSubmenu.tsx —— 「移动到项目」子菜单(项目列表/选择项目文件夹/移到对话:33-87)
- lib/projectGrouping.ts —— 分组算法(groupSessions:375;pinned 先抽走:384;dialogue 判定:405;unclassified 判定:410-418;项目内排序 status→sortTime desc:324-329;latestActivityAt:510-520)
- lib/sidebarProjectSorting.ts —— 项目排序(time/alphabetic/manual/default:24-58)
- lib/formatSidebarTime.ts:31-67 —— 相对时间标签(刚刚/N 分钟/小时/天/周/月/年)
- components/ui/dropdown-menu.tsx —— Radix DropdownMenu 包装
- components/ui/confirm-dialog.tsx —— Radix AlertDialog 包装
- sidebar/menuStyles.ts —— 菜单统一 class 常量
- components/sidebar/SortableList.tsx —— SortableJS 薄包装(仅用于项目排序/置顶排序,不用于会话归类)
- hooks/useCollapsedProjects.ts —— 折叠持久化(localStorage key cc-agent.sidebar.collapsedProjects,只存 collapsed)

### 右键菜单实现模式
无原生 context menu、无独立 ContextMenu 组件:controlled Radix DropdownMenu + fixed 0×0 隐形 trigger 锚定鼠标坐标(ProjectNode.tsx:346, SessionItem.tsx:789)。

### 项目右键菜单项全集
重命名项目 / 搜索会话 / [本地] 查看文件 / [本地] 在文件管理器中打开 / [本地] 复制深度链接 / [本地] 同步此项目的 Codex 会话 / 全部归档(ConfirmDialog 二次确认)。
**没有「删除项目」「移动项目」。** 新建项目在段头 + 按钮,不在右键菜单。

### 会话右键菜单三变体
- archived:重命名 / 取消归档 / [可选]导出会话 / 复制对话链接 / 删除
- draft/空:重命名 / 复制对话链接 / 删除
- 标准:置顶(取消置顶) / 重命名 / [可选]移动到项目(子菜单) / 复制对话链接 / 在新窗口打开 / [可选]导出会话 / 归档 / 删除
- 删除/归档走 ConfirmDialog;hover Archive 是 4s 行内 Confirm 胶囊(无弹窗);unarchive 无确认

### 归类交互
无拖拽归类。右键 →「移动到项目」→ 子菜单(最近项目列表 / 选择项目文件夹 / 移到对话)。拖拽仅用于项目间排序(拖动后自动切 manual 排序并持久化)。

## B. maker 侧调研结论(数据层,research-data)

### 核心模型
「项目」不是一等实体!由 `sessions.workspaceKind='project' + sessions.workingDir` 派生分组:
- SQLite sessions 表(main/localDb/schema.ts:17):id/title/workingDir/workspaceKind('project'|'dialogue')/status('active'|'archived'|'deleted')/pinnedAt/userSendAt/updatedAt
- ProjectNode 是派生类型(projectGrouping.ts:73):projectKey/scope/workingDir/displayName/sessions/latestActivityAt
- projectKey = normalize(workingDir) 前缀 local:/remote:/device:(shared/projectKeys.ts)
- 项目显示名 = 独立 alias 表 project_aliases(projectKey, alias)(schema.ts:658)
- 最近项目 = recent_workdirs 表;手动排序 = renderer localStorage

### CRUD 链路
- 「新建项目」不建 project row:选目录 → patchNewMakerDraft({workingDir}) → /cc-agent/new → 首条消息时 createSession({workingDir, workspaceKind:'project'})
- 重命名项目 = 写 alias 表(不改路径):useProjectAliases.updateAlias → IPC → project_aliases upsert
- **无删除项目**;只有「全部归档」= 逐个 session setStatus('archived')
- 会话移动 = patch {workingDir, workspaceKind:'project'} 或 {workspaceKind:'dialogue'};乐观 patchLocal → sessionService.update → IPC → DB → 广播
- 删除会话 = 软删除(status='deleted' 墓碑),list 默认过滤
- 排序时间轴 = userSendAt ?? updatedAt(userSendAt 只在用户发消息时 bump,不被元数据污染)
- 状态管理 = 模块级 singleton store + subscribe(非 zustand/redux)

## C. mivo 现状(Lead 摸底)

- src/app/ProjectSidebar.tsx(17.9K):已有 Projects/Canvases 两段 UI 骨架,但 projectGroups 是**硬编码 demo 常量**(64-75 行),「New project」按钮空壳(332),无右键菜单,无重命名/删除/移动交互
- 数据层已有:CanvasDocument.projectId?: string(types/mivoCanvas.ts:428);documentSlice.ts:createCanvas(title,{projectId,templateId}) / duplicateCanvas / deleteCanvas(带「至少保留一块画板」保护)/ renameCanvas
- CanvasDocument **无任何时间戳字段**(无 createdAt/updatedAt)→ 时间标签和最近排序需要加字段+迁移
- 持久化:zustand persist v9 + IndexedDB(canvasPersistConfig.ts,有 migrate 链 canvasStoreMigrate)
- 无项目实体 store、无项目 CRUD
- 依赖面:**无 Radix、无 sortablejs、无 tailwind**;UI 全部 plain CSS class(App.css);已有 portal 弹层模式(debug-log panel、settings-menu)
- e2e:Playwright scripts/e2e-smoke.mjs,双拓扑(dev+prod)×双渲染器(dom+leafer)
- CI:main 分支保护,PR + 6 项 CI + trunk-guard(review thread 必须 resolve)
- 项目 invariant:所有用户可见操作必须 debugLogger 记日志,需要即时反馈的用 toastFeedback(docs/development-logging.md)
- **注意:当前工作树 feat/leafer-stamp-native-fx 有另一 feature 的未提交改动,本复刻执行必须开独立分支/工作树,从 main 拉**

## D. Lead 映射评估(已定决策,清单需遵循)

概念映射:
| maker | mivo |
|---|---|
| session | canvas(CanvasDocument) |
| project(workingDir 派生) | project(一等实体,新建 projectsSlice) |
| DialogueSection(对话) | 「Canvas」区 = projectId 为空的画板 |
| workspaceKind='dialogue' | canvas.projectId === undefined |
| 移动到项目 patch workingDir | 移动到项目 patch canvas.projectId |
| alias 表 | project.name 直接存实体上(无需 alias 间接层) |

架构决策(D1-D8):
- D1 项目为一等实体:projects: Array<{id, name, createdAt}> 存 canvasStore 新 slice(或独立 slice 文件),持久化随 canvas persist v9→v10 迁移;理由:mivo 无 workingDir 概念,canvas.projectId 已存在
- D2 右键菜单自研轻量 ContextMenu(portal + 鼠标坐标定位 + Escape/点外关闭),不引 Radix;视觉对齐 maker menuStyles(暗色圆角面板)
- D3 v1 不引 sortablejs,不做拖拽排序;项目排序 = latestActivityAt 倒序(maker default 模式);后续可加
- D4 时间标签:CanvasDocument 增加 updatedAt(内容变更时 bump)+ 移植 formatSidebarTime 逻辑(纯函数,近似直接拷贝,i18n 简化为中文/英文按现 UI 语言)
- D5 不复刻(maker 特有/超范围):查看文件、文件管理器、深链、同步 Codex、远程/device-link、机器切换、vendor 过滤、自动化分组、多选批量、导出会话、在新窗口打开、archive 状态机(mivo 画板无 status;v1 只有删除,不做归档/置顶——**置顶和归档是否进 v1 由清单 worker 给出建议,Lead 终审**)
- D6 画板右键菜单(标准变体):重命名 / 移动到项目(子菜单:项目列表 + 「移到 Canvas」)/ 复制画板 / 删除(确认弹窗;沿用「至少保留一块」保护)
- D7 项目右键菜单:重命名(inline,对齐 maker)/ 在此项目新建画板(对齐 maker hover SquarePen + 菜单双入口可选)/ 删除项目(**maker 没有但 mivo 必须有**,因项目是真实实体;级联 = 其下画板回落为 standalone,需确认弹窗;菜单风格对齐 maker)
- D8 新建项目:段头 + 按钮 → 直接建实体(inline 命名或默认名+立即 rename),无 maker 的选目录步骤

交互保真目标(UI 兜底阶段验收基准):
- 分组结构:Projects 段(可折叠,项目节点可折叠)+ Canvas 段,折叠态持久化(localStorage,只存 collapsed,对齐 useCollapsedProjects)
- 右键菜单出现在鼠标坐标,菜单项 hover 样式/分隔线对齐 maker
- inline rename:双击或菜单触发,Enter/Blur 提交,Esc 取消
- 时间标签:行右侧相对时间,title 为绝对时间
- 删除类操作确认弹窗(标题/描述/取消/确认红色按钮,对齐 maker ConfirmDialog 结构)
- 所有操作按 mivo invariant 打 debugLogger + toastFeedback
