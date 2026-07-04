import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetImageMetricsCache, getImageMetrics, reportImageMetrics } from './imageMetricsCache'

// Mock readImportedAssetFile so tests don't touch IDB. Returns a fake blob whose
// createImageBitmap yields a known width/height.
const createImageBitmapMock = vi.fn(async (blob: Blob) => {
  const text = await blob.text()
  // Encode dims in the blob body so tests can vary them: "WxH".
  const [w, h] = text.split('x').map(Number)
  return { width: w, height: h, close: vi.fn() }
})

const readImportedAssetFileMock = vi.fn(async (assetUrl: string) => {
  if (assetUrl.endsWith('-miss')) return undefined
  // Encode dims in the blob body.
  const dims = assetUrl.endsWith('-large') ? '2000x1000' : '400x300'
  return { name: 'n', type: 'image/png', blob: new Blob([dims], { type: 'image/png' }), createdAt: 1 }
})

vi.mock('./assetStorage', () => ({
  isImportedAssetUrl: (url?: string) => Boolean(url?.startsWith('mivo-asset:')),
  readImportedAssetFile: (assetUrl: string) => readImportedAssetFileMock(assetUrl),
}))

beforeEach(() => {
  __resetImageMetricsCache()
  readImportedAssetFileMock.mockClear()
  createImageBitmapMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// createImageBitmap is a browser global; stub it before each test.
vi.stubGlobal('createImageBitmap', createImageBitmapMock)

const ASSET = 'mivo-asset:abc'
const ASSET_LARGE = 'mivo-asset:abc-large'
const ASSET_MISS = 'mivo-asset:abc-miss'
const HTTP = 'https://example.com/cat.png'

describe('reportImageMetrics — cache write', () => {
  it('writes a valid size that a subsequent getImageMetrics returns without IDB decode', async () => {
    reportImageMetrics(ASSET, { width: 640, height: 480 })
    // getImageMetrics should hit the cache — no IDB read, no bitmap decode.
    const dims = await getImageMetrics(ASSET)
    expect(dims).toEqual({ width: 640, height: 480 })
    expect(readImportedAssetFileMock).not.toHaveBeenCalled()
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('rejects non-positive sizes (no cache poison)', async () => {
    reportImageMetrics(ASSET, { width: 0, height: 480 })
    reportImageMetrics(ASSET, { width: -1, height: 480 })
    // Not cached → getImageMetrics falls through to IDB decode.
    await getImageMetrics(ASSET)
    expect(readImportedAssetFileMock).toHaveBeenCalled()
  })
})

describe('getImageMetrics — cache hit (bitmap decode only once)', () => {
  it('decodes the IDB blob once; subsequent calls hit the cache (no re-decode)', async () => {
    const first = await getImageMetrics(ASSET)
    expect(first).toEqual({ width: 400, height: 300 })
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1)

    const second = await getImageMetrics(ASSET)
    expect(second).toEqual({ width: 400, height: 300 })
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1) // cache hit, no re-decode
    expect(readImportedAssetFileMock).toHaveBeenCalledTimes(1)
  })

  it('closes the bitmap after reading dims (does not hold it)', async () => {
    const dims = await getImageMetrics(ASSET_LARGE)
    expect(dims).toEqual({ width: 2000, height: 1000 })
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1)
    const bitmap = await createImageBitmapMock.mock.results[0].value
    expect(bitmap.close).toHaveBeenCalled()
  })
})

describe('getImageMetrics — in-flight dedup', () => {
  it('concurrent calls for the same URL share one decode (one createImageBitmap)', async () => {
    // Fire both before either resolves.
    const p1 = getImageMetrics(ASSET)
    const p2 = getImageMetrics(ASSET)
    const [a, b] = await Promise.all([p1, p2])

    expect(a).toEqual({ width: 400, height: 300 })
    expect(b).toEqual(a)
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1)
    expect(readImportedAssetFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('getImageMetrics — non-imported URLs (cache-only)', () => {
  it('returns undefined for a non-imported URL with no prior report (no IDB decode)', async () => {
    const dims = await getImageMetrics(HTTP)
    expect(dims).toBeUndefined()
    expect(readImportedAssetFileMock).not.toHaveBeenCalled()
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('returns the reported size after reportImageMetrics for a non-imported URL', async () => {
    reportImageMetrics(HTTP, { width: 800, height: 600 })
    const dims = await getImageMetrics(HTTP)
    expect(dims).toEqual({ width: 800, height: 600 })
    expect(readImportedAssetFileMock).not.toHaveBeenCalled()
  })
})

describe('getImageMetrics — IDB miss + decode failure', () => {
  it('returns undefined when the asset is not in IDB (miss)', async () => {
    const dims = await getImageMetrics(ASSET_MISS)
    expect(dims).toBeUndefined()
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('returns undefined and does not cache when createImageBitmap throws', async () => {
    readImportedAssetFileMock.mockResolvedValueOnce({
      name: 'n', type: 'image/png',
      blob: new Blob(['boom'], { type: 'image/png' }), createdAt: 1,
    })
    createImageBitmapMock.mockRejectedValueOnce(new Error('decode boom'))
    const dims = await getImageMetrics(ASSET)
    expect(dims).toBeUndefined()
    // A failed decode must not poison the cache — a retry re-attempts.
    readImportedAssetFileMock.mockClear()
    const retry = await getImageMetrics(ASSET)
    expect(readImportedAssetFileMock).toHaveBeenCalled()
    void retry
  })
})
