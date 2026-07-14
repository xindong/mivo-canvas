// persistWriteExecutor.test.ts
// G1-a retry 接线验证:createAdapterWriteExecutor dispatch by op.kind → 共享 requestJson +
// idempotency-key header + classifyHttpStatus 映射 WriteOutcome。非画布域写接通;画布域写 + chat
// → terminal(不重试不调 adapter)。
//
// stub BFF(契约 wire shape)验证成功/冲突/幂等删路径;stub fetch 验证 5xx/401/429/422 + non-HttpError throw。
// 与 serverPersistAdapter.wiring.test.ts 同款:不 import server 代码(app 项目无 node types;tsc -b 会报 TS2591)。

import { describe, expect, it, vi } from 'vitest'
import { createAdapterWriteExecutor } from './persistWriteExecutor'
import { debugLogger } from '../store/debugLogStore'
import { migrateLegacyOp, type WriteOp } from './writeRetryQueue'

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

describe('G1-a persistWriteExecutor — 非三类画布域 op → unsupported-retained(A2-S4 三类已迁 §14.3;chat 已接 wired)', () => {
  it('upsertEdge / upsertAnchor / deleteEdge / deleteAnchor → unsupported-retained(非 §14.3 三类,留存等 G1-c)', async () => {
    const exec = stubExecutor(makeStubBff())
    const r1 = await exec({ kind: 'upsertEdge', canvasId: 'c1', edgeId: 'e1', payload: {} as never }, 'e1')
    expect(r1.status).toBe('unsupported-retained')
    if (r1.status === 'unsupported-retained') expect(r1.message).toContain('G1-c')
    const r2 = await exec({ kind: 'upsertAnchor', canvasId: 'c1', anchorId: 'a1', payload: {} as never }, 'a2')
    expect(r2.status).toBe('unsupported-retained')
    const r3 = await exec({ kind: 'deleteEdge', canvasId: 'c1', edgeId: 'e1' }, 'a3')
    expect(r3.status).toBe('unsupported-retained')
    const r4 = await exec({ kind: 'deleteAnchor', canvasId: 'c1', anchorId: 'a1' }, 'a4')
    expect(r4.status).toBe('unsupported-retained')
  })
})

describe('A2-S4 Block 4:FX-5 队列 migration-on-read(§14.3 legacy drain 兼容通道)', () => {
  // 权威:docs/decisions/n20-truth-source-decision.md §14.3(行 36-46)+ §1.2 cutover row 2(行 168)+
  //   spike migrateWriteOp(n20-truth-source.spike.test.ts L2300-2312)。server §14.3 已就位(#239):
  //   canvas.ts legacyDrainEnvelope(L521-579)+ deleteChildCascadeHandler(L728-781)+ reorder(L447-513)。
  // 迁移在 executor 侧 drain 时内存计算(IDB pristine);三类 kind 真发 server,非三类 retained。

  describe('migrateLegacyOp 纯函数(三路映射 + null passthrough,不 throw)', () => {
    it('upsertNode → legacy-envelope{kind:legacy-replace,canvasId,nodeId,version:1,payload,baseRevision}', () => {
      const m = migrateLegacyOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { x: 1 } as never, baseRevision: 7 })
      expect(m?.kind).toBe('legacy-envelope')
      if (m?.kind === 'legacy-envelope') {
        expect(m.envelope).toEqual({ kind: 'legacy-replace', canvasId: 'c1', nodeId: 'n1', version: 1, payload: { x: 1 }, baseRevision: 7 })
      }
    })
    it('upsertNode 缺 baseRevision → baseRevision=0(server 走 missing+base=0→create fresh,§14.3 四态)', () => {
      const m = migrateLegacyOp({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { x: 1 } as never })
      expect(m?.kind).toBe('legacy-envelope')
      if (m?.kind === 'legacy-envelope') expect(m.envelope.baseRevision).toBe(0)
    })
    it('deleteNode → delete cmd{kind:node-delete-cascade,canvasId,nodeId}', () => {
      const m = migrateLegacyOp({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' })
      expect(m?.kind).toBe('delete')
      if (m?.kind === 'delete') expect(m.cmd).toEqual({ kind: 'node-delete-cascade', canvasId: 'c1', nodeId: 'n1' })
    })
    it('reorderChildren → reorder{canvasId,childType,orderedIds,baseContentVersion}', () => {
      const m = migrateLegacyOp({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1', 'n2'], baseContentVersion: 4 })
      expect(m?.kind).toBe('reorder')
      if (m?.kind === 'reorder') {
        expect(m.canvasId).toBe('c1')
        expect(m.childType).toBe('node')
        expect(m.orderedIds).toEqual(['n1', 'n2'])
        expect(m.baseContentVersion).toBe(4)
      }
    })
    it('非三类 kind(upsertEdge/putUserState/appendChatMessage)→ null(passthrough,不 throw 进生产路径)', () => {
      expect(migrateLegacyOp({ kind: 'upsertEdge', canvasId: 'c1', edgeId: 'e1', payload: {} as never })).toBeNull()
      expect(migrateLegacyOp({ kind: 'putUserState', key: 'k', value: 1 })).toBeNull()
      expect(migrateLegacyOp({ kind: 'appendChatMessage', canvasId: 'c1', message: {} })).toBeNull()
    })
    it('reorderChildren type=chat-message → null(per-actor DP-6R,非 §14.3 legacy 画布域 drain;留存给 DP-6R)', () => {
      expect(migrateLegacyOp({ kind: 'reorderChildren', canvasId: 'c1', type: 'chat-message', orderedIds: ['m1'], baseContentVersion: 0 })).toBeNull()
    })
  })

  describe('legacy-envelope(upsertNode)drain — PATCH §14.3 wire + 分类', () => {
    const op = (baseRevision?: number): WriteOp => ({
      kind: 'upsertNode',
      canvasId: 'c1',
      nodeId: 'n1',
      payload: { x: 1 } as never,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
    })
    // 捕获 fetch:记录 method/path/body/if-match/idem,返 canned(默认 200 UpsertResponse)。
    const capture = (status = 200, body: unknown = { id: 'n1', revision: 9, seq: 1, base: 'b' }) => {
      const calls: { method: string; path: string; body: unknown; ifMatch: string | null; idem: string | null }[] = []
      const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers((init?.headers as Record<string, string>) ?? {})
        calls.push({
          method: (init?.method ?? 'GET').toUpperCase(),
          path: new URL(input, 'http://stub').pathname,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
          ifMatch: headers.get('if-match'),
          idem: headers.get('idempotency-key'),
        })
        return json(body, status)
      }
      return { fetch, calls }
    }

    it('fresh(200)→ success(+revision);PATCH /:id/nodes/:nodeId,body=legacy-replace 信封,无 If-Match(baseRevision 在信封内)', async () => {
      const { fetch, calls } = capture(200, { id: 'n1', revision: 9, seq: 1, base: 'b' })
      const exec = stubExecutor(fetch)
      const r = await exec(op(7), 'idem-1')
      expect(r.status).toBe('success')
      if (r.status === 'success') expect(r.revision).toBe(9)
      expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/canvas/c1/nodes/n1', idem: 'idem-1', ifMatch: null })
      expect(calls[0].body).toEqual({ kind: 'legacy-replace', canvasId: 'c1', nodeId: 'n1', version: 1, payload: { x: 1 }, baseRevision: 7 })
    })

    it('409 legacy-stale-conflict → rejected terminal dead-letter(fail-visible,不静默丢;不触发 onConflict 自动 rebase)', async () => {
      const exec = cannedExecutor(409, { error: 'legacy-stale-conflict', id: 'n1', currentRevision: 3 })
      const r = await exec(op(7), 'idem-2')
      expect(r.status).toBe('rejected')
    })

    it('gate-off 400{message:"legacy drain gate closed"}→ gate-blocked(数据保全,不丢、不 terminal;全等精确匹配)', async () => {
      const exec = cannedExecutor(400, { error: 'bad-request', message: 'legacy drain gate closed' })
      const r = await exec(op(7), 'idem-3')
      expect(r.status).toBe('gate-blocked')
      if (r.status === 'gate-blocked') expect(r.message).toContain('legacy drain gate closed')
    })

    it('F2 envelope 本地合法 + 400 其他消息(scope/server drift)→ gate-blocked(数据保全;本地已校验,400 不可能是 payload-rejection)', async () => {
      const exec = cannedExecutor(400, { error: 'bad-request', message: 'envelope canvasId/nodeId must match path' })
      const r = await exec(op(7), 'idem-4')
      expect(r.status).toBe('gate-blocked')
      if (r.status === 'gate-blocked') expect(r.message).not.toContain('legacy drain gate closed') // server-drift 诊断
    })

    it('F2 全等匹配负例:相似前后缀 "xlegacy drain gate closedx" → gate-blocked + server-drift 诊断(全等非 includes,不误判为 gate-closed)', async () => {
      const exec = cannedExecutor(400, { error: 'bad-request', message: 'xlegacy drain gate closedx' })
      const r = await exec(op(7), 'neg-1')
      expect(r.status).toBe('gate-blocked') // 本地合法 + 400 → gate-blocked(数据保全)
      if (r.status === 'gate-blocked') {
        // 全等未命中 'xlegacy drain gate closedx'(!== 'legacy drain gate closed')→ 走 server-drift 分支
        expect(r.message).toContain('server drift')
        expect(r.message).not.toBe('legacy drain gate closed (LEGACY_DRAIN off)') // 非 gate-closed 精确消息
      }
    })

    it('F2 本地非法 envelope(payload 非 object / 腐败)→ rejected fail-visible,不发送请求(400 根本轮不到歧义)', async () => {
      const calls: { method: string; path: string }[] = []
      const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(input, 'http://stub').pathname })
        return json({ id: 'n1', revision: 9 }, 200)
      }
      const exec = stubExecutor(fetch)
      // payload 是 string(模拟 IDB 腐败)→ migrateLegacyOp 拷进 envelope → validateLegacyEnvelopeLocal 拒(payload 非 object)
      const r = await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: 'not-an-object' as never, baseRevision: 0 }, 'bad-1')
      expect(r.status).toBe('rejected')
      expect(calls.length).toBe(0) // 本地非法 → validateLegacyEnvelopeLocal 拒,不发请求
    })

    it('F4-① baseRevision=MAX_SAFE_INTEGER+1 → client(isInteger)与 server 同判放行(非 isSafeInteger 拒)→ 发请求 success', async () => {
      const calls: { method: string }[] = []
      const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase() })
        return json({ id: 'n1', revision: 5, seq: 1, base: 'b' }, 200)
      }
      const exec = stubExecutor(fetch)
      // MAX_SAFE_INTEGER+1=2^53:Number.isInteger=true(放行);旧 isSafeInteger=false 会拒(与 server isInteger 分裂)。
      const r = await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { x: 1 } as never, baseRevision: Number.MAX_SAFE_INTEGER + 1 }, 'f4-1')
      expect(r.status).toBe('success') // 新代码 isInteger 放行 = server 同判 → 发请求 200
      expect(calls.length).toBe(1)
    })

    it('F4-② payload=new Date(0)(toJSON→string)→ wire 形态 payload 非 object → 本地 rejected,0 fetch(不击穿 F2 gate-blocked 永久重发)', async () => {
      const calls: { method: string }[] = []
      const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase() })
        return json({ id: 'n1', revision: 5 }, 200)
      }
      const exec = stubExecutor(fetch)
      // Date(0) 本地 typeof==='object'(旧放行);JSON.stringify 触发 toJSON→'"1970-01-01T00:00:00.000Z"'(string),
      //   parse 回来 payload=string → 新代码 rejected(0 fetch,不发给 server 致 400→gate-blocked 周期性永久重发)。
      const r = await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: new Date(0) as never, baseRevision: 0 }, 'f4-2')
      expect(r.status).toBe('rejected')
      expect(calls.length).toBe(0)
    })

    it('F4-②b payload 自定义 toJSON 产生非 object(string)→ 本地 rejected,0 fetch', async () => {
      const calls: { method: string }[] = []
      const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase() })
        return json({ id: 'n1', revision: 5 }, 200)
      }
      const exec = stubExecutor(fetch)
      const r = await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: { toJSON: () => 'string-result' } as never, baseRevision: 0 }, 'f4-2b')
      expect(r.status).toBe('rejected')
      expect(calls.length).toBe(0)
    })

    it('F4-③ payload 循环引用 → JSON.stringify 抛 → 本地 rejected(非 transient),0 fetch', async () => {
      const calls: { method: string }[] = []
      const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ method: (init?.method ?? 'GET').toUpperCase() })
        return json({ id: 'n1', revision: 5 }, 200)
      }
      const exec = stubExecutor(fetch)
      const cyclic: Record<string, unknown> = { x: 1 }
      cyclic.self = cyclic // 循环引用 → JSON.stringify 抛
      const r = await exec({ kind: 'upsertNode', canvasId: 'c1', nodeId: 'n1', payload: cyclic as never, baseRevision: 0 }, 'f4-3')
      expect(r.status).toBe('rejected') // F4:stringify 抛在 validateLegacyEnvelopeLocal 内 catch → rejected(旧代码落外层 transient)
      expect(r.status).not.toBe('transient')
      expect(calls.length).toBe(0)
    })

    it('401 → unauthorized(队列暂停,数据保留)', async () => {
      const exec = cannedExecutor(401, { error: 'require-login' })
      const r = await exec(op(7), 'idem-5')
      expect(r.status).toBe('unauthorized')
    })

    it('403 → rejected terminal(authz deny)', async () => {
      const exec = cannedExecutor(403, { error: 'forbidden' })
      const r = await exec(op(7), 'idem-6')
      expect(r.status).toBe('rejected')
    })

    it('422 → reuse-conflict terminal', async () => {
      const exec = cannedExecutor(422, { error: 'idempotency-key-reuse', key: 'idem-x' })
      const r = await exec(op(7), 'idem-7')
      expect(r.status).toBe('reuse-conflict')
    })

    it('5xx → transient(带 backoff 重试)', async () => {
      const exec = cannedExecutor(503, { error: 'down' })
      const r = await exec(op(7), 'idem-8')
      expect(r.status).toBe('transient')
    })
  })

  describe('delete(deleteNode)drain — DELETE §10.4 cascade + 分类', () => {
    it('200 → success(已删 / 幂等)', async () => {
      const exec = cannedExecutor(200, { id: 'n1', seq: 2 })
      const r = await exec({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' }, 'd1')
      expect(r.status).toBe('success')
    })
    it('404 → success(幂等,delete 意图已满足)', async () => {
      const exec = cannedExecutor(404, { error: 'unknown-node' })
      const r = await exec({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' }, 'd2')
      expect(r.status).toBe('success')
    })
    it('428(缺 BaseCursor,队列 deleteNode 无 base)→ rejected terminal(fail-visible,不静默丢)', async () => {
      const exec = cannedExecutor(428, { error: 'precondition-required', id: 'n1' })
      const r = await exec({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' }, 'd3')
      expect(r.status).toBe('rejected')
    })
    it('409 delete-race → rejected terminal dead-letter', async () => {
      const exec = cannedExecutor(409, { error: 'revision-conflict', id: 'n1', currentRevision: 5 })
      const r = await exec({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' }, 'd4')
      expect(r.status).toBe('rejected')
    })
    it('DELETE path = /api/canvas/:canvasId/nodes/:nodeId(验请求 shape + idem header)', async () => {
      const calls: { method: string; path: string; idem: string | null }[] = []
      const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers((init?.headers as Record<string, string>) ?? {})
        calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(input, 'http://stub').pathname, idem: headers.get('idempotency-key') })
        return new Response(JSON.stringify({ id: 'n1', seq: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const exec = stubExecutor(fetch)
      await exec({ kind: 'deleteNode', canvasId: 'c1', nodeId: 'n1' }, 'd5')
      expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/canvas/c1/nodes/n1', idem: 'd5' })
    })
  })

  describe('reorder(reorderChildren)drain — POST /:id/reorder + 分类', () => {
    it('200 → success;POST /:id/reorder body {type,orderedIds},If-Match = baseContentVersion(bare number)', async () => {
      const calls: { method: string; path: string; body: unknown; ifMatch: string | null }[] = []
      const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers((init?.headers as Record<string, string>) ?? {})
        calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(input, 'http://stub').pathname, body: init?.body ? JSON.parse(init.body as string) : undefined, ifMatch: headers.get('if-match') })
        return json({ reordered: true, contentVersion: 5, base: 'ob' }, 200)
      }
      const exec = stubExecutor(fetch)
      const r = await exec({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1', 'n2'], baseContentVersion: 3 }, 'r1')
      expect(r.status).toBe('success')
      expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/canvas/c1/reorder', ifMatch: '3' })
      expect(calls[0].body).toEqual({ type: 'node', orderedIds: ['n1', 'n2'] })
    })
    it('409 revision-conflict → rejected terminal dead-letter(不触发 onConflict 自动 rebase)', async () => {
      const exec = cannedExecutor(409, { error: 'revision-conflict', id: 'c1', currentRevision: 5 })
      const r = await exec({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1'], baseContentVersion: 3 }, 'r2')
      expect(r.status).toBe('rejected')
    })
    it('400 bad-orderedIds → rejected terminal(fail-visible)', async () => {
      const exec = cannedExecutor(400, { error: 'bad-request', message: 'orderedIds dup' })
      const r = await exec({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1', 'n1'], baseContentVersion: 3 }, 'r3')
      expect(r.status).toBe('rejected')
    })
    it('5xx → transient(重试)', async () => {
      const exec = cannedExecutor(500, { error: 'down' })
      const r = await exec({ kind: 'reorderChildren', canvasId: 'c1', type: 'node', orderedIds: ['n1'], baseContentVersion: 3 }, 'r4')
      expect(r.status).toBe('transient')
    })
  })

  describe('新格式记录零影响(非三类 kind 走原路径,迁移不介入)', () => {
    it('putUserState 不被 migrateLegacyOp 接走 → 原 PUT /api/user-state 路径(成功)', async () => {
      const exec = stubExecutor(makeStubBff())
      const r = await exec({ kind: 'putUserState', key: 'pref:tool', value: 'brush' }, 'u1')
      expect(r.status).toBe('success')
    })
    it('upsertEdge(非三类画布域)→ unsupported-retained(走原 G1-c seam,不迁 §14.3)', async () => {
      const exec = stubExecutor(makeStubBff())
      const r = await exec({ kind: 'upsertEdge', canvasId: 'c1', edgeId: 'e1', payload: {} as never }, 'u2')
      expect(r.status).toBe('unsupported-retained')
    })
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

  // F3: attach/detach 缺 canvasId(旧 durable 记录)→ fail-visible retain。
  // Block 3 seam 加 required canvasId 前入队的旧 IDB 记录读出 canvasId===undefined;server attach 路由
  // required canvasId 会 400 → rejected 删记录 → intent 静默丢。廉价防线:executor 拦截 → unsupported-retained
  // (不发不删,deferred 留存)+ debugLogger.error 记失败路径。不做 migration 推导(canvasId 推不出)。
  it('F3: attachAsset 缺 canvasId → unsupported-retained,不发请求,debugLogger.error 记失败路径', async () => {
    const errorSpy = vi.spyOn(debugLogger, 'error').mockImplementation(() => {})
    const { fetch, calls } = captureCalls()
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    const op = { kind: 'attachAsset', assetId: 'a1', nodeId: 'n1' } as unknown as WriteOp
    const outcome = await exec(op, 'k-legacy-attach')
    expect(outcome.status).toBe('unsupported-retained')
    expect(calls.length).toBe(0)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe('PersistWriteExecutor')
    expect(errorSpy.mock.calls[0][1]).toContain('missing canvasId')
    errorSpy.mockRestore()
  })

  it('F3: detachAsset 缺 canvasId → unsupported-retained,不发请求', async () => {
    const errorSpy = vi.spyOn(debugLogger, 'error').mockImplementation(() => {})
    const { fetch, calls } = captureCalls()
    const exec = createAdapterWriteExecutor({ fetch, baseUrl: '', getAuthHeaders: () => ah() })
    const op = { kind: 'detachAsset', assetId: 'a1', nodeId: 'n1' } as unknown as WriteOp
    const outcome = await exec(op, 'k-legacy-detach')
    expect(outcome.status).toBe('unsupported-retained')
    expect(calls.length).toBe(0)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
