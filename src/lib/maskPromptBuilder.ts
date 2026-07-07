// src/lib/maskPromptBuilder.ts
// 双图局部重绘的最终提示词「外壳包裹」（用户 2026-07-07 实测结构定型）：
//   图1 = 干净原图（编辑基底）、图2 = 红圈标注副本（定位参考）。
// 「编辑要求」正文由 LLM 结构化整理生成（src/lib/maskEditCompose.ts，按红圈①②③
// 逐条拆分用户意图 + 补保护句），本模块只负责套上固定的图1/图2 头 + 复查尾，
// 并提供锚点方位计算（喂给整理器）。在前端拼装：聊天卡片直接展示逐字最终提示词。

import type { ImageMaskBounds } from '../canvas/imageMaskGeometry'

const promptHeader =
  '帮我对图1进行优化修改。我在图2上圈出了编辑的具体位置，请分析图2的红圈内容，在图1的画面中做针对性修改。'
const promptFooter = '务必每一条都严格执行并复查。'

/** 用图1/图2 结构外壳包裹「编辑要求」正文。body 为空时只返回头尾。 */
export const buildDualImagePrompt = (body: string): string => {
  return `${promptHeader}\n编辑要求：\n${body.trim()}\n${promptFooter}`
}

/**
 * 极端位置词（最左侧/最右侧/最上方/最下方）：仅多圈时按圆心在「散布更大的那根
 * 轴」上的极值计算；中间的圈返回 undefined。喂给整理器帮助它区分红圈，避免方位
 * 幻觉。顺序与传入 bounds 一致（即红圈编号顺序）。
 */
export const anchorPositions = (boundsList: ImageMaskBounds[]): (string | undefined)[] => {
  if (boundsList.length < 2) return boundsList.map(() => undefined)
  const centers = boundsList.map((bounds) => ({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }))
  const xs = centers.map((center) => center.x)
  const ys = centers.map((center) => center.y)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  const horizontal = spreadX >= spreadY
  const values = horizontal ? xs : ys
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max - min <= 0) return boundsList.map(() => undefined)
  return values.map((value) => {
    if (value === min) return horizontal ? '最左侧' : '最上方'
    if (value === max) return horizontal ? '最右侧' : '最下方'
    return undefined
  })
}
