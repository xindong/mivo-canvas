import type { CanvasStampKind } from '../types/mivoCanvas'

/**
 * A stamp is an SVG image sticker. Each SVG ships with its own white rounded
 * card; the canvas layer adds the drop shadow.
 */
export type StampDefinition = {
  kind: CanvasStampKind
  label: string
  src: string
}

export const stampDefinitions: StampDefinition[] = [
  { kind: 'plus-one', label: '+1', src: '/stickers/plus-one.svg' },
  { kind: 'heart', label: 'Heart', src: '/stickers/heart.svg' },
  { kind: 'star', label: 'Star', src: '/stickers/star.svg' },
  { kind: 'check', label: 'Check', src: '/stickers/check.svg' },
  { kind: 'question', label: 'Question', src: '/stickers/question.svg' },
  { kind: 'thumbs-down', label: 'Thumbs down', src: '/stickers/down.svg' },
  { kind: 'down-2', label: 'Down alt', src: '/stickers/down-2.svg' },
  { kind: 'face', label: 'Face', src: '/stickers/face.svg' },
  { kind: 'smile', label: 'Smile', src: '/stickers/smile.svg' },
  { kind: 'eyes', label: 'Eyes', src: '/stickers/eyes.svg' },
]

export const defaultStampKind: CanvasStampKind = 'plus-one'

const stampByKind = new Map<CanvasStampKind, StampDefinition>(
  stampDefinitions.map((definition) => [definition.kind, definition]),
)

export const stampDefinitionFor = (kind: CanvasStampKind | undefined): StampDefinition =>
  (kind ? stampByKind.get(kind) : undefined) || stampDefinitions[0]

export const stampSrcFor = (kind: CanvasStampKind | undefined): string => stampDefinitionFor(kind).src

export const stampLabelFor = (kind: CanvasStampKind | undefined): string => stampDefinitionFor(kind).label

/**
 * FigJam grows a held stamp through four stages before placement.
 * Sizes are canvas units for the placed node (and preview box).
 */
export const stampGrowthSizes = [44, 60, 82, 112]
export const stampGrowthIntervalMs = 420

export const stampCursorCssFor = (kind: CanvasStampKind): string => `url("${stampSrcFor(kind)}") 14 14, copy`
