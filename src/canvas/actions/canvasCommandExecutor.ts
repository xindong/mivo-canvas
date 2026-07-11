// src/canvas/actions/canvasCommandExecutor.ts
// T2.3 — Effect-layer apply seam: dispatch a CanvasCommand onto a CanvasActionRuntime.
//
// ROLE
// The UI-intent layer (canvasActionModel.ts closures) currently calls
// CanvasActionRuntime methods directly. T2.2 will rewire those closures to *emit*
// a CanvasCommand instead; this module is the inverse — it takes a serialized
// CanvasCommand and drives the runtime. Together they let canvas effects round-trip
// through a JSON representation (replay / collaboration groundwork).
//
// This PR (first slice) implements apply for the **sync document-mutation**
// commands — every command whose effect is a synchronous runtime call returning
// void or a created node id. The two-stage-asset + generation commands throw
// CanvasCommandDeferredError: their apply needs to resolve `referenceAssetIds` /
// `assetId` back to Blobs via /api/assets (T1.5), which lands in the T2.3 second
// slice (PR2). The throw is explicit and tagged so callers (and tests) can tell
// "not yet wired" apart from a real failure.
//
// RETURN CONTRACT
// - Node-creation commands return the newly created node id (string), mirroring
//   runtime.addTextNode / addFrameNode / addAiSlotNode / addMarkupNode (→ string)
//   and addAnnotationNode (→ string | undefined).
// - Non-creating commands return undefined.
// - Deferred commands throw rather than return — PR2 will widen the return type
//   to include Promise<string[]> for generation.

import type { CanvasActionRuntime } from './canvasActionTypes'
import type { CanvasCommand } from './canvasCommand'

/** Thrown when a CanvasCommand's apply is not implemented in the current slice. */
export class CanvasCommandDeferredError extends Error {
  readonly commandKind: string
  readonly reason: string
  constructor(commandKind: string, reason: string) {
    super(`CanvasCommand "${commandKind}" apply not implemented: ${reason}`)
    this.name = 'CanvasCommandDeferredError'
    this.commandKind = commandKind
    this.reason = reason
  }
}

const DEFERRED_REASON =
  'two-stage asset / generation apply lands in T2.3 second slice (PR2) — referenceAssetIds / assetId → Blob resolution via /api/assets'

/**
 * Apply a CanvasCommand to a CanvasActionRuntime. Returns the created node id for
 * node-creation commands, undefined otherwise. Throws CanvasCommandDeferredError
 * for asset + generation commands (see file header).
 */
export const applyCanvasCommand = (
  command: CanvasCommand,
  runtime: CanvasActionRuntime,
): string | undefined => {
  switch (command.kind) {
    // ── Node creation ───────────────────────────────────────────────────────────
    case 'add-text-node':
      return runtime.addTextNode(command.position, command.text)
    case 'add-frame-node':
      return runtime.addFrameNode(command.position, command.size, command.title)
    case 'add-ai-slot-node':
      return runtime.addAiSlotNode(command.position, command.size, command.prompt)
    case 'add-annotation-node':
      return runtime.addAnnotationNode(
        command.sourceNodeId,
        command.position,
        command.instruction,
        command.options,
      )
    case 'add-markup-node':
      return runtime.addMarkupNode(
        command.markupKind,
        command.position,
        command.geometry,
        command.options,
      )

    // ── Node style / section ────────────────────────────────────────────────────
    case 'update-markup-style':
      runtime.updateMarkupStyle(command.nodeId, command.style)
      return undefined
    case 'update-section-style':
      runtime.updateSectionStyle(command.nodeId, command.style)
      return undefined
    case 'set-section-lock-mode':
      runtime.setSectionLockMode(command.nodeId, command.mode)
      return undefined
    case 'remove-section-only':
      runtime.removeSectionOnly(command.nodeId)
      return undefined

    // ── Selection / tool ────────────────────────────────────────────────────────
    case 'select-nodes':
      runtime.selectNodes(command.nodeIds, command.primaryNodeId)
      return undefined
    case 'set-active-tool':
      runtime.setActiveTool(command.toolId)
      return undefined

    // ── Organization ────────────────────────────────────────────────────────────
    case 'duplicate-node':
      runtime.duplicateNode(command.nodeId)
      return undefined
    case 'duplicate-selected-nodes':
      runtime.duplicateSelectedNodes()
      return undefined
    case 'group-selected-nodes':
      runtime.groupSelectedNodes()
      return undefined
    case 'ungroup-selected-nodes':
      runtime.ungroupSelectedNodes()
      return undefined
    case 'copy-selected-nodes':
      runtime.copySelectedNodes()
      return undefined
    case 'paste-clipboard-nodes':
      runtime.pasteClipboardNodes()
      return undefined

    // ── Layer ────────────────────────────────────────────────────────────────────
    case 'move-node-layer':
      runtime.moveNodeLayer(command.nodeId, command.move)
      return undefined
    case 'move-selected-layer':
      runtime.moveSelectedLayer(command.move)
      return undefined

    // ── Arrange ──────────────────────────────────────────────────────────────────
    case 'align-selected-nodes':
      runtime.alignSelectedNodes(command.alignment)
      return undefined
    case 'distribute-selected-nodes':
      runtime.distributeSelectedNodes(command.axis)
      return undefined
    case 'arrange-selected-nodes':
      runtime.arrangeSelectedNodes(command.mode)
      return undefined

    // ── Visibility / lock ──────────────────────────────────────────────────────
    case 'toggle-selected-nodes-locked':
      runtime.toggleSelectedNodesLocked()
      return undefined
    case 'hide-selected-nodes':
      runtime.hideSelectedNodes()
      return undefined
    case 'show-all-hidden-nodes':
      runtime.showAllHiddenNodes()
      return undefined

    // ── Delete ───────────────────────────────────────────────────────────────────
    case 'delete-node':
      runtime.deleteNode(command.nodeId)
      return undefined
    case 'delete-selected-nodes':
      runtime.deleteSelectedNodes()
      return undefined

    // ── Deferred (PR2) ──────────────────────────────────────────────────────────
    case 'import-asset':
    case 'generate-variations':
    case 'generate-image-edit':
    case 'generate-beside-node':
    case 'generate-into-ai-slot':
    case 'generate-from-annotation':
      throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
  }
}
