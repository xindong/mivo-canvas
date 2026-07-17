// server/routes/archive.route.test.ts
// Phase 2 归档(PR-A):/api/canvas/:id/archive|unarchive + /api/projects/:id/archive|unarchive 路由级契约测试。
// 覆盖:archive/unarchive 端点(200 + status wire)、CR-6 write-guard(archived canvas 子记录写→409;read/manage 放行)、
// includeArchived 列表过滤、级联归档/恢复、D2 create(status:) 端到端落库。驱动真实 Hono route(memory backend)。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req, canonicalNode, wirePayload, setBaseCursorSecrets } from './persistTestApp'

const TEST_SECRET = ['test', 'secret', 'a2s2'].join('-')
beforeAll(() => setBaseCursorSecrets([TEST_SECRET]))
afterAll(() => setBaseCursorSecrets(null))

describe('Phase 2 归档 routes (PR-A)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  const createProject = (id: string, name = 'P', status?: 'archived' | 'active') =>
    req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, name, ...(status ? { status } : {}) }) })
  const createCanvas = (id: string, projectId = 'p1', status?: 'archived' | 'active') =>
    req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, projectId, title: id, ...(status ? { status } : {}) }) })
  const setup = async () => {
    await createProject('p1')
    await createCanvas('c1', 'p1')
    await createCanvas('c2', 'p1')
  }

  // ── archive/unarchive 端点 ──
  it('POST /api/canvas/:id/archive → 200 + status:archived;幂等(重复→200 no-op)', async () => {
    await setup()
    const a = await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    expect(a.status).toBe(200)
    expect((a.body as { status?: string }).status).toBe('archived')
    // 幂等
    const a2 = await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    expect(a2.status).toBe(200)
    expect((a2.body as { status?: string }).status).toBe('archived')
  })

  it('POST /api/canvas/:id/unarchive → 200 + status 缺省(active);幂等', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    const u = await req(app, '/api/canvas/c1/unarchive', { method: 'POST', headers: hdr(KEY_A) })
    expect(u.status).toBe(200)
    expect((u.body as { status?: string }).status).toBeUndefined() // active 缺省(wire 向后兼容)
    // 幂等
    const u2 = await req(app, '/api/canvas/c1/unarchive', { method: 'POST', headers: hdr(KEY_A) })
    expect(u2.status).toBe(200)
  })

  it('POST /api/canvas/:id/archive 跨 owner → 404 unknown-canvas(无泄漏)', async () => {
    await setup()
    const cross = await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_B) })
    expect(cross.status).toBe(404)
    expect((cross.body as { error: string }).error).toBe('unknown-canvas')
  })

  it('POST /api/canvas/never/archive → 404 unknown-canvas', async () => {
    await setup()
    const r = await req(app, '/api/canvas/never/archive', { method: 'POST', headers: hdr(KEY_A) })
    expect(r.status).toBe(404)
    expect((r.body as { error: string }).error).toBe('unknown-canvas')
  })

  // ── CR-6 write-guard:archived canvas 子记录写→409;read/manage 放行 ──
  it('CR-6:archived canvas GET(读)放行 → 200 + status:archived', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    const g = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(g.status).toBe(200)
    expect((g.body as { status?: string }).status).toBe('archived')
  })

  it('CR-6:archived canvas PUT meta(写)→ 409 archived;body={error:archived,id}', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    const put = await req(app, '/api/canvas/c1', { method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ payload: { projectId: 'p1', title: 'x' } }) })
    expect(put.status).toBe(409)
    expect(put.body).toEqual({ error: 'archived', id: 'c1' })
  })

  it('CR-6:archived canvas POST chat(写)→ 409 archived;恢复后可写', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    const chat = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(chat.status).toBe(409)
    expect((chat.body as { error: string }).error).toBe('archived')
    // 恢复后 chat 可写
    await req(app, '/api/canvas/c1/unarchive', { method: 'POST', headers: hdr(KEY_A) })
    const chat2 = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(chat2.status).toBe(201)
  })

  it('CR-6:archived canvas POST node(子记录写)→ 409 archived', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    const nodeCreate = await req(app, '/api/canvas/c1/nodes/n1', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ clientId: 'n1', type: 'node', payload: wirePayload(canonicalNode('n1')) }) })
    expect(nodeCreate.status).toBe(409)
    expect((nodeCreate.body as { error: string }).error).toBe('archived')
  })

  it('CR-6:archived canvas DELETE(彻底删除,manage)→ 204 放行(彻底删除入口不受 archived guard)', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    // 删后 GET → 404(is_deleted 终态)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
  })

  // ── F-1 锁:非成员对 archived canvas 写→404(非 409,无存在性泄漏)──
  // 防回归:若 CR-6 409 判定被挪回 authz 之前(原 F-1 bug 态),KEY_B 会得 409 archived(泄漏存在性),本用例红;修后得 404(走 authz deny)。
  it('F-1 锁:KEY_B(非成员/无 share)对 KEY_A 的 archived canvas 发写(PUT / node POST)→ 404 unknown-canvas(非 409 archived,无泄漏)', async () => {
    await setup()
    await req(app, '/api/canvas/c1/archive', { method: 'POST', headers: hdr(KEY_A) })
    // 非成员 PUT(写)→ 404(走 authz deny,不返 409 泄漏 archived 存在性)
    const put = await req(app, '/api/canvas/c1', { method: 'PUT', headers: hdr(KEY_B), body: JSON.stringify({ payload: { projectId: 'p1', title: 'x' } }) })
    expect(put.status).toBe(404)
    expect((put.body as { error: string }).error).toBe('unknown-canvas')
    // 非成员 POST node(子记录写)→ 同样 404(非 409;body 经 validateCreateBody/validateChildPayload 后到 authz)
    const nodeCreate = await req(app, '/api/canvas/c1/nodes/n1', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ clientId: 'n1', type: 'node', payload: wirePayload(canonicalNode('n1')) }) })
    expect(nodeCreate.status).toBe(404)
    expect((nodeCreate.body as { error: string }).error).toBe('unknown-canvas')
  })

  // ── includeArchived 列表过滤 ──
  it('GET /api/canvas 默认排除 archived;?includeArchived=true 含 archived', async () => {
    await setup()
    await req(app, '/api/canvas/c2/archive', { method: 'POST', headers: hdr(KEY_A) })
    const def = await req(app, '/api/canvas', { headers: hdr(KEY_A) })
    expect((def.body as { canvases: { id: string }[] }).canvases.map((c) => c.id).sort()).toEqual(['c1'])
    const all = await req(app, '/api/canvas?includeArchived=true', { headers: hdr(KEY_A) })
    expect((all.body as { canvases: { id: string }[] }).canvases.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
  })

  it('GET /api/projects 默认排除 archived project;?includeArchived=true 含', async () => {
    await createProject('p1')
    await createProject('p2')
    await req(app, '/api/projects/p2/archive', { method: 'POST', headers: hdr(KEY_A) })
    const def = await req(app, '/api/projects', { headers: hdr(KEY_A) })
    expect((def.body as { projects: { id: string }[] }).projects.map((p) => p.id).sort()).toEqual(['p1'])
    const all = await req(app, '/api/projects?includeArchived=true', { headers: hdr(KEY_A) })
    expect((all.body as { projects: { id: string }[] }).projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })

  // ── project 级联归档/恢复 ──
  it('POST /api/projects/:id/archive 级联归档 project + 子画布;unarchive 级联恢复', async () => {
    await setup()
    const a = await req(app, '/api/projects/p1/archive', { method: 'POST', headers: hdr(KEY_A) })
    expect(a.status).toBe(200)
    expect((a.body as { status?: string }).status).toBe('archived')
    // 子画布级联归档
    const c1 = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((c1.body as { status?: string }).status).toBe('archived')
    const c2 = await req(app, '/api/canvas/c2', { headers: hdr(KEY_A) })
    expect((c2.body as { status?: string }).status).toBe('archived')
    // 子记录写被 write-guard 拒(级联归档生效)
    const chat = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(chat.status).toBe(409)
    // unarchive 级联恢复子画布(archivedByCascade=true 的)
    const u = await req(app, '/api/projects/p1/unarchive', { method: 'POST', headers: hdr(KEY_A) })
    expect(u.status).toBe(200)
    const c1b = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((c1b.body as { status?: string }).status).toBeUndefined() // active
    // 恢复后子记录写放行
    const chat2 = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(chat2.status).toBe(201)
  })

  it('D3:project 归档/恢复不影响用户先前单独归档的子画布(仍 archived)', async () => {
    await setup()
    // 先单独归档 c2
    await req(app, '/api/canvas/c2/archive', { method: 'POST', headers: hdr(KEY_A) })
    // 归档 project(c1 cascade-archived;c2 已 archived 不重触)
    await req(app, '/api/projects/p1/archive', { method: 'POST', headers: hdr(KEY_A) })
    // 恢复 project → c1 恢复(active);c2 仍 archived(单独归档的不被强制恢复)
    await req(app, '/api/projects/p1/unarchive', { method: 'POST', headers: hdr(KEY_A) })
    const c1 = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((c1.body as { status?: string }).status).toBeUndefined() // active
    const c2 = await req(app, '/api/canvas/c2', { headers: hdr(KEY_A) })
    expect((c2.body as { status?: string }).status).toBe('archived') // D3:仍 archived
  })

  // ── D2:create wire 带 status ──
  it('D2:POST /api/canvas {status:archived} → 201 + body.status=archived + write-guard 即时生效', async () => {
    await createProject('p1')
    const c = await createCanvas('c1', 'p1', 'archived')
    expect(c.status).toBe(201)
    expect((c.body as { status?: string }).status).toBe('archived')
    // 即时 archived:子记录写被拒
    const chat = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(chat.status).toBe(409)
  })

  it('D2:POST /api/projects {status:archived} → 201 + body.status=archived', async () => {
    const p = await createProject('p1', 'P', 'archived')
    expect(p.status).toBe(201)
    expect((p.body as { status?: string }).status).toBe('archived')
    // 默认 list 排除 archived project
    const def = await req(app, '/api/projects', { headers: hdr(KEY_A) })
    expect((def.body as { projects: { id: string }[] }).projects).toHaveLength(0)
    const all = await req(app, '/api/projects?includeArchived=true', { headers: hdr(KEY_A) })
    expect((all.body as { projects: { id: string }[] }).projects.map((x) => x.id)).toEqual(['p1'])
  })

  it('D2:POST /api/canvas {status:active} → 201(显式 active 等同缺省;wire 不带 status)', async () => {
    await createProject('p1')
    const c = await createCanvas('c1', 'p1', 'active')
    expect(c.status).toBe(201)
    expect((c.body as { status?: string }).status).toBeUndefined() // active 缺省
  })

  it('D2:POST /api/canvas {status:bogus} → 400 bad-request', async () => {
    await createProject('p1')
    const c = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', status: 'bogus' }) })
    expect(c.status).toBe(400)
    expect((c.body as { error: string }).error).toBe('bad-request')
  })

  it('既有 DELETE 仍为彻底删除(is_deleted 终态,与 archive 双轨独立)', async () => {
    await setup()
    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // archived 视图也不含 deleted(includeArchived 只返非 deleted)
    const all = await req(app, '/api/canvas?includeArchived=true', { headers: hdr(KEY_A) })
    expect((all.body as { canvases: { id: string }[] }).canvases.map((c) => c.id)).not.toContain('c1')
  })
})
