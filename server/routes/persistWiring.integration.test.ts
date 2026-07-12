// persistWiring.integration.test.ts
// G1-a P2-1 真实 BFF 集成测试:用 buildPersistApp + Hono app.request 驱动真实 routes(server/routes/*)。
//
// 修复的假阳性(原 serverPersistAdapter.wiring.test.ts 的 stub 缺陷):
//  1. stub 只读 pathname 忽略 query → listCanvas(projectId) 断言恒过(只 seed 一个 canvas)。
//  2. stub owner=raw api key ≠ 真实指纹/SSO → actor 隔离未真实覆盖。
// 本测试用真实 routes(KEY_A/KEY_B → 不同指纹)覆盖:
//  - listCanvas('?projectId=p1') seed p1+p2 后只返 p1 的 canvas(query filter 真实)。
//  - actor 隔离:KEY_A 的 canvas 对 KEY_B 不可见(真实指纹,非 raw key)。
//  - 428 precondition-required / 409 revision-conflict / 422 reuse-conflict / 404-delete 幂等。
//  - multipart asset 单列在 assetsAttachDetach.test.ts(本文件覆盖 projects/canvas/user-state)。
//
// 本测试不 import src/lib adapter(跨 tsconfig 项目边界,TS2591);adapter 的 wire-shape 正确性由
// serverPersistAdapter.wiring.test.ts(stub)覆盖,真实 route 行为由本文件覆盖——两端合起来证 client→wire→BFF→backend。

import { describe, it, expect } from 'vitest'
import { buildPersistApp, req, KEY_A, KEY_B, hdr } from './persistTestApp'

// 创建 project(KEY_A)并返回 id。
const createProject = async (app: ReturnType<typeof buildPersistApp>['app'], name: string, id: string, key = KEY_A) => {
  const res = await req(app, '/api/projects', {
    method: 'POST',
    headers: { ...hdr(key), 'content-type': 'application/json' },
    body: JSON.stringify({ name, id }),
  })
  expect(res.status).toBe(201)
  return res.body as { id: string; revision: number }
}

// 在 project 下创建 canvas(KEY_A)。
const createCanvas = async (
  app: ReturnType<typeof buildPersistApp>['app'],
  projectId: string,
  canvasId: string,
  title: string,
  key = KEY_A,
) => {
  const res = await req(app, '/api/canvas', {
    method: 'POST',
    headers: { ...hdr(key), 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, id: canvasId, title }),
  })
  expect(res.status).toBe(201)
  return res.body as { id: string; metaRevision: number; contentVersion: number }
}

describe('G1-a P2-1 — listCanvas(projectId) query filter(真实 route,修 stub 忽略 query 假阳性)', () => {
  it('seed p1+p2 各一个 canvas 后 GET /api/canvas?projectId=p1 只返 p1 的 canvas', async () => {
    const { app } = buildPersistApp()
    await createProject(app, 'p-one', 'p1')
    await createProject(app, 'p-two', 'p2')
    await createCanvas(app, 'p1', 'c1', 'canvas-under-p1')
    await createCanvas(app, 'p2', 'c2', 'canvas-under-p2')

    // query filter:只返 p1 的 canvas(不是全部 2 个——stub 假阳性处)
    const res = await req(app, '/api/canvas?projectId=p1', { method: 'GET', headers: hdr(KEY_A) })
    expect(res.status).toBe(200)
    const list = (res.body as { canvases: { id: string; projectId: string }[] }).canvases
    expect(list.map((c) => c.id)).toEqual(['c1'])
    expect(list.every((c) => c.projectId === 'p1')).toBe(true)

    // 无 query → 返全部(owner 范围内)
    const all = await req(app, '/api/canvas', { method: 'GET', headers: hdr(KEY_A) })
    expect(((all.body as { canvases: { id: string }[] }).canvases).map((c) => c.id).sort()).toEqual(['c1', 'c2'])
  })
})

describe('G1-a P2-1 — actor 隔离(真实指纹,非 raw key stub)', () => {
  it('KEY_A 的 canvas 对 KEY_B 不可见(list 返空;GET :id → 404 无泄漏)', async () => {
    const { app } = buildPersistApp()
    await createProject(app, 'a-proj', 'pa', KEY_A)
    await createCanvas(app, 'pa', 'c-a', 'canvas-A', KEY_A)

    // KEY_B 列表:看不到 KEY_A 的 canvas(真实指纹隔离)
    const listB = await req(app, '/api/canvas', { method: 'GET', headers: hdr(KEY_B) })
    expect(listB.status).toBe(200)
    expect((listB.body as { canvases: unknown[] }).canvases).toEqual([])

    // KEY_B 直接 GET KEY_A 的 canvas → 404(不泄漏存在性)
    const getB = await req(app, '/api/canvas/c-a', { method: 'GET', headers: hdr(KEY_B) })
    expect(getB.status).toBe(404)
  })
})

describe('G1-a P2-1 — If-Match 契约:428 / 409 / 422 / 404-delete(真实 route)', () => {
  it('PUT /api/canvas/:id 既有 canvas 缺 If-Match → 428 precondition-required', async () => {
    const { app } = buildPersistApp()
    await createProject(app, 'p', 'p1')
    await createCanvas(app, 'p1', 'c1', 't')
    const res = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { projectId: 'p1', title: 'renamed' } }),
    })
    expect(res.status).toBe(428)
  })

  it('PUT /api/canvas/:id stale If-Match → 409 revision-conflict + currentRevision', async () => {
    const { app } = buildPersistApp()
    await createProject(app, 'p', 'p1')
    const created = await createCanvas(app, 'p1', 'c1', 't')
    // bump rev:PUT with correct If-Match (metaRevision 0)
    const bump = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(created.metaRevision) },
      body: JSON.stringify({ payload: { projectId: 'p1', title: 'v2' } }),
    })
    expect(bump.status).toBe(200)
    // stale If-Match (旧 base 0) → 409 revision-conflict + currentRevision
    const stale = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(created.metaRevision) },
      body: JSON.stringify({ payload: { projectId: 'p1', title: 'v3' } }),
    })
    expect(stale.status).toBe(409)
    const body = stale.body as { error: string; currentRevision: number }
    expect(body.error).toBe('revision-conflict')
    expect(typeof body.currentRevision).toBe('number')
  })

  it('POST /api/canvas 同 idempotency-key 不同 body → 422 reuse-conflict', async () => {
    const { app } = buildPersistApp()
    await createProject(app, 'p', 'p1')
    const first = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
      body: JSON.stringify({ projectId: 'p1', id: 'c1', title: 'first' }),
    })
    expect(first.status).toBe(201)
    // 同 idem-key 不同 body → 422
    const reuse = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
      body: JSON.stringify({ projectId: 'p1', id: 'c1', title: 'DIFFERENT' }),
    })
    expect(reuse.status).toBe(422)
  })

  it('DELETE /api/canvas/:id 不存在 → 404;存在 → 204(幂等)', async () => {
    const { app } = buildPersistApp()
    await createProject(app, 'p', 'p1')
    await createCanvas(app, 'p1', 'c1', 't')
    // 不存在 → 404
    const missing = await req(app, '/api/canvas/nonexistent', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(missing.status).toBe(404)
    // 存在 → 204
    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
  })
})

describe('G1-a P2-1 — project PATCH If-Match 契约(428/409)真实 route', () => {
  it('PATCH /api/projects/:id 缺 If-Match → 428;stale → 409;正确 → 200', async () => {
    const { app } = buildPersistApp()
    const created = await createProject(app, 'p', 'p1')
    // 缺 If-Match → 428
    const noMatch = await req(app, '/api/projects/p1', {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(noMatch.status).toBe(428)
    // 正确 If-Match → 200
    const ok = await req(app, '/api/projects/p1', {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(created.revision) },
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(ok.status).toBe(200)
    // stale If-Match (旧 base) → 409
    const stale = await req(app, '/api/projects/p1', {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(created.revision) },
      body: JSON.stringify({ name: 'stale' }),
    })
    expect(stale.status).toBe(409)
  })
})

describe('G1-a P2-1 — user-state If-Match 契约(428/409)真实 route', () => {
  it('PUT /api/user-state/:key 既有缺 If-Match → 428;stale → 409;正确 → 200', async () => {
    const { app } = buildPersistApp()
    // 新建(无 base)→ rev 0
    const create = await req(app, '/api/user-state/pref:tool', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'brush' }),
    })
    expect(create.status).toBe(200)
    const rev = (create.body as { revision: number }).revision
    // 既有缺 If-Match → 428
    const noMatch = await req(app, '/api/user-state/pref:tool', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'pen' }),
    })
    expect(noMatch.status).toBe(428)
    // bump:正确 If-Match(rev)→ 200,revision 升
    const bump = await req(app, '/api/user-state/pref:tool', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(rev) },
      body: JSON.stringify({ value: 'bumped' }),
    })
    expect(bump.status).toBe(200)
    // stale:旧 base(rev)现在 stale(current 已 bump)→ 409 revision-conflict + currentRevision
    const stale = await req(app, '/api/user-state/pref:tool', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(rev) },
      body: JSON.stringify({ value: 'stale' }),
    })
    expect(stale.status).toBe(409)
    const staleBody = stale.body as { error: string; currentRevision: number }
    expect(staleBody.error).toBe('revision-conflict')
    expect(typeof staleBody.currentRevision).toBe('number')
    // 正确 If-Match(current)→ 200
    const ok = await req(app, '/api/user-state/pref:tool', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': String(staleBody.currentRevision) },
      body: JSON.stringify({ value: 'ok' }),
    })
    expect(ok.status).toBe(200)
  })
})

describe('G1-a R3 F2-A — user-state 真实消费方依赖的 server 端 round-trip(canvas:<id>:selection)', () => {
  // 客户端 hydrateFromServer 现真实消费 `canvas:<id>:selection`(DP-1 frozen key,恢复 active canvas
  // selection 到 store;R3 F2-A)。本测试刻画服务端 round-trip:PUT string-array value → GET list/单 key
  // 返该 value(hydrate 读此形状)。证客户端消费方读到的服务端真值,且跨 owner 隔离。
  it('PUT /api/user-state/canvas:c1:selection {value:string[]} → GET 返该 value(rev 0 create)', async () => {
    const { app } = buildPersistApp()
    const put = await req(app, '/api/user-state/canvas:c1:selection', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ value: ['n1', 'n2'] }),
    })
    expect(put.status).toBe(200)
    expect((put.body as { revision: number }).revision).toBe(0)
    // GET list → hydrateUserStateMap 读的同一形状
    const list = await req(app, '/api/user-state', { method: 'GET', headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    const entries = (list.body as { entries: Record<string, { value: unknown; revision: number }> }).entries
    expect(entries['canvas:c1:selection']).toBeDefined()
    expect(entries['canvas:c1:selection'].value).toEqual(['n1', 'n2'])
    // 单 key GET 亦返
    const single = await req(app, '/api/user-state/canvas:c1:selection', { method: 'GET', headers: hdr(KEY_A) })
    expect(single.status).toBe(200)
    expect((single.body as { value: unknown }).value).toEqual(['n1', 'n2'])
  })

  it('canvas:<id>:selection 跨 owner 隔离(KEY_A 的 selection 不被 KEY_B 见)', async () => {
    const { app } = buildPersistApp()
    await req(app, '/api/user-state/canvas:c1:selection', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ value: ['n-a'] }),
    })
    await req(app, '/api/user-state/canvas:c1:selection', {
      method: 'PUT',
      headers: { ...hdr(KEY_B), 'content-type': 'application/json' },
      body: JSON.stringify({ value: ['n-b'] }),
    })
    const listA = await req(app, '/api/user-state', { method: 'GET', headers: hdr(KEY_A) })
    expect((listA.body as { entries: Record<string, { value: unknown }> }).entries['canvas:c1:selection'].value).toEqual(['n-a'])
    const listB = await req(app, '/api/user-state', { method: 'GET', headers: hdr(KEY_B) })
    expect((listB.body as { entries: Record<string, { value: unknown }> }).entries['canvas:c1:selection'].value).toEqual(['n-b'])
  })
})
