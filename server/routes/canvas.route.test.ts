// server/routes/canvas.route.test.ts
// T1.3 /api/canvas 路由级契约测试(内存 backend)。覆盖 api-surface §4.2:
// 全量 GET、POST(projectId 须属 owner)、节点级 PATCH FX-4(create/update/409/413)、
// chat 子资源(DP-6)、级联软删、owner 隔离。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req } from './persistTestApp'

describe('/api/canvas routes (T1.3)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  // helper:建 owner A 的 project(POST /api/canvas 须 project 存在)
  const seedProject = async (id = 'p1'): Promise<void> => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, name: 'P' }) })
  }

  it('POST canvas 缺 project(unknown-project)→ 404;有 project → 201', async () => {
    const noProject = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p-missing', title: 'C' }) })
    expect(noProject.status).toBe(404)
    expect((noProject.body as { error: string }).error).toBe('unknown-project')

    await seedProject()
    const created = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    expect(created.status).toBe(201)
    expect((created.body as { id: string; projectId: string; revision: number }).projectId).toBe('p1')
    expect((created.body as { revision: number }).revision).toBe(0)
  })

  it('GET /api/canvas/:id 全量(meta + nodes/edges/anchors),per-record revision 出现', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    // n1:create(rev 0)→ update(base 0 匹配→bump rev 1),验 GET 带最新 envelope revision
    await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1', type: 'image', title: 't' }, revision: 0 }) })
    await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1', type: 'image', title: 't2' }, revision: 0 }) })
    await req(app, '/api/canvas/c1/anchors/a1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'a1', type: 'point' }, revision: 0 }) })

    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    const body = got.body as { id: string; revision: number; nodes: { id: string; revision: number; payload: unknown }[]; anchors: unknown[]; edges: unknown[] }
    expect(body.id).toBe('c1')
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0].id).toBe('n1')
    expect(body.nodes[0].revision).toBe(1) // create 0 → update bumped to 1;GET 带最新 envelope revision
    expect(body.anchors).toHaveLength(1)
  })

  it('节点级 PATCH(FX-4):missing→create;同 revision 再 PATCH→409;413 body>1MB', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })

    // missing → create(revision 0)
    const created = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1', type: 'image' }, revision: 0 }),
    })
    expect(created.status).toBe(200)
    const rev = (created.body as { revision: number }).revision
    expect(rev).toBe(0)

    // update with correct base revision → bumped
    const updated = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1', type: 'image', title: 't2' }, revision: rev }),
    })
    expect(updated.status).toBe(200)
    expect((updated.body as { revision: number }).revision).toBe(1)

    // stale revision → 409
    const stale = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1', type: 'image' }, revision: rev }),
    })
    expect(stale.status).toBe(409)
    expect((stale.body as { error: string; currentRevision: number }).currentRevision).toBe(1)

    // 413:body > 1MB(FX-4 jsonRequestMaxBytes)
    const bigPayload = { id: 'n-big', type: 'image', padding: 'x'.repeat(1_100_000) }
    const tooLarge = await req(app, '/api/canvas/c1/nodes/n-big', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: bigPayload, revision: 0 }),
    })
    expect(tooLarge.status).toBe(413)
  })

  it('PATCH node on missing canvas → 404 unknown-canvas;PATCH on deleted canvas → 404', async () => {
    await seedProject()
    const noCanvas = await req(app, '/api/canvas/missing/nodes/n1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1' }, revision: 0 }),
    })
    expect(noCanvas.status).toBe(404)
    expect((noCanvas.body as { error: string }).error).toBe('unknown-canvas')
  })

  it('chat 子资源(DP-6):POST message → GET 列表 → PATCH → DELETE', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })

    const created = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(created.status).toBe(201)
    expect((created.body as { id: string; revision: number }).id).toBe('m1')

    // idempotent:同 message.id 再 POST → 200 existing
    const replay = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(replay.status).toBe(200)

    const list = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    expect((list.body as { messages: unknown[] }).messages).toHaveLength(1)

    // PATCH message revision-checked
    const patched = await req(app, '/api/canvas/c1/chat/m1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'm1', role: 'user', text: 'edited' }, revision: 0 }),
    })
    expect(patched.status).toBe(200)
    expect((patched.body as { revision: number }).revision).toBe(1)

    // stale → 409
    const stale = await req(app, '/api/canvas/c1/chat/m1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'm1' }, revision: 0 }),
    })
    expect(stale.status).toBe(409)

    // DELETE message → 204;再 GET 列表为空
    const del = await req(app, '/api/canvas/c1/chat/m1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    const listAfter = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((listAfter.body as { messages: unknown[] }).messages).toHaveLength(0)
  })

  it('DELETE /api/canvas/:id 级联软删 nodes/anchors/chat(DP-3/DP-6)', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1' }, revision: 0 }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })

    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)

    // 软删后 GET → 404;chat 列表 → 404(canvas 软删)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(404)
  })

  it('owner 隔离:B GET A 的 canvas → 404(同 unknown,无泄漏)', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    const cross = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/canvas/never', { headers: hdr(KEY_B) })
    expect(cross.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(cross.body).toEqual(unknown.body)
  })

  it('DELETE child node 软删;missing node → 404', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1' }, revision: 0 }) })

    const del = await req(app, '/api/canvas/c1/nodes/n1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    // 删后 canvas GET 的 nodes 为空
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: unknown[] }).nodes).toHaveLength(0)

    // missing node DELETE → 404
    const missing = await req(app, '/api/canvas/c1/nodes/never', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(missing.status).toBe(404)
    expect((missing.body as { error: string }).error).toBe('unknown-node')
  })
})
