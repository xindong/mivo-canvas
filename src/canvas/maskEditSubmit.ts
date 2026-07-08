// 从 ImageMaskEditOverlay 机械抽离(structure guard >900),行为不变。
// 提交装配:subjects 构建 + 锚点方位编排 + 结构化提示词组装 + 红圈标注图 +
// onSubmit payload 组装。纯函数,依赖通过参数进;mask 由 submit 外部 await
// buildEditMaskBlob 后传入(保留 try 块内的顺序与 in-flight guard 语义)。
import {
  boundsForRegions,
  maskEditDefaultModel,
  maskEditQualityFor,
  type ImageMaskBounds,
  type ImageMaskRegion,
  type ImageMaskSubmitPayload,
} from './imageMaskGeometry'
import { anchorPositions, buildDualImagePrompt } from '../lib/maskPromptBuilder'
import { composeMaskEditBody } from '../lib/maskEditCompose'
import { buildAnchorMarkedImage, type MarkedShape } from '../lib/regionDescribe'
import { recognitionLabel, type AnchorRecognition } from './useMaskAnchorRecognition'

type NaturalSize = { width: number; height: number }
type RecognitionsRef = { current: Record<string, AnchorRecognition> }
type Mask = ImageMaskSubmitPayload['mask']

export async function buildMaskEditSubmission({
  body,
  regions,
  naturalSize,
  resolvedAssetUrl,
  recognitionsRef,
  regionKey,
  mask,
}: {
  body: string
  regions: ImageMaskRegion[]
  naturalSize: NaturalSize
  resolvedAssetUrl: string
  recognitionsRef: RecognitionsRef
  regionKey: (region: ImageMaskRegion) => string
  mask: Mask
}): Promise<ImageMaskSubmitPayload> {
  // 多锚点：每个锚点带识别标签 + 自身 bounds（供红圈标注图 + 兜底用）。
  const subjects = regions
    .map((region) => {
      const label = recognitionLabel(recognitionsRef.current[regionKey(region)])
      const bounds = boundsForRegions([region], naturalSize)
      return label && bounds ? { label, bounds } : undefined
    })
    .filter((subject): subject is { label: string; bounds: ImageMaskBounds } => Boolean(subject))
  // 结构化整理：把用户大意按红圈①②③（标签+方位）拆成逐条编辑要求（LLM，
  // gpt-5.4-mini）。方位由 bounds 算好喂给整理器。失败/降级 → 静默回退到直接
  // 用原文当正文，绝不阻塞出图。整理结果 + 外壳 = 最终提示词，聊天卡片逐字展示。
  const anchorBounds = regions.map((region) => boundsForRegions([region], naturalSize) as ImageMaskBounds)
  const positions = anchorPositions(anchorBounds)
  const composeAnchors = regions.map((region, index) => {
    const rec = recognitionsRef.current[regionKey(region)]
    return {
      n: index + 1,
      label: recognitionLabel(rec) || `目标${index + 1}`,
      position: positions[index],
      // 画面别处有无同类（识别步判定，缺省 true 保守）→ compose 据此决定加不加保护句。
      hasDuplicate: rec?.hasDuplicate !== false,
    }
  })
  const composedBody = await composeMaskEditBody(body, composeAnchors)
  const finalPrompt = buildDualImagePrompt(composedBody ?? body)
  // 单图指认（Set-of-Mark）：把用户画的选区所见即所得地用红色画到全图副本上
  //（点选=自动红圈、矩形/椭圆=红框/红椭圆、圈选=手绘闭合红圈,序号与画布/
  // 标签一致），这张副本就是发给 nano-banana 的编辑图。生成失败则静默退回
  // 纯文字定位，不阻塞提交。
  const markShapes = regions
    .map((region, index): MarkedShape | undefined => {
      const n = index + 1
      if (region.type === 'brush' && region.points.length === 1) {
        return { kind: 'point', x: region.points[0].x, y: region.points[0].y, n }
      }
      if (region.type === 'box') {
        return { kind: 'rect', bounds: { x: region.x, y: region.y, width: region.width, height: region.height }, n }
      }
      if (region.type === 'ellipse') {
        return { kind: 'ellipse', bounds: { x: region.x, y: region.y, width: region.width, height: region.height }, n }
      }
      if (region.type === 'loop') return { kind: 'loop', points: region.points, n }
      return undefined
    })
    .filter((shape): shape is MarkedShape => Boolean(shape))
  const markedImage =
    markShapes.length && resolvedAssetUrl
      ? await buildAnchorMarkedImage(resolvedAssetUrl, naturalSize, markShapes)
      : null
  return {
    prompt: finalPrompt,
    mask,
    maskBounds: regions.length ? boundsForRegions(regions, naturalSize) : undefined,
    sourceSize: naturalSize,
    model: maskEditDefaultModel,
    quality: maskEditQualityFor(maskEditDefaultModel),
    subjects: subjects.length ? subjects : undefined,
    markedImage: markedImage ?? undefined,
  }
}
