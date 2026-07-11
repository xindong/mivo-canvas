// src/canvas/actions/canvasActionEmitters.ts
// T2.2 — effect-emission helpers extracted from canvasActionModel.ts (move-only commit).
//
// LAYERING (arch-migration-execution-plan.md §4 P2 T2.2 — intent/emission split):
//   UI intent layer  = canvasActionModel.ts — menu/toolbar structure, enable conditions,
//                     closures wired to the emitters below.  [stays]
//   Emission layer   = this file — helpers that drive CanvasActionRuntime (the effect
//                     exits). T2.2 rewires these to emit CanvasCommand via
//                     applyCanvasCommand in a SEPARATE rewiring commit (not this one).
//
// This commit is a pure verbatim move: function bodies are byte-identical to their
// origin in canvasActionModel.ts; verify with `git diff --color-moved`. The separate
// `export { … }` block below is the only addition (makes the moved helpers importable
// by the intent layer); it does not modify any function body.

import type { CanvasActionRuntime, LayerMove } from './canvasActionTypes'
import type { MarkupKind, SectionLockMode, ToolId } from '../../types/mivoCanvas'
import type { DistributionAxis, SelectionAlignment, SelectionArrangeMode } from '../../store/canvasStore'

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
  void runtime.generateVariations(primaryNodeId(runtime))
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

const generateFromPrimaryAnnotation = (runtime: CanvasActionRuntime) => {
  void runtime.generateFromAnnotation(primaryNodeId(runtime))
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

const arrange = (runtime: CanvasActionRuntime, mode: SelectionArrangeMode) => {
  runtime.arrangeSelectedNodes(mode)
}


// Exported for the UI-intent layer (canvasActionModel.ts). `setTool` is internal to
// this module (only used by createText/Frame/importAssetAtContext below).
export {
  primaryNodeId,
  duplicateAction,
  deleteAction,
  moveLayerAction,
  makeVariations,
  generateBesidePrimary,
  generateIntoPrimarySlot,
  addAnnotationForPrimary,
  beginImageEditPrompt,
  generateImageEditForPrimary,
  generateFromPrimaryAnnotation,
  cropPrimaryNode,
  downloadPrimaryOriginal,
  renamePrimaryNode,
  setSectionStyle,
  setMarkupStyle,
  setSectionLockMode,
  removeSectionOnly,
  sectionStyleStateFor,
  createTextAtContext,
  createFrameAtContext,
  createAiSlotAtContext,
  createMarkupAtContext,
  importAssetAtContext,
  selectAll,
  align,
  distribute,
  arrange,
}
