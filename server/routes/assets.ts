// server/routes/assets.ts
// T1.5 content-addressed asset routes.
//   POST /api/assets        — upload bytes (multipart 'image' file OR JSON {image: b64})
//                            → 200 {assetId, mimeType, originalName, sizeBytes, refcount, deduped}
//                            Dedup: same content hash → same assetId, bytes reused.
//   GET  /api/assets/:id    — serve content-addressed bytes by sha256 id.
//
// Mount gate (P1.4): the whole sub-app is mounted in app.ts ONLY when
// MIVO_ENABLE_ASSET_SERVICE=1 (default off). Flag off → /api/assets 404 (no route).
//
// MIME safety (P1.3): the server sniffs magic bytes and rejects anything outside a
// static image allowlist (png/jpeg/webp/gif/avif). providedType is NOT trusted for
// the allowlist decision (an attacker can't sneak text/html or image/svg+xml past
// the gate by lying in the Content-Type). HTML/SVG/PDF/scripts are rejected. Every
// GET carries X-Content-Type-Options: nosniff so a sniffed-but-rejected type can
// never be re-interpreted inline by the browser.
//
// Authorization (P2.5): GET is owner-scoped — the requester must be the uploader OR
// hold a live reference to the asset. Cross-owner reads return 404 (not 403, so
// existence is never leaked). Cross-owner STORAGE dedup still happens (same hash =
// one physical copy); cross-owner READ sharing is a T1.4 share-grant concern.
// Cache-Control: private (owner-scoped, not a shared proxy cache). Request logs
// truncate the hash to 12 hex (never log a full asset id).
//
// Auth (对齐现有模式): rejectInvalidMivoApiKey rejects a present-but-malformed
// X-Mivo-Api-Key (400, no env fallback for bogus headers). A missing/blank key
// falls back to env via resolvePlatformCtx. The resolved platform key is
// fingerprinted (fingerprintOfPlatformKey, FX-2) → ownerFp.
//
// Path traversal (P2.6): ASSET_ID_RE (lowercase hex64) at the route boundary; the
// store + fs backend re-validate and throw InvalidAssetIdError — a non-hash id
// never reaches fs.
//
// Registered under /api via app.route('/api', createAssetRoutes()) in app.ts.
import { Hono } from 'hono'
import { Buffer } from 'node:buffer'
import {
  rejectInvalidMivoApiKey,
  resolvePlatformCtx,
  fingerprintOfPlatformKey,
} from '../lib/keys'
import {
  parseMultipartBody,
  readJsonBody,
  firstMultipartField,
  multipartFiles,
  logRequest,
  newRequestId,
} from '../lib/request'
import { getEnvConfig } from '../lib/config'
import { RequestBodyTooLargeError } from '../lib/upstream'
import { jsonResponse, plainTextNoContentType } from '../lib/response'
import {
  createAssetStore,
  resolveAssetStoreDir,
  createFsAssetBackend,
  InvalidAssetIdError,
  type AssetStore,
  type AssetStoreBackend,
} from '../lib/assetStore'
import type { App, AppEnv } from '../lib/types'

// sha256 hex (64). Validated on GET so a non-hash :id never reaches the store /
// backend (P2.6 — defense in depth: the store re-validates too).
const ASSET_ID_RE = /^[0-9a-f]{64}$/

// P1.3: server-side MIME allowlist — only vetted static media. SVG (which can
// carry scripts), HTML, PDF, and any executable/navigable content are NOT here.
const MIME_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

/**
 * Sniff magic bytes for the allowlisted image types with STRUCTURAL validation
 * (P1.3 — not just short magic). Returns the sniffed MIME or null if the bytes
 * don't match a vetted static-image signature (→ rejected).
 *
 * Coverage boundary: this validates the format HEADER / leading structure per spec
 * (magic + chunk/box/LSD integrity + nonzero dimensions). It does NOT fully decode
 * the image (no PNG CRC, no JPEG huffman/scan validation, no ISOBMFF box-graph walk,
 * no GIF frame/LZW validation). The guarantee is: a polyglot whose magic is grafted
 * onto non-image content (e.g. 'GIF89a<script>…') is rejected at the first structural
 * field that doesn't parse, and a truncated header (too few bytes to hold the
 * required leading structure) is rejected. A byte-perfect-but-corrupt payload that
 * still parses its header would be accepted at this gate and render broken client-
 * side — the nosniff + Content-Type gate keeps it from being re-interpreted as
 * anything executable.
 *
 * This sniffer is deliberately NARROWER than server/lib/assets.ts#mimeForFile
 * (which also handles svg for the host-file local-assets route) — the asset store
 * must reject svg, not serve it.
 */
const sniffAssetMime = (bytes: Buffer): string | null => {
  // PNG: 8-byte sig + IHDR chunk (length=13 + 'IHDR' + width + height + …).
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && // width
    bytes.readUInt32BE(20) > 0 // height
  ) {
    return 'image/png'
  }
  // JPEG: SOI (FF D8) + a marker (FF X). Require a real marker after SOI — RST
  // (D0-D7) / SOI (D8) / EOI (D9) are not valid first markers. A 3-byte truncated
  // JPEG (FF D8 FF only) is rejected by the length>=4 guard.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const marker = bytes[3]
    if (marker >= 0xc0 && marker <= 0xfe && !(marker >= 0xd0 && marker <= 0xd9)) {
      return 'image/jpeg'
    }
  }
  // WebP: RIFF + size + WEBP + VP8/VP8L/VP8X chunk fourcc. Validate the RIFF size
  // field isn't truncated (size+8 <= bytes.length).
  if (
    bytes.length >= 16 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const fourcc = bytes.subarray(12, 16).toString('ascii')
    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'VP8X') {
      const riffSize = bytes.readUInt32LE(4)
      if (riffSize + 8 <= bytes.length) return 'image/webp'
    }
  }
  // GIF: strict GIF87a/GIF89a magic + Logical Screen Descriptor + first block
  // introducer. 'GIF89a<script>…' polyglots fail: after the 6-byte magic the LSD
  // parses, but the byte where the first block (image 0x2c / extension 0x21 /
  // trailer 0x3b) is expected is non-image content → reject.
  if (bytes.length >= 13) {
    const magic = bytes.subarray(0, 6).toString('ascii')
    if (magic === 'GIF87a' || magic === 'GIF89a') {
      const width = bytes.readUInt16LE(6)
      const height = bytes.readUInt16LE(8)
      if (width > 0 && height > 0) {
        const packed = bytes[10]
        const gctFlag = (packed & 0x80) >>> 7
        let pos = 13 // past header(6) + LSD(7)
        if (gctFlag) pos += 3 * (1 << ((packed & 0x07) + 1)) // Global Color Table
        if (pos < bytes.length) {
          const introducer = bytes[pos]
          if (introducer === 0x2c || introducer === 0x21 || introducer === 0x3b) {
            return 'image/gif'
          }
        }
      }
    }
  }
  // AVIF: ISOBMFF 'ftyp' box with major brand avif/avis. Validate the box size
  // field (bytes 0..4 BE): a ftyp box is >= 16 bytes (size+type+brand+minor) and
  // must not be truncated (size <= bytes.length).
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString('ascii') === 'ftyp' &&
    ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'))
  ) {
    const boxSize = bytes.readUInt32BE(0)
    if (boxSize >= 16 && boxSize <= bytes.length) return 'image/avif'
  }
  return null
}

// Hash truncation for request logs (P2.5 — never log a full asset id).
const shortHash = (assetId: string): string => assetId.slice(0, 12)

export type AssetRouteOptions = {
  /**
   * Injected store (tests). When omitted, a default fs-backed store is built
   * from MIVO_ASSET_STORE_DIR (default ~/.mivo-canvas/assets — outside the repo).
   */
  store?: AssetStore
  /** Injected backend (mutually exclusive with `store`; convenience for tests). */
  backend?: AssetStoreBackend
}

export const createAssetRoutes = (options: AssetRouteOptions = {}): App => {
  const app: App = new Hono<AppEnv>()
  const store =
    options.store ?? (options.backend ? createAssetStore(options.backend) : createAssetStore(createFsBackendFromEnv()))

  // POST /api/assets — multipart/form-data ('image' file) OR JSON {image: base64}.
  app.post('/assets', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const log = (status: number, note?: string): void => {
      logRequest({ method: 'POST', path: '/api/assets', requestId, status, latencyMs: Date.now() - t0, note })
    }

    // F4: reject malformed X-Mivo-Api-Key at the boundary (no env fallback for bogus headers).
    const badKey = rejectInvalidMivoApiKey(c)
    if (badKey) {
      log(400, 'bad-mivo-key')
      return badKey
    }
    const ownerFp = fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)

    try {
      let bytes: Buffer
      let originalName: string

      const contentType = c.req.header('content-type') || ''
      if (contentType.includes('multipart/form-data')) {
        const { fields, files } = await parseMultipartBody(c)
        const file = multipartFiles(files, 'image')[0] ?? multipartFiles(files, 'file')[0]
        if (!file) {
          log(400, 'no-image-field')
          return c.json({ error: 'image field is required' }, 400)
        }
        bytes = Buffer.from(await file.arrayBuffer())
        originalName = firstMultipartField(fields, 'name') || file.name || 'asset'
      } else {
        const body = await readJsonBody<{ image?: string; name?: string }>(
          c,
          getEnvConfig().imageRequestMaxBytes,
        )
        if (!body.image) {
          log(400, 'no-image-field')
          return c.json({ error: 'image field is required' }, 400)
        }
        bytes = Buffer.from(body.image, 'base64')
        originalName = body.name || 'asset'
      }

      if (!bytes.length) {
        log(400, 'empty-bytes')
        return c.json({ error: 'image is empty' }, 400)
      }

      // P1.3: sniff magic bytes; reject anything outside the static-image allowlist.
      // providedType is intentionally NOT trusted for this decision. sniffAssetMime
      // returns only vetted image types (or null); MIME_ALLOWLIST is the explicit gate
      // (defense in depth — a future sniffer change can't sneak a type past it).
      const sniffed = sniffAssetMime(bytes)
      if (!sniffed || !MIME_ALLOWLIST.has(sniffed)) {
        log(415, 'mime-rejected')
        return c.json({ error: 'unsupported media type: only static images (png/jpeg/webp/gif/avif) are accepted', code: 'mime_rejected' }, 415)
      }

      // P1.3: atomic quota-reserved upload — per-owner lock serializes the quota
      // check + upsert so two concurrent uploads from the same owner can't both pass
      // the gate. Dedup (existing record) charges 0 new bytes → never trips quota.
      const quotaBytes = getEnvConfig().assetOwnerQuotaBytes
      const outcome = await store.uploadWithQuota(bytes, sniffed, originalName, ownerFp, quotaBytes)
      if (outcome.kind === 'quota-exceeded') {
        log(413, 'quota-exceeded')
        return c.json(
          { error: 'per-owner asset quota exceeded', code: 'quota_exceeded', quota: outcome.quota, used: outcome.used, size: outcome.size },
          413,
        )
      }
      const result = outcome.result
      log(200, result.deduped ? `dedup ${shortHash(result.assetId)}` : `new ${shortHash(result.assetId)}`)
      return jsonResponse(
        {
          assetId: result.assetId,
          mimeType: result.mimeType,
          originalName: result.originalName,
          sizeBytes: result.sizeBytes,
          refcount: result.refcount,
          deduped: result.deduped,
        },
        200,
      )
    } catch (error) {
      if (error instanceof InvalidAssetIdError) {
        log(404, 'invalid-id')
        return plainTextNoContentType(c, 'Asset not found', 404)
      }
      const status = error instanceof RequestBodyTooLargeError ? 413 : 500
      log(status, error instanceof RequestBodyTooLargeError ? 'too-large' : 'error')
      return c.json({ error: error instanceof Error ? error.message : 'Unable to store asset' }, status)
    }
  })

  // GET /api/assets/:id — owner-scoped content-addressed serve (P2.5).
  app.get('/assets/:id', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const assetId = c.req.param('id')
    const log = (status: number, note?: string): void => {
      // P2.5: log the path with a TRUNCATED hash (never the full asset id).
      logRequest({ method: 'GET', path: `/api/assets/${shortHash(assetId)}`, requestId, status, latencyMs: Date.now() - t0, note })
    }

    const badKey = rejectInvalidMivoApiKey(c)
    if (badKey) {
      log(400, 'bad-mivo-key')
      return badKey
    }
    if (!ASSET_ID_RE.test(assetId)) {
      log(404, 'invalid-id')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    // P2.5: owner-scoped read — must be uploader or hold a live reference.
    const ownerFp = fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)
    const hit = await store.readForOwner(assetId, ownerFp)
    if (!hit) {
      log(404, 'missing-or-forbidden')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    // P1.3: nosniff on every GET so a stored type can never be re-interpreted inline.
    c.header('Content-Type', hit.mimeType)
    c.header('X-Content-Type-Options', 'nosniff')
    // P2.5: private (owner-scoped) — never cache on a shared proxy.
    c.header('Cache-Control', 'private, max-age=31536000, immutable')
    log(200, 'ok')
    return c.body(hit.bytes as never)
  })

  return app
}

const createFsBackendFromEnv = () => createFsAssetBackend(resolveAssetStoreDir())

// re-exported for test convenience (mounting pattern mirroring local-assets)
export type { AssetStore, AssetStoreBackend }
