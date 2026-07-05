// server/routes/proxy-image.ts
// W3 (QoL batch): GET /api/mivo/proxy-image?url= — CORS proxy for external images
// so readCanvasImageBlob can load cross-origin URLs that the browser would otherwise
// block with a TypeError ("Failed to fetch").
//
// SSRF hardening (F1): URL validation + IP classification live in the pure module
// src/lib/proxyImageSecurity.ts (testable). DNS resolution happens here (not pure).
// redirect:'manual' + hop ≤ 4, each Location re-validated end-to-end so a public
// URL that 302s to an internal IP is rejected at the hop. Content-Type must be
// image/*, body ≤ 30MB, timeout 15s.

import { Hono } from 'hono'
import { lookup } from 'node:dns/promises'
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
const resolveHostIps = async (hostname: string): Promise<string[]> => {
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

// A host is blocked iff DNS resolves to no IPs OR any resolved IP is a private/
// loopback/link-local/ULA/mapped literal. Reject-on-any-private matches SSRF best
// practice (don't pick the one public IP from a mixed resolution).
const isHostBlocked = async (hostname: string): Promise<boolean> => {
  const ips = await resolveHostIps(hostname)
  if (ips.length === 0) return true
  return ips.some((ip) => isPrivateHostLiteral(ip))
}

const fetchWithTimeout = (url: string): Promise<Response> =>
  fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  })

export const createProxyImageRoutes = (): App => {
  const app: App = new Hono<AppEnv>()
  app.get('/proxy-image', async (c) => {
    const rawUrl = c.req.query('url')
    const parsed = parseProxyUrl(rawUrl || '')
    if (!parsed.ok) {
      return jsonResponse({ error: `invalid url: ${parsed.reason}` }, 400)
    }
    if (await isHostBlocked(parsed.url.hostname)) {
      return jsonResponse({ error: 'blocked host' }, 400)
    }

    let currentUrl: string = parsed.url.toString()
    let response: Response
    try {
      response = await fetchWithTimeout(currentUrl)
    } catch (error) {
      return jsonResponse(
        { error: `upstream fetch failed: ${error instanceof Error ? error.message : ''}` },
        502,
      )
    }

    // Follow 3xx redirects manually, re-validating each Location end-to-end (F1).
    let hop = 0
    while (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      hop += 1
      if (hop > MAX_PROXY_HOPS) {
        return jsonResponse({ error: 'too many redirects' }, 400)
      }
      const location = response.headers.get('location')!
      const nextParsed = parseProxyUrl(location)
      if (!nextParsed.ok) {
        return jsonResponse({ error: `invalid redirect: ${nextParsed.reason}` }, 400)
      }
      if (await isHostBlocked(nextParsed.url.hostname)) {
        return jsonResponse({ error: 'blocked redirect host' }, 400)
      }
      currentUrl = nextParsed.url.toString()
      try {
        response = await fetchWithTimeout(currentUrl)
      } catch (error) {
        return jsonResponse(
          { error: `upstream fetch failed: ${error instanceof Error ? error.message : ''}` },
          502,
        )
      }
    }

    if (!response.ok) {
      return jsonResponse({ error: `upstream status ${response.status}` }, 502)
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) {
      return jsonResponse({ error: 'not an image' }, 400)
    }
    const contentLength = Number(response.headers.get('content-length') || '0')
    if (contentLength && contentLength > PROXY_MAX_BYTES) {
      return jsonResponse({ error: 'image too large' }, 413)
    }

    // Defensive size cap while buffering (Content-Length can be absent/lying).
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > PROXY_MAX_BYTES) {
      return jsonResponse({ error: 'image too large' }, 413)
    }

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  })
  return app
}
