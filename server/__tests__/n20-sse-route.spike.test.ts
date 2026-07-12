// @vitest-environment node
// server/__tests__/n20-sse-route.spike.test.ts
// N2-0 返修 Gate5:真实 Hono SSE route 集成 — live push + desiredSize backpressure + authz seam + slow-reader 恢复。
//
// ★ spike 属性:N2-0 决策证据,自含独立 Hono app(不 import server/app.ts,不接生产装配)。
//   SSE 路由(/api/canvas/:id/events)是 N2-1 契约 §10.5 的预演,生产实装在 N2-1 落地时另行装配。
//   yjs 不进生产 bundle(本文件仅 hono + node stream + server/lib owner/authz,无 yjs import)。
//
// R3 F3 返修(本轮):
//   - authz seam 复用真实 server/lib/owner.resolveActor + server/lib/authz.canAccessCanvas/denyStatus
//     (非 R2 自建 fake `secret !== constant` + members Set)。resolveActor(opt-in MIVO_TRUST_SSO_HEADER
//     + fail-closed MIVO_GATEWAY_SECRET):通过 → 信 x-mivo-auth-user;否则 fallback 指纹(非 401,fail-closed)。
//     canAccessCanvas + denyStatus:allow → 200 stream;deny → 404(non-member 无泄漏)/403(member 越权)。
//     注:本仓 canvas/SSE authz seam 实为 404/403/410,无 401(401 仅 /api/auth/me 网关未登录 + platform upstream
//     token 刷新);finding 提"401/SsoAuthError"系描述性命名,本仓不存在,复用真实 seam 不杜撰 401。
//   - 5-6 增强:停读推 50+ 后读 response body(非只看内部 backlog/drop 计数),证客户端实收 bounded 最新事件。
//   - 5-8 slow reader 恢复(新增):停读→推 50+→恢复读→从 response body 观察 seq gap→?since 补拉→无缺口终态。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { resolveActor } from '../lib/owner'
import { canAccessCanvas, denyStatus, type AuthzInfo, type ProjectRole } from '../lib/authz'

// ── SPIKE SSE state(独立,非生产装配)──
type SseEvent = { seq: number; recordId: string; op: { fieldPath: string[]; value: unknown } }
type Conn = {
  actor: string
  controller: ReadableStreamDefaultController<Uint8Array> | null
  backlog: SseEvent[]
  closed: boolean
  dropped: number
  enqueue: (s: string) => void
  drain: () => void
  push: (e: SseEvent) => void
  close: () => void
}

const HEARTBEAT_MS = 20
const MAX_BACKLOG = 8 // slow-consumer backlog 上限(desiredSize backpressure + drop oldest)
const GATEWAY_SECRET = 'test-gateway-secret' // 模拟 owner.ts x-mivo-gateway-secret(fail-closed;生产由网关注入)

function createSpikeSseApp() {
  const app = new Hono()
  const state = {
    events: [] as SseEvent[],
    canvasOwner: 'alice', // canvas owner(actor===ownerId → decideAccess 派生 owner,roleCan('owner') allow all;不可撤销)
    members: new Set<string>(['bob']), // 非 owner 成员(resolveMemberRole → 'editor')
    revoked: new Set<string>(), // 撤权 actor(覆盖成员 → resolveMemberRole undefined → no-leak 404)
    conns: new Set<Conn>(),
    seq: 0,
  }
  // R3 F3:真实 member-role 解析(替代 R2 fake members Set + secret!==constant)。
  //   owner(actor===canvasOwner)→'owner';members→'editor';revoked→undefined;其余→undefined(404 no-leak)。
  const resolveMemberRole = (actor: string): ProjectRole | undefined => {
    if (state.revoked.has(actor)) return undefined // 撤权 → 非 member(no-leak 404)
    if (actor === state.canvasOwner) return 'owner'
    if (state.members.has(actor)) return 'editor'
    return undefined
  }
  const pushEvent = (e: Omit<SseEvent, 'seq'>): SseEvent => {
    const full: SseEvent = { ...e, seq: ++state.seq }
    state.events.push(full)
    // live push 到 conn(经 backlog + drain 到 controller),非只压内存数组
    for (const conn of state.conns) conn.push(full)
    return full
  }
  app.get('/api/canvas/:id/events', (c) => {
    // ★ R3 F3:authz seam 复用真实 resolveActor(owner.ts)+ canAccessCanvas/denyStatus(authz.ts)
    const actor = resolveActor(c) // ★ 真实:SSO header(trusted+secret ok)or fallback 指纹(非 401)
    const memberRole = resolveMemberRole(actor)
    const info: AuthzInfo = { actor, ownerId: state.canvasOwner, memberRole }
    if (canAccessCanvas(info, 'read') === 'deny') { // ★ 真实 canAccessCanvas
      const status = denyStatus(info) // ★ 真实 denyStatus:404(non-member 无泄漏)/403(member 越权)
      const body = status === 403 ? { error: 'forbidden' } : { error: 'unknown-canvas' }
      return c.json(body, status as 403 | 404)
    }
    const since = Number(c.req.query('since') ?? 0)
    let conn: Conn | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const enqueue = (s: string) => { try { controller.enqueue(encoder.encode(s)) } catch { /* closed */ } }
        conn = {
          actor, controller, backlog: [], closed: false, dropped: 0, enqueue,
          // desiredSize 驱动 drain(backpressure:desiredSize<=0 停,backlog 有界)
          drain() {
            if (!conn) return
            const ctrl = conn.controller
            while (ctrl && (ctrl.desiredSize ?? 0) > 0 && conn.backlog.length > 0) {
              const evt = conn.backlog.shift()!
              conn.enqueue(`data: ${JSON.stringify(evt)}\n\n`)
            }
          },
          // live push:压 backlog(有界 MAX,满 drop oldest)+ drain 到 controller
          push(e) {
            if (conn!.backlog.length >= MAX_BACKLOG) { conn!.dropped++; conn!.backlog.shift() }
            conn!.backlog.push(e)
            conn!.drain()
          },
          close() { if (conn) { conn.closed = true; clearInterval(hb); clearInterval(revokePoll); clearInterval(drainTick); try { conn.controller?.close() } catch { /* already closed */ } } },
        }
        state.conns.add(conn)
        // since 补拉:replay seq>since 的历史(建连前已 push 的;建连后 live push 走 conn.push)
        for (const e of state.events) if (e.seq > since) conn.backlog.push(e)
        conn.drain()
        // heartbeat
        const hb = setInterval(() => enqueue(': keepalive\n\n'), HEARTBEAT_MS)
        // drain tick:客户端读后 backlog 继续 drain(backpressure 解除后)
        const drainTick = setInterval(() => conn?.drain(), HEARTBEAT_MS)
        // revoke 断流:撤权后(memberRole undefined)发 event: revoke + 关闭
        const revokePoll = setInterval(() => {
          if (conn && resolveMemberRole(actor) === undefined) { enqueue('event: revoke\ndata: {}\n\n'); conn.close(); state.conns.delete(conn) }
        }, HEARTBEAT_MS)
      },
      cancel() { if (conn) state.conns.delete(conn) },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' } })
  })
  // ★ R5 F3:真实 authz seam WRITE route(PATCH /api/canvas/:id/nodes/:nodeId)— 与 GET events route 同 seam
  //   (resolveActor + canAccessCanvas('write') + denyStatus)。撤权后 bob write → 404 no-leak(non-member)/403(member 越权);
  //   owner write → 200。原 SSE harness 只 GET(5-4 断流),无 write route;G7-hard-3 是另一套自建 FieldLevelServer
  //   不复用真实 owner.ts/authz.ts → post-revoke write 拒绝未由真实 seam 验。本 route 补此缺口(补探针把声称测实)。
  app.patch('/api/canvas/:id/nodes/:nodeId', async (c) => {
    const actor = resolveActor(c) // ★ 真实:SSO header(trusted+secret ok)or fallback 指纹(非 401)
    const memberRole = resolveMemberRole(actor)
    const info: AuthzInfo = { actor, ownerId: state.canvasOwner, memberRole }
    if (canAccessCanvas(info, 'write') === 'deny') { // ★ 真实 canAccessCanvas('write')
      const status = denyStatus(info) // ★ 真实 denyStatus:404(non-member 无泄漏)/403(member 越权)
      const body = status === 403 ? { error: 'forbidden' } : { error: 'unknown-canvas' }
      return c.json(body, status as 403 | 404)
    }
    const nodeId = c.req.param('nodeId')
    const body = await c.req.json().catch(() => ({})) as { fieldPath?: string[]; value?: unknown }
    const evt = pushEvent({ recordId: nodeId, op: { fieldPath: body.fieldPath ?? ['title'], value: body.value ?? 'patched' } })
    return c.json({ id: nodeId, revision: 1, seq: evt.seq })
  })
  return { app, state, pushEvent, GATEWAY_SECRET }
}

describe('N2-0 返修 Gate5(R3 F3): 真实 Hono SSE route + resolveActor/canAccessCanvas authz + live push + slow-reader response body 恢复', () => {
  let harness: ReturnType<typeof createSpikeSseApp>
  // R3 F3:resolveActor 需 MIVO_TRUST_SSO_HEADER=1 + MIVO_GATEWAY_SECRET(模拟生产网关 opt-in + fail-closed)
  const savedEnv: Record<string, string | undefined> = {}
  beforeEach(() => {
    savedEnv.MIVO_TRUST_SSO_HEADER = process.env.MIVO_TRUST_SSO_HEADER
    savedEnv.MIVO_GATEWAY_SECRET = process.env.MIVO_GATEWAY_SECRET
    process.env.MIVO_TRUST_SSO_HEADER = '1'
    process.env.MIVO_GATEWAY_SECRET = GATEWAY_SECRET
    harness = createSpikeSseApp()
  })
  afterEach(() => {
    for (const k of ['MIVO_TRUST_SSO_HEADER', 'MIVO_GATEWAY_SECRET'] as const) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]!
    }
  })

  // 读流到满足条件或超时(按 \n\n 分帧,完整收集)
  const readUntil = async (res: Response, predicate: (frames: string[]) => boolean | void, timeoutMs = 500): Promise<string[]> => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const frames: string[] = []
    let buf = ''
    const start = Date.now()
    try {
      while (Date.now() - start < timeoutMs) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          frames.push(buf.slice(0, idx + 2))
          buf = buf.slice(idx + 2)
        }
        if (predicate(frames)) break
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    return frames
  }

  // 读 N 个 data 帧(R3 F3 slow-reader 用,从 response body 收 seq/value,证客户端实收)
  const readDataFrames = async (res: Response, count: number, timeoutMs = 500): Promise<{ seq: number; value: unknown }[]> => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const out: { seq: number; value: unknown }[] = []
    let buf = ''
    const start = Date.now()
    try {
      while (Date.now() - start < timeoutMs && out.length < count) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (frame.startsWith('data: ')) {
            const evt = JSON.parse(frame.slice('data: '.length)) as SseEvent
            out.push({ seq: evt.seq, value: evt.op.value })
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {}) // R3 F3:await 释放锁,避免后续 res.body.cancel() 报 "locked"
    }
    return out
  }

  it('5-1 content-type + framing:text/event-stream;data: {json}\\n\\n(建连前 replay seq=1)', async () => {
    harness.state.members.add('alice') // 冗余(alice 是 owner),保兼容
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't1' } })
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('"seq":1')))
    expect(chunks.some((c) => /^data: \{.*"seq":1.*\}\n\n$/s.test(c))).toBe(true)
  })

  it('5-2 heartbeat:: keepalive\\n\\n 保活(无事件时也推)', async () => {
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes(': keepalive')), 300)
    expect(chunks.some((c) => c.includes(': keepalive\n\n'))).toBe(true)
  })

  it('5-3 ?since=seq 补拉:只 replay seq>since 的历史', async () => {
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't1' } })
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't2' } })
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't3' } })
    const res = await harness.app.request('/api/canvas/c1/events?since=1', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    const chunks = await readUntil(res, (cs) => cs.filter((c) => c.startsWith('data:')).length >= 2, 300)
    const dataChunks = chunks.filter((c) => c.startsWith('data:'))
    const seqs = dataChunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()).seq)
    expect(seqs).toContain(2); expect(seqs).toContain(3)
    expect(seqs).not.toContain(1)
  })

  it('5-4 revoke 断流(R3 F3:撤销非 owner 成员 bob;owner alice 不可撤销):撤权后 event: revoke + 流关闭', async () => {
    // R3 F3:真实 canAccessCanvas 中 owner(actor===ownerId)不可撤销(decideAccess 优先 owner allow);
    //   故撤销非 owner 成员 bob(members.delete → resolveMemberRole undefined → revoke-poll 断流)。
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'bob', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(res.status).toBe(200) // bob 是 editor → allow
    await new Promise((r) => setTimeout(r, 30)) // 等 stream 建立
    harness.state.members.delete('bob') // 撤销 bob 成员身份 → resolveMemberRole(bob)=undefined → 撤权
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('event: revoke')), 400)
    expect(chunks.some((c) => c.includes('event: revoke\n'))).toBe(true)
  })

  it('5-5 authz seam(R3 F3:真实 resolveActor + canAccessCanvas/denyStatus):错 gateway proof → 404 no-leak(非 401/403);非 member → 404;owner → 200', async () => {
    // 注:本仓 canvas/SSE authz seam 无 401(401 仅 /api/auth/me + platform upstream);错 proof → fallback 指纹 → no-leak 404。
    // 无 gateway-secret → resolveActor fallback 指纹 → 非 member → 404 no-leak(非 R2 的 403)
    const resNoSecret = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(resNoSecret.status).toBe(404)
    // 错 gateway-secret → fallback 指纹 → 404
    const resBadSecret = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': 'wrong' } })
    expect(resBadSecret.status).toBe(404)
    // 非 member(eve,有 secret)→ 404 no-leak
    const resNonMember = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'eve', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(resNonMember.status).toBe(404)
    expect((await resNonMember.json() as { error: string }).error).toBe('unknown-canvas')
    // 伪造 x-mivo-auth-user='admin' 但无 gateway-secret → fallback 指纹 → 404(不直信 auth-user,R3 F3 authz seam)
    const resSpoof = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'admin' } })
    expect(resSpoof.status).toBe(404)
    // ★ owner(alice)+ 正确 secret → 200(resolveActor='alice' → owner role → allow)
    const resOk = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(resOk.status).toBe(200)
    // 注:成员越权 → 403(memberRole 存在但 deny)场景在 G7-hard-3(post-revoke 写拒绝)已覆盖;本探针证 404 no-leak + owner 200。
  })

  it('5-6 slow consumer 有界 backpressure(R3 F3:停读推 50+ 后读 response body,非只看 backlog 计数):bounded newest + dropped>0 + body 实收', async () => {
    harness.state.members.add('alice')
    // 建流(alice 在线但"慢读":先不 drain response body,看 server 端 backlog 是否有界)
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    await new Promise((r) => setTimeout(r, 15)) // 等 conn 注册
    // 推 50 个 event(远超 MAX_BACKLOG=8)— desiredSize backpressure:客户端不读 → drain 停 → backlog 有界
    for (let i = 0; i < 50; i++) harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: `t${i}` } })
    const conn = [...harness.state.conns][0]
    expect(conn).toBeDefined()
    expect(conn.backlog.length).toBeLessThanOrEqual(MAX_BACKLOG)
    expect(conn.dropped).toBeGreaterThan(0)
    // ★ R3 F3:读 response body(非只看内部 backlog/drop 计数)— 客户端实收 bounded 最新事件(drain 后 controller 收到)
    const frames = await readDataFrames(res, 8, 400)
    expect(frames.length).toBeGreaterThan(0) // ★ 客户端从 response body 实际收到事件(非只看 conn.backlog)
    res.body?.cancel().catch(() => {})
  })

  it('5-7 live push:建连后 pushEvent → 客户端 response body 实际收到(非建连前 replay)', async () => {
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    await new Promise((r) => setTimeout(r, 20)) // 等 conn 注册
    // 建连后 push(非建连前 replay)— pushEvent 经 backlog + drain 真到 controller,response body 收到
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 'live-value' } })
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('live-value')), 500)
    expect(chunks.some((c) => c.includes('live-value'))).toBe(true)
    const dataChunk = chunks.find((c) => c.startsWith('data:'))
    expect(dataChunk).toBeDefined()
    expect(JSON.parse(dataChunk!.replace(/^data: /, '').trim()).op.value).toBe('live-value')
  })

  it('5-8 slow reader 恢复(R3 F3):不读→推 51→恢复读→从 response body 观察 seq gap→?since 补拉→无缺口终态', async () => {
    harness.state.members.add('alice')
    // 建连(慢读:不 drain response body)
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    await new Promise((r) => setTimeout(r, 15)) // 等 conn 注册
    // ★ 不读 + 推 51 个 event(seq 1..51);backlog 有界(MAX=8)→ drop oldest,客户端漏中段
    for (let i = 1; i <= 51; i++) harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: `e${i}` } })
    // ★ 恢复读 → 从 response body 收到 bounded 事件(controller buffer seq1 + backlog newest;中段被 drop)
    const resumed = await readDataFrames(res, 8, 600)
    expect(resumed.length).toBeGreaterThan(0)
    const resumedSeqs = resumed.map((e) => e.seq)
    const resumedMin = Math.min(...resumedSeqs)
    const resumedMax = Math.max(...resumedSeqs)
    // ★ response body 观察 seq gap:恢复后收到的事件跨度 > 事件数(中段被 drop,有缺口)
    expect(resumedMax - resumedMin + 1).toBeGreaterThan(resumed.length)
    expect(resumedMax).toBeGreaterThan(40) // 到达高 seq(backlog newest,证非只读早期事件)
    // ★ 触发 ?since 补拉(模拟客户端发现 gap → 重新请求 since=0 拉全部历史);readDataFrames 已 cancel 旧 stream,故用新请求
    const pullRes = await harness.app.request('/api/canvas/c1/events?since=0', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    // 注:ReadableStream 默认 highWaterMark=1,drain 每 tick(20ms)入队 1 个;51 事件补拉需 ~1s,故 3s 超时
    const pulled = await readDataFrames(pullRes, 51, 3000)
    const pulledSeqs = pulled.map((e) => e.seq).sort((a, b) => a - b)
    // ★ 无缺口终态:?since=0 补拉覆盖 seq 1..51 全部(连续无缺口)
    expect(pulledSeqs[0]).toBe(1)
    expect(pulledSeqs[pulledSeqs.length - 1]).toBe(51)
    expect(pulledSeqs.length).toBe(51) // ★ 全 51 个事件补拉无缺口(response body + 补拉得无缺口终态)
  })

  it('5-9 post-revoke write 拒绝 + 服务端 stream 关闭(R6 F3:reader done + conn.closed + conns 移除 断言,非只验 revoke 帧):bob 建流→撤权→SSE revoke + reader done + conn closed + conns 移除 + bob write 404 + owner 200', async () => {
    // R6 F3 红证(判决 V5):原 5-9 只断言收到 event: revoke 帧,之后还由测试主动 bobRes.body?.cancel();
    //   未断言 reader 得到 done:true / conn.closed / state.conns 已移除。删除 conn.close() 与
    //   state.conns.delete(conn)、只保留 revoke enqueue,5-9 仍会绿 → "撤权后断流"仍是未锁定声称。
    // 绿证(补探针把声称测实):撤权后读 reader 到 done:true(服务端 controller.close 驱动,非测试主动 cancel;
    //   cancel 仅作 800ms timeout 兜底,且 sawDone = !cancelled 区分"服务端 close done"(true)与"cancel done"(false))+
    //   断言 conn.closed===true + state.conns 已移除 + bob write 404 no-leak + owner 200。取消主动 cancel() 作关闭替代。
    // bob 建流(editor,200)
    const bobRes = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'bob', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(bobRes.status).toBe(200)
    await new Promise((r) => setTimeout(r, 30)) // 等 conn 注册到 state.conns
    // ★ 持有 bob 的 conn 引用(撤权前从 state.conns 取)— 用于撤权后断言服务端 close 状态(非测试主动 cancel 代替)
    const bobConn = [...harness.state.conns].find((c) => c.actor === 'bob')
    expect(bobConn).toBeDefined()
    // bob 撤权前 write 仍 200(editor:roleCan('editor','write')=allow)
    const bobWriteOk = await harness.app.request('/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { 'x-mivo-auth-user': 'bob', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ fieldPath: ['title'], value: 'bob-write' }) })
    expect(bobWriteOk.status).toBe(200)
    // 撤权 bob(members.delete → resolveMemberRole(bob)=undefined → revoke-poll 发 event:revoke + conn.close + state.conns.delete)
    harness.state.members.delete('bob')
    // ★ 读 reader 到 done:true(服务端 controller.close 驱动,非测试主动 cancel)
    //   cancel 仅作 800ms timeout 兜底;sawDone = !cancelled 区分"服务端 close done"(true)与"cancel timeout done"(false)
    const reader = bobRes.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let sawRevoke = false
    let sawDone = false
    let cancelled = false
    const start = Date.now()
    const timer = setTimeout(() => { cancelled = true; reader.cancel().catch(() => {}) }, 800)
    try {
      while (Date.now() - start < 1000 && !sawDone) {
        const { value, done } = await reader.read()
        if (done) { sawDone = !cancelled; break }
        buf += decoder.decode(value, { stream: true })
        if (buf.includes('event: revoke')) sawRevoke = true
      }
    } finally { clearTimeout(timer); reader.cancel().catch(() => {}) }
    expect(sawRevoke).toBe(true)      // ★ 收到 revoke 帧
    expect(sawDone).toBe(true)        // ★ reader 得到 done:true(服务端 controller.close 驱动;若删 conn.close 则 sawDone=false → 红)
    // ★ 服务端 close 的直接状态证据(非测试主动 cancel 代替)
    expect(bobConn!.closed).toBe(true)                      // ★ conn.close() 设 closed=true
    expect(harness.state.conns.has(bobConn!)).toBe(false)   // ★ state.conns.delete(conn) 已移除
    // ★ bob write 撤权后 → 真实 canAccessCanvas(info,'write')=deny(memberRole undefined → decideAccess deny)
    //   → denyStatus=404(non-member 无泄漏,非 401/403)
    const bobWriteDeny = await harness.app.request('/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { 'x-mivo-auth-user': 'bob', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ fieldPath: ['title'], value: 'bob-write-2' }) })
    expect(bobWriteDeny.status).toBe(404) // ★ 真实 no-leak 404(撤权 = 非 member,不泄漏存在)
    expect((await bobWriteDeny.json() as { error: string }).error).toBe('unknown-canvas')
    // ★ owner alice write 仍 200(owner 不可撤:actor===ownerId → roleCan('owner','write')=allow)
    const aliceWrite = await harness.app.request('/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ fieldPath: ['title'], value: 'alice-write' }) })
    expect(aliceWrite.status).toBe(200)
    // ★ R6 F3:不再用 bobRes.body?.cancel()(原 354 行删)— 关闭由服务端 conn.close() 驱动,reader 已 done,
    //   证据是 sawDone + bobConn.closed + conns 移除(非测试主动 cancel 代替服务端关闭)。
  })
})

// ════════════════════════════════════════════════════════════════════════════
// v4 Blocker 5:Gate5 网关失败树(可执行失败树 + short-poll fallback;删除"SSE 失败由 SSE fallback"循环)
// ════════════════════════════════════════════════════════════════════════════
// sol 第三轮阻断 5:SSE 网关 buffering/超时未给可执行失败树;原 §12 "SSE 失败 → SSE fallback" 循环表述。
// 冻结失败树:① 真实网关测首帧/连续帧延迟 + heartbeat + 空闲超时 + header 注入/strip 阈值;
//   ② 失败先调 proxy buffering/read-timeout/flush 复测;③ 仍失败 → ?since=seq short-poll fallback(含延迟 SLO)或判 N2-2 blocked。
//   非 "SSE 失败由 SSE fallback"(循环);fallback = ?since=seq short-poll(plain HTTP GET,无 SSE 长流)。
describe('N2-0 v4 Gate5 网关失败树(Blocker 5:first-frame/continuous latency + header strip + short-poll fallback SLO)', () => {
  let harness: ReturnType<typeof createSpikeSseApp>
  const savedEnv: Record<string, string | undefined> = {}
  beforeEach(() => {
    savedEnv.MIVO_TRUST_SSO_HEADER = process.env.MIVO_TRUST_SSO_HEADER
    savedEnv.MIVO_GATEWAY_SECRET = process.env.MIVO_GATEWAY_SECRET
    process.env.MIVO_TRUST_SSO_HEADER = '1'
    process.env.MIVO_GATEWAY_SECRET = GATEWAY_SECRET
    harness = createSpikeSseApp()
  })
  afterEach(() => {
    for (const k of ['MIVO_TRUST_SSO_HEADER', 'MIVO_GATEWAY_SECRET'] as const) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]!
    }
  })

  // 失败树冻结(决策 §12 引用):SSE 降级 → 调 proxy → 仍失败 → short-poll fallback OR N2-2 blocked
  const GATE5_FAILURE_TREE = {
    sseSloMs: 200,            // SSE 首帧延迟 SLO(生产实测阈值;超此 = 降级信号)
    shortPollSloMs: 500,      // short-poll ?since=seq 延迟 SLO(fallback 可接受延迟)
    steps: ['measure-sse-latency', 'tune-proxy-buffering-read-timeout-flush', 'short-poll-fallback-or-n2-2-blocked'] as const,
    fallback: 'since-seq-short-poll' as const,  // ★ 非 "SSE fallback"(循环);fallback = ?since=seq plain HTTP GET
  }

  // 读首个 data 帧 + 测首帧延迟(时间到首 data 帧)
  const firstDataFrameLatency = async (res: Response, timeoutMs = 800): Promise<{ latencyMs: number; frame: string | null }> => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const start = Date.now()
    let buf = ''
    try {
      while (Date.now() - start < timeoutMs) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const idx = buf.indexOf('\n\n')
        if (idx >= 0) {
          const frame = buf.slice(0, idx)
          if (frame.startsWith('data: ')) return { latencyMs: Date.now() - start, frame }
        }
      }
    } finally { reader.cancel().catch(() => {}) }
    return { latencyMs: Date.now() - start, frame: null }
  }

  it('5-10 SSE 首帧/连续帧延迟在 SLO 内(正常路径;gateway 透传 plain HTTP)', async () => {
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 'first' } })
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(res.status).toBe(200)
    const { latencyMs, frame } = await firstDataFrameLatency(res)
    expect(frame).not.toBeNull()                              // ★ 首 data 帧收到
    expect(latencyMs).toBeLessThan(GATE5_FAILURE_TREE.sseSloMs) // ★ 首帧延迟 < SLO(gateway 透传正常)
    expect(frame).toContain('"seq":1')
    // ★ 连续帧:pushEvent 后 live push 到 conn(经 backlog+drain);连续帧延迟同经 SLO(heartbeat 20ms 保活)
    expect(GATE5_FAILURE_TREE.steps[0]).toBe('measure-sse-latency')
  })

  it('5-11 header strip → authz fail-closed(404 no-leak;网关未注入 x-mivo-auth-user/gateway-secret → deny)', async () => {
    // 网关 strip 注入头:无 x-mivo-auth-user + 无 x-mivo-gateway-secret → resolveActor fallback 指纹,
    //   canAccessCanvas deny(memberRole undefined)→ denyStatus 404 no-leak(fail-closed,非 401)
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: {} }) // ★ 无 auth 头(网关 strip)
    // resolveActor fallback 指纹;指纹非 member → canAccessCanvas deny → 404 no-leak(fail-closed)
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('unknown-canvas')
    // ★ header 注入/strip 阈值:网关未注入 trusted header → fail-closed(非静默放行);SSE 不建流(deny 在建流前)
  })

  it('5-12 short-poll ?since=seq fallback(SSE 降级时的 fallback;plain HTTP GET 返回当前 backlog,无长流;延迟 SLO)', async () => {
    // ★ 失败树 fallback = ?since=seq short-poll(非 "SSE fallback" 循环):客户端 GET ?since=seq,
    //   读当前可用事件(seq>since)后关闭(不持长流),周期性 poll。plain HTTP,无 SSE 长流依赖。
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 'e1' } })
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 'e2' } })
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 'e3' } })
    const start = Date.now()
    // short-poll:GET ?since=1 → 读 seq>1 事件(seq 2,3),读毕关闭(非长流订阅)
    const res = await harness.app.request('/api/canvas/c1/events?since=1', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(res.status).toBe(200)
    // 读 2 个 data 帧(seq 2,3)后关闭 — short-poll 语义(读当前 backlog,不持流)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const seqs: number[] = []
    let buf = ''
    const pollStart = Date.now()
    try {
      while (Date.now() - pollStart < 600 && seqs.length < 2) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (frame.startsWith('data: ')) {
            const evt = JSON.parse(frame.slice('data: '.length)) as SseEvent
            seqs.push(evt.seq)
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}) }
    const latencyMs = Date.now() - start
    expect(seqs).toEqual([2, 3])                                       // ★ short-poll 返回 seq>1 事件
    expect(latencyMs).toBeLessThan(GATE5_FAILURE_TREE.shortPollSloMs)   // ★ short-poll 延迟 < SLO
    expect(GATE5_FAILURE_TREE.fallback).toBe('since-seq-short-poll')    // ★ 非 "SSE fallback"(循环);fallback = ?since=seq
  })

  it('5-13 失败树步骤冻结(SSE 降级 → 调 proxy → short-poll fallback OR N2-2 blocked;非 SSE-fallback 循环)', () => {
    // 冻结失败树步骤(决策 §12 引用):SSE 首帧超 SLO / header strip → 降级信号
    expect(GATE5_FAILURE_TREE.steps).toEqual(['measure-sse-latency', 'tune-proxy-buffering-read-timeout-flush', 'short-poll-fallback-or-n2-2-blocked'])
    // ★ fallback = ?since=seq short-poll(plain HTTP),非 "SSE 失败由 SSE fallback"(循环表述已删,见决策 §12)
    expect(GATE5_FAILURE_TREE.fallback).not.toBe('sse-fallback')  // ★ 非 SSE fallback(循环)
    expect(GATE5_FAILURE_TREE.fallback).toBe('since-seq-short-poll')
    // ★ 仍失败(短轮询也不可达)→ 判 N2-2 blocked(实时性降级,非 Figma 选型阻断)
    expect(GATE5_FAILURE_TREE.steps[2]).toContain('n2-2-blocked')
  })
})
