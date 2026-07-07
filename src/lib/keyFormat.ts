// src/lib/keyFormat.ts
// Two-key format helpers ported from XDMaker's providerSecrets / useApiKey /
// useMivoApiKey patterns (see history/auth-probe/02-gateway-key.md §6.1). MivoCanvas
// is browser-side (no Electron safeStorage), so these are pure functions over the
// raw key string — validation, masking for UI, and hash/tail for log reconciliation.
//
// Two keys:
//   gateway key — `sk-` prefix, validated by GET /v1/models probe (server/routes/keys.ts)
//   mivo key     — `mivo_` prefix, lazy-validated on first tool call (no cheap ping)
//
// Logging invariant: never log the raw key. keyTail (last 4) is for client debug
// log; keyHash (sha256 first 12) mirrors maker's server-side log fingerprint and is
// safe to echo in BFF logs / remote debug reports for cross-side reconciliation.

const GATEWAY_PREFIX = 'sk-'
const MIVO_PREFIX = 'mivo_'
const MIVO_MIN_LENGTH = 12

export const isGatewayKey = (key: string): boolean => key.startsWith(GATEWAY_PREFIX)

export const isMivoKey = (key: string): boolean =>
  key.startsWith(MIVO_PREFIX) && key.length >= MIVO_MIN_LENGTH

export const isMivoKeyPrefix = (key: string): boolean => key.startsWith(MIVO_PREFIX)

/**
 * Mask a key for UI display: keep the prefix (so the user recognizes which key
 * family it is) + last 4 chars (so they can tell keys apart), hide the middle.
 *   sk-abcdef0123   →  sk-••••••0123
 *   mivo_abcdef0123 →  mivo_••••••0123
 * Empty / too-short input returns an empty string (never echoes a partial secret).
 */
export const maskKey = (key: string): string => {
  if (!key) return ''
  const prefix = key.startsWith(MIVO_PREFIX)
    ? MIVO_PREFIX
    : key.startsWith(GATEWAY_PREFIX)
      ? GATEWAY_PREFIX
      : ''
  // Need at least prefix + 4 tail chars to mask without revealing new material.
  if (key.length < (prefix.length || 0) + 4) return ''
  const tail = key.slice(-4)
  return `${prefix}••••••${tail}`
}

/**
 * Last 4 chars for client debug logs. Mirrors maker useApiKey.ts keyTail.
 * Returns '<empty>' / '<short>' sentinels for degenerate input so log lines stay
 * readable instead of printing an empty field.
 */
export const keyTail = (key: string | null | undefined): string => {
  if (!key) return '<empty>'
  if (key.length <= 4) return '<short>'
  return key.slice(-4)
}

/**
 * sha256 first 12 hex chars — server-side log fingerprint. Async because Web
 * Crypto's subtle.digest is async in the browser. Safe to log: sha256 is
 * one-way and 12 hex chars (48 bits) is enough for reconciliation without
 * brute-force exposure of the raw key.
 */
export const keyHash = async (key: string): Promise<string> => {
  if (!key) return ''
  const data = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 12)
}
