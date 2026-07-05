import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererMode } from './rendererMode'
import { isEngineLodRequested } from './engineLodMode'

/**
 * 0b spike — Phase 2b 正式化时按 phase2b-adapter-camera-zorder.md 重构。
 *
 * leafer 模式下 image / frame / markup shape(rect/ellipse/note) /
 * markup line/arrow(含 connector、derivation edge) 由 Leafer 真画，
 * 不再渲染 DOM 节点。其余类型（text / markdown / ai-slot / task-placeholder /
 * markup brush/stamp 等）继续走 DOM。
 *
 * Phase 4a 把 shape 集从 spike 的 markup-rect 扩到 rect/ellipse/note（frame 已在
 * 0b 集内）；Phase 4b 加入 line/arrow/connector；brush/stamp 归 4c，静态文本归
 * Phase 5。
 *
 * 已知取舍（Phase 5 前）：markup 的文字层（MarkupTextLayer —— note 的正文、
 * rect/ellipse 的标注文字、line/arrow 的线上 label）随 DOM 节点一起被过滤，
 * leafer 模式下暂不可见/不可编辑 —— 与 spike 已有的 markup-rect 行为一致，
 * Phase 5 静态文本 spike 决定去向。line/arrow 因此也不画 label 缺口
 * （leaferLinePaint.ts 画完整单段线）。
 */

/** Phase 4a shape 集：frame(section) + markup rect/ellipse/note。
 *  leaferShapePaint.ts 消费同一谓词，保证 filter（DOM 不画）与 paint（Leafer 画）
 *  永远同集，不会出现两边都画/两边都不画。 */
export const isLeaferShapePaintedNode = (node: MivoCanvasNode): boolean =>
  node.type === 'frame' ||
  (node.type === 'markup' &&
    (node.markupKind === 'rect' || node.markupKind === 'ellipse' || node.markupKind === 'note'))

/** Phase 4b line 集：markup line/arrow —— connector 与 derivation edge 就是带
 *  binding 的 line/arrow markup 节点，同属此集。leaferLinePaint.ts 消费同一谓词
 *  （filter/paint 同集约定同上）。 */
export const isLeaferLinePaintedNode = (node: MivoCanvasNode): boolean =>
  node.type === 'markup' && (node.markupKind === 'line' || node.markupKind === 'arrow')

export const isLeaferSpikePainted = (node: MivoCanvasNode): boolean =>
  node.type === 'image' || isLeaferShapePaintedNode(node) || isLeaferLinePaintedNode(node)

/** Pixi spike 谓词冻结在 0b 集（image/frame/markup-rect/text）：pixi 已 NO-GO
 *  （engine-combo-0g），其 paint 分支不扩 4a shape 集，避免 pixi 模式下 DOM 被
 *  过滤而 pixi 只会画矩形的 ellipse/note 视觉错位。 */
export const isPixiSpikePainted = (node: MivoCanvasNode): boolean =>
  node.type === 'image' ||
  node.type === 'frame' ||
  (node.type === 'markup' && node.markupKind === 'rect') ||
  node.type === 'text'

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
