// src/canvas/actions/canvasActionEmitters.ts
// T2.2 — effect-emission helpers (intent/emission layer split).
//
// LAYERING (arch-migration-execution-plan.md §4 P2 T2.2):
//   UI intent layer  = canvasActionModel.ts — menu/toolbar structure, enable conditions,
//                     closures wired to the emitters below.  [stays]
//   Emission layer   = this file — helpers that drive CanvasActionRuntime (the effect
//                     exits).
//
// HISTORY: commit 1 moved these verbatim from canvasActionModel.ts (byte-identical,
// `git diff --color-moved` verifiable). commit 2 rewires the 22 sync applied-kind exits
// to emit CanvasCommand via applyCanvasCommand; the 7 deferred (import-asset /
// generate-* / mask-edit) stay as direct calls (applyCanvasCommand would throw
// CanvasCommandDeferredError — exec-t23s2 lane handles their two-stage-asset apply).
//
// Sync applied-kind exits are now fully routed through CanvasCommand (27/27).
// The remaining deferred kinds (import-asset / generate-* / mask-edit) stay on
// direct runtime calls until their two-stage asset bridge is wired.

import type { CanvasActionRuntime, LayerMove } from './canvasActionTypes'
import type { MarkupKind, SectionLockMode, ToolId } from '../../types/mivoCanvas'
import type { DistributionAxis, SelectionAlignment, SelectionArrangeMode } from '../../store/canvasStore'
import { applyCanvasCommand } from './canvasCommandExecutor'

const primaryNodeId = (runtime: CanvasActionRuntime) => runtime.context.primaryNode?.id

const duplicateAction = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  if (runtime.context.kind === 'multi') applyCanvasCommand({ kind: 'duplicate-selected-nodes' }, runtime)
  else applyCanvasCommand({ kind: 'duplicate-node', nodeId }, runtime)
}

const deleteAction = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  if (runtime.context.kind === 'multi') applyCanvasCommand({ kind: 'delete-selected-nodes' }, runtime)
  else applyCanvasCommand({ kind: 'delete-node', nodeId }, runtime)
}

const moveLayerAction = (runtime: CanvasActionRuntime, move: LayerMove) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  if (runtime.context.kind === 'multi') applyCanvasCommand({ kind: 'move-selected-layer', move }, runtime)
  else applyCanvasCommand({ kind: 'move-node-layer', nodeId, move }, runtime)
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
  applyCanvasCommand({ kind: 'add-annotation-node', sourceNodeId: primaryNodeId(runtime) }, runtime)
}

const beginImageEditPrompt = (
  runtime: CanvasActionRuntime,
  operation: Parameters<CanvasActionRuntime['generateImageEdit']>[1],
  instruction: string,
  titlePrefix: string,
) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  const noteId = applyCanvasCommand(
    {
      kind: 'add-annotation-node',
      sourceNodeId: nodeId,
      instruction,
      options: {
        operation,
        title: `${titlePrefix} for ${runtime.context.primaryNode?.title || 'image'}`,
      },
    },
    runtime,
  )
  if (!noteId) return

  applyCanvasCommand({ kind: 'set-active-tool', toolId: 'select' }, runtime)
  // add-annotation-node is a sync kind (no bridge) — runtime returns string|undefined.
  // #208 widened applyCanvasCommand's return to a broad union (string|string[]|Promise)
  // to cover async generation; narrow to string before handing to onEditText.
  // Behavior == pre-rewiring (`runtime.addAnnotationNode` returned string|undefined).
  if (typeof noteId === 'string') runtime.onEditText?.(noteId)
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

  applyCanvasCommand({ kind: 'update-section-style', nodeId, style }, runtime)
}

const setMarkupStyle = (
  runtime: CanvasActionRuntime,
  style: Parameters<CanvasActionRuntime['updateMarkupStyle']>[1],
) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  applyCanvasCommand({ kind: 'update-markup-style', nodeId, style }, runtime)
}

const setSectionLockMode = (runtime: CanvasActionRuntime, mode?: SectionLockMode) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  applyCanvasCommand({ kind: 'set-section-lock-mode', nodeId, mode }, runtime)
}

const removeSectionOnly = (runtime: CanvasActionRuntime) => {
  const nodeId = primaryNodeId(runtime)
  if (!nodeId) return

  applyCanvasCommand({ kind: 'remove-section-only', nodeId }, runtime)
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
  applyCanvasCommand({ kind: 'set-active-tool', toolId }, runtime)
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

  applyCanvasCommand({ kind: 'add-text-node', position: runtime.canvasPosition }, runtime)
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

  applyCanvasCommand({ kind: 'add-frame-node', position: runtime.canvasPosition }, runtime)
}

const createAiSlotAtContext = (runtime: CanvasActionRuntime) => {
  const position = runtime.canvasPosition || { x: 0, y: 0 }
  applyCanvasCommand(
    {
      kind: 'add-ai-slot-node',
      position: { x: position.x - 160, y: position.y - 160 },
    },
    runtime,
  )
}

const createMarkupAtContext = (runtime: CanvasActionRuntime, kind: MarkupKind) => {
  const position = runtime.canvasPosition || { x: 0, y: 0 }
  applyCanvasCommand(
    {
      kind: 'add-markup-node',
      markupKind: kind,
      position: { x: position.x - 80, y: position.y - 48 },
      geometry: { width: 160, height: 96 },
      options: {
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
      },
    },
    runtime,
  )
}

const importAssetAtContext = (runtime: CanvasActionRuntime) => {
  if (runtime.canvasPosition && runtime.onImportAssetAt) {
    runtime.onImportAssetAt(runtime.canvasPosition)
    return
  }

  setTool(runtime, 'import')
}

const selectAll = (runtime: CanvasActionRuntime) => {
  applyCanvasCommand({ kind: 'select-nodes', nodeIds: runtime.allNodeIds }, runtime)
}

const align = (runtime: CanvasActionRuntime, alignment: SelectionAlignment) => {
  applyCanvasCommand({ kind: 'align-selected-nodes', alignment }, runtime)
}

const distribute = (runtime: CanvasActionRuntime, axis: DistributionAxis) => {
  applyCanvasCommand({ kind: 'distribute-selected-nodes', axis }, runtime)
}

const arrange = (runtime: CanvasActionRuntime, mode: SelectionArrangeMode) => {
  applyCanvasCommand({ kind: 'arrange-selected-nodes', mode }, runtime)
}

// T2.2 — zero-arg emitters for the quickbar/context-menu method-ref exits (copy/paste/
// group/ungroup/toggle/hide/show). The UI-intent layer wires these as onClick handlers
// instead of passing runtime.X directly, so command emission stays in this layer.
const copySelectedNodes = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'copy-selected-nodes' }, runtime)
const pasteClipboardNodes = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'paste-clipboard-nodes' }, runtime)
const groupSelectedNodes = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'group-selected-nodes' }, runtime)
const ungroupSelectedNodes = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'ungroup-selected-nodes' }, runtime)
const toggleSelectedNodesLocked = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'toggle-selected-nodes-locked' }, runtime)
const hideSelectedNodes = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'hide-selected-nodes' }, runtime)
const showAllHiddenNodes = (runtime: CanvasActionRuntime) =>
  applyCanvasCommand({ kind: 'show-all-hidden-nodes' }, runtime)


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
  copySelectedNodes,
  pasteClipboardNodes,
  groupSelectedNodes,
  ungroupSelectedNodes,
  toggleSelectedNodesLocked,
  hideSelectedNodes,
  showAllHiddenNodes,
}
