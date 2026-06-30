import {
  AlignCenter,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Brush,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  FileVideo,
  FilePlus2,
  Group,
  Image,
  ImagePlus,
  LocateFixed,
  Lock,
  Maximize2,
  MessageSquareText,
  Minus,
  PanelTop,
  PaintBucket,
  Pencil,
  Square,
  SquareDashed,
  SquareMousePointer,
  Sparkles,
  Type,
  Trash2,
  Ungroup,
  Unlock,
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
  runtime.generateBesideNode(primaryNodeId(runtime))
}

const generateIntoPrimarySlot = (runtime: CanvasActionRuntime) => {
  runtime.generateIntoAiSlot(primaryNodeId(runtime))
}

const addAnnotationForPrimary = (runtime: CanvasActionRuntime) => {
  runtime.addAnnotationNode(primaryNodeId(runtime))
}

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
  { label: 'White fill', value: '#ffffff' },
  { label: 'Warm fill', value: '#fff7e6' },
  { label: 'Blue fill', value: '#eef6ff' },
  { label: 'Pink fill', value: '#fff0f0' },
  { label: 'Green fill', value: '#effaf2' },
]

const sectionBorderPresets = [
  { label: 'Orange border', value: '#ff8a00' },
  { label: 'Blue border', value: '#159bff' },
  { label: 'Purple border', value: '#6957e8' },
  { label: 'Gray border', value: '#8c8880' },
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

  return [
    {
      id: 'section',
      actions: [
        { id: 'section-fill-white', label: 'White fill', icon: Brush, onClick: () => setSectionStyle(runtime, { sectionFillColor: '#ffffff' }) },
        { id: 'section-fill-warm', label: 'Warm fill', icon: Brush, onClick: () => setSectionStyle(runtime, { sectionFillColor: '#fff7e6' }) },
        { id: 'section-border-orange', label: 'Orange dashed border', icon: SquareDashed, onClick: () => setSectionStyle(runtime, { sectionBorderColor: '#ff8a00', sectionBorderStyle: 'dashed' }) },
        { id: 'section-border-solid', label: 'Solid border', icon: SquareDashed, onClick: () => setSectionStyle(runtime, { sectionBorderStyle: 'solid' }) },
        { id: 'section-border-thin', label: 'Thin border', text: '1', onClick: () => setSectionStyle(runtime, { sectionBorderWidth: 1 }) },
        { id: 'section-border-medium', label: 'Medium border', text: '2', onClick: () => setSectionStyle(runtime, { sectionBorderWidth: 2 }) },
        { id: 'section-border-bold', label: 'Bold border', text: '4', onClick: () => setSectionStyle(runtime, { sectionBorderWidth: 4 }) },
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

const markupStyleActionsFor = (runtime: CanvasActionRuntime): CanvasActionItem[] => [
  ...(runtime.context.primaryNode?.markupKind === 'arrow' || runtime.context.primaryNode?.markupKind === 'line'
    ? [
        {
          id: 'markup-arrowheads',
          label: 'Arrowheads',
          icon: ArrowUpRight,
          children: [
            {
              id: 'markup-arrow-none',
              label: 'No arrows',
              text: '–',
              onClick: () => setMarkupStyle(runtime, { markupStartArrow: false, markupEndArrow: false }),
            },
            {
              id: 'markup-arrow-end',
              label: 'End arrow',
              text: '→',
              onClick: () => setMarkupStyle(runtime, { markupStartArrow: false, markupEndArrow: true }),
            },
            {
              id: 'markup-arrow-both',
              label: 'Both arrows',
              text: '↔',
              onClick: () => setMarkupStyle(runtime, { markupStartArrow: true, markupEndArrow: true }),
            },
          ],
          onClick: () =>
            setMarkupStyle(runtime, {
              markupStartArrow: false,
              markupEndArrow: !(runtime.context.primaryNode?.markupEndArrow ?? runtime.context.primaryNode?.markupKind === 'arrow'),
            }),
        } satisfies CanvasActionItem,
      ]
    : []),
  {
    id: 'markup-stroke-color',
    label: 'Stroke color',
    icon: PaintBucket,
    children: markupColorPresets.map((preset) => ({
      id: `markup-stroke-${preset.value}`,
      label: preset.label,
      text: '●',
      onClick: () => setMarkupStyle(runtime, { markupStrokeColor: preset.value }),
    })),
    onClick: () => setMarkupStyle(runtime, { markupStrokeColor: '#6957e8' }),
  },
  {
    id: 'markup-fill-color',
    label: 'Fill color',
    icon: Square,
    children: markupFillPresets.map((preset) => ({
      id: `markup-fill-${preset.value}`,
      label: preset.label,
      text: '●',
      onClick: () => setMarkupStyle(runtime, { markupFillColor: preset.value }),
    })),
    onClick: () => setMarkupStyle(runtime, { markupFillColor: 'rgba(105, 87, 232, 0.08)' }),
  },
  {
    id: 'markup-stroke-width',
    label: 'Stroke width',
    icon: Minus,
    children: [
      { id: 'markup-width-2', label: 'Thin', text: '2', onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 2 }) },
      { id: 'markup-width-4', label: 'Medium', text: '4', onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 4 }) },
      { id: 'markup-width-6', label: 'Bold', text: '6', onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 6 }) },
    ],
    onClick: () => setMarkupStyle(runtime, { markupStrokeWidth: 4 }),
  },
  {
    id: 'markup-stroke-style',
    label: runtime.context.primaryNode?.markupStrokeStyle === 'dashed' ? 'Solid line' : 'Dashed line',
    icon: SquareDashed,
    onClick: () =>
      setMarkupStyle(runtime, {
        markupStrokeStyle: runtime.context.primaryNode?.markupStrokeStyle === 'dashed' ? 'solid' : 'dashed',
      }),
  },
  ...(runtime.context.primaryNode?.markupKind === 'rect'
    ? [
        {
          id: 'markup-corner-radius',
          label: 'Corner radius',
          icon: Square,
          children: [
            { id: 'markup-radius-0', label: 'Sharp', text: '0', onClick: () => setMarkupStyle(runtime, { markupCornerRadius: 0 }) },
            { id: 'markup-radius-6', label: 'Soft', text: '6', onClick: () => setMarkupStyle(runtime, { markupCornerRadius: 6 }) },
            { id: 'markup-radius-18', label: 'Round', text: '18', onClick: () => setMarkupStyle(runtime, { markupCornerRadius: 18 }) },
          ],
          onClick: () => setMarkupStyle(runtime, { markupCornerRadius: runtime.context.primaryNode?.markupCornerRadius ? 0 : 8 }),
        } satisfies CanvasActionItem,
      ]
    : []),
]

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
                    runtime.generateIntoAiSlot(context.primaryNode.id)
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
      { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
      { id: 'bring-front', label: 'Front', icon: ChevronsUp, onClick: () => moveLayerAction(runtime, 'front') },
      { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
    ],
  },
]

const annotationQuickToolbarGroupsFor: NodeActionExtension = (runtime) => [
  {
    id: 'annotation',
    actions: [
      { id: 'generate-from-note', label: 'Generate', icon: Sparkles, onClick: () => generateFromPrimaryAnnotation(runtime) },
      { id: 'edit-note', label: 'Edit', icon: Type, onClick: () => runtime.onEditText?.(runtime.context.primaryNode?.id || '') },
      { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
      { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
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
      { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
      { id: 'bring-front', label: 'Front', icon: ChevronsUp, onClick: () => moveLayerAction(runtime, 'front') },
      { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
    ],
  },
]

const imageQuickToolbarGroupsFor: NodeActionExtension = (runtime) => {
  if (!hasAnyCapability(runtime.context, 'imageAsset')) return []

  const aiEditActions: CanvasActionItem[] = [
    { id: 'generate-beside', label: 'Generate beside', icon: Sparkles, onClick: () => generateBesidePrimary(runtime) },
    { id: 'add-edit-note', label: 'Add edit note', icon: MessageSquareText, onClick: () => addAnnotationForPrimary(runtime) },
    { id: 'variations', label: 'Make variations', icon: Sparkles, onClick: () => makeVariations(runtime) },
  ]

  return [
    {
      id: 'image',
      actions: [
        { id: 'details', label: 'Details', icon: Image, onClick: () => runtime.onOpenDetails?.() },
        { id: 'crop', label: 'Crop', icon: Crop, onClick: () => cropPrimaryNode(runtime) },
        {
          id: 'ai-edit-menu',
          label: 'AI Edit',
          icon: Sparkles,
          children: aiEditActions,
          onClick: () => makeVariations(runtime),
        },
      ],
    },
  ]
}

const fileQuickToolbarGroupsFor: NodeActionExtension = (runtime) => {
  const node = runtime.context.primaryNode
  if (!node || (!hasAnyCapability(runtime.context, 'markdownDoc') && !hasAnyCapability(runtime.context, 'pdfAsset') && !hasAnyCapability(runtime.context, 'videoAsset'))) {
    return []
  }
  const FileIcon = node.type === 'video' ? FileVideo : FileText

  return [
    {
      id: 'file',
      actions: [
        { id: 'details', label: 'Details', icon: FileIcon, onClick: () => runtime.onOpenDetails?.() },
        { id: 'download-original', label: 'Download original', icon: Download, onClick: () => downloadPrimaryOriginal(runtime) },
        { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
        { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
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
      { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
      { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
      { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
    ],
  },
]

const sectionQuickToolbarGroupsFor: NodeActionExtension = (runtime) => {
  const { context } = runtime

  return [
    {
      id: 'frame',
      actions: [
        {
          id: 'section-fill',
          label: 'Section fill',
          icon: PaintBucket,
          children: sectionFillPresets.map((preset) => ({
            id: `section-fill-${preset.value}`,
            label: preset.label,
            text: '●',
            onClick: () => setSectionStyle(runtime, { sectionFillColor: preset.value }),
          })),
          onClick: () => setSectionStyle(runtime, { sectionFillColor: '#ffffff' }),
        },
        {
          id: 'section-border',
          label: 'Section border',
          icon: SquareDashed,
          children: [
            ...sectionBorderPresets.map((preset) => ({
              id: `section-border-${preset.value}`,
              label: preset.label,
              text: '●',
              onClick: () => setSectionStyle(runtime, { sectionBorderColor: preset.value }),
            })),
            { id: 'section-border-dashed', label: 'Dashed border', text: 'D', onClick: () => setSectionStyle(runtime, { sectionBorderStyle: 'dashed' }) },
            { id: 'section-border-solid', label: 'Solid border', text: 'S', onClick: () => setSectionStyle(runtime, { sectionBorderStyle: 'solid' }) },
          ],
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
      { id: 'align-left', label: 'Align left', text: 'L', onClick: () => align(runtime, 'left') },
      { id: 'align-center', label: 'Align center', text: 'C', onClick: () => align(runtime, 'center') },
      { id: 'align-right', label: 'Align right', text: 'R', onClick: () => align(runtime, 'right') },
      { id: 'align-top', label: 'Align top', text: 'T', onClick: () => align(runtime, 'top') },
      { id: 'align-middle', label: 'Align middle', text: 'M', onClick: () => align(runtime, 'middle') },
      { id: 'align-bottom', label: 'Align bottom', text: 'B', onClick: () => align(runtime, 'bottom') },
      ...(context.selectedCount >= 3
        ? [
            {
              id: 'distribute-horizontal',
              label: 'Distribute horizontal',
              text: 'H',
              onClick: () => distribute(runtime, 'horizontal'),
            },
            {
              id: 'distribute-vertical',
              label: 'Distribute vertical',
              text: 'V',
              onClick: () => distribute(runtime, 'vertical'),
            },
          ]
        : []),
    ]

    return [
      {
        id: 'multi',
        actions: [
          { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
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
          { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
        ],
      },
    ]
  }

  return nodeQuickToolbarGroupsFor(runtime)
}
