// persistWriteExecutor.test.ts
// G1-a retry 接线验证:createAdapterWriteExecutor dispatch by op.kind → 共享 requestJson +
// idempotency-key header + classifyHttpStatus 映射 WriteOutcome。非画布域写接通;画布域写 + chat
// → terminal(不重试不调 adapter)。
//
// stub BFF(契约 wire shape)验证成功/冲突/幂等删路径;stub fetch 验证 5xx/401/429/422 + non-HttpError throw。
// 与 serverPersistAdapter.wiring.test.ts 同款:不 import server 代码(app 项目无 node types;tsc -b 会报 TS2591)。

import { describe, expect, it } from 'vitest'
import { createAdapterWriteExecutor } from './persistWriteExecutor'
import type { WriteOp } from './writeRetryQueue'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = () => (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** stateful stub BFF:user-state Map(支持 428/409 语义)+ project create。 */
const makeStubBff = () => {
  const userState = new Map<string, { value: unknown; revision: number }>()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers((init?.headers as Record<string, string>) ?? {})
    const path = new URL(input, 'http://stub').pathname
    if (method === 'POST' && path === '/api/projects') return json({ id: 'p1', name: 'p', ownerId: KEY_A, createdAt: 't', updatedAt: 't', revision: 0, isDeleted: false }, 201)
    if (method === 'PUT' && path.startsWith('/api/user-state/')) {
      const key = decodeURIComponent(path.slice('/api/user-state/'.length))
      const b = JSON.parse((init?.body as string) ?? '{}') as { value: unknown }
      const ifMatch = headers.get('if-match') // missing → null(string | null)
      const existing = userState.get(key)
      if (existing && ifMatch === null) return json({ error: 'precondition-required', id: key }, 428)
      if (existing && ifMatch !== null && Number(ifMatch) !== existing.revision) return json({ error: 'revision-conflict', id: key, currentRevision: existing.revision }, 409)
      const newRev = (existing?.revision ?? -1) + 1
      userState.set(key, { value: b.value, revision: newRev })
      return json({ id: key, revision: newRev }, 200)
    }
    if (method === 'DELETE' && path.startsWith('/api/user-state/')) {
      const key = decodeURIComponent(path.slice('/api/user-state/'.length))
      if (!userState.has(key)) return new Response(null, { status: 404 })
      userState.delete(key)
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  }
  return fetch
}

const stubExecutor = (fetch: (input: string, init?: RequestInit) => Promise<Response>) =>
  createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: authHeaders() })

const cannedExecutor = (status: number, body: unknown) =>
  createAdapterWriteExecutor({
    fetch: async () => json(body, status),
    baseUrl: '',
    getAuthHeaders: authHeaders(),
  })

describe('G1-a persistWriteExecutor — 非画布域写 dispatch(stub BFF)', () => {
  it('createProject op → success', async () => {
    const exec = stubExecutor(makeStubBff())
    const op: WriteOp = { kind: 'createProject', name: 'p', id: 'p1' }
    // R2 F1:成功响应携带服务端 revision(drain 经 onSuccess 回灌 store)。
    expect(await exec(op, 'idem-1')).toEqual({ status: 'success', revision: 0 })
  })

  it('putUserState op → success;既存缺 base → 428 → rejected(非 transient,不重试)', async () => {
    const exec = stubExecutor(makeStubBff())
    expect(await exec({ kind: 'putUserState', key: 'pref:tool', value: 'brush' }, 'idem-2')).toEqual({ status: 'success' })
    const r2 = await exec({ kind: 'putUserState', key: 'pref:tool', value: 'pen' }, 'idem-3')
    expect(r2.status).toBe('rejected')
  })

  it('deleteUserState op → success;再删(404)→ success(幂等)', async () => {
    const exec = stubExecutor(makeStubBff())
    expect(await exec({ kind: 'deleteUserState', key: 'pref:tool' }, 'idem-4')).toEqual({ status: 'success' })
    expect(await exec({ kind: 'deleteUserState', key: 'pref:tool' }, 'idem-5')).toEqual({ status: 'success' })
  })

  it('putUserState stale base → 409 → conflict(返 currentRevision,不重试)', async () => {
    const exec = stubExecutor(makeStubBff())
    await exec({ kind: 'putUserState', key: 'pref:brush', value: 'a' }, 'idem-6')
    await exec({ kind: 'putUserState', key: 'pref:brush', value: 'b', baseRevision: 0 }, 'idem-7') // bump 到 1
    const r = await exec({ kind: 'putUserState', key: 'pref:brush', value: 'c', baseRevision: 0 }, 'idem-8') // stale → 409
    expect(r.status).toBe('conflict')
    if (r.status === 'conflict') expect(typeof r.currentRevision).toBe('number')
  })
})

describe('G1-a persistWriteExecutor — HTTP 失败分类(classifyHttpStatus)', () => {
  it('5xx → transient(带 backoff 重试)', async () => {
    const exec = cannedExecutor(500, 'boom')
    expect((await exec({ kind: 'putUserState', key: 'pref:tool', value: 'x' }, 't1')).status).toBe('transient')
  })
  it('401 → unauthorized(队列暂停,数据保留)', async () => {
    const exec = cannedExecutor(401, { error: 'unauthorized' })
    expect(await exec({ kind: 'putUserState', key: 'pref:tool', value: 'x' }, 't2')).toEqual({ status: 'unauthorized' })
  })
  it('429 → transient(限流,重试)', async () => {
    const exec = cannedExecutor(429, 'rate')
    expect((await exec({ kind: 'createProject', name: 'p' }, 't3')).status).toBe('transient')
  })
  it('422 reuse-conflict → reuse-conflict(同 idem key 不同 body)', async () => {
    const exec = cannedExecutor(422, { error: 'idempotency-key-reuse', key: 'k1' })
    const r = await exec({ kind: 'putUserState', key: 'pref:tool', value: 'x' }, 't4')
    expect(r.status).toBe('reuse-conflict')
    if (r.status === 'reuse-conflict') expect(r.key).toBe('k1')
  })
  it('non-HttpError throw(fetch 网络层)→ transient', async () => {
    const exec = createAdapterWriteExecutor({
      fetch: async () => { throw new TypeError('failed to fetch') },
      baseUrl: '',
      getAuthHeaders: authHeaders(),
    })
    const r = await exec({ kind: 'putUserState', key: 'pref:tool', value: 'x' }, 't5')
    expect(r.status).toBe('transient')
    if (r.status === 'transient') expect(r.message).toContain('failed to fetch')
  })
})

describe('G1-a persistWriteExecutor — 画布域写 → unsupported-retained(chat 已接 wired,不再 deferred)', () => {
  it('upsertNode / reorderChildren / deleteNode → unsupported-retained(G1-c seam;不返 terminal 致删 durable)', async () => {
    const exec = stubExecutor(makeStubBff())
    const r1 = await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: {} as never }, 'c1')
    expect(r1.status).toBe('unsupported-retained')
    if (r1.status === 'unsupported-retained') expect(r1.message).toContain('G1-c')
    const r2 = await exec({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1'], baseContentVersion: 0 }, 'c2')
    expect(r2.status).toBe('unsupported-retained')
    const r3 = await exec({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' }, 'c2b')
    expect(r3.status).toBe('unsupported-retained')
  })
})

describe('G1-a persistWriteExecutor — chat op wired(DP-6R P1-1;append/update/delete)', () => {
  const chatFetch = (status = 200, body: unknown = { id: 'm1', revision: 0 }): { fetch: typeof fetch; calls: { method: string; path: string }[] } => {
    const calls: { method: string; path: string }[] = []
    const f = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(input, 'http://stub').pathname })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
    return { fetch: f as unknown as typeof fetch, calls }
  }
  const ah = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })

  it('appendChatMessage → POST /api/canvas/:id/chat,body {message} → success', async () => {
    const { fetch, calls } = chatFetch(201, { id: 'm1', revision: 0 })
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    const r = await exec({ kind: 'appendChatMessage', canvasId: 'c1', message: { text: 'hi' } }, 'cm1')
    expect(r).toEqual({ status: 'success' })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/canvas/c1/chat' })
  })
  it('updateChatMessage → PATCH /api/canvas/:id/chat/:msgId,body {payload},带 if-match', async () => {
    const { fetch, calls } = chatFetch()
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    const r = await exec({ kind: 'updateChatMessage', canvasId: 'c1', msgId: 'm1', payload: { text: 'edited' }, baseRevision: 3 }, 'um1')
    expect(r).toEqual({ status: 'success' })
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/canvas/c1/chat/m1' })
  })
  it('deleteChatMessage → DELETE /api/canvas/:id/chat/:msgId;404 → success(幂等)', async () => {
    const { fetch, calls } = chatFetch(404, null)
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    const r = await exec({ kind: 'deleteChatMessage', canvasId: 'c1', msgId: 'm-gone' }, 'dm1')
    expect(r).toEqual({ status: 'success' })
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/canvas/c1/chat/m-gone' })
  })
})

describe('G1-a persistWriteExecutor — 非画布域新 op dispatch(stub BFF)', () => {
  // makeStubBff 当前只 stub createProject/putUserState/deleteUserState;updateProject/deleteProject/
  // createCanvas/updateCanvas/deleteCanvas/attachAsset/detachAsset 走 captureCalls(单状态码)验证
  // dispatch + path + If-Match + body 构造(不验 BFF 真实 CRUD 语义——那是 server 集成测试的活)。
  const captureCalls = (status = 200, body: unknown = { id: 'x', revision: 0 }) => {
    const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = []
    const fetch = async (input: string, init?: RequestInit) => {
      calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: new URL(input, 'http://stub').pathname,
        body: init?.body ? JSON.parse(init.body as string) : null,
        headers: (init?.headers as Record<string, string>) ?? {},
      })
      return json(body, status)
    }
    return { fetch, calls }
  }
  const ah = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })

  it('updateProject → PATCH /api/projects/:id,body {name},带 if-match', async () => {
    const { fetch, calls } = captureCalls()
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    // R2 F1:成功响应携带服务端 revision(captureCalls 默认 body {id:'x',revision:0})。
    expect(await exec({ kind: 'updateProject', projectId: 'p1', name: 'renamed', baseRevision: 3 }, 'u1')).toEqual({ status: 'success', revision: 0 })
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/projects/p1', body: { name: 'renamed' } })
    expect(calls[0].headers['if-match']).toBe('3')
  })
  it('deleteProject → DELETE /api/projects/:id;404 → success(幂等)', async () => {
    const { fetch, calls } = captureCalls(404, null)
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    expect(await exec({ kind: 'deleteProject', projectId: 'p-gone' }, 'd1')).toEqual({ status: 'success' })
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/projects/p-gone' })
  })
  it('createCanvas → POST /api/canvas,body {projectId,id,title}', async () => {
    const { fetch, calls } = captureCalls(200, { id: 'c1', metaRevision: 5 })
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    // R2 F1:成功响应携带 CanvasMeta.metaRevision(drain 经 onSuccess 回灌 store.canvases[id].metaRevision)。
    expect(await exec({ kind: 'createCanvas', canvasId: 'c1', projectId: 'p1', title: 't' }, 'cc1')).toEqual({ status: 'success', revision: 5 })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/canvas', body: { projectId: 'p1', id: 'c1', title: 't' } })
  })
  it('updateCanvas → PUT /api/canvas/:id,body {payload:{projectId,title}},带 if-match', async () => {
    const { fetch, calls } = captureCalls(200, { id: 'c1', metaRevision: 7 })
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    expect(await exec({ kind: 'updateCanvas', canvasId: 'c1', projectId: 'p1', title: 'new', baseRevision: 2 }, 'uc1')).toEqual({ status: 'success', revision: 7 })
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/canvas/c1' })
    expect(calls[0].body).toEqual({ payload: { projectId: 'p1', title: 'new' } })
    expect(calls[0].headers['if-match']).toBe('2')
  })
  it('deleteCanvas → DELETE /api/canvas/:id;404 → success(幂等)', async () => {
    const { fetch } = captureCalls(404, null)
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    expect(await exec({ kind: 'deleteCanvas', canvasId: 'c-gone' }, 'dc1')).toEqual({ status: 'success' })
  })
  it('attachAsset → POST /api/assets/:assetId/attach,body {nodeId,canvasId};404(missing)→ rejected', async () => {
    const { fetch, calls } = captureCalls()
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    expect(await exec({ kind: 'attachAsset', canvasId: 'c1', assetId: 'a1', nodeId: 'n1' }, 'aa1')).toEqual({ status: 'success' })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/assets/a1/attach', body: { nodeId: 'n1', canvasId: 'c1' } })
    // 404 missing asset → rejected(isDelete=false;不能 attach 到不存在的 asset)
    const exec404 = createAdapterWriteExecutor({ fetch: async () => new Response(null, { status: 404 }), baseUrl: '', getAuthHeaders: () => ah() })
    expect((await exec404({ kind: 'attachAsset', canvasId: 'c1', assetId: 'a-missing', nodeId: 'n1' }, 'aa2')).status).toBe('rejected')
  })
  it('detachAsset → POST /api/assets/:assetId/detach;404 → success(幂等);403 → rejected', async () => {
    const { fetch, calls } = captureCalls(404, null)
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    expect(await exec({ kind: 'detachAsset', canvasId: 'c1', assetId: 'a1', nodeId: 'n1' }, 'da1')).toEqual({ status: 'success' })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/assets/a1/detach', body: { nodeId: 'n1', canvasId: 'c1' } })
    // 403 owner-mismatch → rejected(跨 owner 非法 detach,不静默成功)
    const exec403 = createAdapterWriteExecutor({ fetch: async () => json({ error: 'forbidden' }, 403), baseUrl: '', getAuthHeaders: () => ah() })
    expect((await exec403({ kind: 'detachAsset', canvasId: 'c1', assetId: 'a1', nodeId: 'n1' }, 'da2')).status).toBe('rejected')
  })
})
