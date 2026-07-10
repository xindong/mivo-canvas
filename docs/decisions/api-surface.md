# API Surface 定稿(T1.3 前置)—— 返修版

> 状态:**契约冻结(2026-07-10,返修 2026-07-11)**。本文件是 T1.3 四端点 + PersistAdapter 的服务端契约权威。
> 返修覆盖 13 条 findings(9×P1+4×P2),逐条对齐实现;旧版 wire 与实现漂移处已收口。
> 范围:把 plan §4 T1.3 行 + §3 DP-5/DP-6/DP-7/DP-8/DP-9 + FX-4 定死为可测契约;PG(T1.1)未批前,服务端以**内存实现**过契约测试,PG 落地后只换 `PersistBackend` 实现(信封列 + 路由契约不变)。
> 上游真相源:`docs/decisions/record-schema.md`(K40/revision/三域)、`docs/decisions/soft-delete-semantics.md`(§2/§3/§7)、`docs/decisions/platform-architecture-2026-07-07.md`(§13 scope/§13.5 归属)、`docs/plan/arch-migration-execution-plan.md`(§3 DP-x、§4 T1.3、FX-4)。
> 源码事实源:`server/lib/keys.ts`(FX-2 owner 指纹)、`server/routes/tasks.ts`(per-user 隔离先例)、`server/lib/config.ts`(`jsonRequestMaxBytes=1048576`)、`src/kernel/records.ts`(NodeRecord/EdgeRecord/AnchorRecord)、`src/lib/persistIdbStorage.ts`(`syncToServer` P4c 接缝)、`server/routes/assets.ts`(T1.5 #195 真实 asset wire)。
>
> **验收(本任务)**:换电脑登录同账号 → 项目/画布/图片/对话原样在(plan §0 成功定义 1)。PG 落地 + 服务器部署后由 PersistAdapter 接线(S6b 同型 swap)兑现,本任务只保证**契约 + 接口互锁可测**。

---

## 0. 总览

四端点按"数据的命运"切分(platform §13.1),**不在 `/api/mivo/*` 下**——`/api/mivo/*` 是无状态图像能力代理(generate/edit/enhance/tasks);`/api/{canvas,projects,user-state,assets}` 是**有状态、按账号归属**的数据持久化底座:

| 端点组 | scope | 子资源 | 依据 |
|---|---|---|---|
| `/api/projects` | document | 项目 CRUD;deleteProject 级联软删画布(DP-3,原子 tree #7) | DP-3、§13.5 |
| `/api/canvas` | document | 画布 record(nodes/edges/anchors)+ **chat 子资源(DP-6)**;节点级 PATCH(FX-4)+ revision 409 + 428 | DP-5、DP-6、FX-4、§13.5 |
| `/api/user-state` | user | per-user KV(selection/相机/偏好/草稿);key namespace allowlist + DP-7 递归敏感扫描(#9) | DP-1、DP-7、§13.1 |
| `/api/assets` | asset | **T1.5 #195 已实现**(POST/GET 真实 shape,§4.4 引用) | DP-5 payload、§13.2 AssetService |

**信封列(DP-5 + 返修 #6 orderKey)**——四端点共享的 record 物理形状,服务端只理解信封列,payload 是不透明 jsonb(节点级合并 tie-break 用 `revision`,不下沉到 payload 字段级):

```
id          TEXT PK            — record 稳定 id(客户端生成 UUID,离线优先幂等)
owner_id    TEXT               — 资源归属 owner(返修 #1 resourceOwnerId;过渡 mivo-key 指纹,T1.4 maker user id)
canvas_id   TEXT NULL          — 所属 canvas(project/user-state/chat-collection meta 此列为空;chat-message/node/edge/anchor = canvasId)
type        TEXT               — 'project'|'canvas'|'chat-collection'|'node'|'edge'|'anchor'|'chat-message'|'user-state'
scope       TEXT               — 'document'|'user'(asset 域见 T1.5,不入本表)
revision    INTEGER            — per-record revision(§13.5 节点级合并 LWW tie-break;envelope 唯一真相,返修 #5)
order_key   REAL               — 稳定排序键(fractional rank,返修 #6;node/chat-message 钉,其余 0)
is_deleted  BOOLEAN            — 软删标记(DP-3/FX-7,1=软删,可 restore;仅 canvas/project/chat-collection 软删,返修 #2)
created_at  TIMESTAMPTZ        — 创建时间(不可变)
updated_at  TIMESTAMPTZ        — 最后写入时间
payload     JSONB              — 整存 record 体(NodeRecord 等);服务端不解析(除白名单 codec 返修 #11/#13)
```

> **DP-5 依据**:`信封列 + payload jsonb`——只拆 `id/owner_id/canvas_id/type/scope/revision/order_key/is_deleted/created_at/updated_at` 及少量索引字段,其余整存 jsonb;不全量拆列,不把 jsonb 当字段级 CRDT。`revision` 是信封列而非 payload 内字段——服务端按 record 粒度 merge,同节点才冲突提示(§13.5)。**返修 #5**:wire payload 不携带 id/revision(shared `UpsertRequest` 已删 revision 字段),id 来自 path,revision base 来自 If-Match header,envelope.revision 是唯一真相。**返修 #6**:`order_key` 让 node/chat-message 稳定排序,listByCanvas ORDER BY order_key。

---

## 1. 鉴权与归属(owner resolution,返修 #1)

**鉴权对齐现有**(plan §4 T1.3 "鉴权对齐现有"):沿用 SSO 网关方案——生产由 nginx 网关(auth.dsworks.cn)全包认证,app 无 auth gate(`server/app.ts` 注释);本地 dev 用 `routes/auth.ts` 桩。per-user key(`X-Mivo-Api-Key`)在各 route 边界注入,与 auth gate 无关。

**返修 #1:actorUserId 与 resourceOwnerId 拆分**:
- `resolveActor(c)` = 调用方身份(FX-2 mivo-key 指纹;§13.5 目标 = maker user id)。`server/lib/owner.ts`。
- `resourceOwnerId` = 资源归属,从 `record.envelope.ownerId` 读。过渡语义下 owner===actor(T1.3 seam),T1.4 扩 project_members/share_links 后解耦。
- 授权 seam(`server/lib/authz.ts`):`canAccessProject/canAccessCanvas/canAccessUserState`。T1.3 只判 owner===actor;**接口/查询路径按授权模型建,T1.4 只扩不改**(加 member/share)。未授权统一 404(无存在泄漏,§5)。
- **project id 全局唯一**(返修 #1):跨 owner 同 project id → 409 `project-exists`(全局 unique index `globalProjectOwners`);同 owner 同 id → 幂等 existing。授权 seam 经 `backend.getProjectOwner(id)` 全局查归属。

**§13.5 目标(迁移靶,T1.4/PG 落地时换)**:owner = 已认证 maker user id(网关 `/api/auth/me.username`)。`resolveActor` 是**唯一 swap 点**:换实现时只改身份解析内部(读网关注入的可信身份),信封列/路由/revision 409/428/cascade 语义全不变。

**边界校验**:每个 route 顶调 `rejectInvalidMivoApiKey(c)`——present-but-malformed(非 `mivo_` 前缀/超 128/坏字符)→ 400 且**不回退 env**(防脏 header 把他人 env key 钉进 owner 桶)。

---

## 2. revision 冲突语义(409)+ 428(返修 #4/#5)

**依据**:platform §13.5(每 record 带 revision,服务端按节点粒度 merge,同节点才冲突)+ record-schema §1(revision 每记录一个,LWW tie-break)+ FX-4(节点级 PATCH 与 revision 同设计)。

**返修 #4:If-Match 严格优先 + existing 强制 base(428)**:
- revision base 唯一来源 = `If-Match` header(返修 #5:wire body 不带 revision;`shared/persist-contract.ts` `resolveBaseRevision` 严格整数 parse)。body 内若带 revision(旧 client)→ 忽略,以 If-Match 为准。
- existing 记录 PATCH/PUT 缺 If-Match → **428 Precondition Required** `{error:'precondition-required', id}`。仅 create 路径(POST ensureCreate + PATCH missing→create)免 base。
- existing.revision === If-Match → 接受,bump revision+1,`updated_at`=now。返回 200/201 `{id, revision}`(post-bump)。
- existing.revision !== If-Match → **409 Conflict** `{error:'revision-conflict', id, currentRevision}`。客户端 rebase(重读→merge→重试)。
- **返修 #5:fresh create 保留客户端 base**——PATCH missing→create 时 revision = `max(0, If-Match)`(对齐 `MemoryDocKernel.nextRevision`:新建 → max(0, base),`src/kernel/docKernel.ts:46-48`);无 If-Match → revision=0。

**返修 #5:envelope 唯一真相**——wire `UpsertRequest` 无 id/revision 字段(shared 类型已删);`RecordEntry.revision` 来自 envelope(非 payload);server 校验 `payload.id`(若有)=== path :id 一致性(返修 #13 codec);payload 内 revision 字段被忽略(防双真相)。

**幂等键(返修 #10)**:`Idempotency-Key` header,作用域 = owner+method+resourceKind+key(复合,跨 type 不串)+ 请求 fingerprint(sha256 body,`fingerprintOfBody`)。同 key+fingerprint → 返既有结果(不 bump);软删命中按冻结语义真恢复。重启后 index 清空 → 视为新写(内存实现语义,PG 用独立表 + UNIQUE,附录 A)。

**返修 #5:canvas metaRevision 与 contentVersion 分名**——`CanvasMeta.metaRevision`(canvas meta record envelope.revision,PUT /api/canvas/:id 的 If-Match base)+ `CanvasMeta.contentVersion`(content 版本 counter,backend 在子资源 node/edge/anchor/chat-message 写入时 bump,存 canvas meta payload.contentVersion)。子资源写入不 bump metaRevision;client 据此探测 content 是否变化,与 metaRevision 独立。

---

## 3. payload 上限与节点级 PATCH(FX-4,返修 #12/#13)

**依据**:FX-4("1MB/413 已源码实证 jsonRequestMaxBytes=1048576;与 revision 同设计")。`server/lib/config.ts` `jsonRequestMaxBytes = 1024 * 1024`。

- **JSON body 上限 1MB**:所有 JSON 写端点走 `readJsonBodyWithFingerprint(c)`(返 body + fingerprint);超限 → `RequestBodyTooLargeError` → **413**(返修 #12:统一 helper `tooLargeBody()` 返 shared `TooLargeBody` `{error:'request-body-too-large', limit:1048576}`,全端点 body 一致)。
- **节点级 PATCH**(`/api/canvas/:id/nodes/:nodeId`):body = `{payload: NodeRecord}`(返修 #5:无 revision)。单节点 payload 远 < 1MB;几千节点保存不 413。
- **返修 #13:NodeRecord payload 白名单 runtime 校验**(`server/lib/persistHttp.ts` `validateChildPayload`):
  - payload 必须 object(非 null/array)。
  - `payload.id`(若有)必须 === path :id(返修 #5 一致性)。
  - 拒 envelope 镜像字段:`ownerId/canvasId/scope/revision/isDeleted/createdAt/updatedAt/orderKey`(PAYLOAD_MIRROR_FIELDS)→ 400 `payload-rejected` mirror-field。
  - 拒 status/tasks(DP-8/9:record 不存运行态/编排态)→ 400 `payload-rejected` forbidden-field。
  - 仅对 node/edge/anchor payload;chat-message payload 不校验(ChatMessage 自身含 status 字段,合法)。

---

## 4. 端点契约

### 4.1 `/api/projects`(document 域)

> 项目是画布的归属容器(§13.5 `projects(id, ownerId)` + `project_members`)。第一版**仅 owner**(T1.4 加 members/share;§13.5 硬约束:owner 校验第一版就要带,不能后补——`resolveActor` + authz seam 已满足)。

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/projects` | — | 200 `{projects: Project[]}`(owner===actor seam:T1.3 只返 actor 自己的;T1.4 加被分享的) |
| `POST /api/projects` | JSON `{id?: string, name: string}`(+可选 `Idempotency-Key`) | 201 `{id, name, ownerId, createdAt, updatedAt, revision, isDeleted}`;同 owner 同 id→200 既有(幂等);**跨 owner 同 id → 409 project-exists**(全局唯一 #1);id 缺失→服务端 UUID;413 body>1MB |
| `GET /api/projects/:id` | — | 200 Project;404 `unknown-project`(跨 owner/未授权=404 同 unknown,无泄漏 #1) |
| `PATCH /api/projects/:id` | JSON `{name?}` + **`If-Match`(必填 #4)** | 200 `{id, name, updatedAt, revision}`;缺 If-Match→428;409 revision-conflict;404;413 |
| `DELETE /api/projects/:id` | — | 204(软删);**softDeleteProjectTree 原子级联(#2/#7)**:project + 其 canvas meta + chat-collection 一起 is_deleted=true;children(node/chat-message)保持活记录;idempotent:删已删→204;404 |

**Project 形状**(信封 payload):
```ts
type Project = { id, name, ownerId, createdAt, updatedAt, revision, isDeleted }
```

> **DP-3 依据**:删画布级联对话(一起 restore);deleteProject 级联软删其画布(soft-delete-semantics §3/§8)。**返修 #2**:cascade 只标 canvas/project/chat-collection,children 保持活记录随父级不可见(GET canvas 软删→404,node/chat-message 不可见但 record 活)。

---

### 4.2 `/api/canvas`(document 域,含 chat 子资源 DP-6)

> 画布 = record 集合(nodes/edges/anchors + meta),每 record 独立 revision(§13.5 节点级合并)。chat 是 per-canvas 独立 collection(DP-6,record-schema §5),随 canvas 生命周期级联(FX-7)。**返修 #2**:chat-collection 是独立 envelope record(type='chat-collection', canvas_id=canvasId),canvas 软删时标 collection record;message 不软删(硬删)。

**4.2.1 画布 record 级**

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/canvas?projectId=<pid>` | — | 200 `{canvases: CanvasMeta[]}`(返修 #8:按 project/owner 枚举;跨 owner 不可见) |
| `GET /api/canvas/:id` | — | 200 `GetCanvasResponse`(metaRevision/contentVersion #5 + nodes/edges/anchors 带 orderKey #6);404 unknown-canvas(跨 owner=404) |
| `POST /api/canvas` | JSON `{id?, projectId, title?, sourceTemplateId?}` + `Idempotency-Key` | 201 `CanvasMeta`;projectId 须属本 owner(否则 404);创建时一并建 chat-collection record(#2);413 |
| `PUT /api/canvas/:id` | JSON `{payload: {projectId?, title?, sourceTemplateId?}}` + **`If-Match`(必填 #4)** | 200 `CanvasMeta`;缺 If-Match→428;409;404;413;**move(#8)**:projectId 可改(须属本 owner) |
| `DELETE /api/canvas/:id` | — | 204;**softDeleteCanvasTree 原子(#2/#7)**:标 canvas meta + chat-collection;children 活;404 |

**CanvasMeta 形状**(返修 #5/#8):
```ts
type CanvasMeta = {
  id, projectId, title, sourceTemplateId?, createdAt, updatedAt,
  metaRevision: Revision,    // canvas meta record envelope.revision
  contentVersion: Revision, // content 版本(子资源写入 bump,backend 维护)
}
type GetCanvasResponse = CanvasMeta & { nodes: RecordEntry[]; edges: RecordEntry[]; anchors: RecordEntry[] }
type RecordEntry = { id, revision, orderKey, payload }  // 返修 #6 orderKey
```

**4.2.2 节点级 PATCH(FX-4 + 返修 #3/#4/#5/#6/#13)**

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `PATCH /api/canvas/:id/nodes/:nodeId` | JSON `{payload: NodeRecord}` + `If-Match`(existing 必填 #4) | 200 `{id, revision}`;409 revision-conflict;404 unknown-canvas/unknown-node;428 缺 base;400 payload-rejected(#13);413 |
| `PATCH /api/canvas/:id/edges/:edgeId` | 同(payload=EdgeRecord) | 同上 |
| `PATCH /api/canvas/:id/anchors/:anchorId` | 同(payload=AnchorRecord) | 同上 |
| `DELETE /api/canvas/:id/nodes/:nodeId` | — | 204(**真硬删 #2**,物理移除);404 unknown-canvas/unknown-node |
| `DELETE /api/canvas/:id/edges/:edgeId` | — | 同(返修 #8:补 edge DELETE) |
| `DELETE /api/canvas/:id/anchors/:anchorId` | — | 同(返修 #8:补 anchor DELETE) |
| `POST /api/canvas/:id/reorder` | JSON `{type:'node'|'edge'|'anchor'|'chat-message', orderedIds:string[]}` | 200 `{reordered: number}`(返修 #6:重排持久化 orderKey,重启顺序一致) |

> **返修 #3:子资源归属**——所有子资源操作 WHERE 带 owner+canvas_id+type+id;`canvas_id` 不可变(upsert 时保留 existing.canvasId);跨 canvas(同 id 属另一 canvas)→ 404 `unknown-*`(不 create,防 canvas_id 篡改)。
> **返修 #4**:existing PATCH 缺 If-Match → 428;PATCH missing→create 用 `max(0, If-Match)`(#5)。
> NodeRecord/EdgeRecord/AnchorRecord 形状见 `src/kernel/records.ts`(K40 + revision;payload 不透明,服务端白名单 codec #13)。

**4.2.3 chat 子资源(DP-6 + 返修 #2)**

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/canvas/:id/chat` | — | 200 `{messages: RecordEntry[]}`(ORDER BY orderKey #6);404 unknown-canvas |
| `POST /api/canvas/:id/chat` | JSON `{message: ChatMessage}` + `Idempotency-Key` | 201 `{id, revision}`;idempotent(同 message.id+owner→200);404(canvas 须未软删);413 |
| `PATCH /api/canvas/:id/chat/:msgId` | JSON `{payload: ChatMessage}` + `If-Match`(必填 #4) | 200 `{id, revision}`;409;404;428;413 |
| `DELETE /api/canvas/:id/chat/:msgId` | — | 204(**真硬删 #2**);404 |

> chat-collection envelope:`type='chat-collection'`, `canvas_id=:id`, `payload={}`;随 canvas soft delete 级联标(#2)。ChatMessage 17 字段(chatStore.ts:65-83),payload 不透明整存;ChatMessage.status 是消息状态(合法,不在 #13 白名单拒收范围——#13 仅针对 NodeRecord/EdgeRecord/AnchorRecord)。

---

### 4.3 `/api/user-state`(user 域)

> per-user KV(platform §13.1 "跨设备同步、按人隔离:简单 KV + LWW,不进 CRDT";DP-1 selection 迁此;DP-7 两把 key 永不进此)。

| 方法+路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/user-state` | — | 200 `{entries: {key: UserStateEntry}}` |
| `GET /api/user-state/:key` | — | 200 UserStateEntry;404 unknown-key |
| `PUT /api/user-state/:key` | JSON `{value: unknown}` + `If-Match`(existing 必填 #4) | 200 `{id, revision}`;409;428 缺 base;400 forbidden-key/forbidden-value/bad-request;413 |
| `DELETE /api/user-state/:key` | — | 204(软删);404 |

**返修 #9:DP-7 namespace allowlist + 每 namespace runtime schema + 递归敏感扫描**:

| key 形式 | 语义 | value kind(#9) |
|---|---|---|
| `canvas:<canvasId>:selection` | 画布选区(DP-1) | any(array/object/string) |
| `canvas:<canvasId>:camera` | 画布相机 | object(any) |
| `canvas:<canvasId>:chat-draft` | 聊天草稿 | string(any) |
| `recent:projects` / `recent:canvases` | 最近打开 | array |
| `pref:tool` / `pref:brush` / `pref:stamp` | 工具偏好 | string |
| `panel:<panelId>` | 面板开合 | boolean |

> **namespace allowlist**:`canvas:`/`recent:`/`pref:`/`panel:`(`USER_STATE_KEY_NAMESPACES`)。非 allowlist 前缀 → 400 `forbidden-key`(gateway-key/mivo-key 天然不在 allowlist,两把 key 不需单独排除)。
> **每 namespace runtime kind**:value 不符期望 kind → 400 `bad-request`。
> **递归敏感扫描**(`scanForSensitiveFields`):扫 value 字段名(大小写/连字符/camelCase 变体:secret/token/password/apiKey/gatewayKey/mivoKey/accessToken/authorization/credential/privateKey)+ 凭据格式值(形如 `mivo_`/`sk-` 前缀)+ 嵌套对象/数组。命中 → 400 `forbidden-value {key, path}`。
> DP-7 合规:raw mivo key 永不作为 user-state 数据落库;前端 strictIdb 是第一道,服务端 namespace allowlist + 敏感扫描是第二道(防绕过)。

---

### 4.4 `/api/assets`(asset 域,返修 #8 引用 T1.5 #195 真实 shape)

> T1.5(#195)已实现 `server/routes/assets.ts`,本契约只钉 wire shape(不再"留待"):
>
> | 方法+路径 | 请求 | 响应 |
> |---|---|---|
> | `POST /api/assets` | multipart `image` 文件 OR JSON `{image: base64}` | 200 `CreateAssetResponse = {assetId, mimeType, originalName, sizeBytes, refcount, deduped}`(内容寻址:同 content hash → 同 assetId,refcount+1,bytes 复用) |
> | `GET /api/assets/:id` | —(id = sha256 hex 64) | 200 content bytes(immutable,长缓存) |
>
> document record 的 `asset` 字段当前是 url 字符串,T1.5 后改 `assetId`(内容寻址,record-schema §2.4/§6 矛盾 3)。`ServerPersistAdapter` 已补 asset seam(`uploadAsset`/`resolveAsset`,引 `CreateAssetResponse`/`AssetRef` 类型,不重复实现)。

---

## 5. 错误码汇总(返修 #4/#5/#12/#13)

| 码 | error 值 | 语义 | 触发端点 |
|---|---|---|---|
| 400 | `bad-request` | 缺必填字段 / 坏 JSON / value kind 不符(#9) | 全部写端点 |
| 400 | `bad-mivo-key` | X-Mivo-Api-Key malformed(无 env 回退) | 全部(F4 边界) |
| 400 | `forbidden-key` | user-state key 非 namespace allowlist(#9) | PUT /api/user-state/:key |
| 400 | `forbidden-value` | user-state value 含敏感字段名/凭据格式值(#9) | PUT /api/user-state/:key |
| 400 | `payload-rejected` | NodeRecord payload 白名单不过(#13:mirror-field/forbidden-field/id-mismatch/not-object) | PATCH node/edge/anchor |
| 404 | `unknown-project`/`unknown-canvas`/`unknown-collection`/`unknown-node`/`unknown-edge`/`unknown-anchor`/`unknown-message`/`unknown-key` | 不存在 / **跨 owner/未授权(#1)** / **跨 canvas(#3)**(同 body,无存在泄漏) | 全部 |
| 405 | `method-not-allowed` | 非 route 声明方法(deferred nicety,新端点 Hono 默认 404) | — |
| 409 | `revision-conflict` | stale revision(返 `currentRevision`) | PATCH/PUT 节点 + meta + user-state |
| 409 | `project-exists` | **跨 owner 同 project id**(全局唯一 #1) | POST /api/projects |
| **428** | `precondition-required` | existing 写端点缺 If-Match base(#4) | PATCH/PUT 节点 + meta + user-state |
| 413 | `request-body-too-large` | body > 1MB(返修 #12 统一 `TooLargeBody`) | 全部 JSON 写端点 |

---

## 6. 内存实现语义 + PG 迁移(返修 #6/#7/#10)

**内存实现(本任务,`server/persist/backend.ts` `InMemoryPersistBackend`)**:
- `Map<ownerId, Map<envelopeKey, PersistRecord>>` 两层(per-owner 隔离)+ `globalProjectOwners` Map(project id 全局唯一索引 #1)+ idempotency index(`owner:method:resourceKind:key` 复合 + fingerprint #10)。
- 软删(#2):仅 canvas/project/chat-collection `is_deleted=true`;node/edge/anchor/chat-message DELETE 物理移除(`hardDeleteChild`)。
- 原子 tree(#7):`softDeleteCanvasTree`/`softDeleteProjectTree`(+`restoreCanvasTree`/`restoreProjectTree`)单函数原子,快照回滚(注入故障测试验证全回滚)。
- orderKey(#6):append 分配递增;`reorderChildren` 全量重分配;`listByCanvas` ORDER BY orderKey。
- contentVersion(#5):`upsertChild`/`hardDeleteChild` bump canvas meta payload.contentVersion(不动 metaRevision)。
- 幂等(#10):key 作用域 owner+method+resourceKind+key + fingerprint(sha256 body);软删命中真恢复。
- **重启清空**(同 tasks registry V02):内存非持久,PG 落地前重启=数据丢。真验收"换电脑原样在"在 PG + 服务器部署后兑现。

**PG 实现(T1.1 批复后,附录 A SQL 草案)**:
- 信封列直接映射表(DP-5 + order_key);payload jsonb;owner_id + canvas_id + type 索引;`revision` 乐观并发(UPDATE WHERE revision=$client,行影响 0 → 409);`order_key` REAL + ORDER BY。
- project 全局唯一:独立 `projects(id PK, owner_id)` 表(全局唯一 id,#1);授权 seam 经 project id 全局查 owner_id。
- 幂等(#10):独立 `idempotency_index(owner_id, method, resource_kind, key, fingerprint, envelope_ref)` + UNIQUE(owner_id, method, resource_kind, key)。
- **swap 不改路由/契约**:PersistBackend 接口不变,`server/app.ts` 注入点换 PgPersistBackend;路由 handler 零改动;契约测试从内存换成 PG fixture 重跑(同 S6b)。

---

## 附录 A:PG 表结构 SQL 草案(T1.1 后由实施 PR 建表,非本任务)

```sql
-- DP-5 信封列 + payload jsonb + order_key(#6)。owner_id 资源归属(过渡: mivo-key 指纹; T1.4: maker user id)。
CREATE TABLE persist_records (
  id          TEXT        NOT NULL,
  owner_id   TEXT        NOT NULL,                  -- 资源归属(返修 #1 resourceOwnerId)
  canvas_id   TEXT        NULL,
  type        TEXT        NOT NULL,                  -- 'project'|'canvas'|'chat-collection'|'node'|'edge'|'anchor'|'chat-message'|'user-state'
  scope       TEXT        NOT NULL,
  revision    INTEGER     NOT NULL DEFAULT 0,        -- envelope 唯一真相(#5)
  order_key   DOUBLE PRECISION NOT NULL DEFAULT 0,   -- 稳定排序(#6)
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,    -- 仅 canvas/project/chat-collection 软删(#2)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB       NOT NULL,                  -- 整存 record 体(canvas meta 含 contentVersion #5)
  PRIMARY KEY (owner_id, type, id)                   -- 跨 owner 同 id:project 走全局表,其余 owner-scoped
);
-- project 全局唯一(#1):独立表,id 全局 PK
CREATE TABLE projects (
  id          TEXT        PRIMARY KEY,               -- 全局唯一(#1)
  owner_id   TEXT        NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB       NOT NULL
);
CREATE INDEX idx_persist_canvas ON persist_records (owner_id, canvas_id, type) WHERE is_deleted = FALSE;
CREATE INDEX idx_persist_order ON persist_records (owner_id, canvas_id, type, order_key) WHERE is_deleted = FALSE;
-- 幂等(#10):独立表 + UNIQUE 复合 key + fingerprint
CREATE TABLE idempotency_index (
  owner_id    TEXT        NOT NULL,
  method      TEXT        NOT NULL,
  resource_kind TEXT     NOT NULL,
  key         TEXT        NOT NULL,
  fingerprint TEXT        NOT NULL,                 -- sha256 body(#10)
  envelope_owner TEXT     NOT NULL,
  envelope_type TEXT     NOT NULL,
  envelope_id TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, method, resource_kind, key)     -- 复合 key 跨 type 不串(#10)
);
-- 乐观并发:UPDATE persist_records SET revision=revision+1, ... WHERE owner_id=$ AND type=$ AND id=$ AND revision=$client;
-- 行影响 0 → 409 revision-conflict(#4/#5)。existing 缺 If-Match 由 route 决 428(#4)。
```

> 草案非最终(T1.1 PG provisioning + Kysely 选型 D10 决定索引/分表细节);**信封列 + revision 409 + 428 + order_key + cascade 软删语义 + 幂等独立表 本文件钉死**,实施 PR 只补索引/Kysely 层,不改契约。

---

## 附录 B:返修 13 条 findings 闭环对照(实现落点)

| # | 优先级 | finding | 实现落点 | 测试 |
|---|---|---|---|---|
| 1 | P1 | owner 模型(拆 actor/resourceOwner;project 全局唯一;授权 seam;404) | `server/lib/owner.ts` resolveActor + `server/lib/authz.ts` + backend `getProjectOwner`/`globalProjectOwners` + routes authzProject | projects.route.test #1 全局唯一 409 + 跨 owner 404 |
| 2 | P1 | 软删粒度(chat-collection envelope;cascade 只标 canvas/project/collection;node/message/edge/anchor 硬删;restore 原子) | backend `softDeleteCanvasTree`/`softDeleteProjectTree`/`restoreCanvasTree` + `hardDeleteChild` + chat-collection type | backend.test #2 + canvas/projects.route.test 硬删+级联 |
| 3 | P1 | 子资源归属(WHERE owner+canvas_id+type+id;canvas_id 不可变;跨 canvas 404) | backend `getChild`/`upsertChild`(cross-canvas)/`hardDeleteChild` | canvas.route.test #3 cross-canvas 404 |
| 4 | P1 | revision 绕过(existing 强制 base 缺失 428;If-Match 优先;create 免 base;helper) | `shared` `resolveBaseRevision` + `persistHttp` `baseFromIfMatch`/`preconditionRequired` + backend `precondition-required` kind | canvas/projects/userState.route.test 428 + If-Match 优先 |
| 5 | P1 | revision 双真相(envelope 唯一;wire 不带 id/revision;payload/path 一致;fresh max(0,base);metaRevision/contentVersion 分名;Kernel↔Server 往返) | shared `UpsertRequest` 删 revision + `CanvasMeta` metaRevision/contentVersion + backend `max(0,base)` + `bumpCanvasContentVersion` + adapter contract test | contract.test #5 往返 + canvas.route.test metaRevision/contentVersion |
| 6 | P1 | 顺序(envelope orderKey;node/chat 钉;SQL ORDER BY;重排持久化) | Envelope.orderKey + backend `nextOrderKey`/`reorderChildren` + listByCanvas ORDER BY + POST /:id/reorder | backend.test #6 + canvas.route.test reorder |
| 7 | P1 | 原子性(softDeleteCanvasTree/ProjectTree + restore 收进 backend 单原子;注入故障全回滚) | backend `softDelete*Tree`/`restore*Tree` 快照回滚 | backend.test #7 注入故障回滚 |
| 8 | P1 | API 面补全(canvas 枚举;CanvasMeta sourceTemplateId/createdAt/move;edge/anchor DELETE;assets 引 #195) | GET /api/canvas + edge/anchor DELETE + CanvasMeta sourceTemplateId + PUT move + §4.4 assets 引 #195 + adapter asset seam | canvas.route.test #8 枚举 + contract.test asset seam |
| 9 | P1 | DP-7(namespace allowlist + 每 namespace schema + 递归敏感扫描;大小写/连字符/camelCase/前缀/嵌套) | shared `USER_STATE_KEY_NAMESPACES`/`userStateNamespaceKind`/`scanForSensitiveFields` + userState route 校验 | userState.route.test #9 + contract.test #9 |
| 10 | P2 | 幂等(key 作用域 owner+method+resourceKind+key + fingerprint;软删真恢复;SQL 独立表+UNIQUE) | backend `idemIndexKey` 复合 + `fingerprintOfBody` + 附录 A `idempotency_index` UNIQUE | backend.test #10 + projects.route.test 幂等跨 type |
| 11 | P2 | 类型互锁(最小 fetch codec;request/response satisfies shared;全端点) | `server/lib/persistHttp.ts` decode/validate/encode + routes 用 decode + TS type annotation | contract.test 类型互锁 + route tests |
| 12 | P2 | 413 body(统一 helper 返 TooLargeBody;全端点断言 status+完整 body) | `persistHttp` `tooLargeBody`/`bodyError` + shared `TooLargeBody` | canvas/projects/userState.route.test 413 完整 body |
| 13 | P2 | DP-8/9 服务端强制(NodeRecord payload 白名单;拒 status/tasks/envelope 镜像;绕过测试) | `shared` `PAYLOAD_MIRROR_FIELDS`/`PAYLOAD_FORBIDDEN_FIELDS` + `persistHttp` `validateChildPayload` | canvas.route.test #13 白名单 + 绕过 |

---

## 附录 C:与既有决策的引用清点

| 决策点 | 本文件落点 | 上游依据 |
|---|---|---|
| DP-1 selection 迁 session | §4.3 key namespace `canvas:<id>:selection` | record-schema §4.1、plan §3 |
| DP-2 anchor 收编 record | §4.2.2 `PATCH /api/canvas/:id/anchors/:anchorId` | record-schema §4.2 |
| DP-3 删画布级联对话 | §4.1/§4.2 DELETE cascade(原子 tree #7) | soft-delete-semantics §3/§8 |
| DP-5 信封列 + payload jsonb + order_key | §0 信封表 + 附录 A | plan §3 DP-5 |
| DP-6 chat 子资源 + chat-collection envelope | §4.2.3 `/api/canvas/:id/chat`(#2) | record-schema §5、plan §3 |
| DP-7 两把 key 永不进 user-state + namespace allowlist + 敏感扫描 | §4.3 namespace + §1 owner 合规(#9) | plan §3 DP-7 |
| DP-8 tasks 不入 document | §0(无 tasks 字段;tasks 走 FX-2 服务端 registry)+ #13 拒 tasks | record-schema §4.3 |
| DP-9 status 不入 record | §3 #13 拒 status(仅 NodeRecord payload) | record-schema §2.1 |
| FX-4 节点级 PATCH 1MB/413 + 428 | §3 + §4.2.2(#4/#12) | plan §4 FX-4 |
| §13.5 节点级合并 revision + 归属模型 | §2 409/428 语义 + §1 actor/owner(#1) | platform §13.5 |
| §13.1 scope 分层 | §0/§4 端点分组 | platform §13.1 |
