// src/canvas/maskEditDraftStore.ts
// 局部重绘锚点草稿仓（2026-07-08 用户）：浮层因失焦/切走/Esc/X 关闭时，把该图
// 已打的锚点（红圈 regions + pointAnchors）、识别态（候选/选中/自定义）和输入框
// 内容按 nodeId 记住；同一张图再次进入局部重绘时原样恢复。草稿只存内存（模块级
// Map，刷新即失，产品确认），两种情况清除：用户手动删光锚点、提交成功出图，
// 以及目标图片本身被删除（overlay 卸载时自检）。
import type { ImageMaskPoint, ImageMaskRegion } from './imageMaskGeometry'
import type { AnchorRecognition } from './useMaskAnchorRecognition'

export type MaskEditDraft = {
  regions: ImageMaskRegion[]
  pointAnchors: Array<{ center: ImageMaskPoint; radius: number }>
  recognitions: Record<string, AnchorRecognition>
  /** 富文本编辑器 innerHTML（chip token + 自由文本混排，原样快照/恢复）。 */
  editorHtml: string
}

const drafts = new Map<string, MaskEditDraft>()

/** 保存草稿；空锚点等价于清除（画布上什么都没圈就没有可记的）。 */
export const saveMaskEditDraft = (nodeId: string, draft: MaskEditDraft): void => {
  if (!draft.regions.length && !draft.pointAnchors.length) {
    drafts.delete(nodeId)
    return
  }
  drafts.set(nodeId, draft)
}

export const getMaskEditDraft = (nodeId: string): MaskEditDraft | undefined => drafts.get(nodeId)

export const clearMaskEditDraft = (nodeId: string): void => {
  drafts.delete(nodeId)
}
