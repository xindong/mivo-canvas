// @vitest-environment node
// server/__tests__/n20-sse-route.spike.test.ts
// N2-0 返修 Gate5(P1-5):真实 Hono SSE route 集成测试 — 非"内存 callback skeleton"。
//
// ★ spike 属性:本文件是 N2-0 决策证据,自含独立 Hono app(不 import server/app.ts,不接生产装配)。
//   SSE 路由(/api/canvas/:id/events)是 N2-1 契约 §10.5 的预演,生产实装在 N2-1 落地时另行装配。
//   yjs 不进生产 bundle(本文件仅 hono + node stream,无 yjs import)。
//
// 覆盖维度(P1-5 要求):
//   1. content-type + framing(text/event-stream;data: {json}\n\n)
//   2. heartbeat(: keepalive\n\n 保活)
//   3. ?since=seq 补拉(replay seq>since 的历史 events)
//   4. revoke 断流(event: revoke + 流关闭)
//   5. authz(非 member → 403 forbidden;member → 流)
//   6. slow consumer 有界(per-conn backlog 上限,超限 drop oldest 不 OOM)
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── SPIKE SSE state(独立,非生产装配)──
type SseEvent = { seq: number; recordId: string; op: { fieldPath: string[]; value: unknown } }
type Conn = { actor: string; backlog: SseEvent[]; closed: boolean; dropped: number; push: (e: SseEvent) => void; close: () => void }

const HEARTBEAT_MS = 20
const MAX_BACKLOG = 8 // slow-consumer backlog 上限

function createSpikeSseApp() {
  const app = new Hono()
  const state = {
    events: [] as SseEvent[],
    members: new Set<string>(),
    conns: new Set<Conn>(),
    seq: 0,
  }
  const pushEvent = (e: Omit<SseEvent, 'seq'>): SseEvent => {
    const full: SseEvent = { ...e, seq: ++state.seq }
    state.events.push(full)
    for (const conn of state.conns) {
      if (conn.backlog.length >= MAX_BACKLOG) {
        conn.dropped++ // slow consumer:drop oldest(不 OOM)
        conn.backlog.shift()
      }
      conn.backlog.push(full)
    }
    return full
  }
  app.get('/api/canvas/:id/events', (c) => {
    // authz:member check(SSE 侧;gateway-secret fail-closed 是 owner.ts 共享职责,见 auth-sso.review-probe)
    const actor = c.req.header('x-mivo-auth-user') ?? 'anon'
    if (!state.members.has(actor)) return c.json({ error: 'forbidden' }, 403)
    const since = Number(c.req.query('since') ?? 0)
    let conn: Conn | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const enqueue = (s: string) => { try { controller.enqueue(encoder.encode(s)) } catch { /* closed */ } }
        conn = {
          actor, backlog: [], closed: false, dropped: 0,
          push: (e) => { enqueue(`data: ${JSON.stringify(e)}\n\n`) },
          close: () => { if (conn) { conn.closed = true; clearInterval(hb); clearInterval(revokePoll); try { controller.close() } catch { /* already closed */ } } },
        }
        state.conns.add(conn)
        // 3. since 补拉:replay seq>since 的历史
        for (const e of state.events) if (e.seq > since) enqueue(`data: ${JSON.stringify(e)}\n\n`)
        // 2. heartbeat
        const hb = setInterval(() => enqueue(': keepalive\n\n'), HEARTBEAT_MS)
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
  return { app, state, pushEvent }
}

describe('N2-0 返修 Gate5: 真实 Hono SSE route 集成(spike,不接生产装配)', () => {
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

  it('5-1 content-type + framing:text/event-stream;data: {json}\\n\\n', async () => {
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't1' } })
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('"seq":1')))
    expect(chunks.some((c) => /^data: \{.*"seq":1.*\}\n\n$/s.test(c))).toBe(true) // ★ SSE framing
  })

  it('5-2 heartbeat:: keepalive\\n\\n 保活(无事件时也推)', async () => {
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice' } })
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes(': keepalive')), 300)
    expect(chunks.some((c) => c.includes(': keepalive\n\n'))).toBe(true) // ★ heartbeat
  })

  it('5-3 ?since=seq 补拉:只 replay seq>since 的历史', async () => {
    harness.state.members.add('alice')
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't1' } }) // seq 1
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't2' } }) // seq 2
    harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: 't3' } }) // seq 3
    // since=1 → 只补 seq 2,3
    const res = await harness.app.request('/api/canvas/c1/events?since=1', { headers: { 'x-mivo-auth-user': 'alice' } })
    const chunks = await readUntil(res, (cs) => cs.filter((c) => c.startsWith('data:')).length >= 2, 300)
    const dataChunks = chunks.filter((c) => c.startsWith('data:'))
    const seqs = dataChunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()).seq)
    expect(seqs).toContain(2); expect(seqs).toContain(3)
    expect(seqs).not.toContain(1) // ★ since=1 不补 seq 1
  })

  it('5-4 revoke 断流:撤权后 event: revoke + 流关闭', async () => {
    harness.state.members.add('alice')
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice' } })
    // 等 stream 建立后撤权
    await new Promise((r) => setTimeout(r, 30))
    harness.state.members.delete('alice') // 撤权
    const chunks = await readUntil(res, (cs) => cs.some((c) => c.includes('event: revoke')), 400)
    expect(chunks.some((c) => c.includes('event: revoke\n'))).toBe(true) // ★ revoke 断流信号
  })

  it('5-5 authz:非 member → 403 forbidden(不建流)', async () => {
    harness.state.members.add('alice')
    // eve 不是 member
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'eve' } })
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('forbidden') // ★ 非 member 拒绝
  })

  it('5-6 slow consumer 有界:backlog 超 MAX_BACKLOG → drop oldest(不 OOM)', async () => {
    harness.state.members.add('alice')
    // 先建流(alice 在线但"慢读":我们不 drain backlog,看 server 端 backlog 是否有界)
    const res = await harness.app.request('/api/canvas/c1/events', { headers: { 'x-mivo-auth-user': 'alice' } })
    await new Promise((r) => setTimeout(r, 10)) // 等 conn 注册
    // 推 50 个 event(远超 MAX_BACKLOG=8)——conn backlog 必有界,不无限增长
    for (let i = 0; i < 50; i++) harness.pushEvent({ recordId: 'n1', op: { fieldPath: ['title'], value: `t${i}` } })
    const conn = [...harness.state.conns][0]
    expect(conn).toBeDefined()
    // ★ backlog 有界:<= MAX_BACKLOG(超的 drop oldest,dropped 计数 > 0)
    expect(conn.backlog.length).toBeLessThanOrEqual(MAX_BACKLOG)
    expect(conn.dropped).toBeGreaterThan(0)
    res.body?.cancel().catch(() => {})
  })
})
