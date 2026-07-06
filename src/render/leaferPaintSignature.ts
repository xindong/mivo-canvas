import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'
import { shouldUseEngineLod } from './engineSpikeLod'

/**
 * PR-R2 per-node paint signature（R-03b 下沉）。每个 paint 模块在 entry 上存一份
 * signature；sync 时若 signature 未变 → 跳过 projectNode + set（drag 单节点时
 * 未变节点 0 工作，仅被拖节点 +1）。拖动只改 x/y，其余 999 节点签名不变 → 0 set。
 *
 * 字段集 = projectNode + sinkVisualDefaults + 四个模块 *PaintPropsFor 读取字段
 * 的并集。漏字段 = 该重画的不重画（视觉漂移），故此字段集是契约——
 * leaferPaintSignature.test.ts 锁定每个关键字段变更都能翻转签名。
 *
 * 覆盖范围：
 *  - geometry：x/y/width/height/rotation（所有模块）
 *  - 显式 fills/strokes 数组：projectNode 优先用 node 自带的，sinkVisualDefaults
 *    仅在无显式 visible solid fill/stroke 时才填默认。node 自带 fills/strokes
 *    时它们才是视觉真相，必须入签名（否则改 fills 不触发重画）。
 *  - image：assetUrl / imageCrop（image 模块；imageCrop 决定 crop child 几何）
 *  - text/fontSize：line label gap（linePaintPropsFor 读 r.text/r.fontSize）
 *  - markup 全集：Kind/BrushKind/StampKind/FillColor/StrokeColor/StrokeWidth/
 *    StrokeStyle/Opacity/Points/StartArrow/EndArrow/CornerRadius（shape/line/brush）
 *  - frame/section：frameColor/sectionFill/Border/Width/Style（shape frame 分支）
 *  - ctx 输入：LOD（shouldUseEngineLod，捕获 viewport.scale 对 kind 的影响）、
 *    zIndex（ctx.layerOf，文档序变化时需重 set）、isEditing（line label 缺口）
 *
 * 性能：JSON.stringify ~35 字段/节点，1000 节点 ≈ 1-2ms（远小于省下的 999 次
 * projectNode+set 的开销，net 净赚）。type/marmarkupKind 等标量在签名对象里是
 * 稳定 key，JSON 序列化代价低。
 */
export const paintSignatureFor = (
  node: MivoCanvasNode,
  ctx: RendererSyncContext,
): string =>
  JSON.stringify({
    type: node.type,
    // LOD boolean 捕获 viewport.scale 对 kind 切换的影响（HD 内部 scale 不影响输出，
    // 故无需把 scale 直接入签名；kind 切换由 lod 翻转体现）。
    lod: shouldUseEngineLod(node, ctx.viewport),
    // geometry
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.transform?.rotation,
    // 显式 fills/strokes（node 自带时为视觉真相）
    fills: node.fills,
    strokes: node.strokes,
    // image
    assetUrl: node.assetUrl,
    imageCrop: node.imageCrop,
    // text（line label gap）
    text: node.text,
    fontSize: node.fontSize,
    textColor: node.textColor,
    textAlign: node.textAlign,
    fontWeight: node.fontWeight,
    // markup
    markupKind: node.markupKind,
    markupBrushKind: node.markupBrushKind,
    markupStampKind: node.markupStampKind,
    markupFillColor: node.markupFillColor,
    markupStrokeColor: node.markupStrokeColor,
    markupStrokeWidth: node.markupStrokeWidth,
    markupStrokeStyle: node.markupStrokeStyle,
    markupOpacity: node.markupOpacity,
    markupPoints: node.markupPoints,
    markupStartArrow: node.markupStartArrow,
    markupEndArrow: node.markupEndArrow,
    markupCornerRadius: node.markupCornerRadius,
    // frame / section
    frameColor: node.frameColor,
    sectionFillColor: node.sectionFillColor,
    sectionBorderColor: node.sectionBorderColor,
    sectionBorderWidth: node.sectionBorderWidth,
    sectionBorderStyle: node.sectionBorderStyle,
    // ctx 输入
    zIndex: ctx.layerOf?.(node.id),
    isEditing: ctx.editingNodeId === node.id,
  })
