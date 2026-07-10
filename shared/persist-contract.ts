// shared/persist-contract.ts
// T1.3 前置:四端点 + PersistAdapter 的 wire 契约类型(客户端 ↔ 服务端互锁)。
// 权威:docs/decisions/api-surface.md。本文件是唯一让 server/ 与 src/ 共享的 seam——
// server 路由按这些类型 parse/返回,client PersistAdapter 按这些类型 (de)serialize,
// 任一侧改 shape → 编译期 break(类型共享互锁,lead §3 任务选项一)。
//
// 约束(两端 tsconfig 共编译):
//  - 纯数据类型,无 DOM/Node 专有 API(服务端 tsconfig lib 仅 ES2023)。
//  - 不用 enum(erasableSyntaxOnly);用 union string + `as const`。
//  - payload 不透明:服务端只理解信封列,payload=unknown(DP-5 jsonb);payload 域类型
//    (NodeRecord 等)在 src/kernel/records.ts,client 侧参数化,不进本共享层。

/** per-record revision(节点级合并 LWW tie-break,platform §13.5)。 */
export type Revision = number

/** scope 分层(platform §13.1)。asset 域见 T1.5,不入本契约。 */
export type PersistScope = 'document' | 'user'

/** record 类型(信封 `type` 列,api-surface §0)。 */
export type PersistType =
  | 'project'
  | 'canvas'
  | 'node'
  | 'edge'
  | 'anchor'
  | 'chat-message'
  | 'user-state'

/**
 * 信封列(DP-5):四端点共享的 record 物理形状。服务端理解全列;payload 不透明。
 * 内存实现 + PG 实现同形;PG swap 不改此(Wire)形状。
 */
export type Envelope<Payload = unknown> = {
  id: string
  ownerId: string
  canvasId: string | null
  type: PersistType
  scope: PersistScope
  revision: Revision
  isDeleted: boolean
  createdAt: string
  updatedAt: string
  payload: Payload
}

/** 写请求(POST idempotent / PATCH 节点级 / PUT meta)。revision 缺失 → upsert 视为新写。 */
export type UpsertRequest<Payload = unknown> = {
  payload: Payload
  revision?: Revision
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

/** 413 body(FX-4,jsonRequestMaxBytes=1048576)。 */
export type TooLargeBody = {
  error: 'request-body-too-large'
  limit: number
}

/** 400 bad-mivo-key(F4 边界,无 env 回退)。 */
export type BadMivoKeyBody = {
  error: 'bad-mivo-key'
}

/** 400 forbidden-key(DP-7 user-state 排除清单服务端兜底)。 */
export type ForbiddenKeyBody = {
  error: 'forbidden-key'
  key: string
}

/** 不存在 / 跨 owner(同 body,无存在泄漏,§1)。type 占位让客户端按 record 类型报。 */
export type UnknownResourceBody = {
  error:
    | 'unknown-project'
    | 'unknown-canvas'
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
  | BadMivoKeyBody
  | ForbiddenKeyBody
  | UnknownResourceBody
  | { error: 'project-exists'; id: string }

// ── 域响应形状(各端点 GET 列表 / 详情)───────────────────────────────────────

/** Project record(api-surface §4.1)。payload = Project。 */
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

// ── Canvas(api-surface §4.2)──────────────────────────────────────────────────

export type CreateCanvasRequest = {
  id?: string
  projectId: string
  title?: string
}

export type CanvasMeta = {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
  revision: Revision
}

/** GET /api/canvas/:id 全量响应。每 child record 返 envelope id + revision(信封列 canonical,
 *  DP-5)+ 不透明 payload(NodeRecord/EdgeRecord/AnchorRecord,客户端 narrow)。
 *  per-record revision 让客户端下次 PATCH 带正确 If-Match(base = 该 envelope revision)。
 *  payload 内 NodeRecord.revision 是客户端镜像,客户端读时 sync = envelope revision,不双写。 */
export type RecordEntry = { id: string; revision: Revision; payload: unknown }

export type GetCanvasResponse = {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
  revision: Revision
  nodes: RecordEntry[]
  edges: RecordEntry[]
  anchors: RecordEntry[]
}

// ── chat 子资源(DP-6,api-surface §4.2.3)─────────────────────────────────────

/** POST /api/canvas/:id/chat。ChatMessage 17 字段不在此展开(payload 不透明)。 */
export type CreateChatMessageRequest = { message: unknown }

export type ListChatMessagesResponse = { messages: RecordEntry[] }

// ── user-state(api-surface §4.3)───────────────────────────────────────────────

export type UserStateEntry = {
  key: string
  value: unknown
  revision: Revision
  updatedAt: string
  isDeleted: boolean
}

export type ListUserStateResponse = { entries: Record<string, UserStateEntry> }
export type PutUserStateRequest = { value: unknown; revision?: Revision }

/**
 * DP-7 排除清单(服务端第二道兜底,前端 strictIdb 是第一道)。
 * gateway-key / mivo-key 命名空间 + 敏感凭据子串 → PUT /api/user-state/:key 拒收 400。
 */
export const USER_STATE_FORBIDDEN_KEY_NAMES = new Set([
  'gateway-key',
  'mivo-key',
])
export const USER_STATE_FORBIDDEN_KEY_PATTERN = /(secret|token|password|apikey)/i
export const isUserStateKeyForbidden = (key: string): boolean =>
  USER_STATE_FORBIDDEN_KEY_NAMES.has(key.toLowerCase()) ||
  USER_STATE_FORBIDDEN_KEY_PATTERN.test(key)

/** HTTP header 常量(两端共享,防字符串漂移)。 */
export const IF_MATCH_HEADER = 'if-match'
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
export const MIVO_API_KEY_HEADER = 'x-mivo-api-key'
