import { useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import { filterDomNodesForRendererSpike, isLeaferSpikePainted } from './leaferSpikeFilter'
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
  editingNodeId,
}: {
  hostRef: MutableRefObject<HTMLDivElement | null>
  viewport: ViewportState
  visibleNodes: MivoCanvasNode[]
  canvasRenderedNodes: MivoCanvasNode[]
  isPanning: boolean
  /** MivoCanvas editingTextNodeId —— FU-11 markup 文字壳在编辑空文字时也保留。 */
  editingNodeId?: string
}) => {
  const pixiSpikeStats = usePixiSpikeRenderer({ hostRef, viewport, nodes: visibleNodes, rendererMode })
  const effectiveRendererMode = pixiSpikeStats.fallbackToDom ? 'dom' : rendererMode
  const renderedNodes = useMemo(
    () =>
      filterDomNodesForRendererSpike(canvasRenderedNodes, effectiveRendererMode, {
        editingNodeId,
        viewportScale: viewport.scale,
      }),
    [canvasRenderedNodes, editingNodeId, effectiveRendererMode, viewport.scale],
  )
  // FU-11 可观测性：文字壳数量变化时记一条 Debug Log（数量不变不重复刷）。
  const textShellCountRef = useRef(0)
  const textShellCount = effectiveRendererMode === 'leafer'
    ? renderedNodes.reduce((count, node) => count + (isLeaferSpikePainted(node) ? 1 : 0), 0)
    : 0
  useEffect(() => {
    if (textShellCountRef.current === textShellCount) return
    textShellCountRef.current = textShellCount
    debugLogger.log('Renderer', `leafer markup 文字壳: ${textShellCount} 个 DOM overlay`)
  }, [textShellCount])
  const leaferSpikeStats = useLeaferSpikeRenderer({
    hostRef,
    viewport,
    nodes: visibleNodes,
    rendererMode: effectiveRendererMode,
    isPanning,
    editingNodeId,
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
      'data-leafer-markup-text-shells': textShellCount,
      'data-pixi-expected-children': pixiSpikeStats.expectedChildren,
      'data-pixi-children': pixiSpikeStats.children,
      'data-pixi-pixel-nonempty': pixiSpikeStats.pixelNonEmpty ? 'true' : 'false',
      'data-pixi-pixel-sample-count': pixiSpikeStats.pixelSampleCount,
      'data-pixi-sync-version': pixiSpikeStats.syncVersion,
      'data-pixi-text-strategy': pixiSpikeStats.textStrategy,
      'data-pixi-texture-pool-size': pixiSpikeStats.texturePoolSize,
      ...engineLodDataAttrsFor(effectiveRendererMode, leaferSpikeStats, pixiSpikeStats),
    }),
    [effectiveRendererMode, leaferSpikeStats, pixiSpikeStats, textShellCount],
  )

  return { renderedNodes, engineSpikeDataAttrs }
}
