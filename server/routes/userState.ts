// server/routes/userState.ts
// T1.3 前置:/api/user-state — per-user KV(user 域:selection/相机/偏好/草稿,DP-1)。
// 权威:docs/decisions/api-surface.md §4.3(返修版二)。
//
// 返修要点(N1-N10):
//  - #1/N7 owner seam:resolveActor + canAccessUserState(action-aware,per-owner KV 永不 share;T1.3 trivial allow);未授权 404。
//  - #4/N5 If-Match 严格(parseIfMatch;invalid → 400,missing → 428,value → base);#5 wire 不带 revision。
//  - #9/N6 DP-7 namespace frozen key(逐项 exact regex,含 canvas suffix;拒未知 suffix)+ 每 namespace runtime kind schema
//    + 递归扫 value 拒敏感字段名/凭据格式值(大小写/连字符/camelCase/前缀/嵌套/URL 编码变体全覆盖)。
//  - #10/N4 幂等 owner+method+resourceKind+key+fingerprint;同 key 不同 body → 422 reuse-conflict;#11 request codec;#12 统一 413。

import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import { canAccessUserState } from '../lib/authz'
import { newRequestId, logRequest } from '../lib/request'
import {
  bodyError,
  decodePutUserState,
  parseIfMatch,
  preconditionRequired,
  readJsonBodyWithFingerprint,
  reuseConflict,
  scanForSensitiveFields,
  scanUserStateKeyForCredential,
  isUserStateKeyNamespaceAllowed,
  userStateNamespaceKind,
} from '../lib/persistHttp'
import type {
  ConflictBody,
  ForbiddenKeyBody,
  ForbiddenValueBody,
  ListUserStateResponse,
  ReuseConflictBody,
  UnknownResourceBody,
  UserStateEntry,
  UpsertResponse,
} from '../../shared/persist-contract.ts'
import type { PersistBackend, PersistRecord } from '../persist/backend'

/** UserState 信封 payload(DP-5:value 是唯一域字段;key=id,revision/timestamps 在信封列)。 */
type UserStatePayload = { value: unknown }

/** 返修 #11:response encoder(satisfies UserStateEntry)。 */
const toEntry = (r: PersistRecord, key: string): UserStateEntry => {
  const p = r.payload as UserStatePayload | undefined
  return {
    key,
    value: p?.value,
    revision: r.revision,
    updatedAt: r.updatedAt,
    isDeleted: r.isDeleted,
  }
}

const valueMatchesKind = (value: unknown, kind: string): boolean => {
  switch (kind) {
    case 'array':
      return Array.isArray(value)
    case 'string-array':
      // F7:canvas:<id>:selection 只收 string[](与 SessionStore 对齐)。
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return true
  }
}

/** N5:malformed If-Match → 400 bad-request body。 */
const badIfMatch = (id: string) => ({ error: 'bad-request' as const, message: 'If-Match must be a non-negative decimal safe integer', id })

export const createUserStateRoutes = ({ backend }: { backend: PersistBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

  /** N7:user-state 授权 seam(per-owner KV,owner===actor;T1.3 trivial allow,T1.4 不扩永不 share)。 */
  const authzUserState = (actor: string, action: 'read' | 'write'): boolean =>
    canAccessUserState(actor, actor, action) === 'allow'

  // GET /api/user-state — owner 全部 KV(未软删)。
  route.get('/', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const actor = resolveActor(c)
    const { records } = await backend.listByOwner(actor, 'user-state')
    const entries: Record<string, UserStateEntry> = {}
    for (const r of records) entries[r.id] = toEntry(r, r.id)
    const body: ListUserStateResponse = { entries }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(body, 200)
  })

  // GET /api/user-state/:key — owner-scoped;跨 owner/不存在/已软删 → 404(无泄漏)。
  route.get('/:key', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const key = c.req.param('key')
    const actor = resolveActor(c)
    if (!authzUserState(actor, 'read')) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    const got = await backend.get(actor, 'user-state', key)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toEntry(got.record, key), 200)
  })

  // PUT /api/user-state/:key — LWW upsert(revision-checked);返修 #9/N6 DP-7 frozen namespace + 敏感扫描;N5/N4。
  route.put('/:key', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const key = c.req.param('key')
    // 返修 #9/N6:frozen namespace(逐项 exact regex;非 allowlist/未知 suffix → 400 forbidden-key;gateway-key/mivo-key 天然不在 frozen 集)。
    if (!isUserStateKeyNamespaceAllowed(key)) {
      const err: ForbiddenKeyBody = { error: 'forbidden-key', key }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'forbidden-key' })
      return c.json(err, 400)
    }
    // F3:完整 user-state key(含 free-form canvasId/panelId 段)credential 扫描——key 按 `:` 切段,任一段规范化后 mivo_/sk- 前缀 → forbidden-key(防 key 里藏凭据)。
    if (scanUserStateKeyForCredential(key)) {
      const err: ForbiddenKeyBody = { error: 'forbidden-key', key }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'forbidden-key-credential' })
      return c.json(err, 400)
    }
    let decoded
    try {
      const { body: raw, fingerprint } = await readJsonBodyWithFingerprint<unknown>(c)
      decoded = decodePutUserState(raw, fingerprint)
    } catch (error) {
      const { status, body } = bodyError(error)
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(body, status as 400 | 413)
    }
    if (!decoded.ok) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: decoded.status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json(decoded.body, decoded.status as 400 | 413)
    }
    // 返修 #9/N6:每 namespace/suffix runtime kind schema(不符 → 400 bad-request)。
    const kind = userStateNamespaceKind(key)
    if (!valueMatchesKind(decoded.value.value, kind)) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-value-kind' })
      return c.json({ error: 'bad-request', message: `value must be ${kind} for namespace` }, 400)
    }
    // 返修 #9/N6:递归敏感扫描(字段名 + 规范化后凭据格式值;大小写/连字符/camelCase/嵌套/URL 编码变体全覆盖)。
    const sensitivePath = scanForSensitiveFields(decoded.value.value)
    if (sensitivePath !== null) {
      const err: ForbiddenValueBody = { error: 'forbidden-value', key, path: sensitivePath }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'forbidden-value' })
      return c.json(err, 400)
    }
    const actor = resolveActor(c)
    if (!authzUserState(actor, 'write')) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    // N5:If-Match 严格(parseIfMatch;invalid → 400,missing → 428 via backend,value → base)。
    const parsed = parseIfMatch(c.req.header('if-match'))
    if (parsed.kind === 'invalid') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-if-match' })
      return c.json(badIfMatch(key), 400)
    }
    const base = parsed.kind === 'value' ? parsed.revision : undefined
    const result = await backend.upsert(actor, 'user-state', key, { value: decoded.value.value } satisfies UserStatePayload, {
      base,
      scope: 'user',
      method: 'PUT',
      resourceKind: 'user-state',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
    })
    if (result.kind === 'reuse-conflict') {
      const err: ReuseConflictBody = reuseConflict(c.req.header('idempotency-key') ?? '')
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 422, latencyMs: Date.now() - t0, note: 'reuse-conflict' })
      return c.json(err, 422)
    }
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(key), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: key, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    // F1 防御:user-state 无父 project,parent-not-live 不可达;类型收窄。
    if (result.kind === 'parent-not-live') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0, note: 'parent-not-live' })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  })

  // DELETE /api/user-state/:key — 软删 KV(user 域 KV,不在 #2 硬删范围;保留软删语义)。idempotent:删已删→204。
  route.delete('/:key', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-mivo-key' })
      return bad
    }
    const key = c.req.param('key')
    const actor = resolveActor(c)
    if (!authzUserState(actor, 'write')) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    const { deleted } = await backend.softDelete(actor, 'user-state', key)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
