// src/lib/assetServiceMode.ts
// Pure prefix + gate helpers for the T1.5 server-asset seam.
//
// DELIBERATELY no auth/IO imports here (no authHeaders → no settingsSlice → no
// persistIdbStorage IDB-persist chain). Low-level consumers — chiefly
// assetStorage.ts — statically import this module to route by prefix / check the
// gate WITHOUT pulling the heavy settings-store graph into their module load
// (which would fire IDB-unavailable side effects in node tests that mock
// debugLogStore). The IO side (upload/fetch with authHeaders) lives in
// assetService.ts and is dynamically imported only when a server path is hit.
//
// Routing invariant: resolve/read route by PREFIX (mivo-sasset: → server), so a
// node created in server mode keeps resolving via GET even after the gate flips
// back to local. Only SAVE routes by the current gate (where NEW bytes go).

export const SERVER_ASSET_PREFIX = 'mivo-sasset:'
const ASSETS_ENV_KEY = 'VITE_MIVO_ASSETS'
const ASSET_BASE_ENV_KEY = 'VITE_MIVO_ASSET_BASE'

export type AssetsMode = 'server' | 'local'

/** Compose the assetUrl for a server-stored asset from its content-hash id. */
export const serverAssetUrl = (assetId: string): string => `${SERVER_ASSET_PREFIX}${assetId}`

export const isServerAssetUrl = (url?: string): boolean => Boolean(url && url.startsWith(SERVER_ASSET_PREFIX))

/** Extract the content-hash assetId from a mivo-sasset: url. */
export const serverAssetId = (url: string): string => url.slice(SERVER_ASSET_PREFIX.length)

const isBrowser = (): boolean => typeof window !== 'undefined' && typeof window.location !== 'undefined'

const readEnv = (key: string): string | null => {
  // Dynamic index avoids Vite build-time static replacement (matches kernelMode.ts),
  // so vi.stubEnv in unit tests takes effect at call time.
  const env = import.meta.env as unknown as Record<string, unknown> | undefined
  const raw = env?.[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

const readUrlParam = (): string | null => {
  if (!isBrowser()) return null
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('assets')
    return raw ? raw : null
  } catch {
    return null
  }
}

/**
 * Resolve the assets storage mode. Precedence (matches kernelMode.ts):
 *   env VITE_MIVO_ASSETS > URL ?assets= > default 'local'.
 * CI/build can force 'server' via env without polluting the URL; the URL is the
 * local hand-toggle. Default is local IDB — server mode is opt-in (灰度).
 */
export const resolveAssetsMode = (): AssetsMode => {
  const envVal = readEnv(ASSETS_ENV_KEY)
  if (envVal === 'server' || envVal === 'local') return envVal
  const urlVal = readUrlParam()
  if (urlVal === 'server' || urlVal === 'local') return urlVal
  return 'local'
}

/** True iff new saves should POST to the server (gate on). */
export const isAssetsServerMode = (): boolean => resolveAssetsMode() === 'server'

/** BFF base URL — same-origin by default; VITE_MIVO_ASSET_BASE for static-host deployments. */
export const resolveAssetBaseUrl = (): string => readEnv(ASSET_BASE_ENV_KEY) ?? ''

/**
 * Client-side mirror of the server's image MIME allowlist
 * (server/routes/assets.ts MIME_ALLOWLIST). Only these vetted static-image types are
 * POSTed to the server in server mode; every other kind (markdown / PDF / video /
 * svg / octet-stream) stays on local IDB even when ?assets=server is on — T1.5's
 * scope is static images, and only the server-gate-acceptable subset is server-
 * storable. Kept in this pure module so assetStorage.ts can route without pulling
 * the IO/auth chain. The server sniffs magic bytes and rejects anything outside its
 * own allowlist regardless of this set, so this is a routing hint, not a trust
 * boundary — if the two ever drift, the server still rejects an unsupported type.
 */
export const SERVER_UPLOADABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

/** True iff `type` is a static image the server will accept (server-mode upload gate). */
export const isServerUploadableImage = (type: string): boolean =>
  SERVER_UPLOADABLE_IMAGE_TYPES.has(type.toLowerCase().split(';')[0])
