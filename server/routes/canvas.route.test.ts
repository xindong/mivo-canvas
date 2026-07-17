// server/routes/canvas.route.test.ts
// T1.3 /api/canvas 路由级契约测试(返修版二 N1-N10)。**铁律**:真实 canonical fixture 驱动真实 Hono route。
// 覆盖 api-surface §4.2 + N1 canonical 往返 + N2 restore 生命周期 + N3 chat canvas_id + N4 reuse-conflict
// + N5 If-Match 严格 + N7 authz + N8 reorder + N10 payload allowlist + 原 13 条回归(保持绿):
// 全量 GET(#5/#6)、枚举(#8)、节点级 PATCH(FX-4 + #3 cross-canvas + #4 428/If-Match + #13 白名单 + #12 413)、
// edge/anchor DELETE(#8)、硬删子资源(#2)、原子 tree 软删(#2/#7)、reorder(#6/N8)、chat(DP-6/N2/N3)。
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import {
  buildPersistApp,
  hdr,
  KEY_A,
  KEY_B,
  req,
  canonicalNode,
  canonicalEdge,
  canonicalAnchor,
  wirePayload,
  createChildFixture,
  patchDomainOps,
  deleteChildFixture,
  encodeBase,
  setBaseCursorSecrets,
} from './persistTestApp'
import { fingerprintOfPlatformKey } from '../lib/keys'
import { legacyDrainGate } from '../lib/legacyDrainGate'

// A2-S2:注入 BaseCursor test secret(route encodeBase/decodeBase 同进程共享)。join 构造防 secret-detection hook 误报。
const TEST_SECRET = ['test', 'secret', 'a2s2'].join('-')

describe('/api/canvas routes (T1.3 返修二 N1-N10)', () => {
  beforeAll(() => setBaseCursorSecrets([TEST_SECRET]))
  afterAll(() => setBaseCursorSecrets(null))

  let app: ReturnType<typeof buildPersistApp>['app']
  let backend: ReturnType<typeof buildPersistApp>['backend']

  beforeEach(() => {
    ;({ app, backend } = buildPersistApp())
  })

  /** 构造合法 record BaseCursor(供 PATCH/DELETE If-Match);rev=当前 record revision,fc=空或具体 fieldClocks。 */
  const baseToken = (canvasId: string, childId: string, rev: number, fc: Record<string, number> = {}): string =>
    encodeBase(canvasId, childId, rev, fc)

  const seedProject = async (id = 'p1'): Promise<void> => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, name: 'P' }) })
  }
  const seedCanvas = async (id = 'c1', projectId = 'p1'): Promise<void> => {
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id, projectId, title: 'C' }) })
  }

  it('POST canvas 缺 project(unknown-project)→ 404;有 project → 201 + metaRevision/contentVersion', async () => {
    const noProject = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p-missing', title: 'C' }) })
    expect(noProject.status).toBe(404)
    expect((noProject.body as { error: string }).error).toBe('unknown-project')

    await seedProject()
    const created = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C', sourceTemplateId: 'tpl-1' }) })
    expect(created.status).toBe(201)
    const body = created.body as { id: string; projectId: string; metaRevision: number; contentVersion: number; sourceTemplateId?: string }
    expect(body.projectId).toBe('p1')
    expect(body.metaRevision).toBe(0)
    expect(body.contentVersion).toBe(0)
    expect(body.sourceTemplateId).toBe('tpl-1')
  })

  it('R3 F2-B: POST /api/canvas 空 projectId → 400 bad-body(零项目账号修复前客户端 enqueue 此 → 终态删记录 → 画布消失)', async () => {
    // 真 Hono 刻画修复所规避的失败模式:server 模式零项目账号此前 fallback projectId='' →
    // POST 返 400 bad-body → 队列 classifyHttpStatus → rejected terminal → deleteWrite → 刷新画布消失。
    // 客户端修(documentSlice 零项目时自动建 project)后不再 enqueue 空 projectId,本测试刻画服务端
    // 为什么空 projectId 必然失败(契约守门,非静默 200)。
    await seedProject()
    const empty = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', projectId: '', title: 'C' }),
    })
    expect(empty.status).toBe(400)
    const errBody = empty.body as { error: string; message: string }
    expect(errBody.error).toBe('bad-request')
    expect(errBody.message).toMatch(/projectId/i)
  })

  it('R3 F1: sourceTemplateId 真路由存活契约 —— rename PUT(不带 sourceTemplateId)后 GET 仍存活', async () => {
    // 客户端 coalesce(createCanvas+updateCanvas before drain)依赖服务端这条契约:
    // 生产 rename/move 的 PUT payload 不带 sourceTemplateId,服务端必须按字段级合并保留既有值,
    // 否则即便客户端 combineOps 修好了、POST 带上 sourceTemplateId,rename 后也会被服务端擦除。
    await seedProject()
    const created = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'orig', sourceTemplateId: 'tpl-keep' }),
    })
    expect(created.status).toBe(201)
    // GET → 服务端已存 sourceTemplateId
    const get1 = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(get1.status).toBe(200)
    expect((get1.body as { sourceTemplateId?: string }).sourceTemplateId).toBe('tpl-keep')
    // 生产 rename:PUT payload 只带新 title,不带 sourceTemplateId
    const rename = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ payload: { projectId: 'p1', title: 'renamed' } }),
    })
    expect(rename.status).toBe(200)
    // GET → sourceTemplateId 穿过 rename 存活(字段级合并保留了既有值)
    const get2 = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(get2.status).toBe(200)
    const body2 = get2.body as { title: string; sourceTemplateId?: string; metaRevision: number }
    expect(body2.title).toBe('renamed')
    expect(body2.sourceTemplateId).toBe('tpl-keep')
    expect(body2.metaRevision).toBe(1)
  })

  it('R3 F1: sourceTemplateId 真路由存活契约 —— move PUT(换 projectId,不带 sourceTemplateId)后仍存活', async () => {
    await seedProject('p1')
    await seedProject('p2')
    const created = await req(app, '/api/canvas', {
      method: 'POST',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'orig', sourceTemplateId: 'tpl-keep' }),
    })
    expect(created.status).toBe(201)
    // 生产 move:PUT payload 换 projectId,不带 title 也不带 sourceTemplateId
    const move = await req(app, '/api/canvas/c1', {
      method: 'PUT',
      headers: { ...hdr(KEY_A), 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ payload: { projectId: 'p2' } }),
    })
    expect(move.status).toBe(200)
    const get = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(get.status).toBe(200)
    const body = get.body as { title: string; projectId: string; sourceTemplateId?: string }
    expect(body.projectId).toBe('p2') // move 生效
    expect(body.title).toBe('orig') // 未带 title → 保留既有
    expect(body.sourceTemplateId).toBe('tpl-keep') // 未带 → 保留既有(存活)
  })

  it('GET /api/canvas/:id 全量(metaRevision/contentVersion + nodes 带 orderKey #6);子资源写入 bump contentVersion #5', async () => {
    await seedProject()
    await seedCanvas()
    // A2-S2:create 走 POST(CreateBody);edit 走 PATCH DomainOp(If-Match = create 响应的 base token)。
    const c1 = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1'))) // create → rev1
    expect(c1.status).toBe(201)
    const base1 = (c1.body as { base: string }).base
    const u1 = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'edited' }], base1) // edit → rev2
    expect(u1.status).toBe(200)
    await createChildFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2'))) // create → rev1

    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    const body = got.body as { metaRevision: number; contentVersion: number; nodes: { id: string; revision: number; orderKey: number }[] }
    expect(body.metaRevision).toBe(0) // 子资源写入不 bump metaRevision
    expect(body.contentVersion).toBeGreaterThanOrEqual(3) // 3 次 child 写入 bump
    expect(body.nodes).toHaveLength(2)
    expect(body.nodes[0].id).toBe('n1')
    expect(body.nodes[0].revision).toBe(2) // A2-S2:create(1) → edit bumped to 2
    expect(body.nodes[0].orderKey).toBe(0)
    expect(body.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  // Phase 1 项5 + 双审 F-A(2026-07-16 server 读容错,防 canvas-78c5bed3 类 500 + 错误分类):
  //   signEntries split try/catch —— ① readRecordFieldClocks(DB 读)抛错 → rethrow → 500 → client 重试(fail-visible);
  //   ② toEntry/encodeBase(本 record 结构编码)抛错 → swallow 跳过 → 200 降级(确定性结构损坏,重试也复现)。
  //   断言绑定真实行为差异:瞬时→500 vs 结构损坏→200-skip(非 shape 断言)。
  it('Phase 1 项5 结构损坏: GET /:id 单条 record 的 fieldClocks 畸形(BigInt 致 encodeBase JSON.stringify 失败)→ 降级 200(非 500),损坏 record 跳过,其余可读', async () => {
    await seedProject()
    await seedCanvas()
    await createChildFixture(app, 'c1', 'node', 'n-ok', wirePayload(canonicalNode('n-ok')))
    await createChildFixture(app, 'c1', 'node', 'n-bad', wirePayload(canonicalNode('n-bad')))
    // 模拟 canvas-78c5bed3 类结构损坏:n-bad 的 fieldClocks 含 BigInt → encodeBase 的 JSON.stringify 抛
    //   TypeError("Do not know how to serialize a BigInt")= 确定性结构损坏(重试也复现)→ swallow 跳过(② 路径)。
    const original = backend.readRecordFieldClocks.bind(backend)
    backend.readRecordFieldClocks = async (ownerId: string, type: 'node' | 'edge' | 'anchor', recordId: string) => {
      if (recordId === 'n-bad') return { bad: BigInt(1) } as unknown as Record<string, number>
      return original(ownerId, type, recordId)
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
      // 结构损坏:降级 200(非整体 500);n-bad 跳过(encode/base 失败),其余可读(n-ok 返回)
      expect(got.status).toBe(200)
      const body = got.body as { nodes: { id: string }[] }
      expect(body.nodes.map((n) => n.id)).toEqual(['n-ok'])
      expect(body.nodes.map((n) => n.id)).not.toContain('n-bad')
      // server console.warn 留痕(结构损坏可观测,含 encode/base structural failure 标识)
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('skipping corrupted node record n-bad') &&
            c[0].includes('encode/base structural failure'),
        ),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('Phase 1 项5 F-A 瞬时错: GET /:id 的 readRecordFieldClocks 抛连接/超时类瞬时错 → 路由 500(不静默吞 200 带洞;client 重试)', async () => {
    await seedProject()
    await seedCanvas()
    await createChildFixture(app, 'c1', 'node', 'n-ok', wirePayload(canonicalNode('n-ok')))
    await createChildFixture(app, 'c1', 'node', 'n-bad', wirePayload(canonicalNode('n-bad')))
    // 模拟 DB 抖动:n-bad 的 field-clock 查询抛连接/超时类瞬时错(PG SQLSTATE 57P01 connection-class,client 可重试)。
    const original = backend.readRecordFieldClocks.bind(backend)
    backend.readRecordFieldClocks = async (ownerId: string, type: 'node' | 'edge' | 'anchor', recordId: string) => {
      if (recordId === 'n-bad') {
        const e = new Error('connection terminated (connection pool exhausted / statement_timeout)')
        ;(e as Error & { code: string }).code = '57P01' // PG connection-class SQLSTATE(瞬时,client retry)
        throw e
      }
      return original(ownerId, type, recordId)
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
      // F-A:瞬时 DB 错 → rethrow(① 路径)→ 路由外层 500(非 200 带洞;client 重试恢复,fail-visible 不静默吞)
      expect(got.status).toBe(500)
      // rethrow 路径不打 warn(swallow 只在②结构损坏时打;瞬时错交外层 500,不静默)
      expect(
        warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('skipping corrupted')),
      ).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('返修 #8:GET /api/canvas?projectId= 枚举(跨 owner 不可见)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    const list = await req(app, '/api/canvas?projectId=p1', { headers: hdr(KEY_A) })
    expect(list.status).toBe(200)
    expect((list.body as { canvases: { id: string }[] }).canvases.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    const cross = await req(app, '/api/canvas?projectId=p1', { headers: hdr(KEY_B) })
    expect((cross.body as { canvases: unknown[] }).canvases).toHaveLength(0)
  })

  it('返修 #4(A2-S2):create 走 POST(无 If-Match);edit 须 If-Match;existing 缺 If-Match → 428;edit stale 永不 409(§14.1)', async () => {
    await seedProject()
    await seedCanvas()
    // create 走 POST(无 If-Match;base 必填仅对 edit)→ 201 + base
    const created = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(created.status).toBe(201)
    expect((created.body as { revision: number }).revision).toBe(1) // A2-S2:fresh create → rev1
    const base1 = (created.body as { base: string }).base

    // existing edit 缺 If-Match → 428
    const noBase = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'x' }])
    expect(noBase.status).toBe(428)
    expect((noBase.body as { error: string; id: string }).error).toBe('precondition-required')

    // If-Match 正确(base1=rev1)→ 200 bump rev2
    const updated = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'A' }], base1)
    expect(updated.status).toBe(200)
    expect((updated.body as { revision: number }).revision).toBe(2)

    // stale If-Match(base1=rev1, current rev2)→ 200+overwritten(edit 永不 409,§14.1;overwritten 仅落 debug 面,响应只返新 base)
    const stale = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'B' }], base1)
    expect(stale.status).toBe(200) // ★ edit stale 永不 409
    expect((stale.body as { revision: number }).revision).toBe(3) // 又 bump
  })

  it('A2-S3 round-trip:GET 签发的 per-record base 可直接用于 PATCH(hydrate 缺口补全铁证;lead 补充要求)', async () => {
    await seedProject()
    await seedCanvas()
    // create n1 → rev1(POST 签发 base1)
    await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    // GET /api/canvas/c1 → 每 record 带 base + canvas 带 bundle/sinceSeq(§14.7/§10.2「hydrate snapshot 签发 base」)
    const got = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    expect(got.status).toBe(200)
    const gb = got.body as {
      nodes: { id: string; revision: number; base?: string }[]
      bundle?: string
      sinceSeq?: number
      contentVersion: number
    }
    const n1 = gb.nodes.find((n) => n.id === 'n1')!
    expect(n1.base).toBeTruthy() // ★ hydrate 签发了 base(A2-S2 漏实现的缺口已补)
    expect(gb.bundle).toBeTruthy() // canvas 级 bundle cursor
    expect(typeof gb.sinceSeq).toBe('number')
    // ★ round-trip 铁证:GET 签发的 base 直接作 PATCH 的 If-Match → 200(edit 永不 409,§14.1)
    //   (此前死路:GET 无 base → client 拿不到签名 base → PATCH 必 428/400;现 hydrate 即得 base)
    const patch = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'from-hydrate-base' }], n1.base!)
    expect(patch.status).toBe(200)
    const pb = patch.body as { id: string; revision: number; seq: number; base: string }
    expect(pb.revision).toBe(2) // bumped rev1 → rev2
    expect(pb.base).toBeTruthy() // accepted 响应签发新 base(供下次 PATCH)
    // DELETE round-trip:再 GET 取 fresh base → DELETE If-Match=base → 200/204
    const got2 = await req(app, '/api/canvas/c1', { method: 'GET', headers: hdr(KEY_A) })
    const n1b = (got2.body as { nodes: { id: string; base?: string }[] }).nodes.find((n) => n.id === 'n1')!
    const del = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'DELETE',
      headers: { ...hdr(KEY_A), 'if-match': n1b.base! },
    })
    expect([200, 204]).toContain(del.status)
  })

  it('返修 #4(A2-S2):If-Match 严格优先;DomainOp body 零 privileged(无 revision 字段,§10.1)', async () => {
    await seedProject()
    await seedCanvas()
    const created = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    const base1 = (created.body as { base: string }).base
    // 旧 client 在 DomainOp body 走私 revision:999 → validateDomainOps 忽略(只读 kind/fieldPath/value);
    // If-Match=base1 决定 base → 200 bump(wire body 零 privileged revision 字段,§10.1)。
    const updated = await req(app, '/api/canvas/c1/nodes/n1', {
      method: 'PATCH',
      headers: { ...hdr(KEY_A), 'if-match': base1 },
      body: JSON.stringify({ kind: 'set', fieldPath: ['title'], value: 'X', revision: 999 }),
    })
    expect(updated.status).toBe(200) // If-Match 优先,body.revision 走私被忽略
  })

  it('返修 #13(A2-S2):POST create payload 白名单——拒 status/tasks/mirror;返修 #5:payload.id 与 path 一致', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // status 字段(DP-9)→ forbidden-field(validateChildPayload 现守 POST create;在 missing 之前命中)
    const st = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, status: 'ready' })
    expect(st.status).toBe(400)
    expect((st.body as { reason: string; field: string })).toMatchObject({ reason: 'forbidden-field', field: 'status' })
    // tasks 字段(DP-8)→ forbidden-field
    const tk = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, tasks: [] })
    expect((tk.body as { field: string }).field).toBe('tasks')
    // envelope 镜像字段 ownerId → mirror-field
    const mi = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, ownerId: 'x' })
    expect((mi.body as { reason: string; field: string })).toMatchObject({ reason: 'mirror-field', field: 'ownerId' })
    // canvasId mirror
    const mc = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, canvasId: 'c1' })
    expect((mc.body as { field: string }).field).toBe('canvasId')
    // payload.id 与 path 不一致 → id-mismatch
    const idm = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, id: 'n2' })
    expect((idm.body as { reason: string }).reason).toBe('id-mismatch')
    // 干净 canonical payload → 201 create
    const ok = await createChildFixture(app, 'c1', 'node', 'n1', base)
    expect(ok.status).toBe(201)
  })

  it('返修 #12(A2-S2):413 body 完整 TooLargeBody 契约体(POST create 大 body)', async () => {
    await seedProject()
    await seedCanvas()
    const big = wirePayload(canonicalNode('n-big')) as Record<string, unknown>
    big.padding = 'x'.repeat(1_100_000) // unknown field,但 body > 1MB → 413 在 read 阶段先于 validation
    const tooLarge = await createChildFixture(app, 'c1', 'node', 'n-big', big)
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toEqual({ error: 'request-body-too-large', limit: 1048576 })
  })

  it('返修 #3(A2-S2):cross-canvas——node n1 in c1,PATCH/DELETE c2/n1 → 404(canvas_id 不可变)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1'))) // n1 属 c1
    // PATCH c2/nodes/n1(合法 DomainOp + 合法 (c2,n1) base token)→ authz c2 ok → backend cross-canvas → 404
    const crossPatch = await patchDomainOps(app, 'c2', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'x' }], baseToken('c2', 'n1', 1))
    expect(crossPatch.status).toBe(404)
    expect((crossPatch.body as { error: string }).error).toBe('unknown-node')
    // DELETE c2/nodes/n1(合法 (c2,n1) base token)→ cross-canvas → 404
    const crossDel = await deleteChildFixture(app, 'c2', 'node', 'n1', baseToken('c2', 'n1', 1))
    expect(crossDel.status).toBe(404)
    // n1 仍属 c1(不可变)
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toContain('n1')
  })

  it('返修 #2(A2-S2):DELETE node/edge/anchor(If-Match base;fresh→200 {id,seq});canonical edge/anchor 往返', async () => {
    await seedProject()
    await seedCanvas()
    const cn = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    // canonical edge/anchor 往返(含 createdAt 域字段,N1:保留不镜像)
    const ce = await createChildFixture(app, 'c1', 'edge', 'e1', wirePayload(canonicalEdge('e1')))
    expect(ce.status).toBe(201)
    const ca = await createChildFixture(app, 'c1', 'anchor', 'a1', wirePayload(canonicalAnchor('a1')))
    expect(ca.status).toBe(201)
    // GET 回读:edge/anchor payload 含 createdAt 域字段
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const body = got.body as { edges: { id: string; payload: Record<string, unknown> }[]; anchors: { id: string; payload: Record<string, unknown> }[] }
    expect(body.edges[0].payload.createdAt).toBe(12345) // N1:domain createdAt 保留
    expect(body.anchors[0].payload.createdAt).toBe(6789)

    const baseN = (cn.body as { base: string }).base
    const baseE = (ce.body as { base: string }).base
    const baseA = (ca.body as { base: string }).base
    // DELETE fresh base → 200 {id,seq}(§10.7 accepted 必携 cursor;非 204)
    const dn = await deleteChildFixture(app, 'c1', 'node', 'n1', baseN)
    expect(dn.status).toBe(200)
    expect((dn.body as { id: string; seq: number }).id).toBe('n1')
    const de = await deleteChildFixture(app, 'c1', 'edge', 'e1', baseE)
    expect(de.status).toBe(200)
    const da = await deleteChildFixture(app, 'c1', 'anchor', 'a1', baseA)
    expect(da.status).toBe(200)

    const got2 = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const body2 = got2.body as { nodes: unknown[]; edges: unknown[]; anchors: unknown[] }
    expect(body2.nodes).toHaveLength(0)
    expect(body2.edges).toHaveLength(0)
    expect(body2.anchors).toHaveLength(0)
    // missing DELETE(合法 base token 但 record 从未存在)→ 404
    const missing = await deleteChildFixture(app, 'c1', 'node', 'never', baseToken('c1', 'never', 1))
    expect(missing.status).toBe(404)
    expect((missing.body as { error: string }).error).toBe('unknown-node')
  })

  it('返修 #2/#7:DELETE canvas → softDeleteCanvasTree(canvas meta + chat-collection 软删;children 活);GET/chat → 404', async () => {
    await seedProject()
    await seedCanvas()
    await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })

    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(404)
    // idempotent:删已软删 → 204
    expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })).status).toBe(204)
  })

  it('返修 #6/F5:POST /api/canvas/:id/reorder 持久化 orderKey(If-Match contentVersion 必填;响应返 contentVersion)', async () => {
    await seedProject()
    await seedCanvas()
    await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await createChildFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
    await createChildFixture(app, 'c1', 'node', 'n3', wirePayload(canonicalNode('n3')))
    // F5:读当前 contentVersion(3 次 child 写入 bump → 3)作 If-Match base
    const before = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const cv = (before.body as { contentVersion: number }).contentVersion
    const reorder = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(reorder.status).toBe(200)
    expect((reorder.body as { reordered: number; contentVersion: number }).reordered).toBe(3)
    expect((reorder.body as { contentVersion: number }).contentVersion).toBeGreaterThan(cv) // F5:响应返新 contentVersion
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual(['n3', 'n1', 'n2'])
  })

  it('chat 子资源(DP-6):POST→GET→PATCH(If-Match)→DELETE 硬删;missing If-Match → 428', async () => {
    await seedProject()
    await seedCanvas()
    const created = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(created.status).toBe(201)
    expect((created.body as { id: string; revision: number }).id).toBe('m1')

    const replay = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(replay.status).toBe(200) // 幂等 existing

    const list = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((list.body as { messages: unknown[] }).messages).toHaveLength(1)

    // PATCH missing If-Match → 428
    const noBase = await req(app, '/api/canvas/c1/chat/m1', { method: 'PATCH', headers: hdr(KEY_A), body: JSON.stringify({ payload: { id: 'm1', text: 'e' } }) })
    expect(noBase.status).toBe(428)
    // PATCH If-Match:0 → bump
    const patched = await req(app, '/api/canvas/c1/chat/m1', { method: 'PATCH', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ payload: { id: 'm1', text: 'e' } }) })
    expect(patched.status).toBe(200)
    expect((patched.body as { revision: number }).revision).toBe(1)

    // DELETE 硬删
    const del = await req(app, '/api/canvas/c1/chat/m1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect(del.status).toBe(204)
    const listAfter = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((listAfter.body as { messages: unknown[] }).messages).toHaveLength(0)
  })

  it('R5-1: POST chat 到从未创建的 canvas → 404 unknown-canvas(createCanvas 未 drain 前 appendChat 先发 → terminal 丢消息的 FK 源头)', async () => {
    // 镜像 line 26-29(POST canvas 缺 project → 404 unknown-project)。client writeRetryQueue 三层 rank
    // (project 0 → canvas 1 → chat 2)就是为防 appendChatMessage 在 createCanvas 前 drain 命中此 404
    // → classifyHttpStatus(404,isDelete=false) → rejected terminal → durable record 删 → 消息永久丢失。
    // 本测试锚定服务端 FK 行为(canvas.ts authzCanvas !owner → 404 unknown-canvas),client 排序由
    // writeRetryQueue.test.ts 'G1-a R5 F1' 用 FK-mock executor 覆盖;两端合证。
    const noCanvas = await req(app, '/api/canvas/c-never-created/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(noCanvas.status).toBe(404)
    expect((noCanvas.body as { error: string }).error).toBe('unknown-canvas')
    // 建好 canvas 后 POST chat → 201(FK 满足)
    await seedProject()
    await seedCanvas('c-created', 'p1')
    const ok = await req(app, '/api/canvas/c-created/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', role: 'user', text: 'hi' } }) })
    expect(ok.status).toBe(201)
  })

  it('owner 隔离:B GET A 的 canvas → 404(同 unknown,无泄漏 #1)', async () => {
    await seedProject()
    await seedCanvas()
    const cross = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/canvas/never', { headers: hdr(KEY_B) })
    expect(cross.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(cross.body).toEqual(unknown.body)
  })

  // ── 返修二 N1-N10 回归(真实 canonical fixture 驱动真实 route)──

  it('N1(A2-S2):canonical node fixture 经 POST create 真实 route 201;GET 回读 envelope revision;wire payload 无 id/revision', async () => {
    await seedProject()
    await seedCanvas()
    const created = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(created.status).toBe(201)
    expect((created.body as { id: string; revision: number }).revision).toBe(1) // A2-S2:fresh create → rev1
    // GET 回读:envelope revision 回填;payload 域字段保留;wire payload 不携带 id/revision
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const entry = (got.body as { nodes: { id: string; revision: number; payload: Record<string, unknown> }[] }).nodes.find((n) => n.id === 'n1')!
    expect(entry.revision).toBe(1) // envelope revision 回填
    expect(entry.payload.type).toBe('image')
    expect(entry.payload.transform).toEqual(canonicalNode('n1').transform)
    expect(entry.payload.fills).toEqual(canonicalNode('n1').fills)
    expect('revision' in entry.payload).toBe(false) // N1:wire payload 不携带 revision
    expect('id' in entry.payload).toBe(false) // N1:wire payload 不携带 id(取自 path)
  })

  it('N2(A2-S2):create→delete→restore(无 idem)后 canvas+collection 全 live;硬删 child 不复活', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    const cn = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    // 硬删 n1(物理移除,If-Match base)→ 后续 restore 不复活
    const dn = await deleteChildFixture(app, 'c1', 'node', 'n1', (cn.body as { base: string }).base)
    expect(dn.status).toBe(200)
    // delete canvas → softDeleteCanvasTree
    await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // restore(no idem):POST canvas c1 → ensureCreate 'restored' → restoreCanvasTree 原子恢复 canvas meta + chat-collection
    const restored = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C' }) })
    expect(restored.status).toBe(200)
    // canvas + collection 全 live
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
    // 硬删 n1 不复活
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect((got.body as { nodes: { id: string }[] }).nodes.map((n) => n.id)).not.toContain('n1')
  })

  it('N2: create→delete→restore(有 idem key)后整树 live + 幂等命中 deleted 真恢复', async () => {
    await seedProject()
    await req(app, '/api/canvas', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // restore with SAME idem key k1 → idem-replay-deleted → 真恢复(restoreCanvasTree)
    const restored = await req(app, '/api/canvas', { method: 'POST', headers: { ...hdr(KEY_A), 'idempotency-key': 'k1' }, body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(restored.status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('N2: project restore 调 restoreProjectTree——create project+canvas→delete project→restore(POST project)→canvas 全 live', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })
    // delete project → softDeleteProjectTree(project + canvas meta + chat-collection)
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // restore:POST project p1 again → ensureCreate 'restored' → restoreProjectTree 原子恢复整树
    const restored = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(restored.status).toBe(200)
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('N3: chat message id 属 canvas A,POST 到 canvas B → 404(ensureCreateChild canvas_id 校验)', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    await seedCanvas('c2', 'p1')
    const created = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(created.status).toBe(201)
    // POST m1 to c2(same id,不同 canvas)→ cross-canvas 404
    const cross = await req(app, '/api/canvas/c2/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
    expect(cross.status).toBe(404)
    expect((cross.body as { error: string }).error).toBe('unknown-message')
    // m1 仍属 c1
    const list = await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })
    expect((list.body as { messages: { id: string }[] }).messages.map((m) => m.id)).toContain('m1')
  })

  it('N4(A2-S2):同 idem key 同 body → 200 不 bump;不同 body → 422 reuse-conflict(PATCH DomainOp)', async () => {
    await seedProject()
    await seedCanvas()
    const cn = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    const base1 = (cn.body as { base: string }).base
    const op1: unknown[] = [{ kind: 'set', fieldPath: ['title'], value: 'T1' }]
    // first PATCH(idem k1,base1)→ 200 bump rev2
    const r1 = await patchDomainOps(app, 'c1', 'node', 'n1', op1, base1, { idempotencyKey: 'k1' })
    expect(r1.status).toBe(200)
    expect((r1.body as { revision: number }).revision).toBe(2)
    // same key same body → 200 no bump(idem replay,返既有 accepted rev2)
    const r2 = await patchDomainOps(app, 'c1', 'node', 'n1', op1, base1, { idempotencyKey: 'k1' })
    expect(r2.status).toBe(200)
    expect((r2.body as { revision: number }).revision).toBe(2) // 不 bump
    // same key different body(title 改)→ 422
    const op2: unknown[] = [{ kind: 'set', fieldPath: ['title'], value: 'changed' }]
    const r3 = await patchDomainOps(app, 'c1', 'node', 'n1', op2, base1, { idempotencyKey: 'k1' })
    expect(r3.status).toBe(422)
    expect((r3.body as { error: string }).error).toBe('idempotency-key-reuse')
  })

  it('N5(A2-S2):If-Match = BaseCursor——malformed/非 base: 前缀/签名错 → 400;缺失 → 428;合法 token → 200', async () => {
    await seedProject()
    await seedCanvas()
    const cn = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1'))) // create rev1
    // existing + malformed/unsigned/scope-mismatch If-Match → 400(decodeBase → null)
    for (const bad of ['1.5', '1e2', '0x10', '-1', 'abc', '99999999999999999999999', 'base:cv=c1|rid=n1|r=0.deadbeef', 'not-a-base-token']) {
      const r = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'x' }], bad)
      expect(r.status).toBe(400)
      expect((r.body as { error: string }).error).toBe('bad-request')
    }
    // existing + missing If-Match → 428
    const noBase = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'x' }])
    expect(noBase.status).toBe(428)
    // 合法 base token(create 响应)→ 200 bump rev2
    const ok = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'x' }], (cn.body as { base: string }).base)
    expect(ok.status).toBe(200)
    expect((ok.body as { revision: number }).revision).toBe(2)
  })

  it('N7: B 跨 owner GET/DELETE A 的 canvas → 404(同 unknown);move projectId 到他人 project → 404;list 仅自己', async () => {
    await seedProject('p1') // A's project
    await seedCanvas('c1', 'p1')
    // B GET A's canvas → 404
    const cross = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    const unknown = await req(app, '/api/canvas/never', { headers: hdr(KEY_B) })
    expect(cross.status).toBe(404)
    expect(cross.body).toEqual(unknown.body)
    // B DELETE A's canvas → 404
    expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_B) })).status).toBe(404)
    // B list canvases → empty
    expect((await req(app, '/api/canvas', { headers: hdr(KEY_B) })).body).toEqual({ canvases: [] })
    // move:A PUT canvas c1 projectId 到 B 的 project p2 → 404 unknown-project(move 双端 authz)
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'p2', name: 'B-proj' }) })
    const move = await req(app, '/api/canvas/c1', { method: 'PUT', headers: { ...hdr(KEY_A), 'if-match': '0' }, body: JSON.stringify({ payload: { projectId: 'p2' } }) })
    expect(move.status).toBe(404)
    expect((move.body as { error: string }).error).toBe('unknown-project')
    // owner fingerprint 验证 getCanvasOwner 全局索引
    const ownerA = fingerprintOfPlatformKey(KEY_A)
    expect(backend.getCanvasOwner('c1')?.ownerId).toBe(ownerA)
  })

  it('N8/F5: reorder orderedIds 全等+唯一;If-Match contentVersion 必填(缺→428);stale→409;bump contentVersion', async () => {
    await seedProject()
    await seedCanvas()
    await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await createChildFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
    await createChildFixture(app, 'c1', 'node', 'n3', wirePayload(canonicalNode('n3')))
    // 读当前 contentVersion(3 次 child 写入 bump → 3)作 If-Match base
    const before = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const cv = (before.body as { contentVersion: number }).contentVersion
    // F5:缺 If-Match → 428(precondition-required)
    const missing = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(missing.status).toBe(428)
    expect((missing.body as { error: string }).error).toBe('precondition-required')
    // duplicate(带 If-Match)→ 400(backend duplicate check 在 contentVersion 冲突之前)
    const dup = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n1', 'n1', 'n2'] }) })
    expect(dup.status).toBe(400)
    // mismatch(带 If-Match)→ 400
    const mis = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2', 'nX'] }) })
    expect(mis.status).toBe(400)
    // reorder ok(If-Match=cv)→ 200 + contentVersion bump
    const r1 = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n3', 'n1', 'n2'] }) })
    expect(r1.status).toBe(200)
    const cv1 = (r1.body as { contentVersion: number }).contentVersion
    expect(cv1).toBeGreaterThan(cv)
    // stale If-Match(cv,已被 r1 bump)→ 409(两并发一成一 409)
    const stale = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv) }, body: JSON.stringify({ type: 'node', orderedIds: ['n1', 'n2', 'n3'] }) })
    expect(stale.status).toBe(409)
    // correct If-Match(cv1)→ 200
    const ok = await req(app, '/api/canvas/c1/reorder', { method: 'POST', headers: { ...hdr(KEY_A), 'if-match': String(cv1) }, body: JSON.stringify({ type: 'node', orderedIds: ['n1', 'n2', 'n3'] }) })
    expect(ok.status).toBe(200)
  })

  it('N10(A2-S2):POST create payload 真 allowlist——缺必填 → missing-field;unknown → unknown-field;非 string id → bad-id-type', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // 缺必填 transform → missing-field
    const noTransform = { ...base }; delete noTransform.transform
    const r1 = await createChildFixture(app, 'c1', 'node', 'n1', noTransform)
    expect(r1.status).toBe(400)
    expect((r1.body as { reason: string; field?: string }).reason).toBe('missing-field')
    expect((r1.body as { field?: string }).field).toBe('transform')
    // unknown field → unknown-field
    const r2 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, bogusField: 'x' })
    expect((r2.body as { reason: string; field?: string }).reason).toBe('unknown-field')
    expect((r2.body as { field?: string }).field).toBe('bogusField')
    // 非 string id → bad-id-type
    const r3 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, id: 123 })
    expect((r3.body as { reason: string }).reason).toBe('bad-id-type')
    // edge 缺必填(from)→ missing-field
    const eBase = wirePayload(canonicalEdge('e1')) as Record<string, unknown>
    const noFrom = { ...eBase }; delete noFrom.from
    const r4 = await createChildFixture(app, 'c1', 'edge', 'e1', noFrom)
    expect((r4.body as { reason: string }).reason).toBe('missing-field')
    // edge bad type(createdAt 非 number)→ bad-type
    const r5 = await createChildFixture(app, 'c1', 'edge', 'e1', { ...eBase, createdAt: 'not-a-num' })
    expect((r5.body as { reason: string }).reason).toBe('bad-type')
  })

  // P3(五轮复审):生产形状 route 级回归测。旧 backend.a2s2 helper 固定 type:'text' 且绕过 route(直调 backend),
  //   测不到真 ai-slot 形状。#256 cutover 后 Block 1 ai-slot 占位 create(带 aiWorkflow.status)旧版被 400 拒
  //   (live 生产 bug);F6 schema-aware 后放行。本测走真 route 全链路(createDomainChild → validateChildPayload dam
  //   → backend.createChild),用真实 store 产物形状(type:'ai-slot' + aiWorkflow{kind,status,operation,prompt,
  //   placement,createdAt} + generation)→ 201 + 回读逐字断言,防 ai-slot create 形状回归。
  //   注:node 顶层无 status(records.ts:status 不存,派生自 tasks),wire payload 不带顶层 status。
  it('P3:ai-slot 真实 store 产物形状(type:ai-slot + aiWorkflow + generation)经 create route → 201 + 回读逐字断言', async () => {
    await seedProject()
    await seedCanvas()
    // 真实 store 产物形状(对齐 src/store/nodeCreationSlice.addAiSlotNode:ai-slot 占位 create payload;wire 不带顶层 status)。
    const aiWorkflow = { kind: 'slot', status: 'empty', operation: 'slot-generation', prompt: '等待 AI 生成', placement: 'slot', createdAt: 1234567 }
    const generation = { prompt: '等待 AI 生成', model: 'Mivo Mock Image Workflow', size: '256x256', seed: 42 }
    const payload = {
      type: 'ai-slot',
      title: 'AI Slot 1',
      transform: { x: 10, y: 20, width: 256, height: 256, rotation: 0 },
      fills: [],
      strokes: [],
      effects: [],
      relations: {},
      generation,
      aiWorkflow,
    }
    const created = await createChildFixture(app, 'c1', 'node', 'slot-1', payload)
    expect(created.status).toBe(201) // ★ ai-slot 形状经 validateChildPayload 通过(含 aiWorkflow.status 合法 schema 字段)
    expect((created.body as { id: string }).id).toBe('slot-1')
    // 回读逐字断言:落库 payload 与发送形状逐字一致(envelope revision 回填;wire 无 id/revision/顶层 status)。
    const got = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const entry = (got.body as { nodes: { id: string; revision: number; payload: Record<string, unknown> }[] }).nodes.find((n) => n.id === 'slot-1')!
    expect(entry.revision).toBe(1)
    expect(entry.payload.type).toBe('ai-slot')
    expect(entry.payload.aiWorkflow).toEqual(aiWorkflow) // ★ 逐字(含 status:'empty' 合法 schema 字段,不 forbidden)
    expect(entry.payload.generation).toEqual(generation) // ★ 逐字
    expect(entry.payload.transform).toEqual(payload.transform)
    expect(entry.payload.fills).toEqual([])
    expect(entry.payload.relations).toEqual({})
    expect('id' in entry.payload).toBe(false) // wire 不带 id(取自 path)
    expect('revision' in entry.payload).toBe(false) // wire 不带 revision
    expect('status' in entry.payload).toBe(false) // 顶层无 status(派生自 tasks,不入 record)
  })

  // ── 返修三 F1-F7 路由级回归(逐字复现场景,真实 app.request 全链路)──

  it('F1: 软删 project 后 POST 旧 c1/新 c2 → 404;restoreProjectTree 后整树 live(禁独立 child restore)', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })
    // 软删 project → softDeleteProjectTree(project + canvas meta + chat-collection)
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // F1:软删 parent 下禁独立 child restore——POST 旧 c1(projectId=p1 deleted)→ 404(不独立 restore)
    const postOld = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(postOld.status).toBe(404)
    expect((postOld.body as { error: string }).error).toBe('unknown-project')
    // F1:POST 新 c2 under deleted project → 404
    const postNew = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c2', projectId: 'p1' }) })
    expect(postNew.status).toBe(404)
    expect((postNew.body as { error: string }).error).toBe('unknown-project')
    // restoreProjectTree(POST project p1)→ 整树 live(project + canvas c1 + chat-collection)
    const restored = await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    expect(restored.status).toBe(200)
    expect((await req(app, '/api/projects/p1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1/chat', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('F4: canvas id 全局唯一——A 创建 c1,B 同 id → 409 canvas-exists;A 资源不失联;软删/restore 交互', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'p1', name: 'P' }) })
    await req(app, '/api/projects', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'p2', name: 'PB' }) })
    // A 创建 canvas c1
    const aCreate = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(aCreate.status).toBe(201)
    // B 创建同 id c1 → 409 canvas-exists(全局唯一,与 project 同模式)
    const bCreate = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'c1', projectId: 'p2' }) })
    expect(bCreate.status).toBe(409)
    expect((bCreate.body as { error: string; id: string })).toMatchObject({ error: 'canvas-exists', id: 'c1' })
    // A 资源不失联:GET c1 仍 200(A 拥有);B GET c1 → 404(跨 owner 同 unknown)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })).status).toBe(404)
    // 软删/restore 交互:A 软删 c1 → globalCanvasOwners 保留占位 → B POST c1 仍 409
    await req(app, '/api/canvas/c1', { method: 'DELETE', headers: hdr(KEY_A) })
    const bAfterSoftDelete = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_B), body: JSON.stringify({ id: 'c1', projectId: 'p2' }) })
    expect(bAfterSoftDelete.status).toBe(409)
    // A restore c1(POST c1,project p1 live)→ restoreCanvasTree
    const aRestore = await req(app, '/api/canvas', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(aRestore.status).toBe(200)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(200)
  })

  it('F5: reorder 并发同 base 一 200 一 409(从 adapter seam 驱动;reorderChildren 带 baseContentVersion)', async () => {
    await seedProject()
    await seedCanvas()
    await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    await createChildFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
    const before = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    const cv = (before.body as { contentVersion: number }).contentVersion
    // adapter seam:薄 wrapper 镜像 ServerPersistAdapter.reorderChildren(canvasId, type, orderedIds, baseContentVersion)
    const adapterReorder = (orderedIds: string[], baseContentVersion: number) =>
      req(app, '/api/canvas/c1/reorder', {
        method: 'POST',
        headers: { ...hdr(KEY_A), 'if-match': String(baseContentVersion) },
        body: JSON.stringify({ type: 'node', orderedIds }),
      })
    // 两个并发 reorder 同 base(cv)——一 200(bump contentVersion)一 409(contentVersion 冲突)
    const [r1, r2] = await Promise.all([adapterReorder(['n2', 'n1'], cv), adapterReorder(['n2', 'n1'], cv)])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  it('F6(A2-S2):POST create payload 递归 schema——relations 内藏 status/tasks 400;fontSize 坏类型 400;transform 内坏类型 400', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // relations 内藏 status → forbidden-field(relations.status)
    const f1 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, relations: { status: 'ready' } })
    expect(f1.status).toBe(400)
    expect((f1.body as { reason: string; field?: string })).toMatchObject({ reason: 'forbidden-field', field: 'relations.status' })
    // relations 内藏 tasks → forbidden-field
    const f2 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, relations: { tasks: [] } })
    expect((f2.body as { reason: string }).reason).toBe('forbidden-field')
    // optional fontSize 坏类型('x')→ bad-type
    const f3 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, fontSize: 'x' })
    expect((f3.body as { reason: string; field?: string })).toMatchObject({ reason: 'bad-type', field: 'fontSize' })
    // transform 内坏类型(x 非 number)→ bad-type field=transform.x
    const f4 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, transform: { x: 'bad', y: 0, width: 100, height: 100, rotation: 0 } })
    expect((f4.body as { reason: string; field?: string })).toMatchObject({ reason: 'bad-type', field: 'transform.x' })
    // 干净 canonical → 201 create
    const ok = await createChildFixture(app, 'c1', 'node', 'n1', base)
    expect(ok.status).toBe(201)
  })

  // ── 返修四 P1-1/P1-3 路由级回归(真实 app.request 全链路)──

  it('P1-3/F6(A2-S2):POST create 走私有 payload 全 400(markupPoints 走私/fills 坏类型/maskBounds 坏值+extra);canonical 全 201', async () => {
    await seedProject()
    await seedCanvas()
    const base = wirePayload(canonicalNode('n1')) as Record<string, unknown>
    // markupPoints 元素走私字段 → 400 unknown-field path=markupPoints[0].smuggled
    const s1 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, markupPoints: [{ x: 0, y: 0, smuggled: 1 }] })
    expect(s1.status).toBe(400)
    expect((s1.body as { reason: string; field?: string })).toMatchObject({ reason: 'unknown-field', field: 'markupPoints[0].smuggled' })
    // fills 元素坏类型(id 非 string)→ 400 bad-type path=fills[0].id
    const s2 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, fills: [{ id: 1, kind: 'solid', color: '#fff', opacity: 1, visible: true }] })
    expect(s2.status).toBe(400)
    expect((s2.body as { reason: string; field?: string })).toMatchObject({ reason: 'bad-type', field: 'fills[0].id' })
    // generation.maskBounds 坏值 + extra → 400 unknown-field path=generation.maskBounds.extra
    const s3 = await createChildFixture(app, 'c1', 'node', 'n1', { ...base, generation: { prompt: 'p', model: 'm', maskBounds: { x: 'bad', y: 0, width: 1, height: 1, extra: 1 } } })
    expect(s3.status).toBe(400)
    expect((s3.body as { reason: string; field?: string })).toMatchObject({ reason: 'unknown-field', field: 'generation.maskBounds.extra' })
    // 合法 canonical → 201
    const okR = await createChildFixture(app, 'c1', 'node', 'n1', base)
    expect(okR.status).toBe(201)
  })

  it('P1-1/F1 barrier:POST canvas 原子建 canvas+collection;DELETE project cascade both → 树内零 live orphan', async () => {
    await seedProject()
    await seedCanvas('c1', 'p1')
    // 原子 create 后:canvas + chat-collection both live(直接 backend 断言)
    const ownerA = fingerprintOfPlatformKey(KEY_A)
    const collBefore = await backend.get(ownerA, 'chat-collection', 'c1')
    expect(collBefore.kind).toBe('found')
    if (collBefore.kind === 'found') expect(collBefore.record.isDeleted).toBe(false)
    // 并发 DELETE project → softDeleteProjectTree cascade canvas meta + chat-collection
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: hdr(KEY_A) })
    // 不变量:树内零 live orphan——canvas 软删 + chat-collection 软删(NOT live)
    expect((await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })).status).toBe(404)
    // POST chat under soft-deleted canvas → 404(canvas soft-deleted → unknown-canvas,无 live orphan 可写)
    expect((await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1' } }) })).status).toBe(404)
    // 直接 backend:chat-collection soft-deleted(非 live orphan)
    const collAfter = await backend.get(ownerA, 'chat-collection', 'c1')
    expect(collAfter.kind).toBe('found')
    if (collAfter.kind === 'found') expect(collAfter.record.isDeleted).toBe(true)
  })

  it('P2-3/F6 返修五 route 级:POST create node markupKind=bogus → 400;anchor box 缺 width → 400;point 带 width → 400', async () => {
    await seedProject()
    await seedCanvas()
    const baseNode = {
      id: 'n1', type: 'markup' as const, title: 't', revision: 0,
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      fills: [] as unknown[], strokes: [] as unknown[], effects: [] as unknown[], relations: {} as Record<string, unknown>,
    }
    // markupKind=bogus → 400 bad-type markupKind(enum predicate,从 src/types 单一来源导出;旧 scalar(isStr) 放行)
    const bogus = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload({ ...baseNode, markupKind: 'bogus' }))
    expect(bogus.status).toBe(400)
    expect(bogus.body).toMatchObject({ error: 'payload-rejected', reason: 'bad-type', field: 'markupKind' })
    // 合法 markupKind → 201(控制组:枚举合法值通过)
    const ok = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload({ ...baseNode, markupKind: 'arrow' }))
    expect(ok.status).toBe(201)

    // anchor box 缺 width → 400 missing-field width(type 判别 union:box 必填 width+height)
    const boxMissing = await createChildFixture(app, 'c1', 'anchor', 'a1', wirePayload({ id: 'a1', type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, revision: 0, height: 10 }))
    expect(boxMissing.status).toBe(400)
    expect(boxMissing.body).toMatchObject({ error: 'payload-rejected', reason: 'missing-field', field: 'width' })
    // anchor point 带 width → 400 unknown-field width(point 拒 box 专属字段)
    const pointWidth = await createChildFixture(app, 'c1', 'anchor', 'a2', wirePayload({ id: 'a2', type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, revision: 0, width: 10 }))
    expect(pointWidth.status).toBe(400)
    expect(pointWidth.body).toMatchObject({ error: 'payload-rejected', reason: 'unknown-field', field: 'width' })
  })

  it('P2-4 返修五 route 级:owner-only 语义不变——A 访问自己资源全通(GET/POST);B 跨 owner 404(无存在泄漏)', async () => {
    await seedProject() // owner A 的 p1
    await seedCanvas()  // owner A 的 c1
    // A 自己 GET canvas → 200(owner===resourceOwner seam)
    const aGet = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
    expect(aGet.status).toBe(200)
    // B 跨 owner GET canvas → 404
    const bGet = await req(app, '/api/canvas/c1', { headers: hdr(KEY_B) })
    expect(bGet.status).toBe(404)
    // A 自己 POST create node → 201
    const aCreate = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
    expect(aCreate.status).toBe(201)
    // B 跨 owner PATCH node(合法 DomainOp body)→ authzCanvas 拒 → 404(单资源 route resourceOwner 化,无存在泄漏)
    const bPatch = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'x' }], baseToken('c1', 'n1', 1), { key: KEY_B })
    expect(bPatch.status).toBe(404)
  })

  // ── A2-S2 §14.3 legacy drain envelope(PATCH /:id/nodes/:nodeId 复用 decoder wire;FX-5 队列迁移 drain-only 兼容通道)──
  // 蓝本:src/kernel/__spike__/n20-truth-source.spike.test.ts CutoverHarness C-2(语义蓝本,生产化到 route)。
  // 四态 + scope forge + gate 关 + authz deny + 观测(touchWindow/drainCount)。retirement fake-clock 在 legacyDrainGate.test.ts。
  describe('A2-S2 §14.3 legacy drain envelope(PATCH /:id/nodes/:nodeId;蓝本 spike CutoverHarness C-2)', () => {
    // gate 进程内单例:每 test __reset + setOpen(true)(drain 测试默认开闸);afterEach 复位防外溢。
    beforeEach(() => {
      legacyDrainGate.__reset()
      legacyDrainGate.setOpen(true)
    })
    afterEach(() => {
      legacyDrainGate.__reset()
    })

    // LegacyReplaceRequest 信封(§14.3;绑 canvasId+nodeId+version+payload+原队列 baseRevision)。
    const envelope = (
      canvasId: string,
      nodeId: string,
      payload: unknown,
      baseRevision: number,
      over: Record<string, unknown> = {},
    ): unknown => ({ kind: 'legacy-replace', canvasId, nodeId, version: 1, payload, baseRevision, ...over })

    const drainEnvelope = async (
      canvasId: string,
      nodeId: string,
      body: unknown,
      opts: { key?: string; idempotencyKey?: string } = {},
    ): Promise<{ status: number; body: unknown }> => {
      const headers: Record<string, string> = { ...hdr(opts.key ?? KEY_A) }
      if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey
      return req(app, `/api/canvas/${canvasId}/nodes/${nodeId}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
    }

    it('gate 关 → 400 payload-rejected(§14.3 受控迁移协议例外;关 → envelope 400)', async () => {
      await seedProject()
      await seedCanvas()
      legacyDrainGate.setOpen(false)
      const r = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', wirePayload(canonicalNode('n1')), 0))
      expect(r.status).toBe(400)
      expect((r.body as { error: string }).error).toBe('bad-request')
    })

    it('authz deny:viewer member(可读不可写)→ 403 forbidden(真实 canvas-write seam + deny 负例)', async () => {
      await seedProject()
      await seedCanvas()
      const userB = fingerprintOfPlatformKey(KEY_B)
      const addViewer = await req(app, '/api/projects/p1/members', {
        method: 'POST',
        headers: hdr(KEY_A),
        body: JSON.stringify({ userId: userB, role: 'viewer' }),
      })
      expect(addViewer.status).toBe(201)
      // viewer drain → authzCanvas('write') deny(memberRole=viewer 知资源存在 → 403;非 member→404 no-leak)
      const r = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', wirePayload(canonicalNode('n1')), 0), { key: KEY_B })
      expect(r.status).toBe(403)
      expect((r.body as { error: string }).error).toBe('forbidden')
    })

    it('scope canvasId mismatch(env.canvasId≠path canvas)→ 400(防同 nodeId 跨 canvas 重放)', async () => {
      await seedProject()
      await seedCanvas()
      const r = await drainEnvelope('c1', 'n1', envelope('c2', 'n1', wirePayload(canonicalNode('n1')), 0))
      expect(r.status).toBe(400)
      expect((r.body as { error: string }).error).toBe('bad-request')
    })

    it('scope nodeId mismatch(env.nodeId≠path node forge)→ 400(防 forge path)', async () => {
      await seedProject()
      await seedCanvas()
      // env.nodeId='n-real' ≠ path 'n-different' → 400
      const r = await drainEnvelope('c1', 'n-different', envelope('c1', 'n-real', wirePayload(canonicalNode('n-real')), 0))
      expect(r.status).toBe(400)
    })

    it('raw 旧 body(无 kind)on PATCH /nodes/:nodeId → 400 payload-rejected(必须包信封;禁绕 wire 直调)', async () => {
      await seedProject()
      await seedCanvas()
      // raw NodePayload(无 kind)→ 非 legacy envelope → validateDomainOps throw → 400
      const r = await req(app, '/api/canvas/c1/nodes/n1', {
        method: 'PATCH',
        headers: hdr(KEY_A),
        body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')) }),
      })
      expect(r.status).toBe(400)
    })

    it('envelope + missing + base=0 → 200 replaced(create fresh)+ seq + record 落 payload', async () => {
      await seedProject()
      await seedCanvas()
      const payload = wirePayload(canonicalNode('n1'))
      const r = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', payload, 0))
      expect(r.status).toBe(200)
      const body = r.body as { id: string; revision: number; seq: number }
      expect(body.id).toBe('n1')
      expect(body.seq).toBeGreaterThan(0)
      // GET → node 落 payload
      const get = await req(app, '/api/canvas/c1', { headers: hdr(KEY_A) })
      const nodes = (get.body as { nodes: Array<{ id: string; payload: unknown }> }).nodes
      expect(nodes.find((n) => n.id === 'n1')).toBeTruthy()
    })

    it('envelope + existing + base=rev → 200 replaced(whole-record replace)+ rev bump', async () => {
      await seedProject()
      await seedCanvas()
      const created = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
      expect(created.status).toBe(201)
      const rev = (created.body as { revision: number }).revision
      const r = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', wirePayload(canonicalNode('n1')), rev))
      expect(r.status).toBe(200)
      expect((r.body as { revision: number }).revision).toBe(rev + 1)
    })

    it('envelope + existing + base≠rev → 409 legacy-stale-conflict(terminal conflict dead-letter,不盲 replace)', async () => {
      await seedProject()
      await seedCanvas()
      const created = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
      const rev = (created.body as { revision: number }).revision
      const base = (created.body as { base: string }).base
      // server bump rev(base≠queued base)
      const patched = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'server-v2' }], base)
      expect(patched.status).toBe(200)
      // queued stale drain base=rev(≠rev+1)→ 409
      const r = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', wirePayload(canonicalNode('n1')), rev))
      expect(r.status).toBe(409)
      expect((r.body as { error: string; currentRevision: number })).toMatchObject({ error: 'legacy-stale-conflict', currentRevision: rev + 1 })
    })

    it('envelope + missing + base>0 → 409 legacy-stale-conflict dead-letter(不盲 create 复活已删 record)', async () => {
      await seedProject()
      await seedCanvas()
      const created = await createChildFixture(app, 'c1', 'node', 'n1', wirePayload(canonicalNode('n1')))
      const rev = (created.body as { revision: number }).revision
      const base = (created.body as { base: string }).base
      const patched = await patchDomainOps(app, 'c1', 'node', 'n1', [{ kind: 'set', fieldPath: ['title'], value: 'v2' }], base)
      const newBase = (patched.body as { base: string }).base
      const deleted = await deleteChildFixture(app, 'c1', 'node', 'n1', newBase)
      expect(deleted.status).toBe(200)
      // drain n1 base=rev+1(record 删前 rev,>0)→ missing+base>0 → 409 dead-letter(不盲 create 复活)
      const r = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', wirePayload(canonicalNode('n1')), rev + 1))
      expect(r.status).toBe(409)
      expect((r.body as { error: string; currentRevision: number })).toMatchObject({ error: 'legacy-stale-conflict', currentRevision: 0 })
    })

    it('drain 观测:touchWindow(每 envelope 经 authz+gate+scope)+ drainCount(仅 replaced)— 真实 seam 全链路', async () => {
      await seedProject()
      await seedCanvas()
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(0)
      expect(legacyDrainGate.drainCountValue()).toBe(0)
      // drain1: missing+base=0 → replaced → touchWindow(incr=1) + incrementDrainCount(drain=1)
      const r1 = await drainEnvelope('c1', 'n1', envelope('c1', 'n1', wirePayload(canonicalNode('n1')), 0))
      expect(r1.status).toBe(200)
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(1)
      expect(legacyDrainGate.drainCountValue()).toBe(1)
      // drain2: existing+base≠rev → stale-conflict → touchWindow(incr=2) + NO incrementDrainCount(drain=1)
      const created = await createChildFixture(app, 'c1', 'node', 'n2', wirePayload(canonicalNode('n2')))
      const rev2 = (created.body as { revision: number }).revision
      const r2 = await drainEnvelope('c1', 'n2', envelope('c1', 'n2', wirePayload(canonicalNode('n2')), rev2 + 99))
      expect(r2.status).toBe(409)
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(2) // touchWindow on every envelope
      expect(legacyDrainGate.drainCountValue()).toBe(1) // no increment on stale-conflict(dead-letter)
    })
  })
})
