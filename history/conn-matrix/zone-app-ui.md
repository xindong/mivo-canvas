# 连接性矩阵 · 分区:外壳 UI(src/app/)

> 只读盘查产物,不改代码。范围:`src/app/` 目录的外壳 UI 功能。
> 不含 `src/store`、`src/canvas`、`src/lib`(由其他 worker 盘),但本表会标注 UI 触达的 store slice / lib client 作为"现状数据在哪"。
> 日期:2026-07-09。

## 主表

| UI 功能 | 现状数据在哪 | 迁移后连接点 | 归属 scope | 现有测试覆盖 | 迁移风险 |
|---|---|---|---|---|---|
| 项目/画布 CRUD(ProjectSidebar + ProjectSidebarControls + sidebar/ProjectRow·CanvasRow·ContextMenu) | `canvasStore` IDB 持久化,name=`mivo-canvas-demo`,`canvasPersistConfig.ts:18-39`(partialize canvases/projects/sceneId/selectedNodeId…,skipHydration)。CRUD:`projectsSlice.ts:34 createProject`/`:45 renameProject`/`:66 deleteProject`(cascade 回落 standalone);画布文档 CRUD 在 `documentSlice`/`canvasDocumentModel.ts`。纯本地,无后端。 | `/api/projects` + `/api/canvas` | document | 强:e2e `project-sidebar.mjs`(6 步:CRUD+内联改名+项目内新建+右键移动+删除 cascade+collapse/reload/updatedAt 排序);unit `projectsSlice.test.ts`/`projectSidebarModel.test.ts` | 高:100% 本地 IDB→全量搬 `/api/projects`+`/api/canvas`;`createCanvas/createProject` 同步返回 id 须改异步+乐观更新;`deleteProject` cascade 语义需后端复刻;侧栏模型 `buildSidebarModel` 纯前端派生可复用但数据源切后端 |
| 右键菜单移动归类(sidebar/ContextMenu) | `ContextMenu.tsx` 纯 UI(portal+视口钳位+子菜单点击展开 D2/v1);移动落盘走 canvasStore set `projectId`(documentSlice)。无后端。 | `/api/canvas`(PATCH projectId)/`/api/projects` move | document | 中-强:e2e `project-sidebar.mjs:137-158`(移动到项目+移回 Canvas,子菜单) | 中:移动归类从本地 set→PATCH `/api/canvas`;ContextMenu 组件本身无状态可复用 |
| 折叠状态(useCollapsedProjects) | localStorage key `mivo.sidebar.collapsedProjects`,只存折叠 project.id 数组;`useCollapsedProjects.ts:11/27`,silent fail 降级。 | `/api/user-state`(用户偏好);保留本地降级 | user | 强:unit `useCollapsedProjects.test.ts`;e2e `project-sidebar.mjs:228-282`(reload 存活) | 低-中:localStorage→user-state;离线降级语义要保留(silent fail) |
| 更新日志面板(ChangelogPanel) | `changelogStore.ts:84` fetch **`/changelog.json?t=`**(public 静态直出,非 /api);未读红点 localStorage `mivo.changelog.lastRead`(`changelogStore.ts:58`)。`ProjectSidebar.tsx:79/82` mount 时 loadChangelog。 | 不需后端(静态 JSON 保留)+ `/api/user-state`(lastRead 已读位) | document(日志本体)/user(lastRead) | 弱:无 ChangelogPanel e2e;unit 仅 `changelogDate.test.ts`(日期窗口) | 中:静态 JSON 可留;lastRead 红点 localStorage→user-state;面板轮播/键盘箭头交互零 e2e(薄弱) |
| Debug 报表页(DebugReportsPage) | `DebugReportsPage.tsx:101` fetch `resolveRemoteDebugEndpoint()`(默认 `/api/mivo/debug-logs`,`remoteDebugReporter.ts:46`),带 `x-mivo-debug-token` header;token 在 sessionStorage `mivo.debugReports.token`(`:33/75/132`)。403→token 解锁表单。 | 保持 `/api/mivo/debug-logs` | session(debug token sessionStorage;记录含 clientId/sessionId) | 中:unit `remoteDebugReporter.test.ts`;DebugReportsPage 无 e2e | 低:端点保持;token 归属 session 合理,无需搬 |
| 设置·网关 Key(GatewayKeyDialog + SettingsPanel API Keys 区) | `settingsSlice.ts:45/92/96` persist IDB name=`mivo-canvas-settings`,`strictIdbStateStorage`(永不回退 localStorage),partialize 只存 gatewayKey+mivoKey。`GatewayKeyDialog.tsx:46` POST `/api/keys/test`(BFF probe,401 不落盘)。SSO 门控:`SettingsPanel.tsx:122` isAuthenticated 才显示 API Keys。 | `/api/user-state` 或 `/api/auth` 用户档案(Key 跟随账号);`POST /api/keys/test` 保持(BFF probe) | user | 中:unit `settingsSlice.test.ts`/`keyFormat.test.ts`;弹窗交互无 e2e | 高:Key 从浏览器 IDB→服务端用户档案(安全提升但迁移复杂);SSO 门控+AutoPrompt 首登缺 key 逻辑需重新对接 |
| 设置·Mivo Key(MivoKeyDialog + MivoKeySection) | 同 `settingsSlice` IDB;`MivoKeyDialog.tsx:35` 仅 `isMivoKey` 格式校验(mivo_ 前缀+长度≥12),**无连通性测试**,首次工具调用懒验证。 | `/api/user-state`/`/api/auth` 用户档案 | user | 中:unit `settingsSlice.test.ts`/`keyFormat.test.ts` | 高:同网关 key;且无 probe→服务端要承接首次调用的懒验证 |
| 设置·SSO 账号(UserChip + SettingsPanel 账号区 + AutoPromptSettings) | `authSlice.ts` **无 persist**;`:37` hydrate 读 `/api/auth/me`(fetchMe);`:57` login 整页跳 `auth.dsworks.cn/login`;`:65` logout 跳 `/api/auth/logout`。SSO session 在 httpOnly cookie。`UserChip.tsx:36` 未登录显示 Settings 入口;`AutoPromptSettings.tsx:37` `shouldAutoPromptSettings` 决定自动弹窗区。 | `/api/auth`(保持) | session/presence(身份) | 中:unit `authClient.test.ts`/`shouldAutoPromptSettings`(纯谓词,已测);UserChip 无 e2e(stale assertion 已修);AutoPromptSettings 无 e2e | 低:`/api/auth` 保持;但 key 归属从浏览器→用户档案后,SSO 与 key 关系更紧,AutoPrompt 触发条件要复评 |
| 素材库(LibraryWorkspace) | 三源:`:334 /api/mivo/local-assets`、`:353 /api/mivo/eagle/tags`、`:372-374 /api/mivo/eagle/{status,folders,assets}`、`:405 /api/mivo/pinterest/status`(prototype/deferred,`assetLibraryModel.ts:82-85` PinterestStatus.mode='prototype')。拖到画布走 `writeLocalAssetDragPayload`。 | 保持 `/api/mivo/local-assets`+`/api/mivo/eagle`;pinterest 仍 deferred;或统一 `/api/assets` | document(素材外部源,代理) | 弱:无 LibraryWorkspace e2e/unit;`archive-assets.mjs` 测的是画布节点 `mivo-asset:` 持久化,非库 UI | 中:三源代理保持;但 drag→canvas payload 契约在画布数据上服务端后要重连;pinterest prototype 未完成 |
| Chat UI(ChatPanel + ChatComposer + ChatMessageList) | `chatStore.ts:836` persist IDB name=`mivo-chat-demo`,`:840 IDB`,`:842 partialize messagesByScene/selectedModel/paramOverrides`(isBusy 不持久化)。`ChatComposer.tsx:50/127` sendMessage→generationSlice→`/api/mivo/generate|tasks`。`ChatPanel.tsx:28` 读 sceneId。 | 消息持久化→`/api/canvas`(对话绑定画布);生图任务保持 `/api/mivo/*` | document(消息绑定 scene) | 强:unit `chatStore.test.ts`/`chatStoreMigrate.test.ts`/`chatBusyDrop.test.ts`/`chatEnhanceFlow.test.ts`/`chatMaskEditFlow.test.ts`;e2e `chat-generation.mjs`+`chat-copy.mjs` | 高:messagesByScene IDB→`/api/canvas`;`settleExpiredChatMessages` hydrate 时跑(run时状态恢复)迁移后须服务端或 hydrate 复跑;task card 状态机(running/success/error/canceled/timeout-retry)与 `/api/mivo/tasks` 轮询紧耦合 |
| useStoreHydration | `useStoreHydration.ts:30` await `canvasStore.persist.rehydrate()`+`chatStore.persist.rehydrate()`(IDB async);失败降级默认态+toast。 | 改从 `/api/canvas`+`/api/user-state` hydrate;gate 仍需 | N/A(编排) | 中:unit `canvasGenerationHydration.test.ts`/`chatStoreMigrate.test.ts`/`canvasStoreMigrate.test.ts` | 中:双 IDB rehydrate→网络 hydrate;first-paint flash/降级语义要保留 |
| ToastViewport | 纯渲染 `toastStore`(运行时,无持久化,无 fetch)。 | 不需后端 | session | 弱:无 test | 低 |
| InspectorPanel | 读 `canvasStore`(selectedNode/nodes),无独立后端。 | 随 `canvasStore`→`/api/canvas` | document | 弱:无专门 test | 低(随主迁移) |

## 测试覆盖薄弱交互(Lead 特别要求标注)

- **侧栏 drag-drop**:**功能不存在**。`grep draggable/onDragStart/onDragEnd src/app/sidebar/*` 零命中。项目/画布移动归类走**右键菜单 ContextMenu 子菜单**("移动到项目"→"移到 Canvas"),e2e `project-sidebar.mjs:137-158` 已覆盖。若迁移后引入 drag-drop 归类,需新建测试。
- **chat task card**:`chat-generation.mjs` 覆盖生图任务的 timeout 重试/中质量重试按钮/`chat-result-image` 出图(`:548-610`),覆盖中-强;但 task card 的 **running/canceled 状态切换 UI** 与 task card 卡片本体 DOM 无专门断言(只断言 result-image + error-text)。
- **collapse 同步**:`project-sidebar.mjs:228-282` 覆盖单设备 reload 存活(localStorage),中-强;但 **多设备 collapse 同步**无覆盖(现状 localStorage 单设备,迁移到 `/api/user-state` 后多设备同步是新增语义,需补测)。

## 关键发现

1. **项目/画布 CRUD 是迁移重灾区**:现状 100% 本地 IDB(`canvasPersistConfig.ts:18` name=`mivo-canvas-demo`,partialize canvases+projects),零后端;`createProject/createCanvas` 同步返回 id(`projectsSlice.ts:34`、ProjectSidebar 直接用返回值进 rename/onOpenCanvas),迁移后必须改异步+乐观更新,`deleteProject` 的 cascade 回落 standalone 语义(`projectsSlice.ts:66-100`)需后端复刻。

2. **两把 Key(sk- 网关 / mivo_)当前存浏览器 IDB**(`settingsSlice.ts:92 strictIdbStateStorage`,partialize 只存两 key,`:96`),SSO 门控后才可配(`SettingsPanel.tsx:122`)。迁移方向是 user scope 用户档案——安全提升但 AutoPromptSettings 首登缺 key 自动弹窗逻辑(`AutoPromptSettings.tsx:37` `shouldAutoPromptSettings`)需重新对接新的"用户档案有无 key"判定。网关 key 有 BFF probe(`POST /api/keys/test`),Mivo key 无 probe、首次调用懒验证(`MivoKeyDialog.tsx:35`),服务端要承接这个懒验证。

3. **更新日志数据源是静态 `/changelog.json` 不是 `/api`**(`changelogStore.ts:84`),迁移后日志本体可保持静态直出,只需把 lastRead 红点(localStorage `mivo.changelog.lastRead`)搬到 `/api/user-state`。ChangelogPanel 轮播/键盘交互零 e2e,是明确的覆盖薄弱点。

4. **Chat 消息持久化(`messagesByScene`)与生图任务链路紧耦合**:`chatStore.ts:842` 持久化消息到 IDB,但 isBusy 不持久化,hydrate 时 `settleExpiredChatMessages`(`chatStore.ts:856`)把 running 消息回落为 error/canceled。迁移到 `/api/canvas` 后这套回落逻辑须在服务端或 hydrate 侧复跑,否则跨设备会看到"卡在 running"的僵尸 task card。

5. **素材库三源已实接两源半**:local(`/api/mivo/local-assets`)、eagle(`/api/mivo/eagle/*`)已实接,pinterest 是 `mode:'prototype'` deferred(`assetLibraryModel.ts:84`)。LibraryWorkspace 本身无任何 e2e/unit 覆盖(薄弱),且 drag→canvas 的 `writeLocalAssetDragPayload` payload 契约在画布数据上服务端后要重连。
