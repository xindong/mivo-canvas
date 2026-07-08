// server/routes/keys.ts
// POST /api/keys/test — BFF proxy for gateway key validation. Calls the XD gateway
// /v1/models probe (GET Bearer) so the browser never exposes the key to CORS or
// upstream logs. 200=valid, 401=Key 无效, other HTTP=服务异常, network=连接失败.
//
// Ported from XDMaker bootstrap-electron.ts:3031-3051 (api-key:test-connection IPC
// handler) — the Electron net.fetch becomes a plain fetch; the error mapping is
// byte-for-byte identical so maker users see the same copy in MivoCanvas.
//
// B1: the BFF is stateless/zero-DB — this route does NOT persist the key. It only
// probes. Persistence is browser-side (settingsSlice → IDB).
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'

const GATEWAY_MODELS_URL = 'https://llm-proxy.tapsvc.com/v1/models'
const PROBE_TIMEOUT_MS = 10_000

export const keysRoute = new Hono<AppEnv>()

type TestBody = { key?: unknown }
type TestResult = { success: boolean; error?: string }

// POST /api/keys/test  body: { key: string }  → 200 { success, error? }
// Always 200 on the HTTP layer for reached-the-gateway cases (success true/false
// in body) so the frontend can read the structured result; only malformed requests
// (bad JSON / wrong format) return 4xx.
keysRoute.post('/test', async (c): Promise<Response> => {
  let body: TestBody
  try {
    body = (await c.req.json()) as TestBody
  } catch {
    return c.json({ success: false, error: '请求体无效' } satisfies TestResult, 400)
  }
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key.startsWith('sk-')) {
    return c.json({ success: false, error: 'Key 格式无效，需以 sk- 开头' } satisfies TestResult, 400)
  }
  // Guard non-header-safe chars (non-ASCII / space / control) + bare 'sk-' prefix
  // BEFORE building the Bearer header — otherwise fetch throws a ByteString error
  // that the catch below mislabels as "网络连接失败", or a bare 'sk-' (no content
  // after the prefix) wastes a guaranteed-401 upstream probe. 对齐 lib/keys.ts 的
  // GATEWAY_KEY_REGEX `^sk-[\x21-\x7e]+$`(sk- 后至少 1 个可打印 ASCII 字符)。
  if (!/^sk-[\x21-\x7e]+$/.test(key)) {
    return c.json({ success: false, error: 'Key 格式无效（含非法字符，请勿包含空格或中文）' } satisfies TestResult, 400)
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(GATEWAY_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (res.ok) return c.json({ success: true } satisfies TestResult, 200)
    if (res.status === 401) return c.json({ success: false, error: 'Key 无效，请检查' } satisfies TestResult, 200)
    return c.json({ success: false, error: `服务异常 (HTTP ${res.status})` } satisfies TestResult, 200)
  } catch {
    return c.json({ success: false, error: '网络连接失败，请检查网络' } satisfies TestResult, 200)
  } finally {
    clearTimeout(timeoutId)
  }
})
