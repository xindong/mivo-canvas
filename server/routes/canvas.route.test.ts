// server/routes/canvas.route.test.ts
// T1.3 /api/canvas 路由级契约测试(返修版二 N1-N10)。**铁律**:真实 canonical fixture 驱动真实 Hono route。
// 覆盖 api-surface §4.2 + N1 canonical 往返 + N2 restore 生命周期 + N3 chat canvas_id + N4 reuse-conflict
// + N5 If-Match 严格 + N7 authz + N8 reorder + N10 payload allowlist + 原 13 条回归(保持绿):
// 全量 GET(#5/#6)、枚举(#8)、节点级 PATCH(FX-4 + #3 cross-canvas + #4 428/If-Match + #13 白名单 + #12 413)、
// edge/anchor DELETE(#8)、硬删子资源(#2)、原子 tree 软删(#2/#7)、reorder(#6/N8)、chat(DP-6/N2/N3)。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req, canonicalNode, canonicalEdge, canonicalAnchor, wirePayload, patchChildWithFixture } from './persistTestApp'
import { fingerprintOfPlatformKey } from '../lib/keys'

describe('/api/canvas routes (T1.3 返修二 N1-N10)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let backend: ReturnType<typeof buildPersistApp>['backend']

  beforeEach(() => {
    ;({ app, backend } = buildPersistApp())
  })

  const seedProject = async (id = 'p1'): Promise<void> => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, name: 'P' }) })
  }
  const seedCanvas = async (id = 'c1', projectId = 'p1'): Promise<void> => {
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, projectId, title: 'C' }) })
  }

  it('POST canvas 缺 project(unknown-project)→ 404;有 project → 201 + metaRevision/contentVersion', async () => {
    const noProject = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p-missing', title: 'C' }) })
    expect(noProject.status).toBe(404)
    expect((noProject.body as { error: string }).error).toBe('unknown-project')

    await seedProject()
    const created = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C', sourceTemplateId: 'tpl-1' }) })
    expect(created.status).toBe(201)
    const body = created.body as { id: string; projectId: string; metaRevision: number; contentVersion: number; sourceTemplateId?: string }
    expect(body.projectId).toBe('p1')
    expect(body.metaRevision).toBe(0)
    expect(body.contentVersion).toBe(0)
    expect(body.sourceTemplateId).toBe('tpl-1')
  })

  it('R3 F2-B: POST /api/canvas 空 projectId → 400 bad-body(零项目账号修复前客户端 enqueue 此 → 终态删记录 → 画布消失)', async () => {
    // 真 Hono 刻画修复所规避的失败模式:server 模式零项目账号此前 fallback projectId='' →
    // POST 返 400 bad-body → 队列 classifyHttpStatus → rejected terminal → deleteWrite → 刷新画布消失。
    // 客户端修(documentSlice 零项目时自动建 project)后不再 enqueue 空 projectId,本测试刻画服务端
    // 为什么空 projectId 必然失败(契约守门,非静默 200)。
    await seedProject()
    const empty = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', projectId: '', title: 'C' }),
    })
    expect(empty.status).toBe(400)
    const errBody = empty.body as { error: string; message: string }
    expect(errBody.error).toBe('bad-request')
    expect(errBody.message).toMatch(/projectId/i)
  })

  it('R3 F1: sourceTemplateId 真路由存活契约 —— rename PUT(不带 sourceTemplateId)后 GET 仍存活', async () => {
    // 客户端 coalesce(createCanvas+updateCanvas before drain)依赖服务端这条契约:
    // 生产 rename/move 的 PUT payload 不带 sourceTemplateId,服务端必须按字段级合并保留既有值,
    // 否则即便客户端 combineOps 修好了、POST 带上 sourceTemplateId,rename 后也会被服务端擦除。
    await seedProject()
    const created = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'orig', sourceTemplateId: 'tpl-keep' }),
    })
    expect(created.status).toBe(201)
    // GET → 服务端已存 sourceTemplateId
    const get1 = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(get1.status).toBe(200)
    expect((get1.body as { sourceTemplateId?: string }).sourceTemplateId).toBe('tpl-keep')
    // 生产 rename:PUT payload 只带新 title,不带 sourceTemplateId
    const rename = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ payload: { projectId: 'p1', title: 'renamed' } }),
    })
    expect(rename.status).toBe(200)
    // GET → sourceTemplateId 穿过 rename 存活(字段级合并保留了既有值)
    const get2 = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(get2.status).toBe(200)
    const body2 = get2.body as { title: string; sourceTemplateId?: string; metaRevision: number }
    expect(body2.title).toBe('renamed')
    expect(body2.sourceTemplateId).toBe('tpl-keep')
    expect(body2.metaRevision).toBe(1)
  })

  it('R3 F1: sourceTemplateId 真路由存活契约 —— move PUT(换 projectId,不带 sourceTemplateId)后仍存活', async () => {
    await seedProject('p1')
    await seedProject('p2')
    const created = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'orig', sourceTemplateId: 'tpl-keep' }),
    })
    expect(created.status).toBe(201)
    // 生产 move:PUT payload 换 projectId,不带 title 也不带 sourceTemplateId
    const move = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ payload: { projectId: 'p2' } }),
    })
    expect(move.status).toBe(200)
    const get = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(get.status).toBe(200)
    const body = get.body as { title: string; projectId: string; sourceTemplateId?: string }
    expect(body.projectId).toBe('p2') // move 生效
    expect(body.title).toBe('orig') // 未带 title → 保留既有
    expect(body.sourceTemplateId).toBe('tpl-keep') // 未带 → 保留既有(存活)
  })

  it('GET /api/canvas/:id 全量(metaRevision/contentVersion + nodes 带 orderKey #6);子资源 upsert bump contentVersion #5', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1'))) // create
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')), '0') // update
    await patchChildWithFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))

    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    const body = got.body as { metaRevision: number; contentVersion: number; nodes: { id: string; revision: number; orderKey: number }[] }
    expect(body.metaRevision).toBe(0) // 子资源写入不 bump metaRevision
    expect(body.contentVersion).toBeGreaterThanOrEqual(3) // 3 次 child 写入 bump
    expect(body.nodes).toHaveLength(2)
    expect(body.nodes[0].id).toBe('n1')
    expect(body.nodes[0].revision).toBe(1) // create(0) → update bumped to 1
    expect(body.nodes[0].orderKey).toBe(0)
    expect(body.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  it('返修 #8:GET /api/canvas?projectId= 枚举(跨 owner 不可见)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    const list = await req(app, '/api/canvas?projectId=p1', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    expect((list.body as { canvases: { id: string }[] }).canvases.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    const cross = await req(app, '/api/canvas?projectId=p1', { headers: hdr(KEY_B) })
    expect((cross.body as { canvases: unknown[] }).canvases).toHaveLength(0)
  })

  it('返修 #4:PATCH node missing→create(无 If-Match);update 须 If-Match;existing 缺 If-Match → 428', async () => {
    await seedProject()
    await seedCanvas()
    const created = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(created.status).toBe(200)
    expect((created.body as { revision: number }).revision).toBe(0)

    // existing 缺 If-Match → 428
    const noBase = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(noBase.status).toBe(428)
    expect((noBase.body as { error: string; id: string }).error).toBe('precondition-required')

    // If-Match 正确 → 200 bump
    const updated = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')), '0')
    expect(updated.status).toBe(200)
    expect((updated.body as { revision: number }).revision).toBe(1)

    // stale If-Match → 409
    const stale = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')), '0')
    expect(stale.status).toBe(409)
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(1)
  })

  it('返修 #4:If-Match 严格优先于 body.revision(wire body 不带 revision #5;body.revision 被忽略)', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    // 旧 client 带 body.revision:999 + If-Match:0 → 用 If-Match(0),bump 成功;canonical payload 通过白名单
    const updated = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), 'if-match': '0' },
      body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')), revision: 999 }),
    })
    expect(updated.status).toBe(200) // If-Match 优先,body.revision 忽略
  })

  it('返修 #13:payload 白名单——拒 status/tasks/mirror 字段;返修 #5:payload.id 与 path 一致', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // status 字段(DP-9)→ forbidden-field(在 missing 之前命中)
    const st = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, status: 'ready' })
    expect(st.status).toBe(400)
    expect((st.body as { reason: string; field: string })).toMatchObject({ reason: 'forbidden-field', field: 'status' })
    // tasks 字段(DP-8)→ forbidden-field
    const tk = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, tasks: [] })
    expect((tk.body as { field: string }).field).toBe('tasks')
    // envelope 镜像字段 ownerId → mirror-field
    const mi = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, ownerId: 'x' })
    expect((mi.body as { reason: string; field: string })).toMatchObject({ reason: 'mirror-field', field: 'ownerId' })
    // canvasId mirror
    const mc = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, canvasId: 'c1' })
    expect((mc.body as { field: string }).field).toBe('canvasId')
    // payload.id 与 path 不一致 → id-mismatch
    const idm = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, id: 'n2' })
    expect((idm.body as { reason: string }).reason).toBe('id-mismatch')
    // 干净 canonical payload → 200 create
    const ok = await patchChildWithFixture(app, 'c1', 'node', 'n1', base)
    expect(ok.status).toBe(200)
  })

  it('返修 #12:413 body 完整 TooLargeBody 契约体', async () => {
    await seedProject()
    await seedCanvas()
    const big = wirePayload(canonicalNode('n-big')) as Record<string, unknown>
    big.padding = 'x'.repeat(1_100_000) // unknown field,但 body > 1MB → 413 在 read 阶段先于 validation
    const tooLarge = await patchChildWithFixture(app, 'c1', 'node', 'n-big', big)
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toEqual({ error: 'request-body-too-large', limit: 1048576 })
  })

  it('返修 #3:cross-canvas——node A in c1,PATCH c2/nodes/A → 404;DELETE c2/nodes/A → 404(canvas_id 不可变)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1'))) // n1 属 c1
    // PATCH c2/nodes/n1 → cross-canvas 404(不 create,canvas_id 不可变)
    const crossPatch = await patchChildWithFixture(app, 'c2', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(crossPatch.status).toBe(404)
    expect((crossPatch.body as { error: string }).error).toBe('unknown-node')
    // DELETE c2/nodes/n1 → 404
    const crossDel = await req(app, '/api/canvas/c2/nodes/n1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(crossDel.status).toBe(404)
    // n1 仍属 c1(不可变)
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toContain('n1')
  })

  it('返修 #2:DELETE node/edge/anchor 硬删(物理移除,GET canvas 后空);canonical edge/anchor 往返', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    // canonical edge/anchor 往返(含 createdAt 域字段,N1:保留不镜像)
    const e1 = await patchChildWithFixture(app, 'c1', 'edge', 'e1', wirePayload(canonicalEdge('e1')))
    expect(e1.status).toBe(200)
    const a1 = await patchChildWithFixture(app, 'c1', 'anchor', 'a1', wirePayload(canonicalAnchor('a1')))
    expect(a1.status).toBe(200)
    // GET 回读:edge/anchor payload 含 createdAt 域字段
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const body = got.body as { edges: { id: string; payload: Record<string, unknown> }[]; anchors: { id: string; payload: Record<string, unknown> }[] }
    expect(body.edges[0].payload.createdAt).toBe(12345) // N1:domain createdAt 保留
    expect(body.anchors[0].payload.createdAt).toBe(6789)

    const dn = await req(app, '/api/canvas/c1/nodes/n1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(dn.status).toBe(204)
    const de = await req(app, '/api/canvas/c1/edges/e1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(de.status).toBe(204)
    const da = await req(app, '/api/canvas/c1/anchors/a1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(da.status).toBe(204)

    const got2 = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const body2 = got2.body as { nodes: unknown[]; edges: unknown[]; anchors: unknown[] }
    expect(body2.nodes).toHaveLength(0)
    expect(body2.edges).toHaveLength(0)
    expect(body2.anchors).toHaveLength(0)
    // missing DELETE → 404
    const missing = await req(app, '/api/canvas/c1/nodes/never', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(missing.status).toBe(404)
    expect((missing.body as { error: string }).error).toBe('unknown-node')
  })

  it('返修 #2/#7:DELETE canvas → softDeleteCanvasTree(canvas meta + chat-collection 软删;children 活);GET/chat → 404', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })

    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(404)
    // idempotent:删已软删 → 204
    expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(204)
  })

  it('返修 #6/F5:POST /api/canvas/:id/reorder 持久化 orderKey(If-Match contentVersion 必填;响应返 contentVersion)', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await patchChildWithFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
    await patchChildWithFixture(app, 'c1', 'node', 'n3', wirePayload(canonicalNode('n3')))
    // F5:读当前 contentVersion(3 次 child 写入 bump → 3)作 If-Match base
    const before = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const cv = (before.body as { contentVersion: number }).contentVersion
    const reorder = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(reorder.status).toBe(200)
    expect((reorder.body as { reordered: number; contentVersion: number }).reordered).toBe(3)
    expect((reorder.body as { contentVersion: number }).contentVersion).toBeGreaterThan(cv) // F5:响应返新 contentVersion
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

  // ── 返修二 N1-N10 回归(真实 canonical fixture 驱动真实 route)──

  it('N1: canonical node fixture 经 encoder PATCH 真实 route 200;GET 回读 envelope revision 回填;wire payload 无 id/revision', async () => {
    await seedProject()
    await seedCanvas()
    const created = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(created.status).toBe(200)
    expect((created.body as { id: string; revision: number }).revision).toBe(0)
    // GET 回读:envelope revision 回填;payload 域字段保留;wire payload 不携带 id/revision
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const entry = (got.body as { nodes: { id: string; revision: number; payload: Record<string, unknown> }[] }).nodes.find((n) => n.id === 'n1')!
    expect(entry.revision).toBe(0) // envelope revision 回填
    expect(entry.payload.type).toBe('image')
    expect(entry.payload.transform).toEqual(canonicalNode('n1').transform)
    expect(entry.payload.fills).toEqual(canonicalNode('n1').fills)
    expect('revision' in entry.payload).toBe(false) // N1:wire payload 不携带 revision
    expect('id' in entry.payload).toBe(false) // N1:wire payload 不携带 id(取自 path)
  })

  it('N2: create→delete→restore(无 idem)后 canvas+collection 全 live;硬删 child 不复活', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    // 硬删 n1(物理移除)→ 后续 restore 不复活
    await req(app, '/api/canvas/c1/nodes/n1', { method: 'DELETE', headers: hdr(KEY_A) })
    // delete canvas → softDeleteCanvasTree
    await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // restore(no idem):POST canvas c1 → ensureCreate 'restored' → restoreCanvasTree 原子恢复 canvas meta + chat-collection
    const restored = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    expect(restored.status).toBe(200)
    // canvas + collection 全 live
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
    // 硬删 n1 不复活
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).not.toContain('n1')
  })

  it('N2: create→delete→restore(有 idem key)后整树 live + 幂等命中 deleted 真恢复', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // restore with SAME idem key k1 → idem-replay-deleted → 真恢复(restoreCanvasTree)
    const restored = await req(app, '/api/canvas', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(restored.status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('N2: project restore 调 restoreProjectTree——create project+canvas→delete project→restore(POST project)→canvas 全 live', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })
    // delete project → softDeleteProjectTree(project + canvas meta + chat-collection)
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // restore:POST project p1 again → ensureCreate 'restored' → restoreProjectTree 原子恢复整树
    const restored = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(restored.status).toBe(200)
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('N3: chat message id 属 canvas A,POST 到 canvas B → 404(ensureCreateChild canvas_id 校验)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    const created = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(created.status).toBe(201)
    // POST m1 to c2(same id,不同 canvas)→ cross-canvas 404
    const cross = await req(app, '/api/canvas/c2/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(cross.status).toBe(404)
    expect((cross.body as { error: string }).error).toBe('unknown-message')
    // m1 仍属 c1
    const list = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((list.body as { messages: { id: string }[] }).messages.map((m) => m.id)).toContain('m1')
  })

  it('N4: 同 idem key 同 body → 200 不 bump;不同 body → 422 reuse-conflict', async () => {
    await seedProject()
    await seedCanvas()
    // first PATCH(idem k1)
    const r1 = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')) }) })
    expect(r1.status).toBe(200)
    expect((r1.body as { revision: number }).revision).toBe(0)
    // same key same body → 200 no bump
    const r2 = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')) }) })
    expect(r2.status).toBe(200)
    expect((r2.body as { revision: number }).revision).toBe(0) // 不 bump
    // same key different body(title 改)→ 422
    const node2 = canonicalNode('n1'); node2.title = 'changed'
    const r3 = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ payload: wirePayload(node2) }) })
    expect(r3.status).toBe(422)
    expect((r3.body as { error: string }).error).toBe('idempotency-key-reuse')
  })

  it('N5: If-Match 严格——1.5/1e2/0x10/-1/abc/超界 → 400;缺失(existing)→ 428;正确 → base', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1'))) // create rev 0
    // existing + invalid If-Match → 400
    for (const bad of ['1.5', '1e2', '0x10', '-1', 'abc', '99999999999999999999999']) {
      const r = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')), bad)
      expect(r.status).toBe(400)
      expect((r.body as { error: string }).error).toBe('bad-request')
    }
    // existing + missing If-Match → 428
    const noBase = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(noBase.status).toBe(428)
    // correct If-Match:0 → 200 bump
    const ok = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')), '0')
    expect(ok.status).toBe(200)
    expect((ok.body as { revision: number }).revision).toBe(1)
  })

  it('N7: B 跨 owner GET/DELETE A 的 canvas → 404(同 unknown);move projectId 到他人 project → 404;list 仅自己', async () => {
    await seedProject('p1') // A's project
    await seedCanvas('c1', 'p1')
    // B GET A's canvas → 404
    const cross = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/canvas/never', { headers: hdr(KEY_B) })
    expect(cross.status).toBe(404)
    expect(cross.body).toEqual(unknown.body)
    // B DELETE A's canvas → 404
    expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_B) })).status).toBe(404)
    // B list canvases → empty
    expect((await req(app, '/api/canvas', { headers: hdr(KEY_B) })).body).toEqual({ canvases: [] })
    // move:A PUT canvas c1 projectId 到 B 的 project p2 → 404 unknown-project(move 双端 authz)
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'p2', name: 'B-proj' }) })
    const move = await req(app, '/api/canvas/c1', { method: 'PUT', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ payload: { projectId: 'p2' } }) })
    expect(move.status).toBe(404)
    expect((move.body as { error: string }).error).toBe('unknown-project')
    // owner fingerprint 验证 getCanvasOwner 全局索引
    const ownerA = fingerprintOfPlatformKey(KEY_A)
    expect(backend.getCanvasOwner('c1')?.ownerId).toBe(ownerA)
  })

  it('N8/F5: reorder orderedIds 全等+唯一;If-Match contentVersion 必填(缺→428);stale→409;bump contentVersion', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await patchChildWithFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
    await patchChildWithFixture(app, 'c1', 'node', 'n3', wirePayload(canonicalNode('n3')))
    // 读当前 contentVersion(3 次 child 写入 bump → 3)作 If-Match base
    const before = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const cv = (before.body as { contentVersion: number }).contentVersion
    // F5:缺 If-Match → 428(precondition-required)
    const missing = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(missing.status).toBe(428)
    expect((missing.body as { error: string }).error).toBe('precondition-required')
    // duplicate(带 If-Match)→ 400(backend duplicate check 在 contentVersion 冲突之前)
    const dup = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n1', 'n1', 'n2'] }) })
    expect(dup.status).toBe(400)
    // mismatch(带 If-Match)→ 400
    const mis = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2', 'nX'] }) })
    expect(mis.status).toBe(400)
    // reorder ok(If-Match=cv)→ 200 + contentVersion bump
    const r1 = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(r1.status).toBe(200)
    const cv1 = (r1.body as { contentVersion: number }).contentVersion
    expect(cv1).toBeGreaterThan(cv)
    // stale If-Match(cv,已被 r1 bump)→ 409(两并发一成一 409)
    const stale = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n1', 'n2', 'n3'] }) })
    expect(stale.status).toBe(409)
    // correct If-Match(cv1)→ 200
    const ok = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv1) }, body: JSON.stringify({ type: 'node', orderedIds: ['n1', 'n2', 'n3'] }) })
    expect(ok.status).toBe(200)
  })

  it('N10: payload 真 allowlist——缺必填 → missing-field;unknown field → unknown-field;非 string id → bad-id-type', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // 缺必填 transform → missing-field
    const noTransform = { ...base }; delete noTransform.transform
    const r1 = await patchChildWithFixture(app, 'c1', 'node', 'n1', noTransform)
    expect(r1.status).toBe(400)
    expect((r1.body as { reason: string; field?: string }).reason).toBe('missing-field')
    expect((r1.body as { field?: string }).field).toBe('transform')
    // unknown field → unknown-field
    const r2 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, bogusField: 'x' })
    expect((r2.body as { reason: string; field?: string }).reason).toBe('unknown-field')
    expect((r2.body as { field?: string }).field).toBe('bogusField')
    // 非 string id → bad-id-type
    const r3 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, id: 123 })
    expect((r3.body as { reason: string }).reason).toBe('bad-id-type')
    // edge 缺必填(from)→ missing-field
    const eBase = wirePayload(canonicalEdge('e1')) as Record<string, unknown>
    const noFrom = { ...eBase }; delete noFrom.from
    const r4 = await patchChildWithFixture(app, 'c1', 'edge', 'e1', noFrom)
    expect((r4.body as { reason: string }).reason).toBe('missing-field')
    // edge bad type(createdAt 非 number)→ bad-type
    const r5 = await patchChildWithFixture(app, 'c1', 'edge', 'e1', { ...eBase, createdAt: 'not-a-num' })
    expect((r5.body as { reason: string }).reason).toBe('bad-type')
  })

  // ── 返修三 F1-F7 路由级回归(逐字复现场景,真实 app.request 全链路)──

  it('F1: 软删 project 后 POST 旧 c1/新 c2 → 404;restoreProjectTree 后整树 live(禁独立 child restore)', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })
    // 软删 project → softDeleteProjectTree(project + canvas meta + chat-collection)
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // F1:软删 parent 下禁独立 child restore——POST 旧 c1(projectId=p1 deleted)→ 404(不独立 restore)
    const postOld = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(postOld.status).toBe(404)
    expect((postOld.body as { error: string }).error).toBe('unknown-project')
    // F1:POST 新 c2 under deleted project → 404
    const postNew = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c2', projectId: 'p1' }) })
    expect(postNew.status).toBe(404)
    expect((postNew.body as { error: string }).error).toBe('unknown-project')
    // restoreProjectTree(POST project p1)→ 整树 live(project + canvas c1 + chat-collection)
    const restored = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(restored.status).toBe(200)
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('F4: canvas id 全局唯一——A 创建 c1,B 同 id → 409 canvas-exists;A 资源不失联;软删/restore 交互', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'p2', name: 'PB' }) })
    // A 创建 canvas c1
    const aCreate = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(aCreate.status).toBe(201)
    // B 创建同 id c1 → 409 canvas-exists(全局唯一,与 project 同模式)
    const bCreate = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'c1', projectId: 'p2' }) })
    expect(bCreate.status).toBe(409)
    expect((bCreate.body as { error: string; id: string })).toMatchObject({ error: 'canvas-exists', id: 'c1' })
    // A 资源不失联:GET c1 仍 200(A 拥有);B GET c1 → 404(跨 owner 同 unknown)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })).status).toBe(404)
    // 软删/restore 交互:A 软删 c1 → globalCanvasOwners 保留占位 → B POST c1 仍 409
    await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    const bAfterSoftDelete = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'c1', projectId: 'p2' }) })
    expect(bAfterSoftDelete.status).toBe(409)
    // A restore c1(POST c1,project p1 live)→ restoreCanvasTree
    const aRestore = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(aRestore.status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('F5: reorder 并发同 base 一 200 一 409(从 adapter seam 驱动;reorderChildren 带 baseContentVersion)', async () => {
    await seedProject()
    await seedCanvas()
    await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await patchChildWithFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
    const before = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const cv = (before.body as { contentVersion: number }).contentVersion
    // adapter seam:薄 wrapper 镜像 ServerPersistAdapter.reorderChildren(canvasId, type, orderedIds, baseContentVersion)
    const adapterReorder = (orderedIds: string[], baseContentVersion: number) =>
      req(app, '/api/canvas/c1/reorder', {
        method: 'POST',
        headers: { ...hdr(KEY_A), 'if-match': String(baseContentVersion) },
        body: JSON.stringify({ type: 'node', orderedIds }),
      })
    // 两个并发 reorder 同 base(cv)——一 200(bump contentVersion)一 409(contentVersion 冲突)
    const [r1, r2] = await Promise.all([adapterReorder(['n2', 'n1'], cv), adapterReorder(['n2', 'n1'], cv)])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  it('F6: PATCH payload 递归 schema——relations 内藏 status/tasks 400;fontSize 坏类型 400;transform 内坏类型 400', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // relations 内藏 status → forbidden-field(relations.status)
    const f1 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, relations: { status: 'ready' } })
    expect(f1.status).toBe(400)
    expect((f1.body as { reason: string; field?: string })).toMatchObject({ reason: 'forbidden-field', field: 'relations.status' })
    // relations 内藏 tasks → forbidden-field
    const f2 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, relations: { tasks: [] } })
    expect((f2.body as { reason: string }).reason).toBe('forbidden-field')
    // optional fontSize 坏类型('x')→ bad-type
    const f3 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, fontSize: 'x' })
    expect((f3.body as { reason: string; field?: string })).toMatchObject({ reason: 'bad-type', field: 'fontSize' })
    // transform 内坏类型(x 非 number)→ bad-type field=transform.x
    const f4 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, transform: { x: 'bad', y: 0, width: 100, height: 100, rotation: 0 } })
    expect((f4.body as { reason: string; field?: string })).toMatchObject({ reason: 'bad-type', field: 'transform.x' })
    // 干净 canonical → 200 create
    const ok = await patchChildWithFixture(app, 'c1', 'node', 'n1', base)
    expect(ok.status).toBe(200)
  })

  // ── 返修四 P1-1/P1-3 路由级回归(真实 app.request 全链路)──

  it('P1-3/F6:走私有 payload 全 400(markupPoints 走私/fills 坏类型/maskBounds 坏值+extra);canonical 全 200', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // markupPoints 元素走私字段 → 400 unknown-field path=markupPoints[0].smuggled
    const s1 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, markupPoints: [{ x: 0, y: 0, smuggled: 1 }] })
    expect(s1.status).toBe(400)
    expect((s1.body as { reason: string; field?: string })).toMatchObject({ reason: 'unknown-field', field: 'markupPoints[0].smuggled' })
    // fills 元素坏类型(id 非 string)→ 400 bad-type path=fills[0].id
    const s2 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, fills: [{ id: 1, kind: 'solid', color: '#fff', opacity: 1, visible: true }] })
    expect(s2.status).toBe(400)
    expect((s2.body as { reason: string; field?: string })).toMatchObject({ reason: 'bad-type', field: 'fills[0].id' })
    // generation.maskBounds 坏值 + extra → 400 unknown-field path=generation.maskBounds.extra
    const s3 = await patchChildWithFixture(app, 'c1', 'node', 'n1', { ...base, generation: { prompt: 'p', model: 'm', maskBounds: { x: 'bad', y: 0, width: 1, height: 1, extra: 1 } } })
    expect(s3.status).toBe(400)
    expect((s3.body as { reason: string; field?: string })).toMatchObject({ reason: 'unknown-field', field: 'generation.maskBounds.extra' })
    // 合法 canonical → 200
    const okR = await patchChildWithFixture(app, 'c1', 'node', 'n1', base)
    expect(okR.status).toBe(200)
  })

  it('P1-1/F1 barrier:POST canvas 原子建 canvas+collection;DELETE project cascade both → 树内零 live orphan', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    // 原子 create 后:canvas + chat-collection both live(直接 backend 断言)
    const ownerA = fingerprintOfPlatformKey(KEY_A)
    const collBefore = await backend.get(ownerA, 'chat-collection', 'c1')
    expect(collBefore.kind).toBe('found')
    if (collBefore.kind === 'found') expect(collBefore.record.isDeleted).toBe(false)
    // 并发 DELETE project → softDeleteProjectTree cascade canvas meta + chat-collection
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    // 不变量:树内零 live orphan——canvas 软删 + chat-collection 软删(NOT live)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // POST chat under soft-deleted canvas → 404(canvas soft-deleted → unknown-canvas,无 live orphan 可写)
    expect((await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })).status).toBe(404)
    // 直接 backend:chat-collection soft-deleted(非 live orphan)
    const collAfter = await backend.get(ownerA, 'chat-collection', 'c1')
    expect(collAfter.kind).toBe('found')
    if (collAfter.kind === 'found') expect(collAfter.record.isDeleted).toBe(true)
  })

  it('P2-3/F6 返修五 route 级:PATCH node markupKind=bogus → 400;anchor box 缺 width → 400;point 带 width → 400', async () => {
    await seedProject()
    await seedCanvas()
    const baseNode = {
      id: 'n1', type: 'markup' as const, title: 't', revision: 0,
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      fills: [] as unknown[], strokes: [] as unknown[], effects: [] as unknown[], relations: {} as Record<string, unknown>,
    }
    // markupKind=bogus → 400 bad-type markupKind(enum predicate,从 src/types 单一来源导出;旧 scalar(isStr) 放行)
    const bogus = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload({ ...baseNode, markupKind: 'bogus' }))
    expect(bogus.status).toBe(400)
    expect(bogus.body).toMatchObject({ error: 'payload-rejected', reason: 'bad-type', field: 'markupKind' })
    // 合法 markupKind → 200(控制组:枚举合法值通过)
    const ok = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload({ ...baseNode, markupKind: 'arrow' }))
    expect(ok.status).toBe(200)

    // anchor box 缺 width → 400 missing-field width(type 判别 union:box 必填 width+height)
    const boxMissing = await patchChildWithFixture(app, 'c1', 'anchor', 'a1', wirePayload({ id: 'a1', type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, revision: 0, height: 10 }))
    expect(boxMissing.status).toBe(400)
    expect(boxMissing.body).toMatchObject({ error: 'payload-rejected', reason: 'missing-field', field: 'width' })
    // anchor point 带 width → 400 unknown-field width(point 拒 box 专属字段)
    const pointWidth = await patchChildWithFixture(app, 'c1', 'anchor', 'a2', wirePayload({ id: 'a2', type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, revision: 0, width: 10 }))
    expect(pointWidth.status).toBe(400)
    expect(pointWidth.body).toMatchObject({ error: 'payload-rejected', reason: 'unknown-field', field: 'width' })
  })

  it('P2-4 返修五 route 级:owner-only 语义不变——A 访问自己资源全通(GET/PATCH);B 跨 owner 404(无存在泄漏)', async () => {
    await seedProject() // owner A 的 p1
    await seedCanvas()  // owner A 的 c1
    // A 自己 GET canvas → 200(owner===resourceOwner seam)
    const aGet = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(aGet.status).toBe(200)
    // B 跨 owner GET canvas → 404
    const bGet = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    expect(bGet.status).toBe(404)
    // A 自己 PATCH node → 200
    const aPatch = await patchChildWithFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(aPatch.status).toBe(200)
    // B 跨 owner PATCH node → 404(单资源 route 已 resourceOwner 化,canAccessCanvas 拒跨 owner)
    const bPatch = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: hdr(KEY_B), body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')) }) })
    expect(bPatch.status).toBe(404)
  })
})
