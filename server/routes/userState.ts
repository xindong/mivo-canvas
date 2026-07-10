// server/routes/userState.ts
// T1.3 前置:/api/user-state — per-user KV(user 域:selection/相机/偏好/草稿,DP-1)。
// 权威:docs/decisions/api-surface.md §4.3。
// 契约:additive;验收由 routes/userState.route.test.ts(内存 backend)覆盖。
//
// 信封 payload 透明:UserStateEntry payload = {value};key/revision/updatedAt 在信封列。
// DP-7:gateway-key/mivo-key + 敏感凭据子串 → 400 forbidden-key(服务端第二道兜底,
// 前端 strictIdb 是第一道)。两把 key 原文永不落本端。
//
// 鉴权:resolveOwner(c) + rejectInvalidMivoApiKey(F4 边界);跨 owner/不存在 → 404(无泄漏)。
// PG swap:backend 注入点,handler 零改动(§6)。

import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveOwner } from '../lib/owner'
import { newRequestId, logRequest, readJsonBody } from '../lib/request'
import { RequestBodyTooLargeError } from '../lib/upstream'
import {
  isUserStateKeyForbidden,
  type ConflictBody,
  type ForbiddenKeyBody,
  type ListUserStateResponse,
  type PutUserStateRequest,
  type UnknownResourceBody,
  type UserStateEntry,
  type UpsertResponse,
} from '../../shared/persist-contract.ts'
import type { PersistBackend, PersistRecord } from '../persist/backend'

/** UserState 信封 payload(DP-5:value 是唯一域字段;key=id,revision/timestamps 在信封列)。 */
type UserStatePayload = { value: unknown }

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
    const owner = resolveOwner(c)
    // scope='user' 在 PUT 时落信封(scope 列);list 只按 type 过滤,user-state records 天然 user scope。
    const { records } = await backend.listByOwner(owner, 'user-state')
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
    const owner = resolveOwner(c)
    const got = await backend.get(owner, 'user-state', key)
    if (got.kind === 'missing' || got.record.isDeleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(toEntry(got.record, key), 200)
  })

  // PUT /api/user-state/:key — LWW upsert(revision-checked);DP-7 排除 → 400 forbidden-key。
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
    // DP-7 服务端兜底:gateway-key/mivo-key 命名空间 + 敏感凭据子串 → 拒收(防绕过前端 strictIdb)。
    if (isUserStateKeyForbidden(key)) {
      const err: ForbiddenKeyBody = { error: 'forbidden-key', key }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 400, latencyMs: Date.now() - t0, note: 'forbidden-key' })
      return c.json(err, 400)
    }
    let body: PutUserStateRequest
    try {
      body = await readJsonBody<PutUserStateRequest>(c)
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400
      logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note: 'bad-body' })
      return c.json({ error: error instanceof Error ? error.message : 'invalid body' }, status as 413 | 400)
    }
    const owner = resolveOwner(c)
    const ifMatch = c.req.header('if-match')
    const revision = body.revision !== undefined ? body.revision : ifMatch !== undefined ? Number(ifMatch) : undefined
    const result = await backend.upsert(owner, 'user-state', key, { value: body.value } satisfies UserStatePayload, {
      revision,
      scope: 'user',
      idempotencyKey: c.req.header('idempotency-key') || undefined,
    })
    if (result.kind === 'conflict') {
      const err: ConflictBody = { error: 'revision-conflict', id: key, currentRevision: result.currentRevision }
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 409, latencyMs: Date.now() - t0, note: 'rev-conflict' })
      return c.json(err, 409)
    }
    const res: UpsertResponse = { id: result.record.id, revision: result.record.revision }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 200, latencyMs: Date.now() - t0 })
    return c.json(res, 200)
  })

  // DELETE /api/user-state/:key — 软删 KV。idempotent:删已删→204;不存在→404。
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
    const owner = resolveOwner(c)
    const { deleted } = await backend.softDelete(owner, 'user-state', key)
    if (!deleted) {
      logRequest({ method: c.req.method, path: c.req.path, requestId, status: 404, latencyMs: Date.now() - t0 })
      return c.json({ error: 'unknown-key' } satisfies UnknownResourceBody, 404)
    }
    logRequest({ method: c.req.method, path: c.req.path, requestId, status: 204, latencyMs: Date.now() - t0 })
    return c.body(null, 204)
  })

  return route
}
