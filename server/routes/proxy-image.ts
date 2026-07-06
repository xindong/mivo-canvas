// server/routes/proxy-image.ts
// W3 (QoL batch): GET /api/mivo/proxy-image?url= — CORS proxy for external images
// so readCanvasImageBlob can load cross-origin URLs that the browser would otherwise
// block with a TypeError ("Failed to fetch").
//
// SSRF hardening (F1 + V-18): URL validation + IP classification live in the pure
// module src/lib/proxyImageSecurity.ts (testable). DNS resolution + IP pinning live
// here (not pure). The hostname is resolved ONCE per hop; the connection is then
// made directly to the pinned public IP (Host header = original hostname, servername
// = hostname for TLS). No second DNS lookup happens, so a DNS-rebinding attack that
// flips the record to an internal IP between the block-check and the connect cannot
// redirect the connection — the TOCTOU window is closed. redirect:'manual' + hop ≤ 4,
// each Location re-validated end-to-end (V-21: relative Location resolved against the
// current URL before validation so `/img/x.png` on a public host is not mis-rejected).
// Content-Type must be image/*, body ≤ 30MB, timeout 15s.

import { Hono } from 'hono'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import {
  MAX_PROXY_HOPS,
  isPrivateHostLiteral,
  parseProxyUrl,
} from '../lib/proxyImageSecurity'
import { jsonResponse } from '../lib/response'
import type { App, AppEnv } from '../lib/types'

const PROXY_TIMEOUT_MS = 15_000
const PROXY_MAX_BYTES = 30 * 1024 * 1024

// Resolve a hostname to IPs. Literal IPs (v4/v6) are returned as-is (no DNS).
// Returns [] on DNS failure — caller treats unresolvable as blocked.
// Exported for tests to stub DNS rebinding (first call public, second call private).
export const resolveHostIps = async (hostname: string): Promise<string[]> => {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return [host]
  }
  try {
    const result = await lookup(host, { all: true })
    return result.map((record) => record.address)
  } catch {
    return []
  }
}

// V-18: sentinel for "every resolved IP is private / unresolvable" → route maps to 400.
class ProxyBlockedError extends Error {
  constructor() {
    super('blocked host')
    this.name = 'ProxyBlockedError'
  }
}

// V-18: sentinel for the defensive size cap exceeded while buffering → 413.
export class ProxyTooLargeError extends Error {
  constructor() {
    super('image too large')
    this.name = 'ProxyTooLargeError'
  }
}

// What the transport hands back to the route. headers keys are lowercase; `body`
// is the fully buffered response (capped at maxBytes by the transport).
export type ProxyTransportResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
}

// The transport is told to connect to `pinnedIp` (never to re-resolve `url.hostname`)
// while sending Host: <hostname> and (for TLS) servername: <hostname> so SNI/cert
// validation still use the original name. This is the seam that makes the route
// testable without real DNS or real sockets — tests inject a fake transport and
// assert it was asked to connect to the pinned public IP, not the rebond internal one.
export type ProxyTransportRequest = {
  url: URL
  pinnedIp: string
  signal: AbortSignal
  timeoutMs: number
  maxBytes: number
}
export type ProxyTransport = (req: ProxyTransportRequest) => Promise<ProxyTransportResponse>

// Default transport: node http/https against the pinned IP. Aborts on signal,
// enforces the defensive size cap mid-stream (throws ProxyTooLargeError).
// Exported so the abort-cleanup path can be exercised against a real local socket.
export const nodeHttpTransport: ProxyTransport = ({ url, pinnedIp, signal, timeoutMs, maxBytes }) => {
  const isTls = url.protocol === 'https:'
  const port = url.port ? Number(url.port) : isTls ? 443 : 80
  const path = `${url.pathname}${url.search}`
  // Host header carries the original hostname (+ non-default port) so virtual-host
  // routing on the upstream sees what it would for a native fetch. Pinning the TCP
  // target to the resolved IP doesn't change the Host header.
  const hostHeaderValue = url.port ? `${url.hostname}:${url.port}` : url.hostname
  const requestHeaders: Record<string, string> = { host: hostHeaderValue }
  const options: RequestOptions = {
    method: 'GET',
    host: pinnedIp,
    port,
    path,
    headers: requestHeaders,
    // For TLS, servername drives SNI + cert verification against the original
    // hostname while the TCP target is the pinned IP.
    ...(isTls ? { servername: url.hostname } : {}),
  }
  const req = isTls ? httpsRequest(options) : httpRequest(options)

  let settled = false
  // cleanup is shared by every settle path (timer-fires, abort, response-end,
  // too-large, error). Idempotent — settled + clear/remove being no-ops makes a
  // second call safe. function declarations are hoisted so cleanup↔onAbort can
  // reference each other without TDZ.
  function cleanup(): void {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  // Nit 1: on abort, run cleanup() SYNCHRONOUSLY right now (clear the timer +
  // drop the abort listener) instead of only relying on the async req 'error'
  // event. The old code destroyed the socket but left the timer/listener live
  // until the error event fired — a release window. settled keeps it idempotent;
  // the subsequent req 'error' handler runs cleanup() again as a no-op and rejects.
  function onAbort(): void {
    if (settled) return
    cleanup()
    req.destroy(new Error('aborted'))
  }
  const timer = setTimeout(() => {
    if (settled) return
    cleanup()
    req.destroy(new Error('timeout'))
  }, timeoutMs)
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  return new Promise<ProxyTransportResponse>((resolve, reject) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let total = 0
      let tooLarge = false
      res.on('data', (chunk: Buffer) => {
        if (tooLarge) return
        total += chunk.length
        if (total > maxBytes) {
          tooLarge = true
          settled = true
          cleanup()
          res.destroy()
          req.destroy()
          reject(new ProxyTooLargeError())
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        settled = true
        cleanup()
        const headers: Record<string, string> = {}
        const raw = res.headers as Record<string, string | string[] | undefined>
        for (const [k, v] of Object.entries(raw)) {
          if (v === undefined) continue
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) })
      })
      res.on('error', (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      })
    })
    req.on('error', (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })
    req.end()
  })
}

export type ProxyImageDeps = {
  resolveIps?: (hostname: string) => Promise<string[]>
  transport?: ProxyTransport
}

export type FetchPinnedDeps = {
  resolveIps: (hostname: string) => Promise<string[]>
  transport: ProxyTransport
  timeoutMs: number
  maxBytes: number
}

// V-18 + nit 2: resolve the hostname ONCE, block-check the resolved IPs, then
// connect directly to a pinned public IP. The transport never re-resolves DNS,
// so a rebinding flip between check and connect has no effect. Reject-on-any-
// private matches the original isHostBlocked semantics: a mixed resolution is
// blocked wholesale, not cherry-picked. Nit 2: if the signal already aborted
// (e.g. between redirect hops, or a client disconnect during a streak), skip the
// DNS query entirely — no point doing a lookup whose result we'll throw away.
// Exported so the abort-before-DNS guard can be unit-tested in isolation.
export const fetchPinned = async (
  urlString: string,
  signal: AbortSignal,
  deps: FetchPinnedDeps,
): Promise<ProxyTransportResponse> => {
  if (signal.aborted) throw new Error('aborted')
  const url = new URL(urlString)
  const ips = await deps.resolveIps(url.hostname)
  if (ips.length === 0) throw new ProxyBlockedError()
  if (ips.some((ip) => isPrivateHostLiteral(ip))) throw new ProxyBlockedError()
  // All resolved IPs are public — pin the first. The transport connects here
  // directly (Host header carries the original hostname), so no second DNS
  // lookup can rebind the connection to an internal IP.
  const pinnedIp = ips[0]
  return deps.transport({ url, pinnedIp, signal, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes })
}

export const createProxyImageRoutes = (deps: ProxyImageDeps = {}): App => {
  const resolveIps = deps.resolveIps ?? resolveHostIps
  const transport = deps.transport ?? nodeHttpTransport
  const fetchPinnedDeps: FetchPinnedDeps = {
    resolveIps,
    transport,
    timeoutMs: PROXY_TIMEOUT_MS,
    maxBytes: PROXY_MAX_BYTES,
  }

  const app: App = new Hono<AppEnv>()
  app.get('/proxy-image', async (c) => {
    const rawUrl = c.req.query('url')
    const parsed = parseProxyUrl(rawUrl || '')
    if (!parsed.ok) {
      return jsonResponse({ error: `invalid url: ${parsed.reason}` }, 400)
    }

    let currentUrl: string = parsed.url.toString()
    const signal = AbortSignal.timeout(PROXY_TIMEOUT_MS)
    let response: ProxyTransportResponse
    try {
      response = await fetchPinned(currentUrl, signal, fetchPinnedDeps)
    } catch (error) {
      if (error instanceof ProxyTooLargeError) return jsonResponse({ error: 'image too large' }, 413)
      if (error instanceof ProxyBlockedError) return jsonResponse({ error: 'blocked host' }, 400)
      return jsonResponse(
        { error: `upstream fetch failed: ${error instanceof Error ? error.message : ''}` },
        502,
      )
    }

    // Follow 3xx redirects manually, re-validating each Location end-to-end (F1).
    let hop = 0
    while (response.status >= 300 && response.status < 400 && response.headers['location']) {
      hop += 1
      if (hop > MAX_PROXY_HOPS) {
        return jsonResponse({ error: 'too many redirects' }, 400)
      }
      const location = response.headers['location']
      // V-21: resolve relative Location against the current URL before validation.
      // A public CDN returning `Location: /img/x.png` (same-origin relative) or
      // `//cdn.example.com/img.png` (protocol-relative) is a normal redirect, not
      // an SSRF attempt — the old parseProxyUrl-on-raw-Location path mis-rejected
      // these as empty-host.
      let nextUrl: URL
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        return jsonResponse({ error: 'invalid redirect url' }, 400)
      }
      const nextParsed = parseProxyUrl(nextUrl.toString())
      if (!nextParsed.ok) {
        return jsonResponse({ error: `invalid redirect: ${nextParsed.reason}` }, 400)
      }
      currentUrl = nextParsed.url.toString()
      try {
        response = await fetchPinned(currentUrl, signal, fetchPinnedDeps)
      } catch (error) {
        if (error instanceof ProxyTooLargeError) return jsonResponse({ error: 'image too large' }, 413)
        if (error instanceof ProxyBlockedError) return jsonResponse({ error: 'blocked host' }, 400)
        return jsonResponse(
          { error: `upstream fetch failed: ${error instanceof Error ? error.message : ''}` },
          502,
        )
      }
    }

    // Only 2xx is a success. A 3xx with no Location falls out of the redirect
    // loop above; treating it as success (the old `!response.status || >= 400`
    // check did) would proxy a 302/304 body with image/* through as 200 + cache
    // headers. Match native fetch's Response.ok semantics (2xx only).
    if (response.status < 200 || response.status >= 300) {
      return jsonResponse({ error: `upstream status ${response.status}` }, 502)
    }
    const contentType = response.headers['content-type'] || ''
    if (!contentType.startsWith('image/')) {
      return jsonResponse({ error: 'not an image' }, 400)
    }
    if (response.body.length > PROXY_MAX_BYTES) {
      return jsonResponse({ error: 'image too large' }, 413)
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  })
  return app
}
