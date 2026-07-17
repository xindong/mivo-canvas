// serverPersistAdapter.wiring.test.ts
// G1-a 非画布域接线验证:createFetchServerPersistAdapter 的请求构造 + 响应解析 + 错误→HttpError
// 映射。用 stub BFF(契约 wire shape,复用 shared 校验 helper 防漂移)验证非画布域 CRUD 往返一致。
//
// 为何 stub 而非 buildPersistApp:adapter 用 Blob/FormData/fetch(DOM lib,属 app 项目 tsconfig);
// server/routes/* 用 node:crypto(node lib,属 server 项目)。单 tsconfig 无两 lib 叠加,故 src/lib/
// 测试不能 import server 代码(tsc -b 会因 app 项目无 node types 报 TS2591)。真 BFF 落 PG 往返由
// server/routes/*.route.test.ts(InMemoryPersistBackend,镜像生产 wire)覆盖;本测试钉死 adapter 的
// client→wire 正确性,与 route test 合起来证明 client→wire→BFF→backend 全链一致(中间 shared 契约
// 类型互锁由 serverPersistAdapter.contract.test.ts 覆盖)。
//
// 默认 mode=local 零变化:本测试只测 wired adapter(显式构造,不依赖 persistMode);unwired 全 reject
// 由 contract test 钉死(本测试末尾再钉一次回归保护)。

import { describe, expect, it, afterEach } from 'vitest'
import {
  isUserStateKeyNamespaceAllowed,
  scanForSensitiveFields,
  scanUserStateKeyForCredential,
  type CanvasMeta,
  type CreateAssetResponse,
  type GetCanvasResponse,
  type NodePayload,
  type Project,
  type UserStateEntry,
} from '../../shared/persist-contract.ts'
import { createFetchServerPersistAdapter, HttpError, unwiredServerPersistAdapter } from './serverPersistAdapter'
import { storeCanvasCursor, __resetCanvasCursorStore } from './snapshotCursorStore'
import type { NodeRecord } from '../kernel/records'

const KEY_A = 'mivo_aaa_user_a'
const KEY_B = 'mivo_bbb_user_b'
const authHeaders = (key: string) => (): Record<string, string> => ({ 'x-mivo-api-key': key })

const json = (body: unknown, status: number, contentType = 'application/json'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })

/** stub BFF:小内存 store,镜像 /api/projects + /api/user-state + /api/canvas[:id] wire 形状 + DP-7 校验。
 * 复用 shared 契约 helper(isUserStateKeyNamespaceAllowed / scan*),与真 BFF(server/routes/userState.ts)同源校验,防 stub 漂移。 */
const makeStubBff = () => {
  const projects = new Map<string, { project: Project; owner: string }>()
  const userState = new Map<string, { value: unknown; revision: number; owner: string }>()
  const canvases = new Map<string, { meta: CanvasMeta; owner: string }>()

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers((init?.headers as Record<string, string>) ?? {})
    const owner = headers.get('x-mivo-api-key') ?? 'anon'
    const path = new URL(input, 'http://stub').pathname

    // POST /api/projects
    if (method === 'POST' && path === '/api/projects') {
      const b = JSON.parse((init?.body as string) ?? '{}') as { name: string; id?: string }
      const id = b.id?.trim() || 'auto'
      const existing = projects.get(id)
      if (existing && existing.owner !== owner) return json({ error: 'project-exists', id }, 409)
      const project: Project = { id, name: b.name, ownerId: owner, createdAt: 't0', updatedAt: 't1', revision: 0, isDeleted: false }
      projects.set(id, { project, owner })
      return json(project, 201)
    }
    // GET /api/projects
    if (method === 'GET' && path === '/api/projects') {
      const list = [...projects.values()].filter((p) => p.owner === owner).map((p) => p.project)
      return json({ projects: list }, 200)
    }

    // PUT /api/user-state/:key
    if (method === 'PUT' && path.startsWith('/api/user-state/')) {
      const key = decodeURIComponent(path.slice('/api/user-state/'.length))
      if (!isUserStateKeyNamespaceAllowed(key) || scanUserStateKeyForCredential(key) !== null)
        return json({ error: 'forbidden-key', key }, 400)
      const b = JSON.parse((init?.body as string) ?? '{}') as { value: unknown }
      const sensitivePath = scanForSensitiveFields(b.value)
      if (sensitivePath !== null) return json({ error: 'forbidden-value', key, path: sensitivePath }, 400)
      const ifMatch = headers.get('if-match') // missing → null(string | null)
      const existing = userState.get(key)
      if (existing && ifMatch === null) return json({ error: 'precondition-required', id: key }, 428)
      if (existing && ifMatch !== null && Number(ifMatch) !== existing.revision)
        return json({ error: 'revision-conflict', id: key, currentRevision: existing.revision }, 409)
      const newRev = (existing?.revision ?? -1) + 1
      userState.set(key, { value: b.value, revision: newRev, owner })
      return json({ id: key, revision: newRev }, 200)
    }
    // GET /api/user-state/:key
    if (method === 'GET' && path.startsWith('/api/user-state/') && path !== '/api/user-state') {
      const key = decodeURIComponent(path.slice('/api/user-state/'.length))
      const e = userState.get(key)
      if (!e || e.owner !== owner) return json({ error: 'unknown-key' }, 404)
      const entry: UserStateEntry = { key, value: e.value, revision: e.revision, updatedAt: 't', isDeleted: false }
      return json(entry, 200)
    }
    // DELETE /api/user-state/:key
    if (method === 'DELETE' && path.startsWith('/api/user-state/')) {
      const key = decodeURIComponent(path.slice('/api/user-state/'.length))
      if (!userState.has(key)) return new Response(null, { status: 404 })
      userState.delete(key)
      return new Response(null, { status: 204 })
    }

    // GET /api/canvas/:id
    if (method === 'GET' && path.startsWith('/api/canvas/') && path !== '/api/canvas') {
      const id = decodeURIComponent(path.slice('/api/canvas/'.length))
      const c = canvases.get(id)
      if (!c || c.owner !== owner) return json({ error: 'unknown-canvas' }, 404)
      const res: GetCanvasResponse = {
        ...c.meta,
        nodes: [], edges: [], anchors: [],
      }
      return json(res, 200)
    }
    // GET /api/canvas (list)
    if (method === 'GET' && path === '/api/canvas') {
      const list = [...canvases.values()].filter((c) => c.owner === owner).map((c) => c.meta)
      return json({ canvases: list }, 200)
    }

    // POST /api/canvas/:id/nodes|edges|anchors/:childId (create) — A2-S3 wired(lead 授权方案 A;create 先行)
    if (method === 'POST' && /^\/api\/canvas\/[^/]+\/(nodes|edges|anchors)\/[^/]+$/.test(path)) {
      const segs = path.split('/')
      const childId = decodeURIComponent(segs[segs.length - 1] ?? '')
      // stub:返 CanvasChildUpsertResponse(seq+base 必填,lead ②;wire shape 钉死,非真 backend 语义)
      return json({ id: childId, revision: 1, seq: 1, base: `stub-base:${childId}` }, 201)
    }
    // POST /api/canvas/:id/reorder — A2-S3 wired(reorder If-Match = bare contentVersion)
    if (method === 'POST' && /^\/api\/canvas\/[^/]+\/reorder$/.test(path)) {
      const b = JSON.parse((init?.body as string) ?? '{}') as { orderedIds?: string[] }
      return json({ reordered: b.orderedIds?.length ?? 0, contentVersion: 1, base: 'stub-order-base' }, 200)
    }

    // POST /api/canvas/:id/archive|unarchive — Phase 2 归档(空 body ArchiveRequest=Record<string,never>;
    //   无 If-Match;返更新后 CanvasMeta)。wire:archive → status:'archived';unarchive → status 缺省(active)。
    if (method === 'POST' && /^\/api\/canvas\/[^/]+\/(archive|unarchive)$/.test(path)) {
      const segs = path.split('/')
      const id = decodeURIComponent(segs[3] ?? '')
      const action = segs[4] ?? ''
      const c = canvases.get(id)
      if (!c || c.owner !== owner) return json({ error: 'unknown-canvas' }, 404)
      const newRev = c.meta.metaRevision + 1
      const updated: CanvasMeta = action === 'archive'
        ? { ...c.meta, status: 'archived', metaRevision: newRev }
        : { ...c.meta, status: undefined, metaRevision: newRev } // unarchive:显式 undefined 覆盖继承的 archived → JSON.stringify 丢弃 → wire 无 status(active)
      canvases.set(id, { meta: updated, owner })
      return json(updated, 200)
    }
    // POST /api/projects/:id/archive|unarchive — Phase 2 归档(空 body;返更新后 Project;级联由真 server 做,stub 不模拟)
    if (method === 'POST' && /^\/api\/projects\/[^/]+\/(archive|unarchive)$/.test(path)) {
      const segs = path.split('/')
      const id = decodeURIComponent(segs[3] ?? '')
      const action = segs[4] ?? ''
      const p = projects.get(id)
      if (!p || p.owner !== owner) return json({ error: 'unknown-project' }, 404)
      const newRev = p.project.revision + 1
      const updated: Project = action === 'archive'
        ? { ...p.project, status: 'archived', revision: newRev, updatedAt: 't2' }
        : { ...p.project, status: undefined, revision: newRev, updatedAt: 't2' } // unarchive:status 缺省(active)
      projects.set(id, { project: updated, owner })
      return json(updated, 200)
    }

    return new Response(null, { status: 404 })
  }

  // test-only seeders(不经 adapter,直接置 stub store;模拟已存在的 canvas)
  const seedCanvas = (id: string, owner: string, projectId = 'p1', title = 'c') => {
    const meta: CanvasMeta = { id, projectId, title, createdAt: 't0', updatedAt: 't1', metaRevision: 0, contentVersion: 0 }
    canvases.set(id, { meta, owner })
  }
  const seedProject = (id: string, owner: string, name = 'proj') => {
    const project: Project = { id, name, ownerId: owner, createdAt: 't0', updatedAt: 't1', revision: 0, isDeleted: false }
    projects.set(id, { project, owner })
  }
  return { fetch, projects, userState, canvases, seedCanvas, seedProject }
}

const makeAdapter = (stub: ReturnType<typeof makeStubBff>, key = KEY_A) =>
  createFetchServerPersistAdapter({ fetch: stub.fetch, baseUrl: '', getAuthHeaders: authHeaders(key) })

describe('G1-a project CRUD round-trip(stub BFF wire shape)', () => {
  it('createProject → listProjects 往返一致(201 + 列表含该项目)', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    const created = await adapter.createProject('my-proj', 'proj-1')
    expect(created.id).toBe('proj-1')
    expect(created.name).toBe('my-proj')
    expect(created.ownerId).toBe(KEY_A)
    expect(created.revision).toBe(0)
    const list = await adapter.listProjects()
    expect(list.projects.map((p) => p.id)).toContain('proj-1')
  })

  it('createProject 全局唯一 id:跨 owner 同 id → 409 project-exists', async () => {
    const stub = makeStubBff()
    const a = makeAdapter(stub, KEY_A)
    const b = makeAdapter(stub, KEY_B)
    await a.createProject('a-proj', 'shared-id')
    await expect(b.createProject('b-proj', 'shared-id')).rejects.toMatchObject({
      name: 'HttpError', status: 409, body: { error: 'project-exists', id: 'shared-id' },
    })
  })

  it('createProject 幂等:同 owner 同 id 再 create → 200 既有', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    const first = await adapter.createProject('p', 'idem-1')
    const second = await adapter.createProject('p', 'idem-1')
    expect(second.id).toBe('idem-1')
    expect(second.ownerId).toBe(first.ownerId)
  })
})

describe('G1-a user-state CRUD round-trip(stub BFF wire shape)', () => {
  it('putUserState(新建)→ getUserState → deleteUserState → getUserState(null) 全链', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    const created = await adapter.putUserState('pref:tool', 'brush')
    expect(created.id).toBe('pref:tool')
    expect(typeof created.revision).toBe('number')
    const got = await adapter.getUserState('pref:tool')
    expect(got?.value).toBe('brush')
    expect(got?.revision).toBe(created.revision)
    await adapter.deleteUserState('pref:tool')
    expect(await adapter.getUserState('pref:tool')).toBeNull()
  })

  it('putUserState 更新带 baseRevision → revision bump;getUserState 见新值', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    const r1 = await adapter.putUserState('pref:brush', 'highlighter')
    const r2 = await adapter.putUserState('pref:brush', 'pen', r1.revision)
    expect(r2.revision).toBe(r1.revision + 1)
    expect((await adapter.getUserState('pref:brush'))?.value).toBe('pen')
  })

  it('putUserState existing 缺 base → 428 precondition-required', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    await adapter.putUserState('pref:tool', 'brush')
    await expect(adapter.putUserState('pref:tool', 'pen')).rejects.toMatchObject({
      name: 'HttpError', status: 428,
    })
  })

  it('putUserState stale base → 409 revision-conflict(返 currentRevision)', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    const r1 = await adapter.putUserState('pref:tool', 'brush')
    await adapter.putUserState('pref:tool', 'pen', r1.revision) // bump
    await expect(adapter.putUserState('pref:tool', 'marker', r1.revision)).rejects.toMatchObject({
      name: 'HttpError', status: 409, body: { error: 'revision-conflict', id: 'pref:tool' },
    })
  })

  it('DP-7:forbidden-key(gateway-key / 非 allowlist)→ 400', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    await expect(adapter.putUserState('gateway-key', 'x')).rejects.toMatchObject({
      name: 'HttpError', status: 400, body: { error: 'forbidden-key' },
    })
    await expect(adapter.putUserState('random:stuff', 'x')).rejects.toMatchObject({
      name: 'HttpError', status: 400, body: { error: 'forbidden-key' },
    })
  })

  it('DP-7:forbidden-value(凭据格式 string value + 敏感字段名)→ 400', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    await expect(adapter.putUserState('pref:tool', 'mivo_stolenkey')).rejects.toMatchObject({
      name: 'HttpError', status: 400, body: { error: 'forbidden-value' },
    })
    await expect(adapter.putUserState('recent:projects', [{ token: 'leaked' }])).rejects.toMatchObject({
      name: 'HttpError', status: 400, body: { error: 'forbidden-value' },
    })
  })

  it('deleteUserState 幂等:删不存在 key → 不抛(404 视为成功)', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    await expect(adapter.deleteUserState('pref:never')).resolves.toBeUndefined()
  })
})

describe('G1-a canvas-meta hydrate(fetchCanvas / listCanvas 读路径)', () => {
  it('fetchCanvas 不存在 → null(404 吃掉)', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    expect(await adapter.fetchCanvas('no-such')).toBeNull()
  })
  it('fetchCanvas 存在 → GetCanvasResponse(meta + nodes/edges/anchors 数组)', async () => {
    const stub = makeStubBff()
    stub.seedCanvas('c1', KEY_A, 'p1', 'canvas-1')
    const adapter = makeAdapter(stub)
    const got = await adapter.fetchCanvas('c1')
    expect(got?.id).toBe('c1')
    expect(got?.projectId).toBe('p1')
    expect(got?.title).toBe('canvas-1')
    expect(Array.isArray(got?.nodes)).toBe(true)
    expect(Array.isArray(got?.edges)).toBe(true)
    expect(Array.isArray(got?.anchors)).toBe(true)
  })
  it('listCanvas → canvases 数组;listCanvas(projectId) 过滤', async () => {
    const stub = makeStubBff()
    stub.seedCanvas('c1', KEY_A, 'p1', 'c-one')
    const adapter = makeAdapter(stub)
    const list = await adapter.listCanvas()
    expect(list.canvases.map((c) => c.id)).toContain('c1')
    const filtered = await adapter.listCanvas('p1')
    expect(filtered.canvases.every((c) => c.projectId === 'p1')).toBe(true)
  })
})

describe('A2-S3 画布域写:create/reorder/edit/delete 全 7 写口真发(lead 方案 A)', () => {
  afterEach(() => __resetCanvasCursorStore())

  /** 预填 bundle holder(模拟 hydrate 已签发 per-record base;edit/delete 从此取 If-Match base)。 */
  const seedBundle = (canvasId: string, recordId: string, base: string): void => {
    const resp: GetCanvasResponse = {
      id: canvasId, projectId: 'p1', title: 'c', createdAt: 't0', updatedAt: 't1',
      metaRevision: 0, contentVersion: 1, sinceSeq: 5,
      nodes: [{ id: recordId, revision: 1, orderKey: 0, payload: {} as NodePayload, base }],
      edges: [], anchors: [],
    }
    storeCanvasCursor(resp)
  }

  it('upsertNode/Edge/Anchor 无 base → POST create:wired(201 CanvasChildUpsertResponse;wire shape 钉死)', async () => {
    const stub = makeStubBff()
    const calls: { path: string; init: RequestInit }[] = []
    const spyFetch = async (input: string, init?: RequestInit) => {
      calls.push({ path: input, init: init ?? {} })
      return stub.fetch(input, init)
    }
    const adapter = createFetchServerPersistAdapter({ fetch: spyFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    const node = { id: 'n1', type: 'image', title: 't', transform: { x: 1 } } as unknown as NodeRecord
    const res = await adapter.upsertNode('c1', node)
    // 返 CanvasChildUpsertResponse(seq+base 必填,lead ②)
    expect(res.id).toBe('n1')
    expect(res.seq).toBe(1)
    expect(res.base).toBe('stub-base:n1')
    // wire shape:POST /api/canvas/c1/nodes/n1,body = CreateBody{clientId, type, payload(无 id/revision)}
    expect(calls[0].path).toBe('/api/canvas/c1/nodes/n1')
    expect(calls[0].init.method).toBe('POST')
    const body = JSON.parse((calls[0].init.body as string) ?? '{}') as { clientId: string; type: string; payload: Record<string, unknown> }
    expect(body.clientId).toBe('n1')
    expect(body.type).toBe('node')
    expect(body.payload).not.toHaveProperty('id')
    expect(body.payload).not.toHaveProperty('revision')
    expect(body.payload.title).toBe('t')
    // 确定性 idempotencyKey(防 retry dup→409)
    expect(new Headers((calls[0].init.headers as Record<string, string>) ?? {}).get('idempotency-key')).toBe('create-node:c1:n1')
    // edge/anchor 同型
    await adapter.upsertEdge('c1', { id: 'e1' } as never)
    await adapter.upsertAnchor('c1', { id: 'a1' } as never)
    expect(calls[1].path).toBe('/api/canvas/c1/edges/e1')
    expect(calls[2].path).toBe('/api/canvas/c1/anchors/a1')
  })

  it('upsertNode 带 base → edit:leaf-decompose payload → PATCH DomainOp[] + If-Match=bundle base', async () => {
    const calls: { path: string; init: RequestInit }[] = []
    const spyFetch = async (input: string, init?: RequestInit) => {
      calls.push({ path: input, init: init ?? {} })
      return json({ id: 'n1', revision: 2, seq: 6, base: 'new-base' }, 200)
    }
    const adapter = createFetchServerPersistAdapter({ fetch: spyFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    seedBundle('c1', 'n1', 'bundle-base-n1') // 预填 bundle(hydrate 签发 base)
    const node = { id: 'n1', type: 'image', title: 'edited', transform: { x: 2, y: 3 } } as unknown as NodeRecord
    const res = await adapter.upsertNode('c1', node, 1) // baseRevision defined → edit
    expect(res.revision).toBe(2)
    expect(calls[0].path).toBe('/api/canvas/c1/nodes/n1')
    expect(calls[0].init.method).toBe('PATCH')
    expect(new Headers((calls[0].init.headers as Record<string, string>) ?? {}).get('if-match')).toBe('bundle-base-n1')
    // body = DomainOp[](leaf-decompose:set 原子叶子 + array whole-lww replace;无 id/revision;无 unset)
    const ops = JSON.parse((calls[0].init.body as string) ?? '[]') as Array<{ kind: string; fieldPath: string[]; value?: unknown }>
    expect(ops.map((o) => o.kind).every((k) => k === 'set' || k === 'array')).toBe(true)
    const paths = ops.map((o) => o.fieldPath.join('.'))
    expect(paths).toContain('title')
    expect(paths).toContain('transform.x')
    expect(paths).toContain('transform.y') // 嵌套对象递归到叶子
    expect(paths).not.toContain('id')
    expect(paths).not.toContain('revision')
  })

  it('edit 无 bundle base → notWiredG1c(fail-visible;hydrate 先填 bundle;禁借用别的 record base 串用)', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    await expect(adapter.upsertNode('c1', { id: 'n1', type: 'image' } as unknown as NodeRecord, 1)).rejects.toThrow(/G1-c/)
  })

  it('deleteNode/Edge/Anchor:DELETE + If-Match=bundle base;404→idempotent void;无 base→notWiredG1c', async () => {
    const calls: { path: string; init: RequestInit }[] = []
    const spyFetch = async (input: string, init?: RequestInit) => {
      calls.push({ path: input, init: init ?? {} })
      return new Response(null, { status: 204 })
    }
    const adapter = createFetchServerPersistAdapter({ fetch: spyFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    seedBundle('c1', 'n1', 'bundle-base-n1')
    await adapter.deleteNode('c1', 'n1')
    expect(calls[0].path).toBe('/api/canvas/c1/nodes/n1')
    expect(calls[0].init.method).toBe('DELETE')
    expect(new Headers((calls[0].init.headers as Record<string, string>) ?? {}).get('if-match')).toBe('bundle-base-n1')
    // 404 → idempotent void(不抛)
    const spy404 = async () => new Response(null, { status: 404 })
    const adapter404 = createFetchServerPersistAdapter({ fetch: spy404, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    seedBundle('c1', 'n1', 'bundle-base-n1')
    await expect(adapter404.deleteNode('c1', 'n1')).resolves.toBeUndefined()
    // 无 bundle base → notWiredG1c(须 clean bundle store;先前 seedBundle 残留会致命中 base 走 DELETE)
    __resetCanvasCursorStore()
    const stub = makeStubBff()
    const adapterNoBundle = makeAdapter(stub)
    await expect(adapterNoBundle.deleteNode('c1', 'n1')).rejects.toThrow(/G1-c/)
  })

  it('deleteNode 409 → re-raise HttpError(delete race;不静默成功;caller owns conflict recovery)', async () => {
    const spy409 = async () => json({ error: 'revision-conflict', id: 'n1', currentRevision: 2 }, 409)
    const adapter = createFetchServerPersistAdapter({ fetch: spy409, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    seedBundle('c1', 'n1', 'stale-base')
    await expect(adapter.deleteNode('c1', 'n1')).rejects.toMatchObject({ name: 'HttpError', status: 409 })
  })

  it('reorderChildren:wired(POST /:id/reorder,If-Match=bare contentVersion;响应 {reordered,contentVersion,base})', async () => {
    const calls: { path: string; init: RequestInit }[] = []
    const stubFetch = async (input: string, init?: RequestInit) => {
      calls.push({ path: input, init: init ?? {} })
      return json({ reordered: 2, contentVersion: 2, base: 'stub-order-base' }, 200)
    }
    const adapter = createFetchServerPersistAdapter({ fetch: stubFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    const res = await adapter.reorderChildren('c1', 'node', ['n1', 'n2'], 1)
    expect(res).toEqual({ reordered: 2, contentVersion: 2, base: 'stub-order-base' })
    expect(calls[0].path).toBe('/api/canvas/c1/reorder')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers((calls[0].init.headers as Record<string, string>) ?? {}).get('if-match')).toBe('1') // bare contentVersion
    const body = JSON.parse((calls[0].init.body as string) ?? '{}') as { type: string; orderedIds: string[] }
    expect(body.type).toBe('node')
    expect(body.orderedIds).toEqual(['n1', 'n2'])
  })

  it('appendChatMessage 已 wired(DP-6R P1-1):POST /api/canvas/:id/chat(stub 无 chat route → 404 HttpError,非 DP-6R seam reject)', async () => {
    const stub = makeStubBff()
    const adapter = makeAdapter(stub)
    // appendChatMessage 现为 wired op:POST 到 BFF(stub 未挂 chat route → 404)。不再是 notWiredDP6R reject。
    await expect(adapter.appendChatMessage('c1', { text: 'hi' })).rejects.toMatchObject({
      name: 'HttpError', status: 404,
    })
  })
})

describe('G1-a asset 方法 wire(stub fetch;全量往返见 server/routes/assets.test.ts)', () => {
  it('uploadAsset → POST /api/assets multipart,返 CreateAssetResponse,带鉴权头,不手设 Content-Type', async () => {
    const calls: { path: string; init: RequestInit }[] = []
    const stubFetch = async (input: string, init?: RequestInit) => {
      calls.push({ path: input, init: init ?? {} })
      return json({ assetId: 'a1', mimeType: 'image/png', originalName: 'x.png', sizeBytes: 3, refcount: 1, deduped: false } satisfies CreateAssetResponse, 200)
    }
    const adapter = createFetchServerPersistAdapter({ fetch: stubFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    const res = await adapter.uploadAsset(new Uint8Array([1, 2, 3]), { mimeType: 'image/png', originalName: 'x.png' })
    expect(res.assetId).toBe('a1')
    expect(calls[0].path).toBe('/api/assets')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBeInstanceOf(FormData)
    const headers = new Headers((calls[0].init.headers as Record<string, string>) ?? {})
    expect(headers.get('x-mivo-api-key')).toBe(KEY_A)
    expect(headers.get('content-type')).toBeNull() // multipart boundary 由 FormData 自带
  })
  it('resolveAsset → GET /api/assets/:id 返 bytes+mime;404 → null', async () => {
    const bytes = new Uint8Array([10, 20, 30])
    const stubFetch = async (input: string) => {
      if (input.includes('/api/assets/missing')) return new Response('Asset not found', { status: 404 })
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    const adapter = createFetchServerPersistAdapter({ fetch: stubFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    const got = await adapter.resolveAsset('a1')
    expect(got?.mimeType).toBe('image/png')
    expect(Array.from(got?.bytes ?? new Uint8Array())).toEqual([10, 20, 30])
    expect(await adapter.resolveAsset('missing')).toBeNull()
  })
  it('uploadAsset 413 → HttpError(不静默成功)', async () => {
    const stubFetch = async () => json({ error: 'request-body-too-large', limit: 1048576 }, 413)
    const adapter = createFetchServerPersistAdapter({ fetch: stubFetch, baseUrl: '', getAuthHeaders: authHeaders(KEY_A) })
    await expect(adapter.uploadAsset(new Uint8Array([1]), { mimeType: 'image/png', originalName: 'x.png' })).rejects.toMatchObject({
      name: 'HttpError', status: 413,
    })
  })
})

describe('G1-a 默认 mode=local 零变化证据', () => {
  it('unwiredServerPersistAdapter 仍全 reject(契约 test 钉死;回归保护)', async () => {
    await expect(unwiredServerPersistAdapter.fetchCanvas('c1')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.createProject('p')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.putUserState('k', 'v')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.uploadAsset(new Uint8Array(), { mimeType: 'image/png', originalName: 'x' })).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.appendChatMessage('c1', {})).rejects.toThrow(/not wired/)
  })
  it('HttpError 是 HttpError 的 instance(executor 用 instanceof 分类)', () => {
    const e = new HttpError(409, { error: 'revision-conflict' })
    expect(e).toBeInstanceOf(HttpError)
    expect(e.status).toBe(409)
    expect(e.name).toBe('HttpError')
  })
})

describe('Phase 2 归档 archive/unarchive adapter 路径(空 body + revision 回捕 + status wire)', () => {
  // 锁测 P2:adapter.archiveCanvas/unarchiveCanvas/archiveProject/unarchiveProject 走 POST 空 body
  //   (ArchiveRequest = Record<string,never>;adapter 不发 body),无 If-Match;返更新后 CanvasMeta/Project
  //   (status:archived wire / active 缺省)+ revision/metaRevision bump 供 drain onSuccess 回灌。
  //   空 body 用 fetch spy 断言(init.body === undefined)。
  const makeAdapterWithSpy = (stub: ReturnType<typeof makeStubBff>, key = KEY_A) => {
    const calls: { method: string; path: string; body?: string }[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: new URL(input, 'http://stub').pathname,
        body: init?.body as string | undefined,
      })
      return stub.fetch(input, init)
    }
    const adapter = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: authHeaders(key) })
    return { adapter, calls }
  }

  it('archiveCanvas → POST /api/canvas/:id/archive 空 body;返 CanvasMeta(status:archived,metaRevision bump)', async () => {
    const stub = makeStubBff()
    stub.seedCanvas('c1', KEY_A, 'p1', 'orig')
    const { adapter, calls } = makeAdapterWithSpy(stub)
    const got = await adapter.archiveCanvas('c1')
    expect(got.status).toBe('archived')
    expect(got.metaRevision).toBe(1) // bump from 0
    expect(got.id).toBe('c1')
    // 空 body + POST + 正确 path
    const arch = calls.find((c) => c.path === '/api/canvas/c1/archive')
    expect(arch).toBeDefined()
    expect(arch!.method).toBe('POST')
    expect(arch!.body).toBeUndefined() // ArchiveRequest = Record<string,never>;adapter 不发 body
  })

  it('unarchiveCanvas → POST /api/canvas/:id/unarchive 空 body;返 CanvasMeta(status 缺省=active wire)', async () => {
    const stub = makeStubBff()
    stub.seedCanvas('c1', KEY_A, 'p1', 'c')
    const { adapter, calls } = makeAdapterWithSpy(stub)
    await adapter.archiveCanvas('c1') // 先 archive(0→1)
    const got = await adapter.unarchiveCanvas('c1') // unarchive(1→2)
    expect(got.status).toBeUndefined() // active 缺省(wire 不回传 status,向后兼容旧 client)
    expect(got.metaRevision).toBe(2)
    const unarch = calls.find((c) => c.path === '/api/canvas/c1/unarchive')
    expect(unarch).toBeDefined()
    expect(unarch!.method).toBe('POST')
    expect(unarch!.body).toBeUndefined() // 空 body
  })

  it('archiveProject → POST /api/projects/:id/archive 空 body;返 Project(status:archived,revision bump)', async () => {
    const stub = makeStubBff()
    stub.seedProject('p1', KEY_A, 'P1')
    const { adapter, calls } = makeAdapterWithSpy(stub)
    const got = await adapter.archiveProject('p1')
    expect(got.status).toBe('archived')
    expect(got.revision).toBe(1) // bump from 0
    expect(got.id).toBe('p1')
    const arch = calls.find((c) => c.path === '/api/projects/p1/archive')
    expect(arch).toBeDefined()
    expect(arch!.method).toBe('POST')
    expect(arch!.body).toBeUndefined() // 空 body
  })

  it('unarchiveProject → POST /api/projects/:id/unarchive 空 body;返 Project(status 缺省=active)', async () => {
    const stub = makeStubBff()
    stub.seedProject('p1', KEY_A, 'P1')
    const { adapter, calls } = makeAdapterWithSpy(stub)
    await adapter.archiveProject('p1') // 0→1
    const got = await adapter.unarchiveProject('p1') // 1→2
    expect(got.status).toBeUndefined() // active 缺省
    expect(got.revision).toBe(2)
    const unarch = calls.find((c) => c.path === '/api/projects/p1/unarchive')
    expect(unarch).toBeDefined()
    expect(unarch!.method).toBe('POST')
    expect(unarch!.body).toBeUndefined() // 空 body
  })
})
