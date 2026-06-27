export const defaultTextFontSize = 24
export const defaultTextColor = '#232323'
export const defaultTextWeight = 500
export const defaultTextAlign = 'left'

const textHorizontalPadding = 20
const textVerticalPadding = 14
const maxTextContentWidth = 520

export type TextAlignment = 'left' | 'center' | 'right'

let textMeasureContext: CanvasRenderingContext2D | undefined

const getTextMeasureContext = () => {
  if (textMeasureContext || typeof document === 'undefined') return textMeasureContext

  textMeasureContext = document.createElement('canvas').getContext('2d') || undefined
  return textMeasureContext
}

const estimatedCharacterWidth = (char: string, fontSize: number) => {
  if (/[\u2e80-\u9fff\uf900-\ufaff]/.test(char)) return fontSize * 1.08
  if (char === ' ') return fontSize * 0.35
  if (/[A-Z0-9]/.test(char)) return fontSize * 0.72
  return fontSize * 0.62
}

const measureTextWidth = (text: string, fontSize: number, fontWeight: number) => {
  const context = getTextMeasureContext()
  if (!context) {
    return Array.from(text || ' ').reduce((width, char) => width + estimatedCharacterWidth(char, fontSize), 0)
  }

  context.font = `${fontWeight} ${fontSize}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  return context.measureText(text || ' ').width
}

const wrappedLineCount = (line: string, wrapWidth: number, fontSize: number, fontWeight: number) => {
  if (measureTextWidth(line, fontSize, fontWeight) <= wrapWidth) return 1

  let count = 1
  let currentWidth = 0

  for (const char of Array.from(line || ' ')) {
    const charWidth = measureTextWidth(char, fontSize, fontWeight)

    if (currentWidth > 0 && currentWidth + charWidth > wrapWidth) {
      count += 1
      currentWidth = charWidth
    } else {
      currentWidth += charWidth
    }
  }

  return count
}

export const textGeometryFor = (
  text: string,
  fontSize = defaultTextFontSize,
  preferredWidth?: number,
  fontWeight = defaultTextWeight,
) => {
  const lines = (text || ' ').split('\n')
  const lineWidths = lines.map((line) => Math.max(1, measureTextWidth(line || ' ', fontSize, fontWeight)))
  const contentWidth = preferredWidth
    ? Math.min(maxTextContentWidth, Math.max(76, preferredWidth - textHorizontalPadding))
    : Math.min(maxTextContentWidth, Math.max(76, Math.ceil(Math.max(...lineWidths))))
  const wrapWidth = Math.max(1, contentWidth - fontSize * 0.5)
  const visualLineCount = lines.reduce(
    (count, line) => count + wrappedLineCount(line || ' ', wrapWidth, fontSize, fontWeight),
    0,
  )

  return {
    width: Math.ceil(contentWidth + textHorizontalPadding),
    height: Math.max(42, Math.ceil(visualLineCount * fontSize * 1.28 + textVerticalPadding + 2)),
  }
}
