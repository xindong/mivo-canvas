import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Hono } from 'hono'
import { createAssetRoutes } from './assets'
import { fingerprintOfPlatformKey } from '../lib/keys'
import { createFsAssetBackend, createMemoryAssetBackend, type AssetStoreBackend } from '../lib/assetStore'
import type { AppEnv } from '../lib/types'

// Mirrors how server/app.ts mounts the sub-app: app.route('/api', createAssetRoutes()).
const buildApp = (backend: AssetStoreBackend): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api', createAssetRoutes({ backend }))
  return app
}

// P1-A: the route canonicalizes via sharp (full decode + re-encode), so test fixtures
// must be REAL decodable images. sharp generates them at test time — no binary blobs in
// the repo, and the fixtures are guaranteed decodable.
const realPng = (color: { r: number; g: number; b: number } = { r: 255, g: 0, b: 0 }) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer()
const realJpeg = (color: { r: number; g: number; b: number } = { r: 0, g: 255, b: 0 }) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).jpeg().toBuffer()
const realWebp = (color: { r: number; g: number; b: number } = { r: 0, g: 0, b: 255 }) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).webp().toBuffer()
const realGif = (color: { r: number; g: number; b: number } = { r: 255, g: 255, b: 0 }) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).gif().toBuffer()
const realAvif = (color: { r: number; g: number; b: number } = { r: 255, g: 0, b: 255 }) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).avif().toBuffer()

// A real 2-frame animated GIF (red frame + green frame).
const realAnimatedGif = (): Promise<Buffer> => {
  const raw = Buffer.from([255, 0, 0, 0, 255, 0])
  return sharp(raw, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
    .gif({ loop: 0, delay: [100, 100] })
    .toBuffer()
}

// The route's canonicalization replicated for test predictions (sharp is deterministic):
// decode with animated:true, re-encode in the detected format.
const canonicalOf = async (bytes: Buffer, fmt: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif'): Promise<Buffer> =>
  sharp(bytes, { animated: true }).toFormat(fmt).toBuffer()

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

// SVG / HTML / PDF — executable/navigable content that must be REJECTED (P1-A: sharp
// decode fails on all of these).
const svgBytes = Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
const htmlBytes = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')
const pdfBytes = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj')

// P2.8: fixture uses the FAKEKEY marker (allowlisted in .gitleaks.toml) — NOT a
// blanket mivo_ exemption. Real key shapes are still scanned.
const MIVO_KEY = 'mivo_FAKEKEY_test'
const fp = () => fingerprintOfPlatformKey(MIVO_KEY)

describe('POST /api/assets', () => {
  it('multipart upload → 200 {assetId, mimeType, ...}; assetId = sha256(canonical) hex64; refcount=0', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng()
    const canonical = await canonicalOf(bytes, 'png')
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')

    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = (await res.json()) as { assetId: string; mimeType: string; originalName: string; sizeBytes: number; refcount: number; deduped: boolean }
    expect(body.assetId).toBe(sha256Hex(canonical)) // assetId = sha256(CANONICAL bytes)
    expect(body.assetId).toHaveLength(64)
    expect(body.mimeType).toBe('image/png')
    expect(body.originalName).toBe('a.png')
    expect(body.sizeBytes).toBe(canonical.length) // size is the canonical size, not the input
    expect(body.refcount).toBe(0) // upload does NOT attach (P1.2)
    expect(body.deduped).toBe(false)
  })

  it('dedup: same image twice → same assetId, deduped=true on 2nd, one copy; refcount stays 0', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 1, g: 2, b: 3 })
    const post = async () => {
      const form = new FormData()
      form.append('image', new File([bytes], 'x.png', { type: 'image/png' }), 'x.png')
      return app.request('/api/assets', { method: 'POST', body: form })
    }
    const r1 = await (await post()).json() as { assetId: string; refcount: number; deduped: boolean }
    const r2 = await (await post()).json() as { assetId: string; refcount: number; deduped: boolean }
    expect(r1.assetId).toBe(r2.assetId)
    expect(r1.refcount).toBe(0)
    expect(r1.deduped).toBe(false)
    expect(r2.refcount).toBe(0)
    expect(r2.deduped).toBe(true) // canonical reused
    expect(be._bytes.size).toBe(1)
  })

  it('JSON base64 upload → 200; sniffed type honored (providedType ignored for the gate)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 4, g: 5, b: 6 })
    // Lie about the type (text/html) — the server must decode png and store image/png.
    const res = await app.request('/api/assets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: bytes.toString('base64'), name: 'json.png', type: 'text/html' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assetId: string; originalName: string; mimeType: string }
    expect(body.originalName).toBe('json.png')
    expect(body.mimeType).toBe('image/png') // decoded canonical, not the lied text/html
  })

  it('P1-A: AVIF (allowlisted) accepted → 200 image/avif', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realAvif()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.avif', { type: 'image/avif' }), 'a.avif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/avif')
  })

  it('P1-A: real JPEG accepted → 200 image/jpeg', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realJpeg()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.jpg', { type: 'image/jpeg' }), 'a.jpg')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/jpeg')
  })

  it('P1-A: real WebP accepted → 200 image/webp', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realWebp()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.webp', { type: 'image/webp' }), 'a.webp')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/webp')
  })

  it('P1-A: real GIF accepted → 200 image/gif', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realGif()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.gif', { type: 'image/gif' }), 'a.gif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/gif')
  })

  it('P1-A: SVG (script-carrying) rejected → 415 mime_rejected', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([svgBytes], 'evil.svg', { type: 'image/svg+xml' }), 'evil.svg')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('mime_rejected')
    expect(be._records.size).toBe(0)
    expect(be._bytes.size).toBe(0)
  })

  it('P1-A: HTML rejected → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([htmlBytes], 'evil.html', { type: 'text/html' }), 'evil.html')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('P1-A: PDF rejected → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([pdfBytes], 'x.pdf', { type: 'application/pdf' }), 'x.pdf')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('multipart with no image field → 400', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('name', 'noimage')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })

  it('stamps ownerFp from X-Mivo-Api-Key (FX-2 归属打标); references empty (no attach)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 7, g: 8, b: 9 })
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
    const { assetId } = await (await app.request('/api/assets', {
      method: 'POST',
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
      body: form,
    })).json() as { assetId: string }
    const rec = be._records.get(assetId)
    expect(rec?.ownerFp).toBe(fp())
    expect(rec?.references).toEqual([]) // no attach in T1.5
  })

  it('malformed X-Mivo-Api-Key → 400 (no env fallback for bogus headers)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([await realPng()], 'a.png', { type: 'image/png' }), 'a.png')
    const res = await app.request('/api/assets', {
      method: 'POST',
      headers: { 'X-Mivo-Api-Key': 'not-a-mivo-key' },
      body: form,
    })
    expect(res.status).toBe(400)
    expect(be._records.size).toBe(0)
  })

  it('P1.4: per-owner quota exceeded → 413 quota_exceeded', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    vi.stubEnv('MIVO_ASSET_OWNER_QUOTA_BYTES', '5') // 5 bytes — any canonical png exceeds it
    try {
      const form = new FormData()
      form.append('image', new File([await realPng()], 'q.png', { type: 'image/png' }), 'q.png')
      const res = await app.request('/api/assets', {
        method: 'POST',
        headers: { 'X-Mivo-Api-Key': MIVO_KEY },
        body: form,
      })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { code: string; quota: number; used: number; size: number }
      expect(body.code).toBe('quota_exceeded')
      expect(be._bytes.size).toBe(0) // nothing stored
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('GET /api/assets/:id (P2.5 owner-scoped + P1.3 nosniff)', () => {
  it('uploader GET → 200 + Content-Type + nosniff + Cache-Control: private; body = canonical', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 10, g: 20, b: 30 })
    const canonical = await canonicalOf(bytes, 'png')
    const form = new FormData()
    form.append('image', new File([bytes], 'serve.png', { type: 'image/png' }), 'serve.png')
    const { assetId } = await (await app.request('/api/assets', {
      method: 'POST',
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
      body: form,
    })).json() as { assetId: string }

    const res = await app.request(`/api/assets/${assetId}`, {
      headers: { 'X-Mivo-Api-Key': MIVO_KEY }, // same owner
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff') // P1.3
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable') // P2.5
    const out = Buffer.from(await res.arrayBuffer())
    expect(out.equals(canonical)).toBe(true) // GET serves the CANONICAL bytes
  })

  it('P2.5: cross-owner GET → 404 (existence not leaked; not 403)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 40, g: 50, b: 60 })
    const form = new FormData()
    form.append('image', new File([bytes], 's.png', { type: 'image/png' }), 's.png')
    const { assetId } = await (await app.request('/api/assets', {
      method: 'POST',
      headers: { 'X-Mivo-Api-Key': MIVO_KEY }, // owner A
      body: form,
    })).json() as { assetId: string }

    // Owner B (a different valid mivo_ key) reads A's assetId → 404.
    const res = await app.request(`/api/assets/${assetId}`, {
      headers: { 'X-Mivo-Api-Key': 'mivo_FAKEKEY_other' },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBeNull()
  })

  it('P2.5: GET without a key → 404 (no ownerFp → no authorization)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 70, g: 80, b: 90 })
    const form = new FormData()
    form.append('image', new File([bytes], 'n.png', { type: 'image/png' }), 'n.png')
    const { assetId } = await (await app.request('/api/assets', {
      method: 'POST',
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
      body: form,
    })).json() as { assetId: string }
    vi.stubEnv('MIVO_PLATFORM_KEY', '') // ensure no env fallback owner
    try {
      const res = await app.request(`/api/assets/${assetId}`)
      expect(res.status).toBe(404)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('valid but unstored hash → 404, no Content-Type', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const res = await app.request(`/api/assets/${'0'.repeat(64)}`, {
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBeNull()
  })

  it('invalid id (non-hex / too short) → 404 (never reaches backend)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const res = await app.request('/api/assets/not-a-hash', {
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
    })
    expect(res.status).toBe(404)
  })

  it('malformed X-Mivo-Api-Key on GET → 400', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const res = await app.request(`/api/assets/${'0'.repeat(64)}`, {
      headers: { 'X-Mivo-Api-Key': 'bogus' },
    })
    expect(res.status).toBe(400)
  })
})

describe('assets route — fs backend (temp dir, real path)', () => {
  it('POST then GET round-trips canonical bytes through the real fs store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-assets-route-'))
    try {
      const app = buildApp(createFsAssetBackend(root))
      const bytes = await realPng({ r: 100, g: 110, b: 120 })
      const canonical = await canonicalOf(bytes, 'png')
      const form = new FormData()
      form.append('image', new File([bytes], 'real.png', { type: 'image/png' }), 'real.png')
      const { assetId } = await (await app.request('/api/assets', {
        method: 'POST',
        headers: { 'X-Mivo-Api-Key': MIVO_KEY },
        body: form,
      })).json() as { assetId: string }
      const res = await app.request(`/api/assets/${assetId}`, {
        headers: { 'X-Mivo-Api-Key': MIVO_KEY },
      })
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).equals(canonical)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// P1-A (third-round root fix): the 4 third-round 200-false-positive samples — each
// passed the OLD magic-byte sniffer as a vetted image (200) but is NOT a real
// decodable image. sharp's full decode rejects them all → 415. Also: a decodable
// image + trailing script is accepted (200) with the trailing payload STRIPPED by
// the canonical re-encode; and an animated GIF preserves its frames.
describe('POST /api/assets — P1-A sharp canonicalization', () => {
  it('JPEG header (SOI+APP0/JFIF) + trailing <script> → 415 (no scan data)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const polyglot = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
      Buffer.from('<script>alert(1)</script>'),
    ])
    const form = new FormData()
    form.append('image', new File([polyglot], 'evil.jpg', { type: 'image/jpeg' }), 'evil.jpg')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
    expect(be._records.size).toBe(0)
    expect(be._bytes.size).toBe(0)
  })

  it('16-byte RIFF/WEBP shell (no VP8 bitstream) → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const shell = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x08, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ')])
    const form = new FormData()
    form.append('image', new File([shell], 'evil.webp', { type: 'image/webp' }), 'evil.webp')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('24-byte residual PNG (sig + partial IHDR, no IDAT) → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const residual = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]),
    ])
    const form = new FormData()
    form.append('image', new File([residual], 'trunc.png', { type: 'image/png' }), 'trunc.png')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('14-byte residual GIF (magic + LSD + trailer, no image data) → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const residual = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
    ])
    const form = new FormData()
    form.append('image', new File([residual], 't.gif', { type: 'image/gif' }), 't.gif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('decodable PNG + trailing <script> → 200; GET serves clean canonical (trailing stripped)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const real = await realPng({ r: 130, g: 140, b: 150 })
    const polyglot = Buffer.concat([real, Buffer.from('<script>alert(1)</script>')])
    const form = new FormData()
    form.append('image', new File([polyglot], 'p.png', { type: 'image/png' }), 'p.png')
    const res = await app.request('/api/assets', { method: 'POST', headers: { 'X-Mivo-Api-Key': MIVO_KEY }, body: form })
    expect(res.status).toBe(200)
    const { assetId } = (await res.json()) as { assetId: string }
    // GET serves the canonical (clean PNG — trailing script stripped by re-encode).
    const get = await app.request(`/api/assets/${assetId}`, {
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
    })
    expect(get.status).toBe(200)
    const served = Buffer.from(await get.arrayBuffer())
    // served bytes are a clean decodable PNG, NOT the polyglot (trailing gone)
    expect(served.equals(polyglot)).toBe(false)
    expect((await sharp(served).metadata()).format).toBe('png')
  })

  it('animated GIF → 200; GET serves canonical with frames preserved (pages > 1)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realAnimatedGif()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.gif', { type: 'image/gif' }), 'a.gif')
    const res = await app.request('/api/assets', { method: 'POST', headers: { 'X-Mivo-Api-Key': MIVO_KEY }, body: form })
    expect(res.status).toBe(200)
    const { assetId } = (await res.json()) as { assetId: string }
    const get = await app.request(`/api/assets/${assetId}`, {
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
    })
    expect(get.status).toBe(200)
    const served = Buffer.from(await get.arrayBuffer())
    // canonical preserves both frames (re-encode did NOT collapse to one)
    expect((await sharp(served, { animated: true }).metadata()).pages).toBe(2)
  })

  it('two differently-compressed PNGs of the SAME pixels → identical canonical → dedup', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    // Same 2×2 red, different PNG compression → different input bytes, same decoded
    // pixels → sharp's default re-encode produces identical canonical → dedup.
    const pngA = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png({ compressionLevel: 9 })
      .toBuffer()
    const pngB = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png({ compressionLevel: 1 })
      .toBuffer()
    expect(pngA.equals(pngB)).toBe(false) // sanity: inputs differ
    const post = (bytes: Buffer) => {
      const form = new FormData()
      form.append('image', new File([bytes], 'x.png', { type: 'image/png' }), 'x.png')
      return app.request('/api/assets', { method: 'POST', body: form })
    }
    const r1 = await (await post(pngA)).json() as { assetId: string; deduped: boolean }
    const r2 = await (await post(pngB)).json() as { assetId: string; deduped: boolean }
    expect(r1.assetId).toBe(r2.assetId) // same canonical → same assetId
    expect(r2.deduped).toBe(true)
    expect(be._bytes.size).toBe(1) // one physical copy
  })

  it('image dimensions over the limit → 413 image_too_large', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    // A real 3×3 PNG with maxDimension=2 → 3 > 2 → too-large.
    const big = await sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    vi.stubEnv('MIVO_ASSET_MAX_DIMENSION', '2')
    try {
      const form = new FormData()
      form.append('image', new File([big], 'big.png', { type: 'image/png' }), 'big.png')
      const res = await app.request('/api/assets', { method: 'POST', body: form })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { code: string; width: number; height: number }
      expect(body.code).toBe('image_too_large')
      expect(body.width).toBe(3)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// P1.3 (route-level): the route uses store.uploadWithQuota (per-owner lock → hash-locked
// admitUpload). Two concurrent NEW uploads that together exceed quota → exactly one 200,
// one 413, final used <= quota.
describe('POST /api/assets — quota atomicity (P1.3 route-level)', () => {
  it('concurrent same-owner NEW uploads → one 200, one 413; final used <= quota', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    // Two DISTINCT real PNGs (different colors → different canonical → both NEW).
    const a = await realPng({ r: 200, g: 10, b: 10 })
    const b = await realPng({ r: 10, g: 200, b: 10 })
    const canonA = await canonicalOf(a, 'png')
    const canonB = await canonicalOf(b, 'png')
    expect(canonA.length).toBe(canonB.length) // both 2×2 png → same canonical length
    const L = canonA.length
    vi.stubEnv('MIVO_ASSET_OWNER_QUOTA_BYTES', String(L)) // one fills exactly, two trip
    try {
      const post = (bytes: Buffer) => {
        const form = new FormData()
        form.append('image', new File([bytes], 'x.png', { type: 'image/png' }), 'x.png')
        return app.request('/api/assets', { method: 'POST', headers: { 'X-Mivo-Api-Key': MIVO_KEY }, body: form })
      }
      const [r1, r2] = await Promise.all([post(a), post(b)])
      expect([r1.status, r2.status].sort()).toEqual([200, 413])
      expect(be._records.size).toBe(1) // exactly one stored
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// P1.5: a dedup uploader is entitled to GET their own upload even though ownerFp
// (first uploader) is someone else and they hold no live reference.
describe('POST/GET /api/assets — dedup uploader entitlement (P1.5)', () => {
  it('A uploads, B uploads same image (dedup), B GET → 200', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = await realPng({ r: 160, g: 161, b: 162 })
    const post = (key: string) => {
      const form = new FormData()
      form.append('image', new File([bytes], 'x.png', { type: 'image/png' }), 'x.png')
      return app.request('/api/assets', { method: 'POST', headers: { 'X-Mivo-Api-Key': key }, body: form })
    }
    const r1 = await post(MIVO_KEY) // owner A — first uploader
    expect(r1.status).toBe(200)
    const r2 = await post('mivo_FAKEKEY_other') // owner B — dedup (same bytes)
    expect(r2.status).toBe(200)
    const { assetId } = (await r2.json()) as { assetId: string }
    // B is registered as a dedup uploader → readForOwner(B) is entitled → 200.
    const get = await app.request(`/api/assets/${assetId}`, {
      headers: { 'X-Mivo-Api-Key': 'mivo_FAKEKEY_other' },
    })
    expect(get.status).toBe(200)
    const canonical = await canonicalOf(bytes, 'png')
    expect(Buffer.from(await get.arrayBuffer()).equals(canonical)).toBe(true)
    // ownerFp is still A (first uploader); B is in the dedicated uploaders structure.
    const rec = be._records.get(assetId)
    expect(rec?.ownerFp).toBe(fp())
    expect(await be.isUploader(assetId, fingerprintOfPlatformKey('mivo_FAKEKEY_other'))).toBe(true)
  })
})
