// server/routes/canvas.route.test.ts
// T1.3 /api/canvas 路由级契约测试(返修版)。覆盖 api-surface §4.2 + 13 条回归:
// 全量 GET(metaRevision/contentVersion #5 + orderKey #6)、枚举(#8)、节点级 PATCH
// (FX-4 + #3 cross-canvas + #4 428/If-Match + #5 payload.id 一致 + #13 白名单 + #12 413 body)、
// edge/anchor DELETE(#8)、硬删子资源(#2)、原子 tree 软删(#2/#7)、reorder(#6)、chat(DP-6)。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req } from './persistTestApp'

describe('/api/canvas routes (T1.3 返修)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  const seedProject = async (id = 'p1'): Promise<void> => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, name: 'P' }) })
  }
  const seedCanvas = async (id = 'c1', projectId = 'p1'): Promise<void> => {
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, projectId, title: 'C' }) })
  }
  /** PATCH node:If-Match 传 base(返修 #4);无 If-Match = create/428-existing。 */
  const patchNode = (canvasId: string, nodeId: string, payload: unknown, ifMatch?: string) =>
    req(app, `/api/canvas/${canvasId}/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
      body: JSON.stringify({ payload }),
    })

  it('POST canvas 缺 project(unknown-project)→ 404;有 project → 201 + metaRevision/contentVersion', async () => {
    const noProject = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p-missing', title: 'C' }) })
    expect(noProject.status).toBe(404)
    expect((noProject.body as { error: string }).error).toBe('unknown-project')

    await seedProject()
    const created = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C', sourceTemplateId: 'tpl-1' }) })
    expect(created.status).toBe(201)
    const body = created.body as { id: string; projectId: string; metaRevision: number; contentVersion: number; sourceTemplateId?: string }
    expect(body.projectId).toBe('p1')
    expect(body.metaRevision).toBe(0) // 返修 #5
    expect(body.contentVersion).toBe(0) // 返修 #5
    expect(body.sourceTemplateId).toBe('tpl-1') // 返修 #8
  })

  it('GET /api/canvas/:id 全量(metaRevision/contentVersion + nodes 带 orderKey #6);子资源 upsert bump contentVersion #5', async () => {
    await seedProject()
    await seedCanvas()
    await patchNode('c1', 'n1', { id: 'n1', type: 'image' }) // create(无 If-Match)
    await patchNode('c1', 'n1', { id: 'n1', type: 'image', title: 't2' }, '0') // update(If-Match:0)
    await patchNode('c1', 'n2', { id: 'n2', type: 'text' })

    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    const body = got.body as { metaRevision: number; contentVersion: number; nodes: { id: string; revision: number; orderKey: number }[] }
    expect(body.metaRevision).toBe(0) // 子资源写入不 bump metaRevision
    expect(body.contentVersion).toBeGreaterThanOrEqual(3) // 返修 #5:3 次 child 写入 bump
    expect(body.nodes).toHaveLength(2)
    expect(body.nodes[0].id).toBe('n1')
    expect(body.nodes[0].revision).toBe(1) // create(0) → update bumped to 1
    expect(body.nodes[0].orderKey).toBe(0) // 返修 #6
    expect(body.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  it('返修 #8:GET /api/canvas?projectId= 枚举', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    const list = await req(app, '/api/canvas?projectId=p1', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    expect((list.body as { canvases: { id: string }[] }).canvases.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    // 跨 owner 不可见
    const cross = await req(app, '/api/canvas?projectId=p1', { headers: hdr(KEY_B) })
    expect((cross.body as { canvases: unknown[] }).canvases).toHaveLength(0)
  })

  it('返修 #4:PATCH node missing→create(无 If-Match);update 须 If-Match;existing 缺 If-Match → 428', async () => {
    await seedProject()
    await seedCanvas()
    const created = await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    expect(created.status).toBe(200)
    expect((created.body as { revision: number }).revision).toBe(0)

    // existing 缺 If-Match → 428 Precondition Required(返修 #4)
    const noBase = await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    expect(noBase.status).toBe(428)
    expect((noBase.body as { error: string; id: string }).error).toBe('precondition-required')

    // If-Match 正确 → 200 bump
    const updated = await patchNode('c1', 'n1', { id: 'n1', type: 'image', title: 't' }, '0')
    expect(updated.status).toBe(200)
    expect((updated.body as { revision: number }).revision).toBe(1)

    // stale If-Match → 409
    const stale = await patchNode('c1', 'n1', { id: 'n1', type: 'image' }, '0')
    expect(stale.status).toBe(409)
    expect((stale.body as { error: string; currentRevision: number }).currentRevision).toBe(1)
  })

  it('返修 #4:If-Match 严格优先于 body.revision(wire body 不带 revision #5;body.revision 被忽略)', async () => {
    await seedProject()
    await seedCanvas()
    await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    // 旧 client 带 body.revision:0 + If-Match:0 → 用 If-Match(0),bump 成功
    const updated = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), 'if-match': '0' },
      body: JSON.stringify({ payload: { id: 'n1', type: 'image' }, revision: 999 }),
    })
    expect(updated.status).toBe(200) // If-Match 优先,body.revision 忽略
  })

  it('返修 #13:payload 白名单——拒 status/tasks/mirror 字段;返修 #5:payload.id 与 path 一致', async () => {
    await seedProject()
    await seedCanvas()
    // status 字段(DP-9 record 不存)→ forbidden-field
    const st = await patchNode('c1', 'n1', { id: 'n1', type: 'image', status: 'ready' })
    expect(st.status).toBe(400)
    expect((st.body as { error: string; reason: string; field: string })).toMatchObject({ error: 'payload-rejected', reason: 'forbidden-field', field: 'status' })
    // tasks 字段(DP-8)→ forbidden-field
    const tk = await patchNode('c1', 'n1', { id: 'n1', type: 'image', tasks: [] })
    expect((tk.body as { reason: string; field: string }).field).toBe('tasks')
    // envelope 镜像字段 ownerId → mirror-field
    const mi = await patchNode('c1', 'n1', { id: 'n1', type: 'image', ownerId: 'x' })
    expect((mi.body as { reason: string; field: string })).toMatchObject({ reason: 'mirror-field', field: 'ownerId' })
    // canvasId mirror
    const mc = await patchNode('c1', 'n1', { id: 'n1', type: 'image', canvasId: 'c1' })
    expect((mc.body as { field: string }).field).toBe('canvasId')
    // payload.id 与 path 不一致 → id-mismatch(返修 #5)
    const idm = await patchNode('c1', 'n1', { id: 'n2', type: 'image' })
    expect((idm.body as { reason: string }).reason).toBe('id-mismatch')
    // 干净 payload → 200 create
    const ok = await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    expect(ok.status).toBe(200)
  })

  it('返修 #12:413 body 完整 TooLargeBody 契约体', async () => {
    await seedProject()
    await seedCanvas()
    const bigPayload = { id: 'n-big', type: 'image', padding: 'x'.repeat(1_100_000) }
    const tooLarge = await patchNode('c1', 'n-big', bigPayload)
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toEqual({ error: 'request-body-too-large', limit: 1048576 })
  })

  it('返修 #3:cross-canvas——node A in c1,PATCH c2/nodes/A → 404;DELETE c2/nodes/A → 404(canvas_id 不可变)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    await patchNode('c1', 'n1', { id: 'n1', type: 'image' }) // n1 属 c1
    // PATCH c2/nodes/n1 → cross-canvas 404(不 create,canvas_id 不可变)
    const crossPatch = await patchNode('c2', 'n1', { id: 'n1', type: 'image' })
    expect(crossPatch.status).toBe(404)
    expect((crossPatch.body as { error: string }).error).toBe('unknown-node')
    // DELETE c2/nodes/n1 → 404
    const crossDel = await req(app, '/api/canvas/c2/nodes/n1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(crossDel.status).toBe(404)
    // n1 仍属 c1(不可变)
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toContain('n1')
  })

  it('返修 #2:DELETE node/edge/anchor 硬删(物理移除,GET canvas 后空)', async () => {
    await seedProject()
    await seedCanvas()
    await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    await req(app, '/api/canvas/c1/edges/e1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'e1', type: 'edge' } }) })
    await req(app, '/api/canvas/c1/anchors/a1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'a1', type: 'point' } }) })

    const dn = await req(app, '/api/canvas/c1/nodes/n1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(dn.status).toBe(204)
    const de = await req(app, '/api/canvas/c1/edges/e1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(de.status).toBe(204)
    const da = await req(app, '/api/canvas/c1/anchors/a1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(da.status).toBe(204)

    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const body = got.body as { nodes: unknown[]; edges: unknown[]; anchors: unknown[] }
    expect(body.nodes).toHaveLength(0)
    expect(body.edges).toHaveLength(0)
    expect(body.anchors).toHaveLength(0)
    // missing DELETE → 404
    const missing = await req(app, '/api/canvas/c1/nodes/never', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(missing.status).toBe(404)
    expect((missing.body as { error: string }).error).toBe('unknown-node')
  })

  it('返修 #2/#7:DELETE canvas → softDeleteCanvasTree(canvas meta + chat-collection 软删;children 活);GET/chat → 404', async () => {
    await seedProject()
    await seedCanvas()
    await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })

    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    // 软删后 GET → 404;chat → 404
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(404)
    // idempotent:删已软删 → 204
    expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(204)
  })

  it('返修 #6:POST /api/canvas/:id/reorder 持久化 orderKey', async () => {
    await seedProject()
    await seedCanvas()
    await patchNode('c1', 'n1', { id: 'n1', type: 'image' })
    await patchNode('c1', 'n2', { id: 'n2', type: 'text' })
    await patchNode('c1', 'n3', { id: 'n3', type: 'text' })
    const reorder = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(reorder.status).toBe(200)
    expect((reorder.body as { reordered: number }).reordered).toBe(3)
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual(['n3', 'n1', 'n2'])
  })

  it('chat 子资源(DP-6):POST→GET→PATCH(If-Match)→DELETE 硬删;missing If-Match → 428', async () => {
    await seedProject()
    await seedCanvas()
    const created = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(created.status).toBe(201)
    expect((created.body as { id: string; revision: number }).id).toBe('m1')

    const replay = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(replay.status).toBe(200) // 幂等 existing

    const list = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((list.body as { messages: unknown[] }).messages).toHaveLength(1)

    // PATCH missing If-Match → 428
    const noBase = await req(app, '/api/canvas/c1/chat/m1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'm1', text: 'e' } }) })
    expect(noBase.status).toBe(428)
    // PATCH If-Match:0 → bump
    const patched = await req(app, '/api/canvas/c1/chat/m1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ payload: { id: 'm1', text: 'e' } }) })
    expect(patched.status).toBe(200)
    expect((patched.body as { revision: number }).revision).toBe(1)

    // DELETE 硬删
    const del = await req(app, '/api/canvas/c1/chat/m1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    const listAfter = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((listAfter.body as { messages: unknown[] }).messages).toHaveLength(0)
  })

  it('owner 隔离:B GET A 的 canvas → 404(同 unknown,无泄漏 #1)', async () => {
    await seedProject()
    await seedCanvas()
    const cross = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/canvas/never', { headers: hdr(KEY_B) })
    expect(cross.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(cross.body).toEqual(unknown.body)
  })
})
