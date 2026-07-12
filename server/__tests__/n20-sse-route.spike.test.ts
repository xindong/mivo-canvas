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
})
