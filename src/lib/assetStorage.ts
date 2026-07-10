import type { ImageDimensions } from './imageSizing'
import { debugLogger } from '../store/debugLogStore'
import { ANONYMOUS_USER_ID, getPersistUserId } from './persistUserId'

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

export const isImportedAssetUrl = (assetUrl?: string) =>
  Boolean(assetUrl?.startsWith(IMPORTED_ASSET_PREFIX))

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

export const saveImportedAsset = async (file: File) => {
  const id = createAssetId()
  const prepared = await prepareImportedImage(file).catch(() => ({
    blob: file,
    type: file.type || mimeFromFilename(file.name),
    dimensions: undefined,
    sourceDimensions: undefined,
    hasTransparency: undefined,
  }))
  const asset: StoredAsset = {
    id,
    name: file.name,
    type: prepared.type,
    blob: prepared.blob,
    createdAt: Date.now(),
    userId: getPersistUserId(),
  }

  await withAssetStore('readwrite', (store) => store.put(asset))

  return {
    assetUrl: importedAssetUrl(id),
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
  }
}

export const saveGeneratedAsset = async (blob: Blob, name: string, type = blob.type || 'image/png') => {
  const normalizedName = name.trim() || `generated-${Date.now()}.png`
  const file = new File([blob], normalizedName, { type })
  return saveImportedAsset(file)
}

export const resolveAssetUrl = async (assetUrl?: string) => {
  if (!assetUrl) return ''
  if (!isImportedAssetUrl(assetUrl)) return assetUrl

  const asset = await withAssetStore<StoredAsset | undefined>('readonly', (store) =>
    store.get(importedAssetId(assetUrl)),
  )

  return asset ? URL.createObjectURL(asset.blob) : ''
}

export const readImportedAssetFile = async (assetUrl?: string): Promise<ImportedAssetFile | undefined> => {
  if (!assetUrl || !isImportedAssetUrl(assetUrl)) return undefined

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
  if (!isImportedAssetUrl(asset.assetUrl) || !asset.dataUrl.startsWith('data:')) return

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
