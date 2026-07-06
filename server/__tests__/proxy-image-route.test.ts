// @vitest-environment node
// server/__tests__/proxy-image-route.test.ts
// V-18/V-21 route-level tests. The pure proxyImageSecurity module already has its
// own tests; these exercise the Hono route end-to-end with an injectable transport
// + resolver (no real DNS, no real sockets). The transport seam lets us assert the
// route asked to connect to the *pinned public IP*, not a rebond internal one — the
// exact thing the TOCTOU fix guarantees.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import {
  createProxyImageRoutes,
  type ProxyTransport,
  type ProxyTransportRequest,
  type ProxyTransportResponse,
  ProxyTooLargeError,
} from '../routes/proxy-image'

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44,
])

type Deps = { resolveIps: ReturnType<typeof vi.fn>; transport: ReturnType<typeof vi.fn> }

const buildApp = (deps: Partial<Deps> = {}) => {
  const resolveIps = deps.resolveIps ?? vi.fn(async () => ['93.184.216.34'])
  const transport = deps.transport ?? vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: PNG_BYTES,
  }))
  const app = createProxyImageRoutes({
    resolveIps: resolveIps as unknown as (h: string) => Promise<string[]>,
    transport: transport as unknown as ProxyTransport,
  })
  return { app, resolveIps, transport }
}

const call = async (
  app: ReturnType<typeof createProxyImageRoutes>,
  url: string,
): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> => {
  const res = await app.request(`/proxy-image?url=${encodeURIComponent(url)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })
  return { status: res.status, body: buf, headers }
}

const transportResponse = (partial: Partial<ProxyTransportResponse>): ProxyTransportResponse => ({
  status: 200,
  headers: {},
  body: Buffer.alloc(0),
  ...partial,
})

describe('proxy-image route (V-18 SSRF + V-21 relative Location)', () => {
  let resolveIps: Deps['resolveIps']
  let transport: Deps['transport']

  beforeEach(() => {
    const deps = buildApp()
    resolveIps = deps.resolveIps
    transport = deps.transport
    // tests override per-case by re-assigning these + rebuilding app
  })

  it('rejects an invalid url (bad scheme / empty)', async () => {
    const { app } = buildApp({ resolveIps, transport })
    const r = await app.request('/proxy-image?url=javascript:alert(1)')
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toMatch(/invalid url/)
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks when DNS resolves to a private IP (reject-on-any-private)', async () => {
    resolveIps = vi.fn(async () => ['127.0.0.1'])
    transport = vi.fn(async () => transportResponse({ status: 200, body: PNG_BYTES }))
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'http://evil.example.com/img.png')
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('blocked host')
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks when DNS resolves to a mixed public+private answer (no cherry-pick)', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34', '10.0.0.5'])
    transport = vi.fn(async () => transportResponse({ status: 200, body: PNG_BYTES }))
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'http://evil.example.com/img.png')
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('blocked host')
    // V-18: never pin the public IP from a mixed answer; never connect at all.
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks when DNS has no answer', async () => {
    resolveIps = vi.fn(async () => [])
    transport = vi.fn(async () => transportResponse({ status: 200, body: PNG_BYTES }))
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'http://noanswer.example.com/img.png')
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('blocked host')
    expect(transport).not.toHaveBeenCalled()
  })

  it('passes a normal public image source through', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi.fn(async () =>
      transportResponse({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: PNG_BYTES,
      }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/img.png')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.body.equals(PNG_BYTES)).toBe(true)
    // V-18: the route resolved DNS exactly once and pinned that IP for the connect.
    expect(resolveIps).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledTimes(1)
    const req = transport.mock.calls[0][0] as ProxyTransportRequest
    expect(req.pinnedIp).toBe('93.184.216.34')
    expect(req.url.hostname).toBe('cdn.example.com')
  })

  it('V-18 DNS rebinding: pins the first resolved public IP and never re-resolves', async () => {
    // Simulate a rebinding DNS that would return public first, then internal.
    // With pinning, the route resolves ONCE and connects to the public IP — the
    // second lookup (the rebind) never happens, so the internal IP is never reached.
    resolveIps = vi
      .fn()
      .mockResolvedValueOnce(['93.184.216.34']) // first (check) call: public
      .mockResolvedValueOnce(['127.0.0.1']) // would-be rebind on a second lookup
    transport = vi.fn(async () =>
      transportResponse({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: PNG_BYTES,
      }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://rebind.example.com/img.png')
    expect(r.status).toBe(200)
    // V-18: only one DNS lookup — the rebind answer was never consumed.
    expect(resolveIps).toHaveBeenCalledTimes(1)
    // V-18: the transport was asked to connect to the pinned PUBLIC ip, not 127.0.0.1.
    const req = transport.mock.calls[0][0] as ProxyTransportRequest
    expect(req.pinnedIp).toBe('93.184.216.34')
    expect(req.pinnedIp).not.toBe('127.0.0.1')
  })

  it('V-21 follows a same-origin relative Location redirect (not mis-rejected)', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi
      .fn()
      .mockResolvedValueOnce(
        transportResponse({
          status: 302,
          headers: { location: '/img/x.png' },
          body: Buffer.alloc(0),
        }),
      )
      .mockResolvedValueOnce(
        transportResponse({
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: PNG_BYTES,
        }),
      )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/orig')
    expect(r.status).toBe(200)
    expect(r.body.equals(PNG_BYTES)).toBe(true)
    expect(transport).toHaveBeenCalledTimes(2)
    // The second hop URL was resolved against the current URL → same host, /img/x.png.
    const second = transport.mock.calls[1][0] as ProxyTransportRequest
    expect(second.url.hostname).toBe('cdn.example.com')
    expect(second.url.pathname).toBe('/img/x.png')
    // Each hop does its own resolve+pin (per-hop re-validation, F1).
    expect(resolveIps).toHaveBeenCalledTimes(2)
  })

  it('V-21 follows a protocol-relative Location redirect', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi
      .fn()
      .mockResolvedValueOnce(
        transportResponse({
          status: 302,
          headers: { location: '//cdn.example.com/img/y.png' },
          body: Buffer.alloc(0),
        }),
      )
      .mockResolvedValueOnce(
        transportResponse({
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: PNG_BYTES,
        }),
      )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/orig')
    expect(r.status).toBe(200)
    const second = transport.mock.calls[1][0] as ProxyTransportRequest
    expect(second.url.hostname).toBe('cdn.example.com')
    expect(second.url.pathname).toBe('/img/y.png')
  })

  it('F1 blocks a public→private redirect at the hop', async () => {
    // Hostname-aware resolver: literal IPs pass through (so 127.0.0.1 stays
    // private), hostnames resolve to a public IP. Mimics real resolveHostIps.
    resolveIps = vi.fn(async (h: string) => {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return [h]
      return ['93.184.216.34']
    })
    transport = vi.fn(async () =>
      transportResponse({
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
        body: Buffer.alloc(0),
      }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://evil.example.com/orig')
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body.toString('utf8')).error).toMatch(/blocked/)
    // The origin was fetched (1 call); the redirect target was blocked before connect.
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-image content-type', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi.fn(async () =>
      transportResponse({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html></html>'),
      }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/page')
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('not an image')
  })

  it('maps a transport ProxyTooLargeError to 413', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi.fn(async () => {
      throw new ProxyTooLargeError()
    })
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/huge.png')
    expect(r.status).toBe(413)
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('image too large')
  })

  it('maps an upstream non-2xx (non-3xx) to 502', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi.fn(async () =>
      transportResponse({ status: 500, headers: {}, body: Buffer.alloc(0) }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/img.png')
    expect(r.status).toBe(502)
    expect(JSON.parse(r.body.toString('utf8')).error).toMatch(/upstream status 500/)
  })

  it('caps redirect following at MAX_PROXY_HOPS (4)', async () => {
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi.fn(async () =>
      transportResponse({
        status: 302,
        headers: { location: '/loop.png' },
        body: Buffer.alloc(0),
      }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/orig')
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('too many redirects')
    // 1 origin + 4 hops = 5 transport calls before the cap trips on hop 5.
    expect(transport).toHaveBeenCalledTimes(5)
  })

  it('V-18/fix2: a 3xx with no Location falls out of the redirect loop → 502 (not 200)', async () => {
    // A 302/304 with no Location (or a 3xx body that slips past the loop) must NOT
    // be proxied out as 200 + cache headers just because it carries image/*. The
    // old `!response.status || >= 400` check let 3xx through; the fix restricts
    // success to 2xx (matches native fetch Response.ok).
    resolveIps = vi.fn(async () => ['93.184.216.34'])
    transport = vi.fn(async () =>
      transportResponse({
        status: 302,
        headers: { 'content-type': 'image/png' },
        body: PNG_BYTES,
      }),
    )
    const { app } = buildApp({ resolveIps, transport })
    const r = await call(app, 'https://cdn.example.com/not-modified')
    expect(r.status).toBe(502)
    expect(JSON.parse(r.body.toString('utf8')).error).toMatch(/upstream status 302/)
  })
})
