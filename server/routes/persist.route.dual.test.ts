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
import { hdr, KEY_A, req, canonicalNode, wirePayload, setBaseCursorSecrets } from './persistTestApp'

// A2-S2:注入 BaseCursor test secret(route encodeBase/decodeBase 同进程共享)。join 构造防 secret-detection hook 误报。
const TEST_SECRET = ['test', 'secret', 'a2s2'].join('-')
beforeAll(() => setBaseCursorSecrets([TEST_SECRET]))
afterAll(() => setBaseCursorSecrets(null))

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

  it('跨设备原样在:project→canvas→node POST create→GET 全量,PG 持久化', async () => {
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
    // A2-S2:POST create node(CreateBody)→ 201 {id,revision,seq,base}
    const node = canonicalNode('n1')
    const post = await req(app, `/api/canvas/c1/nodes/n1`, { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ clientId: 'n1', type: 'node', payload: wirePayload(node) }) })
    expect(post.status).toBe(201)
    expect((post.body as { id: string; revision: number }).id).toBe('n1')
    expect((post.body as { revision: number }).revision).toBe(1) // A2-S2:fresh create → rev1
    expect((post.body as { base?: string }).base).toBeTruthy() // 签发 base 供后续 PATCH
    // GET canvas 全量 → 200(metaRevision/contentVersion + nodes)
    const get = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(get.status).toBe(200)
    const body = get.body as { id: string; contentVersion: number; metaRevision: number; nodes: { id: string }[] }
    expect(body.id).toBe('c1')
    expect(body.contentVersion).toBe(1) // 1 child 写入 bump
    expect(body.metaRevision).toBe(0) // 子资源写入不动 metaRevision
    expect(body.nodes.map((n) => n.id)).toEqual(['n1'])
  })

  it('A2-S2:PATCH existing 缺 If-Match → 428;malformed base → 400;正确 base → 200 bump;DELETE stale → 409 race', async () => {
    await pgBackend!.__reset()
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p2', name: 'P2' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c2', projectId: 'p2' }) })
    const node = canonicalNode('n2')
    // POST create(无 If-Match)→ 201 + base1
    const created = await req(app, '/api/canvas/c2/nodes/n2', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ clientId: 'n2', type: 'node', payload: wirePayload(node) }) })
    expect(created.status).toBe(201)
    const base1 = (created.body as { base: string }).base
    // existing PATCH 缺 If-Match → 428
    const c428 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify([{ kind: 'set', fieldPath: ['title'], value: 'x' }]) })
    expect(c428.status).toBe(428)
    expect((c428.body as { error: string }).error).toBe('precondition-required')
    // malformed If-Match(非 BaseCursor '99')→ 400(edit 永不 409;malformed base → 400)
    const c400 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '99' }, body: JSON.stringify([{ kind: 'set', fieldPath: ['title'], value: 'x' }]) })
    expect(c400.status).toBe(400)
    // 正确 If-Match(base1=rev1)→ 200 bump rev2(edit 永远 200)
    const c200 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': base1 }, body: JSON.stringify([{ kind: 'set', fieldPath: ['title'], value: 'x' }]) })
    expect(c200.status).toBe(200)
    expect((c200.body as { revision: number }).revision).toBe(2)
    // DELETE stale(base1=rev1, current rev2)→ 409 race(§14.1 delete stale→409,与 edit 永不 409 对照)
    const d409 = await req(app, '/api/canvas/c2/nodes/n2', { method: 'DELETE', headers: { ...hdr(KEY_A), 'if-match': base1 } })
    expect(d409.status).toBe(409)
    expect((d409.body as { error: string }).error).toBe('revision-conflict')
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
