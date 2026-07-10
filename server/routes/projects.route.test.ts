// server/routes/projects.route.test.ts
// T1.3 /api/projects 路由级契约测试(内存 backend)。覆盖 api-surface §4.1:
// owner 隔离(404 无泄漏)、幂等创建(同 id→200 existing)、revision 409、DP-3 级联软删。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req } from './persistTestApp'
import { fingerprintOfPlatformKey } from '../lib/keys'

describe('/api/projects routes (T1.3)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let backend: ReturnType<typeof buildPersistApp>['backend']

  beforeEach(() => {
    ;({ app, backend } = buildPersistApp())
  })

  it('POST 无 id → 201 服务端生成 UUID;GET / 含之', async () => {
    const created = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ name: 'p1' }) })
    expect(created.status).toBe(201)
    const proj = created.body as { id: string; name: string; ownerId: string; revision: number }
    expect(proj.name).toBe('p1')
    expect(proj.id).toBeTruthy()
    expect(proj.revision).toBe(0)

    const list = await req(app, '/api/projects', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    expect((list.body as { projects: unknown[] }).projects).toHaveLength(1)
  })

  it('POST 同 id 第二次 → 200 existing(幂等,不重建,revision 不 bump)', async () => {
    const body = JSON.stringify({ id: 'p-fix', name: 'p1' })
    const first = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body })
    expect(first.status).toBe(201)
    expect((first.body as { revision: number }).revision).toBe(0)
    const second = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body })
    expect(second.status).toBe(200) // idempotent existing
    expect((second.body as { revision: number }).revision).toBe(0) // 不 bump
  })

  it('Idempotency-Key header:同 key 第二次返既有(不重建)', async () => {
    const init = { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k-1' }, body: JSON.stringify({ name: 'p1' }) }
    const first = await req(app, '/api/projects', init)
    expect(first.status).toBe(201)
    const firstId = (first.body as { id: string }).id
    const second = await req(app, '/api/projects', { ...init, body: JSON.stringify({ name: 'different' }) })
    expect(second.status).toBe(200) // idempotent replay
    expect((second.body as { id: string }).id).toBe(firstId) // 同一 record,不重建
  })

  it('owner 隔离:A 的项目 B 看不到(B GET A 的 id → 404 unknown-project,同 unknown id body,无泄漏)', async () => {
    const created = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p-a', name: 'A' }) })
    expect(created.status).toBe(201)

    const crossOwner = await req(app, '/api/projects/p-a', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/projects/never-existed', { headers: hdr(KEY_B) })
    expect(crossOwner.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(crossOwner.body).toEqual(unknown.body) // 同 body,无存在泄漏
    expect((crossOwner.body as { error: string }).error).toBe('unknown-project')

    // B 的列表为空(A 的项目不在 B 列表)
    const bList = await req(app, '/api/projects', { headers: hdr(KEY_B) })
    expect((bList.body as { projects: unknown[] }).projects).toHaveLength(0)
  })

  it('PATCH 正确 revision → 200 bumped;stale revision → 409 conflict', async () => {
    const created = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'n0' }) })
    const rev = (created.body as { revision: number }).revision
    expect(rev).toBe(0)

    const ok = await req(app, '/api/projects/p1', {
      method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': String(rev) }, body: JSON.stringify({ name: 'n1' }),
    })
    expect(ok.status).toBe(200)
    expect((ok.body as { name: string; revision: number }).name).toBe('n1')
    expect((ok.body as { revision: number }).revision).toBe(1)

    const stale = await req(app, '/api/projects/p1', {
      method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': String(rev) }, body: JSON.stringify({ name: 'stale' }),
    })
    expect(stale.status).toBe(409)
    expect((stale.body as { error: string; currentRevision: number }).error).toBe('revision-conflict')
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(1)
  })

  it('PATCH missing id → 404', async () => {
    const res = await req(app, '/api/projects/missing', {
      method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toBe('unknown-project')
  })

  it('DELETE 级联软删:删 project → 其下 canvas + chat 一并软删(DP-3)', async () => {
    // 建项目 + canvas + 一条 chat message + 一个 node
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'n1', type: 'image' }, revision: 0 }),
    })

    const del = await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)

    // 级联:canvas + node + chat 都软删 → GET 各 404
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(404)
    // backend 层直接验软删标记(DP-3 一起软删,非物理删)
    const owner = fingerprintOfPlatformKey(KEY_A)
    const canvasRec = await backend.get(owner, 'canvas', 'c1')
    expect(canvasRec.kind).toBe('found')
    expect(canvasRec.kind === 'found' && canvasRec.record.isDeleted).toBe(true)
    const nodeRec = await backend.get(owner, 'node', 'n1')
    expect(nodeRec.kind === 'found' && nodeRec.record.isDeleted).toBe(true)
    const msgRec = await backend.get(owner, 'chat-message', 'm1')
    expect(msgRec.kind === 'found' && msgRec.record.isDeleted).toBe(true)

    // DELETE 幂等:再删一次 → 204(已删)
    const del2 = await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del2.status).toBe(204)
    // DELETE missing → 404
    const del3 = await req(app, '/api/projects/never', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del3.status).toBe(404)
  })

  it('malformed X-Mivo-Api-Key → 400(无 env 回退,F4 边界)', async () => {
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-api-key': 'not-a-mivo-key' } })
    expect(res.status).toBe(400)
  })
})
