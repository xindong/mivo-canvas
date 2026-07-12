// @vitest-environment node
// server/__tests__/n20-sse-route.spike.test.ts
// N2-0 返修 Gate5(R2-2):真实 Hono SSE route 集成 — live push + desiredSize backpressure + gateway-secret authz seam。
//
// ★ spike 属性:本文件是 N2-0 决策证据,自含独立 Hono app(不 import server/app.ts,不接生产装配)。
//   SSE 路由(/api/canvas/:id/events)是 N2-1 契约 §10.5 的预演,生产实装在 N2-1 落地时另行装配。
//   yjs 不进生产 bundle(本文件仅 hono + node stream,无 yjs import)。
//
// R2-2 返修(本轮):
//   - live push:pushEvent 真推到 conn controller(经 backlog + drain),非只压内存数组 → 建连后 push 客户端 response body 实际收到(5-7)。
//   - desiredSize backpressure:drain 由 controller.desiredSize 驱动(<=0 停,backlog 有界 MAX_BACKLOG,满 drop oldest 不 OOM)(5-6)。
//   - authz seam:resolveActor 复用 owner.ts 模式(gateway-secret fail-closed 先验,再信 x-mivo-auth-user),非直信 x-mivo-auth-user(5-5)。
//   - 网关 SSE buffering 条件项:生产网关可能缓冲/超时 text/event-stream(○条件式留 lead 实测,非"无需验证"),见决策文档 §2 Gate5 / §12。
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'

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
    members: new Set<string>(),
    conns: new Set<Conn>(),
    seq: 0,
  }
  // R2-2:resolveActor/authz seam — 复用 owner.ts 模式(gateway-secret fail-closed 先验,再信 x-mivo-auth-user)
  const resolveActor = (c: { req: { header: (n: string) => string | undefined } }): { actor: string; forbidden: boolean } => {
    const secret = c.req.header('x-mivo-gateway-secret')
    if (secret !== GATEWAY_SECRET) return { actor: 'anon', forbidden: true } // ★ fail-closed:无/错 gateway-secret 拒
    const actor = c.req.header('x-mivo-auth-user') ?? 'anon' // gateway 验过后才信 auth-user
    return { actor, forbidden: !state.members.has(actor) }
  }
  const pushEvent = (e: Omit<SseEvent, 'seq'>): SseEvent => {
    const full: SseEvent = { ...e, seq: ++state.seq }
    state.events.push(full)
    // ★ R2-2:live push 到 conn(经 backlog + drain 到 controller),非只压内存数组
    for (const conn of state.conns) conn.push(full)
    return full
  }
  app.get('/api/canvas/:id/events', (c) => {
    // ★ R2-2:authz seam(gateway-secret fail-closed + member check)
    const { actor, forbidden } = resolveActor(c)
    if (forbidden) return c.json({ error: 'forbidden' }, 403)
    const since = Number(c.req.query('since') ?? 0)
    let conn: Conn | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const enqueue = (s: string) => { try { controller.enqueue(encoder.encode(s)) } catch { /* closed */ } }
        conn = {
          actor, controller, backlog: [], closed: false, dropped: 0, enqueue,
          // ★ R2-2:desiredSize 驱动 drain(backpressure:desiredSize<=0 停,backlog 有界)
          drain() {
            if (!conn) return
            const ctrl = conn.controller // 抽局部变量收窄(null check 后访问 desiredSize)
            while (ctrl && (ctrl.desiredSize ?? 0) > 0 && conn.backlog.length > 0) {
              const evt = conn.backlog.shift()!
              conn.enqueue(`data: ${JSON.stringify(evt)}\n\n`)
            }
          },
          // ★ live push:压 backlog(有界 MAX,满 drop oldest)+ drain 到 controller
          push(e) {
            if (conn!.backlog.length >= MAX_BACKLOG) { conn!.dropped++; conn!.backlog.shift() }
            conn!.backlog.push(e)
            conn!.drain()
          },
          close() { if (conn) { conn.closed = true; clearInterval(hb); clearInterval(revokePoll); clearInterval(drainTick); try { conn.controller?.close() } catch { /* already closed */ } } },
        }
        state.conns.add(conn)
        // 3. since 补拉:replay seq>since 的历史(建连前已 push 的;建连后 live push 走 conn.push)
        for (const e of state.events) if (e.seq > since) conn.backlog.push(e)
        conn.drain()
        // 2. heartbeat
        const hb = setInterval(() => enqueue(': keepalive\n\n'), HEARTBEAT_MS)
        // drain tick:客户端读后 backlog 继续 drain(backpressure 解除后)
        const drainTick = setInterval(() => conn?.drain(), HEARTBEAT_MS)
        // 4. revoke 断流:撤权后发 event: revoke + 关闭
        const revokePoll = setInterval(() => {
          if (conn && !state.members.has(actor)) { enqueue('event: revoke\ndata: {}\n\n'); conn.close(); state.conns.delete(conn) }
        }, HEARTBEAT_MS)
      },
      cancel() { if (conn) state.conns.delete(conn) },
    })
    // 1. content-type + framing
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' } })
  })
  return { app, state, pushEvent, GATEWAY_SECRET }
}

describe('N2-0 返修 Gate5(R2-2): 真实 Hono SSE route + live push + desiredSize backpressure + gateway-secret authz', () => {
  let harness: ReturnType<typeof createSpikeSseApp>
  beforeEach(() => { harness = createSpikeSseApp() })

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

  it('5-1 content-type + framing:text/event-stream;data: {json}\\n\\n(建连前 replay seq=1)', async () => {
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't1' } })
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('"seq":1')))
    expect(chunks.some((c) => /^data: \{.*"seq":1.*\}\n\n$/s.test(c))).toBe(true) // ★ SSE framing
  })

  it('5-2 heartbeat:: keepalive\\n\\n 保活(无事件时也推)', async () => {
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes(': keepalive')), 300)
    expect(chunks.some((c) => c.includes(': keepalive\n\n'))).toBe(true) // ★ heartbeat
  })

  it('5-3 ?since=seq 补拉:只 replay seq>since 的历史', async () => {
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't1' } }) // seq 1
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't2' } }) // seq 2
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't3' } }) // seq 3
    // since=1 → 只补 seq 2,3
    const res = await harness.app.request('/api/canvas/c1/events?since=1', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    const chunks = await readUntil(res, (cs) => cs.filter((c) => c.startsWith('data:')).length >= 2, 300)
    const dataChunks = chunks.filter((c) => c.startsWith('data:'))
    const seqs = dataChunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()).seq)
    expect(seqs).toContain(2); expect(seqs).toContain(3)
    expect(seqs).not.toContain(1) // ★ since=1 不补 seq 1
  })

  it('5-4 revoke 断流:撤权后 event: revoke + 流关闭', async () => {
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    await new Promise((r) => setTimeout(r, 30)) // 等 stream 建立
    harness.state.members.delete('alice') // 撤权
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('event: revoke')), 400)
    expect(chunks.some((c) => c.includes('event: revoke\n'))).toBe(true) // ★ revoke 断流信号
  })

  it('5-5 authz seam(R2-2):无/错 gateway-secret → 403(fail-closed);有 secret 非 member → 403;有 secret+member → 流', async () => {
    harness.state.members.add('alice')
    // 无 gateway-secret → 403(fail-closed,owner.ts 模式)
    const resNoSecret = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(resNoSecret.status).toBe(403)
    // 错 gateway-secret → 403
    const resBadSecret = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': 'wrong' } })
    expect(resBadSecret.status).toBe(403)
    // 有 secret + 非 member(eve) → 403
    const resNonMember = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'eve', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(resNonMember.status).toBe(403)
    expect((await resNonMember.json() as { error: string }).error).toBe('forbidden')
    // ★ 伪造 x-mivo-auth-user='admin' 但无 gateway-secret → 仍 403(不直信 auth-user,R2-2 authz seam)
    const resSpoof = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'admin' } })
    expect(resSpoof.status).toBe(403)
    // 有 secret + member → 流
    const resOk = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    expect(resOk.status).toBe(200)
  })

  it('5-6 slow consumer 有界 backpressure(R2-2):desiredSize<=0 时 backlog 有界 + drop oldest(不 OOM)', async () => {
    harness.state.members.add('alice')
    // 建流(alice 在线但"慢读":不 drain response body,看 server 端 backlog 是否有界)
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    await new Promise((r) => setTimeout(r, 15)) // 等 conn 注册
    // 推 50 个 event(远超 MAX_BACKLOG=8)— desiredSize backpressure:客户端不读 → drain 停 → backlog 有界
    for (let i = 0; i < 50; i++) harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: `t${i}` } })
    const conn = [...harness.state.conns][0]
    expect(conn).toBeDefined()
    // ★ backlog 有界:<= MAX_BACKLOG(desiredSize<=0 停 drain,满 drop oldest);dropped > 0(不 OOM)
    expect(conn.backlog.length).toBeLessThanOrEqual(MAX_BACKLOG)
    expect(conn.dropped).toBeGreaterThan(0)
    res.body?.cancel().catch(() => {})
  })

  it('5-7 live push(R2-2):建连后 pushEvent → 客户端 response body 实际收到(非建连前 replay)', async () => {
    harness.state.members.add('alice')
    // 先建连(state.events 空,无 replay)
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': harness.GATEWAY_SECRET } })
    await new Promise((r) => setTimeout(r, 20)) // 等 conn 注册
    // ★ 建连后 push(非建连前 replay)— pushEvent 经 backlog + drain 真到 controller,response body 收到
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 'live-value' } })
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('live-value')), 500)
    // ★ live push 到 response body(R2-2:非 v1 只压内存数组致客户端收不到)
    expect(chunks.some((c) => c.includes('live-value'))).toBe(true)
    const dataChunk = chunks.find((c) => c.startsWith('data:'))
    expect(dataChunk).toBeDefined()
    expect(JSON.parse(dataChunk!.replace(/^data: /, '').trim()).op.value).toBe('live-value') // ★ live event 内容正确
  })
})
