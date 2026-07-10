// server/routes/projects.route.test.ts
// T1.3 /api/projects 路由级契约测试(返修版)。覆盖 13 条回归:
// #1 project id 全局唯一(跨 owner → 409 project-exists)+ 授权 seam(跨 owner → 404)、
// #2/#7 DELETE softDeleteProjectTree 原子级联(canvas meta + chat-collection 软删;children 活)、
// #4 428/If-Match、#10 幂等跨 type 不串、#12 413 完整 body。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req, canonicalNode, wirePayload } from './persistTestApp'
import { fingerprintOfPlatformKey } from '../lib/keys'

describe('/api/projects routes (T1.3 返修)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let backend: ReturnType<typeof buildPersistApp>['backend']

  beforeEach(() => {
    ;({ app, backend } = buildPersistApp())
  })

  const create = async (key: string, id: string, name = 'P') =>
    req(app, '/api/projects', { method: 'POST', headers: hdr(key), body: JSON.stringify({ id, name }) })

  it('POST 无 id → 201 服务端生成 UUID;GET / 含之', async () => {
    const created = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ name: 'p1' }) })
    expect(created.status).toBe(201)
    const proj = created.body as { id: string; name: string; ownerId: string; revision: number }
    expect(proj.name).toBe('p1')
    expect(proj.id).toBeTruthy()
    expect(proj.revision).toBe(0)
    const list = await req(app, '/api/projects', { headers: hdr(KEY_A) })
    expect((list.body as { projects: unknown[] }).projects).toHaveLength(1)
  })

  it('返修 #1:project id 全局唯一——跨 owner 同 id → 409 project-exists;同 owner → 幂等 200', async () => {
    const a = await create(KEY_A, 'p1')
    expect(a.status).toBe(201)
    const a2 = await create(KEY_A, 'p1')
    expect(a2.status).toBe(200) // 同 owner 幂等
    const b = await create(KEY_B, 'p1')
    expect(b.status).toBe(409) // 跨 owner 全局唯一
    expect((b.body as { error: string; id: string })).toMatchObject({ error: 'project-exists', id: 'p1' })
  })

  it('返修 #1:授权 seam——B GET A 的 project → 404(同 unknown,无泄漏);B list 为空', async () => {
    await create(KEY_A, 'p-a')
    const crossOwner = await req(app, '/api/projects/p-a', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/projects/never-existed', { headers: hdr(KEY_B) })
    expect(crossOwner.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(crossOwner.body).toEqual(unknown.body)
    expect((crossOwner.body as { error: string }).error).toBe('unknown-project')
    const bList = await req(app, '/api/projects', { headers: hdr(KEY_B) })
    expect((bList.body as { projects: unknown[] }).projects).toHaveLength(0)
  })

  it('返修 #4:PATCH existing 缺 If-Match → 428;stale → 409;正确 → 200 bump', async () => {
    await create(KEY_A, 'p1', 'n0')
    // existing 缺 If-Match → 428
    const noBase = await req(app, '/api/projects/p1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ name: 'n1' }) })
    expect(noBase.status).toBe(428)
    expect((noBase.body as { error: string; id: string }).error).toBe('precondition-required')
    // If-Match:0 → bump
    const ok = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ name: 'n1' }) })
    expect(ok.status).toBe(200)
    expect((ok.body as { name: string; revision: number }).revision).toBe(1)
    // stale 0 → 409
    const stale = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ name: 'stale' }) })
    expect(stale.status).toBe(409)
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(1)
    // PATCH missing → 404
    const missing = await req(app, '/api/projects/missing', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ name: 'x' }) })
    expect(missing.status).toBe(404)
  })

  it('返修 #2/#7:DELETE → softDeleteProjectTree 原子级联(canvas meta + chat-collection 软删;children 保持活记录)', async () => {
    await create(KEY_A, 'p1')
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')) }) })

    const del = await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    // 级联软删:project + canvas meta + chat-collection → isDeleted=true
    const owner = fingerprintOfPlatformKey(KEY_A)
    const isDel = async (type: 'project' | 'canvas' | 'chat-collection' | 'node' | 'chat-message', id: string): Promise<boolean | undefined> => {
      const r = await backend.get(owner, type, id)
      return r.kind === 'found' ? r.record.isDeleted : undefined
    }
    expect(await isDel('project', 'p1')).toBe(true)
    expect(await isDel('canvas', 'c1')).toBe(true)
    expect(await isDel('chat-collection', 'c1')).toBe(true)
    // 返修 #2:children(node/chat-message)保持活记录(不软删,随父级不可见)
    expect(await isDel('node', 'n1')).toBe(false)
    expect(await isDel('chat-message', 'm1')).toBe(false)
    // GET 层:canvas/chat → 404(父级不可见)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(404)
    // idempotent:删已软删 → 204;missing → 404
    expect((await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(204)
    expect((await req(app, '/api/projects/never', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(404)
  })

  it('返修 #10:幂等跨 type 不串(POST project + POST canvas 同 idempotency-key → 两条独立)', async () => {
    const a = await req(app, '/api/projects', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(a.status).toBe(201)
    const c = await req(app, '/api/canvas', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(c.status).toBe(201) // 跨 type 不串
    // 同 type 同 key → 幂等回放 200
    const a2 = await req(app, '/api/projects', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(a2.status).toBe(200)
  })

  it('返修 #12:413 body 完整 TooLargeBody', async () => {
    const big = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p-big', name: 'x'.repeat(1_100_000) }) })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: 'request-body-too-large', limit: 1048576 })
  })

  it('malformed X-Mivo-Api-Key → 400(无 env 回退,F4 边界)', async () => {
    const res = await req(app, '/api/projects', { headers: { 'x-mivo-api-key': 'not-a-mivo-key' } })
    expect(res.status).toBe(400)
  })

  it('N4: project POST 同 idem key 同 body → 200 不 bump;不同 body → 422', async () => {
    const r1 = await req(app, '/api/projects', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'kp1' }, body: JSON.stringify({ id: 'p-n4', name: 'P' }) })
    expect(r1.status).toBe(201)
    const r2 = await req(app, '/api/projects', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'kp1' }, body: JSON.stringify({ id: 'p-n4', name: 'P' }) })
    expect(r2.status).toBe(200) // 幂等回放,不 bump
    expect((r2.body as { revision: number }).revision).toBe(0)
    const r3 = await req(app, '/api/projects', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'kp1' }, body: JSON.stringify({ id: 'p-n4', name: 'DIFF' }) })
    expect(r3.status).toBe(422)
    expect((r3.body as { error: string }).error).toBe('idempotency-key-reuse')
  })

  it('N5: project PATCH If-Match 1.5/0x10/-1/abc → 400;缺失 → 428;正确 → bump', async () => {
    await create(KEY_A, 'p-n5', 'n0')
    for (const bad of ['1.5', '0x10', '-1', 'abc']) {
      const r = await req(app, '/api/projects/p-n5', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': bad }, body: JSON.stringify({ name: 'n1' }) })
      expect(r.status).toBe(400)
      expect((r.body as { error: string }).error).toBe('bad-request')
    }
    // missing If-Match(existing)→ 428
    expect((await req(app, '/api/projects/p-n5', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ name: 'n1' }) })).status).toBe(428)
    // correct → bump
    const ok = await req(app, '/api/projects/p-n5', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ name: 'n1' }) })
    expect(ok.status).toBe(200)
    expect((ok.body as { revision: number }).revision).toBe(1)
  })

  it('F2: project PATCH 同 idem key 同 body → 200 不 bump;不同 body → 422(fingerprint 传入 upsert)', async () => {
    await create(KEY_A, 'p-f2', 'n0')
    // first PATCH(idem k1,name=n1,If-Match:0)→ 200 bump rev 1
    const r1 = await req(app, '/api/projects/p-f2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1', 'if-match': '0' }, body: JSON.stringify({ name: 'n1' }) })
    expect(r1.status).toBe(200)
    expect((r1.body as { revision: number }).revision).toBe(1)
    // same idem key same body(name=n1)→ 200 不 bump(返既有 rev 1;idem-replay 短路,免 If-Match)
    const r2 = await req(app, '/api/projects/p-f2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ name: 'n1' }) })
    expect(r2.status).toBe(200)
    expect((r2.body as { revision: number }).revision).toBe(1)
    // same idem key different body(name=DIFF)→ 422 reuse-conflict(fingerprint mismatch)
    const r3 = await req(app, '/api/projects/p-f2', { method: 'PATCH', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ name: 'DIFF' }) })
    expect(r3.status).toBe(422)
    expect((r3.body as { error: string }).error).toBe('idempotency-key-reuse')
  })
})
