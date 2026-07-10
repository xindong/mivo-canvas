import type { ImageDimensions } from './imageSizing'
import { debugLogger } from '../store/debugLogStore'
import { ANONYMOUS_USER_ID, getPersistUserId } from './persistUserId'
// Pure prefix + gate helpers (light module — no auth/settings-store chain). The
// IO side (uploadAssetToServer / fetchServerAssetBlob, which import authHeaders)
// is dynamically imported from ./assetService only when a server path is hit,
// so importing assetStorage never pulls settingsSlice/persistIdbStorage.
import { isAssetsServerMode, isServerAssetUrl, isServerUploadableImage, serverAssetId, serverAssetUrl } from './assetServiceMode'

const DB_NAME = 'mivo-canvas-assets'
const DB_VERSION = 1
const STORE_NAME = 'assets'
const IMPORTED_ASSET_PREFIX = 'mivo-asset:'
const SOURCE = 'Assets'
const transparentAlphaThreshold = 2
const transparentTrimPadding = 2
const maxAlphaScanPixels = 12_000_000

const extensionMimeMap: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  markdown: 'text/markdown',
  md: 'text/markdown',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  webm: 'video/webm',
  webp: 'image/webp',
}

const mimeFromFilename = (filename: string) => {
  const extension = filename.split('.').pop()?.toLowerCase() || ''
  return extensionMimeMap[extension] || 'application/octet-stream'
}

const normalizedMimeType = (type: string) => type.toLowerCase().split(';')[0]

const isKnownOpaqueImageType = (type: string) =>
  type === 'image/jpeg' || type === 'image/jpg' || type === 'image/bmp'

const isLikelyTransparentImageType = (type: string) =>
  type === 'image/svg+xml' || type === 'image/gif'

const shouldScanImageAlpha = (type: string) =>
  type === 'image/png' || type === 'image/webp'

type StoredAsset = {
  id: string
  name: string
  type: string
  blob: Blob
  createdAt: number
  // FX-6: the user whose cache namespace owns this blob. Pre-FX-6 records lack
  // this field (undefined) and are claimed by the first authenticated user via
  // migrateUntaggedAssets. Anonymous-mode assets stay userId === 'anonymous'.
  userId?: string
}

export type SerializedCanvasAsset = {
  assetUrl: string
  name: string
  type: string
  dataUrl: string
  createdAt?: number
}

export type ImportedAssetFile = Pick<StoredAsset, 'name' | 'type' | 'blob' | 'createdAt'>

const openAssetDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const withAssetStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const db = await openAssetDb()

  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const request = run(transaction.objectStore(STORE_NAME))

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => db.close()
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

const createAssetId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const importedAssetUrl = (assetId: string) => `${IMPORTED_ASSET_PREFIX}${assetId}`

// A "mivo-asset:" url points into local IDB; a "mivo-sasset:" url points at the
// server content-addressed store (T1.5). Both are imported-asset references that
// the lease + useResolvedAssetUrl must resolve — so the predicate accepts both.
// This keeps assetUrlLease.ts unchanged: it calls resolveAssetUrl, which routes
// by prefix, and isLeaseable uses this predicate.
export const isImportedAssetUrl = (assetUrl?: string) =>
  Boolean(assetUrl && (assetUrl.startsWith(IMPORTED_ASSET_PREFIX) || isServerAssetUrl(assetUrl)))

const importedAssetId = (assetUrl: string) => assetUrl.slice(IMPORTED_ASSET_PREFIX.length)

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

const dataUrlToBlob = async (dataUrl: string) => {
  const response = await fetch(dataUrl)
  return response.blob()
}

type AlphaBounds = {
  left: number
  top: number
  width: number
  height: number
  hasTransparency: boolean
}

type PreparedImportedImage = {
  blob: Blob
  type: string
  dimensions?: ImageDimensions
  sourceDimensions?: ImageDimensions
  hasTransparency?: boolean
}

const alphaBoundsFor = (imageData: ImageData): AlphaBounds | undefined => {
  const { width, height, data } = imageData
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let hasTransparency = false

  for (let index = 3; index < data.length; index += 4) {
    const alpha = data[index]
    if (alpha < 255) hasTransparency = true
    if (alpha <= transparentAlphaThreshold) continue

    const pixelIndex = (index - 3) / 4
    const x = pixelIndex % width
    const y = Math.floor(pixelIndex / width)

    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  if (maxX < minX || maxY < minY) return undefined

  const left = Math.max(0, minX - transparentTrimPadding)
  const top = Math.max(0, minY - transparentTrimPadding)
  const right = Math.min(width - 1, maxX + transparentTrimPadding)
  const bottom = Math.min(height - 1, maxY + transparentTrimPadding)

  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
    hasTransparency,
  }
}

const prepareImportedImage = async (file: File): Promise<PreparedImportedImage> => {
  const detectedType = file.type || mimeFromFilename(file.name)
  const normalizedType = normalizedMimeType(detectedType)
  const fallback = {
    blob: file,
    type: detectedType,
    dimensions: undefined,
    sourceDimensions: undefined,
    hasTransparency: undefined,
  }

  if (!detectedType.startsWith('image/')) return fallback

  const bitmap = await createImageBitmap(file)
  const sourceDimensions = {
    width: bitmap.width,
    height: bitmap.height,
  }

  if (isKnownOpaqueImageType(normalizedType) || isLikelyTransparentImageType(normalizedType) || !shouldScanImageAlpha(normalizedType)) {
    bitmap.close()
    return {
      ...fallback,
      dimensions: sourceDimensions,
      sourceDimensions,
      hasTransparency: isLikelyTransparentImageType(normalizedType) ? true : isKnownOpaqueImageType(normalizedType) ? false : undefined,
    }
  }

  const sourcePixels = bitmap.width * bitmap.height
  const scanScale = sourcePixels > maxAlphaScanPixels ? Math.sqrt(maxAlphaScanPixels / sourcePixels) : 1
  const scanWidth = Math.max(1, Math.round(bitmap.width * scanScale))
  const scanHeight = Math.max(1, Math.round(bitmap.height * scanScale))

  const canvas = document.createElement('canvas')
  canvas.width = scanWidth
  canvas.height = scanHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    bitmap.close()
    return {
      ...fallback,
      dimensions: sourceDimensions,
      sourceDimensions,
    }
  }

  context.drawImage(bitmap, 0, 0, scanWidth, scanHeight)
  const bounds = alphaBoundsFor(context.getImageData(0, 0, canvas.width, canvas.height))
  bitmap.close()

  if (!bounds) {
    return {
      ...fallback,
      dimensions: sourceDimensions,
      sourceDimensions,
      hasTransparency: true,
    }
  }

  return {
    ...fallback,
    dimensions: sourceDimensions,
    sourceDimensions,
    hasTransparency: bounds.hasTransparency,
  }
}

type AssetRef = {
  assetUrl: string
  name: string
  type: string
  sizeBytes: number
  title: string
  size: string
  dimensions?: ImageDimensions
  sourceDimensions?: ImageDimensions
  hasTransparency?: boolean
}

const buildAssetRef = (assetUrl: string, file: File, prepared: PreparedImportedImage): AssetRef => ({
  assetUrl,
  name: file.name,
  type: prepared.type,
  sizeBytes: file.size,
  title: file.name.replace(/\.[^.]+$/, ''),
  size: prepared.sourceDimensions
    ? `${prepared.sourceDimensions.width}x${prepared.sourceDimensions.height}`
    : 'source',
  dimensions: prepared.dimensions,
  sourceDimensions: prepared.sourceDimensions,
  hasTransparency: prepared.hasTransparency,
})

export const saveImportedAsset = async (file: File): Promise<AssetRef> => {
  const prepared = await prepareImportedImage(file).catch(() => ({
    blob: file,
    type: file.type || mimeFromFilename(file.name),
    dimensions: undefined,
    sourceDimensions: undefined,
    hasTransparency: undefined,
  }))

  // T1.5 server mode: POST ONLY server-uploadable static images to the server
  // (png/jpeg/webp/gif/avif — the server's MIME allowlist). Non-image kinds
  // (markdown / PDF / video) and svg (script-carrying, rejected by the server gate)
  // stay on local IDB even in server mode — T1.5's scope is vetted static images,
  // and only that subset is server-storable. assetUrl encodes where the bytes live
  // (mivo-sasset:<id> for server, mivo-asset:<uuid> for IDB), so resolve/serialize
  // route by prefix regardless of the current gate.
  if (isAssetsServerMode() && isServerUploadableImage(prepared.type)) {
    const { uploadAssetToServer } = await import('./assetService')
    const uploaded = await uploadAssetToServer(prepared.blob, file.name, prepared.type)
    return buildAssetRef(serverAssetUrl(uploaded.assetId), file, prepared)
  }

  // Local IDB path (default, gate off — zero behavior change vs pre-T1.5).
  const id = createAssetId()
  const asset: StoredAsset = {
    id,
    name: file.name,
    type: prepared.type,
    blob: prepared.blob,
    createdAt: Date.now(),
    userId: getPersistUserId(),
  }
  await withAssetStore('readwrite', (store) => store.put(asset))
  return buildAssetRef(importedAssetUrl(id), file, prepared)
}

export const saveGeneratedAsset = async (blob: Blob, name: string, type = blob.type || 'image/png') => {
  const normalizedName = name.trim() || `generated-${Date.now()}.png`
  const file = new File([blob], normalizedName, { type })
  return saveImportedAsset(file)
}

export const resolveAssetUrl = async (assetUrl?: string) => {
  if (!assetUrl) return ''
  // T1.5: a mivo-sasset: url resolves via GET /api/assets/:id → blob URL.
  // Routing by PREFIX (not the current gate) means a node created in server mode
  // keeps resolving via GET even after the user switches back to local — the
  // assetUrl encodes where its bytes live.
  if (isServerAssetUrl(assetUrl)) {
    const { fetchServerAssetBlob } = await import('./assetService')
    const fetched = await fetchServerAssetBlob(serverAssetId(assetUrl))
    return fetched ? URL.createObjectURL(fetched.blob) : ''
  }
  if (!isImportedAssetUrl(assetUrl)) return assetUrl

  const asset = await withAssetStore<StoredAsset | undefined>('readonly', (store) =>
    store.get(importedAssetId(assetUrl)),
  )

  return asset ? URL.createObjectURL(asset.blob) : ''
}

export const readImportedAssetFile = async (assetUrl?: string): Promise<ImportedAssetFile | undefined> => {
  if (!assetUrl) return undefined
  if (isServerAssetUrl(assetUrl)) {
    // T1.5: server read path. name / createdAt are unknown on GET (the server
    // returns bytes + mimeType only); callers fall back to node.assetOriginalName
    // for the filename (assetDownload.ts filenameFor) — metrics only needs blob.
    const { fetchServerAssetBlob } = await import('./assetService')
    const fetched = await fetchServerAssetBlob(serverAssetId(assetUrl))
    if (!fetched) return undefined
    return { name: '', type: fetched.mimeType, blob: fetched.blob, createdAt: 0 }
  }
  if (!isImportedAssetUrl(assetUrl)) return undefined

  const asset = await withAssetStore<StoredAsset | undefined>('readonly', (store) =>
    store.get(importedAssetId(assetUrl)),
  )

  if (!asset) return undefined

  return {
    name: asset.name,
    type: asset.type,
    blob: asset.blob,
    createdAt: asset.createdAt,
  }
}

export const serializeImportedAsset = async (assetUrl?: string): Promise<SerializedCanvasAsset | undefined> => {
  if (!assetUrl || !isImportedAssetUrl(assetUrl)) return undefined
  // T1.5: server asset → fetch bytes + embed dataUrl so the archive stays
  // self-contained (same shape as the IDB path; only the bytes source differs).
  // A fetch failure (server down / asset purged) → omit from archive + warn,
  // rather than embedding a broken entry.
  if (isServerAssetUrl(assetUrl)) {
    // T1.5: server asset → fetch bytes + embed dataUrl so the archive stays
    // self-contained (same shape as the IDB path; only the bytes source differs).
    // P2.7: any fetch / blob failure (server down / asset purged / network error /
    // AbortError) → omit from archive + warn, never throw — archive serialization
    // is best-effort and must not abort the whole export on one unavailable asset.
    try {
      const { fetchServerAssetBlob } = await import('./assetService')
      const fetched = await fetchServerAssetBlob(serverAssetId(assetUrl))
      if (!fetched) {
        debugLogger.warn(
          SOURCE,
          `serialize: server asset ${serverAssetId(assetUrl).slice(0, 12)}… unavailable, omitted from archive`,
        )
        return undefined
      }
      return {
        assetUrl,
        name: '',
        type: fetched.mimeType,
        dataUrl: await blobToDataUrl(fetched.blob),
        createdAt: 0,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      debugLogger.warn(
        SOURCE,
        `serialize: server asset ${serverAssetId(assetUrl).slice(0, 12)}… failed: ${msg}, omitted from archive`,
      )
      return undefined
    }
  }

  const asset = await withAssetStore<StoredAsset | undefined>('readonly', (store) =>
    store.get(importedAssetId(assetUrl)),
  )

  if (!asset) return undefined

  return {
    assetUrl,
    name: asset.name,
    type: asset.type,
    dataUrl: await blobToDataUrl(asset.blob),
    createdAt: asset.createdAt,
  }
}

export const restoreSerializedAsset = async (asset: SerializedCanvasAsset) => {
  if (!asset || !isImportedAssetUrl(asset.assetUrl)) return
  // T1.5: server asset → re-POST the embedded bytes. Content-addressed dedup
  // means the server returns the SAME assetId (= content hash) — so the node's
  // mivo-sasset:<assetId> ref stays valid on a target server that didn't have
  // it yet. Bytes stay server-side; NEVER IDB-write (would shadow the server ref).
  if (isServerAssetUrl(asset.assetUrl)) {
    if (!asset.dataUrl.startsWith('data:')) return
    const blob = await dataUrlToBlob(asset.dataUrl)
    try {
      const { uploadAssetToServer } = await import('./assetService')
      await uploadAssetToServer(blob, asset.name || 'restored-asset', asset.type || blob.type)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      debugLogger.warn(
        SOURCE,
        `restore server asset ${serverAssetId(asset.assetUrl).slice(0, 12)}… failed: ${msg}`,
      )
    }
    return
  }

  if (!asset.dataUrl.startsWith('data:')) return

  const id = importedAssetId(asset.assetUrl)
  const blob = await dataUrlToBlob(asset.dataUrl)
  const storedAsset: StoredAsset = {
    id,
    name: asset.name || id,
    type: asset.type || blob.type || 'application/octet-stream',
    blob,
    createdAt: asset.createdAt || Date.now(),
    userId: getPersistUserId(),
  }

  await withAssetStore('readwrite', (store) => store.put(storedAsset))
}

/**
 * FX-6 clear asset blobs owned by the given user — called from
 * clearCurrentUserCache on logout. Iterates the assets store and deletes every
 * record whose `userId` matches; other users' blobs are never touched. Node-test-
 * safe: no-op when IndexedDB is undefined (the auth characterization tests run
 * with no IDB global). Asset ids are globally unique (crypto.randomUUID), so
 * resolveAssetUrl stays by-id only — cross-user isolation comes from the
 * namespaced canvas that owns the references, not from filtering reads.
 */
export const clearAssetsForUser = async (userId: string): Promise<void> => {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return
  if (!userId) return
  let cleared = 0
  try {
    const db = await openAssetDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result as IDBCursorWithValue | null
        if (cursor) {
          const rec = cursor.value as StoredAsset
          if (rec.userId === userId) {
            cursor.delete()
            cleared += 1
          }
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('asset clear aborted'))
    })
    db.close()
    if (cleared > 0) {
      debugLogger.log(SOURCE, `cleared ${cleared} asset(s) for user ${userId} on logout`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    debugLogger.warn(SOURCE, `clearAssetsForUser failed for ${userId}: ${msg}`)
  }
}

/**
 * FX-6 one-shot migration: claim pre-FX-6 asset blobs (no `userId` field) for the
 * current authenticated user so a later logout actually clears them. Idempotent
 * via a per-user sessionStorage marker and via cursor state (no untagged records
 * remain after a run). Skipped for the anonymous namespace — anonymous assets stay
 * shared, and there is no authenticated owner to claim them. Fire-and-forget from
 * authSlice.hydrate; never blocks canvas hydration (assets resolve on demand).
 */
export const migrateUntaggedAssets = async (userId: string): Promise<void> => {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return
  if (!userId || userId === ANONYMOUS_USER_ID) return
  if (typeof sessionStorage === 'undefined') return
  const marker = `mivo-assets-ns-migrated:${userId}`
  if (sessionStorage.getItem(marker)) return
  let tagged = 0
  try {
    const db = await openAssetDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result as IDBCursorWithValue | null
        if (cursor) {
          const rec = cursor.value as StoredAsset
          if (rec.userId === undefined || rec.userId === null || rec.userId === '') {
            rec.userId = userId
            cursor.update(rec)
            tagged += 1
          }
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('asset migration aborted'))
    })
    db.close()
    sessionStorage.setItem(marker, '1')
    if (tagged > 0) {
      debugLogger.log(SOURCE, `migrated ${tagged} untagged asset(s) → user ${userId}`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Marker NOT set → next boot retries. Never silently lose the migration chance.
    debugLogger.warn(SOURCE, `migrateUntaggedAssets failed for ${userId}: ${msg}`)
  }
}
