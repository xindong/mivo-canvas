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
import type { CanvasCommand, CanvasCommandKind } from './canvasCommand'

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
  'two-stage asset / generation apply lands in T2.3 second slice (PR2) — assetId / maskAssetId / markedImageAssetId / referenceAssetIds → Blob resolution via /api/assets'

/**
 * Thrown when a CanvasCommand's payload fails the minimal required-shape check
 * (F2: malformed payload must NOT pass deserialize and silently reach the runtime).
 * `commandKind` + `field` + `reason` tag it so callers can tell a bad payload
 * apart from a deferred (not-yet-wired) or a real runtime failure. This is a
 * shallow, per-kind required-field gate — NOT a deep schema; deep validation of
 * untrusted remote commands is a collaboration-replay concern (T2.2+).
 */
export class CanvasCommandInvalidPayloadError extends Error {
  readonly commandKind: string
  readonly field: string
  readonly reason: string
  constructor(commandKind: string, field: string, reason: string) {
    super(`CanvasCommand "${commandKind}" invalid payload field "${field}": ${reason}`)
    this.name = 'CanvasCommandInvalidPayloadError'
    this.commandKind = commandKind
    this.field = field
    this.reason = reason
  }
}

// ─── minimal required-shape gate (F2) ───────────────────────────────────────────
// A data-driven per-kind required-field map. `Record<CanvasCommandKind, ...>`
// makes this a forcing function: a new kind added to the union without a shape
// entry fails to type-check here (mirroring the executor switch's assertNever).
// The checks are deliberately shallow — presence + top-level type — so they
// catch the F2 attack paths (missing required field, wrong-type array, nested
// coordinate missing x/y) and incidentally fail-closed on non-finite numerics
// that JSON.stringify turns to null (NaN / ±Infinity → null → not a finite
// number). -0 serializes to 0 (a valid coordinate) and is intentionally allowed.

type FieldCheck =
  | { readonly key: string; readonly check: 'point' } // { x, y } finite numbers
  | { readonly key: string; readonly check: 'size' } // { width, height } finite numbers
  | { readonly key: string; readonly check: 'stringArray' } // Array (elements unchecked — minimal)
  | { readonly key: string; readonly check: 'object' } // non-null plain object (style / options patch)
  | { readonly key: string; readonly check: 'string' } // present + typeof string (covers literal-union fields)
  | { readonly key: string; readonly check: 'number' } // present + finite number

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isPlainObjectValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const payloadError = (kind: string, field: string, reason: string) =>
  new CanvasCommandInvalidPayloadError(kind, field, reason)

/**
 * Minimal required-field shape per CanvasCommand kind. `as const` is implicit per
 * entry (string keys); the `Record<CanvasCommandKind, ...>` annotation forces a
 * shape entry for every kind. Kinds with no required fields carry `[]`.
 */
const CANVAS_COMMAND_PAYLOAD_SHAPE: Record<CanvasCommandKind, readonly FieldCheck[]> = {
  'add-text-node': [{ key: 'position', check: 'point' }],
  'add-frame-node': [{ key: 'position', check: 'point' }],
  'add-ai-slot-node': [{ key: 'position', check: 'point' }],
  'add-annotation-node': [],
  'add-markup-node': [
    { key: 'markupKind', check: 'string' },
    { key: 'position', check: 'point' },
  ],
  'update-markup-style': [
    { key: 'nodeId', check: 'string' },
    { key: 'style', check: 'object' },
  ],
  'update-section-style': [
    { key: 'nodeId', check: 'string' },
    { key: 'style', check: 'object' },
  ],
  'set-section-lock-mode': [{ key: 'nodeId', check: 'string' }],
  'remove-section-only': [{ key: 'nodeId', check: 'string' }],
  'select-nodes': [{ key: 'nodeIds', check: 'stringArray' }],
  'set-active-tool': [{ key: 'toolId', check: 'string' }],
  'duplicate-node': [{ key: 'nodeId', check: 'string' }],
  'duplicate-selected-nodes': [],
  'group-selected-nodes': [],
  'ungroup-selected-nodes': [],
  'copy-selected-nodes': [],
  'paste-clipboard-nodes': [],
  'move-node-layer': [
    { key: 'nodeId', check: 'string' },
    { key: 'move', check: 'string' },
  ],
  'move-selected-layer': [{ key: 'move', check: 'string' }],
  'align-selected-nodes': [{ key: 'alignment', check: 'string' }],
  'distribute-selected-nodes': [{ key: 'axis', check: 'string' }],
  'arrange-selected-nodes': [{ key: 'mode', check: 'string' }],
  'toggle-selected-nodes-locked': [],
  'hide-selected-nodes': [],
  'show-all-hidden-nodes': [],
  'delete-node': [{ key: 'nodeId', check: 'string' }],
  'delete-selected-nodes': [],
  'import-asset': [
    { key: 'assetId', check: 'string' },
    { key: 'mimeType', check: 'string' },
    { key: 'position', check: 'point' },
  ],
  'generate-variations': [],
  'generate-image-edit': [
    { key: 'operation', check: 'string' },
    { key: 'prompt', check: 'string' },
  ],
  'generate-beside-node': [],
  'generate-into-ai-slot': [],
  'generate-from-annotation': [],
  'mask-edit': [
    { key: 'sourceNodeId', check: 'string' },
    { key: 'prompt', check: 'string' },
    { key: 'sourceSize', check: 'size' },
  ],
}

const validateField = (kind: string, command: CanvasCommand, spec: FieldCheck): void => {
  const record = command as unknown as Record<string, unknown>
  const value = record[spec.key]
  switch (spec.check) {
    case 'point': {
      if (!isPlainObjectValue(value)) throw payloadError(kind, spec.key, 'expected {x,y} point object')
      if (!isFiniteNumber(value.x)) throw payloadError(kind, 'x', 'expected finite number in point')
      if (!isFiniteNumber(value.y)) throw payloadError(kind, 'y', 'expected finite number in point')
      return
    }
    case 'size': {
      if (!isPlainObjectValue(value)) throw payloadError(kind, spec.key, 'expected {width,height} size object')
      if (!isFiniteNumber(value.width)) throw payloadError(kind, 'width', 'expected finite number in size')
      if (!isFiniteNumber(value.height)) throw payloadError(kind, 'height', 'expected finite number in size')
      return
    }
    case 'stringArray': {
      if (!Array.isArray(value)) throw payloadError(kind, spec.key, 'expected array')
      return
    }
    case 'object': {
      if (!isPlainObjectValue(value)) throw payloadError(kind, spec.key, 'expected object')
      return
    }
    case 'string': {
      if (typeof value !== 'string') throw payloadError(kind, spec.key, 'expected string')
      return
    }
    case 'number': {
      if (!isFiniteNumber(value)) throw payloadError(kind, spec.key, 'expected finite number')
    }
  }
}

/**
 * Validate a CanvasCommand's minimal required payload shape. Called by
 * applyCanvasCommand BEFORE any runtime dispatch so a malformed payload throws a
 * tagged CanvasCommandInvalidPayloadError instead of leaking into a runtime call
 * as a bare TypeError (F2). Round-tripped locally-serialized commands always pass.
 */
export const validateCanvasCommandPayload = (command: CanvasCommand): void => {
  const specs = CANVAS_COMMAND_PAYLOAD_SHAPE[command.kind]
  for (const spec of specs) validateField(command.kind, command, spec)
}

/** Forcing-function helper for the apply switch: a new CanvasCommandKind without a
 *  case fails to type-check here (F3③). Returns never (always throws). */
const assertNeverCommand = (value: never): never => {
  throw new Error(`Unhandled CanvasCommand kind: ${(value as CanvasCommand).kind}`)
}

/**
 * Apply a CanvasCommand to a CanvasActionRuntime. Returns the created node id for
 * node-creation commands, undefined otherwise. Throws CanvasCommandDeferredError
 * for asset + generation commands (see file header). Throws
 * CanvasCommandInvalidPayloadError before any runtime call if the payload fails
 * the minimal required-shape gate (F2).
 */
export const applyCanvasCommand = (
  command: CanvasCommand,
  runtime: CanvasActionRuntime,
): string | undefined => {
  validateCanvasCommandPayload(command)
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
    case 'mask-edit':
      throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
    default:
      // F3③ forcing function: a new CanvasCommandKind added to the union without a
      // case above makes `command` non-`never` here, failing type-check.
      return assertNeverCommand(command)
  }
}
