// Pure URL + IP-literal validation for the CORS image proxy (W3, QoL batch).
// DNS resolution is NOT pure, so it stays server-side (server/routes/proxy-image.ts).
// This module is the testable core: scheme/credential/hostname checks + literal-IP
// classification (private / loopback / link-local / ULA / IPv4-mapped IPv6).
//
// F1 (per-hop re-validation): every redirect Location is re-run through parseProxyUrl
// + isPrivateHostLiteral so a public URL that 302s to an internal IP is rejected at
// the hop, not just at the origin.

/** Max redirect hops the proxy will follow (F1: hop ≤ 4). */
export const MAX_PROXY_HOPS = 4

export type ProxyUrlResult = { ok: true; url: URL } | { ok: false; reason: string }

/** Validate a single proxy URL: http/https only, no credentials, non-empty host. */
export const parseProxyUrl = (raw: string): ProxyUrlResult => {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'empty-url' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme-not-http' }
  }
  // Reject credential URLs (http://user:pass@host) — never forward auth material.
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials-in-url' }
  }
  if (!url.hostname) {
    return { ok: false, reason: 'empty-host' }
  }
  return { ok: true, url }
}

/**
 * Classify a literal IPv4/IPv6 host as private / loopback / link-local / ULA /
 * IPv4-mapped-IPv6. Returns false for public literals and for non-literal
 * hostnames (those need DNS resolution, done server-side).
 *
 * Cover:
 *  - IPv4: 10/8, 172.16/12, 192.168/16, 127/8 (loopback), 169.254/16 (link-local),
 *    0.0.0.0/8, 100.64/10 (CGNAT — treat as private to be safe).
 *  - IPv6: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local), ::ffff:* (mapped),
 *    ::/128-ish unspecified.
 */
export const isPrivateHostLiteral = (host: string): boolean => {
  // Strip IPv6 brackets `[::1]` → `::1`
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — extract the IPv4 and classify it.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  const plainV4 = mapped
    ? mapped[1]
    : h.includes('.') && !h.includes(':')
      ? h
      : null

  if (plainV4) {
    const parts = plainV4.split('.').map(Number)
    if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return false
    }
    const [a, b] = parts
    if (a === 10) return true // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true // 192.168.0.0/16 private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local
    if (a === 0) return true // 0.0.0.0/8 "this network"
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    return false
  }

  // IPv6 literal (contains ':')
  if (h.includes(':')) {
    const lower = h.toLowerCase()
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true // loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA fc00::/7
    if (lower.startsWith('fe80')) return true // link-local fe80::/10
    if (lower.startsWith('::ffff:')) return true // IPv4-mapped (re-check, mapped branch above usually catches)
    if (lower === '::') return true // unspecified
    return false
  }

  // Hostname (e.g. example.com) — needs DNS resolution; not classifiable as a literal.
  return false
}

/** A redirect Location is safe to follow iff the URL parses and the host is not a
 *  private/loopback/link-local literal. DNS for hostnames is resolved by the caller
 *  (server route) before calling this for the resolved IPs. */
export const isRedirectLocationSafe = (location: string): boolean => {
  const parsed = parseProxyUrl(location)
  if (!parsed.ok) return false
  if (isPrivateHostLiteral(parsed.url.hostname)) return false
  return true
}
