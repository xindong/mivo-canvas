// server/lib/keys.ts
// BFF per-request key resolution (B1: keys live browser-side; BFF is stateless /
// zero-DB). Routes read X-Mivo-Api-Key from the request header and fall back to env
// so existing single-deployment env-key configs keep working unchanged.
//
// Header contract (E2 ↔ E1):
//   X-Mivo-Api-Key  — mivo_ MCP key. WIRED: drives platform ctx + per-key token
//                     bucketing in server/platform/state.ts.
//   X-Gateway-Key   — sk- gateway key. WIRED: drives llm-proxy calls (enhance /
//                     describe-region / compose-mask-edit via resolveGatewayKey).
//                     Falls back to env MIVO_LLM_API_KEY when absent.
import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { getEnvConfig, type PlatformCtx } from './config'

export const MIVO_API_KEY_HEADER = 'x-mivo-api-key'
export const GATEWAY_KEY_HEADER = 'x-gateway-key'

// Per-user fingerprint of a mivo_ platform key. sha256 first 16 hex chars — enough
// collision resistance for per-key sharding without ever surfacing the raw key in
// memory snapshots or logs. Two distinct mivo_ keys map to two distinct
// fingerprints. SHARED by the platform session-token bucket (server/platform/
// state.ts) and the task-registry owner scope (server/tasks/registry.ts) so a
// user's platform session and their tasks partition identically: a user's tasks
// are only visible to requests carrying the same mivo_ key.
export const fingerprintOfPlatformKey = (platformKey: string): string =>
  createHash('sha256').update(platformKey).digest('hex').slice(0, 16)

/**
 * Resolve a per-request platform ctx for a Hono route handler. Prefer the
 * browser-injected mivo_ key (X-Mivo-Api-Key), fall back to env MIVO_PLATFORM_KEY
 * for programmatic / single-deployment callers. platformEndpoint always comes
 * from env (single upstream).
 */
export const resolvePlatformCtx = (c: Context): PlatformCtx => {
  const env = getEnvConfig()
  const headerKey = c.req.header(MIVO_API_KEY_HEADER)?.trim() ?? ''
  return {
    platformKey: headerKey || env.platformKey,
    platformEndpoint: env.platformEndpoint,
  }
}

/**
 * Build a platform ctx from an already-extracted header key. Used by the async
 * task path: the route reads X-Mivo-Api-Key once, threads it through the runner
 * params (the runner has no access to the Hono Context — it runs fire-and-forget
 * off the registry), and rebuilds the ctx here. Falls back to env when the header
 * was absent so legacy env-key deployments still work.
 */
export const platformCtxFromKey = (platformKey: string | undefined): PlatformCtx => {
  const env = getEnvConfig()
  return {
    platformKey: platformKey?.trim() || env.platformKey,
    platformEndpoint: env.platformEndpoint,
  }
}

// F4: harden the X-Mivo-Api-Key header. A missing/blank header is OK (falls back
// to env via resolvePlatformCtx — the review-probe contract). A present-but-
// malformed header is rejected with 400 and does NOT fall back to env — otherwise
// an attacker spraying bogus headers could pin another tenant's env key into a
// bucket. Limits: 128 chars (generous for any real mivo_ key) + conservative
// charset (mivo_ prefix + [A-Za-z0-9_-] only).
const MIVO_KEY_MAX_LENGTH = 128
const MIVO_KEY_REGEX = /^mivo_[A-Za-z0-9_-]+$/

export type MivoKeyHeaderValidation =
  | { ok: true }
  | { ok: false; status: 400; error: string }

export const validateMivoApiKeyHeader = (c: Context): MivoKeyHeaderValidation => {
  const raw = c.req.header(MIVO_API_KEY_HEADER)
  if (raw === undefined) return { ok: true }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true }
  if (trimmed.length > MIVO_KEY_MAX_LENGTH) {
    return { ok: false, status: 400, error: 'X-Mivo-Api-Key 过长（上限 128 字符）' }
  }
  if (!MIVO_KEY_REGEX.test(trimmed)) {
    return { ok: false, status: 400, error: 'X-Mivo-Api-Key 格式无效（需 mivo_ 前缀 + 字母/数字/下划线/连字符）' }
  }
  return { ok: true }
}

/**
 * Reject a malformed X-Mivo-Api-Key header at the route boundary. Returns the
 * 400 Response to send immediately, or null when the header is absent/blank/
 * well-formed (caller proceeds; resolvePlatformCtx will pick up the header or
 * fall back to env as before).
 */
export const rejectInvalidMivoApiKey = (c: Context): Response | null => {
  const validation = validateMivoApiKeyHeader(c)
  if (validation.ok) return null
  return c.json({ error: validation.error }, validation.status)
}

// Gateway key (sk-) header resolution + validation. Used by the LLM routes
// (enhance / describe-region / compose-mask-edit) that call llm-proxy. Reads
// X-Gateway-Key → falls back to env MIVO_LLM_API_KEY (= MIVO_IMAGE_API_KEY fallback
// in getEnvConfig) for programmatic / single-deployment callers.
// present-but-invalid (non-sk- / non-ASCII / too long) → 400, NO fallback to env
// (防脏 header 构造 Bearer 时 ByteString 异常被误报"网络连接失败";对齐 keys.ts
// /test 路由的非 ASCII 校验)。missing/blank → ok(fallback env via resolveGatewayKey)。
const GATEWAY_KEY_MAX_LENGTH = 128
// sk- 前缀 + 可打印 ASCII(无空格/控制/非 ASCII)—— 严到能防 ByteString 异常,宽到
// 不误拒真实 sk- key(其字符集是 ASCII 子集)。
const GATEWAY_KEY_REGEX = /^sk-[\x21-\x7e]+$/

export type GatewayKeyHeaderValidation =
  | { ok: true }
  | { ok: false; status: 400; error: string }

export const validateGatewayKeyHeader = (c: Context): GatewayKeyHeaderValidation => {
  const raw = c.req.header(GATEWAY_KEY_HEADER)
  if (raw === undefined) return { ok: true }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true }
  if (trimmed.length > GATEWAY_KEY_MAX_LENGTH) {
    return { ok: false, status: 400, error: 'X-Gateway-Key 过长（上限 128 字符）' }
  }
  if (!GATEWAY_KEY_REGEX.test(trimmed)) {
    return { ok: false, status: 400, error: 'X-Gateway-Key 格式无效（需 sk- 前缀 + 不含空格/中文）' }
  }
  return { ok: true }
}

/**
 * Reject a malformed X-Gateway-Key at the route boundary. Returns the 400 Response
 * to send immediately, or null when the header is absent/blank/well-formed (caller
 * proceeds; resolveGatewayKey picks up the header or falls back to env).
 */
export const rejectInvalidGatewayKey = (c: Context): Response | null => {
  const validation = validateGatewayKeyHeader(c)
  if (validation.ok) return null
  return c.json({ error: validation.error }, validation.status)
}

/**
 * Resolve the gateway key (sk-) for a Hono route handler. Prefer the browser-
 * injected X-Gateway-Key, fall back to env MIVO_LLM_API_KEY. Caller should call
 * rejectInvalidGatewayKey(c) first so a present-but-invalid header is rejected
 * (this function assumes the header is absent or already validated).
 */
export const resolveGatewayKey = (c: Context): string => {
  const env = getEnvConfig()
  const headerKey = c.req.header(GATEWAY_KEY_HEADER)?.trim() ?? ''
  return headerKey || env.llmApiKey
}
