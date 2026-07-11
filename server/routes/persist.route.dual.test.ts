// server/routes/persist.route.dual.test.ts
// T1.3 route 级双后端 smoke:用真实 Hono route(app.request 全链路)跑核心场景 over PG 后端。
// Boundary 4 铁律:必须走真 app.request 全链路(不是手写 JSON 对比)。证明 PG swap 后路由 handler 零改动,
// wire shape(status/body/error 码)与内存后端一致。PG gate:MIVO_PG_TEST=1(本地 brew PG);CI 无 PG 跳过。
//
// 内存后端的完整 route 契约见 canvas/projects/userState.route.test.ts(表征测试,一字不改);本测只钉 PG swap 等价性 smoke。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { createProjectsRoutes } from './projects'
import { createCanvasRoutes } from './canvas'
import { createUserStateRoutes } from './userState'
import { PgPersistBackend } from '../persist/pgBackend'
import { InMemoryPermissionBackend } from '../lib/permissions'
import { hdr, KEY_A, req, canonicalNode, wirePayload } from './persistTestApp'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'
let pgBackend: PgPersistBackend | undefined
// T1.4: persist route smoke 不验权限逻辑(只钉 PG persist swap 等价性);permission backend 用内存即可
// (authz 派生 owner 判定在内存下成立;permission 表无状态注入)。PG 权限契约由 permissionBackend.contract.dual.test.ts 覆盖。
const pgPermissions = new InMemoryPermissionBackend()

const buildPgApp = (): Hono<AppEnv> => {
  if (!pgBackend) throw new Error('pg backend not initialized')
  const app = new Hono<AppEnv>()
  app.route('/api/projects', createProjectsRoutes({ backend: pgBackend, permissions: pgPermissions }))
  app.route('/api/canvas', createCanvasRoutes({ backend: pgBackend, permissions: pgPermissions }))
  app.route('/api/user-state', createUserStateRoutes({ backend: pgBackend }))
  return app
}

;(PG_TEST_ENABLED ? describe : describe.skip)('PG backend route smoke(app.request 全链路)', () => {
  let app: Hono<AppEnv>
  beforeAll(async () => {
    pgBackend = new PgPersistBackend({
      host: process.env.MIVO_PG_HOST || '127.0.0.1',
      port: Number(process.env.MIVO_PG_PORT || 55443),
      database: process.env.MIVO_PG_DB || 'mivocanvas',
      user: process.env.MIVO_PG_USER || 'mivo',
      password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
      maxConnections: 5,
      idleTimeoutMs: 5000,
    })
    await pgBackend.migrate()
    await pgBackend.ready
    app = buildPgApp()
  })
  afterAll(async () => {
    if (pgBackend) await pgBackend.destroy()
  })

  it('跨设备原样在:project→canvas→node PATCH→GET 全量,PG 持久化', async () => {
    await pgBackend!.ready
    await pgBackend!.__reset()
    // POST project → 201
    const p = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(p.status).toBe(201)
    expect((p.body as { id: string }).id).toBe('p1')
    // POST canvas → 201
    const c = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    expect(c.status).toBe(201)
    expect((c.body as { contentVersion: number }).contentVersion).toBe(0)
    // PATCH node(fx-4 节点级)→ 200 {id,revision}
    const node = canonicalNode('n1')
    const patch = await req(app, `/api/canvas/c1/nodes/n1`, { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: wirePayload(node) }) })
    expect(patch.status).toBe(200)
    expect((patch.body as { id: string; revision: number }).id).toBe('n1')
    expect((patch.body as { revision: number }).revision).toBe(0)
    // GET canvas 全量 → 200(metaRevision/contentVersion + nodes)
    const get = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(get.status).toBe(200)
    const body = get.body as { id: string; contentVersion: number; metaRevision: number; nodes: { id: string }[] }
    expect(body.id).toBe('c1')
    expect(body.contentVersion).toBe(1) // 1 child 写入 bump
    expect(body.metaRevision).toBe(0) // 子资源写入不动 metaRevision
    expect(body.nodes.map((n) => n.id)).toEqual(['n1'])
  })

  it('revision 409 + 428:PATCH existing 缺 If-Match → 428;stale → 409;正确 → 200', async () => {
    await pgBackend!.__reset()
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p2', name: 'P2' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c2', projectId: 'p2' }) })
    const node = canonicalNode('n2')
    // missing→create(无 If-Match)→ 200
    const c1 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: wirePayload(node) }) })
    expect(c1.status).toBe(200)
    // existing 缺 If-Match → 428
    const c428 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: wirePayload(node) }) })
    expect(c428.status).toBe(428)
    expect((c428.body as { error: string }).error).toBe('precondition-required')
    // stale If-Match(0 ≠ current 0... 实际 revision=0,base=99 stale)→ 409
    const c409 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '99' }, body: JSON.stringify({ payload: wirePayload(node) }) })
    expect(c409.status).toBe(409)
    expect((c409.body as { error: string }).error).toBe('revision-conflict')
    // 正确 If-Match(revision=0)→ 200,revision bump → 1
    const c200 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ payload: wirePayload(node) }) })
    expect(c200.status).toBe(200)
    expect((c200.body as { revision: number }).revision).toBe(1)
  })

  it('softDelete + restore:DELETE canvas → 204;POST restore → 200(restored);GET 软删 → 404', async () => {
    await pgBackend!.__reset()
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p3', name: 'P3' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c3', projectId: 'p3' }) })
    // DELETE canvas → 204(softDeleteCanvasTree)
    const d = await req(app, '/api/canvas/c3', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(d.status).toBe(204)
    // GET 软删 canvas → 404
    const g404 = await req(app, '/api/canvas/c3', { headers: hdr(KEY_A) })
    expect(g404.status).toBe(404)
    expect((g404.body as { error: string }).error).toBe('unknown-canvas')
    // POST canvas(已软删,restore)→ 200(restored)
    const r = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c3', projectId: 'p3' }) })
    expect(r.status).toBe(200) // restored(non-created)
    // GET 恢复后 → 200
    const g200 = await req(app, '/api/canvas/c3', { headers: hdr(KEY_A) })
    expect(g200.status).toBe(200)
  })

  it('跨 owner 404 + canvas-exists 409(F1/F4 authz seam + 全局唯一)', async () => {
    await pgBackend!.__reset()
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'pA', name: 'PA' }) })
    // A 建 canvas c-shared
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c-shared', projectId: 'pA' }) })
    // B 跨 owner GET A 的 canvas → 404(无存在泄漏)
    const bGet = await req(app, '/api/canvas/c-shared', { headers: hdr('mivo_bbb_user_b') })
    expect(bGet.status).toBe(404)
    // B 建自己的 project,再用 A 已占的 canvas id 建 canvas → 409 canvas-exists(F4 全局唯一)
    await req(app, '/api/projects', { method: 'POST', headers: hdr('mivo_bbb_user_b'), body: JSON.stringify({ id: 'pB', name: 'PB' }) })
    const bPost = await req(app, '/api/canvas', { method: 'POST', headers: hdr('mivo_bbb_user_b'), body: JSON.stringify({ id: 'c-shared', projectId: 'pB' }) })
    expect(bPost.status).toBe(409)
    expect((bPost.body as { error: string }).error).toBe('canvas-exists')
  })
})
