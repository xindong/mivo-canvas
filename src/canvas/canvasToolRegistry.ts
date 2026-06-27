import {
  Hand,
  ImagePlus,
  MessageSquare,
  MousePointer2,
  PanelTop,
  Pencil,
  SmilePlus,
  Type,
  Video,
} from 'lucide-react'
import type { ToolId } from '../types/mivoCanvas'
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
    id: 'brush',
    label: 'Brush',
    group: 'create',
    runtimeTool: 'select',
    enabled: false,
    icon: Pencil,
  },
  {
    id: 'sticker',
    label: 'Sticker',
    group: 'create',
    runtimeTool: 'select',
    enabled: false,
    icon: SmilePlus,
  },
  {
    id: 'comment',
    label: 'Comment',
    group: 'create',
    runtimeTool: 'select',
    enabled: false,
    icon: MessageSquare,
  },
  {
    id: 'image',
    label: 'Image',
    group: 'media',
    runtimeTool: 'select',
    dividerBefore: true,
    enabled: false,
    icon: ImagePlus,
  },
  {
    id: 'video',
    label: 'Video',
    group: 'media',
    runtimeTool: 'select',
    enabled: false,
    icon: Video,
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
