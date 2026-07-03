// server/lib/config.ts
// Env-derived config + static model maps ported from vite.config.ts.
// Env values are read lazily via getEnvConfig() so tests can override per-request
// (timeouts + upstream URLs are test-only overrides; defaults match dev exactly).

// ─── Static constants (model maps, limits, enhance models) ───────────────────
export const mivoModelRatioMap: Record<string, string[]> = {
  'gpt-image-2': ['1:1', '3:2', '2:3', '16:9', '9:16'],
  'gemini-3-pro-image': ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '4:5', '5:4'],
  'doubao-seedance-2-0-260128': ['1:1', '3:4', '4:3', '16:9', '9:16', '21:9'],
  'doubao-seedance-2-0-fast-260128': ['1:1', '3:4', '4:3', '16:9', '9:16', '21:9'],
}
export const mivoModelDefaultRatio: Record<string, string> = {
  'gpt-image-2': '1:1',
  'gemini-3-pro-image': '1:1',
  'doubao-seedance-2-0-260128': '16:9',
  'doubao-seedance-2-0-fast-260128': '16:9',
}
export const defaultMivoImageModel = 'gpt-image-2'
export const mivoQualitySet = new Set(['low', 'medium', 'high'])
export const mivoImageSizeMap = {
  '1:1': { low: '1024x1024', medium: '2048x2048', high: '2304x2304' },
  '3:2': { low: '1536x1024', medium: '3072x2048', high: '3456x2304' },
  '2:3': { low: '1024x1536', medium: '2048x3072', high: '2304x3456' },
  '16:9': { low: '1824x1024', medium: '2048x1152', high: '2560x1440' },
  '9:16': { low: '1024x1824', medium: '1152x2048', high: '1440x2560' },
} as const
export const mivoEnhancePrimaryModel = 'claude-haiku-4-5'
export const mivoEnhanceFallbackModel = 'gpt-5.4-mini'
export const jsonRequestMaxBytes = 1024 * 1024
export const imageRequestMaxBytes = 40 * 1024 * 1024

export type MivoImageRatio = keyof typeof mivoImageSizeMap
export type MivoImageQuality = keyof (typeof mivoImageSizeMap)['1:1']
export type MivoImageResponse = { images: Array<{ b64: string }> }
export type PlatformCtx = { platformKey: string; platformEndpoint: string }

// ─── Env-derived config (lazy; tests override via process.env) ───────────────
export type MivoEnvConfig = {
  imageApiKey: string
  llmApiKey: string
  platformKey: string
  platformEndpoint: string
  imageApiBase: string
  llmApiBase: string
  upstreamTimeoutMs: number
  editUpstreamTimeoutMs: number
  enhancePrimaryTimeoutMs: number
  enhanceFallbackTimeoutMs: number
  platformPollDeadlineMs: number
  platformPollIntervalMs: number
  jsonRequestMaxBytes: number
  imageRequestMaxBytes: number
  // P2-C2: max in-flight variations edits per batch (Promise.allSettled batches of
  // this size). Default 4 = full concurrency for the typical 4-variation batch;
  // >4 batches in groups of this size. Env-tunable so e2e can pin it to 1 to force
  // serial partial-failure ordering.
  variationsConcurrency: number
}

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const getEnvConfig = (): MivoEnvConfig => ({
  imageApiKey: process.env.MIVO_IMAGE_API_KEY || '',
  llmApiKey: process.env.MIVO_LLM_API_KEY || process.env.MIVO_IMAGE_API_KEY || '',
  platformKey: process.env.MIVO_PLATFORM_KEY || '',
  platformEndpoint: (process.env.MIVO_PLATFORM_ENDPOINT || 'https://aigc.xindong.com').replace(/\/$/, ''),
  // Upstream URLs (env-overridable for tests; defaults match dev middleware exactly)
  imageApiBase: process.env.MIVO_IMAGE_API_BASE || 'https://llm-proxy.tapsvc.com/v1/images',
  llmApiBase: process.env.MIVO_LLM_API_BASE || 'https://llm-proxy.tapsvc.com/v1',
  // Timeouts (env-overridable for tests; defaults match dev middleware)
  upstreamTimeoutMs: num(process.env.MIVO_UPSTREAM_TIMEOUT_MS, 240_000),
  editUpstreamTimeoutMs: num(process.env.MIVO_EDIT_UPSTREAM_TIMEOUT_MS, 180_000),
  enhancePrimaryTimeoutMs: num(process.env.MIVO_ENHANCE_PRIMARY_TIMEOUT_MS, 8_000),
  enhanceFallbackTimeoutMs: num(process.env.MIVO_ENHANCE_FALLBACK_TIMEOUT_MS, 8_000),
  platformPollDeadlineMs: num(process.env.MIVO_PLATFORM_POLL_DEADLINE_MS, 175_000),
  platformPollIntervalMs: num(process.env.MIVO_PLATFORM_POLL_INTERVAL_MS, 2_500),
  // Body limits (env-overridable for tests; defaults match dev middleware)
  jsonRequestMaxBytes: num(process.env.MIVO_JSON_REQUEST_MAX_BYTES, jsonRequestMaxBytes),
  imageRequestMaxBytes: num(process.env.MIVO_IMAGE_REQUEST_MAX_BYTES, imageRequestMaxBytes),
  // P2-C2: variations concurrency cap (default 4; e2e may lower to 1).
  variationsConcurrency: num(process.env.MIVO_VARIATIONS_CONCURRENCY, 4),
})
