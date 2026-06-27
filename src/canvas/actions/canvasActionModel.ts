import type { LucideIcon } from 'lucide-react'
import {
  AlignCenter,
  ArrowDown,
  ArrowUp,
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
  FilePlus2,
  Group,
  Image,
  ImagePlus,
  LocateFixed,
  Lock,
  Maximize2,
  MessageSquareText,
  PanelTop,
  PaintBucket,
  Pencil,
  SquareDashed,
  SquareMousePointer,
  Sparkles,
  Type,
  Trash2,
  Ungroup,
  Unlock,
} from 'lucide-react'
import type { DistributionAxis, SelectionAlignment } from '../../store/canvasStore'
import type { MivoCanvasNode, SectionLockMode, ToolId } from '../../types/mivoCanvas'
import {
  hasAnyCapability,
  hasCommonCapability,
  type CanvasSelectionContext,
} from './canvasSelectionModel'

type LayerMove = 'forward' | 'backward' | 'front' | 'back'

export type CanvasActionItem = {
  id: string
  label: string
  icon?: LucideIcon
  text?: string
  danger?: boolean
  disabled?: boolean
  children?: CanvasActionItem[]
  onClick: () => void
}

export type CanvasActionGroup = {
  id: string
  actions: CanvasActionItem[]
}

export type CanvasActionRuntime = {
  context: CanvasSelectionContext
  clipboardCount: number
  hiddenCount: number
  allNodeIds: string[]
  canvasPosition?: { x: number; y: number }
  onOpenDetails?: () => void
  onFitAll?: () => void
  onFitSelection?: () => void
  onCreateTextAt?: (position: { x: number; y: number }) => void
  onCreateFrameAt?: (position: { x: number; y: number }) => void
  onEditText?: (nodeId: string) => void
  onRenameNode?: (nodeId: string) => void
  onImportImageAt?: (position: { x: number; y: number }) => void
  onCropNode?: (nodeId: string) => void
  onDownloadOriginal?: (node?: MivoCanvasNode) => void
  setActiveTool: (toolId: ToolId) => void
  addTextNode: (position: { x: number; y: number }, text?: string) => string
  addFrameNode: (position: { x: number; y: number }, size?: { width: number; height: number }, title?: string) => string
  addAiSlotNode: (position: { x: number; y: number }, size?: { width: number; height: number }, prompt?: string) => string
  addAnnotationNode: (
    sourceNodeId?: string,
    position?: { x: number; y: number },
    instruction?: string,
  ) => string | undefined
  updateSectionStyle: (
    nodeId: string,
    style: Pick<
      Partial<MivoCanvasNode>,
      'sectionFillColor' | 'sectionBorderColor' | 'sectionBorderWidth' | 'sectionBorderStyle' | 'sectionTitleVisible'
    >,
  ) => void
  setSectionLockMode: (nodeId: string, mode?: SectionLockMode) => void
  removeSectionOnly: (nodeId: string) => void
  selectNodes: (nodeIds: string[], primaryNodeId?: string) => void
  generateVariations: (sourceNodeId?: string) => void
  generateBesideNode: (sourceNodeId?: string, prompt?: string) => void
  generateIntoAiSlot: (slotId?: string, prompt?: string) => void
  generateFromAnnotation: (annotationNodeId?: string) => void
  duplicateNode: (nodeId: string) => void
  duplicateSelectedNodes: () => void
  groupSelectedNodes: () => void
  ungroupSelectedNodes: () => void
  copySelectedNodes: () => void
  pasteClipboardNodes: () => void
  moveNodeLayer: (nodeId: string, move: LayerMove) => void
  moveSelectedLayer: (move: LayerMove) => void
  alignSelectedNodes: (alignment: SelectionAlignment) => void
  distributeSelectedNodes: (axis: DistributionAxis) => void
  toggleSelectedNodesLocked: () => void
  hideSelectedNodes: () => void
  showAllHiddenNodes: () => void
  deleteNode: (nodeId: string) => void
  deleteSelectedNodes: () => void
}

const objectLabelFor = (context: CanvasSelectionContext) => {
  if (context.selectedCount > 1) {
    if (context.objectTypes.size === 1 && context.objectTypes.has('image')) return 'images'
    if (context.objectTypes.size === 1 && context.objectTypes.has('text')) return 'text items'
    return 'objects'
  }

  if (context.primaryNode?.type === 'text') return 'text'
  if (context.primaryNode?.type === 'frame') return 'section'
  if (context.primaryNode?.type === 'ai-slot') return 'AI slot'
  if (context.primaryNode?.type === 'annotation') return 'annotation'
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

const setSectionStyle = (
  runtime: CanvasActionRuntime,
  style: Parameters<CanvasActionRuntime['updateSectionStyle']>[1],
) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  runtime.updateSectionStyle(nodeId, style)
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

const importImageAtContext = (runtime: CanvasActionRuntime) => {
  if (runtime.canvasPosition && runtime.onImportImageAt) {
    runtime.onImportImageAt(runtime.canvasPosition)
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

export const contextMenuGroupsFor = (runtime: CanvasActionRuntime): CanvasActionGroup[] => {
  const { context } = runtime
  const objectLabel = objectLabelFor(context)
  const selectedCount = context.selectedCount
  const hasClipboard = runtime.clipboardCount > 0
  const canUseImageAi = hasAnyCapability(context, 'aiEditable') || hasAnyCapability(context, 'aiReference')
  const slotSelected = context.kind === 'single' && hasAnyCapability(context, 'aiSlot')
  const annotationSelected = context.kind === 'single' && hasAnyCapability(context, 'annotation')
  const canGenerateBeside = context.kind === 'single' && !slotSelected && context.primaryNode?.type !== 'frame'
  const canAddAnnotation = context.kind === 'single' && !slotSelected && !annotationSelected && context.primaryNode?.type !== 'frame'
  const canCropPrimary = context.primaryNode?.type === 'image'
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
          { id: 'import-image', label: 'Import image', icon: FilePlus2, onClick: () => importImageAtContext(runtime) },
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
    ...(sectionSelected
      ? [
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
      : []),
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
    ...(context.kind === 'single' && (canUseImageAi || slotSelected || annotationSelected || canGenerateBeside)
      ? [
          {
            id: 'generate',
            actions: [
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
            ],
          },
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

  if (context.primaryNode?.type === 'ai-slot') {
    return [
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
  }

  if (context.primaryNode?.type === 'annotation') {
    return [
      {
        id: 'annotation',
        actions: [
          { id: 'generate-from-note', label: 'Generate', icon: Sparkles, onClick: () => generateFromPrimaryAnnotation(runtime) },
          { id: 'edit-note', label: 'Edit', icon: Type, onClick: () => runtime.onEditText?.(context.primaryNode?.id || '') },
          { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
          { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
          { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
        ],
      },
    ]
  }

  if (context.primaryNode?.type === 'image' && hasAnyCapability(context, 'imageAsset')) {
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

  if (context.primaryNode?.type === 'text') {
    return [
      {
        id: 'text-ai',
        actions: [
          { id: 'generate-beside-text', label: 'Generate', icon: Sparkles, onClick: () => generateBesidePrimary(runtime) },
          { id: 'edit-text', label: 'Edit', icon: Type, onClick: () => runtime.onEditText?.(context.primaryNode?.id || '') },
          { id: 'copy', label: 'Copy', icon: Copy, onClick: runtime.copySelectedNodes },
          { id: 'duplicate', label: 'Duplicate', icon: Copy, onClick: () => duplicateAction(runtime) },
          { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteAction(runtime) },
        ],
      },
    ]
  }

  if (context.primaryNode?.type === 'frame') {
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
            label: context.primaryNode.sectionTitleVisible === false ? 'Show title' : 'Hide title',
            icon: context.primaryNode.sectionTitleVisible === false ? Eye : EyeOff,
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

  return []
}
