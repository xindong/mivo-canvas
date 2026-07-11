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
    expect(await exec(op, 'idem-1')).toEqual({ status: 'success' })
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

describe('G1-a persistWriteExecutor — 画布域写 + chat → terminal(不重试不调 adapter)', () => {
  it('upsertNode / reorderChildren → terminal(G1-c seam)', async () => {
    const exec = stubExecutor(makeStubBff())
    expect((await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: {} as never }, 'c1')).status).toBe('terminal')
    expect((await exec({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1'], baseContentVersion: 0 }, 'c2')).status).toBe('terminal')
  })
  it('appendChatMessage → terminal(DP-6R seam)', async () => {
    const exec = stubExecutor(makeStubBff())
    expect((await exec({ kind: 'appendChatMessage', canvasId: 'c1', message: { text: 'hi' } }, 'c3')).status).toBe('terminal')
  })
})
