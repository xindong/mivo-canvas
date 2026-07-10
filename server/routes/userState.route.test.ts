// server/routes/userState.route.test.ts
// T1.3 /api/user-state 路由级契约测试(返修版二 N1-N10)。**铁律**:真实 route driving。
// 覆盖:
//   #9/N6 DP-7 frozen namespace(逐项 exact regex,含 canvas suffix;拒未知 suffix)+ 每 namespace/suffix runtime kind
//     + 递归敏感扫描(字段名/规范后凭据格式值;大小写/连字符/camelCase/嵌套/URL 编码变体全覆盖)、
//   #4/N5 428/If-Match 严格(invalid → 400)、#1/N7 owner 隔离、#10/N4 幂等 reuse-conflict、#12 413 body。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, hdr, KEY_A, KEY_B, req } from './persistTestApp'

describe('/api/user-state routes (T1.3 返修二 N1-N10)', () => {
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

  it('返修 #9/N6:frozen namespace——非 allowlist/未知 suffix → 400 forbidden-key', async () => {
    // gateway-key / mivo-key 不在 frozen 集(两把 key 天然拒)
    expect((await put('gateway-key', 'x')).status).toBe(400)
    expect((await put('mivo-key', 'x')).status).toBe(400)
    // 随机非 allowlist 前缀
    expect((await put('random:stuff', 'x')).status).toBe(400)
    expect((await put('secret-token', 'x')).status).toBe(400)
    expect((await put('user-session-token', 'x')).status).toBe(400)
    // N6:未知 suffix → forbidden-key
    expect((await put('canvas:c1:bogus', 'x')).status).toBe(400)
    expect((await put('canvas:c1:selection-extra', 'x')).status).toBe(400)
    // allowlist frozen key 正常(值须匹配 kind)
    expect((await put('canvas:c1:selection', ['n1'])).status).toBe(200) // array
    expect((await put('canvas:c1:camera', { x: 1 })).status).toBe(200) // object
    expect((await put('canvas:c1:chat-draft', 'draft')).status).toBe(200) // string
    expect((await put('recent:projects', ['p1'])).status).toBe(200)
    expect((await put('pref:tool', 'brush')).status).toBe(200)
    expect((await put('panel:library', true)).status).toBe(200)
  })

  it('返修 #9/N6:每 namespace/suffix runtime kind schema(不符 → 400 bad-request)', async () => {
    // canvas:*:selection 期望 array
    expect((await put('canvas:c1:selection', 'not-array')).status).toBe(400)
    expect((await put('canvas:c1:selection', { x: 1 })).status).toBe(400)
    // canvas:*:camera 期望 object
    expect((await put('canvas:c1:camera', 'not-object')).status).toBe(400)
    expect((await put('canvas:c1:camera', ['array'])).status).toBe(400)
    // canvas:*:chat-draft 期望 string
    expect((await put('canvas:c1:chat-draft', 123)).status).toBe(400)
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

  it('返修 #9/N6:递归敏感扫描——字段名/凭据格式值(大小写/连字符/camelCase/前缀/嵌套/URL 编码变体)', async () => {
    // 字段名(大小写/连字符/camelCase)——用 camera(object kind)承载 object value
    expect((await put('canvas:c1:camera', { secret: 'x' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { userApiKey: 'x' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { 'api-key': 'x' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { AccessToken: 'x' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { Authorization: 'x' })).status).toBe(400)
    // 嵌套 object
    expect((await put('canvas:c1:camera', { nested: { password: 'x' } })).status).toBe(400)
    // 嵌套 array——用 selection(array kind)承载 array value
    expect((await put('canvas:c1:selection', [{ a: 1 }, { token: 'y' }])).status).toBe(400)
    // 凭据格式值(规范后大小写/URL 编码变体均命中)
    expect((await put('canvas:c1:camera', { data: 'mivo_stolenkey' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { data: 'sk-leaked' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { data: 'MIVO_uppercase' })).status).toBe(400) // 大小写不敏感
    expect((await put('canvas:c1:camera', { data: 'Sk-mixedcase' })).status).toBe(400)
    expect((await put('canvas:c1:camera', { data: '%6divo_encoded' })).status).toBe(400) // URL 编码变体(decode → mivo_)
    // 干净 value → 200
    expect((await put('canvas:c1:selection', ['n1', 'n2'])).status).toBe(200)
    expect((await put('canvas:c1:camera', { x: 1, y: 2, zoom: 0.5 })).status).toBe(200)
    // forbidden-value body shape
    const fv = await put('canvas:c1:camera', { secret: 'x' })
    expect((fv.body as { error: string; key: string; path: string })).toMatchObject({ error: 'forbidden-value', path: 'secret' })
  })

  it('owner 隔离:A 的 KV 对 B 不可见(B GET A 的 key → 404 同 unknown;B list 为空 #1/N7)', async () => {
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
    const big = await put('canvas:c1:selection', ['x'.repeat(1_100_000)])
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: 'request-body-too-large', limit: 1048576 })
  })

  it('N4: user-state PUT 同 idem key 同 body → 200 不 bump;不同 body → 422', async () => {
    const r1 = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', { method: 'PUT', headers: { ...hdr(KEY_A), 'idempotency-key': 'ku1' }, body: JSON.stringify({ value: ['n1'] }) })
    expect(r1.status).toBe(200)
    expect((r1.body as { revision: number }).revision).toBe(0)
    // same key same body → 200 no bump
    const r2 = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', { method: 'PUT', headers: { ...hdr(KEY_A), 'idempotency-key': 'ku1' }, body: JSON.stringify({ value: ['n1'] }) })
    expect(r2.status).toBe(200)
    expect((r2.body as { revision: number }).revision).toBe(0)
    // same key different body → 422
    const r3 = await req(app, '/api/user-state/canvas%3Ac1%3Aselection', { method: 'PUT', headers: { ...hdr(KEY_A), 'idempotency-key': 'ku1' }, body: JSON.stringify({ value: ['n2'] }) })
    expect(r3.status).toBe(422)
    expect((r3.body as { error: string }).error).toBe('idempotency-key-reuse')
  })

  it('N5: user-state PUT If-Match 1.5/0x10/-1/abc → 400;缺失(existing)→ 428;正确 → bump', async () => {
    await put('canvas:c1:selection', ['n1']) // create rev 0
    for (const bad of ['1.5', '0x10', '-1', 'abc', '99999999999999999999999']) {
      const r = await put('canvas:c1:selection', ['n1'], bad)
      expect(r.status).toBe(400)
      expect((r.body as { error: string }).error).toBe('bad-request')
    }
    // missing(existing)→ 428
    expect((await put('canvas:c1:selection', ['n2'])).status).toBe(428)
    // correct → bump
    const ok = await put('canvas:c1:selection', ['n2'], '0')
    expect(ok.status).toBe(200)
    expect((ok.body as { revision: number }).revision).toBe(1)
  })

  it('F3: URL 编码 field name 绕过 → 400 forbidden-value;key 含 mivo_ 段 → 400 forbidden-key', async () => {
    // F3 part1:object key URL 编码(%61piKey → decode apiKey)→ 命中 forbidden-value(camera=object kind 承载)
    const f1 = await put('canvas:c1:camera', { '%61piKey': 'stolen' })
    expect(f1.status).toBe(400)
    expect((f1.body as { error: string }).error).toBe('forbidden-value')
    // F3 part2:key 含 mivo_ 段(canvas:mivo_xxx:selection;namespace 允许但 credential 段扫描拒)→ forbidden-key
    const f2 = await put('canvas:mivo_xxx:selection', ['n1'])
    expect(f2.status).toBe(400)
    expect((f2.body as { error: string }).error).toBe('forbidden-key')
    // F3 part2:key 含大写 MIVO_ 段(规范化后命中)→ forbidden-key
    expect((await put('canvas:MIVO_upper:selection', ['n1'])).status).toBe(400)
    // 干净 key 正常
    expect((await put('canvas:c1:selection', ['n1'])).status).toBe(200)
  })

  it('F7: canvas:<id>:selection 只收 string[](与 SessionStore 对齐)', async () => {
    // string[] → 200
    expect((await put('canvas:c1:selection', ['n1', 'n2'])).status).toBe(200)
    // 非 string[](含 number item)→ 400 bad-request
    const f = await put('canvas:c2:selection', ['n1', 123])
    expect(f.status).toBe(400)
    expect((f.body as { error: string }).error).toBe('bad-request')
    // 非 array(object)→ 400
    expect((await put('canvas:c3:selection', { x: 1 })).status).toBe(400)
  })
})
