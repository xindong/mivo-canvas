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
 * FU-12：frame(section) 标题同样收口——leaferShapePaint 只画 frame 盒体不画
 * 标题，此前 dom-frame-title 随 DOM 被过滤（未记录的取舍）。现对"标题可见且
 * 非空"的 frame 放行 DOM 节点，CanvasNodeView 只渲染 dom-frame-title
 * （frame-title-overlay 壳）。无标题/隐藏标题不产生空壳；LOD 全景态与 markup
 * 文字壳同口径隐藏。改名交互（双击 → window.prompt）走画布 hit-test，本就
 * 不依赖 DOM 节点，两模式一致。
 *
 * 4c 已知取舍（V2 已消除）：stamp 的 just-placed 落地动画（stamp-pop 弹跳 +
 *  impact 放射线）现由 leaferStampFx 在 leafer 模式原生复现（pop 作用于 sticker
 *  Rect，impact lines 是 Group 内兄弟，420ms 后销毁）；绘制中的 brush 预览是
 *  MivoCanvas 的 overlay SVG（非节点），两种模式都保持 DOM，落笔成节点后才由
 *  Leafer 接手。
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
  /** 选中的节点 id 集合。leafer 模式下被 Leafer 真画的 image/stamp 节点选中时，
   *  保留一个"纯选中 DOM 壳"承载 .dom-node.selected 外框 + resize handles
   *  （本体仍由 Leafer 真画，DOM 壳不画 <img>/贴纸）。未选中节点不产生空壳
   *  （虚拟化省下的 DOM 不加回来）。 */
  selectedNodeIds?: ReadonlySet<string>
}

/** 拥有 MarkupTextLayer 的 Leafer 真画集：stamp 以外的全部 markup——
 *  MarkupNodeView 对 note/rect/ellipse/brush/line/arrow 都渲染 MarkupTextLayer，
 *  且 isEditableTextNode 只排除 stamp（brush 也能双击编辑文字）。frame 标题
 *  是 dom-frame-title，非 MarkupTextLayer（FU-12 另立 needsFrameTitleShell）。 */
export const hasMarkupTextLayer = (node: MivoCanvasNode): boolean =>
  node.type === 'markup' && node.markupKind !== 'stamp'

/** 0g 口径：全景 LOD 态文字随降级隐藏。本体不参与 LOD（纯矢量），文字壳按
 *  与 image/text 相同的屏幕投影阈值(engineSpikeLod)隐藏。 */
const passesTextShellLod = (node: MivoCanvasNode, options: MarkupTextShellOptions): boolean => {
  const lodRequested = options.lodRequested ?? isEngineLodRequested
  if (!lodRequested) return true
  const scale = options.viewportScale ?? 1
  const thresholdPx = options.lodThresholdPx ?? engineLodThresholdPx
  return Math.max(Math.abs(node.width), Math.abs(node.height)) * scale >= thresholdPx
}

/** leafer 模式下该节点是否保留"纯文字 DOM 壳"（CanvasNodeView markup-text-overlay）。 */
export const needsMarkupTextShell = (
  node: MivoCanvasNode,
  options: MarkupTextShellOptions = {},
): boolean => {
  if (!hasMarkupTextLayer(node)) return false
  if (!node.text?.trim() && node.id !== options.editingNodeId) return false
  return passesTextShellLod(node, options)
}

/** FU-12: leafer 模式下 frame 是否保留"纯标题 DOM 壳"（CanvasNodeView
 *  frame-title-overlay）。标题隐藏（sectionTitleVisible=false）或为空 → 无壳；
 *  改名走 window.prompt，无编辑态壳需求（对比 markup 的 editingNodeId）。 */
export const needsFrameTitleShell = (
  node: MivoCanvasNode,
  options: MarkupTextShellOptions = {},
): boolean => {
  if (node.type !== 'frame') return false
  if (node.sectionTitleVisible === false || !node.title?.trim()) return false
  return passesTextShellLod(node, options)
}

/** leafer 模式下 image 节点选中时保留"纯选中 DOM 壳"。image 本体由
 *  leaferImagePaint 真画，DOM 壳不画 <img>，只承载 .dom-node.selected 的
 *  outline/box-shadow + primarySelected 时的 4 角 resize handle——否则 leafer
 *  模式下点选 image 选中态外框会随 DOM 壳一起被过滤掉（次级工具条独立定位
 *  仍显示，故表现为"只丢外框"）。未选中 image 不产生空壳。 */
export const needsImageSelectionShell = (
  node: MivoCanvasNode,
  options: MarkupTextShellOptions = {},
): boolean => node.type === 'image' && Boolean(options.selectedNodeIds?.has(node.id))

/** leafer 模式下 stamp 选中时保留"纯选中 DOM 壳"。stamp 本体由
 *  leaferBrushStampPaint 的 Group/sticker 真画；DOM 壳只承载 .dom-node.selected
 *  外框 + 4 角等比 resize handle，不渲染 dom-markup-stamp。 */
export const needsStampSelectionShell = (
  node: MivoCanvasNode,
  options: MarkupTextShellOptions = {},
): boolean =>
  node.type === 'markup' &&
  node.markupKind === 'stamp' &&
  Boolean(options.selectedNodeIds?.has(node.id))

/**
 * leafer 模式下从 DOM 渲染列表里剔除已被 Leafer 画的节点；FU-11 起对需要
 * 文字层的 markup 节点放行（CanvasNodeView 渲染纯文字壳），FU-12 起对标题
 * 可见的 frame 放行（纯标题壳），image/stamp 选中时放行纯选中壳（外框 + handle）。
 * dom 模式原样返回（默认行为零变化）。
 */
export const filterDomNodesForRendererSpike = (
  nodes: MivoCanvasNode[],
  rendererMode: RendererMode,
  textShellOptions: MarkupTextShellOptions = {},
): MivoCanvasNode[] =>
  rendererMode === 'leafer'
    ? nodes.filter(
        (node) =>
          !isLeaferDomFiltered(node) ||
          needsMarkupTextShell(node, textShellOptions) ||
          needsFrameTitleShell(node, textShellOptions) ||
          needsImageSelectionShell(node, textShellOptions) ||
          needsStampSelectionShell(node, textShellOptions),
      )
    : rendererMode === 'pixi'
      ? nodes.filter((node) => !isPixiSpikePainted(node))
      : nodes

export const filterDomNodesForLeaferSpike = filterDomNodesForRendererSpike
