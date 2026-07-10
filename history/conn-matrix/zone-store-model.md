# 功能连接性矩阵 · 分区:状态/文档数据层 (src/store + src/model)

> 盘查范围:`src/store/` + `src/model/`(含 `src/lib/persistIdbStorage.ts` —— 它是 store 持久化的物理落点,虽在 lib/ 但归本分区)。
> 不含:src/canvas、src/lib(除 persistIdbStorage)、src/app(别的 worker 在盘)。
> 迁移后连接点术语:`/api/canvas`(画布文档:节点/边) | `/api/projects`(项目结构 CRUD) | `/api/user-state`(相机/工具偏好/最近打开/草稿) | `/api/assets`(图片) | 现有 BFF 生图端点 `/api/mivo/*` | `/api/auth`(身份) | 不需后端(纯前端瞬态)。
> 归属 scope:document / user / session / presence。
> 证据格式:`file:line`。本盘查为只读,未改任何文件。

---

## 0. 持久化拓扑速览

| store | persist name | 存储介质 | version | skipHydration | 落点文件 |
|------|-------------|---------|---------|---------------|---------|
| `useCanvasStore` | `mivo-canvas-demo` | IDB(`idbStateStorage`,降级 localStorage) | 10 | true | `canvasPersistConfig.ts:18-39` |
| `useChatStore`(chat) | `mivo-chat-demo` | IDB(`idbStateStorage`) | 2 | true | `chatStore.ts:835-873` |
| `useSettingsStore` | `mivo-canvas-settings` | IDB(`strictIdbStateStorage`,**绝不**降级 localStorage) | 1 | 否(自带 onRehydrate) | `settingsSlice.ts:47-105` |
| `useAuthStore` | —(无 persist) | 进程内存,每次 hydrate 读 `/api/auth/me` | — | — | `authSlice.ts:31-75` |
| `useCameraFocusStore` | —(无 persist) | 进程内存,瞬态 | — | — | `cameraFocusStore.ts:27-51` |
| `useChangelogStore` | —(无 persist) | 进程内存 + `localStorage` 存 `lastRead` 一项 | — | — | `changelogStore.ts:77-118` |
| `useDebugLogStore` | —(无 persist) | 进程内存环形缓冲 | — | — | `debugLogStore.ts:37` |
| `useToastStore` | —(无 persist) | 进程内存 | — | — | `toastStore.ts:28` |

IDB 物理库:`mivo-canvas-persist` / store `kv` / `{key,value}` 记录(`persistIdbStorage.ts:28-33`)。`setItem` 写 IDB 后留有 `syncToServer` 空实现作为 **P4c 服务端持久化接线点**(`persistIdbStorage.ts:129-135`),当前 fire-and-forget 未接服务端 —— 这是本分区迁移的主入口。

---

## 1. 核心矩阵

| 状态/切片/字段 | 现状存哪 | 迁移后连接点 | 归属 scope | 现有测试覆盖 | 迁移风险/耦合点 |
|---------------|---------|-------------|-----------|-------------|----------------|
| **useCanvasStore** 组合 store(6 slice 装配:`projects+document+nodeMutation+nodeCreation+generation+selection`) | IDB `mivo-canvas-demo` v10,partialize 见下行 | 拆分见各行 | document+user+session 混 | 强(`canvasStore.contract.test.ts` 33.8K + `canvasStoreMigrate.test.ts` 24.1K) | **文档域+用户域+会话域混在同一 store 同一 partialize blob**(`canvasStore.ts:77-89`)。迁移要拆 store 才能分别路由到 `/api/canvas` vs `/api/user-state` | 
| └ `canvases: Record<CanvasId, CanvasDocument>` | partialize 持久化(`canvasPersistConfig.ts:30` → `compactCanvasesForPersist` `canvasDocumentModel.ts:100-103`);运行时 `nodes/edges/tasks` 是活跃 scene 的投影(`documentSlice.ts:42-44,60-69`) | `/api/canvas`(节点/边/任务文档体) | document | 强(`canvasDocumentModel.test.ts` 29.2K + `documentModelV2.test.ts` 13.7K) | 单文档 10k+ 节点超 localStorage 5MB 是迁 IDB 的根因(`canvasPersistConfig.ts:21-23`)。`compactNodeForPersist` 删 `asset/fills/relations/strokes/transform`(`canvasDocumentModel.ts:76-91`)—— **资产引用与渲染样式不入文档 persist,迁移时需确认 `/api/canvas` 只存文档骨架、资产走 `/api/assets`** |
| └ `projects: CanvasProject[]` | partialize 持久化(`canvasPersistConfig.ts:31`);seed `DEMO_PROJECTS`(`projectsSlice.ts:33`) | `/api/projects`(项目结构 CRUD) | document | 强(`projectsSlice.test.ts` 10K) | 删 project 级联把 canvas `projectId` 回落 undefined,**canvas 体不删**(`projectsSlice.ts:66-100`)—— 迁移后 `/api/projects` DELETE 要保持同样的级联语义,否则数据不一致 |
| └ `sceneId: CanvasId`(当前活跃画布) | partialize 持久化(`canvasPersistConfig.ts:32`) | `/api/user-state`(最近打开/活跃画布指针) | user | 中(随 contract test) | 文档体(document scope)与"当前打开哪个"(user scope)被同一 partialize 持久化 —— 迁移需把 `sceneId` 从 `/api/canvas` 文档里拆出,归 user-state |
| └ `selectedNodeId` / `selectedNodeIds` | partialize 持久化(`canvasPersistConfig.ts:33-34`);另在 `canvases[sceneId].selectedNode(s)` 也有副本(`canvasDocumentModel.ts:97`) | `/api/user-state`(选择态)或 不需后端(纯前端瞬态,取决于是否跨设备同步) | session/user | 弱(无 selectionSlice 专属 test,随 contract) | **选择态被存了两份**:顶层 `selectedNodeId(s)` + 文档内 `canvases[scene].selectedNodeIds`(`canvasDocumentModel.ts:97`)。迁移前要先定单一真相源,否则双写 |
| └ `activeTool` / `brushStyle` / `activeStampKind` | partialize 持久化(`canvasPersistConfig.ts:35-37`) | `/api/user-state`(工具/笔刷偏好) | user | 中(随 contract test) | 纯用户偏好,与文档无关却混在文档 store —— 迁移时归 user-state 最自然 |
| └ `nodes` / `edges` / `tasks`(活跃 scene 运行时投影) | **不直接 partialize**;由 `canvases[sceneId]` 文档 hydrate(`documentSlice.ts:42-44,162-174`) | 随 `/api/canvas` 文档体 | document | 中(随 contract) | `tasks` 含生图任务态,hydration 时 `settleExpiredCanvasGenerations` 把 `running` 任务标 `failed`(`canvasGenerationHydration.ts:241`)—— 迁移后服务端需重放此 settle 语义,否则跨设备看到僵尸 running |
| └ `historyPast` / `historyFuture`(undo/redo 栈) | **不持久化**(`documentSlice.ts:44-45,67-68`),进程内存 | 不需后端(纯前端瞬态) | session | 中(`historyManager.test.ts` 8.6K) | 快照体积大,若迁后端做协作会爆炸;当前正确地不持久化,保持 |
| └ `clipboardNodes` / `clipboardAssets` / `lastPlacedStampId` | **不持久化**(`canvasStateTypes.ts:75-80`) | 不需后端 | session | 弱(随 contract) | 瞬态,迁移无风险 |
| **generationSlice** 生成动作(不改 store 形状,改 `canvases[scene].tasks` + nodes/edges) | 任务态写入 `canvases` 文档(随 persist);in-flight `running` 态靠 hydration settle | 生图请求走现有 BFF `/api/mivo/*`;任务元数据随 `/api/canvas` 文档 | document+session | 强(`generation.contract.test.ts` 29.2K + `generationFacade.test.ts` 9.7K) | **生图任务元数据(timing/stage/progress)随文档 persist,但实际生图走 BFF**。迁移后若 `/api/canvas` 存任务态,需与 BFF `/api/mivo/*` 的 job 状态机对齐(`server/platform` 已有 job 轮询),否则双源 |
| **nodeCreationSlice / nodeMutationSlice / nodeFactory** | 节点 CRUD 作用于 `canvases[scene].nodes` | 随 `/api/canvas` | document | 强(`nodeFactory.test.ts` 18.8K) | 纯领域操作,迁移随文档体一起走,无独立风险 |
| **useChatStore** `messagesByScene` | IDB `mivo-chat-demo` v2 partialize(`chatStore.ts:842-843`) | 现有 BFF `/api/mivo/*`(对话历史)或 `/api/canvas` 附挂 | session/document | 强(`chatStore.test.ts` 23.2K + `chatStoreMigrate.test.ts` 12.1K + `chatMaskEditFlow.test.ts` 30.9K + `chatEnhanceFlow.test.ts` + `chatBusyDrop.test.ts`) | **对话域独立 store,与文档 store 分离**(好)。但 `messagesByScene` 用 sceneId 作 key —— sceneId 即 canvasId,迁移后对话与画布文档强耦合,删画布要级联清对话,当前无此级联(`documentSlice.ts:136-160` 删 canvas 不清 chat) |
| useChatStore `selectedModel` / `paramOverrides` | IDB partialize(`chatStore.ts:844-845`) | `/api/user-state`(模型/参数偏好) | user | 强(同上) | 模型选择是用户偏好,却跟对话消息混在同一 persist blob —— 迁移时拆 user-state |
| useChatStore `isBusy` | **不持久化**(partialize 注释排除,`chatStore.ts:846`;merge 强制 `isBusy:false` `chatStore.ts:854`) | 不需后端 | session | 中(`chatBusyDrop.test.ts`) | 正确不持久化,迁移无风险 |
| useChatStore `migrate`/`merge` | hydration 时 v0→v2 迁移 + 过期消息 settle(`chatStore.ts:848-872`,`chatStoreMigrate.ts:60-65`) | — | — | 强(`chatStoreMigrate.test.ts`) | 迁移到服务端后,版本迁移逻辑要从 client 迁到 server-side rehydrate,否则离线缓存与权威源版本不一致 |
| **useSettingsStore** `gatewayKey` / `mivoKey` | IDB `strictIdbStateStorage`(绝不降级 localStorage,`settingsSlice.ts:91-92,96`) | `/api/auth`(身份/凭据)—— 或保持前端 secrets 不上服务端 | session(凭据) | 中(`settingsSlice.test.ts` 8.5K) | **secrets 走 strict IDB 是安全设计**(注释明确反对 localStorage,`persistIdbStorage.ts:207-218`)。迁移到服务端存 key 与"网关 BFF 无状态"原则冲突(`settingsSlice.ts:4-5`),建议保持前端,服务端只做 probe `/api/keys/test` |
| useSettingsStore `panelOpen`/`panelSection`/`autoPromptedThisSession`/`_hydrated` | **不持久化**(partialize 只存两 key,`settingsSlice.ts:96`) | 不需后端 | session | 中 | 正确不持久化,reload 重置 |
| **useAuthStore** `user`/`status` | **无 persist**,每次启动 `hydrate()` 读 `GET /api/auth/me`(`authSlice.ts:31-52`) | `/api/auth`(身份) | session | **无**(无 authSlice.test.ts) | 已是服务端权威(网关 httpOnly cookie),迁移无需改 —— **但零测试保护是风险**,login/logout 跳转逻辑无回归门 |
| **useCameraFocusStore** `pendingFocus` | **无 persist**,瞬态(`cameraFocusStore.ts:1-4,27-51`) | 不需后端 | session | 中(`cameraFocusStore.test.ts` 2.5K) | 瞬态,迁移无风险 |
| **useChangelogStore** `entries`/`updatedAt`/`loaded` | 进程内存,`fetch('/changelog.json')`(`changelogStore.ts:82-107`);`lastRead` 存 `localStorage`(`mivo.changelog.lastRead`,`changelogStore.ts:58-66,108-117`) | 不需后端(静态资源 + 本地已读戳) | user | **无**(无 changelogStore.test.ts) | `lastRead` 是唯一走 localStorage 的状态,迁移时归 `/api/user-state`(已读时间戳),但价值低,可保持前端 |
| **useDebugLogStore** 日志环缓冲 | 进程内存(`debugLogStore.ts:37`);`remoteDebugReporter` 异步 POST `/api/mivo/debug-logs`(`remoteDebugReporter.ts:46,136-144`) | 现有 BFF `/api/mivo/debug-logs` | session | 中(`remoteDebugReporter.test.ts` 3.2K) | 已接服务端(fire-and-forget + localStorage 队列 `remoteDebugReporter.ts:106`),迁移无额外工作 |
| **useToastStore** | 进程内存,无 persist(`toastStore.ts:28`) | 不需后端 | session | **无**(无 toastStore.test.ts) | 瞬态,迁移无风险,但零测试 |
| **src/model/documentModelV2** 纯领域模型(cloneNodeV2/normalize/setTransform/setFills...) | 纯函数,无状态(`documentModelV2.ts:271-376`) | 随 `/api/canvas` 文档体(被 nodeFactory 调用) | document | 强(`documentModelV2.test.ts` 13.7K) | 纯逻辑,迁移随文档层 |
| **src/model/anchorModel** 实验性锚点(`experimentalAnchors` on node) | 节点字段,随 `canvases` persist(`anchorModel.ts:119`) | 随 `/api/canvas`;或独立 `/api/canvas/anchors` 若转 formal | document | 强(`anchorModel.test.ts` 8.1K) | **P2-D1 EXPERIMENTAL**,路线图 §9 P4-a 要求"收编为 formal CanvasAnchor 或删除字段"(`canvasStateTypes.ts:249-250`)。迁移前必须先做此决策,否则把实验字段灌进服务端文档会成技术债 |
| **src/model/canvasSnapshotModel** 快照归一化 | 纯函数(`canvasSnapshotModel.ts:28`) | 不需后端(undo/redo 瞬态) | session | 中(`canvasSnapshotModel.test.ts` 2.9K) | 随 history 栈,不持久化 |
| **src/model/aiCanvasCommands** AI 结果节点构造 | 纯函数(`aiCanvasCommands.ts:33`) | 随 `/api/canvas` 文档体 | document | 中(`aiCanvasCommands.test.ts` 2.8K) | 纯逻辑 |
| **canvasGenerationHydration / chatGenerationHydration** 版本迁移 + 过期 settle | 纯函数,在 persist `migrate`/`merge` 调用(`canvasGenerationHydration.ts:27,67,283-311`) | — | — | 强(`canvasStoreMigrate.test.ts` + `canvasGenerationHydration.test.ts` 6.2K) | 迁移服务端后,client 迁移逻辑变"离线缓存 rehydrate",服务端要做权威版本对齐 |
| **persistIdbStorage** `idbStateStorage` / `strictIdbStateStorage` / `syncToServer`(空) | IDB KV,`setItem` 后 `syncToServer` 空实现(`persistIdbStorage.ts:129-135,141-205`) | **P4c 接线点** → 改 `syncToServer(name,value)` 推 `/api/canvas` 等 | — | 中(`src/lib/persistIdbStorage.test.ts`) | **迁移主入口已预留**:注释放注释写明"IDB 退为离线缓存层(offline-first),server-authoritative merge on rehydrate"。但当前 `setItem` 写 IDB 后未调 `syncToServer`(line 182 注释掉了 `void syncToServer`) |
| **canvasPersistConfig** partialize 配置 | 见 §2 详 | — | — | 弱(无专属 test,随 contract) | partialize 列表是迁移拆分的唯一改动点,改它要同步改 hydration merge |

---

## 2. 重点①:persist partialize 到底存了哪些字段(canvasPersistConfig)

`canvasPersistConfig.ts:29-38` —— `useCanvasStore` 的 partialize 白名单(只这 8 个字段进 IDB):

```ts
partialize: (state: CanvasState) => ({
  canvases: compactCanvasesForPersist(state.canvases),  // 文档体(含每文档 nodes/edges/tasks/title/projectId/updatedAt/selectedNodeIds)
  projects: state.projects,                              // 项目结构
  sceneId: state.sceneId,                                // 当前活跃画布
  selectedNodeId: state.selectedNodeId,                   // 顶层选择(主)
  selectedNodeIds: state.selectedNodeIds,                 // 顶层选择(集)
  activeTool: state.activeTool,                           // 工具偏好
  brushStyle: state.brushStyle,                           // 笔刷偏好
  activeStampKind: state.activeStampKind,                 // stamp 种类偏好
})
```

**不进 persist 的 CanvasState 字段**(运行时/瞬态,`canvasStateTypes.ts:65-82`):
`nodes` / `edges` / `tasks`(活跃 scene 投影,由 canvases hydrate) / `clipboardNodes` / `clipboardAssets` / `lastPlacedStampId` / `historyPast` / `historyFuture`。

**chatStore partialize**(`chatStore.ts:842-847`):`messagesByScene` / `selectedModel` / `paramOverrides`(`isBusy` 排除)。

**settingsSlice partialize**(`settingsSlice.ts:96`):只 `gatewayKey` / `mivoKey`(UI 态全排除)。

---

## 3. 重点②:文档域和会话域是否混在同一 store

**是,严重混合。** `useCanvasStore`(`canvasStore.ts:77-89`)是 6 slice 装配的单 store,同一 partialize blob 同时存:

| scope | 字段 | 迁移后应去的连接点 |
|-------|------|-------------------|
| document | `canvases`(nodes/edges/tasks/title/projectId/updatedAt) | `/api/canvas` |
| document | `projects` | `/api/projects` |
| user | `sceneId`(最近打开) | `/api/user-state` |
| session/user | `selectedNodeId(s)` | `/api/user-state` 或 不需后端 |
| user | `activeTool`/`brushStyle`/`activeStampKind` | `/api/user-state` |

→ 迁移时不能把整个 `mivo-canvas-demo` blob 原样推到单一端点,必须按 scope 拆分:`canvases`→`/api/canvas`,`projects`→`/api/projects`,其余 user/session 偏好→`/api/user-state`。

**对话域(chatStore)是独立 store,未混入** —— 这是好的分离(`chatStore.ts:171-875`)。但 `messagesByScene` 用 `sceneId`(=canvasId)作 key,与画布文档隐式耦合,删画布时对话不级联清(见 §4 风险)。

**选择态双写**:顶层 `selectedNodeId(s)` 与文档内 `canvases[scene].selectedNodeIds` 各存一份(`canvasDocumentModel.ts:97`),partialize 两个都存 —— 迁移前必须先定单一真相源。

---

## 4. 重点③:哪些状态现在没测试保护

**零测试(None)**:
- `authSlice.ts` —— 登录/登出/hydrate 跳转逻辑无任何 test 文件。**最高风险**:身份态无回归门,SSO 跳转 redirect 参数、401 markUnauthenticated 幂等都没保护。
- `changelogStore.ts` —— `lastRead` localStorage 读写、`normalizeEntry` 兼容性无 test。
- `toastStore.ts` —— 无 test。
- `debugLogStore.ts` —— 无 test(但 `remoteDebugReporter` 有中覆盖)。
- `canvasPersistConfig.ts` —— 无专属 test(partialize 白名单改动无直接门,靠 contract test 间接)。
- `selectionSlice` / `documentSlice` / `nodeMutationSlice` / `nodeCreationSlice` —— 无专属 test,**靠 `canvasStore.contract.test.ts` 间接覆盖**(中)。
- `maskEditTaskRuntime` / `canvasGenerationCancel` —— 无专属 test。

**弱/中覆盖**(有 test 但薄):`cameraFocusStore`(2.5K)、`canvasSnapshotModel`(2.9K)、`aiCanvasCommands`(2.8K)、`aiCanvasWorkflow`(3.8K)、`persistIdbStorage`(在 lib,有专属 test)。

**强覆盖**:`canvasStore` 契约 + migrate、`canvasDocumentModel`、`documentModelV2`、`anchorModel`、`projectsSlice`、`generationSlice`(contract+facade)、`nodeFactory`、`historyManager`、`chatStore` 全家、`settingsSlice`。

---

## 5. 迁移主入口结论

1. **`persistIdbStorage.syncToServer` 是预留的 P4c 接线点**(`persistIdbStorage.ts:129-135`),当前空实现,`setItem` 写 IDB 后未调用(line 182 注释掉了)。迁移 = 把 `syncToServer(name,value)` 改成按 `name` 路由到 `/api/canvas` / `/api/projects` / `/api/user-state`,IDB 退为离线缓存,服务端 authoritative merge on rehydrate。
2. **拆 store 是迁移前置**:文档域(canvases/projects)与用户域(sceneId/tool/brush/selection)目前混在同一 partialize,要先拆分才能分别路由。
3. **assets 不在文档 persist**:`compactNodeForPersist` 删 asset/fills/strokes/transform —— 文档只存骨架,资产走 `/api/assets`,迁移时要保持此分离。
4. **实验字段 anchorModel 要先决策**(`canvasStateTypes.ts:249-250`):formal 化还是删除,否则会把实验字段灌进服务端。
5. **authSlice 零测试是最大风险点**,迁移前应补 SSO 跳转 + hydrate 回归测试。
