import {
  ArrowUpRight,
  Circle,
  Hand,
  Minus,
  MousePointer2,
  PanelTop,
  Pencil,
  RectangleHorizontal,
  SmilePlus,
  StickyNote,
  Type,
} from 'lucide-react'
import type { MarkupKind, ToolId } from '../types/mivoCanvas'
import type { RuntimeCanvasTool } from './canvasInteraction'

export type CanvasToolGroup = 'navigate' | 'create' | 'media'

export type CanvasToolDefinition = {
  id: ToolId
  label: string
  shortcut?: string
  keyboardShortcuts?: string[]
  group: CanvasToolGroup
  runtimeTool?: RuntimeCanvasTool
  dividerBefore?: boolean
  enabled?: boolean
  icon: typeof MousePointer2
}

export const markupShapeToolIds = [
  'markup-arrow',
  'markup-line',
  'markup-rect',
  'markup-ellipse',
] as const satisfies ToolId[]

export type MarkupShapeToolId = (typeof markupShapeToolIds)[number]

export const canvasToolRegistry: CanvasToolDefinition[] = [
  {
    id: 'select',
    label: 'Select',
    shortcut: 'V',
    keyboardShortcuts: ['v'],
    group: 'navigate',
    runtimeTool: 'select',
    icon: MousePointer2,
  },
  {
    id: 'hand',
    label: 'Hand',
    shortcut: 'H / Space',
    keyboardShortcuts: ['h'],
    group: 'navigate',
    runtimeTool: 'hand',
    icon: Hand,
  },
  {
    id: 'text',
    label: 'Text',
    shortcut: 'T',
    keyboardShortcuts: ['t'],
    group: 'create',
    runtimeTool: 'text',
    icon: Type,
  },
  {
    id: 'frame',
    label: 'Section',
    shortcut: 'F',
    keyboardShortcuts: ['f'],
    group: 'create',
    runtimeTool: 'frame',
    icon: PanelTop,
  },
  {
    id: 'markup-brush',
    label: 'Brush',
    shortcut: 'P',
    keyboardShortcuts: ['p'],
    group: 'create',
    runtimeTool: 'markup',
    dividerBefore: true,
    icon: Pencil,
  },
  {
    id: 'markup-arrow',
    label: 'Arrow',
    shortcut: 'A',
    keyboardShortcuts: ['a'],
    group: 'create',
    runtimeTool: 'markup',
    icon: ArrowUpRight,
  },
  {
    id: 'markup-line',
    label: 'Line',
    shortcut: 'L',
    keyboardShortcuts: ['l'],
    group: 'create',
    runtimeTool: 'markup',
    icon: Minus,
  },
  {
    id: 'markup-rect',
    label: 'Rectangle',
    shortcut: 'R',
    keyboardShortcuts: ['r'],
    group: 'create',
    runtimeTool: 'markup',
    icon: RectangleHorizontal,
  },
  {
    id: 'markup-ellipse',
    label: 'Ellipse',
    shortcut: 'O',
    keyboardShortcuts: ['o'],
    group: 'create',
    runtimeTool: 'markup',
    icon: Circle,
  },
  {
    id: 'markup-note',
    label: 'Markup note',
    shortcut: 'N',
    keyboardShortcuts: ['n'],
    group: 'create',
    runtimeTool: 'markup',
    icon: StickyNote,
  },
  {
    id: 'stamp',
    label: 'Stamp',
    shortcut: 'S',
    keyboardShortcuts: ['s'],
    group: 'create',
    runtimeTool: 'stamp',
    icon: SmilePlus,
  },
]

export const isCanvasToolEnabled = (toolId: ToolId) => {
  const tool = canvasToolRegistry.find((item) => item.id === toolId)
  return Boolean(tool && tool.enabled !== false)
}

export const toolForKeyboardShortcut = (key: string) => {
  const normalizedKey = key.toLowerCase()
  return canvasToolRegistry.find(
    (tool) => tool.enabled !== false && tool.keyboardShortcuts?.includes(normalizedKey),
  )?.id
}

export const markupKindForTool = (toolId: ToolId): MarkupKind | undefined => {
  if (toolId === 'markup-arrow') return 'arrow'
  if (toolId === 'markup-line') return 'line'
  if (toolId === 'markup-rect') return 'rect'
  if (toolId === 'markup-ellipse') return 'ellipse'
  if (toolId === 'markup-brush') return 'brush'
  if (toolId === 'markup-note') return 'note'
  return undefined
}
