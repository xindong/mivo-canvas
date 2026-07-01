import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  Copy,
  Crop,
  Download,
  Eraser,
  Eye,
  EyeOff,
  ExternalLink,
  FilePlus2,
  Group,
  ImagePlus,
  LocateFixed,
  Lock,
  Maximize2,
  MessageSquareText,
  Minus,
  PanelTop,
  Pencil,
  Square,
  SquareDashed,
  SquareMousePointer,
  Sparkles,
  Type,
  Trash2,
  Ungroup,
  Unlock,
  Wand2,
} from 'lucide-react'
import type { DistributionAxis, SelectionAlignment } from '../../store/canvasStore'
import type { CanvasNodeType, MarkupKind, SectionLockMode, ToolId } from '../../types/mivoCanvas'
import {
  hasAnyCapability,
  hasCommonCapability,
  type CanvasSelectionContext,
} from './canvasSelectionModel'
import type { CanvasActionGroup, CanvasActionItem, CanvasActionRuntime, LayerMove } from './canvasActionTypes'

export type { CanvasActionGroup, CanvasActionItem, CanvasActionRuntime } from './canvasActionTypes'

const objectLabelFor = (context: CanvasSelectionContext) => {
  if (context.selectedCount > 1) {
    if (context.objectTypes.size === 1 && context.objectTypes.has('image')) return 'images'
    if (context.objectTypes.size === 1 && context.objectTypes.has('text')) return 'text items'
    if (context.objectTypes.size === 1 && context.objectTypes.has('markdown')) return 'Markdown documents'
    if (context.objectTypes.size === 1 && context.objectTypes.has('pdf')) return 'PDFs'
    if (context.objectTypes.size === 1 && context.objectTypes.has('video')) return 'videos'
    return 'objects'
  }

  if (context.primaryNode?.type === 'text') return 'text'
  if (context.primaryNode?.type === 'frame') return 'section'
  if (context.primaryNode?.type === 'ai-slot') return 'AI slot'
  if (context.primaryNode?.type === 'annotation') return 'annotation'
  if (context.primaryNode?.type === 'markup') return 'markup'
  if (context.primaryNode?.type === 'markdown') return 'Markdown'
  if (context.primaryNode?.type === 'pdf') return 'PDF'
  if (context.primaryNode?.type === 'video') return 'video'
  if (context.primaryNode?.type === 'task-placeholder') return 'task'
  return 'image'
}

const primaryNodeId = (runtime: CanvasActionRuntime) => runtime.context.primaryNode?.id

const duplicateAction = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  if (runtime.context.kind === 'multi') runtime.duplicateSelectedNodes()
  else runtime.duplicateNode(nodeId)
}

const deleteAction = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  if (runtime.context.kind === 'multi') runtime.deleteSelectedNodes()
  else runtime.deleteNode(nodeId)
}

const moveLayerAction = (runtime: CanvasActionRuntime, move: LayerMove) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  if (runtime.context.kind === 'multi') runtime.moveSelectedLayer(move)
  else runtime.moveNodeLayer(nodeId, move)
}

const makeVariations = (runtime: CanvasActionRuntime) => {
  runtime.generateVariations(primaryNodeId(runtime))
}

const generateBesidePrimary = (runtime: CanvasActionRuntime) => {
  void runtime.generateBesideNode(primaryNodeId(runtime))
}

const generateIntoPrimarySlot = (runtime: CanvasActionRuntime) => {
  void runtime.generateIntoAiSlot(primaryNodeId(runtime))
}

const addAnnotationForPrimary = (runtime: CanvasActionRuntime) => {
  runtime.addAnnotationNode(primaryNodeId(runtime))
}

const beginImageEditPrompt = (
  runtime: CanvasActionRuntime,
  operation: Parameters<CanvasActionRuntime['generateImageEdit']>[1],
  instruction: string,
  titlePrefix: string,
) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  const noteId = runtime.addAnnotationNode(nodeId, undefined, instruction, {
    operation,
    title: `${titlePrefix} for ${runtime.context.primaryNode?.title || 'image'}`,
  })
  if (!noteId) return

  runtime.setActiveTool('select')
  runtime.onEditText?.(noteId)
}

const generateImageEditForPrimary = (
  runtime: CanvasActionRuntime,
  operation: Parameters<CanvasActionRuntime['generateImageEdit']>[1],
  prompt: string,
) => {
  void runtime.generateImageEdit(primaryNodeId(runtime), operation, prompt)
}

const imageAiEditActionsFor = (runtime: CanvasActionRuntime): CanvasActionItem[] => [
  {
    id: 'edit-with-prompt',
    label: 'Edit with prompt',
    icon: Wand2,
    onClick: () =>
      beginImageEditPrompt(
        runtime,
        'prompt-edit',
        'Describe the image edit here',
        'Prompt edit',
      ),
  },
  {
    id: 'select-area-edit',
    label: 'Select area',
    icon: SquareMousePointer,
    onClick: () =>
      beginImageEditPrompt(
        runtime,
        'area-edit',
        'Select the area to edit, then describe the change here',
        'Area edit',
      ),
  },
  {
    id: 'remove-background',
    label: 'Remove background',
    icon: Eraser,
    onClick: () =>
      generateImageEditForPrimary(
        runtime,
        'remove-background',
        'Remove the background and keep the subject as a clean transparent cutout.',
      ),
  },
  {
    id: 'expand-image',
    label: 'Expand',
    icon: Maximize2,
    onClick: () =>
      generateImageEditForPrimary(
        runtime,
        'outpaint',
        'Expand the image beyond its current edges while preserving the original composition.',
      ),
  },
  {
    id: 'boost-resolution',
    label: 'Boost resolution',
    text: 'HD',
    onClick: () =>
      generateImageEditForPrimary(
        runtime,
        'upscale',
        'Increase image resolution and preserve the original visual content.',
      ),
  },
]

const generateFromPrimaryAnnotation = (runtime: CanvasActionRuntime) => {
  runtime.generateFromAnnotation(primaryNodeId(runtime))
}

const cropPrimaryNode = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.onCropNode?.(nodeId)
}

const downloadPrimaryOriginal = (runtime: CanvasActionRuntime) => {
  runtime.onDownloadOriginal?.(runtime.context.primaryNode)
}

const renamePrimaryNode = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.onRenameNode?.(nodeId)
}

const hasGroupedNodes = (runtime: CanvasActionRuntime) =>
  runtime.context.nodes.some((node) => Boolean(node.groupId))

const lockLabelFor = (runtime: CanvasActionRuntime) =>
  runtime.context.nodes.some((node) => !node.locked) ? 'Lock' : 'Unlock'

const sectionFillPresets = [
  { label: 'White', value: '#ffffff' },
  { label: 'Warm', value: '#fff7e6' },
  { label: 'Blue', value: '#eef6ff' },
  { label: 'Pink', value: '#fff0f0' },
  { label: 'Green', value: '#effaf2' },
]

const sectionBorderPresets = [
  { label: 'Orange', value: '#ff8a00' },
  { label: 'Blue', value: '#159bff' },
  { label: 'Purple', value: '#6957e8' },
  { label: 'Gray', value: '#8c8880' },
]

const markupColorPresets = [
  { label: 'Purple', value: '#6957e8' },
  { label: 'Blue', value: '#159bff' },
  { label: 'Red', value: '#b9473a' },
  { label: 'Green', value: '#497466' },
  { label: 'Orange', value: '#ff8a00' },
]

const markupFillPresets = [
  { label: 'No fill', value: 'transparent' },
  { label: 'Soft purple', value: 'rgba(105, 87, 232, 0.08)' },
  { label: 'Soft yellow', value: '#fff1a8' },
  { label: 'Soft blue', value: 'rgba(21, 155, 255, 0.1)' },
]

const swatchForColor = (color: string) => ({
  color,
  transparent: color === 'transparent',
})

const setSectionStyle = (
  runtime: CanvasActionRuntime,
  style: Parameters<CanvasActionRuntime['updateSectionStyle']>[1],
) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.updateSectionStyle(nodeId, style)
}

const setMarkupStyle = (
  runtime: CanvasActionRuntime,
  style: Parameters<CanvasActionRuntime['updateMarkupStyle']>[1],
) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.updateMarkupStyle(nodeId, style)
}

const setSectionLockMode = (runtime: CanvasActionRuntime, mode?: SectionLockMode) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.setSectionLockMode(nodeId, mode)
}

const removeSectionOnly = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.removeSectionOnly(nodeId)
}

const sectionStyleStateFor = (runtime: CanvasActionRuntime) => {
  const section = runtime.context.primaryNode

  return {
    fillColor: section?.sectionFillColor || '#ffffff',
    lineColor: section?.sectionBorderColor || section?.frameColor || '#ff8a00',
    lineStyle: section?.sectionBorderStyle || 'dashed',
    lineWidth: section?.sectionBorderWidth || 2,
  }
}

const sectionFillActionsFor = (runtime: CanvasActionRuntime, fillColor: string): CanvasActionItem[] =>
  sectionFillPresets.map((preset) => ({
    id: `section-fill-${preset.value}`,
    label: preset.label,
    swatch: swatchForColor(preset.value),
    selected: fillColor === preset.value,
    onClick: () => setSectionStyle(runtime, { sectionFillColor: preset.value }),
  }))

const sectionLineActionsFor = (
  runtime: CanvasActionRuntime,
  lineColor: string,
  lineStyle: 'solid' | 'dashed',
  lineWidth: number,
): CanvasActionItem[] => [
  ...sectionBorderPresets.map((preset) => ({
    id: `section-line-${preset.value}`,
    label: preset.label,
    swatch: swatchForColor(preset.value),
    selected: lineColor === preset.value,
    onClick: () => setSectionStyle(runtime, { sectionBorderColor: preset.value }),
  })),
  {
    id: 'section-line-dashed',
    label: 'Dashed line',
    linePreview: { color: lineColor, width: 3, dashed: true },
    selected: lineStyle === 'dashed',
    onClick: () => setSectionStyle(runtime, { sectionBorderStyle: 'dashed' }),
  },
  {
    id: 'section-line-solid',
    label: 'Solid line',
    linePreview: { color: lineColor, width: 3 },
    selected: lineStyle === 'solid',
    onClick: () => setSectionStyle(runtime, { sectionBorderStyle: 'solid' }),
  },
  {
    id: 'section-line-thin',
    label: 'Thin',
    linePreview: { color: lineColor, width: 1, dashed: lineStyle === 'dashed' },
    selected: lineWidth === 1,
    onClick: () => setSectionStyle(runtime, { sectionBorderWidth: 1 }),
  },
  {
    id: 'section-line-medium',
    label: 'Medium',
    linePreview: { color: lineColor, width: 2, dashed: lineStyle === 'dashed' },
    selected: lineWidth === 2,
    onClick: () => setSectionStyle(runtime, { sectionBorderWidth: 2 }),
  },
  {
    id: 'section-line-bold',
    label: 'Bold',
    linePreview: { color: lineColor, width: 4, dashed: lineStyle === 'dashed' },
    selected: lineWidth === 4,
    onClick: () => setSectionStyle(runtime, { sectionBorderWidth: 4 }),
  },
]

const sectionLockToolbarAction = (runtime: CanvasActionRuntime): CanvasActionItem => {
  const section = runtime.context.primaryNode
  const locked = Boolean(section?.sectionLockMode)

  return {
    id: 'section-lock',
    label: locked ? 'Unlock' : 'Lock',
    icon: locked ? Unlock : Lock,
    children: [
      { id: 'section-lock-all', label: 'Lock all', icon: Lock, onClick: () => setSectionLockMode(runtime, 'all') },
      {
        id: 'section-lock-background',
        label: 'Lock background only',
        icon: PanelTop,
        onClick: () => setSectionLockMode(runtime, 'background'),
      },
      { id: 'section-unlock', label: 'Unlock section', icon: Unlock, disabled: !locked, onClick: () => setSectionLockMode(runtime) },
    ],
    onClick: () => setSectionLockMode(runtime, locked ? undefined : 'background'),
  }
}

const setTool = (runtime: CanvasActionRuntime, toolId: ToolId) => {
  runtime.setActiveTool(toolId)
}

const createTextAtContext = (runtime: CanvasActionRuntime) => {
  if (!runtime.canvasPosition) {
    setTool(runtime, 'text')
    return
  }

  if (runtime.onCreateTextAt) {
    runtime.onCreateTextAt(runtime.canvasPosition)
    return
  }

  runtime.addTextNode(runtime.canvasPosition)
}

const createFrameAtContext = (runtime: CanvasActionRuntime) => {
  if (!runtime.canvasPosition) {
    setTool(runtime, 'frame')
    return
  }

  if (runtime.onCreateFrameAt) {
    runtime.onCreateFrameAt(runtime.canvasPosition)
    return
  }

  runtime.addFrameNode(runtime.canvasPosition)
}

const createAiSlotAtContext = (runtime: CanvasActionRuntime) => {
  const position = runtime.canvasPosition || { x: 0, y: 0 }
  runtime.addAiSlotNode({ x: position.x - 160, y: position.y - 160 })
}

const createMarkupAtContext = (runtime: CanvasActionRuntime, kind: MarkupKind) => {
  const position = runtime.canvasPosition || { x: 0, y: 0 }
  runtime.addMarkupNode(kind, { x: position.x - 80, y: position.y - 48 }, { width: 160, height: 96 }, {
    points:
      kind === 'arrow' || kind === 'line'
        ? [
            { x: 8, y: 88 },
            { x: 152, y: 8 },
          ]
        : kind === 'brush'
          ? [
              { x: 12, y: 62 },
              { x: 44, y: 24 },
              { x: 82, y: 64 },
              { x: 132, y: 26 },
            ]
          : undefined,
  })
}

const importAssetAtContext = (runtime: CanvasActionRuntime) => {
  if (runtime.canvasPosition && runtime.onImportAssetAt) {
    runtime.onImportAssetAt(runtime.canvasPosition)
    return
  }

  setTool(runtime, 'import')
}

const selectAll = (runtime: CanvasActionRuntime) => {
  runtime.selectNodes(runtime.allNodeIds)
}

const align = (runtime: CanvasActionRuntime, alignment: SelectionAlignment) => {
  runtime.alignSelectedNodes(alignment)
}

const distribute = (runtime: CanvasActionRuntime, axis: DistributionAxis) => {
  runtime.distributeSelectedNodes(axis)
}

type NodeActionExtension = (runtime: CanvasActionRuntime) => CanvasActionGroup[]

const sectionContextMenuGroupsFor: NodeActionExtension = (runtime) => {
  const { context } = runtime
  const { fillColor, lineColor, lineStyle, lineWidth } = sectionStyleStateFor(runtime)

  return [
    {
      id: 'section',
      actions: [
        {
          id: 'section-fill',
          label: 'Section fill',
          swatch: swatchForColor(fillColor),
          children: sectionFillActionsFor(runtime, fillColor),
          onClick: () => setSectionStyle(runtime, { sectionFillColor: '#ffffff' }),
        },
        {
          id: 'section-line',
          label: 'Section line',
          linePreview: { color: lineColor, width: lineWidth, dashed: lineStyle === 'dashed' },
          children: sectionLineActionsFor(runtime, lineColor, lineStyle, lineWidth),
          onClick: () => setSectionStyle(runtime, { sectionBorderColor: '#ff8a00' }),
        },
        {
          id: 'section-title-toggle',
          label: context.primaryNode?.sectionTitleVisible === false ? 'Show title' : 'Hide title',
          icon: context.primaryNode?.sectionTitleVisible === false ? Eye : EyeOff,
          onClick: () =>
            setSectionStyle(runtime, {
              sectionTitleVisible: context.primaryNode?.sectionTitleVisible === false,
            }),
        },
      ],
    },
    {
      id: 'section-lock',
      actions: [
        { id: 'section-lock-all', label: 'Lock all', icon: Lock, onClick: () => setSectionLockMode(runtime, 'all') },
        {
          id: 'section-lock-background',
          label: 'Lock background only',
          icon: PanelTop,
          onClick: () => setSectionLockMode(runtime, 'background'),
        },
        {
          id: 'section-unlock',
          label: 'Unlock section',
          icon: Unlock,
          disabled: !context.primaryNode?.sectionLockMode,
          onClick: () => setSectionLockMode(runtime),
        },
        {
          id: 'remove-section-only',
          label: 'Remove section only',
          icon: PanelTop,
          onClick: () => removeSectionOnly(runtime),
        },
      ],
    },
  ]
}

const generationContextMenuGroupsFor: NodeActionExtension = (runtime) => {
  const { context } = runtime
  if (context.kind !== 'single') return []

  const canUseImageAi = hasAnyCapability(context, 'aiEditable') || hasAnyCapability(context, 'aiReference')
  const slotSelected = hasAnyCapability(context, 'aiSlot')
  const annotationSelected = hasAnyCapability(context, 'annotation')
  const canGenerateBeside = !slotSelected && context.primaryNode?.type !== 'frame'
  const canAddAnnotation = !slotSelected && !annotationSelected && context.primaryNode?.type !== 'frame'
  const canCropPrimary = context.primaryNode?.type === 'image'
  const generateActions: CanvasActionItem[] = [
    ...(slotSelected
      ? [
          {
            id: 'generate-into-slot',
            label: 'Generate into slot',
            icon: ImagePlus,
            onClick: () => generateIntoPrimarySlot(runtime),
          },
        ]
      : []),
    ...(annotationSelected
      ? [
          {
            id: 'generate-from-annotation',
            label: 'Generate from note',
            icon: Sparkles,
            onClick: () => generateFromPrimaryAnnotation(runtime),
          },
        ]
      : []),
    ...(canGenerateBeside
      ? [
          {
            id: 'generate-beside',
            label: 'Generate beside',
            icon: Sparkles,
            onClick: () => generateBesidePrimary(runtime),
          },
        ]
      : []),
    ...(canAddAnnotation
      ? [
          {
            id: 'add-edit-note',
            label: 'Add edit note',
            icon: MessageSquareText,
            onClick: () => addAnnotationForPrimary(runtime),
          },
        ]
      : []),
    ...(canUseImageAi
      ? [
          { id: 'variations', label: 'Make variations', icon: Sparkles, onClick: () => makeVariations(runtime) },
        ]
      : []),
  ]

  return [
    ...(generateActions.length ? [{ id: 'generate', actions: generateActions }] : []),
    ...(canCropPrimary
      ? [
          {
            id: 'edit',
            actions: [
              { id: 'crop', label: 'Crop', icon: Crop, onClick: () => cropPrimaryNode(runtime) },
            ],
          },
        ]
      : []),
  ]
}

const markupStyleActionsFor = (runtime: CanvasActionRuntime): CanvasActionItem[] => {
  const node = runtime.context.primaryNode
  const kind = node?.markupKind
  const isConnector = kind === 'arrow' || kind === 'line'
  const strokeColor = node?.markupStrokeColor || '#6957e8'
  const fillColor = node?.markupFillColor || 'transparent'
  const strokeWidth = node?.markupStrokeWidth || 3
  const isMediumStrokeWidth = strokeWidth !== 2 && strokeWidth !== 6
  const strokeStyle = node?.markupStrokeStyle || 'solid'
  const hasStartArrow = Boolean(node?.markupStartArrow)
  const hasEndArrow = node?.markupEndArrow ?? kind === 'arrow'
  const cornerRadius = node?.markupCornerRadius || 0

  return [
    ...(isConnector
      ? [
          {
            id: 'markup-arrowheads',
            label: 'Arrowheads',
            icon: ArrowUpRight,
            menuVariant: 'segmented',
            children: [
              {
                id: 'markup-arrow-none',
                label: 'No arrows',
                icon: Minus,
                selected: !hasStartArrow && !hasEndArrow,
                onClick: () => setMarkupStyle(runtime, { markupStartArrow: false, markupEndArrow: false }),
              },
              {
                id: 'markup-arrow-end',
                label: 'End arrow',
                icon: ArrowRight,
                selected: !hasStartArrow && hasEndArrow,
                onClick: () => setMarkupStyle(runtime, { markupStartArrow: false, markupEndArrow: true }),
              },
              {
                id: 'markup-arrow-both',
                label: 'Both arrows',
                icon: ArrowLeftRight,
                selected: hasStartArrow && hasEndArrow,
                onClick: () => setMarkupStyle(runtime, { markupStartArrow: true, markupEndArrow: true }),
              },
            ],
            onClick: () =>
              setMarkupStyle(runtime, {
                markupStartArrow: false,
                markupEndArrow: !hasEndArrow,
              }),
          } satisfies CanvasActionItem,
        ]
      : []),
    {
      id: 'markup-fill-color',
      label: 'Fill color',
      swatch: swatchForColor(fillColor),
      menuVariant: 'palette',
      children: markupFillPresets.map((preset) => ({
        id: `markup-fill-${preset.value}`,
        label: preset.label,
        swatch: swatchForColor(preset.value),
        selected: fillColor === preset.value,
        onClick: () => setMarkupStyle(runtime, { markupFillColor: preset.value }),
      })),
      onClick: () => setMarkupStyle(runtime, { markupFillColor: 'rgba(105, 87, 232, 0.08)' }),
    },
    {
      id: 'markup-line-style',
      label: 'Line',
      linePreview: { color: strokeColor, width: strokeWidth, dashed: strokeStyle === 'dashed' },
      menuVariant: 'palette',
      children: [
        ...markupColorPresets.map((preset) => ({
          id: `markup-stroke-${preset.value}`,
          label: preset.label,
          swatch: swatchForColor(preset.value),
          selected: strokeColor === preset.value,
          onClick: () => setMarkupStyle(runtime, { markupStrokeColor: preset.value }),
        })),
        {
          id: 'markup-stroke-solid',
          label: 'Solid line',
          linePreview: { color: strokeColor, width: 3 },
          selected: strokeStyle === 'solid',
          onClick: () => setMarkupStyle(runtime, { markupStrokeStyle: 'solid' }),
        },
        {
          id: 'markup-stroke-dashed',
          label: 'Dashed line',
          linePreview: { color: strokeColor, width: 3, dashed: true },
          selected: strokeStyle === 'dashed',
          onClick: () => setMarkupStyle(runtime, { markupStrokeStyle: 'dashed' }),
        },
        {
          id: 'markup-width-2',
          label: 'Thin',
          linePreview: { color: strokeColor, width: 2, dashed: strokeStyle === 'dashed' },
          selected: strokeWidth === 2,
          onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 2 }),
        },
        {
          id: 'markup-width-3',
          label: 'Medium',
          linePreview: { color: strokeColor, width: 3, dashed: strokeStyle === 'dashed' },
          selected: isMediumStrokeWidth,
          onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 3 }),
        },
        {
          id: 'markup-width-6',
          label: 'Bold',
          linePreview: { color: strokeColor, width: 6, dashed: strokeStyle === 'dashed' },
          selected: strokeWidth === 6,
          onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 6 }),
        },
      ],
      onClick: () => setMarkupStyle(runtime, { markupStrokeColor: '#6957e8' }),
    },
    ...(kind === 'rect'
      ? [
          {
            id: 'markup-corner-radius',
            label: 'Corner radius',
            icon: Square,
            menuVariant: 'segmented',
            children: [
              { id: 'markup-radius-0', label: 'Sharp', text: '0', selected: cornerRadius === 0, onClick: () => setMarkupStyle(runtime, { markupCornerRadius: 0 }) },
              { id: 'markup-radius-6', label: 'Soft', text: '6', selected: cornerRadius === 6, onClick: () => setMarkupStyle(runtime, { markupCornerRadius: 6 }) },
              { id: 'markup-radius-18', label: 'Round', text: '18', selected: cornerRadius === 18, onClick: () => setMarkupStyle(runtime, { markupCornerRadius: 18 }) },
            ],
            onClick: () => setMarkupStyle(runtime, { markupCornerRadius: cornerRadius ? 0 : 8 }),
          } satisfies CanvasActionItem,
        ]
      : []),
  ]
}

const markupContextMenuGroupsFor: NodeActionExtension = (runtime) => [
  {
    id: 'markup-text',
    actions: [
      {
        id: 'edit-markup-text',
        label: 'Edit text',
        icon: Type,
        onClick: () => runtime.onEditText?.(runtime.context.primaryNode?.id || ''),
      },
    ],
  },
  {
    id: 'markup-style',
    actions: markupStyleActionsFor(runtime),
  },
]

const contextMenuExtensionsByNodeType: Partial<Record<CanvasNodeType, NodeActionExtension>> = {
  image: generationContextMenuGroupsFor,
  'task-placeholder': generationContextMenuGroupsFor,
  text: generationContextMenuGroupsFor,
  annotation: generationContextMenuGroupsFor,
  'ai-slot': generationContextMenuGroupsFor,
  frame: sectionContextMenuGroupsFor,
  markup: markupContextMenuGroupsFor,
}

const nodeContextMenuGroupsFor = (runtime: CanvasActionRuntime): CanvasActionGroup[] => {
  const node = runtime.context.primaryNode
  if (runtime.context.kind !== 'single' || !node) return []

  return contextMenuExtensionsByNodeType[node.type]?.(runtime) || []
}

export const contextMenuGroupsFor = (runtime: CanvasActionRuntime): CanvasActionGroup[] => {
  const { context } = runtime
  const objectLabel = objectLabelFor(context)
  const selectedCount = context.selectedCount
  const hasClipboard = runtime.clipboardCount > 0
  const canArrange = hasCommonCapability(context, 'layerable')
  const canExport = hasCommonCapability(context, 'exportable')
  const canGroupSelection = context.kind === 'multi' && hasCommonCapability(context, 'groupable')
  const canUngroupSelection = hasGroupedNodes(runtime)
  const sectionSelected = context.kind === 'single' && context.primaryNode?.type === 'frame'
  const canLock = hasCommonCapability(context, 'lockable') && !sectionSelected
  const canHide = hasCommonCapability(context, 'hideable')

  if (context.kind === 'blank') {
    return [
      {
        id: 'create',
        actions: [
          ...(hasClipboard
            ? [
                {
                  id: 'paste',
                  label: `Paste ${runtime.clipboardCount} item${runtime.clipboardCount > 1 ? 's' : ''}`,
                  icon: Clipboard,
                  onClick: runtime.pasteClipboardNodes,
                },
              ]
            : []),
          { id: 'new-text', label: 'New text here', icon: Type, onClick: () => createTextAtContext(runtime) },
          { id: 'new-section', label: 'New section here', icon: PanelTop, onClick: () => createFrameAtContext(runtime) },
          { id: 'new-ai-slot', label: 'New AI image slot here', icon: SquareDashed, onClick: () => createAiSlotAtContext(runtime) },
          { id: 'new-arrow-markup', label: 'New arrow markup', icon: ArrowUpRight, onClick: () => createMarkupAtContext(runtime, 'arrow') },
          { id: 'new-rect-markup', label: 'New rectangle markup', icon: Square, onClick: () => createMarkupAtContext(runtime, 'rect') },
          { id: 'new-note-markup', label: 'New markup note', icon: MessageSquareText, onClick: () => createMarkupAtContext(runtime, 'note') },
        ],
      },
      {
        id: 'canvas',
        actions: [
          ...(runtime.allNodeIds.length && runtime.onFitAll
            ? [
                {
                  id: 'fit-all',
                  label: 'Fit all objects',
                  icon: LocateFixed,
                  onClick: runtime.onFitAll,
                },
              ]
            : []),
          ...(runtime.allNodeIds.length
            ? [
                {
                  id: 'select-all',
                  label: 'Select all objects',
                  icon: SquareMousePointer,
                  onClick: () => selectAll(runtime),
                },
              ]
            : []),
          ...(runtime.hiddenCount
            ? [
                {
                  id: 'show-hidden',
                  label: `Show ${runtime.hiddenCount} hidden object${runtime.hiddenCount > 1 ? 's' : ''}`,
                  icon: Eye,
                  onClick: runtime.showAllHiddenNodes,
                },
              ]
            : []),
          { id: 'import-asset', label: 'Import asset', icon: FilePlus2, onClick: () => importAssetAtContext(runtime) },
        ],
      },
    ]
  }

  return [
    {
      id: 'inspect',
      actions: [
        ...(context.kind === 'single'
          ? [
              {
                id: 'view-details',
                label:
                  context.primaryNode?.type === 'text' || context.primaryNode?.type === 'annotation'
                    ? context.primaryNode.type === 'annotation'
                      ? 'Edit note'
                      : 'Edit text'
                    : context.primaryNode?.type === 'frame'
                      ? 'Rename section'
                      : context.primaryNode?.type === 'ai-slot'
                        ? 'Generate into slot'
                      : 'View details',
                icon: context.primaryNode?.type === 'frame' ? Pencil : ExternalLink,
                onClick: () => {
                  runtime.setActiveTool('select')
                  if (context.primaryNode?.type === 'frame' && context.primaryNode.id) {
                    runtime.onRenameNode?.(context.primaryNode.id)
                    return
                  }
                  if (
                    (context.primaryNode?.type === 'text' || context.primaryNode?.type === 'annotation') &&
                    context.primaryNode.id
                  ) {
                    runtime.onEditText?.(context.primaryNode.id)
                    return
                  }
                  if (context.primaryNode?.type === 'ai-slot' && context.primaryNode.id) {
                    void runtime.generateIntoAiSlot(context.primaryNode.id)
                    return
                  }
                  runtime.onOpenDetails?.()
                },
              },
            ]
          : []),
        {
          id: 'copy',
          label: context.kind === 'multi' ? `Copy ${selectedCount} ${objectLabel}` : `Copy ${objectLabel}`,
          icon: Copy,
          onClick: runtime.copySelectedNodes,
        },
        {
          id: 'duplicate',
          label: context.kind === 'multi' ? `Duplicate ${selectedCount} ${objectLabel}` : `Duplicate ${objectLabel}`,
          icon: Copy,
          onClick: () => duplicateAction(runtime),
        },
        ...(runtime.onFitSelection
          ? [
              {
                id: 'fit-selection',
                label: 'Fit selection',
                icon: LocateFixed,
                onClick: runtime.onFitSelection,
              },
            ]
          : []),
        ...(hasClipboard
          ? [
              {
                id: 'paste',
                label: `Paste ${runtime.clipboardCount} item${runtime.clipboardCount > 1 ? 's' : ''}`,
                icon: Clipboard,
                onClick: runtime.pasteClipboardNodes,
              },
            ]
          : []),
      ],
    },
    ...nodeContextMenuGroupsFor(runtime),
    ...(canGroupSelection || canUngroupSelection || canLock || canHide
      ? [
          {
            id: 'organize',
            actions: [
              ...(canGroupSelection
                ? [
                    {
                      id: 'group',
                      label: `Group ${selectedCount} objects`,
                      icon: Group,
                      onClick: runtime.groupSelectedNodes,
                    },
                  ]
                : []),
              ...(canUngroupSelection
                ? [
                    {
                      id: 'ungroup',
                      label: 'Ungroup',
                      icon: Ungroup,
                      onClick: runtime.ungroupSelectedNodes,
                    },
                  ]
                : []),
              ...(canLock
                ? [
                    {
                      id: 'toggle-lock',
                      label: `${lockLabelFor(runtime)} ${objectLabel}`,
                      icon: runtime.context.nodes.some((node) => !node.locked) ? Lock : Unlock,
                      onClick: runtime.toggleSelectedNodesLocked,
                    },
                  ]
                : []),
              ...(canHide
                ? [
                    {
                      id: 'hide',
                      label: `Hide ${objectLabel}`,
                      icon: EyeOff,
                      onClick: runtime.hideSelectedNodes,
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(canArrange
      ? [
          {
            id: 'arrange',
            actions: [
              { id: 'bring-forward', label: 'Bring forward', icon: ArrowUp, onClick: () => moveLayerAction(runtime, 'forward') },
              { id: 'send-backward', label: 'Send backward', icon: ArrowDown, onClick: () => moveLayerAction(runtime, 'backward') },
              { id: 'bring-front', label: 'Bring to front', icon: ChevronsUp, onClick: () => moveLayerAction(runtime, 'front') },
              { id: 'send-back', label: 'Send to back', icon: ChevronsDown, onClick: () => moveLayerAction(runtime, 'back') },
            ],
          },
        ]
      : []),
    ...(context.kind === 'multi'
      ? [
          {
            id: 'align',
            actions: [
              { id: 'align-left', label: 'Align left', text: 'L', onClick: () => align(runtime, 'left') },
              { id: 'align-center', label: 'Align center', text: 'C', onClick: () => align(runtime, 'center') },
              { id: 'align-right', label: 'Align right', text: 'R', onClick: () => align(runtime, 'right') },
              { id: 'align-top', label: 'Align top', text: 'T', onClick: () => align(runtime, 'top') },
              { id: 'align-middle', label: 'Align middle', text: 'M', onClick: () => align(runtime, 'middle') },
              { id: 'align-bottom', label: 'Align bottom', text: 'B', onClick: () => align(runtime, 'bottom') },
              ...(selectedCount >= 3
                ? [
                    { id: 'distribute-horizontal', label: 'Distribute horizontal', text: 'H', onClick: () => distribute(runtime, 'horizontal') },
                    { id: 'distribute-vertical', label: 'Distribute vertical', text: 'V', onClick: () => distribute(runtime, 'vertical') },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(canExport
      ? [
          {
            id: 'export',
            actions: [
              {
                id: 'download',
                label: hasCommonCapability(context, 'downloadOriginal') ? 'Download original' : 'Download',
                icon: Download,
                onClick: () => downloadPrimaryOriginal(runtime),
              },
            ],
          },
        ]
      : []),
    {
      id: 'danger',
      actions: [
        {
          id: 'delete',
          label:
            context.kind === 'single' && context.primaryNode?.type === 'frame'
              ? 'Delete section and contents'
              : context.kind === 'multi'
                ? `Delete ${selectedCount} ${objectLabel}`
                : `Delete ${objectLabel}`,
          icon: Trash2,
          danger: true,
          onClick: () => deleteAction(runtime),
        },
      ],
    },
  ]
}

const aiSlotQuickToolbarGroupsFor: NodeActionExtension = (runtime) => [
  {
    id: 'ai-slot',
    actions: [
      { id: 'fill-slot', label: 'Generate', icon: ImagePlus, onClick: () => generateIntoPrimarySlot(runtime) },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
      { id: 'bring-front', label: 'Front', icon: ChevronsUp, onClick: () => moveLayerAction(runtime, 'front') },
    ],
  },
]

const annotationQuickToolbarGroupsFor: NodeActionExtension = (runtime) => [
  {
    id: 'annotation',
    actions: [
      { id: 'generate-from-note', label: 'Generate', icon: Sparkles, onClick: () => generateFromPrimaryAnnotation(runtime) },
      { id: 'edit-note', label: 'Edit', icon: Type, onClick: () => runtime.onEditText?.(runtime.context.primaryNode?.id || '') },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
    ],
  },
]

const markupQuickToolbarGroupsFor: NodeActionExtension = (runtime) => [
  {
    id: 'markup',
    actions: [
      {
        id: 'edit-markup-text',
        label: 'Edit text',
        icon: Type,
        onClick: () => runtime.onEditText?.(runtime.context.primaryNode?.id || ''),
      },
      ...markupStyleActionsFor(runtime),
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
      { id: 'bring-front', label: 'Front', icon: ChevronsUp, onClick: () => moveLayerAction(runtime, 'front') },
      { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
    ],
  },
]

const imageQuickToolbarGroupsFor: NodeActionExtension = (runtime) => {
  if (!hasAnyCapability(runtime.context, 'imageAsset')) return []

  return [
    {
      id: 'image',
      actions: [
        { id: 'crop', label: 'Crop', icon: Crop, onClick: () => cropPrimaryNode(runtime) },
        {
          id: 'ai-edit-menu',
          label: 'AI Edit',
          icon: Sparkles,
          children: imageAiEditActionsFor(runtime),
          onClick: () =>
            beginImageEditPrompt(
              runtime,
              'prompt-edit',
              'Describe the image edit here',
              'Prompt edit',
            ),
        },
      ],
    },
  ]
}

const fileQuickToolbarGroupsFor: NodeActionExtension = (runtime) => {
  const node = runtime.context.primaryNode
  if (!node || !hasAnyCapability(runtime.context, 'pdfAsset')) {
    return []
  }

  return [
    {
      id: 'file',
      actions: [
        { id: 'download-original', label: 'Download original', icon: Download, onClick: () => downloadPrimaryOriginal(runtime) },
      ],
    },
  ]
}

const textQuickToolbarGroupsFor: NodeActionExtension = (runtime) => [
  {
    id: 'text-ai',
    actions: [
      { id: 'generate-beside-text', label: 'Generate', icon: Sparkles, onClick: () => generateBesidePrimary(runtime) },
      { id: 'edit-text', label: 'Edit', icon: Type, onClick: () => runtime.onEditText?.(runtime.context.primaryNode?.id || '') },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
    ],
  },
]

const sectionQuickToolbarGroupsFor: NodeActionExtension = (runtime) => {
  const { context } = runtime
  const { fillColor, lineColor, lineStyle, lineWidth } = sectionStyleStateFor(runtime)

  return [
    {
      id: 'frame',
      actions: [
        {
          id: 'section-fill',
          label: 'Section fill',
          swatch: swatchForColor(fillColor),
          menuVariant: 'palette',
          children: sectionFillActionsFor(runtime, fillColor),
          onClick: () => setSectionStyle(runtime, { sectionFillColor: '#ffffff' }),
        },
        {
          id: 'section-line',
          label: 'Section line',
          linePreview: { color: lineColor, width: lineWidth, dashed: lineStyle === 'dashed' },
          menuVariant: 'palette',
          children: sectionLineActionsFor(runtime, lineColor, lineStyle, lineWidth),
          onClick: () => setSectionStyle(runtime, { sectionBorderColor: '#ff8a00' }),
        },
        {
          id: 'rename-frame',
          label: 'Rename section',
          icon: PanelTop,
          onClick: () => renamePrimaryNode(runtime),
        },
        {
          id: 'section-title',
          label: context.primaryNode?.sectionTitleVisible === false ? 'Show title' : 'Hide title',
          icon: context.primaryNode?.sectionTitleVisible === false ? Eye : EyeOff,
          onClick: () =>
            setSectionStyle(runtime, {
              sectionTitleVisible: context.primaryNode?.sectionTitleVisible === false,
            }),
        },
        sectionLockToolbarAction(runtime),
        ...(runtime.onFitSelection
          ? [{ id: 'fit-section', label: 'Focus section', icon: Maximize2, onClick: runtime.onFitSelection }]
          : []),
      ],
    },
  ]
}

const quickToolbarExtensionsByNodeType: Partial<Record<CanvasNodeType, NodeActionExtension>> = {
  image: imageQuickToolbarGroupsFor,
  markdown: fileQuickToolbarGroupsFor,
  pdf: fileQuickToolbarGroupsFor,
  video: fileQuickToolbarGroupsFor,
  text: textQuickToolbarGroupsFor,
  frame: sectionQuickToolbarGroupsFor,
  'ai-slot': aiSlotQuickToolbarGroupsFor,
  annotation: annotationQuickToolbarGroupsFor,
  markup: markupQuickToolbarGroupsFor,
}

const nodeQuickToolbarGroupsFor = (runtime: CanvasActionRuntime): CanvasActionGroup[] => {
  const node = runtime.context.primaryNode
  if (runtime.context.kind !== 'single' || !node) return []

  return quickToolbarExtensionsByNodeType[node.type]?.(runtime) || []
}

export const quickToolbarGroupsFor = (runtime: CanvasActionRuntime): CanvasActionGroup[] => {
  const { context } = runtime
  if (context.kind === 'blank') return []

  if (context.kind === 'multi') {
    const alignActions: CanvasActionItem[] = [
      { id: 'align-left', label: 'Align left', icon: AlignHorizontalJustifyStart, onClick: () => align(runtime, 'left') },
      { id: 'align-center', label: 'Align center', icon: AlignHorizontalJustifyCenter, onClick: () => align(runtime, 'center') },
      { id: 'align-right', label: 'Align right', icon: AlignHorizontalJustifyEnd, onClick: () => align(runtime, 'right') },
      { id: 'align-top', label: 'Align top', icon: AlignVerticalJustifyStart, onClick: () => align(runtime, 'top') },
      { id: 'align-middle', label: 'Align middle', icon: AlignVerticalJustifyCenter, onClick: () => align(runtime, 'middle') },
      { id: 'align-bottom', label: 'Align bottom', icon: AlignVerticalJustifyEnd, onClick: () => align(runtime, 'bottom') },
      ...(context.selectedCount >= 3
        ? [
            {
              id: 'distribute-horizontal',
              label: 'Distribute horizontal',
              icon: BetweenHorizontalStart,
              onClick: () => distribute(runtime, 'horizontal'),
            },
            {
              id: 'distribute-vertical',
              label: 'Distribute vertical',
              icon: BetweenVerticalStart,
              onClick: () => distribute(runtime, 'vertical'),
            },
          ]
        : []),
    ]

    return [
      {
        id: 'multi',
        actions: [
          { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
          ...(hasGroupedNodes(runtime)
            ? [{ id: 'ungroup', label: 'Ungroup', icon: Ungroup, onClick: runtime.ungroupSelectedNodes }]
            : hasCommonCapability(context, 'groupable')
              ? [{ id: 'group', label: 'Group', icon: Group, onClick: runtime.groupSelectedNodes }]
              : []),
          {
            id: 'align-menu',
            label: 'Align',
            icon: AlignCenter,
            menuVariant: 'icon-grid',
            children: alignActions,
            onClick: () => align(runtime, 'center'),
          },
          {
            id: 'toggle-lock',
            label: lockLabelFor(runtime),
            icon: context.nodes.some((node) => !node.locked) ? Lock : Unlock,
            onClick: runtime.toggleSelectedNodesLocked,
          },
          ...(hasCommonCapability(context, 'layerable')
            ? [{ id: 'bring-front', label: 'Front', icon: ChevronsUp, onClick: () => moveLayerAction(runtime, 'front') }]
            : []),
        ],
      },
    ]
  }

  return nodeQuickToolbarGroupsFor(runtime)
}
