// imageMetricsCache — natural-size cache for image assets (Phase 3a, metrics track).
//
// Stores only the decoded natural {width, height} — never holds the bitmap. Used by
// useImageNaturalSize to backfill legacy imported nodes (no assetSourceDimensions on
// the node) and to share one decode across mounts. Non-imported URLs are cache-only:
// the <img onLoad> path calls reportImageMetrics, and getImageMetrics returns the
// cached value (or undefined until the first load reports).
//
// Design: plans/leafer-designs/phase3a-asset-lease-metrics.md §3.
//
// Red line: this is a render-only cache. It does NOT persist to the node — new
// imports/generations write assetSourceDimensions on the node (§2.5 方案 A), so the
// cache is only the fallback for legacy nodes and the onLoad report path.

import type { ImageDimensions } from './imageSizing'
import { isImportedAssetUrl, readImportedAssetFile } from './assetStorage'
import { debugLogger } from '../store/debugLogStore'

const metricsCache = new Map<string, ImageDimensions>()
const inFlight = new Map<string, Promise<ImageDimensions | undefined>>()
const SOURCE = 'Image Metrics'

const isValidDimensions = (dims: ImageDimensions): boolean =>
  Number.isFinite(dims.width) && dims.width > 0 && Number.isFinite(dims.height) && dims.height > 0

/**
 * Write a decoded natural size into the cache. Called from <img onLoad> for any URL
 * (imported blob, http, data). Idempotent; the latest measurement wins.
 */
export const reportImageMetrics = (assetUrl: string, dimensions: ImageDimensions): void => {
  if (!assetUrl || !isValidDimensions(dimensions)) return
  metricsCache.set(assetUrl, { width: dimensions.width, height: dimensions.height })
}

/**
 * Read the cached natural size, decoding the IDB blob on miss for imported assets.
 * Returns undefined for non-imported URLs that haven't been reported via onLoad yet
 * (there is no blob to decode for an http URL).
 *
 * Concurrent calls for the same URL share one in-flight decode (dedup).
 */
export const getImageMetrics = async (assetUrl?: string): Promise<ImageDimensions | undefined> => {
  if (!assetUrl) return undefined

  const cached = metricsCache.get(assetUrl)
  if (cached) return cached

  // Non-imported URLs have no IDB blob to decode — the onLoad path reports them.
  if (!isImportedAssetUrl(assetUrl)) return undefined

  const existing = inFlight.get(assetUrl)
  if (existing) return existing

  const task = (async (): Promise<ImageDimensions | undefined> => {
    const file = await readImportedAssetFile(assetUrl)
    if (!file) return undefined // IDB miss — asset gone

    try {
      const bitmap = await createImageBitmap(file.blob)
      const dims: ImageDimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      if (!isValidDimensions(dims)) return undefined
      metricsCache.set(assetUrl, dims)
      return dims
    } catch (error) {
      debugLogger.warn(
        SOURCE,
        `decode failed for ${assetUrl}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  })()

  inFlight.set(assetUrl, task)
  try {
    return await task
  } finally {
    inFlight.delete(assetUrl)
  }
}

/** Test-only: clear the cache + in-flight map. Not exported to app code. */
export const __resetImageMetricsCache = (): void => {
  metricsCache.clear()
  inFlight.clear()
}
