# 功能连接性矩阵 · 总表（2026-07-09）

> 来源：三个 glm-5.2 worker 并行盘查 src/store+model / src/canvas+lib / src/app 三分区，各落一份分册（本目录 zone-*.md），lead 合成。
> 用途：回答"现有每个功能迁移后连到哪个后端 + 归属哪层 + 有没有测试保护"，作为迁移计划的 P0 发现物 —— 让"保证所有功能都能迁移/一致"从空词变成可清点清单。
> 分册详情（带 file:line）：`zone-store-model.md` / `zone-canvas-lib.md` / `zone-app-ui.md`。

## 一、总表：功能 → 后端连接点 → 归属 scope → 测试覆盖 → 风险

| # | 功能 | 现状数据在哪 | 迁移后连接点 | scope | 测试覆盖 | 风险 |
|---|---|---|---|---|---|---|
| 1 | 画布内容（节点/边） | 运行时投影，不进 persist（compactNodeForPersist 删 asset/fills/transform，只存骨架） | `/api/canvas` | document | 强（canvasStore.contract 864行） | records 扁平化+revision |
| 2 | 画布/项目结构 | IDB `mivo-canvas-demo`（partialize canvases+projects） | `/api/canvas` + `/api/projects` | document | 中（project-sidebar e2e） | CRUD 同步返 id → 改异步+乐观；deleteProject cascade 后端复刻 |
| 3 | 项目 CRUD（侧栏） | 本地 IDB，createProject/Canvas 同步返 id | `/api/projects` | document | 中 | 同步→异步、乐观更新、级联删 standalone 语义 |
| 4 | chat 消息（messagesByScene） | 独立 store `mivo-chat-demo` IDB，isBusy 不持久 | `/api/canvas`（随画布）+ 保持 `/api/mivo/*`（生图） | document | 中-强 | hydrate 的 settleExpiredChatMessages 回落须服务端复跑，否则跨设备见僵尸 running task card |
| 5 | 相机/工具偏好/最近打开/草稿 | 混在 canvasStore partialize（sceneId/activeTool/brushStyle/stampKind） | `/api/user-state` | user | 弱-间接 | 从混合 blob 里拆出来 |
| 6 | 选择态 | **双写**：顶层 selectedNodeId(s) + 文档内 canvases[scene].selectedNodeIds | 拆域后归 session（不同步）or user | session | 间接 | ⚠️ 迁移前先定单一真相源 |
| 7 | 图片资产（导入+生成） | 纯客户端 IDB `mivo-canvas-assets` 存 blob，节点存 `mivo-asset:<uuid>` 伪URL | `/api/assets`（内容寻址文件） | document 引用 | 中 | **最大迁移面**：save/resolve 全新增服务端；assetUrlLease refcount 可复用、useResolvedAssetUrl 不改 |
| 8 | 生图 generate/edit（同步） | BFF `/api/mivo/generate\|edit` | 保持 `/api/mivo/*` | — | 弱 | ⚠️ **同步路径没带 authHeaders（mivoImageClient.ts:132/173），与异步 tasks 鉴权不一致，必补** |
| 9 | 生图 tasks（异步 poll/cancel） | BFF `/api/mivo/tasks`，按 taskId 直查 | 保持 `/api/mivo/*` | — | 中 | 服务端任务 registry 须 per-user 命名空间防越权读/取消 |
| 10 | 局部重绘提交链 | 跨 4 端点 + proxy-image CORS 代理 | 保持 `/api/mivo/*` | — | 中（mask e2e 8场景） | per-user cookie 会话须穿透整条 fallback 链 |
| 11 | 两把 key（sk-/mivo_） | 浏览器 IDB strictIdb（绝不降级 localStorage） | **保持前端不迁**（与 BFF 无状态一致） | user（引用） | 中 | Mivo key 懒验证服务端要承接；首登缺 key 弹窗逻辑重接 |
| 12 | 身份/会话（SSO） | nginx 网关 cookie 同源，authClient `/api/auth/me` | `/api/auth`（已就位 #155） | user | **无（authSlice 零测试，最高风险）** | 401 markUnauthenticated / 登录跳转全裸奔 |
| 13 | 更新日志 | 静态 `/changelog.json`（本体）+ localStorage（lastRead 红点） | 本体留静态；lastRead → `/api/user-state` | user | 弱（轮播/键盘零 e2e） | 仅红点搬 user-state |
| 14 | debug log | remoteDebugReporter → `/api/mivo/debug-logs` | 保持 `/api/mivo/*` | — | 中 | per-user 可选 |
| 15 | 素材库 LibraryWorkspace | local+eagle 实接、pinterest prototype | **deferred**（A3：总线只做服务端源） | — | **无（零 e2e/unit）** | 本机源 web 部署失效，已决策延后 |

## 二、迁移主接线点（三分区交叉印证，高可信）

`persistIdbStorage.ts:129-135 syncToServer` 是**空实现的预留接线点**（注释标 P4c 改 POST）。state 层和 io 层两个 worker 独立都指到它——迁移 = 把它改成按 persist name 路由到 `/api/canvas`/`/api/projects`/`/api/user-state`，IDB 退为离线缓存，服务端 authoritative merge on rehydrate。**这是整个服务端化的物理入口。**

## 三、盘查带出的新前置项（补进任务板）

**新增 P0 决策项（迁移前必须先拍，否则灌债/返工）：**
- **DP-1 选择态单一真相源**：顶层 vs 文档内双写，迁移前定一处（建议归 session、不双写）。
- **DP-2 anchorModel 实验字段**：P2-D1 EXPERIMENTAL，roadmap §9 P4-a 要求 formal 化或删——迁移前决定，别把实验字段灌进服务端文档。
- **DP-3 chat 删画布不级联清对话**：messagesByScene 用 sceneId 作 key，删画布不清 → 服务端要定级联/软删语义（呼应软删任务 T1.10）。

**新增 P0 表征测试目标（零测试且在迁移链上，最高优先）：**
- authSlice（SSO 登录/登出/hydrate/401，**完全无测试**）——两个分区都点名，鉴权链路整体测试薄。
- LibraryWorkspace、ChangelogPanel 交互（零 e2e）——若这些功能要保行为一致，先补表征测试。

**新增 P1 修复项（迁移当天会撞）：**
- FX-1 同步 generate/edit 补 authHeaders（mivoImageClient.ts:132/173）——鉴权不一致。
- FX-2 生图 tasks registry per-user 命名空间——防越权读/取消。
- FX-3 chat hydrate 的僵尸 task card 回落逻辑服务端复跑——否则跨设备见卡死的 running 卡片。

## 四、明确不迁 / 保持现状（避免过度迁移）

- 两把 key：留前端 strictIdb（BFF 无状态原则）。
- 更新日志本体：留静态 changelog.json。
- 生图/mask/debug 端点：保持现有 `/api/mivo/*`，只做 per-user 会话穿透。
- 素材库本机源（local/eagle）：deferred（A3 已决策）。
