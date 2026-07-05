import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { CanvasGenerationOptions, DistributionAxis, SelectionAlignment, SelectionArrangeMode } from '../../store/canvasStore'
import type {
  AiWorkflowOperation,
  MarkupKind,
  MarkupPoint,
  MivoCanvasNode,
  SectionLockMode,
  ToolId,
} from '../../types/mivoCanvas'
import type { VariationParam } from '../../types/generation'
import type { CanvasSelectionContext } from './canvasSelectionModel'

export type LayerMove = 'forward' | 'backward' | 'front' | 'back'

// icon 放宽为 lucide 图标或自绘 size/className 兼容组件(如 MaskPointIcon)——
// 渲染点只传 size,两类组件都满足。
export type CanvasActionIcon = LucideIcon | ComponentType<{ size?: number; className?: string }>

export type CanvasActionItem = {
  id: string
  label: string
  icon?: CanvasActionIcon
  text?: string
  menuVariant?: 'list' | 'palette' | 'segmented' | 'icon-grid'
  swatch?: {
    color: string
    transparent?: boolean
  }
  linePreview?: {
    color?: string
    width?: number
    dashed?: boolean
  }
  selected?: boolean
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
  onImportAssetAt?: (position: { x: number; y: number }) => void
  onCropNode?: (nodeId: string) => void
  onStartImageMaskEdit?: (nodeId: string) => void
  onDownloadOriginal?: (node?: MivoCanvasNode) => void
  setActiveTool: (toolId: ToolId) => void
  addTextNode: (position: { x: number; y: number }, text?: string) => string
  addFrameNode: (position: { x: number; y: number }, size?: { width: number; height: number }, title?: string) => string
  addAiSlotNode: (position: { x: number; y: number }, size?: { width: number; height: number }, prompt?: string) => string
  addAnnotationNode: (
    sourceNodeId?: string,
    position?: { x: number; y: number },
    instruction?: string,
    options?: { operation?: AiWorkflowOperation; title?: string },
  ) => string | undefined
  addMarkupNode: (
    kind: MarkupKind,
    position: { x: number; y: number },
    geometry?: { width: number; height: number },
    options?: {
      points?: MarkupPoint[]
      text?: string
      strokeColor?: string
      fillColor?: string
      strokeWidth?: number
      strokeStyle?: MivoCanvasNode['markupStrokeStyle']
      startArrow?: boolean
      endArrow?: boolean
      connectorStart?: MivoCanvasNode['connectorStart']
      connectorEnd?: MivoCanvasNode['connectorEnd']
      select?: boolean
    },
  ) => string
  updateMarkupStyle: (
    nodeId: string,
    style: Pick<
      Partial<MivoCanvasNode>,
      | 'markupStrokeColor'
      | 'markupFillColor'
      | 'markupStrokeWidth'
      | 'markupStrokeStyle'
      | 'markupOpacity'
      | 'markupStartArrow'
      | 'markupEndArrow'
      | 'markupCornerRadius'
    >,
  ) => void
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
  generateVariations: (
    sourceNodeId?: string,
    variations?: VariationParam[],
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateImageEdit: (
    sourceNodeId: string | undefined,
    operation: AiWorkflowOperation,
    prompt: string,
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateBesideNode: (
    sourceNodeId?: string,
    prompt?: string,
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateIntoAiSlot: (
    slotId?: string,
    prompt?: string,
    options?: CanvasGenerationOptions,
  ) => Promise<string[]>
  generateFromAnnotation: (annotationNodeId?: string, options?: CanvasGenerationOptions) => Promise<string[]>
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
  arrangeSelectedNodes: (mode: SelectionArrangeMode) => void
  toggleSelectedNodesLocked: () => void
  hideSelectedNodes: () => void
  showAllHiddenNodes: () => void
  deleteNode: (nodeId: string) => void
  deleteSelectedNodes: () => void
}
