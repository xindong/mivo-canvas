import { useEffect, useMemo, useState } from 'react'
import type { ImageDimensions } from './imageSizing'
import { getImageMetrics, reportImageMetrics } from './imageMetricsCache'

type NaturalSize = { width: number; height: number }

type ImgLoadEvent = { currentTarget: { naturalWidth: number; naturalHeight: number } }

/**
 * Resolve the natural pixel size of a node's image asset (Phase 3a, metrics track).
 *
 * Priority:
 * 1. `sourceDimensions` (node.assetSourceDimensions) — written at import/generation
 *    time, available synchronously. Zero decode.
 * 2. `getImageMetrics(assetUrl)` — cache hit first, then IDB decode for imported
 *    legacy nodes that lack the field (backfill).
 * 3. `<img onLoad>` → `reportImageMetrics` — for non-imported URLs (http/data) the
 *    cache is populated by the load itself; the returned `onLoad` wires this.
 *
 * The measured value is keyed by assetUrl so a stale measurement from a previous
 * asset stops applying the instant assetUrl changes (no synchronous state reset
 * in the effect, no `.url` field leaked to the caller).
 */
export function useImageNaturalSize(
  assetUrl: string | undefined,
  sourceDimensions?: ImageDimensions,
): { naturalSize: NaturalSize | undefined; onLoad: (event: ImgLoadEvent) => void } {
  const srcWidth = sourceDimensions?.width
  const srcHeight = sourceDimensions?.height
  const fromNode = useMemo<NaturalSize | undefined>(() => {
    if (srcWidth === undefined || srcHeight === undefined) return undefined
    if (srcWidth <= 0 || srcHeight <= 0) return undefined
    return { width: srcWidth, height: srcHeight }
  }, [srcWidth, srcHeight])

  const [measured, setMeasured] = useState<{ assetUrl: string; dims: NaturalSize } | undefined>()

  useEffect(() => {
    if (fromNode || !assetUrl) return
    let active = true
    void getImageMetrics(assetUrl).then((dims) => {
      if (active && dims) setMeasured({ assetUrl, dims })
    })
    return () => {
      active = false
    }
  }, [assetUrl, fromNode])

  const onLoad = (event: ImgLoadEvent) => {
    const dims: NaturalSize = {
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    }
    if (dims.width <= 0 || dims.height <= 0) return
    if (assetUrl) reportImageMetrics(assetUrl, dims)
    // Only flip state when the sync path isn't authoritative; avoids a re-render
    // shadowed by fromNode.
    if (!fromNode) setMeasured({ assetUrl: assetUrl || '', dims })
  }

  const measuredForCurrent =
    measured && measured.assetUrl === assetUrl ? measured.dims : undefined

  return { naturalSize: fromNode ?? measuredForCurrent, onLoad }
}
