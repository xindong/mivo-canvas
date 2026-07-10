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
import { canonicalizeImage } from '../lib/canonicalize'
import type { App, AppEnv } from '../lib/types'

// sha256 hex (64). Validated on GET so a non-hash :id never reaches the store /
// backend (P2.6 — defense in depth: the store re-validates too).
const ASSET_ID_RE = /^[0-9a-f]{64}$/

// P1-A (third-round root fix): the magic-byte sniffer was replaced by a full decode
// + canonical re-encode via sharp (server/lib/canonicalize.ts). The static-image
// allowlist (png/jpeg/webp/gif/avif) is enforced by sharp's decoder — a format
// outside it fails to decode → 415. See canonicalize.ts for the full rationale
// (polyglot/truncated/trailing-payload rejection, decode-bomb guards, animation
// preservation). providedType is NOT trusted (an attacker can't lie via Content-Type).

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

      // P1-A (third-round root fix): full decode + canonical re-encode via sharp.
      // The uploaded bytes are decoded; only a real image in the static-image
      // allowlist (png/jpeg/webp/gif/avif) is accepted, and the STORED bytes are
      // sharp's canonical re-encode (so assetId = sha256(canonical)). Polyglots /
      // truncated headers / trailing payloads either fail to decode (→ 415) or are
      // stripped by the re-encode. Decode-bomb guards (max dimension / max pixels)
      // → 413 image_too_large. providedType is NOT trusted.
      const limits = {
        maxDimension: getEnvConfig().assetMaxDimension,
        maxPixels: getEnvConfig().assetMaxPixels,
      }
      const canon = await canonicalizeImage(bytes, limits)
      if (canon.kind === 'unsupported') {
        log(415, 'mime-rejected')
        return c.json(
          { error: 'unsupported media type: only static images (png/jpeg/webp/gif/avif) are accepted', code: 'mime_rejected' },
          415,
        )
      }
      if (canon.kind === 'too-large') {
        log(413, 'image-too-large')
        return c.json(
          { error: 'image dimensions or pixel count exceeds the limit', code: 'image_too_large', width: canon.width, height: canon.height },
          413,
        )
      }

      // P2-C: atomic quota-reserved upload of the CANONICAL bytes — per-owner lock
      // serializes the quota check, then a single hash-locked admission primitive
      // (dedup → register uploader no-charge; NEW → quota gate before write). Dedup
      // (existing record) charges 0 new bytes → never trips quota.
      const quotaBytes = getEnvConfig().assetOwnerQuotaBytes
      const outcome = await store.uploadWithQuota(canon.canonicalBytes, canon.mimeType, originalName, ownerFp, quotaBytes)
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
