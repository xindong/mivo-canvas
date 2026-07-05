import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererMode } from './rendererMode'
import { isEngineLodRequested } from './engineLodMode'

/**
 * 0b spike — Phase 2b 正式化时按 phase2b-adapter-camera-zorder.md 重构。
 *
 * leafer 模式下 image / frame / markup-rect 由 LeaferRenderer 真画，不再渲染 DOM 节点，
 * 否则测不出渲染性能差异。其余类型（text / markdown / ai-slot / task-placeholder /
 * markup 非 rect / connector 等）继续走 DOM。
 *
 * spike 只画三类（image/frame/rect）是 0b 规模验证的最小集；Phase 3+ 才扩展到
 * line/brush/stamp/static-text 等其余 paint 类型。
 */

export const isLeaferSpikePainted = (node: MivoCanvasNode): boolean =>
  node.type === 'image' ||
  node.type === 'frame' ||
  (node.type === 'markup' && node.markupKind === 'rect')

export const isPixiSpikePainted = (node: MivoCanvasNode): boolean =>
  isLeaferSpikePainted(node) || node.type === 'text'

const isLeaferDomFiltered = (node: MivoCanvasNode): boolean =>
  isLeaferSpikePainted(node) || (isEngineLodRequested && node.type === 'text')

/**
 * leafer 模式下从 DOM 渲染列表里剔除已被 Leafer 画的节点。
 * dom 模式原样返回（默认行为零变化）。
 */
export const filterDomNodesForRendererSpike = (
  nodes: MivoCanvasNode[],
  rendererMode: RendererMode,
): MivoCanvasNode[] =>
  rendererMode === 'leafer'
    ? nodes.filter((node) => !isLeaferDomFiltered(node))
    : rendererMode === 'pixi'
      ? nodes.filter((node) => !isPixiSpikePainted(node))
      : nodes

export const filterDomNodesForLeaferSpike = filterDomNodesForRendererSpike
