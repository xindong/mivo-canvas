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
 * 返修 N6:每 namespace/suffix 的 runtime value kind schema(不符 → 400 bad-request)。
 */
export type UserStateValueKind = 'array' | 'object' | 'string' | 'number' | 'boolean' | 'any'

export const userStateNamespaceKind = (key: string): UserStateValueKind => {
  if (/^canvas:[^:]+:selection$/.test(key)) return 'array'
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

/** 规范化字符串:URL-decode + lower-case(best-effort,decode 失败则仅 lower-case)。N6 credential 扫描用。 */
const normalizeForScan = (s: string): string => {
  try {
    return decodeURIComponent(s).toLowerCase()
  } catch {
    return s.toLowerCase()
  }
}

/** 凭据格式值命中(规范后 mivo_/sk- 前缀)。N6:大小写/URL 编码变体均命中。 */
const isCredentialValue = (v: unknown): boolean =>
  typeof v === 'string' && CREDENTIAL_VALUE_PREFIX.test(normalizeForScan(v))

/**
 * 递归扫描 value,返回首个敏感路径(无则 null)。
 * 返修 N6:覆盖 object key(含 camelCase/连字符/前缀变体)+ 嵌套对象/数组 + 字符串值格式
 * (规范后大小写/URL 编码变体均命中)。
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

const NODE_TYPE_VALUES = new Set([
  'image', 'task-placeholder', 'text', 'frame', 'ai-slot', 'annotation', 'markup', 'markdown', 'pdf', 'video',
])
const EDGE_TYPE_VALUES = new Set(['generate', 'edit'])
const ANCHOR_TYPE_VALUES = new Set(['point', 'box'])

/** 必填字段 + 类型校验谓词(逐 type)。 */
type PayloadSpec = { allowed: ReadonlySet<string>; required: ReadonlyArray<[string, (v: unknown) => boolean]> }

const PAYLOAD_SPECS: Record<'node' | 'edge' | 'anchor', PayloadSpec> = {
  node: {
    allowed: new Set<string>(NODE_PAYLOAD_KEYS),
    required: [
      ['type', (v) => isStr(v) && NODE_TYPE_VALUES.has(v)],
      ['title', isStr],
      ['transform', isObj],
      ['fills', isArr],
      ['strokes', isArr],
      ['effects', isArr],
      ['relations', isObj],
    ],
  },
  edge: {
    allowed: new Set<string>(EDGE_PAYLOAD_KEYS),
    required: [
      ['from', isStr],
      ['to', isStr],
      ['type', (v) => isStr(v) && EDGE_TYPE_VALUES.has(v)],
      ['prompt', isStr],
      ['createdAt', isNum],
    ],
  },
  anchor: {
    allowed: new Set<string>(ANCHOR_PAYLOAD_KEYS),
    required: [
      ['type', (v) => isStr(v) && ANCHOR_TYPE_VALUES.has(v)],
      ['targetNodeId', isStr],
      ['x', isNum],
      ['y', isNum],
      ['instruction', isStr],
      ['createdAt', isNum],
    ],
  },
}

export type PayloadCheck =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; body: PayloadRejectedBody }

/**
 * 返修 N1/N10:真实 decoder——逐 type payload 白名单 runtime 校验。
 * - 必须是 object(非 null/array)。
 * - `id`(若有)必须 string 且 === path(N10:非 string id → bad-id-type;不一致 → id-mismatch #5)。
 * - `revision`(若有)→ mirror-field(envelope 唯一真相,防双真相)。
 * - envelope 镜像字段(ownerId/canvasId/scope/revision/isDeleted/updatedAt/orderKey)→ mirror-field。
 *   注:`createdAt` 不在 mirror 拒收收集——Edge/Anchor 的 createdAt 是 canonical 域字段(allowed-keys
 *   放行);Node 无此域字段,Node payload 带 createdAt 由 unknown-field 拒(allowed 不含之)。
 * - status/tasks → forbidden-field(DP-8/9)。
 * - 非 allowed key → unknown-field(N10:拒 unknown)。
 * - 缺必填 → missing-field;类型不符 → bad-type(N10:必填/类型校验)。
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
  if ('id' in obj) {
    if (!isStr(obj.id)) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'bad-id-type', field: 'id' } }
    }
    if (obj.id !== pathId) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'id-mismatch', field: 'id' } }
    }
  }
  // envelope 镜像字段(含 revision)→ mirror-field
  for (const f of PAYLOAD_MIRROR_FIELDS) {
    if (f in obj) return { ok: false, body: { error: 'payload-rejected', reason: 'mirror-field', field: f } }
  }
  // DP-8/9 显式拒收
  for (const f of PAYLOAD_FORBIDDEN_FIELDS) {
    if (f in obj) return { ok: false, body: { error: 'payload-rejected', reason: 'forbidden-field', field: f } }
  }
  const spec = PAYLOAD_SPECS[type]
  // 拒 unknown(N10)
  for (const key of Object.keys(obj)) {
    if (key === 'id') continue // id 特殊(已校验)
    if (!spec.allowed.has(key)) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'unknown-field', field: key } }
    }
  }
  // 必填 + 类型校验(N10)
  for (const [field, check] of spec.required) {
    if (!(field in obj)) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'missing-field', field } }
    }
    if (!check(obj[field])) {
      return { ok: false, body: { error: 'payload-rejected', reason: 'bad-type', field } }
    }
  }
  return { ok: true, payload: obj }
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
