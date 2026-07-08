# MivoCanvas 后端改造决策架构（含持久化 / DB 选型）（2026-07-08，草案 v1）

> 状态：**草案，供团队商议**。本仓库多人协作、本提案提出者非 owner —— 文档里除【已定】外的项，**均为待团队/owner 共同商议决定的提案，不代表已拍板**。这是后端改造的**收敛真相源**——把此前散在多处的落档统一成一份权威后端设计，补齐"现状→目标"路径上未定的工程决策。由 `persistence-db-selection` 扩写而来（DB 选型是 §4）。
> 上游真相源（不与之冲突，只细化后端面）：
> - `platform-architecture-2026-07-07.md`（§13 近期落地架构 + §13.5 共享/归属模型，owner 已拍板）— 团队共享草稿，暂未入库
> - `arch-migration-execution-plan.md`（M0–M4 绞杀者迁移）— 团队共享草稿，暂未入库
> - `docs/decisions/p4-schema-spike.md`（**已提交**：Version 粒度、chat 服务端化、投影字段、mivoserver 映射边界）
> 标注约定：【已定】= 上游 owner 文档（platform-architecture / p4-schema-spike）已拍板、可溯源；【建议】= 本文推荐、待团队定；【未决】= 待团队/owner 拍板。**除【已定】外都要团队商议。**

---

## 0. 一句话

后端要从**"无状态 AI 代理 BFF"**改造成**"有持久化、有 per-user 鉴权、有权限、CRDT-ready 的服务端底座"**，用绞杀者模式小步进 main、每步开关可回滚。四条线（持久化+DB / 鉴权+权限 / 编排上移 / 内存态→共享存储）一次立档、分期落地。数据库选 **PostgreSQL**（§4）。

---

## 1. 后端现状基线（改造起点，已核实）

| 维度 | 现状 | 证据 |
|---|---|---|
| 形态 | Hono + @hono/node-server 单进程，同源托管 `dist/` + `/api/mivo/*` | `server/index.ts` `server/app.ts` |
| 本质 | **无状态代理**：generate/edit/enhance/describe-region → 平台通道(aigc.xindong.com) + llm-proxy，submit→poll→download 异步轮询 | `server/routes/*` `server/platform/job.ts` |
| 数据库 | **无**。不存任何业务数据；画布全在浏览器 IndexedDB(persist v9) | `server/` 无 DB 依赖；`src/lib/persistIdbStorage.ts` |
| 服务端状态 | 仅内存 token/session 缓存(单飞)，单进程、重启即失 | `server/platform/state.ts`（注释已标"P4 横向扩展需共享存储"） |
| 门禁 | `MIVO_BFF_TOKEN` 单一共享 token（Bearer/Basic/X-Mivo-Bff-Token 三种携带方式**都校验同一个 token**），**非 per-user 鉴权** | `server/app.ts` access gate；`server/__tests__/access-gate.test.ts` |

**结论**：现在没有"后端该有的东西"（用户、持久化、权限、并发），改造 = **第一次造服务端**。

---

## 2. 目标后端分层（对齐平台架构 §2）

```
L2 编排层        GenerationOrchestrator：读画布上下文 → 调能力 → 发 command 写回（不再直接改 store）
      ↕ BFF 契约（唯一对外缝，P1 已实证平移零前端改动）
L3 能力底座      平台通道/llm-proxy（现有）+ mivoserver（身份/资产/多模型，待接）
——————————————————————————————————————————————————
【新增】持久化层  PersistAdapter：IDB 实现（现有）→ Server 实现（P4c）；四端点 + 数据库
```

后端改造主要新增**持久化层**，并把 L2 编排从前端 store 收敛到服务端契约面。渲染层(L4)、能力代理(L3 现有)基本不动。

---

## 3. 持久化层设计【核心】

### 3.1 PersistAdapter 接口先冻结（迁移解耦的关键，对齐平台架构 §13.4 步骤 2）

**【已定】** 先抽 `PersistAdapter` 接口、IDB 挂后面（行为零变化）；接口一冻结，服务端实现(P4b/P4c)可并行开工，不等前端其余改造。双实现渐切（renderer flag 是成功先例）。

### 3.2 四端点（对齐平台架构 §13.5 硬约束）

| 端点 | scope | 说明 | 权限 |
|---|---|---|---|
| `/api/user-state` | user | 相机/最近/工具偏好/草稿，KV+LWW，跨设备同步 | 按人隔离 |
| `/api/assets` | 资产 | 元数据入库 + 文件走对象存储；document 只存 `assetId` | owner |
| `/api/canvas/:id` | document | 画布节点/边/anchor + chat（独立集合） | **owner/成员/链接权限，第一版就带** |
| `/api/projects` | 归属 | 项目 CRUD + 成员 + 分享链接 | owner 建/邀请 |

**【已定，平台架构 §13.5】** `/api/canvas` `/api/projects` 第一版就带权限校验，**不后补**；身份用 maker user id，不发明第二套。

### 3.3 数据模型（四层 scope，对齐平台架构 §13.1）

| scope | 内容 | 同步策略 |
|---|---|---|
| document | nodes/edges/anchors/画布结构 + chat（per-canvas 集合） | 服务端真相 + **节点级合并**（每 record 带 `revision`），CRDT-ready |
| user | 相机 per 画布/最近/工具偏好/草稿 | 跨设备同步、按人隔离，KV+LWW，不进 CRDT |
| session | 拖拽中间态/编辑 overlay/在飞任务句柄 | 不同步（undo 栈 per 设备，选区不同步） |
| presence | 他人光标/选区 | 未来协作，现在零代码留位 |

### 3.4 Version（跨会话版本，对齐 **已提交** p4-schema-spike §2）

**【已定，p4-schema-spike】**
- 服务端 Version 与本地 undo(D7 的 60 条快照)**不共用存储**：undo 走本地易失，Version 走服务端持久化日志。
- 策略 = **混合**：每 K 版/时间窗落一次全量基线快照（复用 `getSnapshot`/`normalizeCanvasSnapshotV2`）+ 中间记增量 delta（复用 `historyManager` 纯函数）；回溯 = 最近基线 + replay。
- 阈值(N/K/T)与清理策略留 P4-a 实施定。

### 3.5 chat history（对齐 **已提交** p4-schema-spike §4）

**【已定，p4-schema-spike】** chat **随 canvas 服务端化，但作独立集合**（按 `canvasId` 索引），不嵌入 canvas 文档主体（避免文档膨胀 + LWW 粒度变粗）。作 P4c 从属项，不阻塞。

### 3.6 存量迁移

**【已定，迁移计划 §12-2】** 存量 IDB → 服务端迁移器：**dry-run + fixtures 回归 + 失败回滚**（内网已有真实用户数据，画布丢了无法交代）。IDB persist 已有 v9 迁移链 + fixtures 体系可复用。

---

## 4. 数据库引擎决策【核心】

### 4.1 先厘清：两个阶段的持久化需求（决定引擎不用为"现在跑 CRDT"买单）

| 阶段 | 时间 | 并发模型 | 数据形态 | 对 DB 的要求 |
|---|---|---|---|---|
| **A. 近期服务端化**（M4/P4c） | 接下来两三个月 | 服务端权威 + **节点级乐观并发**（见 §6） | 每节点一行结构化记录 | 普通关系库即可，`revision` 是整数列 |
| **B. 未来协作**（§8 排最后，独立立项） | 协作愿景启动 | 真 CRDT（Yjs） | Yjs 编码二进制 | 存一段 bytea/blob |

**关键**：平台架构 §6 的"CRDT-ready / 对齐 Yjs"约束的是**表结构形状**（每节点独立 id、属性扁平、无嵌套大 JSON，能无损映射 Y.Map/Y.Array），不是要求现在就存 Yjs 二进制。近期存普通结构化行；B 阶段只加一张 bytea 表。→ 选型不为 CRDT 买单。

### 4.2 候选引擎对比

| 引擎 | 关系域(归属/权限) | 文档域(节点行+revision+灵活属性) | 未来 Yjs 二进制 | 并发/扩展 | 团队契合 | 判定 |
|---|---|---|---|---|---|---|
| **PostgreSQL** | ✅ 外键/权限 join 干净 | ✅ JSONB + 普通列 revision | ✅ bytea；Hocuspocus 官方 database 扩展 | ✅ 多写并发好，P4 共享存储 | ✅ Node 生态最成熟 | ✅ **推荐** |
| SQLite | ✅ | ✅（Hocuspocus 有 extension-sqlite） | ✅ blob | ❌ **单写锁**，内网多人写是硬伤 | 中 | ❌ 仅够 bootstrap |
| MySQL | ✅ | ⚠️ JSON 弱于 JSONB | ✅ blob | ✅ | ⚠️ 无既有、无差异化优势 | ❌ |
| MongoDB | ❌ 权限模型本质关系型，文档库做别扭 | ✅ | ⚠️ | ✅ | ❌ 未用 | ❌ 权限不匹配 |

### 4.3 决策：PostgreSQL 【建议】

**【建议，未决】** 一个 Postgres 覆盖全部四层 scope：关系表（归属/权限）+ JSONB（节点灵活属性）+ KV 表（user-state）+ 未来 bytea（Yjs）。三条硬理由：① 唯一同时把"强关系权限"和"半结构化节点"都做好的引擎，不用双引擎；② CRDT-ready 与未来 Yjs 落库天然支持（`revision` 整数列 / Hocuspocus `extension-database` 原样存 bytea）；③ 契合现状（后端 Node/TS）与部署（内网单机 docker，已有 docker 目录，低运维；且正是 `state.ts` 说的"P4 共享存储"）。

### 4.4 表结构（DDL，对齐 §13.5 已定模型）

```sql
-- ── 关系域（§13.5 原文三表，身份复用 maker user id，不建身份表） ──
create table projects (
  id text primary key, owner_id text not null, title text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table project_members (
  project_id text not null references projects(id) on delete cascade,
  user_id text not null, role text not null check (role in ('owner','editor','viewer')),
  primary key (project_id, user_id)
);
create table share_links (
  token text primary key, project_id text not null references projects(id) on delete cascade,
  permission text not null check (permission in ('view','edit')),
  created_by text not null, created_at timestamptz not null default now()
);

-- ── 文档域（CRDT-ready 形状：每节点一行 + revision） ──
create table canvases (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  title text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table canvas_records (
  canvas_id text not null references canvases(id) on delete cascade,
  record_id text not null, kind text not null,        -- 'node'|'edge'|'anchor'
  props jsonb not null,                                -- 扁平属性，含 schemaVersion
  revision bigint not null,                            -- §13.5 硬约束：spike 阶段就有
  updated_at timestamptz not null default now(),
  primary key (canvas_id, record_id)
);
create table canvas_chat_messages (
  canvas_id text not null references canvases(id) on delete cascade,
  message_id text not null, payload jsonb not null, created_at timestamptz not null default now(),
  primary key (canvas_id, message_id)
);

-- ── user 域（KV + LWW） ──
create table user_state (
  user_id text not null, key text not null, value jsonb not null,
  updated_at timestamptz not null default now(), primary key (user_id, key)
);

-- ── 素材（元数据入库，文件进对象存储） ──
create table assets (
  id text primary key, owner_id text not null, mime_type text, size_bytes bigint,
  storage_key text not null, created_at timestamptz not null default now()
);

-- ── 未来协作（B 阶段才加） ──
create table yjs_documents (
  document_name text primary key, state bytea not null, updated_at timestamptz not null default now()
);
```

### 4.5 索引 / 连接池 / 备份 / 容量 / 部署（工程细节）

- **索引【建议】**：`canvas_records` 已含 PK `(canvas_id, record_id)`，补 `create index on canvas_records(canvas_id)`（按画布拉全量）；`create index on projects(owner_id)`、`create index on project_members(user_id)`（"我的项目"列表）；`share_links` PK on token 即够。
- **连接池【建议】**：现单进程 pm2 → 应用层 `pg.Pool`（或 Kysely 内置）；未来多实例 → 前置 **pgBouncer**（transaction 模式），避免连接数爆。
- **备份/回滚【建议，对齐"真实数据不容丢"】**：`pg_dump` 每日全量 + 开 **WAL 归档做 PITR**（可回滚到任意时点）；存量 IDB→服务端迁移前先备份。
- **容量估算**：`canvas_records` 一节点一行、`props` 通常 <1KB；重画布千节点级 = 单表几千行/画布，Postgres 毫无压力。未来 `yjs_documents.state` 每文档 KB–MB 级。素材大文件不入库（对象存储）。→ 起步内网单机绰绰有余。
- **部署形态【建议】**：起步**同机 docker**（10.102.80.15 已有 docker 目录，低运维）；P4 横向扩展时迁独立实例/托管 PG。

### 4.5.1 数据根目录：`/AIGC_Group/mivo-canvas-data`（与代码仓分离）【已定，owner】

**【已定，owner 2026-07-08】** 所有持久化数据统一存放在 **`/AIGC_Group/mivo-canvas-data`**，与代码仓 `/AIGC_Group/mivo-canvas` **物理分离**。

**为什么必须分离（不是偏好，是硬约束）**：代码仓每天 9:00/17:00 自动 `git pull` + `npm ci` + rebuild 部署；数据若待在仓库目录内，会被部署流程波及、混入 `.gitignore` 复杂度、且有随误操作丢失的风险。数据与代码分离后，重装/重建代码不碰数据，数据备份/迁移也独立。

**目录布局【建议】**：
```
/AIGC_Group/mivo-canvas-data/
├── postgres/     # Postgres PGDATA（docker volume 挂到这里）
├── assets/       # 素材对象存储（本地 fs 或 MinIO 的 data volume）
└── backups/      # pg_dump 全量 + WAL 归档
```
docker 部署时把上述子目录作为 volume 挂载；`assets.storage_key` 相对 `assets/` 解析。

**对"对象存储用哪家"的收窄**：本决策要求数据全部在此路径下 → **排除公司远程 OSS（aigc.xindong.com）作为画布数据/素材的主存储**（那是远程、不在此路径），素材落 **本地文件系统** 或 **本地 MinIO（volume 指向 `assets/`）**。见 §4.5.2 建议。

### 4.5.2 素材存储：起步本地文件系统（内容寻址），封在 AssetService 后【建议】

**【建议，未决待确认】** 起步用 **本地文件系统**（不引入 MinIO），封在 `AssetService` 接口后，留 S3 兼容迁移路径。

**为什么不是 MinIO（现在）**：当前是内网工具、单机、量不大；MinIO 的杀手锏（presigned URL 卸载、跨机扩展、lifecycle）近期（M4 单机）用不上，为用不上的能力多养一个常驻服务 + 故障点不划算（KISS/YAGNI）。

**接口设计（让 fs→S3 迁移只是换实现，零 schema 改动，同 PersistAdapter 套路）**：
```
interface AssetService {
  put(bytes): Promise<assetId>      // 写入，返回内容寻址 id
  get(assetId): ReadableStream      // 读出
  url(assetId): string              // fs 实现 → 内部 /api/assets/:id 路由；S3 实现 → presigned URL
}
```
- **内容寻址 key**：`assets/<sha256[0:2]>/<sha256>.<ext>` → 白送去重 + 完整性校验 + 目录分片。（对齐 knowledge base 概念 content-addressed-asset-identity）
- **opaque ref**：`assets.storage_key` 只存不透明 key，后端无关；DB 不关心底下是 fs 还是 S3。（对齐 storage-adapter-client-side-opaque-ref）

**切 MinIO/S3 的触发条件**（任一出现再切，在此之前不引入）：① 真要跨机横向扩展（P4）；② 需 presigned URL 把大图服务从 BFF 卸载；③ 手写 GC/配额（B5）变得难维护。

**权限**：`/AIGC_Group/mivo-canvas-data` 目录归属/权限比照代码仓（yanjian + zhuzan 已有 ACL），部署账号（yanjian）对其可写；docker 容器以对应 uid 挂载。实施时新建目录并对齐 ACL（现在不预建）。

### 4.6 未来协作阶段（B）：Yjs 落到同一个 Postgres（不换引擎）

到协作立项时，只加 `yjs_documents` 表 + 接 Hocuspocus：其官方 `@hocuspocus/extension-database` 要求实现 `fetch(documentName)→Uint8Array` / `store(documentName, state)`，`state` 是 Yjs 编码二进制**原样存成 bytea**。近期 `canvas_records`（结构化行）与未来 `yjs_documents`（二进制）可并存：迁移期把结构化行**投影**成初始 Yjs 文档灌入（因近期 schema 已按 Y.Map/Y.Array 形状设计，是"投影"非"重构"），之后 Yjs 成文档域真相源。

### 4.7 访问层 【建议】

**【建议，未决】** **不引入 Prisma**（平台架构 §4 明确排除，maker 用 Prisma 但 mivo 不搬）。推荐 **Kysely**（类型安全 query builder，无重运行时/代码生成，契合项目 strict TS + `server/contracts` 类型文化）；备选裸 `pg` / Drizzle。

### 4.8 迁移双轨（对齐 p4-schema-spike 语义）

两类迁移分开：① DB schema 迁移（建表/加列，Kysely migrations 或 SQL 文件版本化）；② **record 级迁移**（`canvas_records.props.schemaVersion`，服务端多版本客户端并存时读取升级），与现有 IDB v9 迁移链同构。

---

## 5. 认证与权限

### 5.1 现状 → 目标

**【已定，平台架构 §5：身份走 A2】** 从"内部共享 token 门禁"升级为"**per-user 鉴权，依赖 maker OAuth/JWT**，不发明第二套身份"。

| | 现状 | 目标 |
|---|---|---|
| 门禁 | `MIVO_BFF_TOKEN` 单一共享 token（防滥用，非用户鉴权） | maker JWT 校验，识别 per-user 身份 |
| 上游 key | 服务端统一 key | **per-user key 透传**（auth E1/E2 分支，已实现待合） |
| 权限 | 无 | owner/editor/viewer + 链接 view/edit，BFF 中间件校验 |

### 5.2 auth E1/E2（**迁移第一顺位前置**）

**【已定，迁移计划 §12-3 / M0-①】** auth E1/E2 分支（per-user key 透传，双审已过、躺在两个 worktree 未合）**必须先合**——否则 M1 改 store 结构会把它冲突到没法救。**这是 M0 硬前置，与 prod 未纳管改动清零同级。**

> ⚠ 这两个 worktree 在本仓库 `git branch` 里看不到（在独立 worktree），本文只记"待合"状态，具体实现以合入时 diff 为准。

### 5.3 权限模型（对齐平台架构 §13.5）

**【已定，§13.5】** Figma 式，**无预定义团队实体**；默认私有，按项目邀请/分享。成员 role=owner/editor/viewer；链接 permission=view/edit；**仅 owner 可邀请**（第一版关死转授权）。校验点全在 BFF 中间件（`/api/projects` `/api/canvas`）。

---

## 6. 并发模型（两个阶段，别混）

**【已定，平台架构 §13.5 A2 + §6】**（§4.1 已从 DB 视角引用，此处给完整语义）：

- **A. 近期——节点级乐观并发**：客户端提交某节点改动时带上读到的 `revision`；服务端 `update ... where record_id=? and revision=?`，命中则 `revision+1`，未命中说明别人先改了同一节点 → 返回冲突提示。**同节点才冲突，不同节点各自独立更新，天然并行。**
- **B. 未来——真 CRDT（Yjs）**：presence、多人光标、自动合并，独立立项（§8 排最后，roadmap 现有"不做 CRDT/实时协作"约束届时正式解除）。

> ⚠ **B 的时机是一项待团队决定的事（D16）**：当前 owner 文档立场是"协作排最后"，但若产品要求"上线就要实时同编"，A 的节点级乐观并发会被 Yjs 取代、B 需大幅前置。见 D16。

---

## 7. 编排上移（L2）

**【已定，平台架构 §13.2 + 迁移计划 M3】** `generationSlice` / `chatMaskEditFlow` / `chatEnhanceFlow` 的网络编排从 store 收敛到 **GenerationOrchestrator(L2)**：
- 编排**不再直接 set 文档**；`commitGenerationResult` 改为**发 command**（generation 域与文档域正式脱钩）。
- 在飞任务归 **session scope**（不同步）。
- facade 雏形已有（`generationFacade`），BFF 路由已是契约层，改动量中等。

---

## 8. 内存态 → 共享存储（横向扩展前置）

**【建议，未决细节】** 现 `server/platform/state.ts` 的 token/chatSession 单飞是**进程内内存**（单实例语义）。上 Postgres + 多实例后：token/session 缓存需挪到**共享存储**（Postgres 表 或 Redis），单飞语义跨实例（分布式锁 or DB 唯一约束）。【未决】用 Postgres 表还是 Redis——起步单实例可先不动，多实例时再定。

---

## 9. 落地顺序与风险（对齐迁移计划 M0–M4）

**绞杀者模式**：每步 main 可发布、开关可回滚，**不许迁移大分支憋两周**（每日两次自动部署逼出的硬约束）。

| 期 | 后端相关动作 | 硬约束 |
|---|---|---|
| **M0** | ① 合 auth E1/E2；② prod 未纳管改动清零；③ record schema+scope spike（验收=无损映射 Y.Map/Y.Array） | 两前置同级，缺一不进 M1 |
| **M1** | Doc 结构 CRDT-ready（`revision` 字段级）+ persist 大版本迁移 | **必须在 P4c 之前**——否则服务端 schema 存旧结构，双份迁移 |
| **M2** | 节点类型/资产源总线契约化（后端资产源接口） | 按"第二实现到场"收窄 |
| **M3** | generation/mask/enhance 编排上移 L2 | — |
| **M4** | PersistAdapter Server 实现：**P4b 资产 → P4c 文档**（存 CRDT-ready 结构，一步到位） | P4c 依赖 M1；P4b 无此依赖可先行 |

**风险清单（迁移计划 §12 摘后端相关）**：
1. 每日自动部署 = 全程不许 main 破碎（强制小步 + 合并队列）。
2. 存量真实用户数据 → persist 大迁移必带 dry-run + 回滚。
3. auth 未合是第一顺位前置（见 §5.2）。
4. **服务端 schema 顺序耦合（最易踩）**：P4c 必须等 M1；P4b 资产无此依赖可先行。
5. **mivoserver 契约可能反推翻设计**——p4-schema-spike §5 已标：本机无 mivoserver 仓库，board 域 schema/字段对照未摸底，是 P4-e 前置（需 lead 提供仓库访问）。
6. **实时协作时机若改（D16）会重排本表**：若团队定"上线就要实时同编"，M1 的 CRDT-ready 要直接对齐真 Yjs（非乐观并发过渡）、且 Hocuspocus/WebSocket 需前置——本 M0–M4 顺序需相应调整。当前表按 owner 文档"协作排最后"的立场排。

---

## 10. 决策登记表（一处看全）

| # | 决策 | 状态 | 出处 |
|---|---|---|---|
| D1 | 后端目标 = 持久化层 + per-user 鉴权 + 权限 + CRDT-ready | 【已定】 | 平台架构 §13 |
| D2 | 四层 scope（document/user/session/presence） | 【已定】 | 平台架构 §13.1 |
| D3 | 归属/权限三表 + maker 身份复用 + owner/editor/viewer + 链接 | 【已定】 | 平台架构 §13.5 |
| D4 | `revision` 字段 spike 阶段就建，权限第一版就带 | 【已定】 | 平台架构 §13.5 |
| D5 | Version = 混合（基线+增量），与本地 undo 分离 | 【已定】 | p4-schema-spike §2 |
| D6 | chat 随 canvas 服务端化、独立集合 | 【已定】 | p4-schema-spike §4 |
| D7 | 存量 IDB→服务端迁移器带 dry-run+回滚 | 【已定】 | 迁移计划 §12-2 |
| D8 | auth E1/E2 先合（M0 硬前置） | 【已定】 | 迁移计划 §12-3 |
| D9 | 数据库引擎 = PostgreSQL | **【建议】** | §4 |
| D10 | 访问层 = Kysely（不用 Prisma） | **【建议】** | §4.7 |
| D11 | 素材存储 = 本地文件系统（内容寻址）封在 AssetService 后，留 S3 迁移路径 | **【建议】** | §4.5.2 |
| D12 | 内存单飞 → 共享存储（Postgres 表 vs Redis） | **【未决】** | §8 |
| D13 | Postgres 部署形态（起步同机 docker） | **【建议】** | §4.5 |
| D14 | mivoserver board 域字段映射 | **【未决，缺访问】** | p4-schema-spike §5 |
| D15 | 数据根目录 = `/AIGC_Group/mivo-canvas-data`，与代码仓分离 | **【已定，owner】** | §4.5.1 |
| D16 | 实时协作时机：A 排最后（现立场）/ B 提到 v1 硬需求 / C 折中（紧随其后里程碑）。可行性已核实（Yjs 绑在 store/overlay 层、LeaferJS 零改动；多人光标 UI 需自建）；无论 B/C 建议先做去风险 spike | **【未决，需团队定】** | §6 / §9 |

---

## 11. 待团队/owner 拍板清单（把所有【建议】【未决】汇总，供商议）

> 本节是这份提案要团队会上过一遍、逐条给出决定的清单。【已定】项（D1–D8、D15，均可溯源到 owner 文档）不在此列，除非团队要重开。

**A. 确认类（有推荐，团队确认即可开工）**
1. 数据库引擎 = **Postgres**（D9）
2. 访问层 = **Kysely，不用 Prisma**（D10）
3. 素材存储 = **本地文件系统起步，封 AssetService，留 S3 路径**（D11）
4. Postgres 部署 = **起步同机 docker**（D13）

**B. 需团队定方向类**
5. **实时协作时机（D16）**：A 排最后 / B 提到 v1 硬需求 / C 折中。**这条影响 M1 结构方向与 M0–M4 排序**；无论 B/C 建议先做 Yjs↔LeaferJS 去风险 spike 再承诺。
6. 内存单飞挪去哪（Postgres 表 vs Redis）——多实例时才需拍（D12）。

**C. 需 lead 提供输入类**
7. **mivoserver 访问**：仓库路径 + board 域 schema，解锁 P4-e 字段映射（D14，p4-schema-spike §5 前置）。
8. 素材若日后切本地 MinIO 的触发条件是否认可（§4.5.2）。

---

## 12. 一页话（给团队/owner 商议用）

后端要第一次长出"真服务端"：存画布/用户态/权限的持久化层 + maker JWT 鉴权 + owner/成员/链接权限 + 为协作预留的 CRDT-ready 结构。**数据怎么分层、权限怎么设计、Version 怎么存、chat 怎么放——上游 owner 文档都已拍板**（本文标【已定】）；本文把它们收敛成一份后端真相源，并把"用什么数据库"补全为 **Postgres + Kysely（不碰 Prisma）**、素材起步本地 fs、附表结构 DDL 与工程细节。**所有数据存 `/AIGC_Group/mivo-canvas-data`、与代码仓物理分离**（代码天天自动部署，数据不能待在仓库里）。**要团队会上拍板的见 §11 清单**：多是有推荐的确认项（Postgres/Kysely/本地 fs/docker）；唯一需要定方向的是 **实时协作时机（D16：排最后 / v1 硬需求 / 折中）**——它是整份里唯一会改动 roadmap 排序的一项，建议先做去风险 spike 再定。落地严格走绞杀者小步、每日两次自动部署不许破线，顺序上 auth 先合、M1 改完结构再上 P4c 服务端持久化。
