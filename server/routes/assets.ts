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
import { resolveCanvasAccess, actorHasCanvasAccess } from '../lib/projectAuthz'
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
import type { PersistBackend } from '../persist/backend'
import type { PermissionBackend } from '../lib/permissions'
import type { App, AppEnv } from '../lib/types'
import type { ArchivedBody } from '../../shared/persist-contract.ts'

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
  /**
   * G2.2(decision 1/2):persist backend for canvas/node authoritative lookup——attach gate ①
   * 验 node 属目标 canvas(不信裸 nodeId)+ detach 验引用画布 edit 权。required(attach/detach authz 依赖)。
   */
  persist: PersistBackend
  /**
   * G2.2(decision 1/2):permission backend for canvas edit/view authz(member role + share-link resolution)。
   * required(attach gate ① write + gate ② transitive view + detach edit authz 依赖)。
   */
  permissions: PermissionBackend
}

export const createAssetRoutes = (options: AssetRouteOptions): App => {
  const app: App = new Hono<AppEnv>()
  const store =
    options.store ?? (options.backend ? createAssetStore(options.backend) : createAssetStore(createFsBackendFromEnv()))
  const persist = options.persist
  const permissions = options.permissions

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
    // G2.2/P1-1:read entitlement = uploader OR 己方 live ref OR 对任一引用画布有 view(read)权
    //   (remaining-tasks-cutover-plan.md:97 "资产随画布可见")。resolveCanvasAccess 处理 member + share-token
    //   两路:owner/editor/viewer member + share-view/share-edit 均可 read 引用画布的 asset。uploader/own-ref
    //   保留(own upload 即使无引用画布仍可读)。missing/forbidden 一律 404(无存在性泄漏,与 P2.5 一致)。
    const record = await store.getRecord(assetId)
    if (!record) {
      log(404, 'missing-or-forbidden')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    let canRead = await store.isUploader(assetId, ownerFp) || record.references.some((r) => r.ownerFp === ownerFp)
    if (!canRead) {
      for (const r of record.references) {
        if (!r.canvasId) continue
        const access = await resolveCanvasAccess(c, persist, permissions, r.canvasId, 'read')
        if (access.ok) { canRead = true; break }
      }
    }
    if (!canRead) {
      log(404, 'missing-or-forbidden')
      return plainTextNoContentType(c, 'Asset not found', 404)
    }
    // read entitlement 通过 → 取 bytes(read 无 authz,仅 bytes + size 守卫;entitlement 已在上方判过)。
    const hit = await store.read(assetId)
    if (!hit) {
      log(404, 'missing-or-corrupt')
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

  // ── G2.2(decision 1/2):asset attach/detach canvas-authz 双门谓词——堵"知 hash 即可跨用户 attach"安全洞 ──
  // 决议(lead 定,A1 节):attach 须同时过两道门(detach 验引用画布 edit 权):
  //   ① actor 对目标 canvas 有 edit(write)权:body 带 canvasId(不信裸 nodeId),服务端从权威 node 数据
  //      反查 node 属该 canvas(persist.getChild;missing/cross-canvas → 404 unknown-node)。
  //   ② actor 是该 asset 的 uploader,或经某个已引用该 asset 的画布获得 view(read)entitlement:
  //      isUploader(assetId, ownerFp) OR references[].ownerFp === ownerFp(己方 ref)OR
  //      references[].canvasId 任一画布 actor 有 view 权(actorHasCanvasAccess)。
  // detach(decision 2):验目标引用所在 canvas 的 edit 权(ref.canvasId;新 ref)。legacy ref(无 canvasId)
  //   回退 ownerFp 校验(owner-mismatch 403,保既有 service 契约 + assetsAttachDetach 测试)。
  //
  // 403/404 语义(防存在性泄漏 + G2.1 proof-gate 语义保持):
  //   - gate ① canvas authz fail:非成员/无分享 → 404 unknown-canvas(无泄漏);成员/分享越权 → 403 forbidden。
  //   - gate ① node-not-in-canvas:404 unknown-node(actor 对 canvas 有 edit,node 不在属 client 错,不泄漏)。
  //   - asset record missing:404 {kind:'missing'}(无 record)。
  //   - gate ② fail(actor 已 canvas-write 授权但与 asset 无关系):403 forbidden(decidable,不静默;SC1:
  //     攻击者自建可编辑 canvas + 他人 hash attach → 403。sha256 不可枚举,存在性泄漏可接受)。
  //   - detach:新 ref canvas-edit authz fail → 404/403(同 gate ① 语义);legacy ref owner-mismatch → 403。
  const ATTACH_BODY_MAX = 8192 // nodeId + canvasId 小体量;8KB 上限防滥用

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
    let body: { nodeId?: string; canvasId?: string }
    try {
      body = await readJsonBody<{ nodeId?: string; canvasId?: string }>(c, ATTACH_BODY_MAX)
    } catch {
      log(400, 'bad-body')
      return c.json({ error: 'invalid body; expected { nodeId: string, canvasId: string }' }, 400)
    }
    const nodeId = body?.nodeId?.trim()
    const canvasId = body?.canvasId?.trim()
    if (!nodeId) {
      log(400, 'missing-node-id')
      return c.json({ error: 'nodeId is required' }, 400)
    }
    if (!canvasId) {
      log(400, 'missing-canvas-id')
      return c.json({ error: 'canvasId is required' }, 400)
    }

    // Gate ①:actor 对目标 canvas 有 edit(write)权 + node 属该 canvas(权威反查,不信裸 nodeId)。
    const access = await resolveCanvasAccess(c, persist, permissions, canvasId, 'write')
    if (!access.ok) {
      log(access.status, access.status === 403 ? 'forbidden' : access.status === 409 ? 'archived' : 'unknown-canvas')
      return c.json(access.body as Record<string, unknown>, access.status as 400 | 403 | 404 | 409 | 410)
    }
    const node = await persist.getChild(access.ownerId, canvasId, 'node', nodeId)
    if (node.kind === 'missing' || node.kind === 'cross-canvas') {
      // node 不属该 canvas → 404 unknown-node(不泄漏;actor 对 canvas 有 edit,node 不在属 client 错)。
      log(404, 'unknown-node')
      return c.json({ error: 'unknown-node' }, 404)
    }

    // Gate ②:actor 与 asset 的关系(uploader OR 己方 ref OR 经引用画布获 view entitlement)。
    const record = await store.getRecord(assetId)
    if (!record) {
      log(404, 'missing')
      return c.json({ kind: 'missing' } satisfies { kind: 'missing' }, 404)
    }
    let entitled = await store.isUploader(assetId, ownerFp)
    if (!entitled) entitled = record.references.some((r) => r.ownerFp === ownerFp)
    if (!entitled) {
      for (const r of record.references) {
        if (!r.canvasId) continue
        if (await actorHasCanvasAccess(persist, permissions, r.canvasId, 'read', ownerFp)) {
          entitled = true
          break
        }
      }
    }
    if (!entitled) {
      // actor 已对目标 canvas 有 edit 权(gate ① 过)但与 asset 无关系 → 403(decidable,不静默;SC1)。
      log(403, 'forbidden-no-asset-entitlement')
      return c.json({ error: 'forbidden' }, 403)
    }

    // 双门过 → attach(record ref canvasId 供后续 detach canvas-edit authz + gate ② 传递性 view)。
    const result = await store.attach(assetId, nodeId, ownerFp, undefined, canvasId)
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
    let body: { nodeId?: string; canvasId?: string }
    try {
      body = await readJsonBody<{ nodeId?: string; canvasId?: string }>(c, ATTACH_BODY_MAX)
    } catch {
      log(400, 'bad-body')
      return c.json({ error: 'invalid body; expected { nodeId: string, canvasId?: string }' }, 400)
    }
    const nodeId = body?.nodeId?.trim()
    if (!nodeId) {
      log(400, 'missing-node-id')
      return c.json({ error: 'nodeId is required' }, 400)
    }
    const bodyCanvasId = body?.canvasId?.trim() || undefined

    const record = await store.getRecord(assetId)
    if (!record) {
      log(404, 'missing')
      return c.json({ kind: 'missing' } satisfies { kind: 'missing' }, 404)
    }
    // P1-4 残留2:复合键选择。bodyCanvasId 存在→精确 (bodyCanvasId, nodeId);未找到则 legacy 兜底
    //   (r.nodeId===nodeId && !r.canvasId);bodyCanvasId 缺失→只匹配 legacy(canvasId===undefined)ref,
    //   新 ref(canvasId 存在)一律要求显式 canvasId(裸 nodeId 不任取第一条,防复合键语义破坏 + 误删他 canvas ref)。
    const ref = bodyCanvasId
      ? (record.references.find((r) => r.nodeId === nodeId && r.canvasId === bodyCanvasId)
        ?? record.references.find((r) => r.nodeId === nodeId && !r.canvasId)) // legacy 兜底
      : record.references.find((r) => r.nodeId === nodeId && !r.canvasId) // 无 bodyCanvasId → 只匹配 legacy ref
    if (!ref) {
      // ref 已不在(或新 ref 需显式 canvasId 但 body 未提供)→ already-detached(幂等 intent 已满足)。
      log(200, 'already-detached')
      return c.json({ kind: 'already-detached' } as { kind: 'already-detached' }, 200)
    }
    // decision 2:验目标引用所在 canvas 的 edit 权。新 ref(ref.canvasId)走 canvas-edit authz;
    // legacy ref(无 canvasId)回退 ownerFp 校验(service 层 owner-mismatch,保既有契约)。
    if (ref.canvasId) {
      if (bodyCanvasId && bodyCanvasId !== ref.canvasId) {
        // body 声称的 canvas 与 ref 实际 canvas 不符 → cross-canvas,不 detach 他 canvas 的 ref。
        log(404, 'cross-canvas')
        return c.json({ error: 'unknown-canvas' }, 404)
      }
      const access = await resolveCanvasAccess(c, persist, permissions, ref.canvasId, 'write')
      if (!access.ok) {
        log(access.status, access.status === 403 ? 'forbidden' : access.status === 409 ? 'archived' : 'unknown-canvas')
        return c.json(access.body as Record<string, unknown>, access.status as 400 | 403 | 404 | 409 | 410)
      }
    } else {
      // CR-6(Phase 2 归档 write-guard,补 legacy 路径):legacy ref(canvas-less,ref.canvasId undefined)整段
      //   此前跳过 resolveCanvasAccess → 不触发归档 409(攻击面:pre-G2.2 canvas-less legacy ref 其 node 落已归档
      //   画布,owner detach → 200 而非 409)。补:用 node→canvas 反查(resolveAssetOwner ownerFp 作 node owner_id
      //   代理:owner-attached legacy ref ownerFp===canvas owner → persist.get 命中;editor-attached ownerFp≠canvas
      //   owner → get missing → 解析不到 → 维持现状,行为不变,不误伤)。不能靠 bodyCanvasId(legacy fallback
      //   故意忽略它,禁回填语义,见下方注释)。
      const nodeRes = await persist.get(ownerFp, 'node', nodeId)
      const legacyCanvasId = nodeRes.kind === 'found' ? nodeRes.record.canvasId : null
      if (legacyCanvasId) {
        const canvasRes = await persist.get(ownerFp, 'canvas', legacyCanvasId)
        if (canvasRes.kind === 'found' && canvasRes.record.status === 'archived') {
          log(409, 'archived')
          return c.json({ error: 'archived', id: legacyCanvasId } satisfies ArchivedBody, 409)
        }
      }
      // 解析不到(node 孤儿/editor-attached legacy ref)或 canvas active → 维持现状(下方 legacy detach)。
    }
    // authz 过(新 ref canvas-edit / legacy ref 走 service ownerFp)→ detach(P1-4 残留2:传 ref.canvasId
    //   本身;legacy ref → undefined,**禁回填 bodyCanvasId**——否则 backend 按 (bodyCanvasId, nodeId)
    //   复合键查 legacy ref (null, nodeId) → 匹配不到 → 假 already-detached)。
    const result = await store.detach(assetId, nodeId, ownerFp, undefined, ref.canvasId)
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
