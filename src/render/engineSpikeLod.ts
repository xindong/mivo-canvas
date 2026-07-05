import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import type { RendererMode } from './rendererMode'
import type { ViewportState } from './useLeaferSpikeRenderer'
import { engineLodMode, engineLodThresholdPx } from './engineLodMode'

export type EngineLodStats = {
  mode: 'on' | 'off'
  enabled: boolean
  thresholdPx: number
  lodNodeCount: number
  lodImageCount: number
  lodTextCount: number
  highFidelityNodeCount: number
}

export type EngineLodStatsCarrier = {
  lodMode: EngineLodStats['mode']
  lodEnabled: boolean
  lodThresholdPx: number
  lodNodeCount: number
  lodImageCount: number
  lodTextCount: number
  highFidelityNodeCount: number
}

const lodPalette = ['#9fb7d6', '#c4a47f', '#8fb99a', '#c58b93', '#a9a2ca', '#86b8c2']

const hashString = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const screenProjectionPxFor = (node: MivoCanvasNode, viewport: ViewportState): number =>
  Math.max(Math.abs(node.width), Math.abs(node.height)) * viewport.scale

export const shouldUseEngineLod = (node: MivoCanvasNode, viewport: ViewportState): boolean =>
  engineLodMode === 'on' &&
  (node.type === 'image' || node.type === 'text') &&
  screenProjectionPxFor(node, viewport) < engineLodThresholdPx

export const engineLodFillFor = (node: MivoCanvasNode): string => {
  if (node.type === 'text') return node.textColor || '#5f595d'
  return lodPalette[hashString(node.id) % lodPalette.length]
}

export const summarizeEngineLod = (nodes: MivoCanvasNode[], viewport: ViewportState): EngineLodStats => {
  let lodImageCount = 0
  let lodTextCount = 0

  for (const node of nodes) {
    if (!shouldUseEngineLod(node, viewport)) continue
    if (node.type === 'image') lodImageCount += 1
    if (node.type === 'text') lodTextCount += 1
  }

  const lodNodeCount = lodImageCount + lodTextCount
  return {
    mode: engineLodMode,
    enabled: engineLodMode === 'on',
    thresholdPx: engineLodThresholdPx,
    lodNodeCount,
    lodImageCount,
    lodTextCount,
    highFidelityNodeCount: nodes.length - lodNodeCount,
  }
}

export const emptyEngineLodStats = (): EngineLodStatsCarrier => ({
  lodMode: engineLodMode,
  lodEnabled: engineLodMode === 'on',
  lodThresholdPx: engineLodThresholdPx,
  lodNodeCount: 0,
  lodImageCount: 0,
  lodTextCount: 0,
  highFidelityNodeCount: 0,
})

export const withEngineLodStats = <T extends object>(stats: T, lodStats: EngineLodStats): T & EngineLodStatsCarrier => ({
  ...stats,
  lodMode: lodStats.mode,
  lodEnabled: lodStats.enabled,
  lodThresholdPx: lodStats.thresholdPx,
  lodNodeCount: lodStats.lodNodeCount,
  lodImageCount: lodStats.lodImageCount,
  lodTextCount: lodStats.lodTextCount,
  highFidelityNodeCount: lodStats.highFidelityNodeCount,
})

export const recordEngineLodSummary = (
  source: string,
  stats: EngineLodStats,
  previousSummaryRef: { current?: string },
) => {
  if (!stats.enabled) return
  const summary = `${stats.lodNodeCount}/${stats.lodImageCount}/${stats.lodTextCount}/${stats.thresholdPx}`
  if (previousSummaryRef.current === summary) return
  previousSummaryRef.current = summary
  debugLogger.log(
    'Renderer',
    `${source} LOD switch: ${stats.lodNodeCount} nodes (${stats.lodImageCount} image, ${stats.lodTextCount} text) below ${stats.thresholdPx}px`,
  )
}

export const engineLodDataAttrsFor = (
  rendererMode: RendererMode,
  leaferStats: EngineLodStatsCarrier,
  pixiStats: EngineLodStatsCarrier,
) => {
  const stats = rendererMode === 'leafer' ? leaferStats : rendererMode === 'pixi' ? pixiStats : emptyEngineLodStats()
  return {
    'data-engine-lod-mode': stats.lodMode,
    'data-engine-lod-enabled': stats.lodEnabled ? 'true' : 'false',
    'data-engine-lod-threshold-px': stats.lodThresholdPx,
    'data-engine-lod-node-count': stats.lodNodeCount,
    'data-engine-lod-image-count': stats.lodImageCount,
    'data-engine-lod-text-count': stats.lodTextCount,
    'data-engine-high-fidelity-node-count': stats.highFidelityNodeCount,
  }
}
