import type { CanvasStampKind } from '../types/mivoCanvas'

export type StampDefinition = {
  kind: CanvasStampKind
  label: string
  emoji: string
}

// FigJam-inspired stamp set: voting, reactions, and review marks.
export const stampDefinitions: StampDefinition[] = [
  { kind: 'plus-one', label: '+1', emoji: '👍' },
  { kind: 'thumbs-down', label: '-1', emoji: '👎' },
  { kind: 'heart', label: 'Heart', emoji: '❤️' },
  { kind: 'star', label: 'Star', emoji: '⭐' },
  { kind: 'check', label: 'Check', emoji: '✅' },
  { kind: 'question', label: 'Question', emoji: '❓' },
  { kind: 'eyes', label: 'Eyes', emoji: '👀' },
  { kind: 'celebrate', label: 'Celebrate', emoji: '🎉' },
]

export const defaultStampKind: CanvasStampKind = 'plus-one'

export const stampEmojiFor = (kind: CanvasStampKind | undefined) =>
  stampDefinitions.find((definition) => definition.kind === kind)?.emoji || '👍'

export const stampLabelFor = (kind: CanvasStampKind | undefined) =>
  stampDefinitions.find((definition) => definition.kind === kind)?.label || '+1'

/**
 * FigJam grows a held stamp through four stages before placement.
 * Sizes are canvas units for the placed node (and preview box).
 */
export const stampGrowthSizes = [44, 60, 82, 112]
export const stampGrowthIntervalMs = 420

export const stampCursorCssFor = (kind: CanvasStampKind) => {
  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'>`,
    `<text x='14' y='15' font-size='20' text-anchor='middle' dominant-baseline='central'>${stampEmojiFor(kind)}</text>`,
    '</svg>',
  ].join('')

  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 14 14, copy`
}
