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

import { useEffect } from 'react'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import { useImageNaturalSize } from '../lib/useImageNaturalSize'
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
  const { naturalSize: maskNaturalSize } = useImageNaturalSize(
    resolvedMaskAssetUrl,
    maskEditNode?.assetSourceDimensions,
  )

  // logging invariant: a mask-edit target whose naturalSize never resolves would
  // silently never mount the overlay (caller gates on maskNaturalSize). Log so a
  // stuck asset (IDB miss + no onLoad report) is traceable in the debug log.
  useEffect(() => {
    if (maskEditNodeId && maskEditNode && !maskNaturalSize) {
      debugLogger.warn(
        'Mask Edit',
        `naturalSize unavailable for ${maskEditNodeId}; mask overlay waiting on asset metrics (cache/IDB/<img onLoad>)`,
      )
    }
  }, [maskEditNodeId, maskEditNode, maskNaturalSize])

  return { maskEditNode, resolvedMaskAssetUrl, maskNaturalSize }
}
