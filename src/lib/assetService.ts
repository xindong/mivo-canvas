// src/lib/assetService.ts
// T1.5 server-side asset service — IO layer (POST /api/assets, GET /api/assets/:id).
//
// Pure prefix + gate helpers live in ./assetServiceMode.ts (no auth/IO imports,
// so low-level consumers can statically import them without pulling the settings-
// store graph). This module imports authHeaders (→ settingsSlice) and is therefore
// dynamically imported by assetStorage.ts ONLY when a server path is actually hit
// — keeping the heavy import chain out of consumers that never touch server assets.
//
// When the assets gate (?assets=server / VITE_MIVO_ASSETS=server) is on, the
// client POSTs SERVER-UPLOADABLE IMAGE bytes to the server and resolves them via
// GET. Non-image kinds (markdown / PDF / video) and svg stay on local IDB even in
// server mode — T1.5's scope is vetted static images (png/jpeg/webp/gif/avif);
// saveImportedAsset gates the server branch with isServerUploadableImage. The
// assetUrl scheme for server assets is `mivo-sasset:<assetId>` (assetId = sha256
// content hash, returned by the server). Default (gate off) stays on local IDB
// (`mivo-asset:<uuid>`) with zero behavior change — server mode is a gated 灰度
// path; the default-flip decision is left to the lead.
//
// Auth: uploads/fetches send X-Mivo-Api-Key via authHeaders() (same as the
// generate/edit/task routes), so the BFF resolves the ownerFp 归属打标.
// Content-addressed GET is OWNER-SCOPED (P1.5): the requester must be an uploader
// of these bytes OR hold a live reference — cross-owner reads return 404 (existence
// is never leaked). A dedup uploader is always entitled to GET their own upload.

// Re-export the pure helpers so tests / consumers can import everything from one module.
export * from './assetServiceMode'

import { authHeaders } from './authHeaders'
import { debugLogger } from '../store/debugLogStore'
import { resolveAssetBaseUrl } from './assetServiceMode'

const SERVER_SOURCE = 'Server Asset'

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: string; message?: string }
    return payload.error || payload.message || `${response.status} ${response.statusText}`
  } catch {
    return `${response.status} ${response.statusText}`
  }
}

export type ServerAssetUploadResult = {
  assetId: string
  mimeType: string
  originalName: string
  sizeBytes: number
  refcount: number
  deduped: boolean
}

/**
 * POST /api/assets with a Blob (multipart 'image' field). Returns the server's
 * upload result (assetId = sha256 content hash). Throws on non-2xx so the caller
 * (saveImportedAsset) can surface a failure. Same authHeaders() as generate/edit.
 *
 * Caller invariant: saveImportedAsset only invokes this for SERVER-UPLOADABLE images
 * (png/jpeg/webp/gif/avif — isServerUploadableImage). Non-image kinds never reach
 * here; they stay on local IDB. The server re-sniffs magic bytes and rejects anything
 * outside its own allowlist regardless of the provided type, so this is the happy path
 * only for vetted static images.
 */
export const uploadAssetToServer = async (blob: Blob, name: string, type: string): Promise<ServerAssetUploadResult> => {
  const formData = new FormData()
  const filename = name || 'asset'
  // The server sniffs magic bytes and rejects anything outside its image allowlist
  // (providedType is NOT trusted for the gate). Preserve the client-known type on
  // the File so the multipart part carries a sensible type; saveImportedAsset only
  // calls this for server-uploadable images, so it's always an allowlisted type here.
  const file = new File([blob], filename, { type: type || blob.type || 'application/octet-stream' })
  formData.append('image', file, filename)
  const response = await fetch(`${resolveAssetBaseUrl()}/api/assets`, {
    method: 'POST',
    headers: { ...authHeaders() },
    body: formData,
  })
  if (!response.ok) {
    const msg = await readErrorMessage(response)
    debugLogger.error(SERVER_SOURCE, `upload failed (${response.status}): ${msg}`)
    throw new Error(`Unable to upload asset (${response.status})`)
  }
  const body = (await response.json()) as ServerAssetUploadResult
  debugLogger.log(
    SERVER_SOURCE,
    `uploaded ${filename} → ${body.assetId.slice(0, 12)}…${body.deduped ? ' (dedup)' : ''}`,
  )
  return body
}

/**
 * GET /api/assets/:id → Blob + mimeType. null on 404 (asset purged / missing).
 * Non-2xx errors surface a warn log + return null (resolve falls back to empty).
 * Network failures (fetch reject — DNS / connection / offline) are caught and
 * also return null, so a server-down never surfaces as an unhandled rejection
 * (P2.7). AbortError is preserved (re-thrown) — it signals intentional cancel,
 * not a network failure, and callers that pass a signal rely on it propagating.
 */
export const fetchServerAssetBlob = async (
  assetId: string,
): Promise<{ blob: Blob; mimeType: string } | null> => {
  let response: Response
  try {
    response = await fetch(`${resolveAssetBaseUrl()}/api/assets/${assetId}`, {
      headers: { ...authHeaders() },
    })
  } catch (error) {
    // P2.7: network failure → null + warn (no unhandled rejection).
    if (error instanceof Error && error.name === 'AbortError') throw error
    debugLogger.warn(SERVER_SOURCE, `fetch ${assetId.slice(0, 12)}… network error: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    debugLogger.warn(SERVER_SOURCE, `fetch ${assetId.slice(0, 12)}… failed (${response.status})`)
    return null
  }
  const mimeType = response.headers.get('content-type') || 'application/octet-stream'
  try {
    return { blob: await response.blob(), mimeType }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    debugLogger.warn(SERVER_SOURCE, `fetch ${assetId.slice(0, 12)}… blob read error: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
