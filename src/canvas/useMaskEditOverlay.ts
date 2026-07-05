// useMaskEditOverlay — resolve the mask-edit target + its natural size (Phase 3b).
//
// 3b moved the mask overlay out of the image DOM node into EditOverlayLayer. The
// overlay no longer reads the image DOM node's <img onLoad> for naturalSize — it
// reads the metrics cache (useImageNaturalSize: node.assetSourceDimensions →
// cache → IDB decode → <img onLoad> report) so the overlay survives the 3c Leafer
// paint switch (image DOM node goes away; the overlay + its metrics source stay).
//
// naturalSize may be undefined briefly while the async cache resolves; the caller
// (MaskCropOverlayHost) gates mounting on it — matching the old CanvasNodeView
// `naturalSize ?` condition. The missing-naturalSize fallback is logged so a stuck
// asset is observable in the debug log (logging invariant: state/skip/fail paths).

import { useEffect, useState } from 'react'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import { useImageNaturalSize } from '../lib/useImageNaturalSize'
import { reportImageMetrics } from '../lib/imageMetricsCache'
import { debugLogger } from '../store/debugLogStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'

type NaturalSize = { width: number; height: number }

export type MaskEditOverlayState = {
  maskEditNode: MivoCanvasNode | undefined
  resolvedMaskAssetUrl: string | undefined
  maskNaturalSize: NaturalSize | undefined
}

/**
 * Resolve the mask-edit target node + resolved asset URL + natural size. Pure
 * composition of useResolvedAssetUrl + useImageNaturalSize; extracted so
 * MivoCanvas stays thin (structure-guard line budget) and the metrics-source
 * contract has one home.
 */
export function useMaskEditOverlay(
  maskEditNodeId: string | undefined,
  visibleNodes: readonly MivoCanvasNode[],
): MaskEditOverlayState {
  const maskEditNode = maskEditNodeId
    ? visibleNodes.find((node) => node.id === maskEditNodeId && node.type === 'image')
    : undefined
  const resolvedMaskAssetUrl = useResolvedAssetUrl(maskEditNode?.assetUrl)
  // P1 fix (Greptile): pass the ORIGINAL assetUrl (local:// for imported nodes),
  // not resolvedMaskAssetUrl (a blob URL). getImageMetrics treats non-imported URLs
  // as undecodable (no IDB blob) and returns undefined; with no <img onLoad> fallback
  // in the overlay path, a legacy imported node without assetSourceDimensions would
  // silently never resolve naturalSize → mask overlay never mounts. resolvedMaskAssetUrl
  // is still used for the <img> src; metrics use the original local:// URL (IDB decode).
  const { naturalSize: metricsNaturalSize } = useImageNaturalSize(
    maskEditNode?.assetUrl,
    maskEditNode?.assetSourceDimensions,
  )

  // Leafer 真 bug 修复(FU e2e 甄别):plain-URL 节点(demo-assets / eagle 等,
  // 非 mivo-asset:)且无 assetSourceDimensions 时,metrics 链的最后一环是 image
  // DOM 节点的 <img onLoad> 上报;leafer 模式 image 无 DOM,该环永不发生 →
  // overlay 永不挂载(AI Edit → Select area 无响应)。这里补一个 overlay 自己的
  // 兜底解码:metrics 未解出时用 Image() 直接量 resolvedMaskAssetUrl,量到即回
  // 写 metrics cache,双模式等价(dom 模式下 metrics 先到,兜底不触发)。
  const [probedNaturalSize, setProbedNaturalSize] = useState<{ url: string; dims: NaturalSize } | undefined>()
  useEffect(() => {
    if (!maskEditNode || metricsNaturalSize || !resolvedMaskAssetUrl) return
    let active = true
    const image = new Image()
    image.onload = () => {
      if (!active) return
      const dims = { width: image.naturalWidth, height: image.naturalHeight }
      if (dims.width <= 0 || dims.height <= 0) return
      if (maskEditNode.assetUrl) reportImageMetrics(maskEditNode.assetUrl, dims)
      debugLogger.log('Mask Edit', `naturalSize resolved by overlay fallback decode for ${maskEditNode.id}: ${dims.width}x${dims.height}`)
      setProbedNaturalSize({ url: resolvedMaskAssetUrl, dims })
    }
    image.onerror = () => {
      if (!active) return
      debugLogger.warn('Mask Edit', `overlay fallback decode failed for ${maskEditNode.id}: ${resolvedMaskAssetUrl}`)
    }
    image.src = resolvedMaskAssetUrl
    return () => {
      active = false
    }
  }, [maskEditNode, metricsNaturalSize, resolvedMaskAssetUrl])
  const maskNaturalSize =
    metricsNaturalSize ??
    (probedNaturalSize && probedNaturalSize.url === resolvedMaskAssetUrl ? probedNaturalSize.dims : undefined)

  // logging invariant: a mask-edit target whose naturalSize never resolves would
  // silently never mount the overlay (caller gates on maskNaturalSize). Log so a
  // stuck asset (IDB miss + no onLoad report + fallback decode pending) is
  // traceable in the debug log.
  useEffect(() => {
    if (maskEditNodeId && maskEditNode && !maskNaturalSize) {
      debugLogger.warn(
        'Mask Edit',
        `naturalSize unavailable for ${maskEditNodeId}; mask overlay waiting on asset metrics (cache/IDB/<img onLoad>/fallback decode)`,
      )
    }
  }, [maskEditNodeId, maskEditNode, maskNaturalSize])

  return { maskEditNode, resolvedMaskAssetUrl, maskNaturalSize }
}
