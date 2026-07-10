# API Surface 定稿(T1.3 前置)

> 状态:**契约冻结(2026-07-10)**。本文件是 T1.3 四端点 + PersistAdapter 的服务端契约权威。
> 范围:把 plan §4 T1.3 行 + §3 DP-5/DP-6/DP-7/DP-8 + FX-4 定死为可测契约;PG(T1.1)未批前,服务端以**内存实现**过契约测试,PG 落地后只换 `PersistBackend` 实现(信封列 + 路由契约不变)。
> 上游真相源:`docs/decisions/record-schema.md`(K40/revision/三域)、`docs/decisions/platform-architecture-2026-07-07.md`(§13 scope/§13.5 归属)、`docs/plan/arch-migration-execution-plan.md`(§3 DP-x、§4 T1.3、FX-4)。
> 源码事实源:`server/lib/keys.ts`(FX-2 owner 指纹)、`server/routes/tasks.ts`(per-user 隔离先例)、`server/lib/config.ts`(`jsonRequestMaxBytes=1048576`)、`src/kernel/records.ts`(NodeRecord/EdgeRecord/AnchorRecord)、`src/lib/persistIdbStorage.ts`(`syncToServer` P4c 接缝)。
>
> **验收(本任务)**:换电脑登录同账号 → 项目/画布/图片/对话原样在(plan §0 成功定义 1)。PG 落地 + 服务器部署后由 PersistAdapter 接线(S6b 同型 swap)兑现,本任务只保证**契约 + 接口互锁可测**。

---

## 0. 总览

四端点按"数据的命运"切分(platform §13.1),**不在 `/api/mivo/*` 下**——`/api/mivo/*` 是无状态图像能力代理(generate/edit/enhance/tasks);`/api/{canvas,projects,user-state,assets}` 是**有状态、按账号归属**的数据持久化底座:

| 端点组 | scope | 子资源 | 依据 |
|---|---|---|---|
| `/api/projects` | document | 项目 CRUD;deleteProject 级联软删画布(DP-3) | DP-3、§13.5 |
| `/api/canvas` | document | 画布 record(nodes/edges/anchors)+ **chat 子资源(DP-6)**;节点级 PATCH(FX-4)+ revision 409 | DP-5、DP-6、FX-4、§13.5 |
| `/api/user-state` | user | per-user KV(selection/相机/偏好/草稿);key namespace 约定 + DP-7 排除清单 | DP-1、DP-7、§13.1 |
| `/api/assets` | asset | **见 T1.5**(本任务不实现,仅引用) | DP-5 payload、§13.2 AssetService |

**信封列(DP-5)**——四端点共享的 record 物理形状,服务端只理解信封列,payload 是不透明 jsonb(节点级合并 tie-break 用 `revision`,不下沉到 payload 字段级):

```
id          TEXT PK            — record 稳定 id(客户端生成 UUID,离线优先幂等)
canvas_id   TEXT NULL          — 所属 canvas(project/user-state 域此列为空;chat message 此列 = canvasId)
type        TEXT               — record 类型:'project'|'canvas'|'node'|'edge'|'anchor'|'chat-message'|'user-state'
revision    INTEGER            — per-record revision(§13.5 节点级合并 LWW tie-break)
scope       TEXT               — 'document'|'user'(asset 域见 T1.5,不入本表)
is_deleted  BOOLEAN            — 软删标记(DP-3/FX-7,1=软删,可 restore;purge 见 FX-7)
created_at  TIMESTAMPTZ        — 创建时间(不可变)
updated_at  TIMESTAMPTZ        — 最后写入时间
payload     JSONB              — 整存 record 体(NodeRecord 等);服务端不解析
```

> **DP-5 依据**:`信封列 + payload jsonb`——只拆 `id/canvas_id/type/revision/scope/is_deleted/created_at/updated_at` 及少量索引字段,其余整存 jsonb;不全量拆列,不把 jsonb 当字段级 CRDT(plan §3 DP-5)。`revision` 是信封列而非 payload 内字段——服务端按 record 粒度 merge,同节点才冲突提示(§13.5)。

---

## 1. 鉴权与归属(owner resolution)

**鉴权对齐现有**(plan §4 T1.3 "鉴权对齐现有"):沿用 SSO 网关方案——生产由 nginx 网关(auth.dsworks.cn)全包认证,app 无 auth gate(`server/app.ts` 注释);本地 dev 用 `routes/auth.ts` 桩(opt-in,见 `lib/auth-stub.ts`)。per-user key(`X-Mivo-Api-Key`)在各 route 边界注入,与 auth gate 无关。

**owner scope(过渡,本内存实现)**:沿用 FX-2 tasks registry 的 per-user 隔离先例——`resolveOwner(c) = fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)`(`server/lib/keys.ts`,sha256 前 16 hex)。`X-Mivo-Api-Key` 缺失 → 回退 env `MIVO_PLATFORM_KEY` 的指纹(dev 单用户 parity,同 tasks 行为)。跨用户访问一律 404(无存在泄漏,同 FX-2 `getTaskForOwner`→404 `unknown-task`)。

> **DP-7 合规**:raw mivo key **永不作为 user-state 数据落库**(DP-7:gatewayKey/mivoKey 留前端 strictIdb,永不进 /api/user-state);此处只用其**指纹**作 owner 分片键(`fingerprintOfPlatformKey` 注释明示"per-user partition/routing key ... never stored")。两把 key 原文仍在前端 `strictIdbStateStorage`(DP-7 专用语义边界),本仓不动。

> **§13.5 目标(迁移靶,T1.4/PG 落地时换)**:owner = 已认证 maker user id(网关 `/api/auth/me.username`,§13.5 "人的标识一律用 maker user id")。`resolveOwner` 是**唯一 swap 点**:换实现时只改 owner 解析内部(读网关注入的可信身份),信封列/路由/revision 409/cascade 语义全不变。过渡用 mivo-key 指纹是因它已 wired + 已有 FX-2 测试可复用,不阻塞契约冻结。

**边界校验**:每个 route 顶调 `rejectInvalidMivoApiKey(c)`——present-but-malformed(非 `mivo_` 前缀/超 128/坏字符)→ 400 且**不回退 env**(防脏 header 把他人 env key 钉进 owner 桶,同 `keys.ts` F4)。缺失/空 → ok(回退 env owner)。

---

## 2. revision 冲突语义(409)

**依据**:platform §13.5(每 record 带 revision,服务端按节点粒度 merge,同节点才冲突)+ record-schema §1(revision 每记录一个,LWW tie-break)+ FX-4(节点级 PATCH 与 revision 同设计)。

**乐观并发**:写请求带 `If-Match: <revision>` header(或 body `revision` 字段,二者等价,header 优先)。服务端:

- existing 不存在 → 创建(用客户端 revision 或 0,`updated_at` = now)。返回 200/201 + `{id, revision}`。
- existing.revision === client.revision → 接受,bump revision+1,`updated_at`=now。返回 200 + `{id, revision}`(post-bump)。
- existing.revision !== client.revision → **409 Conflict**:
  ```json
  { "error": "revision-conflict", "id": "<recordId>", "currentRevision": <existing.revision> }
  ```
  客户端据此 rebase(重读 → merge → 重试)。**同 409 body 跨 owner 与不存在**?不——409 仅在同 owner 的 stale revision 时返回;跨 owner/不存在走 404(无泄漏,§1)。

**幂等键**:`Idempotency-Key` header(可选,同 FX-2 tasks):同 key + 同 owner + record 仍存在 → 返回既有结果(不 bump revision、不重复副作用)。重启后 index 清空 → 视为新写(内存实现语义,PG 落地后跨进程持久,见 §6)。幂等不跨 owner(B 重用 A 的 key → 两条独立 record,同 `idemIndexKey` 的 ownerFp 前缀)。

---

## 3. payload 上限与节点级 PATCH(FX-4)

**依据**:FX-4("1MB/413 已源码实证 jsonRequestMaxBytes=1048576;与 revision 同设计")。`server/lib/config.ts` `jsonRequestMaxBytes = 1024 * 1024`。

- **JSON body 上限 1MB**:所有 JSON 写端点(POST/PATCH/PUT)走 `readJsonBody(c)`(同 tasks 路由);超限 → `RequestBodyTooLargeError` → **413**(干净 413,不 destroy socket,`server/lib/request.ts` D1)。
- **节点级 PATCH**(`/api/canvas/:id/nodes/:nodeId`):body = `{payload: NodeRecord, revision}`。单节点 payload 远 < 1MB;**几千节点保存不 413**——客户端按节点 PATCH,不整画布 PUT。整画布 PUT(若提供)走同一 1MB 上限(超 → 413,提示客户端改走节点级 PATCH)。
- 413 body:`{ "error": "request-body-too-large", "limit": 1048576 }`(对齐 tasks `413` 分支)。

---

## 4. 端点契约

### 4.1 `/api/projects`(document 域)

> 项目是画布的归属容器(§13.5 `projects(id, ownerId)` + `project_members`)。第一版**仅 owner**(T1.4 加 project_members/share_links 权限层;§13.5 硬约束:`/api/projects` `/api/canvas` 第一版就要带 owner 校验,不能后补——owner 校验在本端点边界 `resolveOwner` 已满足,members 层 T1.4 补)。

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/projects` | — | 200 `{projects: Project[]}`(owner 全部未软删);跨 owner 不可见(本端点只返 owner 自己的) |
| `POST /api/projects` | JSON `{id?: string, name: string}`(+可选 `Idempotency-Key`) | 201 `{id, name, createdAt, updatedAt, revision}`;idempotent:同 id+owner 已存在→200 既有(不重建);id 缺失→服务端生成 UUID;owner-scoped id 不跨 owner 冲突(不同 owner 同 id 是不同分片 PK);413 body>1MB |
| `GET /api/projects/:id` | — | 200 Project;404 `{error:'unknown-project'}`(跨 owner = 404 同 unknown,无泄漏) |
| `PATCH /api/projects/:id` | JSON `{name?, revision}` + `If-Match` | 200 `{id, name, updatedAt, revision}`;409 revision-conflict;404 unknown-project;413 |
| `DELETE /api/projects/:id` | — | 204(软删 is_deleted=true);**级联软删其下所有 canvas**(`type='canvas'` 且 `canvas.projectId===id`)+ 级联软删 canvas 的 chat collection(DP-3,一起 restore);idempotent:删已软删→204;404 unknown-project |

**Project 形状**(信封 payload):
```ts
type Project = {
  id: string; name: string; ownerId: string;   // ownerId = resolveOwner(c)
  createdAt: string; updatedAt: string; revision: number; isDeleted: boolean;
}
```

> **DP-3 依据**:删画布级联对话(一起 restore);deleteProject 同裁决级联软删其画布(standalone 回落是硬删时代防丢补偿,软删落地后理由消失,且避免孤儿 UI)——见 `docs/decisions/soft-delete-semantics.md` §3/§8、record-schema §4(FX-7 细化保留期/purge/asset refcount 回收)。

**cascade 语义**:DELETE /api/projects/:id 在一个事务内把 project + 其 canvases + 其 canvases 的 chat messages 全部置 `is_deleted=true`(同 `updated_at`=now,各自 bump revision)。restore(P2,FX-7)反向全恢复。purge 与 asset refcount 见 FX-7(本任务不实现 purge,只实现软删 + cascade 标记)。

---

### 4.2 `/api/canvas`(document 域,含 chat 子资源 DP-6)

> 画布 = record 集合(nodes/edges/anchors + meta),每 record 独立 revision(§13.5 节点级合并)。chat 是 per-canvas 独立 collection(DP-6,record-schema §5),随 canvas 生命周期级联(FX-7)。

**4.2.1 画布 record 级**

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/canvas/:id` | — | 200 `{id, projectId, title, createdAt, updatedAt, revision, nodes: NodeRecord[], edges: EdgeRecord[], anchors: AnchorRecord[]}`(全量拉取,跨设备原样在);404 unknown-canvas(跨 owner=404) |
| `POST /api/canvas` | JSON `{id?: string, projectId: string, title?: string}` + `Idempotency-Key` | 201 `{id, projectId, title, createdAt, updatedAt, revision}`;projectId 须属本 owner(否则 404 unknown-project);idempotent 同 projects;413 |
| `PUT /api/canvas/:id` | JSON `{title?, revision}` + `If-Match`(doc-level meta 更新) | 200 `{id, title, updatedAt, revision}`;409;404;413 |
| `DELETE /api/canvas/:id` | — | 204 软删 canvas + **级联软删其 chat collection**(DP-3/DP-6);404 unknown-canvas |

**4.2.2 节点级 PATCH(FX-4)**

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `PATCH /api/canvas/:id/nodes/:nodeId` | JSON `{payload: NodeRecord, revision}` + `If-Match` | 200 `{nodeId, revision}`;409 revision-conflict(返 `currentRevision`);404 unknown-canvas;413 body>1MB |
| `PATCH /api/canvas/:id/edges/:edgeId` | 同(payload=EdgeRecord) | 同上 |
| `PATCH /api/canvas/:id/anchors/:anchorId` | 同(payload=AnchorRecord) | 同上 |
| `DELETE /api/canvas/:id/nodes/:nodeId` | — | 204 软删该 node record;404 unknown-canvas/unknown-node |

> NodeRecord/EdgeRecord/AnchorRecord 形状见 `src/kernel/records.ts`(K40 + revision;payload 不透明,服务端不解析,信封列才是服务端理解的全部)。
> **FX-4 依据**:节点级 PATCH → 单节点 payload << 1MB,几千节点保存不 413(客户端按节点 PATCH,不整画布 PUT)。revision 冲突同 §2(同节点才 409,不同节点各自 bump 不冲突)。

**4.2.3 chat 子资源(DP-6)**

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/canvas/:id/chat` | — | 200 `{messages: ChatMessage[]}`(per-canvas collection,跨设备原样在);404 unknown-canvas(跨 owner=404) |
| `POST /api/canvas/:id/chat` | JSON `{message: ChatMessage}` + `Idempotency-Key` | 201 `{id, revision}`;idempotent(同 message.id+owner→200 既有);404 unknown-canvas(canvas 须未软删);413 |
| `PATCH /api/canvas/:id/chat/:msgId` | JSON `{payload: ChatMessage, revision}` + `If-Match` | 200 `{id, revision}`;409;404 unknown-canvas/unknown-message;413 |
| `DELETE /api/canvas/:id/chat/:msgId` | — | 204 软删 message;404 |

> **DP-6 依据**:chat 随文档域走 `/api/canvas` 子资源(messagesByScene 键随 canvas 生命周期,独立集合存储 D6,级联语义见 FX-7)——plan §3 DP-6、record-schema §5。ChatMessage 17 字段(chatStore.ts:65-83),字段级 schema 随 T1.3 本端点定;**本任务不展开 ChatMessage 字段级 CRDT 映射**(chat 是 document 域独立 collection,payload 不透明整存,服务端不解析,同 node payload 语义)。
> chat message 信封:`type='chat-message'`,`canvas_id=:id`(子资源归属),`payload=ChatMessage`。
> **级联**:DELETE /api/canvas/:id → 事务内把该 canvas 的所有 `type='chat-message'` record 置 is_deleted=true(DP-3)。DELETE /api/projects/:id 再级联到这些 chat message(§4.1 cascade)。

---

### 4.3 `/api/user-state`(user 域)

> per-user KV(platform §13.1 "跨设备同步、按人隔离:简单 KV + LWW,不进 CRDT";DP-1 selection 迁此;DP-7 两把 key 永不进此)。

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/user-state` | — | 200 `{entries: {key: UserStateEntry}}`(owner 全部 KV) |
| `GET /api/user-state/:key` | — | 200 UserStateEntry;404 unknown-key(跨 owner=404) |
| `PUT /api/user-state/:key` | JSON `{value: unknown, revision}` + `If-Match`(LWW;revision 缺失→ upsert 视为新写) | 200 `{key, revision}`;409 revision-conflict;413 |
| `DELETE /api/user-state/:key` | — | 204(软删 is_deleted=true);404 unknown-key |

**key namespace 约定**(DP-1/§13.1):

| key 形式 | 语义 | scope 子域 |
|---|---|---|
| `canvas:<canvasId>:selection` | 画布选区(DP-1,per user+canvas) | selection |
| `canvas:<canvasId>:camera` | 画布相机(viewport x/y/zoom) | camera |
| `canvas:<canvasId>:chat-draft` | 聊天草稿(prompt 未发送) | draft |
| `recent:projects` / `recent:canvases` | 最近打开列表 | recents |
| `pref:tool` / `pref:brush` / `pref:stamp` | 工具偏好(brush/stamp 记忆) | prefs |
| `panel:<panelId>` | 面板开合状态 | panel |

> key 是任意客户端字符串(带 `:` 分层,避免扁平碰撞)。owner 隔离 = `resolveOwner(c)` 分片,不同 owner 的同 key 互不可见。

**DP-7 排除清单(永不进 /api/user-state)**:

| 排除项 | 留存处 | 理由 |
|---|---|---|
| `gatewayKey`(sk-) | 前端 `strictIdbStateStorage`(gateway-key namespace) | DP-7:sk- 网关 key 是设备级 API key,跨账号共享,不入 user-state |
| `mivoKey`(mivo_) | 前端 `strictIdbStateStorage`(mivo-key namespace) | DP-7:mivo_ 平台 key 同上,服务端只承接懒验证 |
| 任意含 `secret`/`token`/`password`/`apiKey` 子串的 key | — | 防御性:敏感凭据不进 KV |

> **服务端校验**:PUT /api/user-state/:key 若 key 命中排除清单(精确匹配 `gateway-key`/`mivo-key` namespace,或正则 `/(secret|token|password|apikey)/i`)→ **400 `{error:'forbidden-key'}`**(防御性拒收,DP-7 硬约束的服务端兜底;前端 strictIdb 是第一道,服务端是第二道,防绕过)。

---

### 4.4 `/api/assets`(asset 域)

> **见 T1.5**(plan §4 T1.5 行:AssetService save→POST /api/assets、resolve→GET;内容寻址;assetUrlLease 复用)。本任务**不实现**该端点——`server/routes/assets.ts` 由 T1.5 worker 交付。本契约只钉:**document record 的 `asset` 字段当前是 url 字符串,T1.5 后改 `assetId`(内容寻址)**(record-schema §2.4/§6 矛盾 3),`/api/canvas` 节点 PATCH 的 payload 内 `asset` 字段随之过渡。/api/assets 的契约由 T1.5 worker 在 `docs/decisions/` 单独定稿,不在本文件展开。

---

## 5. 错误码汇总

| 码 | error 值 | 语义 | 触发端点 |
|---|---|---|---|
| 400 | `bad-request` | 缺必填字段 / 坏 JSON | 全部写端点 |
| 400 | `bad-mivo-key` | X-Mivo-Api-Key malformed(无 env 回退) | 全部(F4 边界) |
| 400 | `forbidden-key` | user-state key 命中 DP-7 排除清单 | PUT /api/user-state/:key |
| 404 | `unknown-project`/`unknown-canvas`/`unknown-node`/`unknown-message`/`unknown-key` | 不存在 / **跨 owner**(同 body,无存在泄漏) | 全部 |
| 405 | `method-not-allowed` | 非 route 声明方法 | 全部。**当前实现**:新四端点用 Hono method-specific route(`route.get/post/patch/put/delete`),wrong method → **404**(Hono 默认,无 route match),非 405。generate/edit 既有 405(用 `app.all`+method 校验)。405 对齐为 deferred nicety(非契约不变量;可拆片补)。 |
| 409 | `revision-conflict` | stale revision(返 `currentRevision`) | PATCH/PUT 节点 + meta + user-state |
| 409 | ~~`project-exists`~~ | **不产生**(owner-scoped id:跨 owner 同 id 是不同分片 PK,不冲突;同 owner 同 id → 幂等 `existing` 200,非 409。UUID 使 same-owner 同 id 近似不可能) | —(POST /api/projects 无此分支) |
| 413 | `request-body-too-large` | body > 1MB(FX-4 `jsonRequestMaxBytes`) | 全部 JSON 写端点 |

---

## 6. 内存实现语义 + PG 迁移

**内存实现(本任务,`server/persist/memoryBackend.ts`)**:
- `Map<ownerFp, Map<envelopeKey, PersistRecord>>` 两层(per-owner 隔离;ownerFp 来自 `resolveOwner`)。
- 软删:`is_deleted=true` 标记,不物理删;cascade 在同一调用内标记级联 records。
- 幂等:`Map<idemIndexKey, envelopeKey>`(ownerFp + idempotencyKey 复合,同 FX-2 `idemIndexKey`)。
- revision:bump 规则同 `MemoryDocKernel`(existing.revision+1 / 新建 max(0,base));409 on stale。
- **重启清空**(同 tasks registry V02 语义):内存非持久,PG 落地前重启 = 数据丢。**文档约定**:客户端不得假设重启后内存数据还在;真验收"换电脑原样在"在 PG + 服务器部署后兑现(本任务只测契约不变量,不测跨重启持久——内存实现重启语义不在验收范围)。

**PG 实现(T1.1 批复后,TODO 留 `server/persist/backend.ts` 文件头 + 下附录 SQL 草案)**:
- 信封列直接映射表(DP-5);payload jsonb;ownerFp + canvas_id + type 索引;`revision` 乐观并发(同 §2);cascade 软删走单事务 + FK 或应用层。
- **swap 不改路由/契约**:PersistBackend 接口不变,`server/app.ts` 注入点从 InMemoryPersistBackend 换 PgPersistBackend;路由 handler 零改动;契约测试从内存换成 PG fixture 重跑(同 S6b persist adapter swap 模式)。
- owner scope 迁 §13.5 目标(maker user id):`resolveOwner` 内部换,信封列加 `owner_id` 占位列(T1.4 members 层同源)。

---

## 附录 A:PG 表结构 SQL 草案(T1.1 后由实施 PR 建表,非本任务)

```sql
-- DP-5 信封列 + payload jsonb。owner_id 占位列(T1.4 members 层同源);过渡 owner scope = mivo-key 指纹。
CREATE TABLE persist_records (
  id          TEXT        NOT NULL,                  -- record 稳定 id(客户端 UUID)
  owner_id   TEXT        NOT NULL,                  -- owner 分片(过渡: mivo-key 指纹; T1.4: maker user id)
  canvas_id   TEXT        NULL,                      -- project/user-state 域 NULL; chat-message = canvasId
  type        TEXT        NOT NULL,                  -- 'project'|'canvas'|'node'|'edge'|'anchor'|'chat-message'|'user-state'
  scope       TEXT        NOT NULL,                  -- 'document'|'user'
  revision    INTEGER     NOT NULL DEFAULT 0,        -- per-record LWW tie-break(§13.5)
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,    -- 软删(DP-3/FX-7)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB       NOT NULL,                  -- 整存 record 体,服务端不解析
  PRIMARY KEY (owner_id, type, id)                  -- 跨 owner 的同 id 不冲突(分片)
);
CREATE INDEX idx_persist_canvas ON persist_records (owner_id, canvas_id, type) WHERE is_deleted = FALSE;
CREATE INDEX idx_persist_idem  ON persist_records (owner_id, idempotency_key)   WHERE idempotency_key IS NOT NULL;
-- idempotency_key 单列存或并入 payload;实施 PR 定。乐观并发:UPDATE ... WHERE revision = $client(行影响 0 → 409)。
```

> 草案非最终(T1.1 PG provisioning + Kysely 选型 D10 决定索引/分表细节);**信封列 + revision 409 + cascade 软删语义本文件钉死**,实施 PR 只补索引/Kysely 层,不改契约。

---

## 附录 B:与既有决策的引用清点

| 决策点 | 本文件落点 | 上游依据 |
|---|---|---|
| DP-1 selection 迁 session | §4.3 key namespace `canvas:<id>:selection` | record-schema §4.1、plan §3 |
| DP-2 anchor 收编 record | §4.2.2 `PATCH /api/canvas/:id/anchors/:anchorId` | record-schema §4.2 |
| DP-3 删画布级联对话 | §4.1/§4.2 DELETE cascade | soft-delete-semantics §3/§8 |
| DP-5 信封列 + payload jsonb | §0 信封表 + 附录 A | plan §3 DP-5 |
| DP-6 chat 子资源 | §4.2.3 `/api/canvas/:id/chat` | record-schema §5、plan §3 |
| DP-7 两把 key 永不进 user-state | §4.3 排除清单 + §1 owner scope 合规 | plan §3 DP-7 |
| DP-8 tasks 不入 document | §0(无 tasks 字段;tasks 走 FX-2 服务端 registry) | record-schema §4.3 |
| FX-4 节点级 PATCH 1MB/413 | §3 + §4.2.2 | plan §4 FX-4 |
| §13.5 节点级合并 revision | §2 409 语义 | platform §13.5 |
| §13.1 scope 分层 | §0/§4 端点分组 | platform §13.1 |
