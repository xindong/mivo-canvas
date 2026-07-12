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
// falls back to env via resolvePlatformCtx (legacy). Owner is resolved via
// resolveAssetOwner (G2.1: strict mode MIVO_SSO_STRICT=1 → SSO actor, 401 on
// missing/wrong gateway proof, NO fingerprint fallback; legacy → mivo-key
// fingerprint → ownerFp, current behavior unchanged).
//
// Path traversal (P2.6): ASSET_ID_RE (lowercase hex64) at the route boundary; the
// store + fs backend re-validate and throw InvalidAssetIdError — a non-hash id
// never reaches fs.
//
// Registered under /api via app.route('/api', createAssetRoutes()) in app.ts.
import { Hono } from 'hono'
import { Buffer } from 'node:buffer'
import { rejectInvalidMivoApiKey } from '../lib/keys'
import { resolveAssetOwner } from '../lib/owner'
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
import { acquireDecodePermit, DecodeBusyError, type DecodePermit } from '../lib/decodeGate'
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

    // R3-F2: resolveAssetOwner (strict proof) before ALL validation (bad-key/body/decode),
    // 对齐 proof-gate 语义——strict + 无 proof → 401 在任何 bad-key/body/decode 前(invalid/missing/known
    // asset 一律 401,无存在性泄漏;返修前 GET bad-key/assetId 校验在 proof 前 → 404 泄漏)。
    const ownerFp = resolveAssetOwner(c)

    // F4: reject malformed X-Mivo-Api-Key at the boundary (no env fallback for bogus headers).
    const badKey = rejectInvalidMivoApiKey(c)
    if (badKey) {
      log(400, 'bad-mivo-key')
      return badKey
    }

    // P1 decode concurrency gate: acquire a global sharp-decode permit BEFORE reading
    // the body. A sharp decode expands a small compressed upload to a huge uncompressed
    // buffer; N concurrent decodes can exhaust process RSS. The permit bounds the whole
    // body-read + decode pipeline (released in finally). A bounded wait queue sheds
    // overflow with 429 (Retry-After) so a slow decode can't pile up an unbounded
    // queue of bodies each holding memory. Auth runs first so an unauthenticated flood
    // never consumes a permit.
    let permit: DecodePermit
    try {
      permit = await acquireDecodePermit()
    } catch (error) {
      if (error instanceof DecodeBusyError) {
        log(429, 'decode-busy')
        c.header('Retry-After', '1')
        return c.json(
          { error: 'asset decode concurrency limit reached; retry later', code: 'decode_busy' },
          429,
        )
      }
      log(500, 'decode-gate-error')
      return c.json({ error: 'unable to acquire decode permit' }, 500)
    }

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
        // width/height are present when our own maxDimension/maxPixels guard trips
        // (we read metadata first); absent when sharp's pixel-limit guard throws
        // before metadata returns (a pixel bomb above sharp's internal limit).
        const body: Record<string, unknown> = {
          error: 'image dimensions or pixel count exceeds the limit',
          code: 'image_too_large',
        }
        if (canon.width !== undefined && canon.height !== undefined) {
          body.width = canon.width
          body.height = canon.height
        }
        return c.json(body, 413)
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
    } finally {
      permit.release()
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

    // R3-F2: resolveAssetOwner (strict proof) before ALL validation (bad-key/assetId shape).
    // strict + 无 proof → 401 在 bad-key/assetId 校验前(invalid/missing/known asset 一律 401,无存在性
    // 泄漏)。返修前 GET 把 ASSET_ID_RE/badKey 校验放在 resolveAssetOwner 前 → strict+无 proof 下
    // not-a-hash=404、合法形状 missing=401(不一致,泄漏 assetId 形状)。
    const ownerFp = resolveAssetOwner(c)

    const badKey = rejectInvalidMivoApiKey(c)
    if (badKey) {
      log(400, 'bad-mimo-key')
      return badKey
    }
    if (!ASSET_ID_RE.test(assetId)) {
      log(404, 'invalid-id')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    // P2.5: owner-scoped read — must be uploader or hold a live reference.
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

  // ── G1-a P1-2 seam:asset attach/detach HTTP 入口(节点生命周期调用方属 G1-c,本轮冻结 wire)──
  // assetStore.attach/detach 已实现(内容寻址 + refcount = references.length + owner-checked),
  // 但此前无 HTTP 入口 → refcount 恒 0。本路由暴露 attach/detach:ownerFp 服务端从 key 派生
  // (client 不可指定,防越权 attach 他人 asset);nodeId 在 body。返回 wire AttachAssetResult/DetachAssetResult。
  // 语义:attach 0→1 幂等(already-attached no-op);detach 1→0 幂等;跨 owner detach → 403(decidable,不静默)。
  // 节点 mutation 调用方(createImageNode/deleteNode)属 G1-c(N2-0),本轮只冻结 route + 不接调用方。
  //
  // ── EXPOSURE TRACE(lead 2026-07-12 批准:owner-gate 延 G2.2,需 documented exposure)──
  // attach 路由 **不 owner-gate**(assetStore.attach 不 owner-check;AttachResult 无 owner-mismatch kind)。
  // 含义:任何持有 assetId(sha256 hex64)的请求方可 attach 自己的 ref → ref 即 live reference → 可 GET 该
  // asset。这是内容寻址 ref 模型的既有 backend 设计(attachRef 一直如此),非 G1-a 新引入。生产暴露面:
  //   - 知 hash 即可 attach+读(理论上绕过 T1.4 share-grant 的显式授权流)。
  // 缓解(G1-a 阶段):assetId 仅返给 uploader(POST /api/assets 响应);不列举、不猜测(sha256 不可枚举)。
  // 节点生命周期 attach 同 owner(用户上传 + attach 自己画布的节点),cross-owner attach 生产不发生。
  // 待办(G2.2):route 层加 `record.ownerFp === attacher` 检查(service 层暴露 isUploader),或并入 T1.4
  // share-grant 设计统一授权。在此之前的暴露:attach 不阻止 cross-owner(知 hash 即可),detattach 已 owner-gate。
  const ATTACH_BODY_MAX = 8192 // nodeId 小体量;8KB 上限防滥用

  app.post('/assets/:id/attach', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const assetId = c.req.param('id')
    const log = (status: number, note?: string): void => {
      logRequest({ method: 'POST', path: `/api/assets/${shortHash(assetId)}/attach`, requestId, status, latencyMs: Date.now() - t0, note })
    }
    // R3-F2: resolveAssetOwner (strict proof) before ALL validation (bad-key/assetId shape),对齐 POST/GET
    // proof-gate 语义——strict + 无 proof → 401 在 bad-key/assetId 校验前(无存在性泄漏)。合并时 G1-a attach
    // 漏同步 G2.1(7743a1d)前置语义,沿用裸 fingerprintOfPlatformKey → strict 下绕过 proof-gate(安全回归);
    // 改用 resolveAssetOwner 对齐 POST/GET:legacy(non-strict)下 ≡ fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey),零变化。
    const ownerFp = resolveAssetOwner(c)
    const badKey = rejectInvalidMivoApiKey(c)
    if (badKey) {
      log(400, 'bad-mivo-key')
      return badKey
    }
    if (!ASSET_ID_RE.test(assetId)) {
      log(404, 'invalid-id')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    let body: { nodeId?: string }
    try {
      body = await readJsonBody<{ nodeId?: string }>(c, ATTACH_BODY_MAX)
    } catch {
      log(400, 'bad-body')
      return c.json({ error: 'invalid body; expected { nodeId: string }' }, 400)
    }
    const nodeId = body?.nodeId?.trim()
    if (!nodeId) {
      log(400, 'missing-node-id')
      return c.json({ error: 'nodeId is required' }, 400)
    }
    // service 层 attach 直接返 AttachResult union(attached/already-attached/missing);ownerFp 服务端派生。
    const result = await store.attach(assetId, nodeId, ownerFp)
    switch (result.kind) {
      case 'attached':
        log(200, 'attached')
        return c.json({ kind: 'attached' } as { kind: 'attached' }, 200)
      case 'already-attached':
        log(200, 'already-attached')
        return c.json({ kind: 'already-attached' } as { kind: 'already-attached' }, 200)
      case 'missing':
        // 无 record/bytes — attach 拒(decidable,不静默)。404(executor 映射 rejected:不能 attach 到不存在的 asset)。
        log(404, 'missing')
        return c.json({ kind: 'missing' } satisfies { kind: 'missing' }, 404)
    }
  })

  app.post('/assets/:id/detach', async (c) => {
    const requestId = newRequestId()
    c.header('X-Request-Id', requestId)
    const t0 = Date.now()
    const assetId = c.req.param('id')
    const log = (status: number, note?: string): void => {
      logRequest({ method: 'POST', path: `/api/assets/${shortHash(assetId)}/detach`, requestId, status, latencyMs: Date.now() - t0, note })
    }
    // R3-F2: resolveAssetOwner (strict proof) before ALL validation (bad-key/assetId shape),对齐 POST/GET
    // proof-gate 语义——strict + 无 proof → 401 在 bad-key/assetId 校验前(无存在性泄漏)。合并时 G1-a detach
    // 漏同步 G2.1(7743a1d)前置语义,沿用裸 fingerprintOfPlatformKey → strict 下绕过 proof-gate(安全回归);
    // 改用 resolveAssetOwner 对齐 POST/GET:legacy(non-strict)下 ≡ fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey),零变化。
    const ownerFp = resolveAssetOwner(c)
    const badKey = rejectInvalidMivoApiKey(c)
    if (badKey) {
      log(400, 'bad-mivo-key')
      return badKey
    }
    if (!ASSET_ID_RE.test(assetId)) {
      log(404, 'invalid-id')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    let body: { nodeId?: string }
    try {
      body = await readJsonBody<{ nodeId?: string }>(c, ATTACH_BODY_MAX)
    } catch {
      log(400, 'bad-body')
      return c.json({ error: 'invalid body; expected { nodeId: string }' }, 400)
    }
    const nodeId = body?.nodeId?.trim()
    if (!nodeId) {
      log(400, 'missing-node-id')
      return c.json({ error: 'nodeId is required' }, 400)
    }
    // service 层 detach 直接返 DetachResult union(detached/already-detached/missing/owner-mismatch)。
    const result = await store.detach(assetId, nodeId, ownerFp)
    switch (result.kind) {
      case 'detached':
        log(200, 'detached')
        return c.json({ kind: 'detached' } as { kind: 'detached' }, 200)
      case 'already-detached':
        log(200, 'already-detached')
        return c.json({ kind: 'already-detached' } as { kind: 'already-detached' }, 200)
      case 'missing':
        // 无 record → 404(executor 幂等 success:detach intent 已满足,asset/ref 已不在)。
        log(404, 'missing')
        return c.json({ kind: 'missing' } satisfies { kind: 'missing' }, 404)
      case 'owner-mismatch':
        // 跨 owner 非法 detach → 403(decidable,不静默;executor 映射 rejected:绝不静默成功他人 asset 的 detach)。
        log(403, 'owner-mismatch')
        return c.json({ kind: 'owner-mismatch' } satisfies { kind: 'owner-mismatch' }, 403)
    }
  })

  return app
}

const createFsBackendFromEnv = () => createFsAssetBackend(resolveAssetStoreDir())

// re-exported for test convenience (mounting pattern mirroring local-assets)
export type { AssetStore, AssetStoreBackend }
