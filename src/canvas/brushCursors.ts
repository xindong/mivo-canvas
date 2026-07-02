import type { BrushToolMode } from '../types/mivoCanvas'

type CursorSpec = {
  paths: string[]
  hotspotX: number
  hotspotY: number
  /** Fixed color for tools whose look should not follow the picked brush color. */
  fixedColor?: string
}

// Lucide icon path data (ISC license), drawn twice: a white halo underlay keeps
// the cursor readable on any canvas content, the top stroke carries the color.
const cursorSpecs: Record<BrushToolMode, CursorSpec> = {
  marker: {
    paths: [
      'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
      'm15 5 4 4',
    ],
    hotspotX: 2,
    hotspotY: 22,
  },
  highlighter: {
    paths: ['m9 11-6 6v3h9l3-3', 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4'],
    hotspotX: 3,
    hotspotY: 20,
  },
  eraser: {
    paths: [
      'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21',
      'M22 21H7',
      'm5 11 9 9',
    ],
    hotspotX: 5,
    hotspotY: 20,
    fixedColor: '#27302c',
  },
}

export const brushCursorCssFor = (mode: BrushToolMode, color: string) => {
  const spec = cursorSpecs[mode]
  const strokeColor = spec.fixedColor || color
  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>`,
    ...spec.paths.map((path) => `<path d='${path}' stroke='#fffaf0' stroke-width='4.4'/>`),
    ...spec.paths.map((path) => `<path d='${path}' stroke='${strokeColor}' stroke-width='2.2'/>`),
    '</svg>',
  ].join('')

  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${spec.hotspotX} ${spec.hotspotY}, crosshair`
}
