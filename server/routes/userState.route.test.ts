// server/routes/userState.route.test.ts
// T1.3 /api/user-state 路由级契约测试(内存 backend)。覆盖 api-surface §4.3:
// KV CRUD、DP-7 排除清单(forbidden-key 400)、revision 409、owner 隔离。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req } from './persistTestApp'

describe('/api/user-state routes (T1.3)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  it('PUT(无 revision)→ 200 create rev 0;GET → 200;再 PUT 正确 revision → bumped;stale → 409', async () => {
    const put1 = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', {
      method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: ['n1'] }),
    })
    expect(put1.status).toBe(200)
    expect((put1.body as { id: string; revision: number }).revision).toBe(0)

    const got = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', { headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    expect((got.body as { value: unknown }).value).toEqual(['n1'])

    const put2 = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', {
      method: 'PUT', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ value: ['n2'] }),
    })
    expect(put2.status).toBe(200)
    expect((put2.body as { revision: number }).revision).toBe(1)

    const stale = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', {
      method: 'PUT', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ value: ['stale'] }),
    })
    expect(stale.status).toBe(409)
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(1)
  })

  it('DP-7 排除清单:gateway-key/mivo-key/含 token 子串 → 400 forbidden-key', async () => {
    const cases = ['gateway-key', 'mivo-key', 'user-session-token', 'canvas:apikey-leak']
    for (const key of cases) {
      const res = await req(app, `/api/user-state/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: 'x' }),
      })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toBe('forbidden-key')
    }
    // 正常 namespace key 不拒(canvas:<id>:selection / pref:tool)
    const ok = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', {
      method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: 'x' }),
    })
    expect(ok.status).toBe(200)
    const ok2 = await req(app, '/api/user-state/pref%3Atool', {
      method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: 'brush' }),
    })
    expect(ok2.status).toBe(200)
  })

  it('owner 隔离:A 的 KV 对 B 不可见(B GET A 的 key → 404 同 unknown;B list 为空)', async () => {
    await req(app, '/api/user-state/canvas%3Ac1%3Aselection', {
      method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: ['n1'] }),
    })

    const crossGet = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', { headers: hdr(KEY_B) })
    const unknownGet = await req(app, '/api/user-state/canvas%3Ac-other%3Aselection', { headers: hdr(KEY_B) })
    expect(crossGet.status).toBe(404)
    expect(unknownGet.status).toBe(404)
    expect(crossGet.body).toEqual(unknownGet.body)
    expect((crossGet.body as { error: string }).error).toBe('unknown-key')

    const bList = await req(app, '/api/user-state', { headers: hdr(KEY_B) })
    expect((bList.body as { entries: Record<string, unknown> }).entries).toEqual({})
  })

  it('GET / list 返 owner 全部 KV;DELETE → 204;missing → 404', async () => {
    await req(app, '/api/user-state/recent%3Aprojects', { method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: ['p1'] }) })
    await req(app, '/api/user-state/pref%3Atool', { method: 'PUT', headers: hdr(KEY_A), body: JSON.stringify({ value: 'brush' }) })

    const list = await req(app, '/api/user-state', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    const entries = (list.body as { entries: Record<string, { value: unknown }> }).entries
    expect(Object.keys(entries)).toHaveLength(2)
    expect(entries['recent:projects'].value).toEqual(['p1'])

    const del = await req(app, '/api/user-state/recent%3Aprojects', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    // 删后 GET → 404;list 只剩 1
    const after = await req(app, '/api/user-state/recent%3Aprojects', { headers: hdr(KEY_A) })
    expect(after.status).toBe(404)
    const list2 = await req(app, '/api/user-state', { headers: hdr(KEY_A) })
    expect(Object.keys((list2.body as { entries: Record<string, unknown> }).entries)).toHaveLength(1)

    // DELETE missing → 404
    const delMissing = await req(app, '/api/user-state/never', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(delMissing.status).toBe(404)
  })
})
