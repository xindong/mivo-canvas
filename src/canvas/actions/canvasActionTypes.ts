import type { LucideIcon } from 'lucide-react'
import type { DistributionAxis, SelectionAlignment } from '../../store/canvasStore'
import type {
  AiWorkflowOperation,
  MarkupKind,
  MarkupPoint,
  MivoCanvasNode,
  SectionLockMode,
  ToolId,
} from '../../types/mivoCanvas'
import type { CanvasSelectionContext } from './canvasSelectionModel'

export type LayerMove = 'forward' | 'backward' | 'front' | 'back'

export type CanvasActionItem = {
  id: string
  label: string
  icon?: LucideIcon
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
  generateVariations: (sourceNodeId?: string) => void
  generateImageEdit: (sourceNodeId: string | undefined, operation: AiWorkflowOperation, prompt: string) => void
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
