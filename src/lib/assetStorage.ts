import type { ImageDimensions } from './imageSizing'

const DB_NAME = 'mivo-canvas-assets'
const DB_VERSION = 1
const STORE_NAME = 'assets'
const IMPORTED_ASSET_PREFIX = 'mivo-asset:'
const transparentAlphaThreshold = 2
const transparentTrimPadding = 2

type StoredAsset = {
  id: string
  name: string
  type: string
  blob: Blob
  createdAt: number
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
  const fallback = {
    blob: file,
    type: file.type || 'application/octet-stream',
    dimensions: undefined,
    sourceDimensions: undefined,
    hasTransparency: undefined,
  }

  if (!file.type.startsWith('image/')) return fallback

  const bitmap = await createImageBitmap(file)
  const sourceDimensions = {
    width: bitmap.width,
    height: bitmap.height,
  }

  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    bitmap.close()
    return {
      ...fallback,
      dimensions: sourceDimensions,
      sourceDimensions,
    }
  }

  context.drawImage(bitmap, 0, 0)
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
    type: file.type || 'application/octet-stream',
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
  }

  await withAssetStore('readwrite', (store) => store.put(asset))

  return {
    assetUrl: importedAssetUrl(id),
    title: file.name.replace(/\.[^.]+$/, ''),
    size: prepared.sourceDimensions
      ? `${prepared.sourceDimensions.width}x${prepared.sourceDimensions.height}`
      : 'source',
    dimensions: prepared.dimensions,
    sourceDimensions: prepared.sourceDimensions,
    hasTransparency: prepared.hasTransparency,
  }
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
  }

  await withAssetStore('readwrite', (store) => store.put(storedAsset))
}
