import { describe, expect, it } from 'vitest'
import {
  MAX_PROXY_HOPS,
  isPrivateHostLiteral,
  isRedirectLocationSafe,
  parseProxyUrl,
} from './proxyImageSecurity'

describe('parseProxyUrl (W3 SSRF validation)', () => {
  it('accepts http and https public URLs', () => {
    expect(parseProxyUrl('https://example.com/img.png').ok).toBe(true)
    expect(parseProxyUrl('http://example.com/img.png').ok).toBe(true)
    expect(parseProxyUrl('https://cdn.example.com/a/b/c.jpg?w=800').ok).toBe(true)
  })

  it('rejects non-http schemes (file/ftp/data)', () => {
    expect(parseProxyUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'scheme-not-http' })
    expect(parseProxyUrl('ftp://example.com/x')).toEqual({ ok: false, reason: 'scheme-not-http' })
    expect(parseProxyUrl('data:image/png;base64,xxx')).toEqual({ ok: false, reason: 'scheme-not-http' })
  })

  it('rejects credential URLs (http://user:pass@host)', () => {
    expect(parseProxyUrl('https://user:pass@example.com/x.png')).toEqual({ ok: false, reason: 'credentials-in-url' })
    expect(parseProxyUrl('http://token@example.com/x.png')).toEqual({ ok: false, reason: 'credentials-in-url' })
  })

  it('rejects invalid / empty URLs', () => {
    expect(parseProxyUrl('').ok).toBe(false)
    expect(parseProxyUrl('not-a-url').ok).toBe(false)
    expect(parseProxyUrl('https://').ok).toBe(false)
  })
})

describe('isPrivateHostLiteral (W3 SSRF IP classification)', () => {
  it('flags IPv4 private ranges + loopback + link-local', () => {
    expect(isPrivateHostLiteral('127.0.0.1')).toBe(true)
    expect(isPrivateHostLiteral('10.0.0.1')).toBe(true)
    expect(isPrivateHostLiteral('192.168.1.1')).toBe(true)
    expect(isPrivateHostLiteral('172.16.0.1')).toBe(true)
    expect(isPrivateHostLiteral('172.31.255.1')).toBe(true)
    expect(isPrivateHostLiteral('169.254.169.254')).toBe(true) // AWS metadata
    expect(isPrivateHostLiteral('0.0.0.0')).toBe(true)
    expect(isPrivateHostLiteral('100.64.0.1')).toBe(true) // CGNAT
  })

  it('does not flag public IPv4 literals', () => {
    expect(isPrivateHostLiteral('8.8.8.8')).toBe(false)
    expect(isPrivateHostLiteral('1.1.1.1')).toBe(false)
    expect(isPrivateHostLiteral('203.0.113.5')).toBe(false)
  })

  it('flags IPv6 loopback / ULA / link-local / mapped', () => {
    expect(isPrivateHostLiteral('::1')).toBe(true)
    expect(isPrivateHostLiteral('[::1]')).toBe(true)
    expect(isPrivateHostLiteral('fc00::1')).toBe(true) // ULA
    expect(isPrivateHostLiteral('fd12:3456::1')).toBe(true) // ULA
    expect(isPrivateHostLiteral('fe80::1')).toBe(true) // link-local
    expect(isPrivateHostLiteral('::ffff:127.0.0.1')).toBe(true) // mapped loopback
    expect(isPrivateHostLiteral('::')).toBe(true) // unspecified
  })

  it('does not flag hostnames (DNS resolved server-side) or public IPv6', () => {
    expect(isPrivateHostLiteral('example.com')).toBe(false)
    expect(isPrivateHostLiteral('2606:4700:4700::1111')).toBe(false) // Cloudflare public DNS
  })
})

// SC-W3: redirect re-validation. The proxy follows redirects manually and re-runs
// parseProxyUrl + isPrivateHostLiteral on each Location. These tests prove the
// per-hop check (F1) catches the three SSRF redirect attack shapes.
describe('isRedirectLocationSafe (W3 per-hop redirect re-validation)', () => {
  it('rejects a public URL that 302s to a private IP (public→private redirect)', () => {
    // Attacker's public server returns Location: http://127.0.0.1/admin
    expect(isRedirectLocationSafe('http://127.0.0.1/admin')).toBe(false)
    expect(isRedirectLocationSafe('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isRedirectLocationSafe('http://10.0.0.1/internal')).toBe(false)
  })

  it('rejects a redirect that changes the scheme (scheme redirect)', () => {
    // http→file / http→ftp rejected by parseProxyUrl at the hop
    expect(isRedirectLocationSafe('file:///etc/passwd')).toBe(false)
    expect(isRedirectLocationSafe('ftp://internal/x')).toBe(false)
    // http→javascript (synthesis) rejected too
    expect(isRedirectLocationSafe('javascript:alert(1)')).toBe(false)
  })

  it('accepts a safe public redirect target', () => {
    expect(isRedirectLocationSafe('https://cdn.example.com/img.png')).toBe(true)
  })
})

// SC-W3: redirect loop / too-many-hops. The proxy caps hops at MAX_PROXY_HOPS;
// a loop that exceeds the cap is rejected by the server route's hop counter.
describe('MAX_PROXY_HOPS (W3 redirect-loop cap)', () => {
  it('caps redirect following at 4 hops', () => {
    expect(MAX_PROXY_HOPS).toBe(4)
  })
})
