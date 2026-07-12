// @vitest-environment node
// server/__tests__/sse-probe.test.ts
// B3 SSE 透传诊断 probe route — 4 success-criteria tests (lead B3 决议 #4).
//
// 覆盖 SC(lead B3 SC 全集):
//   SC1: 开关关(MIVO_ENABLE_SSE_PROBE 不设)→ 404,SSE 代码路径完全不可达(默认构建零暴露)
//   SC2: 开 + strict(MIVO_SSO_STRICT=1)+ 无网关 proof → 401(对齐 G2.1)
//   SC3: 开 + 认证(ok proof + x-mivo-auth-user)→ 客户端实收 ≥2 条 heartbeat(seq + ts)
//   SC4: 客户端断开 → heartbeat interval 清理(资源释放;__sseProbeActiveIntervalCount 归 0)
//
// 测试机制:loadFresh(对齐 auth-sso.review-probe.test.ts 的 loadFreshApp)— vi.resetModules()
// + 动态 import,使 MIVO_ENABLE_SSE_PROBE(module-load 挂载 gate,app.ts/env.ts)每测重读。
// strict/secret/interval 是 per-request(resolveActor / sse-probe.ts 调用时读 process.env),
// 同一 app 实例可 per-test 设。test hooks(__sseProbeActiveIntervalCount / __resetSseProbeState)
// 与 app 同一 fresh module graph(import '../routes/sse-probe' 复用 app.ts 已加载的 fresh 实例)。
//
// 不复用 spike(n20-sse-route.spike.test.ts)的 harness:spike 是自含 Hono app + yjs/backlog/since
// /replay 契约预演;本 route 是独立最小 heartbeat probe,测真实 app 装配下的 authz seam + 流 + 资源释放。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_NAMES = [
  'NODE_ENV',
  'MIVO_PUBLIC',
  'MIVO_DEV_MODE',
  'MIVO_SSO_STRICT',
  'MIVO_TRUST_SSO_HEADER',
  'MIVO_GATEWAY_SECRET',
  'MIVO_ENABLE_SSE_PROBE',
  'MIVO_SSE_PROBE_INTERVAL_MS',
  'MIVO_PERSIST_BACKEND',
  'MIVO_PLATFORM_KEY',
] as const

type EnvName = (typeof ENV_NAMES)[number]
const savedEnv: Record<EnvName, string | undefined> = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<EnvName, string | undefined>

const restoreEnv = (): void => {
  for (const name of ENV_NAMES) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

// Mirror auth-sso.review-probe.test.ts loadFreshApp: vi.resetModules + dynamic import,
// so the module-load mount gate (MIVO_ENABLE_SSE_PROBE via env.ts sseProbeEnabled →
// app.ts conditional mount) is re-read per test. Returns app + sse-probe test hooks
// from the SAME fresh module graph (test hooks observe the fresh module's counter).
// Return type is inferred (Hono's app.request returns Response | Promise<Response>).
const loadFresh = async () => {
  vi.resetModules()
  const { app } = await import('../app')
  const hooks = await import('../routes/sse-probe')
  return { app, ...hooks }
}

const GATEWAY_SECRET = 'test-gateway-secret-b3'

// Read N heartbeat frames (event: heartbeat + data: {seq,ts}) from the SSE stream.
// Splits on \n\n (SSE frame boundary); tolerates partial chunks across reads.
const readHeartbeats = async (
  res: Response,
  count: number,
  timeoutMs = 1000,
): Promise<{ seq: number; ts: string }[]> => {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const out: { seq: number; ts: string }[] = []
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
        if (!frame.startsWith('event: heartbeat')) continue
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const parsed = JSON.parse(dataLine.slice('data: '.length)) as { seq: number; ts: string }
        out.push({ seq: parsed.seq, ts: parsed.ts })
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return out
}

describe('B3 SSE probe route (GET /api/diag/sse-probe)', () => {
  beforeEach(() => {
    restoreEnv()
    // Clear probe env between tests so loadFresh re-reads module-load flags cleanly.
    for (const name of ENV_NAMES) delete process.env[name]
  })

  afterEach(() => {
    restoreEnv()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('SC1: switch off (MIVO_ENABLE_SSE_PROBE unset) → 404, SSE path unreachable', async () => {
    // MIVO_ENABLE_SSE_PROBE unset → app.ts does not mount sseProbeRoute; the 404 stub
    // returns 404 (no SPA fallback for an /api path). SSE/auth code never runs.
    const { app } = await loadFresh()
    const res = await app.request('/api/diag/sse-probe')
    expect(res.status).toBe(404)
  })

  it('SC2: switch on + strict + no gateway proof → 401 (aligned with G2.1)', async () => {
    process.env.MIVO_ENABLE_SSE_PROBE = '1'
    process.env.MIVO_SSO_STRICT = '1'
    process.env.MIVO_GATEWAY_SECRET = GATEWAY_SECRET
    // No x-mivo-gateway-secret header → resolveActor strict branch throws SsoAuthError
    // (ssoHeaderSecretOk fails) → app.onError(ssoAuthErrorHandler) → 401.
    const { app } = await loadFresh()
    const res = await app.request('/api/diag/sse-probe')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: expect.stringContaining('gateway secret'),
    })
  })

  it('SC3: switch on + auth ok → client receives ≥2 heartbeats (seq + ts)', async () => {
    process.env.MIVO_ENABLE_SSE_PROBE = '1'
    process.env.MIVO_SSO_STRICT = '1'
    process.env.MIVO_GATEWAY_SECRET = GATEWAY_SECRET
    process.env.MIVO_SSE_PROBE_INTERVAL_MS = '20' // test speed (prod default 15000ms)
    const { app } = await loadFresh()
    const res = await app.request('/api/diag/sse-probe', {
      headers: {
        'x-mivo-gateway-secret': GATEWAY_SECRET,
        'x-mivo-auth-user': 'alice',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const beats = await readHeartbeats(res, 2, 1000)
    expect(beats.length).toBeGreaterThanOrEqual(2)
    // seq strictly increasing from 1 (first heartbeat sent immediately on connect).
    expect(beats[0].seq).toBe(1)
    expect(beats[1].seq).toBe(2)
    // ts is ISO 8601 (no business data, just seq + timestamp per B3 spec).
    expect(beats[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(beats[1].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('SC4: client disconnect → heartbeat interval cleared (resources released)', async () => {
    process.env.MIVO_ENABLE_SSE_PROBE = '1'
    process.env.MIVO_SSO_STRICT = '1'
    process.env.MIVO_GATEWAY_SECRET = GATEWAY_SECRET
    process.env.MIVO_SSE_PROBE_INTERVAL_MS = '20'
    const { app, __sseProbeActiveIntervalCount, __resetSseProbeState } = await loadFresh()
    __resetSseProbeState()

    const res = await app.request('/api/diag/sse-probe', {
      headers: {
        'x-mivo-gateway-secret': GATEWAY_SECRET,
        'x-mivo-auth-user': 'alice',
      },
    })
    expect(res.status).toBe(200)
    // Read one heartbeat chunk → stream start() ran → setInterval registered.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(decoder.decode(first.value)).toContain('event: heartbeat')
    // Interval now active (one live heartbeat timer per open connection).
    expect(__sseProbeActiveIntervalCount()).toBe(1)
    // Client disconnect → cancel stream → cancel() source fires → clearInterval.
    await reader.cancel()
    // Let the microtask queue process cancel (defense; await cancel() usually suffices).
    await new Promise((r) => setTimeout(r, 50))
    expect(__sseProbeActiveIntervalCount()).toBe(0)
  })
})
