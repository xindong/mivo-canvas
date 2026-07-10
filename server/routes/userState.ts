// server/routes/userState.ts
// T1.3 前置:/api/user-state — per-user KV(user 域:selection/相机/偏好/草稿,DP-1)。
// 权威:docs/decisions/api-surface.md §4.3(返修版)。
// 契约:additive;验收由 routes/userState.route.test.ts(内存 backend)覆盖。
//
// 返修要点:
//  - #1 owner seam:resolveActor + per-owner(=owner===actor);未授权 404。
//  - #4 If-Match 严格优先,existing 缺 base → 428;#5 wire 不带 revision。
//  - #9 DP-7 namespace allowlist(canvas:/recent:/pref:/panel:)+ 每 namespace runtime kind schema
//    + 递归扫 value 拒敏感字段名/凭据格式值(大小写/连字符/camelCase/前缀/嵌套全覆盖)。
//  - #10 幂等 owner+method+resourceKind+key+fingerprint;#11 request codec;#12 统一 413。

import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveActor } from '../lib/owner'
import { newRequestId, logRequest } from '../lib/request'
import {
  baseFromIfMatch,
  bodyError,
  decodePutUserState,
  preconditionRequired,
  readJsonBodyWithFingerprint,
  scanForSensitiveFields,
  isUserStateKeyNamespaceAllowed,
  userStateNamespaceKind,
} from '../lib/persistHttp'
import type {
  ConflictBody,
  ForbiddenKeyBody,
  ForbiddenValueBody,
  ListUserStateResponse,
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

export const createUserStateRoutes = ({ backend }: { backend: PersistBackend }): Hono<AppEnv> => {
  const route = new Hono<AppEnv>()

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
    const got = await backend.get(actor, 'user-state', key)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toEntry(got.record, key), 200)
  })

  // PUT /api/user-state/:key — LWW upsert(revision-checked);返修 #9 DP-7 namespace allowlist + 敏感扫描。
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
    // 返修 #9:namespace allowlist(非 allowlist 前缀 → 400 forbidden-key;gateway-key/mivo-key 天然不在 allowlist)。
    if (!isUserStateKeyNamespaceAllowed(key)) {
      const err: ForbiddenKeyBody = { error: 'forbidden-key', key }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'forbidden-key' })
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
    // 返修 #9:每 namespace runtime kind schema(不符 → 400 bad-request)。
    const kind = userStateNamespaceKind(key)
    if (!valueMatchesKind(decoded.value.value, kind)) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'bad-value-kind' })
      return c.json({ error: 'bad-request', message: `value must be ${kind} for namespace` }, 400)
    }
    // 返修 #9:递归敏感扫描(字段名 + 凭据格式值;大小写/连字符/camelCase/嵌套全覆盖)。
    const sensitivePath = scanForSensitiveFields(decoded.value.value)
    if (sensitivePath !== null) {
      const err: ForbiddenValueBody = { error: 'forbidden-value', key, path: sensitivePath }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'forbidden-value' })
      return c.json(err, 400)
    }
    const actor = resolveActor(c)
    const base = baseFromIfMatch(c.req.header('if-match'))
    const result = await backend.upsert(actor, 'user-state', key, { value: decoded.value.value } satisfies UserStatePayload, {
      base,
      scope: 'user',
      method: 'PUT',
      resourceKind: 'user-state',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
      bodyFingerprint: decoded.fingerprint,
    })
    if (result.kind === 'precondition-required') {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 428, latencyMs: Date.now() - t0, note: 'precondition-required' })
      return c.json(preconditionRequired(key), 428)
    }
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: key, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
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
