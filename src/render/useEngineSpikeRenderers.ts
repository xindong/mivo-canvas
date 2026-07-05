import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { filterDomNodesForRendererSpike } from './leaferSpikeFilter'
import { rendererMode } from './rendererMode'
import { useLeaferSpikeRenderer, type ViewportState } from './useLeaferSpikeRenderer'
import { usePixiSpikeRenderer } from './usePixiSpikeRenderer'
import { engineLodDataAttrsFor } from './engineSpikeLod'

export const useEngineSpikeRenderers = ({
  hostRef,
  viewport,
  visibleNodes,
  canvasRenderedNodes,
  isPanning,
}: {
  hostRef: MutableRefObject<HTMLDivElement | null>
  viewport: ViewportState
  visibleNodes: MivoCanvasNode[]
  canvasRenderedNodes: MivoCanvasNode[]
  isPanning: boolean
}) => {
  const pixiSpikeStats = usePixiSpikeRenderer({ hostRef, viewport, nodes: visibleNodes, rendererMode })
  const effectiveRendererMode = pixiSpikeStats.fallbackToDom ? 'dom' : rendererMode
  const renderedNodes = useMemo(
    () => filterDomNodesForRendererSpike(canvasRenderedNodes, effectiveRendererMode),
    [canvasRenderedNodes, effectiveRendererMode],
  )
  const leaferSpikeStats = useLeaferSpikeRenderer({
    hostRef,
    viewport,
    nodes: visibleNodes,
    rendererMode: effectiveRendererMode,
    isPanning,
  })
  const engineSpikeDataAttrs = useMemo(
    () => ({
      'data-renderer-mode': effectiveRendererMode,
      'data-leafer-expected-children': leaferSpikeStats.expectedChildren,
      'data-leafer-children': leaferSpikeStats.children,
      'data-leafer-pixel-nonempty': leaferSpikeStats.pixelNonEmpty ? 'true' : 'false',
      'data-leafer-pixel-sample-count': leaferSpikeStats.pixelSampleCount,
      'data-leafer-sync-version': leaferSpikeStats.syncVersion,
      'data-leafer-pan-cache-enabled': leaferSpikeStats.panCacheEnabled ? 'true' : 'false',
      'data-leafer-pan-cache-frozen': leaferSpikeStats.panCacheFrozen ? 'true' : 'false',
      'data-leafer-pan-cache-captures': leaferSpikeStats.panCacheCaptures,
      'data-leafer-pan-cache-last-dx': leaferSpikeStats.panCacheLastDeltaX,
      'data-leafer-pan-cache-last-dy': leaferSpikeStats.panCacheLastDeltaY,
      'data-pixi-expected-children': pixiSpikeStats.expectedChildren,
      'data-pixi-children': pixiSpikeStats.children,
      'data-pixi-pixel-nonempty': pixiSpikeStats.pixelNonEmpty ? 'true' : 'false',
      'data-pixi-pixel-sample-count': pixiSpikeStats.pixelSampleCount,
      'data-pixi-sync-version': pixiSpikeStats.syncVersion,
      'data-pixi-text-strategy': pixiSpikeStats.textStrategy,
      'data-pixi-texture-pool-size': pixiSpikeStats.texturePoolSize,
      ...engineLodDataAttrsFor(effectiveRendererMode, leaferSpikeStats, pixiSpikeStats),
    }),
    [effectiveRendererMode, leaferSpikeStats, pixiSpikeStats],
  )

  return { renderedNodes, engineSpikeDataAttrs }
}
