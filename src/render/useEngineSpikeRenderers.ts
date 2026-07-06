import { useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import { filterDomNodesForRendererSpike, isLeaferSpikePainted } from './leaferSpikeFilter'
import { rendererMode } from './rendererMode'
import { computeEffectiveRendererMode } from './rendererFallback'
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
  selectedNodeIds,
}: {
  hostRef: MutableRefObject<HTMLDivElement | null>
  viewport: ViewportState
  visibleNodes: MivoCanvasNode[]
  canvasRenderedNodes: MivoCanvasNode[]
  isPanning: boolean
  /** MivoCanvas editingTextNodeId —— FU-11 markup 文字壳在编辑空文字时也保留。 */
  editingNodeId?: string
  /** 选中的节点 id 数组（MivoCanvas store 的 selectedNodeIds）—— leafer 模式下
   *  选中 image/stamp 保留纯选中 DOM 壳（外框 + resize handle），否则选中态
   *  外框随 DOM 壳被过滤掉。hook 内 memo 成 Set 给 filter 做 O(1) 命中。 */
  selectedNodeIds: string[]
}) => {
  const pixiSpikeStats = usePixiSpikeRenderer({ hostRef, viewport, nodes: visibleNodes, rendererMode })
  // 第一段：仅看 pixi fallback，决定喂给 leafer 的 rendererMode。pixi 失败时 leafer
  // 收到 'dom'——注意 useLeaferSpikeRenderer 的 init effect 对 dom+leafer 都 init
  // （空白 canvas，仅 'pixi' 早退），故这里不阻止 Leafer init，只是让 leafer 走 dom
  // 分支不 paint、effectiveRendererMode 最终降到 dom 让 DOM 接管全部节点。
  const pixiEffectiveMode = computeEffectiveRendererMode(rendererMode, pixiSpikeStats.fallbackToDom, false)
  // Memo 成 Set 给 filter 做 O(1) 命中；dep 选数组（store 稳定引用），Set 随之稳定，
  // 避免 renderedNodes useMemo 每次重跑触发 paint。
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  // Greptile P2（hook 顺序前移）：useLeaferSpikeRenderer 必须在 renderedNodes useMemo
  // 之前调用——renderedNodes 依赖 effectiveRendererMode（line 53），而 effectiveRendererMode
  // 依赖 leaferSpikeStats.fallbackToDom。若把 leafer 挪回 renderedNodes 之后，leafer init
  // 失败时 renderedNodes 会用 stale（pixi-only）mode 过滤掉 leafer-painted 节点 → 白屏一帧，
  // 违反 R1 SC"非白屏"。故此顺序是**数据依赖必需**，非可选项。
  // HMR 安全：hook 顺序在每次 render 固定（5 个 hook 全非条件调用），正常 runtime 不会触发
  // "fewer hooks"；Fast-Refresh 改文件时的瞬态告警 full reload 即恢复，生产无 HMR 不受影响。
  const leaferSpikeStats = useLeaferSpikeRenderer({
    hostRef,
    viewport,
    nodes: visibleNodes,
    rendererMode: pixiEffectiveMode,
    isPanning,
    editingNodeId,
  })
  // 第二段：再看 leafer fallback，算最终 effectiveRendererMode。leafer init 抛错时
  // leaferSpikeStats.fallbackToDom=true → 降到 'dom'，renderedNodes 不再被 leafer 过滤，
  // DOM 渲染全部节点（非白屏）。
  const effectiveRendererMode = computeEffectiveRendererMode(
    rendererMode,
    pixiSpikeStats.fallbackToDom,
    leaferSpikeStats.fallbackToDom,
  )
  const renderedNodes = useMemo(
    () =>
      filterDomNodesForRendererSpike(canvasRenderedNodes, effectiveRendererMode, {
        editingNodeId,
        viewportScale: viewport.scale,
        selectedNodeIds: selectedNodeIdSet,
      }),
    [canvasRenderedNodes, editingNodeId, effectiveRendererMode, viewport.scale, selectedNodeIdSet],
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
