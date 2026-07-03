import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Hono } from 'hono'
import { createEagleRoutes } from './eagle'
import type { AppEnv } from '../lib/types'

const buildApp = (enabled: boolean): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api/mivo', createEagleRoutes({ enabled }))
  return app
}

// Offline suite: Eagle app unreachable (high port nothing listens on).
// Matches the dev-middleware capture baseline (eagle-status-offline etc.).
describe('eagle routes — offline (MIVO_EAGLE_API_URL unreachable)', () => {
  let app: Hono<AppEnv>
  const savedUrl = process.env.MIVO_EAGLE_API_URL
  const savedTimeout = process.env.MIVO_EAGLE_TIMEOUT_MS

  beforeAll(() => {
    process.env.MIVO_EAGLE_API_URL = 'http://127.0.0.1:59999'
    delete process.env.MIVO_EAGLE_TIMEOUT_MS
    app = buildApp(true)
  })

  afterAll(() => {
    if (savedUrl === undefined) delete process.env.MIVO_EAGLE_API_URL
    else process.env.MIVO_EAGLE_API_URL = savedUrl
    if (savedTimeout === undefined) delete process.env.MIVO_EAGLE_TIMEOUT_MS
    else process.env.MIVO_EAGLE_TIMEOUT_MS = savedTimeout
  })

  it('status → 200 {connected:false}', async () => {
    const res = await app.request('/api/mivo/eagle/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = (await res.json()) as { connected: boolean }
    expect(body.connected).toBe(false)
  })

  it('folders → 502 plain text, no Content-Type (D4 preserved)', async () => {
    const res = await app.request('/api/mivo/eagle/folders')
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toBeNull()
  })

  it('tags → 502 plain text, no Content-Type', async () => {
    const res = await app.request('/api/mivo/eagle/tags')
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toBeNull()
  })

  it('assets → 502 plain text, no Content-Type', async () => {
    const res = await app.request('/api/mivo/eagle/assets')
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toBeNull()
  })

  it('thumbnail → 200 SVG fallback (image/svg+xml, no-store)', async () => {
    const res = await app.request('/api/mivo/eagle/assets/abc/thumbnail')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('file → 404 plain text "Eagle original not found"', async () => {
    const res = await app.request('/api/mivo/eagle/assets/abc/file')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBeNull()
    expect(await res.text()).toBe('Eagle original not found')
  })

  it('POST status → 200 same as GET (D6 no method guard)', async () => {
    const res = await app.request('/api/mivo/eagle/status', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connected: boolean }
    expect(body.connected).toBe(false)
  })

  it('disabled → 404 (SC1.4)', async () => {
    const disabled = buildApp(false)
    const res = await disabled.request('/api/mivo/eagle/status')
    expect(res.status).toBe(404)
  })
})

// D5 intentional change: upstream fetch now has a default timeout. A hanging
// Eagle API must surface as the same offline shape, bounded in time.
describe('eagle routes — D5 upstream timeout (MIVO_EAGLE_TIMEOUT_MS=50)', () => {
  let slowServer: Server
  let slowPort: number
  let app: Hono<AppEnv>
  const savedUrl = process.env.MIVO_EAGLE_API_URL
  const savedTimeout = process.env.MIVO_EAGLE_TIMEOUT_MS

  beforeAll(async () => {
    slowServer = createServer((_req, res) => {
      // Never respond quickly; the BFF must time out first.
      setTimeout(() => {
        res.setHeader('content-type', 'application/json')
        res.end('{"status":"success","data":{}}')
      }, 2000)
    })
    await new Promise<void>((resolve) => {
      slowServer.listen(0, '127.0.0.1', () => {
        const addr = slowServer.address()
        slowPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
    process.env.MIVO_EAGLE_API_URL = `http://127.0.0.1:${slowPort}`
    process.env.MIVO_EAGLE_TIMEOUT_MS = '50'
    app = buildApp(true)
  })

  afterAll(async () => {
    if (savedUrl === undefined) delete process.env.MIVO_EAGLE_API_URL
    else process.env.MIVO_EAGLE_API_URL = savedUrl
    if (savedTimeout === undefined) delete process.env.MIVO_EAGLE_TIMEOUT_MS
    else process.env.MIVO_EAGLE_TIMEOUT_MS = savedTimeout
    await new Promise<void>((resolve) => slowServer.close(() => resolve()))
  })

  it('status times out → 200 {connected:false} within ~timeout', async () => {
    const start = Date.now()
    const res = await app.request('/api/mivo/eagle/status')
    const elapsed = Date.now() - start
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connected: boolean }
    expect(body.connected).toBe(false)
    // Timeout is 50ms; allow slack for fetch/socket setup. Must be well under
    // the 2s the slow server takes to respond.
    expect(elapsed).toBeLessThan(1500)
  })

  it('folders times out → 502 within ~timeout', async () => {
    const start = Date.now()
    const res = await app.request('/api/mivo/eagle/folders')
    const elapsed = Date.now() - start
    expect(res.status).toBe(502)
    expect(elapsed).toBeLessThan(1500)
  })
})
