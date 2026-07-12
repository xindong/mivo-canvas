// server/routes/sse-probe.ts
// B3 SSE 透传诊断 probe — GET /sse-probe (mounted at /api/diag by app.ts).
//
// 用途:N2-0 Gate5 "条件式 GO" 留给 lead 生产实测的网关 SSE 透传项
// (docs/decisions/n20-truth-source-decision.md §12 未验证项 2/3):生产网关对
// text/event-stream 的 buffering/超时/Streaming 行为本仓无法在仓内验,需在公司
// 网关后挂一个最小 SSE 路由实测。本 route 即该最小 probe——纯 heartbeat,无业务数据,
// 供 curl/网关实测透传时延与保活,验证 SSE 走 plain HTTP 经公司网关可达且不被缓冲吞掉。
//
// 严禁用于业务:SSE 业务 events 路由(/api/canvas/:id/events)是 N2-1 契约 §10.5
// 实装范围,本 route 只发 heartbeat,不碰 yjs/契约/业务数据。spike
// (server/__tests__/n20-sse-route.spike.test.ts)验过 SSE 写法(ReadableStream +
// desiredSize backpressure + heartbeat + resolveActor authz seam);本 route 是独立
// 最小实现,不搬 spike 的 yjs/backlog/since/replay 逻辑。
//
// 保护(对齐 lead B3 决议 + G2.1 严格 SSO,owner.ts):
// - env 开关 MIVO_ENABLE_SSE_PROBE(默认关,app.ts 条件挂载)→ 默认构建零暴露:开关不设
//   时路由不挂载,app.ts 注册 404 stub(防 SPA fallback),SSE 代码路径完全不可达。
// - 鉴权复用 resolveActor(server/lib/owner.ts):strict 模式(MIVO_SSO_STRICT=1)下缺/错
//   网关 proof(x-mivo-gateway-secret)→ 抛 SsoAuthError → 顶层
//   app.onError(ssoAuthErrorHandler) → 401(对齐 G2.1)。non-strict 下 fallback 指纹
//   (诊断路由,不取 owner-scoped 资源,无数据泄漏面)。
//
// 流语义:建连立即发 1 条 heartbeat(不等 15s——慢网关也能立刻看到流活着,且测试不必
// 等 15s),之后每 MIVO_SSE_PROBE_INTERVAL_MS(默认 15000ms;可配,测试加速)发一条;每条
// = `event: heartbeat\ndata: {"seq":N,"ts":"ISO"}\n\n`。客户端断开(ReadableStream
// cancel / enqueue 抛)→ clearInterval + close,资源释放(__sseProbeActiveIntervalCount 归 0)。
//
// Env is read per-request (like debug-logs) so tests can vary it without module reset,
// except MIVO_ENABLE_SSE_PROBE itself which gates the mount in app.ts (module-load).

import { Hono } from 'hono'
import { resolveActor } from '../lib/owner'

/** 心跳间隔,默认 15s;测试用 MIVO_SSE_PROBE_INTERVAL_MS 调小加速。生产不改即 15s。 */
const getHeartbeatIntervalMs = (): number => {
  const raw = process.env.MIVO_SSE_PROBE_INTERVAL_MS
  if (raw === undefined || raw === '') return 15_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15_000
}

// 资源释放观测(test hook):当前活跃 heartbeat interval 计数。客户端断开后应归 0
// (clearInterval 已执行)。生产只读不响;test 用 __resetSseProbeState 清理上一轮残留。
let activeIntervalCount = 0
export const __sseProbeActiveIntervalCount = (): number => activeIntervalCount
export const __resetSseProbeState = (): void => {
  activeIntervalCount = 0
}

export const sseProbeRoute = new Hono()

sseProbeRoute.get('/sse-probe', (c) => {
  // 鉴权 gate:复用 resolveActor。strict(MIVO_SSO_STRICT=1)+ 缺/错网关 proof → 抛
  // SsoAuthError → app.onError(ssoAuthErrorHandler) → 401(对齐 G2.1)。结果丢弃:本 route
  // 不取 owner-scoped 资源,只用作 auth gate(side-effect = 抛错);non-strict fallback
  // 指纹对诊断路由可接受(无数据泄漏面)。
  resolveActor(c)

  const encoder = new TextEncoder()
  const intervalMs = getHeartbeatIntervalMs()
  let seq = 0
  let intervalId: ReturnType<typeof setInterval> | null = null
  let stopped = false

  // 释放 heartbeat timer。幂等(stopped 守卫)。cancel / enqueue 抛 都走这里。
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
      if (activeIntervalCount > 0) activeIntervalCount -= 1
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = (): void => {
        if (stopped) return
        seq += 1
        // payload 只含序号 + ISO 时间戳;无业务数据(对齐 lead B3 决议)。
        const payload = { seq, ts: new Date().toISOString() }
        const frame = `event: heartbeat\ndata: ${JSON.stringify(payload)}\n\n`
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          // controller 已关(客户端断开)→ 释放 timer,幂等 close。
          stop()
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
      }
      // 立即发首条:慢网关立刻看到流活着;测试不必等满 15s。
      tick()
      intervalId = setInterval(tick, intervalMs)
      activeIntervalCount += 1
    },
    cancel() {
      // 客户端断开(@hono/node-server 检测到 socket close / 消费方 reader.cancel)
      // → 释放 timer。controller 由消费方关闭,不在此重复 close。
      stop()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
})
