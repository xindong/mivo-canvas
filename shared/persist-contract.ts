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
 * F3 返修五(真不动点):不再用固定层数上限——循环 decode 至不再变化(fixed point),防 DoS 用**累计解码
 * 输出长度阈值**(MAX_DECODE_TOTAL)而非固定层数。单次 decode 不会让字符串变长(%XX 3 字符→1 字符,其余 1:1),
 * 故正常输入单调缩短至无 `%` 即收敛;累计输出长度阈值兜底恶意超长/构造输入(超阈即停,用最后一次成功值)。
 * F3 多层编码:单次 decode 不够——`%2561piKey`→`%61piKey`→`apiKey`(2 层);`%252561piKey`→3 层;
 * `%252525252561piKey`→6 层→`apiKey`;`%256divo_xxx`→`%6divo_xxx`→`mivo_xxx`;`%2553k-test`→`%53k-test`→`Sk-test`。
 * 异常即停(尾部 malformed `%`,用最后一次成功值,含原始值)。**保留 raw 扫描**:无 `%` 的字符串 fixed-point
 * 立即返回(raw 形态直接被后续 regex 命中,如 `apiKey`/`mivo_xxx`/`sk-test`),decode 只会**增加**匹配
 * (把编码变体还原成 credential),不会丢 raw 命中。6 层 `%252525252561piKey` 命中(旧 5 次上限阻断第 6 次 → 漏)。
 */
const MAX_DECODE_TOTAL = 1_048_576 // 累计解码输出长度阈值(DoS 上限);decode 单调缩短,正常多层远不达
const normalizeForScan = (s: string): string => {
  let cur = s
  let total = s.length
  for (;;) {
    let next: string
    try {
      next = decodeURIComponent(cur)
    } catch {
      return cur.toLowerCase() // 异常即停:用最后一次成功值(或原始值,含 raw credential)
    }
    if (next === cur) return cur.toLowerCase() // fixed point(无 % 或已收敛)
    total += next.length
    if (total > MAX_DECODE_TOTAL) return next.toLowerCase() // 累计输出长度阈值防 DoS(超长输入不卡死)
    cur = next
  }
}

/** 凭据格式值命中(规范后 mivo_/sk- 前缀)。N6:大小写/URL 编码变体均命中。 */
const isCredentialValue = (v: unknown): boolean =>
  typeof v === 'string' && CREDENTIAL_VALUE_PREFIX.test(normalizeForScan(v))

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
    // F3:object key 先 best-effort decode+lower 再匹配(防 %61piKey → apiKey 编码绕过)。
    if (SENSITIVE_FIELD_PATTERN.test(normalizeForScan(k))) return prefix ? `${prefix}.${k}` : k
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

/** F6:递归扫 status/tasks(任意层)——返回首个命中 path(无则 null)。top-level 与 nested(relations/fills 内藏)一视同仁。 */
const findForbiddenDeep = (value: unknown, prefix: string): string | null => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenDeep(value[i], `${prefix}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PAYLOAD_FORBIDDEN_FIELDS.has(k)) return prefix ? `${prefix}.${k}` : k
      const hit = findForbiddenDeep(v, prefix ? `${prefix}.${k}` : k)
      if (hit) return hit
    }
  }
  return null
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
        if (!(k in check.fields)) return { reason: 'unknown-field', field: path ? `${path}.${k}` : k }
      }
      for (const req of check.required ?? []) {
        if (!(req in value)) return { reason: 'missing-field', field: path ? `${path}.${req}` : req }
      }
      for (const [k, sub] of Object.entries(check.fields)) {
        if (k in value) {
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
      if (!(check.tag in value)) return { reason: 'missing-field', field: path ? `${path}.${check.tag}` : check.tag }
      const tag = value[check.tag]
      if (!isStr(tag)) return { reason: 'bad-type', field: path ? `${path}.${check.tag}` : check.tag }
      const variant = check.variants[tag]
      if (!variant) return { reason: 'unknown-field', field: path ? `${path}.${check.tag}` : check.tag }
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
  // F6:status/tasks 任意层递归拒(findForbiddenDeep 在 schema 之前;top-level 与 nested relations/fills 内藏均命中)。
  const forbiddenPath = findForbiddenDeep(obj, '')
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
