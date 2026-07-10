// server/lib/persistHttp.ts
// T1.3 persist 路由共用 HTTP helper(返修 #4/#10/#11/#12/#13)。
// 权威:docs/decisions/api-surface.md(返修版)§2/§3/§5。
//
// - #4:If-Match 严格优先,existing 缺 base → 428 Precondition Required。
// - #10:请求 fingerprint(sha256 body),幂等 key 复合 owner+method+resourceKind+key+fingerprint。
// - #11:最小 runtime codec(不接生产开关,always-on 校验 wire shape satisfies shared 类型)。
// - #12:统一 413 TooLargeBody 契约体。
// - #13:NodeRecord payload 白名单 runtime 校验(拒 envelope 镜像字段 + status/tasks)。

import type { Context } from 'hono'
import { readJsonBody } from './request'
import { RequestBodyTooLargeError } from './upstream'
import { fingerprintOfBody } from '../persist/backend'
import {
  PAYLOAD_FORBIDDEN_FIELDS,
  PAYLOAD_MIRROR_FIELDS,
  resolveBaseRevision,
  type CreateCanvasRequest,
  type CreateProjectRequest,
  type PayloadRejectedBody,
  type PreconditionRequiredBody,
  type PutUserStateRequest,
  type Revision,
  type TooLargeBody,
  type UpsertRequest,
} from '../../shared/persist-contract.ts'

export const BODY_LIMIT = 1_048_576

/** 返修 #12:统一 413 契约体(对齐 tasks 413 分支 + shared TooLargeBody)。 */
export const tooLargeBody = (): TooLargeBody => ({ error: 'request-body-too-large', limit: BODY_LIMIT })

/** 返修 #4:428 契约体(existing 写端点缺 If-Match base)。 */
export const preconditionRequired = (id: string): PreconditionRequiredBody => ({
  error: 'precondition-required',
  id,
})

/**
 * 返修 #4:base revision 解析。If-Match 严格优先;wire body 不携带 revision(返修 #5 已删)。
 * 返回 undefined = 缺 base(backend 对 existing 返 precondition-required,route → 428)。
 */
export const baseFromIfMatch = (ifMatch: string | undefined): Revision | undefined =>
  resolveBaseRevision(ifMatch)

/** 返修 #10:读 JSON body + 算 fingerprint(sha256)。超限抛 RequestBodyTooLargeError(route → 413)。 */
export const readJsonBodyWithFingerprint = async <T>(c: Context): Promise<{ body: T; fingerprint: string }> => {
  const body = await readJsonBody<T>(c)
  return { body, fingerprint: fingerprintOfBody(body) }
}

// ── 返修 #11:最小 runtime request codec(wire shape satisfies shared 类型)──────────────────

export type DecodeResult<T> = { ok: true; value: T; fingerprint: string } | { ok: false; status: 400 | 413; body: unknown }

const bad = (message: string): { ok: false; status: 400; body: { error: 'bad-request'; message: string } } => ({
  ok: false,
  status: 400,
  body: { error: 'bad-request', message },
})

/** POST /api/projects body codec。 */
export const decodeCreateProject = (raw: unknown, fingerprint: string): DecodeResult<CreateProjectRequest> => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('invalid body')
  const b = raw as Record<string, unknown>
  if (b.id !== undefined && typeof b.id !== 'string') return bad('id must be string')
  if (typeof b.name !== 'string' || b.name.trim() === '') return bad('name is required')
  return { ok: true, value: { id: typeof b.id === 'string' ? b.id : undefined, name: b.name }, fingerprint }
}

/** POST /api/canvas body codec。 */
export const decodeCreateCanvas = (raw: unknown, fingerprint: string): DecodeResult<CreateCanvasRequest> => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('invalid body')
  const b = raw as Record<string, unknown>
  if (typeof b.projectId !== 'string' || b.projectId.trim() === '') return bad('projectId is required')
  return {
    ok: true,
    value: {
      projectId: b.projectId,
      id: typeof b.id === 'string' ? b.id : undefined,
      title: typeof b.title === 'string' ? b.title : undefined,
      sourceTemplateId: typeof b.sourceTemplateId === 'string' ? b.sourceTemplateId : undefined,
    },
    fingerprint,
  }
}

/** PATCH/PUT body codec(返修 #5:wire 不带 revision;{payload} only)。 */
export const decodeUpsertRequest = (raw: unknown, fingerprint: string): DecodeResult<UpsertRequest> => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('invalid body')
  const b = raw as Record<string, unknown>
  if (!('payload' in b) || b.payload == null) return bad('payload is required')
  // 返修 #5:wire body 不携带 revision;若旧 client 带 revision,忽略(不作为真相)。
  return { ok: true, value: { payload: b.payload }, fingerprint }
}

/** PUT /api/user-state/:key body codec。 */
export const decodePutUserState = (raw: unknown, fingerprint: string): DecodeResult<PutUserStateRequest> => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('invalid body')
  const b = raw as Record<string, unknown>
  if (!('value' in b)) return bad('value is required')
  return { ok: true, value: { value: b.value }, fingerprint }
}

/** 读取 body 失败统一映射(返修 #12:413 返 TooLargeBody;其余 400)。 */
export const bodyError = (error: unknown): { status: 400 | 413; body: unknown } => {
  if (error instanceof RequestBodyTooLargeError) return { status: 413, body: tooLargeBody() }
  return { status: 400, body: { error: 'bad-request', message: error instanceof Error ? error.message : 'invalid body' } }
}

// ── 返修 #13:NodeRecord payload 白名单 runtime 校验(envelope 镜像字段 + status/tasks 拒收)──

export type PayloadCheck = { ok: true; payload: Record<string, unknown> } | { ok: false; body: PayloadRejectedBody }

/**
 * 校验 child payload(node/edge/anchor/chat-message):
 * - 必须是 object(返修 #11/#13)。
 * - payload.id(若有)必须 === path :id(返修 #5 一致性)。
 * - 拒 envelope 镜像字段:ownerId/canvasId/scope/revision/isDeleted/createdAt/updatedAt/orderKey(返修 #13)。
 * - 拒 status/tasks(返修 #13 DP-8/9:record 不存运行态/编排态)。
 */
export const validateChildPayload = (payload: unknown, pathId: string): PayloadCheck => {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, body: { error: 'payload-rejected', reason: 'not-object' } }
  }
  const obj = payload as Record<string, unknown>
  if ('id' in obj && typeof obj.id === 'string' && obj.id !== pathId) {
    return { ok: false, body: { error: 'payload-rejected', reason: 'id-mismatch', field: 'id' } }
  }
  for (const f of PAYLOAD_MIRROR_FIELDS) {
    if (f in obj) return { ok: false, body: { error: 'payload-rejected', reason: 'mirror-field', field: f } }
  }
  for (const f of PAYLOAD_FORBIDDEN_FIELDS) {
    if (f in obj) return { ok: false, body: { error: 'payload-rejected', reason: 'forbidden-field', field: f } }
  }
  return { ok: true, payload: obj }
}

/**
 * 返修 #9:user-state value 递归敏感扫描。
 * @returns 首个敏感字段路径(无则 null)。route 命中 → 400 forbidden-value。
 */
export { scanForSensitiveFields, isUserStateKeyNamespaceAllowed, userStateNamespaceKind } from '../../shared/persist-contract.ts'
