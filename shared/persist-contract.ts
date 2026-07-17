// shared/persist-contract.ts
// T1.3 前置:四端点 + PersistAdapter 的 wire 契约(客户端 ↔ 服务端互锁)—— 返修版二(N1-N10)。
// 权威:docs/decisions/api-surface.md。本文件是唯一让 server/ 与 src/ 共享的 seam——
// server 路由按这些类型 parse/返回,client PersistAdapter 按这些类型 (de)serialize,
// 任一侧改 shape → 编译期 break(类型共享互锁,lead §3 任务选项一)。
//
// 约束(两端 tsconfig 共编译):
//  - 纯数据类型 + 纯函数,无 DOM/Node 专有 API(服务端 tsconfig lib 仅 ES2023)。
//  - 不用 enum(erasableSyntaxOnly);用 union string + `as const`。
//  - revision 唯一真相在 envelope 信封列(platform §13.5);wire payload 不携带 id/revision
//    (返修 finding #5:envelope 唯一真相)。id 来自 URL path,revision base 来自 If-Match header
//    (返修 finding #4:existing 强制 base,缺失 428;If-Match 严格优先;create 免 base)。
//  - 返修 N1:transport payload = 逐 type Omit<Record,'id'|'revision'>(id 取路径,revision 取
//    envelope/If-Match;payload 内 domain createdAt 保留不镜像校验——Edge/Anchor 的 createdAt
//    是 canonical 域字段,不在 mirror 拒收集)。本共享层 import type 引用 src/kernel/records
//    (单向,无环:src/kernel 不 import shared;src/types/mivoCanvas + src/lib/imageSizing 均 DOM-free,
//    服务端 tsconfig 含 ES2023 可类型检查)。

import type { AnchorRecord, EdgeRecord, NodeRecord } from '../src/kernel/records'
import {
  MARKUP_KIND_VALUES,
  MARKUP_BRUSH_KIND_VALUES,
  CANVAS_STAMP_KIND_VALUES,
  SECTION_LOCK_MODE_VALUES,
  MARKDOWN_DISPLAY_MODE_VALUES,
  MARKUP_STROKE_STYLE_VALUES as MARKUP_STROKE_STYLE_CONST,
  EXPERIMENTAL_ANCHOR_TYPE_VALUES,
} from '../src/types/mivoCanvas'

/** per-record revision(envelope 唯一真相,节点级合并 LWW tie-break,platform §13.5)。 */
export type Revision = number

/**
 * Phase 2 归档(回收站):record 活跃态。live 记录 `status ∈ {active, archived}`(缺省=active,向后兼容)。
 * - `active`:正常可见可写(默认)。
 * - `archived`:归档态——可读(回收站预览)、可恢复、子记录写返 409 archived(CR-6,客户端引导先恢复再编辑)。
 * **彻底删除沿用现有 is_deleted 软删终态,不新增 'deleted' status 值**(避免与 is_deleted 双轨)。
 * wire optional:旧 client 不读此字段无感;envelope 列(D1,镜像 is_deleted 存储先例)。
 */
export type RecordStatus = 'active' | 'archived'

/** scope 分层(platform §13.1)。asset 域见 T1.5,不入本契约。 */
export type PersistScope = 'document' | 'user'

/**
 * record 类型(信封 `type` 列,api-surface §0)。
 * `chat-collection`:per-canvas 的对话集合 envelope(返修 finding #2);collection 级软删标记,
 * message 不软删(硬删/编辑)。`chat-message` 是单条消息(活记录,不软删)。
 *
 * DP-6R(chat per-user 重拆,2026-07-12):
 * - `chat-collection` **per-canvas 共享**,存在 **canvas owner** 名下(随 canvas 原子创建/软删/恢复),
 *   只钉 canvas 级"对话集合在"标记;不含 per-actor 状态。
 * - `chat-message` **per-actor 私有**:envelope.ownerId = **actor**(写入者稳定 identity,DP-4 SSO username
 *   或 dev/legacy 指纹)。PK = (actor, 'chat-message', messageId)——两 actor 可在同 canvas 拥同 messageId
 *   (per-actor namespace)。画布 authz 只证 actor 可访问画布;chat CRUD 强制**只读写 actor 自己的 collection**
 *   (listByCanvas / ensureCreateChild / upsertChild / hardDeleteChild / reorderChildren 对 chat-message 一律
 *   按 actor 分区)。匿名 share-link 访客(actor=null / 无稳定 identity)chat 读写一律 401 require-login。
 * - chat-message 写入(PATCH/POST/DELETE/reorder)**不 bump 共享 canvas contentVersion**(chat 是 per-user
 *   私有,非共享画布内容;client fetchCanvas 只返 nodes/edges/anchors,不含 chat)。reorder 的乐观锁走
 *   **独立的 per-actor×canvas orderRevision**(见 ListChatMessagesResponse),与共享 cv 解耦。
 * - 旧 owner chat(ownerId=canvasOwner)无需搬迁:owner 的 actor === canvasOwner,故 owner GET 仍见旧数据;
 *   成员不获复制(Gate2 生产未启用前无成员 chat)。删/恢复画布只触 canvas meta + chat-collection
 *   (均 under canvasOwner),per-actor chat-message 活记录不动 → 不串 actor collection。
 */
export type PersistType =
  | 'project'
  | 'canvas'
  | 'chat-collection'
  | 'node'
  | 'edge'
  | 'anchor'
  | 'chat-message'
  | 'user-state'

/**
 * 信封列(DP-5 + 返修 #6 orderKey):四端点共享的 record 物理形状。服务端理解全列;payload 不透明。
 * 内存实现 + PG 实现同形;PG swap 不改此(Wire)形状。
 *
 * - `orderKey`(fractional rank,返修 #6):node/chat-message 等有序子资源用其稳定排序;
 *   无序资源(project/canvas meta/user-state)orderKey=0。listByCanvas 按 orderKey 升序返回。
 * - `ownerId`(返修 #1 resourceOwnerId):资源归属 owner。鉴权 seam 校验 actor 是否可访问该 owner 的资源。
 *   **DP-6R**:`chat-message` 的 ownerId = **actor**(写入者本人,per-actor 私有),非 canvas owner;
 *   其余 type(node/edge/anchor/canvas/chat-collection/project/user-state)ownerId = canvas/project owner。
 */
export type Envelope<Payload = unknown> = {
  id: string
  ownerId: string
  canvasId: string | null
  type: PersistType
  scope: PersistScope
  revision: Revision
  orderKey: number
  isDeleted: boolean
  /** D1(Phase 2 归档):status 信封列(镜像 is_deleted 存储先例)。缺省/undefined=active(向后兼容)。 */
  status?: RecordStatus
  createdAt: string
  updatedAt: string
  payload: Payload
}

// ── 返修 N1:transport payload = 逐 type Omit<Record,'id'|'revision'> ──────────────────
// id 来自 path,revision 来自 envelope/If-Match;payload 不携带 id/revision(防双真相)。
// Edge/Anchor 的 `createdAt` 是 canonical 域字段(保留,不镜像校验);Node 无 createdAt 域字段。
export type NodePayload = Omit<NodeRecord, 'id' | 'revision'>
export type EdgePayload = Omit<EdgeRecord, 'id' | 'revision'>
export type AnchorPayload = Omit<AnchorRecord, 'id' | 'revision'>

/**
 * 写请求(POST idempotent / PATCH 节点级 / PUT meta)。
 * 返修 #5/N1:wire body 不携带 id/revision——id 来自 path,revision base 来自 If-Match header。
 * payload = 逐 type transport(NodePayload/EdgePayload/AnchorPayload);服务端对 node/edge/anchor 做
 * runtime 白名单 codec(N10:必填/类型校验/拒 unknown/非 string id 400)。
 */
export type UpsertRequest<Payload = unknown> = {
  payload: Payload
}

/**
 * 写成功响应(201/200)。revision = post-bump(调用方免二次读)。
 *
 * A2-S2 过渡态(§10.2):扩 seq(per-canvas 单调事件序号)+ base(opaque BaseCursor string,accepted 后签发)。
 *   - 当前 optional:旧 client(只读 id/revision)不 break;新 server route(PATCH/POST/DELETE)返全字段。
 *   - base 是 opaque string(server encodeBase 签发,client 不读内部,回传 If-Match)。
 *
 * A2-S3 strictify(lead ②,Plan C 收尾):拆 `CanvasChildUpsertResponse`(seq+base 必填)extends 本类型,
 *   供 canvas child 域(PATCH/POST)返回;chat(DP-6R per-actor,有独立 orderRevision 游标,不进 canvas_seq)
 *   与 user-state(无序流无字段级契约)仍用本类型(optional,**不填** seq/base——不发明未经终审的语义)。
 *   client contract test 据此恢复 canvas 域 exact type test(toEqualTypeOf)。
 */
export type UpsertResponse = {
  id: string
  revision: Revision
  /** A2-S2:per-canvas 单调事件序号(§10.5;?since=seq 补拉)。optional 过渡,canvas child 域必填(见 CanvasChildUpsertResponse)。 */
  seq?: number
  /** A2-S2:opaque BaseCursor string(§14.1;accepted 后签发新 base,client 回传 If-Match)。optional 过渡,canvas child 域必填(见 CanvasChildUpsertResponse)。 */
  base?: string
}

/**
 * A2-S3(lead ②):canvas child 域(PATCH /:id/nodes/:nodeId edit / POST create)写成功响应——
 * seq + base **必填**(server route A2-S2 已全填,PATCH:617/POST:683)。extends UpsertResponse(optional)
 * 以便 chat/userState 等非 canvas child 域仍用 UpsertResponse(optional,不填 seq/base)。
 * - chat(DP-6R per-actor):有独立 orderRevision 游标,不进 canvas_seq → 不适用 seq/base,保 optional 不填。
 * - user-state:无序流无字段级契约 → 不适用,保 optional 不填。
 * - DELETE 响应非本类型(返 {id, seq},record 已删无 base,§10.7 cursor=seq);reorder 非 UpsertResponse shape
 *   (返 {reordered, contentVersion, base})。
 * client contract test 用本类型恢复 exact type test(toEqualTypeOf)。
 */
export type CanvasChildUpsertResponse = UpsertResponse & {
  seq: number
  base: string
}

// ── A2-S2 field-level DomainOp wire 契约(§10.1;server/client 共享;server/lib/domainOp.ts 提供 validator)──
// TODO(A2-S3): 阶段 3 client adapter 接线时,DomainOp/CreateBody 投入生产 wire(client 发,server 收)。
/** FieldPath = 非空 tuple(G1-b R4-P1-1 / S10-6;运行时拒空)。leaf-level 域语义路径,非 RFC6902 JSON-Pointer。 */
export type FieldPath = readonly [string | number, ...(string | number)[]]

/**
 * F2-ter(T2.2 Block 2 五轮):fieldPath 终点类别(schema-aware 分类,单一真相源)。
 * 定义于 shared(与 FieldPath 同层,neutral type contract 层)——生产 classifyFieldPathTarget
 * 与 transport classifyTransportIntentTarget 两站共用 `classifyFieldPathBySchema` 返此类型,杜绝手写第二份。
 * - `leaf`:标量叶子(string/number/boolean)——set/delete-field 合法。
 * - `container`:对象/union 容器,或 required 根数组(fills/strokes/effects)——整子树 set/delete-field = clobber 重表达,拒。
 * - `array-element`:数组元素位置(末段 number)——by-stable-id deferred,拒 delete-field;整元素 set 拒。
 * - `array-field`:optional 数组字段(aiWorkflow.sourceNodeIds/relations.parentIds)——delete 放行(整数组删,合法),set 拒(整数组替换 = clobber 吞 peer insert)。
 */
export type FieldPathTarget = 'leaf' | 'container' | 'array-element' | 'array-field'
/**
 * DomainOp = 单 record LWW delta(§10.1;无 recordId/actor/base/opId,全 adapter/path/header 注入)。
 * 无 create(走独立 POST)/ 无 strict-tx(改 server-named)/ 无 by-id(A2 deferred,fail-visible)。
 */
export type DomainOp =
  | { kind: 'set'; fieldPath: FieldPath; value: unknown }
  | { kind: 'unset'; fieldPath: FieldPath }
  | { kind: 'array'; fieldPath: FieldPath; class: 'whole-lww'; intent: 'replace'; value: unknown[] }
  | { kind: 'array'; fieldPath: FieldPath; class: 'primitive'; intent: 'insert' | 'remove'; value: string }
  | { kind: 'reorder'; orderedIds: string[] }
/** server-named invariant command(跨 record 原子,§10.4;仅 node-delete-cascade 实证;其余类型+注释级)。 */
export type ServerInvariantCommand =
  | { kind: 'node-delete-cascade'; canvasId: string; nodeId: string }
  | { kind: 'group-reparent'; canvasId: string; nodeIds: string[]; targetGroupId: string | null }
  | { kind: 'result-asset-attach'; canvasId: string; anchorId: string; assetId: string; resultNodeId: string }
export type RecordKind = 'node' | 'edge' | 'anchor'
/** CreateBody = POST /:id/nodes/:nodeId body(§10.2;零 privileged,id 来自 path client NodeRecord.id)。 */
export type CreateBody = { clientId: string; type: RecordKind; payload: unknown }
/**
 * LegacyReplaceRequest 信封(§14.3;FX-5 队列迁移 drain-only 兼容通道)。
 * - 绑 canvasId+nodeId+原队列 baseRevision;scope 校验防同 nodeId 跨 canvas 重放。
 * - 四态矩阵:existing+base=rev→200 replace / existing+base≠rev→409 / missing+base>0→409 dead-letter / missing+base=0→create。
 * - LEGACY_DRAIN gate env 默认关;retirement 后消失(主写唯一 DomainOp)。受控迁移协议例外(非双协议窗口)。
 */
export type LegacyReplaceRequest = {
  kind: 'legacy-replace'
  canvasId: string
  nodeId: string
  version: 1
  payload: unknown
  baseRevision: Revision
}
/** Legacy drain 观测 + retirement 判定接口(§14.3;drainCount 累计 + pending gauge + quiet-window 60_000ms)。 */
export type LegacyDrainStatus = {
  drainCount: number
  pendingGauge: number
  envelopeIncrementInWindow: number
  quietWindowMs: number
  elapsedMs: number
  /** canRetire:pending=0 + 窗内 envelope 增量=0 + elapsed>=quietWindowMs(连续 quiet-window 内无 envelope 到达)。 */
  canRetire: boolean
}

/** 409 revision 冲突体(api-surface §2)。客户端据此 rebase。 */
export type ConflictBody = {
  error: 'revision-conflict'
  id: string
  currentRevision: Revision
}

/** 413 body(FX-4,jsonRequestMaxBytes=1048576)。返修 #12:统一 helper 返此 shape。 */
export type TooLargeBody = {
  error: 'request-body-too-large'
  limit: number
}

/** 428 Precondition Required(返修 #4:existing 写端点缺 If-Match base)。 */
export type PreconditionRequiredBody = {
  error: 'precondition-required'
  id: string
}

/** 400 bad-mivo-key(F4 边界,无 env 回退)。 */
export type BadMivoKeyBody = {
  error: 'bad-mivo-key'
}

/** 400 forbidden-key / forbidden-value(DP-7 user-state 排除清单服务端兜底,返修 #9/N6)。 */
export type ForbiddenKeyBody = {
  error: 'forbidden-key'
  key: string
}
export type ForbiddenValueBody = {
  error: 'forbidden-value'
  key: string
  path: string
}

/**
 * 返修 N4:422 幂等 key 复用冲突(同 key 不同 fingerprint=不同 body)。
 * 同 key + 同 body(同 fingerprint)→ 200 既有(不 bump);同 key + 不同 body → 422。
 */
export type ReuseConflictBody = {
  error: 'idempotency-key-reuse'
  key: string
}

/** 400 payload-rejected(返修 #13/N10:NodeRecord payload 白名单 runtime 校验)。 */
export type PayloadRejectedReason =
  | 'mirror-field'
  | 'forbidden-field'
  | 'id-mismatch'
  | 'bad-id-type'
  | 'not-object'
  | 'unknown-field'
  | 'missing-field'
  | 'bad-type'
export type PayloadRejectedBody = {
  error: 'payload-rejected'
  reason: PayloadRejectedReason
  field?: string
}

/** 不存在 / 跨 owner / 未授权(同 body,无存在泄漏,§1/#1)。 */
export type UnknownResourceBody = {
  error:
    | 'unknown-project'
    | 'unknown-canvas'
    | 'unknown-collection'
    | 'unknown-node'
    | 'unknown-edge'
    | 'unknown-anchor'
    | 'unknown-message'
    | 'unknown-key'
}

/**
 * DP-6R:401 require-login(匿名 share-link 访客 chat 读写)。
 * 匿名访客按链接角色可访问画布,但 chat per-user 需稳定 identity;无 identity 的 chat 读写一律 401,
 * 引导客户端登录(actor=null 路径不可写 chat collection)。
 */
export type RequireLoginBody = {
  error: 'require-login'
}

/**
 * CR-6(Phase 2 归档 write-guard):archived canvas 的子记录写被拒(409)。客户端引导"先恢复再编辑"。
 * 触发点:authzCanvas 对 archived(action=write|move)返此 body;read/manage 放行(归档可读、可恢复、可彻底删除)。
 * SG-1(server 端 archived-parent 写入闸门,defense-in-depth):canvas POST create / PUT move 命中 archived
 * 目标 project 也返此 body(id=目标 projectId;与 CR-6 同 error 语义,客户端既有 409 archived 分支直接覆盖)。
 */
export type ArchivedBody = {
  error: 'archived'
  id: string
}

/**
 * SG-2(server 端 archived project 删除门禁,defense-in-depth):DELETE /api/projects/:id 命中
 * 「status='archived' 的项目 + 其下存在 status!=='archived' 的 live 子画布」→ 409 返此 body
 * (与 client deleteProject blocked reason 'active-child' 同语义:先恢复/归档所有活跃子画布再彻底删除)。
 * active project 的正常删除(整树软删)语义不变,不触发此门禁。
 */
export type ActiveChildBody = {
  error: 'active-child'
  id: string
}

/** 统一错误体(任一 4xx)。 */
export type ApiErrorBody =
  | { error: 'bad-request'; message?: string }
  | { error: 'method-not-allowed' }
  | ConflictBody
  | TooLargeBody
  | PreconditionRequiredBody
  | BadMivoKeyBody
  | ForbiddenKeyBody
  | ForbiddenValueBody
  | ReuseConflictBody
  | PayloadRejectedBody
  | UnknownResourceBody
  | RequireLoginBody
  | ArchivedBody
  | ActiveChildBody
  | { error: 'project-exists'; id: string }
  // F4:canvas id 全局唯一(与 project 同模式)——跨 owner 同 canvas id → 409 canvas-exists。
  | { error: 'canvas-exists'; id: string }

// ── Project(record-schema §4.1)─────────────────────────────────────────────────

export type Project = {
  id: string
  name: string
  ownerId: string
  createdAt: string
  updatedAt: string
  revision: Revision
  isDeleted: boolean
  /** D1(Phase 2 归档):status 列(缺省/undefined=active)。wire optional 向后兼容。 */
  status?: RecordStatus
}

export type ListProjectsResponse = { projects: Project[] }
export type CreateProjectRequest = { id?: string; name: string; status?: RecordStatus }
/**
 * G1-a P1-2:PATCH /api/projects/:id body(projects.ts:185)。rename 走此;If-Match = Project.revision base
 * (missing → 428 / invalid → 400 / stale → 409 revision-conflict)。wire body 不携带 revision。
 */
export type UpdateProjectRequest = { name?: string }

// ── Canvas(api-surface §4.2)─────────────────────────────────────────────────────

export type CreateCanvasRequest = {
  id?: string
  projectId: string
  title?: string
  sourceTemplateId?: string
  /** D2(Phase 2 归档):create wire 可选 status(combineOps create+archive→create(status:'archived') 语义)。 */
  status?: RecordStatus
}

/**
 * Canvas meta wire shape(返修 #5 + #8)。
 * - `metaRevision`:canvas meta record 的 envelope revision(PUT /api/canvas/:id 的 If-Match base)。
 * - `contentVersion`:content(children)版本号——每次**共享**子资源(node/edge/anchor)写入 backend bump,
 *   客户端据此探测 content 是否变化(与 metaRevision 独立,防止 meta 与 content 双真相混淆)。
 *   **DP-6R(P1-2)**:`chat-message` 是 per-actor 私有,写入/reorder **不 bump** 此 contentVersion
 *   (chat 非共享画布内容);chat reorder 的乐观锁走独立的 per-actor×canvas `orderRevision`
 *   (见 ListChatMessagesResponse),与共享 contentVersion 解耦——node 写不使 chat reorder 误 409。
 * - `sourceTemplateId`/`createdAt`/`move`(返修 #8 API 面补全,对齐 documentMeta)。
 *
 * A2-S3(§14.7/§10.2「hydrate snapshot 签发 base + bundle + since」):
 * - `bundle`:opaque canvas 级 SnapshotCursor bundle 字符串(server encodeBundle 签发,内含 recordId→
 *   BaseCursor 映射 + order cursor + since cursor;client 不读内部,作 events/poll catch-up 的 cursor
 *   透传)。optional(Plan C 渐进)。
 * - `sinceSeq`:canvas 事件 seq(数字,供 client 构建 bundle 的 since 项 + GET /events/poll?since=<seq>
 *   增量补拉;非连续,取 server 权威值)。optional(Plan C 渐进)。
 */
export type CanvasMeta = {
  id: string
  projectId: string
  title: string
  sourceTemplateId?: string
  createdAt: string
  updatedAt: string
  metaRevision: Revision
  contentVersion: Revision
  /** A2-S3:opaque canvas 级 bundle cursor(server encodeBundle 签发;client 透传 events/poll)。 */
  bundle?: string
  /** A2-S3:canvas 事件 seq(client 构建 since cursor + events/poll?since=<seq> 补拉)。 */
  sinceSeq?: number
  /** D1(Phase 2 归档):status 列(缺省/undefined=active)。wire optional 向后兼容。 */
  status?: RecordStatus
}

/**
 * GET /api/canvas/:id 全量响应。每 child record 返 envelope id + revision + orderKey(信封列 canonical,
 * DP-5 + 返修 #6)+ 不透明 payload(NodeRecord/EdgeRecord/AnchorRecord,客户端 narrow)。
 * per-record revision 让客户端下次 PATCH 带正确 If-Match(base = 该 envelope revision)。
 * payload 内 NodeRecord.revision 是客户端镜像,客户端读时 sync = envelope revision,不双写(返修 #5)。
 *
 * A2-S3(§14.7/§10.2「hydrate snapshot 签发 base」):每 record 附 `base` = opaque BaseCursor
 * 字符串(server encodeBase 签发,绑 canvasId+recordId+revision+per-field clock snapshot)。client 不读
 * 内部,回传 PATCH/DELETE 的 If-Match。pre-existing record hydrate 后即有 base → 首次 edit/delete 不再
 * 缺 If-Match(428)/不再需 refetch-mint。optional(Plan C 渐进;旧 client 不读此字段不 break)。
 */
export type RecordEntry = { id: string; revision: Revision; orderKey: number; payload: unknown; base?: string }

export type GetCanvasResponse = CanvasMeta & {
  nodes: RecordEntry[]
  edges: RecordEntry[]
  anchors: RecordEntry[]
}

/** 返修 #8:canvas 枚举(按 project/owner)。 */
export type ListCanvasResponse = { canvases: CanvasMeta[] }

/**
 * G1-a P1-2:canvas meta wire payload(PUT /api/canvas/:id body = { payload: CanvasPayload },canvas.ts:284)。
 * - `projectId` 可改(move;move 双端 owner-only authz,canvas.ts:311-329)。
 * - `title`/`sourceTemplateId` 可改;`contentVersion` 由 backend bump(wire body 不携带,与 metaRevision 同走 If-Match)。
 * wire body 不携带 metaRevision/metaRevision base 走 If-Match(missing → 428 / stale → 409)。
 */
export type CanvasPayload = {
  projectId: string
  title?: string
  sourceTemplateId?: string
}

/** PUT /api/canvas/:id body(与 node/edge/anchor PATCH 同 UpsertRequest<{payload}> 形状)。 */
export type UpdateCanvasRequest = { payload: CanvasPayload }

/** POST /api/canvas → 201/200 CanvasMeta(createCanvas 返回类型与 listCanvas 元素同 shape)。 */
export type CreateCanvasResponse = CanvasMeta

// ── Phase 2 归档(回收站):archive/unarchive 端点 wire 契约 ──────────────────────────
// POST /api/canvas/:id/archive|unarchive  → 200 CanvasMeta(更新后的 canvas meta;archived=可读不可写子记录)
// POST /api/project/:id/archive|unarchive → 200 Project(级联:archiveProject 归档其全部子画布;
//   unarchiveProject 仅恢复 archivedByCascade=true 的子画布,用户先前单独归档的不被强制恢复——D3)
// 既有 DELETE /api/canvas/:id、DELETE /api/project/:id 保留为"彻底删除"(沿用 is_deleted 软删终态)。
// archive/unarchive 动作语义在 path(空请求体);幂等:重复 archive 已归档 → 200 no-op。
// 鉴权:action=manage(owner-only,与 DELETE 同矩阵)。
/** archive/unarchive 请求体(空——动作在 path;镜像 DELETE 无 body 约定)。 */
export type ArchiveRequest = Record<string, never>
/** archive/unarchive 响应(单 record meta;canvas→CanvasMeta,project→Project)。 */
export type ArchiveCanvasResponse = CanvasMeta
export type ArchiveProjectResponse = Project
/**
 * 列表端点 includeArchived 查询参数(GET /api/projects、GET /api/canvas[?projectId=…]):
 * - 缺省/false:仅返 active(非 archived)+ 非 deleted(默认视图,归档项隐藏)。
 * - true:返 active + archived(非 deleted);回收站"已归档"视图拉取。deleted 始终排除(除非走 internal includeDeleted)。
 * wire 是 query string(`?includeArchived=true`),非 body;此处仅冻结语义供 client/server 对齐。
 */

// ── chat 子资源(DP-6,api-surface §4.2.3)──────────────────────────────────────

/** POST /api/canvas/:id/chat。ChatMessage 17 字段不在此展开(payload 不透明)。 */
export type CreateChatMessageRequest = { message: unknown }

/** G1-a chat 接线(DP-6R P1-1):PATCH /api/canvas/:id/chat/:msgId body(与 node/edge/anchor PATCH 同 UpsertRequest<{payload}> 形状)。If-Match = msg envelope revision。 */
export type UpdateChatMessageRequest = { payload: unknown }

/**
 * GET /api/canvas/:id/chat 响应(DP-6R:per-actor collection)。
 *
 * `orderRevision`:**per-actor×canvas chat collection 的独立乐观锁 cursor**(DP-6R P1-2 真乐观锁)。
 *   - 客户端读此值作为下次 `POST /api/canvas/:id/reorder`(type=chat-message)的 **If-Match base**;
 *   - reorder 成功后,响应 `contentVersion` 字段携带 bump 后的新 orderRevision(client 据此更新本地 cursor);
 *   - reorder 同事务 compare(base !== current → 409 revision-conflict)+ bump → 同 base 两并发一成一败;
 *   - 与 canvas 共享 contentVersion **完全解耦**:node/edge/anchor 写入 bump 共享 cv 但**不**影响
 *     chat orderRevision → node 写不使 chat reorder 误 409;A/B(不同 actor)各自独立 cursor,互不冲突。
 *   - chat POST/PATCH/DELETE **不 bump** orderRevision(消息集合变化由 reorder 的 orderedIds 全等校验兜底,
 *     非 reorder 竞争);仅 chat reorder 自身 bump。
 */
export type ListChatMessagesResponse = { messages: RecordEntry[]; orderRevision: Revision }

// ── user-state(api-surface §4.3)────────────────────────────────────────────────

export type UserStateEntry = {
  key: string
  value: unknown
  revision: Revision
  updatedAt: string
  isDeleted: boolean
}

export type ListUserStateResponse = { entries: Record<string, UserStateEntry> }

/** 返修 #5:wire body 不携带 revision(rev base 走 If-Match)。 */
export type PutUserStateRequest = { value: unknown }

// ── DP-7 user-state 防御(返修 #9/N6:namespace allowlist + 每 namespace schema + 递归敏感扫描)──

/**
 * 返修 N6:frozen key 逐项 exact regex(含 canvas suffix)。每个 namespace 的合法 key 形式冻结,
 * 拒未知 suffix(如 `canvas:<id>:bogus` → forbidden-key)。canvasId/panelId 是 free-form(非冒号非空)。
 * - `canvas:<id>:selection`(array)/`canvas:<id>:camera`(object)/`canvas:<id>:chat-draft`(string)
 * - `recent:projects` / `recent:canvases`(array)
 * - `pref:tool` / `pref:brush` / `pref:stamp`(string)
 * - `panel:<panelId>`(boolean)
 * 两把 key(gateway-key/mivo-key)不在 frozen 集(天然拒);随机非 allowlist 前缀也拒。
 */
export const USER_STATE_KEY_FROZEN = [
  /^canvas:[^:]+:selection$/,
  /^canvas:[^:]+:camera$/,
  /^canvas:[^:]+:chat-draft$/,
  /^recent:projects$/,
  /^recent:canvases$/,
  /^pref:tool$/,
  /^pref:brush$/,
  /^pref:stamp$/,
  /^panel:[^:]+$/,
] as const

/** 兼容旧 API:namespace allowlist 前缀(粗粒度,route 仍可用;N6 frozen regex 是真校验)。 */
export const USER_STATE_KEY_NAMESPACES = ['canvas:', 'recent:', 'pref:', 'panel:'] as const

export const isUserStateKeyNamespaceAllowed = (key: string): boolean =>
  USER_STATE_KEY_FROZEN.some((re) => re.test(key))

/**
 * 返修 N6/F7:每 namespace/suffix 的 runtime value kind schema(不符 → 400 bad-request)。
 * F7:`canvas:<id>:selection` 只收 **string[]**(与 SessionStore 对齐),kind='string-array'
 * (array 且 every item 是 string);`recent:*` 仍收任意 array。
 */
export type UserStateValueKind = 'array' | 'string-array' | 'object' | 'string' | 'number' | 'boolean' | 'any'

export const userStateNamespaceKind = (key: string): UserStateValueKind => {
  if (/^canvas:[^:]+:selection$/.test(key)) return 'string-array'
  if (/^canvas:[^:]+:camera$/.test(key)) return 'object'
  if (/^canvas:[^:]+:chat-draft$/.test(key)) return 'string'
  if (/^recent:/.test(key)) return 'array'
  if (/^pref:/.test(key)) return 'string'
  if (/^panel:/.test(key)) return 'boolean'
  return 'any'
}

/**
 * 敏感字段名模式(返修 #9/N6:递归扫 value 拒敏感;大小写/连字符/camelCase 变体全覆盖)。
 * 命中字段名:secret/token/password/apiKey/gatewayKey/mivoKey/accessToken/auth/credential/privateKey 等。
 */
export const SENSITIVE_FIELD_PATTERN =
  /(secret|token|password|api[-_]?key|gateway[-_]?key|mivo[-_]?key|access[-_]?token|authorization|credential|private[-_]?key)/i

/**
 * 返修 N6:凭据格式值模式(mivo_ / sk- 前缀)。匹配在 normalize 后(URL-decode + lower-case),
 * 故 `MIVO_xxx` / `Sk-xxx` / URL 编码变体(`%6divo_xxx` → decode → `mivo_xxx`)均命中。
 */
const CREDENTIAL_VALUE_PREFIX = /^(mivo_|sk-)/

/**
 * 规范化字符串:URL-decode-to-fixed-point(循环至不再变化)+ lower-case。N6/F3 credential 扫描用。
 *
 * F3 返修六(fail-closed):六审两处 fail-open → fail-closed——
 *  1. 累计解码输出长度超 MAX_DECODE_TOTAL → 不返回部分结果。部分结果可能恰停在 credential 还原前一步:
 *     如 `%256divo_secret`+超长填充:pass1 → `%6divo_secret<pad>` 仍无 `mivo_` 前缀,旧实现返回该部分值
 *     → `isCredentialValue` 假阴性 → 漏报 200。改:超阈即视作命中(suspicious=true),调用方 route 400。
 *  2. malformed '%'(decodeURIComponent 抛 URIError,如尾部孤立 `%`):旧实现 catch 返 cur.toLowerCase()
 *     (raw/部分值),`%6divo_secret%` 停在 `%6divo_secret%`(无 `mivo_` 前缀)→ 漏报。改分段安全解码——
 *     逐 `%XX` 解析,合法 `%XX`(2 hex)照解,坏序列(孤立 `%`、`%` 后非 2 hex)原样保留 `%`,其余 1:1。
 *     故 `%6divo_secret%` → `mivo_secret%`(命中 `mivo_` 前缀);`%61piKey%` → `apiKey%`(命中敏感名 `apiKey`)。
 *
 * 取舍(两法选一,本实现选分段安全解码):分段解码坏 `%` 原样保留 + 合法 `%XX` 照解 → 能还原真实 credential
 * (合法 `%6d`→`m` 段仍被解)且不误伤干净的孤立 `%`(如 `"50% off"` 中的 `%` 保留 → 非 credential → 不拒)。
 * 反例整体 fail-closed(遇 malformed `%` 即视作可疑拒)更激进,但任何含孤立 `%` 的良性值(`"50%"`)都会被拒
 * → 误杀。分段解码只在超预算(suspicious)或真 credential 命中时拒,语义更精确,故选之。
 *
 * F3 多层编码:单次 decode 不够——`%2561piKey`→`%61piKey`→`apiKey`(2 层);`%252525252561piKey`→6 层→`apiKey`。
 * fixed-point 循环至不再变化收敛;decode 单调缩短(`%XX` 3→1,其余 1:1,孤立 `%` 1:1 保留),故正常输入
 * 收敛至无合法 `%XX` 即停;累计输出长度阈值(MAX_DECODE_TOTAL)兜底恶意超长/构造输入(超阈 suspicious)。
 */
const MAX_DECODE_TOTAL = 1_048_576 // 累计解码输出长度阈值(DoS 上限);decode 单调缩短,正常多层远不达

/** NormalizedScan:suspicious=true 表示累计解码超 MAX_DECODE_TOTAL(fail-closed,调用方视作命中)。 */
type NormalizedScan = { suspicious: boolean; value: string }

// 0-9 a-f A-F → 0-15;非 hex → -1
const hexValue = (cc: number): number => {
  if (cc >= 0x30 && cc <= 0x39) return cc - 0x30 // '0'-'9'
  if (cc >= 0x41 && cc <= 0x46) return cc - 0x41 + 10 // 'A'-'F'
  if (cc >= 0x61 && cc <= 0x66) return cc - 0x61 + 10 // 'a'-'f'
  return -1
}

/**
 * 分段安全 URL-decode:**永不抛**。逐 `%XX` 解析,合法 `%XX`(2 hex)→ 对应字节,坏序列(孤立 `%`、
 * `%` 后非 2 hex)→ 原样保留 `%`,其余字符 1:1。decodeURIComponent 遇 malformed `%` 抛 URIError,本函数兜底。
 * credential 扫描只关心 ASCII 前缀(`mivo_`/`sk-`/`apiKey`/`secret`/...),逐字节解码不影响 ASCII 模式匹配;
 * 合法输入(含多字节 UTF-8)走 decodeURIComponent(safeDecodeOnce 内,精确,与既有契约一致)。
 */
const decodeSegmented = (s: string): string => {
  let out = ''
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) === 0x25 /* '%' */ && i + 2 < s.length) {
      const h1 = hexValue(s.charCodeAt(i + 1))
      const h2 = hexValue(s.charCodeAt(i + 2))
      if (h1 >= 0 && h2 >= 0) {
        out += String.fromCharCode(h1 * 16 + h2)
        i += 3
        continue
      }
    }
    out += s[i]
    i += 1
  }
  return out
}

/**
 * 单次安全 decode:合法输入走 decodeURIComponent(精确,含多字节 UTF-8,与既有契约一致);
 * malformed `%` 抛 URIError 时兜底分段解码(不抛,坏 `%` 保留 + 合法 `%XX` 照解)。
 */
const safeDecodeOnce = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return decodeSegmented(s)
  }
}

const normalizeForScan = (s: string): NormalizedScan => {
  let cur = s
  let total = s.length
  for (;;) {
    const next = safeDecodeOnce(cur)
    if (next === cur) return { suspicious: false, value: cur.toLowerCase() } // fixed point(无合法 %XX 或已收敛)
    total += next.length
    if (total > MAX_DECODE_TOTAL) return { suspicious: true, value: '' } // fail-closed:超预算视作命中(不返回部分结果漏报)
    cur = next
  }
}

/** 凭据格式值命中(规范后 mivo_/sk- 前缀)或 fail-closed suspicious(超预算)。N6:大小写/URL 编码变体均命中。 */
const isCredentialValue = (v: unknown): boolean => {
  if (typeof v !== 'string') return false
  const n = normalizeForScan(v)
  return n.suspicious || CREDENTIAL_VALUE_PREFIX.test(n.value)
}

/**
 * 递归扫描 value,返回首个敏感路径(无则 null)。
 * 返修 N6/F3:覆盖 object key(含 camelCase/连字符/前缀变体 + **URL 编码变体(含双重编码)**——每层 object key
 * 先 fixed-point decode+lower 再匹配,故 `{"%61piKey":...}` → `apiKey`、`{"%2561piKey":...}` → `%61piKey`→`apiKey`
 * 均命中)+ 嵌套对象/数组 + 字符串值格式(规范后大小写/URL 编码变体均命中)。返回的 path 是 **raw key**(未 decode),
 * 与既有契约测试('api-key'/'userApiKey' path)一致。
 */
export const scanForSensitiveFields = (value: unknown, prefix = ''): string | null => {
  if (value === null || typeof value !== 'object') {
    // 字符串值:规范后形如 mivo_/sk- 前缀 → 拒(凭据格式值,大小写/URL 编码变体均命中)
    if (isCredentialValue(value)) {
      return prefix || '<value>'
    }
    return null
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForSensitiveFields(value[i], `${prefix}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // F3:object key 先 best-effort decode+lower 再匹配(防 %61piKey → apiKey 编码绕过);
    // fail-closed:suspicious(超预算)key 视作命中(防深度编码藏敏感名,超预算即拒,不返回部分结果漏报)。
    const nk = normalizeForScan(k)
    if (nk.suspicious || SENSITIVE_FIELD_PATTERN.test(nk.value)) return prefix ? `${prefix}.${k}` : k
    const hit = scanForSensitiveFields(v, prefix ? `${prefix}.${k}` : k)
    if (hit) return hit
  }
  return null
}

/**
 * F3:完整 user-state key(含 free-form canvasId/panelId 段)做同一 credential 扫描。
 * key 按 `:` 切段,每段 fixed-point decode+lower 后查 mivo_/sk- 前缀;任一段命中 → 返该段(非 null)。
 * 例:`canvas:mivo_xxx:selection` → 'mivo_xxx';`canvas:%6divo_xxx:selection` → decode → 'mivo_xxx';
 * `canvas:%256divo_xxx:selection` → 双重 decode → 'mivo_xxx';`canvas:%2553k-test:selection` → 'sk-test';
 * `canvas:c1:selection` → null(c1/selection 非 credential)。frozen namespace allowlist 通过的 key
 * 仍可能 embed credential 段,此函数在 namespace 通过后补刀(防 key 里藏凭据)。
 */
export const scanUserStateKeyForCredential = (key: string): string | null => {
  for (const seg of key.split(':')) {
    if (isCredentialValue(seg)) return seg
  }
  return null
}

// ── DP-7 旧排除清单(向后兼容,namespace allowlist 已覆盖两把 key,此处保留值扫描兜底)──
export const USER_STATE_FORBIDDEN_KEY_NAMES = new Set(['gateway-key', 'mivo-key'])
export const USER_STATE_FORBIDDEN_KEY_PATTERN = /(secret|token|password|apikey)/i
export const isUserStateKeyForbidden = (key: string): boolean =>
  USER_STATE_FORBIDDEN_KEY_NAMES.has(key.toLowerCase()) ||
  USER_STATE_FORBIDDEN_KEY_PATTERN.test(key)

// ── 返修 #8/N9:asset seam(引用 T1.5 PR #195 已实现的真实 wire shape,不重复实现)──
/**
 * POST /api/assets → 200(shape 引自 server/routes/assets.ts,#195)。
 * refcount = references.length(内容寻址:同 content hash → 同 assetId,bytes 复用,引用计数 = 该 asset
 * 被多少 record 引用)。
 */
export type CreateAssetResponse = {
  assetId: string
  mimeType: string
  originalName: string
  sizeBytes: number
  refcount: number
  deduped: boolean
}
/**
 * 返修 N9:resolve seam 返回 bytes+mime(内容寻址 GET /api/assets/:id → 200 content bytes,
 * immutable, Cache-Control: private,owner-scoped;跨 owner GET → 404),**不返 AssetRef 元数据**。
 * env gate(MIVO_ENABLE_ASSET_SERVICE=1,默认关 → 404);owner 404;private cache;refcount=references.length。
 */
export type ResolvedAsset = {
  bytes: Uint8Array
  mimeType: string
}

// ── G1-a P1-2:asset attach/detach wire seam(冻结契约 + route + defer 边界)──
// assetStore.ts 的 attachRef/detachRef 已实现(内容寻址 + refcount = references.length + owner-checked),
// 但无 HTTP 入口。G1-a 冻结 client↔route wire 契约:ownerFp 由服务端从 key 派生(client 不传);
// contentHash/assetId 在 URL path;nodeId 在 body。节点生命周期 attach/detach 调用方属 G1-c(node mutation),
// 本轮只冻结 wire shape + route + adapter 方法 + executor op,不接 node 生命周期写(defer 边界)。
/**
 * POST /api/assets/:assetId/attach body。ownerFp 服务端派生(client 不可指定,防越权 attach 他人 asset)。
 * 幂等:同 (assetId, nodeId) 已存在 → 'already-attached'(assetStore attachRef 语义)。
 */
export type AttachAssetRequest = { nodeId: string }

/**
 * POST /api/assets/:assetId/detach body。ownerFp 服务端派生;跨 owner detach → 'owner-mismatch'(decidable,不静默)。
 * 幂等:ref 不存在 → 'already-detached'。
 */
export type DetachAssetRequest = { nodeId: string }

export type AttachAssetResult =
  | { kind: 'attached' } // 新引用插入
  | { kind: 'already-attached' } // 幂等:(assetId, nodeId) 已存在
  | { kind: 'missing' } // 无 record/bytes — attach 拒(decidable,不静默)

export type DetachAssetResult =
  | { kind: 'detached' } // 引用移除
  | { kind: 'already-detached' } // 幂等:引用本不存在
  | { kind: 'missing' } // 无 record
  | { kind: 'owner-mismatch' } // 跨 owner 非法 detach(decidable)

// ── 返修 #13/N10:NodeRecord payload 白名单(envelope 镜像字段 + status/tasks 拒收 + 逐 type schema)──
/**
 * envelope 镜像字段(payload 不该携带,防双真相/绕过)。出现 → 400 payload-rejected(mirror-field)。
 * **N1 修订**:`createdAt` **不在此列**——Edge/Anchor 的 createdAt 是 canonical 域字段(保留,走 allowed-keys
 * 放行;Node 无此域字段,Node payload 带 createdAt 由 unknown-field 拒)。
 * `revision` 在此列(envelope 唯一真相,wire payload 不携带;出现 → mirror-field)。
 * id/type 不在此列(NodeRecord 身份字段;payload.id 用于与 path 一致性校验 #5/N10)。
 */
export const PAYLOAD_MIRROR_FIELDS = new Set([
  'ownerId',
  'canvasId',
  'scope',
  'revision',
  'isDeleted',
  'updatedAt',
  'orderKey',
])

/** DP-8/9 显式拒收字段(record 不存 status/tasks,防客户端塞运行态/编排态进 document payload)。 */
export const PAYLOAD_FORBIDDEN_FIELDS = new Set(['status', 'tasks'])

/** 返修 #4:HTTP header 常量(两端共享,防字符串漂移)。If-Match 为 revision base 唯一来源。 */
export const IF_MATCH_HEADER = 'if-match'
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
export const MIVO_API_KEY_HEADER = 'x-mivo-api-key'

// ── 返修 N5:If-Match 严格十进制非负 safe integer parse ───────────────────────────
/**
 * 返修 N5:If-Match = 十进制非负 safe integer(正则 ^(0|[1-9][0-9]*)$ + Number.isSafeInteger)。
 * 1.5 / 1e2 / 0x10 / NaN / 负数 / 超界(Number.MAX_SAFE_INTEGER 之上)/ 前导空格等全拒。
 * 区分 missing(无 header → route 决 428)vs invalid(有 header 但格式错 → route 决 400 bad-request)。
 */
const IF_MATCH_DECIMAL_RE = /^(0|[1-9][0-9]*)$/

export type IfMatchParse =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'value'; revision: Revision }

export const parseIfMatch = (ifMatch: string | undefined): IfMatchParse => {
  if (ifMatch === undefined || ifMatch === '') return { kind: 'missing' }
  if (!IF_MATCH_DECIMAL_RE.test(ifMatch)) return { kind: 'invalid' }
  const n = Number(ifMatch)
  if (!Number.isSafeInteger(n) || n < 0) return { kind: 'invalid' }
  return { kind: 'value', revision: n }
}

/**
 * 返修 #4/N5:base revision 解析(向后兼容别名)。missing/invalid 均 → undefined(由 route 用
 * `parseIfMatch` 区分 428 vs 400;此 helper 仅给旧调用方,不区分)。严格十进制 + safe integer。
 */
export const resolveBaseRevision = (ifMatch: string | undefined): Revision | undefined => {
  const parsed = parseIfMatch(ifMatch)
  return parsed.kind === 'value' ? parsed.revision : undefined
}

// ── 返修 N1/N10:逐 type payload schema(allowed keys + required + 类型校验)+ encoder/decoder ──

/** NodePayload 合法 key 集(keyof Omit<NodeRecord,'id'|'revision'>;编译期 exhaustiveness 检查保无漂移)。 */
export const NODE_PAYLOAD_KEYS = [
  'type', 'title', 'transform', 'fills', 'strokes', 'effects', 'layout', 'constraints', 'asset',
  'relations', 'text', 'fontSize', 'textColor', 'fontWeight', 'textAlign', 'textAutoWidth',
  'markupKind', 'markupBrushKind', 'markupStampKind', 'markupPoints', 'markupStartArrow',
  'markupEndArrow', 'markupCornerRadius', 'sectionTitleVisible', 'sectionLockMode', 'sectionTemplateId',
  'markdownDisplayMode', 'imageHasTransparency', 'assetSourceDimensions', 'imageCrop', 'sourceNodeId',
  'groupId', 'locked', 'hidden', 'favorited', 'generation', 'aiWorkflow', 'experimentalAnchors',
  'annotationBounds',
] as const satisfies ReadonlyArray<keyof NodePayload>

/** EdgePayload 合法 key 集。createdAt 是 canonical 域字段(保留)。 */
export const EDGE_PAYLOAD_KEYS = ['from', 'to', 'type', 'prompt', 'createdAt'] as const satisfies ReadonlyArray<keyof EdgePayload>

/** AnchorPayload 合法 key 集。createdAt 是 canonical 域字段(保留)。 */
export const ANCHOR_PAYLOAD_KEYS = [
  'type', 'targetNodeId', 'x', 'y', 'instruction', 'createdAt', 'width', 'height', 'resultNodeIds',
] as const satisfies ReadonlyArray<keyof AnchorPayload>

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number'
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isArr = (v: unknown): v is unknown[] => Array.isArray(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isStrEnum = (values: Set<string>) => (v: unknown): v is string => isStr(v) && values.has(v)

const NODE_TYPE_VALUES = new Set([
  'image', 'task-placeholder', 'text', 'frame', 'ai-slot', 'annotation', 'markup', 'markdown', 'pdf', 'video',
])
const EDGE_TYPE_VALUES = new Set(['generate', 'edit'])
// F6 返修五:anchor type + markup/stamp/section/markdown 枚举从 src/types 单一来源导出(别手抄字符串表)。
const ANCHOR_TYPE_VALUES = new Set(EXPERIMENTAL_ANCHOR_TYPE_VALUES)
const MARKUP_KIND_SET = new Set(MARKUP_KIND_VALUES)
const MARKUP_BRUSH_KIND_SET = new Set(MARKUP_BRUSH_KIND_VALUES)
const CANVAS_STAMP_KIND_SET = new Set(CANVAS_STAMP_KIND_VALUES)
const SECTION_LOCK_MODE_SET = new Set(SECTION_LOCK_MODE_VALUES)
const MARKDOWN_DISPLAY_MODE_SET = new Set(MARKDOWN_DISPLAY_MODE_VALUES)

// F6:编译期 exhaustiveness——NodeRecord/EdgeRecord/AnchorRecord 加字段必须同步 *_PAYLOAD_KEYS,
// 否则下一行类型 = never,赋值 true 编译失败(Exclude<keyof Payload, KEYS[number]> extends never 模式:
// 加字段不进 KEYS 数组 → Exclude 非 never → 条件类型 = never → true 不可赋值 → 编译报错)。
export const NODE_PAYLOAD_EXHAUSTIVE: [Exclude<keyof NodePayload, (typeof NODE_PAYLOAD_KEYS)[number]>] extends [never]
  ? true
  : never = true
export const EDGE_PAYLOAD_EXHAUSTIVE: [Exclude<keyof EdgePayload, (typeof EDGE_PAYLOAD_KEYS)[number]>] extends [never]
  ? true
  : never = true
export const ANCHOR_PAYLOAD_EXHAUSTIVE: [Exclude<keyof AnchorPayload, (typeof ANCHOR_PAYLOAD_KEYS)[number]>] extends [never]
  ? true
  : never = true

// F6:递归 exact schema DSL——scalar(叶类型)/object(固定 key,exact 拒 unknown)/array(逐元素)/
// union(kind|type 判别联合)。validateCheck 递归遍历,返首个 {reason,field}(path 点号 + 数组下标)。
// 覆盖 record-schema §3 全部固定对象/判别 union/数组:transform/fills(strokes/effects 判别)/layout/
// constraints/asset/relations/generation.maskBounds+maskSourceSize/aiWorkflow/markupPoints/experimentalAnchors/
// annotationBounds/imageCrop/assetSourceDimensions ——逐层 unknown 拒、required nested、元素类型全覆盖。
type Check =
  | { readonly t: 'scalar'; readonly test: (v: unknown) => boolean }
  | { readonly t: 'object'; readonly fields: Readonly<Record<string, Check>>; readonly required?: readonly string[] }
  | { readonly t: 'array'; readonly element: Check }
  | { readonly t: 'union'; readonly tag: string; readonly variants: Readonly<Record<string, Check>> }

const scalar = (test: (v: unknown) => boolean): Check => ({ t: 'scalar', test })
const obj = (fields: Record<string, Check>, required?: readonly string[]): Check => ({ t: 'object', fields, required })
const arr = (element: Check): Check => ({ t: 'array', element })
const union = (tag: string, variants: Record<string, Check>): Check => ({ t: 'union', tag, variants })

const MARKUP_STROKE_STYLE_VALUES = new Set(MARKUP_STROKE_STYLE_CONST)
const CONNECTOR_ANCHOR_VALUES = new Set(['center', 'top', 'right', 'bottom', 'left'])
const LAYOUT_MODE_VALUES = new Set(['none', 'auto'])
const LAYOUT_DIRECTION_VALUES = new Set(['horizontal', 'vertical'])
const CONSTRAINT_HORIZONTAL_VALUES = new Set(['left', 'right', 'left-right', 'center', 'scale'])
const CONSTRAINT_VERTICAL_VALUES = new Set(['top', 'bottom', 'top-bottom', 'center', 'scale'])
const FILL_SCALE_MODE_VALUES = new Set(['fill', 'fit', 'crop', 'tile'])
const AI_WORKFLOW_KIND_VALUES = new Set(['slot', 'annotation', 'result'])
const AI_WORKFLOW_STATUS_VALUES = new Set(['empty', 'queued', 'generating', 'ready', 'failed', 'canceled'])
const AI_WORKFLOW_OPERATION_VALUES = new Set([
  'slot-generation', 'beside-generation', 'annotation-edit', 'variation', 'prompt-edit',
  'area-edit', 'remove-background', 'outpaint', 'upscale',
])
const AI_WORKFLOW_PLACEMENT_VALUES = new Set(['slot', 'right', 'left', 'below'])

// §3.1 transform {x,y,width,height,rotation} / §3.10 annotationBounds + imageCrop + maskBounds {x,y,width,height}
const TRANSFORM: Check = obj(
  { x: scalar(isNum), y: scalar(isNum), width: scalar(isNum), height: scalar(isNum), rotation: scalar(isNum) },
  ['x', 'y', 'width', 'height', 'rotation'],
)
const RECT: Check = obj(
  { x: scalar(isNum), y: scalar(isNum), width: scalar(isNum), height: scalar(isNum) },
  ['x', 'y', 'width', 'height'],
)
// §3.5 assetSourceDimensions / §3.7 generation.maskSourceSize {width,height}
const DIMENSIONS: Check = obj({ width: scalar(isNum), height: scalar(isNum) }, ['width', 'height'])
// §3.6 ConnectorBinding {nodeId, anchor, offset?}
const CONNECTOR_BINDING: Check = obj(
  { nodeId: scalar(isStr), anchor: scalar(isStrEnum(CONNECTOR_ANCHOR_VALUES)), offset: scalar(isNum) },
  ['nodeId', 'anchor'],
)
// §3.2 fills = solid | image(kind 判别不可变)
const FILL_ELEMENT: Check = union('kind', {
  solid: obj(
    { id: scalar(isStr), kind: scalar(isStrEnum(new Set(['solid']))), color: scalar(isStr), opacity: scalar(isNum), visible: scalar(isBool) },
    ['id', 'kind', 'color', 'opacity', 'visible'],
  ),
  image: obj(
    {
      id: scalar(isStr), kind: scalar(isStrEnum(new Set(['image']))), assetUrl: scalar(isStr),
      opacity: scalar(isNum), visible: scalar(isBool), scaleMode: scalar(isStrEnum(FILL_SCALE_MODE_VALUES)),
    },
    ['id', 'kind', 'assetUrl', 'opacity', 'visible', 'scaleMode'],
  ),
})
// §3.3 strokes {id,color,width,style,opacity,visible}
const STROKE_ELEMENT: Check = obj(
  {
    id: scalar(isStr), color: scalar(isStr), width: scalar(isNum),
    style: scalar(isStrEnum(MARKUP_STROKE_STYLE_VALUES)), opacity: scalar(isNum), visible: scalar(isBool),
  },
  ['id', 'color', 'width', 'style', 'opacity', 'visible'],
)
// §3.4 effects = shadow | blur(kind 判别不可变)
const EFFECT_ELEMENT: Check = union('kind', {
  shadow: obj(
    {
      id: scalar(isStr), kind: scalar(isStrEnum(new Set(['shadow']))), color: scalar(isStr),
      x: scalar(isNum), y: scalar(isNum), blur: scalar(isNum), spread: scalar(isNum),
      opacity: scalar(isNum), visible: scalar(isBool),
    },
    ['id', 'kind', 'color', 'x', 'y', 'blur', 'spread', 'opacity', 'visible'],
  ),
  blur: obj(
    { id: scalar(isStr), kind: scalar(isStrEnum(new Set(['blur']))), radius: scalar(isNum), visible: scalar(isBool) },
    ['id', 'kind', 'radius', 'visible'],
  ),
})
// §2.7 markupPoints {x,y,pressure?}
const MARKUP_POINT: Check = obj({ x: scalar(isNum), y: scalar(isNum), pressure: scalar(isNum) }, ['x', 'y'])
// §3.9 anchor variant(ExperimentalAnchor / AnchorRecord;type 判别 union——F6 返修五:
// box 必填 width+height,point 拒 box 专属字段 width/height。point anchor 带 width → unknown-field 400;
// box anchor 缺 width/height → missing-field 400;type 不在 variants → unknown-field 400。
// experimentalAnchors 元素(带 id)与顶层 anchor wire payload(Omit id)共用 fields,仅 id required 差异。)
const ANCHOR_POINT_FIELDS: Record<string, Check> = {
  id: scalar(isStr), type: scalar(isStrEnum(ANCHOR_TYPE_VALUES)), targetNodeId: scalar(isStr),
  x: scalar(isNum), y: scalar(isNum), instruction: scalar(isStr), createdAt: scalar(isNum),
  resultNodeIds: arr(scalar(isStr)),
}
const ANCHOR_BOX_FIELDS: Record<string, Check> = {
  id: scalar(isStr), type: scalar(isStrEnum(ANCHOR_TYPE_VALUES)), targetNodeId: scalar(isStr),
  x: scalar(isNum), y: scalar(isNum), instruction: scalar(isStr), createdAt: scalar(isNum),
  width: scalar(isNum), height: scalar(isNum), resultNodeIds: arr(scalar(isStr)),
}
// ANCHOR_ELEMENT:node 内嵌 experimentalAnchors 元素(id 必填,ExperimentalAnchor.id)。
const ANCHOR_ELEMENT: Check = union('type', {
  point: obj(ANCHOR_POINT_FIELDS, ['id', 'type', 'targetNodeId', 'x', 'y', 'instruction', 'createdAt']),
  box: obj(ANCHOR_BOX_FIELDS, ['id', 'type', 'targetNodeId', 'x', 'y', 'instruction', 'createdAt', 'width', 'height']),
})
// ANCHOR_WIRE_ELEMENT:顶层 anchor wire payload(id 来自 path,Omit;variant required 不含 id,spec 放行 id optional)。
const ANCHOR_WIRE_ELEMENT: Check = union('type', {
  point: obj(ANCHOR_POINT_FIELDS, ['type', 'targetNodeId', 'x', 'y', 'instruction', 'createdAt']),
  box: obj(ANCHOR_BOX_FIELDS, ['type', 'targetNodeId', 'x', 'y', 'instruction', 'createdAt', 'width', 'height']),
})
// §3.5 asset {url, mimeType?, originalName?, sizeBytes?}
const ASSET_REF: Check = obj(
  { url: scalar(isStr), mimeType: scalar(isStr), originalName: scalar(isStr), sizeBytes: scalar(isNum) },
  ['url'],
)
// §3.6 relations = NodeRelations Omit aiWorkflow {parentIds?, sectionId?, targetNodeId?, connectorStart?, connectorEnd?}
const RELATIONS: Check = obj({
  parentIds: arr(scalar(isStr)), sectionId: scalar(isStr), targetNodeId: scalar(isStr),
  connectorStart: CONNECTOR_BINDING, connectorEnd: CONNECTOR_BINDING,
})
// §2.8 layout {mode, direction?, gap?, padding?{top,right,bottom,left}}
const LAYOUT: Check = obj(
  {
    mode: scalar(isStrEnum(LAYOUT_MODE_VALUES)), direction: scalar(isStrEnum(LAYOUT_DIRECTION_VALUES)),
    gap: scalar(isNum),
    padding: obj(
      { top: scalar(isNum), right: scalar(isNum), bottom: scalar(isNum), left: scalar(isNum) },
      ['top', 'right', 'bottom', 'left'],
    ),
  },
  ['mode'],
)
// §2.3 constraints {horizontal?, vertical?}
const CONSTRAINTS: Check = obj({
  horizontal: scalar(isStrEnum(CONSTRAINT_HORIZONTAL_VALUES)),
  vertical: scalar(isStrEnum(CONSTRAINT_VERTICAL_VALUES)),
})
// §3.7 generation {prompt, model, size?, seed?, strength?, taskId?, createdAt?, maskBounds?, maskSourceSize?}
const GENERATION: Check = obj(
  {
    prompt: scalar(isStr), model: scalar(isStr), size: scalar(isStr), seed: scalar(isNum),
    strength: scalar(isNum), taskId: scalar(isStr), createdAt: scalar(isNum),
    maskBounds: RECT, maskSourceSize: DIMENSIONS,
  },
  ['prompt', 'model'],
)
// §3.8 aiWorkflow {kind, status?, operation?, prompt?, sourceNodeIds?, anchorNodeId?, annotationNodeId?, slotId?, placement?, createdAt?, progress?, stage?, startedAt?, elapsedSec?}
const AI_WORKFLOW: Check = obj(
  {
    kind: scalar(isStrEnum(AI_WORKFLOW_KIND_VALUES)), status: scalar(isStrEnum(AI_WORKFLOW_STATUS_VALUES)),
    operation: scalar(isStrEnum(AI_WORKFLOW_OPERATION_VALUES)), prompt: scalar(isStr),
    sourceNodeIds: arr(scalar(isStr)), anchorNodeId: scalar(isStr), annotationNodeId: scalar(isStr),
    slotId: scalar(isStr), placement: scalar(isStrEnum(AI_WORKFLOW_PLACEMENT_VALUES)),
    createdAt: scalar(isNum), progress: scalar(isNum), stage: scalar(isStr),
    startedAt: scalar(isNum), elapsedSec: scalar(isNum),
  },
  ['kind'],
)

// F6 逐 type 顶层 spec(object Check;id 允许但由 validateChildPayload 预校验 path 一致 → spec 放行 scalar(isStr))。
const PAYLOAD_SPECS: Record<'node' | 'edge' | 'anchor', Check> = {
  node: obj({
    id: scalar(isStr), type: scalar(isStrEnum(NODE_TYPE_VALUES)), title: scalar(isStr), transform: TRANSFORM,
    fills: arr(FILL_ELEMENT), strokes: arr(STROKE_ELEMENT), effects: arr(EFFECT_ELEMENT),
    layout: LAYOUT, constraints: CONSTRAINTS, asset: ASSET_REF, relations: RELATIONS, text: scalar(isStr),
    fontSize: scalar(isNum), textColor: scalar(isStr), fontWeight: scalar(isNum),
    textAlign: scalar((v) => isStr(v) && (v === 'left' || v === 'center' || v === 'right')),
    textAutoWidth: scalar(isBool), markupKind: scalar(isStrEnum(MARKUP_KIND_SET)), markupBrushKind: scalar(isStrEnum(MARKUP_BRUSH_KIND_SET)),
    markupStampKind: scalar(isStrEnum(CANVAS_STAMP_KIND_SET)), markupPoints: arr(MARKUP_POINT), markupStartArrow: scalar(isBool),
    markupEndArrow: scalar(isBool), markupCornerRadius: scalar(isNum), sectionTitleVisible: scalar(isBool),
    sectionLockMode: scalar(isStrEnum(SECTION_LOCK_MODE_SET)), sectionTemplateId: scalar(isStr), markdownDisplayMode: scalar(isStrEnum(MARKDOWN_DISPLAY_MODE_SET)),
    imageHasTransparency: scalar(isBool), assetSourceDimensions: DIMENSIONS, imageCrop: RECT,
    sourceNodeId: scalar(isStr), groupId: scalar(isStr), locked: scalar(isBool), hidden: scalar(isBool),
    favorited: scalar(isBool), generation: GENERATION, aiWorkflow: AI_WORKFLOW,
    experimentalAnchors: arr(ANCHOR_ELEMENT), annotationBounds: RECT,
  }, ['type', 'title', 'transform', 'fills', 'strokes', 'effects', 'relations']),
  edge: obj(
    { id: scalar(isStr), from: scalar(isStr), to: scalar(isStr), type: scalar(isStrEnum(EDGE_TYPE_VALUES)), prompt: scalar(isStr), createdAt: scalar(isNum) },
    ['from', 'to', 'type', 'prompt', 'createdAt'],
  ),
  anchor: ANCHOR_WIRE_ELEMENT,
}

/**
 * F6(schema-aware,lead 裁定 B):递归扫 status/tasks,但**仅在 schema 未定义该位置时**才拒;schema 合法字段(如
 * AI_WORKFLOW.status)放行,交 validateCheck 类型校验。envelope 防线语义保留:顶层 status/tasks(node schema 未定义)
 * 照拒、schema 未定义容器内藏匿 status(relations/layout/fills[0] 等)照拒。
 * 地面真因:旧版任意层拒 status 把 AI_WORKFLOW.status 这类合法 schema 字段也拒了 → #256 server cutover 后 Block 1
 *   ai-slot 占位 create(带 aiWorkflow.status)被 400 拒,slot 落库通道断(live 生产 bug)。schema-aware 后放行。
 */
const findForbiddenDeep = (check: Check, value: unknown, prefix: string): string | null => {
  switch (check.t) {
    case 'scalar':
      return null // 标量叶,无子字段
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const obj = value as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) {
        // F3-ter+ P2-1(五轮复审):own-property 判定——`in` 走原型链,Object.prototype 键(constructor/toString/
        //   hasOwnProperty)会命中 `k in check.fields`(plain object 继承 Object.prototype)→ 误判 schema 已定义 →
        //   递归 check.fields[k](= Object.prototype.constructor 函数,无 .t)→ default null,forbidden 扫描被绕过。
        //   Object.hasOwn 只判自有键,constructor 等落 else → unknown-field(PAYLOAD_FORBIDDEN_FIELDS 不含它们)。
        if (Object.hasOwn(check.fields, k)) {
          // schema 定义该字段:递归下钻(合法字段如 aiWorkflow.status 不拒,交 validateCheck 类型校验)
          const hit = findForbiddenDeep(check.fields[k] as Check, v, prefix ? `${prefix}.${k}` : k)
          if (hit) return hit
        } else {
          // schema 未定义该 key:status/tasks → forbidden(藏匿 envelope/runaway 字段);其余交 validateCheck unknown-field
          if (PAYLOAD_FORBIDDEN_FIELDS.has(k)) return prefix ? `${prefix}.${k}` : k
        }
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return null
      for (let i = 0; i < value.length; i++) {
        const hit = findForbiddenDeep(check.element, value[i], `${prefix}[${i}]`)
        if (hit) return hit
      }
      return null
    }
    case 'union': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const tagVal = (value as Record<string, unknown>)[check.tag]
      if (typeof tagVal !== 'string') return null // tag 缺/非 string 交 validateCheck
      // P2-1:own-property 判 variant——tagVal 为 'constructor'/'toString' 时 `check.variants[tagVal]` 走原型链
      //   命中 Object.prototype.constructor(函数,truthy)→ 旧 `if (!variant)` 不拒 → 递归函数 default → 不 forbidden;
      //   validateCheck 侧 `check.variants[tag]` 同样命中 → 函数 .t=undefined → assertNeverCheck throw → 500。
      //   hasOwn 只判自有 variant,未知 tag 交 validateCheck unknown-field(400,不 500)。
      if (!Object.hasOwn(check.variants, tagVal)) return null // tag 不在 variants 交 validateCheck unknown-field
      const variant = check.variants[tagVal] as Check
      return findForbiddenDeep(variant, value, prefix)
    }
    default:
      return null
  }
}

/** F6 递归校验结果(首个错;无则 null)。path 用点号 + 数组下标(如 fills[0].kind / generation.maskBounds.x)。 */
type FieldError = { reason: PayloadRejectedReason; field: string }

const assertNeverCheck = (x: never): never => {
  throw new Error(`validateCheck: unhandled Check variant ${JSON.stringify((x as { t: string }).t)}`)
}

const validateCheck = (check: Check, value: unknown, path: string): FieldError | null => {
  switch (check.t) {
    case 'scalar':
      return check.test(value) ? null : { reason: 'bad-type', field: path || '<root>' }
    case 'object': {
      if (!isObj(value)) return { reason: 'bad-type', field: path || '<root>' }
      // unknown nested key → unknown-field(§3 exact;先于 required/type,与 transform.bogus 测试一致)
      for (const k of Object.keys(value)) {
        // P2-1:own-property 判 schema 字段——防 Object.prototype 键(constructor 等)经 `in` 误命中 schema。
        if (!Object.hasOwn(check.fields, k)) return { reason: 'unknown-field', field: path ? `${path}.${k}` : k }
      }
      for (const req of check.required ?? []) {
        if (!Object.hasOwn(value, req)) return { reason: 'missing-field', field: path ? `${path}.${req}` : req }
      }
      for (const [k, sub] of Object.entries(check.fields)) {
        if (Object.hasOwn(value, k)) {
          const err = validateCheck(sub, value[k], path ? `${path}.${k}` : k)
          if (err) return err
        }
      }
      return null
    }
    case 'array': {
      if (!isArr(value)) return { reason: 'bad-type', field: path || '<root>' }
      for (let i = 0; i < value.length; i++) {
        const err = validateCheck(check.element, value[i], `${path}[${i}]`)
        if (err) return err
      }
      return null
    }
    case 'union': {
      if (!isObj(value)) return { reason: 'bad-type', field: path || '<root>' }
      // P2-1:own-property 判别 tag presence(防原型链);variant lookup 同用 hasOwn(防 constructor/toString 命中
      //   Object.prototype.constructor 函数 → truthy 误判 → 函数 .t=undefined → assertNeverCheck throw 500)。
      if (!Object.hasOwn(value, check.tag)) return { reason: 'missing-field', field: path ? `${path}.${check.tag}` : check.tag }
      const tag = value[check.tag]
      if (!isStr(tag)) return { reason: 'bad-type', field: path ? `${path}.${check.tag}` : check.tag }
      if (!Object.hasOwn(check.variants, tag)) return { reason: 'unknown-field', field: path ? `${path}.${check.tag}` : check.tag }
      const variant = check.variants[tag] as Check
      return validateCheck(variant, value, path)
    }
    default:
      return assertNeverCheck(check)
  }
}

export type PayloadCheck =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; body: PayloadRejectedBody }

/**
 * 返修 N1/N10/F6:真实 decoder——逐 type payload 递归 exact 白名单 runtime 校验。
 * - 必须是 object(非 null/array)→ not-object。
 * - `id`(若有)必须 string 且 === path(N10:非 string id → bad-id-type;不一致 → id-mismatch #5)。
 * - envelope 镜像字段(ownerId/canvasId/scope/revision/isDeleted/updatedAt/orderKey)→ mirror-field。
 *   注:`createdAt` 不在 mirror 拒收收集——Edge/Anchor 的 createdAt 是 canonical 域字段(spec 放行)。
 * - F6:**status/tasks 任意层递归拒**(findForbiddenDeep;在 schema 之前,与 N10 #13 测试一致)。
 * - F6 递归 exact schema(validateCheck):unknown nested key → unknown-field;缺必填 → missing-field;
 *   类型不符 → bad-type;数组逐元素(fills/strokes/effects/markupPoints/experimentalAnchors)、判别 union
 *   (fills solid|image / effects shadow|blur)、固定对象(generation.maskBounds/maskSourceSize/relations/
 *   aiWorkflow/transform/layout/constraints/asset/annotationBounds/imageCrop/assetSourceDimensions)全 exact。
 */
export const validateChildPayload = (
  type: 'node' | 'edge' | 'anchor',
  payload: unknown,
  pathId: string,
): PayloadCheck => {
  if (!isObj(payload)) {
    return { ok: false, body: { error: 'payload-rejected', reason: 'not-object' } }
  }
  const obj = payload
  // id 特殊(允许但须匹配 path;N10 非 string id → bad-id-type)
  // P2-1:own-property 判 id/mirror——防 payload 经原型链误命中(虽 JSON payload 仅自有键,统一 own-property 语义)。
  if (Object.hasOwn(obj, 'id')) {
    if (!isStr(obj.id)) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'bad-id-type', field: 'id' } }
    }
    if (obj.id !== pathId) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'id-mismatch', field: 'id' } }
    }
  }
  // envelope 镜像字段(含 revision)→ mirror-field
  for (const f of PAYLOAD_MIRROR_FIELDS) {
    if (Object.hasOwn(obj, f)) return { ok: false, body: { error: 'payload-rejected', reason: 'mirror-field', field: f } }
  }
  // F6(schema-aware,lead 裁定 B):status/tasks 仅在 schema 未定义处拒;schema 合法字段(aiWorkflow.status)放行。
  //   envelope 防线保留:顶层 status/tasks 照拒、schema 未定义容器内藏(relations.status / fills[0].tasks)照拒。
  const forbiddenPath = findForbiddenDeep(PAYLOAD_SPECS[type], obj, '')
  if (forbiddenPath) {
    return { ok: false, body: { error: 'payload-rejected', reason: 'forbidden-field', field: forbiddenPath } }
  }
  // F6 递归 exact schema(顶层 id 已预校验;spec 含 id:scalar(isStr) 放行,其余逐层 unknown/missing/type/元素)。
  const err = validateCheck(PAYLOAD_SPECS[type], obj, '')
  if (err) {
    return { ok: false, body: { error: 'payload-rejected', reason: err.reason, field: err.field } }
  }
  return { ok: true, payload: obj }
}

/**
 * F1-ter(T2.2 Block 2 五轮):顶层 required 字段集(从 PAYLOAD_SPECS[type].required 推导,不手写第二份)。
 * 供 server/lib/domainOp unsetByPath 的 isRequiredTopLevel 回调:删叶子后剪枝到顶层 required 字段时保留空壳
 * (如 relations:{} —— schema required 但 RELATIONS 无 required child,空 shell 合法;防 prune 掉 required 顶层 →
 * hydrate missing-field)。optional 顶层(asset/generation/aiWorkflow…)不在其中 → 照剪(F1-bis ② 行为不变)。
 */
export const requiredTopLevelFields = (type: 'node' | 'edge' | 'anchor'): readonly string[] => {
  const spec = PAYLOAD_SPECS[type]
  return spec.t === 'object' ? (spec.required ?? []) : []
}

/**
 * F2-ter(T2.2 Block 2 五轮):schema-aware fieldPath 终点分类(单一真相源,生产 + transport 两站共用)。
 * 遍历 PAYLOAD_SPECS[type] 的 Check schema 沿 fieldPath 下钻,返 FieldPathTarget:
 *  - 末段 string 命中 required array(fills/strokes/effects:required 根数组)→ 'container'(delete/set 都拒)
 *  - 末段 string 命中 optional array(aiWorkflow.sourceNodeIds/relations.parentIds)→ 'array-field'(delete 放行 set 拒)
 *  - 末段 string 命中 object/union(transform/asset/relations/generation…)→ 'container'(整子树 set/delete = clobber,拒)
 *  - 末段 string 命中 scalar(title/locked…)→ 'leaf'(set/delete-field 合法)
 *  - 末段 number → 'array-element'(数组元素位置;delete-field 结构性拒,set 拒——整元素替换)
 *  - 未知字段 / union 内深层(无 tag 值无法 schema 下钻)→ 'leaf'(port 对 schema 不透明处不拦未知;非法 set 由 structural/dam 兜底)
 * 与旧手写 classifier 的差异(lead 裁定 P2-2):fills/strokes/effects 从 'array-field'(delete 放行)升 'container'
 *   (delete/set 都拒)——required 根数组不可整体删;validateChildPayload dam 兜底保证 payload 合法。
 */
export const classifyFieldPathBySchema = (
  type: 'node' | 'edge' | 'anchor',
  fieldPath: readonly (string | number)[],
): FieldPathTarget => {
  let check: Check | undefined = PAYLOAD_SPECS[type]
  for (let i = 0; i < fieldPath.length; i++) {
    const seg = fieldPath[i]
    const isLast = i === fieldPath.length - 1
    if (typeof seg === 'number') {
      // 数组元素下标:末段 → 指向元素位置 'array-element';中段 → 下钻到数组 element。
      if (isLast) return 'array-element'
      if (!check || check.t !== 'array') return 'leaf' // 非数组上 number 段(防御):视 leaf
      check = check.element
      continue
    }
    // string 段:仅 object 变体可 schema 下钻;scalar/array(schema 已耗尽)/union(无 tag 值无法下钻)→ 视 leaf
    //   (port 对 schema 不透明处不拦未知;非法 set 由 structural 入口兜,非法 payload 由 validateChildPayload dam 兜底)。
    if (!check || check.t !== 'object') return 'leaf'
    if (!Object.hasOwn(check.fields, seg)) return 'leaf' // 未知字段:port 不拦未知,视 leaf(P2-1 own-property 判定)
    const isRequired = (check.required ?? []).includes(seg)
    const sub: Check = check.fields[seg]
    if (isLast) {
      if (sub.t === 'array') return isRequired ? 'container' : 'array-field'
      if (sub.t === 'object' || sub.t === 'union') return 'container'
      return 'leaf' // scalar
    }
    check = sub // 中段:下钻
  }
  return 'leaf'
}

/**
 * 返修 N1:真实 encoder(client)——canonical Record → wire payload(剥离 id + revision)。
 * 与 decoder(validateChildPayload)对称:wire payload 不携带 id/revision(id 取路径,revision 取 envelope)。
 * client 据此构造 PATCH body `{payload: encodeChildPayload(node)}`。
 */
export const encodeChildPayload = <T extends { id?: unknown; revision?: unknown }>(
  record: T,
): Omit<T, 'id' | 'revision'> => {
  // 浅拷贝 + delete id/revision(避免 destructure rest-sibling lint;wire payload 不携带 id/revision)。
  const rest = { ...record } as Record<string, unknown>
  delete rest.id
  delete rest.revision
  return rest as Omit<T, 'id' | 'revision'>
}
