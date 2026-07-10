// server/routes/userState.route.test.ts
// T1.3 /api/user-state 路由级契约测试(返修版)。覆盖 13 条回归:
// #9 DP-7 namespace allowlist(canvas:/recent:/pref:/panel:)+ 每 namespace runtime kind schema
//   + 递归敏感扫描(字段名/凭据格式值;大小写/连字符/camelCase/嵌套)、
// #4 428/If-Match、#1 owner 隔离、#12 413 body。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req } from './persistTestApp'

describe('/api/user-state routes (T1.3 返修)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  const put = (key: string, value: unknown, ifMatch?: string, apiKey = KEY_A) =>
    req(app, `/api/user-state/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { ...hdr(apiKey), ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
      body: JSON.stringify({ value }),
    })

  it('PUT(无 If-Match)→ 200 create rev 0;GET → 200;PUT 正确 If-Match → bump;stale → 409', async () => {
    const put1 = await put('canvas:c1:selection', ['n1'])
    expect(put1.status).toBe(200)
    expect((put1.body as { revision: number }).revision).toBe(0)

    const got = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', { headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    expect((got.body as { value: unknown }).value).toEqual(['n1'])

    const put2 = await put('canvas:c1:selection', ['n2'], '0')
    expect(put2.status).toBe(200)
    expect((put2.body as { revision: number }).revision).toBe(1)

    const stale = await put('canvas:c1:selection', ['stale'], '0')
    expect(stale.status).toBe(409)
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(1)
  })

  it('返修 #4:existing PUT 缺 If-Match → 428', async () => {
    await put('canvas:c1:selection', ['n1'])
    const noBase = await put('canvas:c1:selection', ['n2'])
    expect(noBase.status).toBe(428)
    expect((noBase.body as { error: string; id: string }).error).toBe('precondition-required')
  })

  it('返修 #9:namespace allowlist——非 allowlist 前缀 → 400 forbidden-key', async () => {
    // gateway-key / mivo-key 不在 allowlist(两把 key 天然拒)
    expect((await put('gateway-key', 'x')).status).toBe(400)
    expect((await put('mivo-key', 'x')).status).toBe(400)
    // 随机非 allowlist 前缀
    expect((await put('random:stuff', 'x')).status).toBe(400)
    expect((await put('secret-token', 'x')).status).toBe(400)
    expect((await put('user-session-token', 'x')).status).toBe(400)
    // allowlist 前缀正常
    expect((await put('canvas:c1:selection', 'x')).status).toBe(200)
    expect((await put('recent:projects', ['p1'])).status).toBe(200)
    expect((await put('pref:tool', 'brush')).status).toBe(200)
    expect((await put('panel:library', true)).status).toBe(200)
  })

  it('返修 #9:每 namespace runtime kind schema(不符 → 400 bad-request)', async () => {
    // recent: 期望 array
    expect((await put('recent:projects', 'not-array')).status).toBe(400)
    // pref: 期望 string
    expect((await put('pref:tool', 123)).status).toBe(400)
    // panel: 期望 boolean
    expect((await put('panel:library', 'not-bool')).status).toBe(400)
    // 正确 kind
    expect((await put('recent:projects', ['p1', 'p2'])).status).toBe(200)
    expect((await put('pref:brush', 'ink')).status).toBe(200)
    expect((await put('panel:inspector', false)).status).toBe(200)
  })

  it('返修 #9:递归敏感扫描——字段名/凭据格式值(大小写/连字符/camelCase/前缀/嵌套)', async () => {
    // 字段名(大小写/连字符/camelCase)
    expect((await put('canvas:c1:selection', { secret: 'x' })).status).toBe(400)
    expect((await put('canvas:c1:selection', { userApiKey: 'x' })).status).toBe(400)
    expect((await put('canvas:c1:selection', { 'api-key': 'x' })).status).toBe(400)
    expect((await put('canvas:c1:selection', { AccessToken: 'x' })).status).toBe(400)
    expect((await put('canvas:c1:selection', { Authorization: 'x' })).status).toBe(400)
    // 嵌套
    expect((await put('canvas:c1:selection', { nested: { password: 'x' } })).status).toBe(400)
    expect((await put('canvas:c1:selection', [{ a: 1 }, { token: 'y' }])).status).toBe(400)
    // 凭据格式值(形如 mivo_/sk-)
    expect((await put('canvas:c1:selection', { data: 'mivo_stolenkey' })).status).toBe(400)
    expect((await put('canvas:c1:selection', { data: 'sk-leaked' })).status).toBe(400)
    // 干净 value → 200
    expect((await put('canvas:c1:selection', ['n1', 'n2'])).status).toBe(200)
    expect((await put('canvas:c1:camera', { x: 1, y: 2, zoom: 0.5 })).status).toBe(200)
    // forbidden-value body shape
    const fv = await put('canvas:c1:selection', { secret: 'x' })
    expect((fv.body as { error: string; key: string; path: string })).toMatchObject({ error: 'forbidden-value', path: 'secret' })
  })

  it('owner 隔离:A 的 KV 对 B 不可见(B GET A 的 key → 404 同 unknown;B list 为空 #1)', async () => {
    await put('canvas:c1:selection', ['n1'])
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
    await put('recent:projects', ['p1'])
    await put('pref:tool', 'brush')
    const list = await req(app, '/api/user-state', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    const entries = (list.body as { entries: Record<string, { value: unknown }> }).entries
    expect(Object.keys(entries)).toHaveLength(2)
    expect(entries['recent:projects'].value).toEqual(['p1'])
    const del = await req(app, '/api/user-state/recent%3Aprojects', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    expect((await req(app, '/api/user-state/recent%3Aprojects', { headers: hdr(KEY_A) })).status).toBe(404)
    const list2 = await req(app, '/api/user-state', { headers: hdr(KEY_A) })
    expect(Object.keys((list2.body as { entries: Record<string, unknown> }).entries)).toHaveLength(1)
    expect((await req(app, '/api/user-state/never', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(404)
  })

  it('返修 #12:413 body 完整 TooLargeBody', async () => {
    const big = await put('canvas:c1:selection', 'x'.repeat(1_100_000))
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: 'request-body-too-large', limit: 1048576 })
  })
})
