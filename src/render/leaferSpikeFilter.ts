import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererMode } from './rendererMode'
import { engineLodThresholdPx, isEngineLodRequested } from './engineLodMode'
import { isLeaferTextPaintRequested } from './textPaintMode'

/**
 * 0b spike — Phase 2b 正式化时按 phase2b-adapter-camera-zorder.md 重构。
 *
 * leafer 模式下 image / frame / markup shape(rect/ellipse/note) /
 * markup line/arrow(含 connector、derivation edge) / markup brush/stamp
 * 由 Leafer 真画，不再渲染 DOM 节点。其余类型（text / markdown / ai-slot /
 * task-placeholder 等）继续走 DOM。
 *
 * Phase 4a 把 shape 集从 spike 的 markup-rect 扩到 rect/ellipse/note（frame 已在
 * 0b 集内）；Phase 4b 加入 line/arrow/connector；Phase 4c 加入 brush/stamp；
 * 静态文本归 Phase 5。
 *
 * FU-11（Phase 5 判决"文本永久留 DOM"后收口）：markup 的文字层
 * （MarkupTextLayer —— note 的正文、rect/ellipse 的标注文字、line/arrow 的
 * 线上 label）在 leafer 模式恢复为"纯文字 DOM 壳"——本体仍由 Leafer 真画，
 * filter 对有文字（或编辑中）的 markup 节点放行 DOM 节点，CanvasNodeView 检测
 * 到 leafer 模式 + Leafer 真画节点时只渲染 MarkupTextLayer（markup-text-overlay
 * 壳）。无文字且不在编辑的 markup 不产生空壳（虚拟化省下的 DOM 不加回来）；
 * bench-only engine LOD 全景态下文字壳随降级隐藏（0g 口径）。line/arrow 的
 * label 缺口由 leaferLinePaint 按同一份 markupTextGeometry 数学补画。
 *
 * 4c 已知取舍：stamp 的 just-placed 落地动画（stamp-pop 弹跳 + impact 放射线，
 * App.css DOM-only 转瞬效果）在 leafer 模式暂不复现 —— 与 note 文本层同级的
 * 接受损失；绘制中的 brush 预览是 MivoCanvas 的 overlay SVG（非节点），两种
 * 模式都保持 DOM，落笔成节点后才由 Leafer 接手。
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

/** Phase 4c brush/stamp 集：markup brush（画笔/荧光笔笔迹）+ stamp（图章）。
 *  leaferBrushStampPaint.ts 消费同一谓词（filter/paint 同集约定同上）。 */
export const isLeaferBrushStampPaintedNode = (node: MivoCanvasNode): boolean =>
  node.type === 'markup' && (node.markupKind === 'brush' || node.markupKind === 'stamp')

export const isLeaferSpikePainted = (node: MivoCanvasNode): boolean =>
  node.type === 'image' ||
  isLeaferShapePaintedNode(node) ||
  isLeaferLinePaintedNode(node) ||
  isLeaferBrushStampPaintedNode(node)

/** Pixi spike 谓词冻结在 0b 集（image/frame/markup-rect/text）：pixi 已 NO-GO
 *  （engine-combo-0g），其 paint 分支不扩 4a shape 集，避免 pixi 模式下 DOM 被
 *  过滤而 pixi 只会画矩形的 ellipse/note 视觉错位。 */
export const isPixiSpikePainted = (node: MivoCanvasNode): boolean =>
  node.type === 'image' ||
  node.type === 'frame' ||
  (node.type === 'markup' && node.markupKind === 'rect') ||
  node.type === 'text'

/** Phase 5 spike:`?textPaint=leafer` 时 text 节点(type='text',annotation 是
 *  独立类型不受影响)交给 Leafer Text 绘制,DOM 侧同集过滤。默认 off,
 *  生产 leafer 模式行为不变。 */
export const isLeaferTextSpikePaintedNode = (node: MivoCanvasNode): boolean =>
  isLeaferTextPaintRequested && node.type === 'text'

const isLeaferDomFiltered = (node: MivoCanvasNode): boolean =>
  isLeaferSpikePainted(node) ||
  isLeaferTextSpikePaintedNode(node) ||
  (isEngineLodRequested && node.type === 'text')

/** FU-11: markup 文字层壳的判定输入。lodRequested/lodThresholdPx 默认取
 *  模块常量（URL flag），参数化只为单测可注入。 */
export type MarkupTextShellOptions = {
  /** MivoCanvas 的 editingTextNodeId —— 空文字 markup 双击进入编辑时也要有壳。 */
  editingNodeId?: string
  /** 当前 viewport.scale，engine LOD 全景态判定用（文字随降级隐藏）。 */
  viewportScale?: number
  lodRequested?: boolean
  lodThresholdPx?: number
}

/** 拥有 MarkupTextLayer 的 Leafer 真画集：stamp 以外的全部 markup——
 *  MarkupNodeView 对 note/rect/ellipse/brush/line/arrow 都渲染 MarkupTextLayer，
 *  且 isEditableTextNode 只排除 stamp（brush 也能双击编辑文字）。frame 标题
 *  是 dom-frame-title，非 MarkupTextLayer，不在本集。 */
export const hasMarkupTextLayer = (node: MivoCanvasNode): boolean =>
  node.type === 'markup' && node.markupKind !== 'stamp'

/** leafer 模式下该节点是否保留"纯文字 DOM 壳"（CanvasNodeView markup-text-overlay）。 */
export const needsMarkupTextShell = (
  node: MivoCanvasNode,
  options: MarkupTextShellOptions = {},
): boolean => {
  if (!hasMarkupTextLayer(node)) return false
  if (!node.text?.trim() && node.id !== options.editingNodeId) return false

  const lodRequested = options.lodRequested ?? isEngineLodRequested
  if (!lodRequested) return true
  // 0g 口径：全景 LOD 态文字随降级隐藏。markup 本体不参与 LOD（纯矢量），
  // 文字壳按与 image/text 相同的屏幕投影阈值(engineSpikeLod)隐藏。
  const scale = options.viewportScale ?? 1
  const thresholdPx = options.lodThresholdPx ?? engineLodThresholdPx
  return Math.max(Math.abs(node.width), Math.abs(node.height)) * scale >= thresholdPx
}

/**
 * leafer 模式下从 DOM 渲染列表里剔除已被 Leafer 画的节点；FU-11 起对需要
 * 文字层的 markup 节点放行（CanvasNodeView 渲染纯文字壳）。
 * dom 模式原样返回（默认行为零变化）。
 */
export const filterDomNodesForRendererSpike = (
  nodes: MivoCanvasNode[],
  rendererMode: RendererMode,
  textShellOptions: MarkupTextShellOptions = {},
): MivoCanvasNode[] =>
  rendererMode === 'leafer'
    ? nodes.filter((node) => !isLeaferDomFiltered(node) || needsMarkupTextShell(node, textShellOptions))
    : rendererMode === 'pixi'
      ? nodes.filter((node) => !isPixiSpikePainted(node))
      : nodes

export const filterDomNodesForLeaferSpike = filterDomNodesForRendererSpike
