// server/lib/maskRegion.ts
// Mask-edit via the nano-banana (Gemini) channel is instruction-based: the
// platform accepts no mask file, so the selected region must be described in
// the prompt. This helper turns maskBounds (+ sourceSize) into a spatial
// clause appended to the user's prompt.
//
// Bounds conventions in the wild (both accepted):
// - annotation area-edit sends normalized 0-1 bounds
// - the brush overlay computes pixel bounds against sourceSize
// Heuristic: width/height <= 1 ⇒ normalized; otherwise pixels ÷ sourceSize.

type RegionBounds = { x: number; y: number; width: number; height: number }
type RegionSize = { width: number; height: number }

// 全程中文（用户 2026-07-07：不要英文）。指令模型（nano-banana）对中文指令同样
// 听话，且用户的成功对照实验用的就是中文。
const genericClause =
  '只修改用户选中的区域。选区以外的一切保持与原图完全一致——构图、颜色、光照、风格都不变。不要在图上画出任何矩形、方框、边框、轮廓或选区标记。'

const parseJson = <T>(raw: string | undefined): T | undefined => {
  if (!raw || !raw.trim()) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const validBounds = (bounds: RegionBounds | undefined): bounds is RegionBounds =>
  Boolean(
    bounds &&
      isFiniteNumber(bounds.x) &&
      isFiniteNumber(bounds.y) &&
      isFiniteNumber(bounds.width) &&
      isFiniteNumber(bounds.height) &&
      bounds.width > 0 &&
      bounds.height > 0,
  )

const validSize = (size: RegionSize | undefined): size is RegionSize =>
  Boolean(size && isFiniteNumber(size.width) && isFiniteNumber(size.height) && size.width > 0 && size.height > 0)

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

// 3x3 网格中文方位命名。
const positionName = (centerX: number, centerY: number): string => {
  const horizontal = centerX < 1 / 3 ? '左' : centerX > 2 / 3 ? '右' : '中'
  const vertical = centerY < 1 / 3 ? '上' : centerY > 2 / 3 ? '下' : '中'
  if (horizontal === '中' && vertical === '中') return '正中'
  if (horizontal === '中') return vertical === '上' ? '顶部中间' : '底部中间'
  if (vertical === '中') return `中部偏${horizontal}`
  return `${vertical === '上' ? '上' : '下'}方偏${horizontal}`
}

// Sanitize the recognized subject label before it enters the prompt: strip
// newlines/quotes, cap length. Empty result ⇒ treated as no label.
const sanitizeSubjectLabel = (label: string | undefined): string =>
  (label || '').replace(/[\r\n"'{}<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)

// Reject-outside boilerplate shared by single- and multi-region clauses.
// Exclusivity sentence: instruction models match the subject NOUN far more
// eagerly than percentage coordinates — with two sword hilts in frame, "edit
// the 刀柄" edits whichever one the model fancies. Spell out that only the
// instance at the described position may change and all look-alikes stay put.
const keepOutsideClause = (plural: boolean): string =>
  `图中可能有多个相似的物体；只修改${plural ? '所描述位置的那几个' : '所描述位置的那一个'}，其余同类物体一律保持原样。` +
  `${plural ? '这些区域' : '该区域'}之外的一切保持与原图完全一致——构图、颜色、光照、风格都不变。` +
  '以上位置描述仅作定位参考：不要在图上画出任何矩形、方框、边框、轮廓或选区标记。'

// Describe one region as a locating noun phrase ("the blue clouds located in the
// top center (roughly 12% of the width ...)"). Returns undefined when the bounds
// are unusable. `subject` empty ⇒ describe by area only.
const describeRegionPhrase = (
  bounds: RegionBounds | undefined,
  size: RegionSize | undefined,
  subject: string,
): string | undefined => {
  if (!validBounds(bounds)) return undefined
  const normalized = bounds.width <= 1 && bounds.height <= 1
  let x = bounds.x
  let y = bounds.y
  let width = bounds.width
  let height = bounds.height
  if (!normalized) {
    if (!validSize(size)) return undefined
    x /= size.width
    y /= size.height
    width /= size.width
    height /= size.height
  }
  const centerX = clamp01(x + width / 2)
  const centerY = clamp01(y + height / 2)
  const widthPct = Math.round(clamp01(width) * 100)
  const heightPct = Math.round(clamp01(height) * 100)
  const centerXPct = Math.round(centerX * 100)
  const centerYPct = Math.round(centerY * 100)
  const head = subject
    ? `位于图片${positionName(centerX, centerY)}的${subject}`
    : `位于图片${positionName(centerX, centerY)}的区域`
  return `${head}（约占画面宽 ${widthPct}%、高 ${heightPct}%，中心在左起 ${centerXPct}%、上起 ${centerYPct}% 处）`
}

/**
 * Build the spatial clause for instruction-based mask edits. When the anchor
 * recognizer produced a subject label, lead with the semantic target ("the
 * blue clouds") — instruction models localize objects far better than
 * percentages. Returns the generic keep-everything-else clause when bounds
 * are missing or malformed — never throws, never blocks the edit.
 */
export const maskRegionPromptClause = (
  maskBoundsJson?: string,
  sourceSizeJson?: string,
  subjectLabel?: string,
): string => {
  const subject = sanitizeSubjectLabel(subjectLabel)
  const size = parseJson<RegionSize>(sourceSizeJson)
  const phrase = describeRegionPhrase(parseJson<RegionBounds>(maskBoundsJson), size, subject)
  if (!phrase) {
    return subject ? `用户选中了：${subject}。${genericClause}` : genericClause
  }
  return `只修改${phrase}。${keepOutsideClause(false)}`
}

type MaskSubject = { label?: unknown; bounds?: RegionBounds }

/**
 * Multi-region variant (Lovart-style multi-anchor): the user marked several
 * objects, each with its own recognized label + bounds. Builds a numbered list
 * of locating phrases. Returns undefined when no subject is usable, so the
 * caller can fall back to the single-region clause.
 */
export const maskSubjectsPromptClause = (
  subjectsJson?: string,
  sourceSizeJson?: string,
): string | undefined => {
  const subjects = parseJson<MaskSubject[]>(subjectsJson)
  if (!Array.isArray(subjects) || !subjects.length) return undefined
  const size = parseJson<RegionSize>(sourceSizeJson)
  const phrases = subjects
    .map((subject) =>
      describeRegionPhrase(subject?.bounds, size, sanitizeSubjectLabel(subject?.label as string | undefined)),
    )
    .filter((phrase): phrase is string => Boolean(phrase))
  if (!phrases.length) return undefined
  if (phrases.length === 1) {
    return `只修改${phrases[0]}。${keepOutsideClause(false)}`
  }
  const list = phrases.map((phrase, index) => `(${index + 1}) ${phrase}`).join('；')
  return `只修改以下 ${phrases.length} 个标记区域：${list}。${keepOutsideClause(true)}`
}

// （历史：单图 withMarkedImageClause 已删——圈画在底图上时 gemini-3-pro 实测无视
// 「别显示红圈」指令，红圈残留进成图。双图方案的最终提示词改由前端
// src/lib/maskPromptBuilder.ts 拼装，BFF 透传；本文件只剩无 markedImage 的文字回退。）

/**
 * Append the region clause to a prompt for the instruction-based edit channel.
 * Prefers the multi-subject list when present; otherwise falls back to the
 * single-region clause (annotation area-edit / legacy single subjectLabel).
 */
export const withMaskRegionClause = (
  prompt: string,
  maskBoundsJson?: string,
  sourceSizeJson?: string,
  subjectLabel?: string,
  subjectsJson?: string,
): string => {
  const clause =
    maskSubjectsPromptClause(subjectsJson, sourceSizeJson) ??
    maskRegionPromptClause(maskBoundsJson, sourceSizeJson, subjectLabel)
  return `${prompt.trim()}\n\n${clause}`
}
