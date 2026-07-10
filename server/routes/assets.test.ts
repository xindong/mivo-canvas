import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// Minimal structurally-valid PNG: 8-byte sig + IHDR chunk (length=13 + 'IHDR' +
// width=1 + height=1 + bitdepth/colortype/compression/filter/interlace + dummy CRC).
// The route sniffer validates sig + IHDR + nonzero dimensions (P1.3); CRC is not
// verified (documented coverage boundary). The marker varies the trailing bytes so
// each fixture produces a distinct sha256 content hash.
const pngBytes = (marker: string): Buffer => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.from([
    0x00, 0x00, 0x00, 0x0d, // IHDR length = 13
    0x49, 0x48, 0x44, 0x52, // 'IHDR'
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x02, 0x00, 0x00, 0x00, // bitdepth 8, colortype 2 (RGB), comp/filter/interlace 0
    0x00, 0x00, 0x00, 0x00, // CRC (dummy — sniffer doesn't verify)
  ])
  return Buffer.concat([sig, ihdr, Buffer.from(marker, 'utf8')])
}

// AVIF magic: ISOBMFF 'ftyp' box with major brand 'avif' (bytes 4..8 = 'ftyp',
// bytes 8..12 = 'avif'). bytes 0..3 are the box size (any value).
const avifBytes = (marker: string): Buffer =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from('ftypavif', 'ascii'),
    Buffer.from(marker, 'utf8'),
  ])

// SVG / HTML / PDF — executable/navigable content that must be REJECTED (P1.3).
const svgBytes = Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
const htmlBytes = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')
const pdfBytes = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj')

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

// P2.8: fixture uses the FAKEKEY marker (allowlisted in .gitleaks.toml) — NOT a
// blanket mivo_ exemption. Real key shapes are still scanned.
const MIVO_KEY = 'mivo_FAKEKEY_test'
const fp = () => fingerprintOfPlatformKey(MIVO_KEY)

describe('POST /api/assets', () => {
  it('multipart upload → 200 {assetId, mimeType, ...}; assetId = sha256 hex64; refcount=0 (no attach)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = pngBytes('hello')
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')

    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = (await res.json()) as { assetId: string; mimeType: string; originalName: string; sizeBytes: number; refcount: number; deduped: boolean }
    expect(body.assetId).toBe(sha256Hex(bytes))
    expect(body.assetId).toHaveLength(64)
    expect(body.mimeType).toBe('image/png')
    expect(body.originalName).toBe('a.png')
    expect(body.sizeBytes).toBe(bytes.length)
    expect(body.refcount).toBe(0) // upload does NOT attach (P1.2)
    expect(body.deduped).toBe(false)
  })

  it('dedup: same bytes twice → same assetId, deduped=true on 2nd, one copy; refcount stays 0', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = pngBytes('dedup')
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
    expect(r2.refcount).toBe(0) // no drift — upload doesn't attach
    expect(r2.deduped).toBe(true)
    expect(be._bytes.size).toBe(1)
  })

  it('JSON base64 upload → 200; sniffed type honored (providedType ignored for the gate)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = pngBytes('json')
    // Lie about the type (text/html) — the server must sniff png and store image/png.
    const res = await app.request('/api/assets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: bytes.toString('base64'), name: 'json.png', type: 'text/html' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assetId: string; originalName: string; mimeType: string }
    expect(body.assetId).toBe(sha256Hex(bytes))
    expect(body.originalName).toBe('json.png')
    expect(body.mimeType).toBe('image/png') // sniffed, not the lied text/html
  })

  it('P1.3: AVIF (allowlisted) accepted via magic-byte sniff', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = avifBytes('avif-marker')
    const form = new FormData()
    form.append('image', new File([bytes], 'a.avif', { type: 'image/avif' }), 'a.avif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/avif')
  })

  it('P1.3: SVG (script-carrying) rejected → 415 mime_rejected', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([svgBytes], 'evil.svg', { type: 'image/svg+xml' }), 'evil.svg')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('mime_rejected')
    expect(be._records.size).toBe(0) // nothing stored
    expect(be._bytes.size).toBe(0)
  })

  it('P1.3: HTML rejected → 415 (no same-origin executable inline response)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([htmlBytes], 'evil.html', { type: 'text/html' }), 'evil.html')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('P1.3: PDF rejected → 415', async () => {
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
    const bytes = pngBytes('owner')
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
    await app.request('/api/assets', {
      method: 'POST',
      headers: { 'X-Mivo-Api-Key': MIVO_KEY },
      body: form,
    })
    const rec = be._records.get(sha256Hex(bytes))
    expect(rec?.ownerFp).toBe(fp())
    expect(rec?.references).toEqual([]) // no attach in T1.5
  })

  it('malformed X-Mivo-Api-Key → 400 (no env fallback for bogus headers)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([pngBytes('badkey')], 'a.png', { type: 'image/png' }), 'a.png')
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
    vi.stubEnv('MIVO_ASSET_OWNER_QUOTA_BYTES', '5') // 5 bytes — any png exceeds it
    try {
      const form = new FormData()
      form.append('image', new File([pngBytes('q')], 'q.png', { type: 'image/png' }), 'q.png')
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
  it('uploader GET → 200 + Content-Type + nosniff + Cache-Control: private', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = pngBytes('serve')
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
    expect(out.equals(bytes)).toBe(true)
  })

  it('P2.5: cross-owner GET → 404 (existence not leaked; not 403)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = pngBytes('shared')
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
    const bytes = pngBytes('nokey')
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
  it('POST then GET round-trips bytes through the real fs store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-assets-route-'))
    try {
      const app = buildApp(createFsAssetBackend(root))
      const bytes = pngBytes('real-fs')
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
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// P1.2: strict magic + structural validation. A polyglot whose magic is grafted onto
// non-image content is rejected at the first structural field that doesn't parse; a
// truncated header (too few bytes for the required leading structure) is rejected.
describe('POST /api/assets — MIME structural validation (P1.2)', () => {
  it('GIF polyglot "GIF89a<script>…" → 415 (strict magic + LSD + block introducer)', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const polyglot = Buffer.from('GIF89a<script>alert(1)</script>')
    const form = new FormData()
    form.append('image', new File([polyglot], 'evil.gif', { type: 'image/gif' }), 'evil.gif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('mime_rejected')
    expect(be._records.size).toBe(0)
    expect(be._bytes.size).toBe(0)
  })

  it('truncated PNG (sig only, no IHDR) → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const form = new FormData()
    form.append('image', new File([truncated], 'trunc.png', { type: 'image/png' }), 'trunc.png')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('truncated GIF (magic only, < 13 bytes for the LSD) → 415', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const form = new FormData()
    form.append('image', new File([Buffer.from('GIF89a')], 't.gif', { type: 'image/gif' }), 't.gif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('real JPEG (SOI + APP0 marker) accepted → 200 image/jpeg', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const form = new FormData()
    form.append('image', new File([jpeg], 'a.jpg', { type: 'image/jpeg' }), 'a.jpg')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/jpeg')
  })

  it('real WebP (RIFF + WEBP + VP8) accepted → 200 image/webp', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x08, 0x00, 0x00, 0x00]), // riff size = 8 (LE)
      Buffer.from('WEBPVP8 '),
    ])
    const form = new FormData()
    form.append('image', new File([webp], 'a.webp', { type: 'image/webp' }), 'a.webp')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/webp')
  })

  it('real GIF89a (header + LSD + trailer) accepted → 200 image/gif', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const gif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // 'GIF89a'
      0x01, 0x00, 0x01, 0x00, // width=1, height=1 (LE)
      0x00, 0x00, 0x00, // packed (no GCT) + bg + aspect
      0x3b, // trailer
    ])
    const form = new FormData()
    form.append('image', new File([gif], 'a.gif', { type: 'image/gif' }), 'a.gif')
    const res = await app.request('/api/assets', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mimeType: string }
    expect(body.mimeType).toBe('image/gif')
  })
})

// P1.3: the route uses store.uploadWithQuota (per-owner lock). Two concurrent NEW
// uploads that together exceed quota → exactly one 200, one 413, final used <= quota.
describe('POST /api/assets — quota atomicity (P1.3 route-level)', () => {
  it('concurrent same-owner NEW uploads → one 200, one 413; final used <= quota', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const a = pngBytes('aaaaa')
    const b = pngBytes('bbbbb')
    expect(a.length).toBe(b.length)
    vi.stubEnv('MIVO_ASSET_OWNER_QUOTA_BYTES', String(a.length + 2)) // one fits, two trip
    try {
      const post = (bytes: Buffer) => {
        const form = new FormData()
        form.append('image', new File([bytes], 'x.png', { type: 'image/png' }), 'x.png')
        return app.request('/api/assets', { method: 'POST', headers: { 'X-Mivo-Api-Key': MIVO_KEY }, body: form })
      }
      const [r1, r2] = await Promise.all([post(a), post(b)])
      expect([r1.status, r2.status].sort()).toEqual([200, 413])
      // Exactly one record stored, its size within quota.
      expect(be._records.size).toBe(1)
      const stored = [...be._records.values()][0]
      expect(stored.sizeBytes).toBeLessThanOrEqual(a.length + 2)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// P1.5: a dedup uploader is entitled to GET their own upload even though ownerFp
// (first uploader) is someone else and they hold no live reference.
describe('POST/GET /api/assets — dedup uploader entitlement (P1.5)', () => {
  it('A uploads, B uploads same bytes (dedup), B GET → 200', async () => {
    const be = createMemoryAssetBackend()
    const app = buildApp(be)
    const bytes = pngBytes('entitlement')
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
    expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true)
    // ownerFp is still A (first uploader); B is in the uploaders set.
    const rec = be._records.get(assetId)
    expect(rec?.ownerFp).toBe(fp())
    expect(rec?.uploaders).toContain(fingerprintOfPlatformKey('mivo_FAKEKEY_other'))
  })
})
