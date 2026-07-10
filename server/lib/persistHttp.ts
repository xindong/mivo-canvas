// server/lib/persistHttp.ts
// T1.3 persist 路由共用 HTTP helper(返修 #4/#5/#10/#11/#12/#13 + N1/N4/N5/N10)。
// 权威:docs/decisions/api-surface.md(返修版)§2/§3/§5。
//
// - #4/N5:If-Match 严格优先,existing 缺 base → 428;malformed(非十进制非负 safe integer)→ 400 bad-request。
// - #10/N4:请求 fingerprint(sha256 body),幂等 key 复合 owner+method+resourceKind+key+fingerprint;同 key 不同 body → 422 reuse-conflict。
// - #11:最小 runtime codec(不接生产开关,always-on 校验 wire shape satisfies shared 类型)。
// - #12:统一 413 TooLargeBody 契约体。
// - #13/N1/N10:NodeRecord/EdgeRecord/AnchorRecord payload 逐 type 白名单 runtime 校验(shared validateChildPayload)。

import type { Context } from 'hono'
import { readJsonBody } from './request'
import { RequestBodyTooLargeError } from './upstream'
import { fingerprintOfBody } from '../persist/backend'
import {
  resolveBaseRevision,
  type CreateCanvasRequest,
  type CreateProjectRequest,
  type PutUserStateRequest,
  type ReuseConflictBody,
  type Revision,
  type TooLargeBody,
  type UpsertRequest,
} from '../../shared/persist-contract.ts'

export const BODY_LIMIT = 1_048_576

/** 返修 #12:统一 413 契约体(对齐 tasks 413 分支 + shared TooLargeBody)。 */
export const tooLargeBody = (): TooLargeBody => ({ error: 'request-body-too-large', limit: BODY_LIMIT })

/** 返修 #4:428 契约体(existing 写端点缺 If-Match base)。 */
export const preconditionRequired = (id: string): { error: 'precondition-required'; id: string } => ({
  error: 'precondition-required',
  id,
})

/** 返修 N4:422 契约体(同 idem key 不同 fingerprint=不同 body)。 */
export const reuseConflict = (key: string): ReuseConflictBody => ({ error: 'idempotency-key-reuse', key })

/**
 * 返修 #4/N5:base revision 解析(向后兼容别名;missing/invalid 均 → undefined)。
 * route 需区分 428(missing)vs 400(invalid)时用 `parseIfMatch`(下方 re-export)。
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

// ── 返修 #13/N1/N10:NodeRecord/EdgeRecord/AnchorRecord payload 逐 type 白名单(shared 实现)──
// validateChildPayload(type, payload, pathId):per-type schema(必填/类型/拒 unknown/非 string id 400/mirror/forbidden)。
export { validateChildPayload, encodeChildPayload, parseIfMatch } from '../../shared/persist-contract.ts'
export type { PayloadCheck } from '../../shared/persist-contract.ts'

/**
 * 返修 #9/N6/F3:user-state value 递归敏感扫描(object key 先 best-effort decode+lower 再匹配,防 %61piKey 绕过)
 * + namespace frozen key 校验 + F3 完整 key credential 段扫描(防 key 含 mivo_ 段)。
 */
export {
  scanForSensitiveFields,
  scanUserStateKeyForCredential,
  isUserStateKeyNamespaceAllowed,
  userStateNamespaceKind,
} from '../../shared/persist-contract.ts'
