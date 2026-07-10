// shared/persist-contract.ts
// T1.3 前置:四端点 + PersistAdapter 的 wire 契约(客户端 ↔ 服务端互锁)—— 返修版。
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
//  - payload 域类型(NodeRecord 等)在 src/kernel/records.ts,client 侧参数化,不进本共享层。

/** per-record revision(envelope 唯一真相,节点级合并 LWW tie-break,platform §13.5)。 */
export type Revision = number

/** scope 分层(platform §13.1)。asset 域见 T1.5,不入本契约。 */
export type PersistScope = 'document' | 'user'

/**
 * record 类型(信封 `type` 列,api-surface §0)。
 * `chat-collection`:per-canvas 的对话集合 envelope(返修 finding #2);collection 级软删标记,
 * message 不软删(硬删/编辑)。`chat-message` 是单条消息(活记录,不软删)。
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
  createdAt: string
  updatedAt: string
  payload: Payload
}

/**
 * 写请求(POST idempotent / PATCH 节点级 / PUT meta)。
 * 返修 #5:wire body 不携带 id/revision——id 来自 path,revision base 来自 If-Match header。
 * payload 不透明(NodeRecord 等),服务端对 node/edge/anchor 做 runtime 白名单 codec(返修 #11/#13)。
 */
export type UpsertRequest<Payload = unknown> = {
  payload: Payload
}

/** 写成功响应(201/200)。revision = post-bump(调用方免二次读)。 */
export type UpsertResponse = {
  id: string
  revision: Revision
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

/** 400 forbidden-key / forbidden-value(DP-7 user-state 排除清单服务端兜底,返修 #9)。 */
export type ForbiddenKeyBody = {
  error: 'forbidden-key'
  key: string
}
export type ForbiddenValueBody = {
  error: 'forbidden-value'
  key: string
  path: string
}

/** 400 payload-rejected(返修 #13:NodeRecord payload 白名单 runtime 校验拒镜像/status/tasks 字段)。 */
export type PayloadRejectedBody = {
  error: 'payload-rejected'
  reason: 'mirror-field' | 'forbidden-field' | 'id-mismatch' | 'not-object'
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
  | PayloadRejectedBody
  | UnknownResourceBody
  | { error: 'project-exists'; id: string }

// ── Project(record-schema §4.1)─────────────────────────────────────────────────

export type Project = {
  id: string
  name: string
  ownerId: string
  createdAt: string
  updatedAt: string
  revision: Revision
  isDeleted: boolean
}

export type ListProjectsResponse = { projects: Project[] }
export type CreateProjectRequest = { id?: string; name: string }

// ── Canvas(api-surface §4.2)─────────────────────────────────────────────────────

export type CreateCanvasRequest = {
  id?: string
  projectId: string
  title?: string
  sourceTemplateId?: string
}

/**
 * Canvas meta wire shape(返修 #5 + #8)。
 * - `metaRevision`:canvas meta record 的 envelope revision(PUT /api/canvas/:id 的 If-Match base)。
 * - `contentVersion`:content(children)版本号——每次子资源(node/edge/anchor/chat)写入 backend bump,
 *   客户端据此探测 content 是否变化(与 metaRevision 独立,防止 meta 与 content 双真相混淆)。
 * - `sourceTemplateId`/`createdAt`/`move`(返修 #8 API 面补全,对齐 documentMeta)。
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
}

/**
 * GET /api/canvas/:id 全量响应。每 child record 返 envelope id + revision + orderKey(信封列 canonical,
 * DP-5 + 返修 #6)+ 不透明 payload(NodeRecord/EdgeRecord/AnchorRecord,客户端 narrow)。
 * per-record revision 让客户端下次 PATCH 带正确 If-Match(base = 该 envelope revision)。
 * payload 内 NodeRecord.revision 是客户端镜像,客户端读时 sync = envelope revision,不双写(返修 #5)。
 */
export type RecordEntry = { id: string; revision: Revision; orderKey: number; payload: unknown }

export type GetCanvasResponse = CanvasMeta & {
  nodes: RecordEntry[]
  edges: RecordEntry[]
  anchors: RecordEntry[]
}

/** 返修 #8:canvas 枚举(按 project/owner)。 */
export type ListCanvasResponse = { canvases: CanvasMeta[] }

// ── chat 子资源(DP-6,api-surface §4.2.3)──────────────────────────────────────

/** POST /api/canvas/:id/chat。ChatMessage 17 字段不在此展开(payload 不透明)。 */
export type CreateChatMessageRequest = { message: unknown }

export type ListChatMessagesResponse = { messages: RecordEntry[] }

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

// ── DP-7 user-state 防御(返修 #9:namespace allowlist + 每 namespace schema + 递归敏感扫描)──

/**
 * key namespace allowlist(返修 #9)。非 allowlist 前缀的 key → 400 forbidden-key。
 * 两把 key(gateway-key/mivo-key)不在 allowlist(天然拒);敏感凭据子串仍由 value 递归扫描兜底。
 */
export const USER_STATE_KEY_NAMESPACES = ['canvas:', 'recent:', 'pref:', 'panel:'] as const

export const isUserStateKeyNamespaceAllowed = (key: string): boolean =>
  USER_STATE_KEY_NAMESPACES.some((ns) => key.startsWith(ns))

/**
 * 每 namespace 的 runtime value kind schema(返修 #9)。宽松 shape 校验:值必须满足该 namespace 期望 kind,
 * 否则 400 bad-request(forbidden-value 路径用于敏感字段,value-shape 不符走 bad-request)。
 * `true` 表示任意 value 兼容(未来可收紧)。
 */
export type UserStateValueKind = 'array' | 'object' | 'string' | 'number' | 'boolean' | 'any'

export const USER_STATE_NAMESPACE_KINDS: Record<string, UserStateValueKind> = {
  'canvas:': 'any', // selection(array)/camera(object)/chat-draft(string) 按 suffix 区分,宽松
  'recent:': 'array',
  'pref:': 'string',
  'panel:': 'boolean',
}

export const userStateNamespaceKind = (key: string): UserStateValueKind => {
  for (const ns of USER_STATE_KEY_NAMESPACES) {
    if (key.startsWith(ns)) return USER_STATE_NAMESPACE_KINDS[ns] ?? 'any'
  }
  return 'any'
}

/**
 * 敏感字段名/值模式(返修 #9:递归扫 value 拒敏感)。
 * - 字段名命中(大小写/连字符/camelCase 变体全覆盖):secret/token/password/apiKey/gatewayKey/mivoKey/accessToken/auth 等。
 * - 值为字符串且形如 mivo_ / sk- 前缀(凭据格式值)→ 拒。
 */
export const SENSITIVE_FIELD_PATTERN =
  /(secret|token|password|api[-_]?key|gateway[-_]?key|mivo[-_]?key|access[-_]?token|authorization|credential|private[-_]?key)/i

export const SENSITIVE_VALUE_PATTERN = /^(mivo_|sk-)/

/**
 * 递归扫描 value,返回首个敏感字段路径(无则 null)。
 * 覆盖:object key(含 camelCase/连字符/前缀变体)+ 嵌套对象/数组 + 字符串值格式。
 */
export const scanForSensitiveFields = (value: unknown, prefix = ''): string | null => {
  if (value === null || typeof value !== 'object') {
    // 字符串值:形如 mivo_/sk- 前缀 → 拒(凭据格式值)
    if (typeof value === 'string' && SENSITIVE_VALUE_PATTERN.test(value)) {
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
    if (SENSITIVE_FIELD_PATTERN.test(k)) return prefix ? `${prefix}.${k}` : k
    const hit = scanForSensitiveFields(v, prefix ? `${prefix}.${k}` : k)
    if (hit) return hit
  }
  return null
}

// ── DP-7 旧排除清单(向后兼容,namespace allowlist 已覆盖两把 key,此处保留值扫描兜底)──
export const USER_STATE_FORBIDDEN_KEY_NAMES = new Set(['gateway-key', 'mivo-key'])
export const USER_STATE_FORBIDDEN_KEY_PATTERN = /(secret|token|password|apikey)/i
export const isUserStateKeyForbidden = (key: string): boolean =>
  USER_STATE_FORBIDDEN_KEY_NAMES.has(key.toLowerCase()) ||
  USER_STATE_FORBIDDEN_KEY_PATTERN.test(key)

// ── 返修 #8:asset seam(引用 T1.5 PR #195 已实现的真实 wire shape,不重复实现)──
/** POST /api/assets → 200(shape 引自 server/routes/assets.ts,#195)。 */
export type CreateAssetResponse = {
  assetId: string
  mimeType: string
  originalName: string
  sizeBytes: number
  refcount: number
  deduped: boolean
}
/** GET /api/assets/:id → content bytes(内容寻址,immutable,长缓存)。 */
export type AssetRef = {
  assetId: string
  mimeType?: string
  originalName?: string
  sizeBytes?: number
}

// ── 返修 #13:NodeRecord payload 白名单(envelope 镜像字段 + status/tasks 拒收)──
/**
 * envelope 镜像字段(payload 不该携带,防双真相/绕过)。出现 → 400 payload-rejected(mirror-field)。
 * id/type 不在此列(NodeRecord 身份字段,payload.id 用于与 path 一致性校验,返修 #5)。
 */
export const PAYLOAD_MIRROR_FIELDS = new Set([
  'ownerId',
  'canvasId',
  'scope',
  'revision',
  'isDeleted',
  'createdAt',
  'updatedAt',
  'orderKey',
])

/** DP-8/9 显式拒收字段(record 不存 status/tasks,防客户端塞运行态/编排态进 document payload)。 */
export const PAYLOAD_FORBIDDEN_FIELDS = new Set(['status', 'tasks'])

/** 返修 #4:HTTP header 常量(两端共享,防字符串漂移)。If-Match 为 revision base 唯一来源。 */
export const IF_MATCH_HEADER = 'if-match'
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
export const MIVO_API_KEY_HEADER = 'x-mivo-api-key'

/** 返修 #4:统一 base revision 解析 helper(If-Match 严格优先,缺失返 undefined 由 route 决 428)。 */
export const resolveBaseRevision = (ifMatch: string | undefined): Revision | undefined => {
  if (ifMatch === undefined || ifMatch === '') return undefined
  // 严格整数 parse(非整数 → 视为缺失/无效,route 决 400/428;此处 NaN→undefined)
  const n = Number(ifMatch)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
