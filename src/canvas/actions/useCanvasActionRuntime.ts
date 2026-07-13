import { useMemo } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import type { CanvasActionRuntime } from './canvasActionTypes'
import { createCanvasSelectionContext } from './canvasSelectionModel'
import { wrapCanvasActionRuntimeWithSync } from './canvasSyncRuntime'

type UseCanvasActionRuntimeOptions = {
  primaryNode?: MivoCanvasNode
  selectedNodes?: MivoCanvasNode[]
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
}

export const useCanvasActionRuntime = ({
  primaryNode,
  selectedNodes,
  canvasPosition,
  onOpenDetails,
  onFitAll,
  onFitSelection,
  onCreateTextAt,
  onCreateFrameAt,
  onEditText,
  onRenameNode,
  onImportAssetAt,
  onCropNode,
  onStartImageMaskEdit,
  onDownloadOriginal,
}: UseCanvasActionRuntimeOptions): CanvasActionRuntime => {
  const nodes = useCanvasStore((state) => state.nodes)
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds)
  const clipboardNodes = useCanvasStore((state) => state.clipboardNodes)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const generateVariations = useCanvasStore((state) => state.generateVariations)
  const duplicateNode = useCanvasStore((state) => state.duplicateNode)
  const duplicateSelectedNodes = useCanvasStore((state) => state.duplicateSelectedNodes)
  const groupSelectedNodes = useCanvasStore((state) => state.groupSelectedNodes)
  const ungroupSelectedNodes = useCanvasStore((state) => state.ungroupSelectedNodes)
  const copySelectedNodes = useCanvasStore((state) => state.copySelectedNodes)
  const pasteClipboardNodes = useCanvasStore((state) => state.pasteClipboardNodes)
  const moveNodeLayer = useCanvasStore((state) => state.moveNodeLayer)
  const moveSelectedLayer = useCanvasStore((state) => state.moveSelectedLayer)
  const alignSelectedNodes = useCanvasStore((state) => state.alignSelectedNodes)
  const distributeSelectedNodes = useCanvasStore((state) => state.distributeSelectedNodes)
  const arrangeSelectedNodes = useCanvasStore((state) => state.arrangeSelectedNodes)
  const toggleSelectedNodesLocked = useCanvasStore((state) => state.toggleSelectedNodesLocked)
  const hideSelectedNodes = useCanvasStore((state) => state.hideSelectedNodes)
  const showAllHiddenNodes = useCanvasStore((state) => state.showAllHiddenNodes)
  const deleteNode = useCanvasStore((state) => state.deleteNode)
  const deleteSelectedNodes = useCanvasStore((state) => state.deleteSelectedNodes)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addFrameNode = useCanvasStore((state) => state.addFrameNode)
  const addAiSlotNode = useCanvasStore((state) => state.addAiSlotNode)
  const addAnnotationNode = useCanvasStore((state) => state.addAnnotationNode)
  const addMarkupNode = useCanvasStore((state) => state.addMarkupNode)
  const updateMarkupStyle = useCanvasStore((state) => state.updateMarkupStyle)
  const updateSectionStyle = useCanvasStore((state) => state.updateSectionStyle)
  const setSectionLockMode = useCanvasStore((state) => state.setSectionLockMode)
  const removeSectionOnly = useCanvasStore((state) => state.removeSectionOnly)
  const selectNodes = useCanvasStore((state) => state.selectNodes)
  const generateBesideNode = useCanvasStore((state) => state.generateBesideNode)
  const generateImageEdit = useCanvasStore((state) => state.generateImageEdit)
  const generateIntoAiSlot = useCanvasStore((state) => state.generateIntoAiSlot)
  const generateFromAnnotation = useCanvasStore((state) => state.generateFromAnnotation)

  const contextNodes = useMemo(() => {
    if (selectedNodes) return selectedNodes
    if (!primaryNode) return []
    if (!selectedNodeIds.includes(primaryNode.id)) return [primaryNode]

    const selectedSet = new Set(selectedNodeIds)
    return nodes.filter((node) => selectedSet.has(node.id))
  }, [nodes, primaryNode, selectedNodeIds, selectedNodes])

  const context = useMemo(
    () => createCanvasSelectionContext(contextNodes, primaryNode),
    [contextNodes, primaryNode],
  )

  return wrapCanvasActionRuntimeWithSync({
    context,
    clipboardCount: clipboardNodes.length,
    hiddenCount: nodes.filter((node) => node.hidden).length,
    allNodeIds: nodes.filter((node) => !node.hidden).map((node) => node.id),
    canvasPosition,
    onOpenDetails,
    onFitAll,
    onFitSelection,
    onCreateTextAt,
    onCreateFrameAt,
    onEditText,
    onRenameNode,
    onImportAssetAt,
    onCropNode,
    onStartImageMaskEdit,
    onDownloadOriginal,
    setActiveTool,
    addTextNode,
    addFrameNode,
    addAiSlotNode,
    addAnnotationNode,
    addMarkupNode,
    updateMarkupStyle,
    updateSectionStyle,
    setSectionLockMode,
    removeSectionOnly,
    selectNodes,
    generateVariations,
    generateImageEdit,
    generateBesideNode,
    generateIntoAiSlot,
    generateFromAnnotation,
    duplicateNode,
    duplicateSelectedNodes,
    groupSelectedNodes,
    ungroupSelectedNodes,
    copySelectedNodes,
    pasteClipboardNodes: () => pasteClipboardNodes(canvasPosition),
    moveNodeLayer,
    moveSelectedLayer,
    alignSelectedNodes,
    distributeSelectedNodes,
    arrangeSelectedNodes,
    toggleSelectedNodesLocked,
    hideSelectedNodes,
    showAllHiddenNodes,
    deleteNode,
    deleteSelectedNodes,
  })
}
