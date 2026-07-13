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
// This module implements apply for the **sync document-mutation** commands (PR1)
// AND the **two-stage-asset** commands (PR2 — this slice). The sync commands
// drive a synchronous runtime call returning void or a created node id. The
// two-stage-asset commands (import-asset, 5 generation kinds, mask-edit) need a
// CanvasCommandAssetBridge to resolve `referenceAssetIds` / `assetId` /
// `maskAssetId` / `markedImageAssetId` back to File/Blob via /api/assets (T1.5
// #195), then dispatch. With NO bridge the apply is still "not wired for this
// caller" → CanvasCommandDeferredError (the PR1 boundary stays visible so the
// PR1/PR2 boundary is still testable). With a bridge the apply is async.
//
// RETURN CONTRACT
// - Sync node-creation commands return the newly created node id (string),
//   mirroring runtime.addTextNode / addFrameNode / addAiSlotNode / addMarkupNode
//   (→ string) and addAnnotationNode (→ string | undefined).
// - Sync non-creating commands return undefined.
// - Two-stage-asset commands return a Promise: import-asset → Promise<string>
//   (new node id), generation → Promise<string[]> (created node ids, mirroring
//   runtime.generate* → Promise<string[]>), mask-edit → Promise<string[]> (the
//   bridge's submit surface returns the edited/new node ids).
// - applyCanvasCommand itself stays NON-async so payload validation (F2) and the
//   no-bridge deferral throw synchronously — the sync-command contract and the
//   PR1 tests are unchanged. The widened return type (CanvasCommandApplyReturn)
//   accommodates both sync results and Promise results. Production wiring of the
//   deferred apply (passing a real bridge from the UI shell) is T2.2's job; this
//   slice's new apply paths are exercised only by tests.

import type { CanvasActionRuntime } from './canvasActionTypes'
import type {
  CanvasCommand,
  CanvasCommandGenerationOptions,
  CanvasCommandKind,
} from './canvasCommand'
// Type-only (verbatimModuleSyntax): erased at runtime so the executor stays free
// of the store's runtime graph while mapping the serializable command options
// (referenceAssetIds) onto the runtime options (referenceFiles: File[]) and
// assembling the mask-edit submit payload 1:1 with the overlay's surface.
import type { CanvasGenerationOptions } from '../../store/canvasStateTypes'
import type { ImageMaskSubmitPayload } from '../imageMaskGeometry'

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
  'two-stage asset apply needs a CanvasCommandAssetBridge (PR2): assetId / maskAssetId / markedImageAssetId / referenceAssetIds → Blob via /api/assets — no bridge means apply not wired for this caller'

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

// ─── two-stage asset bridge (PR2) ──────────────────────────────────────────────
// Dependency-injected seam for resolving assetIds → File/Blob and driving the
// app-layer import + mask-edit submit surfaces. The executor calls this
// interface ONLY (it does NOT import the app/server asset layer — dependency
// direction is app → executor, never reversed). The UI shell provides the impl
// at the assembly point (T2.2 wiring); tests mock it. Each deferred kind's
// apply is only reached when a bridge is passed, so production behavior is
// unchanged until T2.2 wires the bridge (the no-bridge path still throws
// CanvasCommandDeferredError, preserving the PR1 boundary + tests).

/**
 * Result of applying a CanvasCommand: a created node id (string), the created
 * node ids for a multi-output generation (string[]), or undefined for
 * non-creating commands.
 */
export type CanvasCommandApplyResult = string | string[] | undefined

/**
 * applyCanvasCommand return type. Sync commands return CanvasCommandApplyResult
 * directly; two-stage-asset commands (import-asset / generation / mask-edit)
 * return a Promise of it (asset resolution + generation/submit are async).
 * Callers that pass a bridge MUST await; callers using only sync commands (or
 * no bridge) get a sync result.
 */
export type CanvasCommandApplyReturn = CanvasCommandApplyResult | Promise<CanvasCommandApplyResult>

// Block 2: the remaining sync emitters must preserve the historical runtime arity
// while still routing through CanvasCommand. Trim only trailing undefineds so
// `fn(a, undefined)` becomes `fn(a)`, but interior holes like
// `fn(a, undefined, c)` are preserved.
const invokeRuntimeWithTrimmedTrailingUndefineds = <TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  ...args: TArgs
): TReturn => {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end -= 1
  return fn(...(args.slice(0, end) as unknown as TArgs))
}

/**
 * Thrown when a two-stage assetId cannot be resolved (404 / network failure /
 * purged asset). Tagged so callers can tell a missing-asset failure apart from
 * a deferral (no bridge) or a real generation/import/runtime failure. The bridge
 * impl MUST throw this (or re-reject) on resolve failure — never return null
 * silently (fail-closed on the asset path, mirroring F2's posture).
 */
export class CanvasCommandAssetResolveError extends Error {
  readonly assetId: string
  readonly reason: string
  constructor(assetId: string, reason: string) {
    super(`CanvasCommand asset "${assetId}" could not be resolved: ${reason}`)
    this.name = 'CanvasCommandAssetResolveError'
    this.assetId = assetId
    this.reason = reason
  }
}

/**
 * Dependency-injected seam for two-stage asset resolution + the app-layer
 * import/mask surfaces. The executor defines this interface; the UI shell
 * (T2.2) provides the impl; tests mock it. None of the methods are called by
 * the executor until a bridge is passed to applyCanvasCommand.
 *
 * Contract: resolveAssetFile MUST throw on 404 / resolve failure (tagged —
 * CanvasCommandAssetResolveError) and never return null/undefined silently, so
 * the apply caller surfaces a real failure path instead of feeding an empty
 * File[] / undefined Blob into a runtime call.
 */
export type CanvasCommandAssetBridge = {
  /**
   * Resolve a two-stage assetId (sha256 content hash, uploaded to /api/assets in
   * T1.5 #195) → File. Used to re-feed generation referenceFiles, mask-edit mask
   * + markedImage Blobs, and the import file. File extends Blob, so the same
   * resolution feeds both the File[] (generation) and Blob (mask) surfaces.
   * Throws CanvasCommandAssetResolveError on 404 / network failure — never
   * returns null silently.
   */
  resolveAssetFile: (assetId: string) => Promise<File>
  /**
   * Add an imported asset node to the canvas at position. The bridge impl wraps
   * the app-layer addImportedFileNode seam (src/lib/canvasAssetImport.ts); the
   * resolved File lets the impl reuse prepareCanvasFileImport (dimensions /
   * displaySize / markdown text). Returns the newly created node id.
   */
  addImportedAssetNode: (input: {
    assetId: string
    file: File
    mimeType: string
    originalName?: string
    position: { x: number; y: number }
  }) => Promise<string>
  /**
   * Submit a mask edit for sourceNodeId with the assembled ImageMaskSubmitPayload
   * (mask + markedImage Blobs already resolved from their assetIds; geometry +
   * scalars ride directly in the payload). The bridge impl wraps the real
   * mask-edit submit surface (chatMaskEditFlow / maskEditTaskRuntime). Returns
   * the new/edited node ids.
   */
  submitImageMaskEdit: (
    sourceNodeId: string,
    payload: ImageMaskSubmitPayload,
  ) => Promise<string[]>
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
 * Apply a CanvasCommand to a CanvasActionRuntime (+ optional asset bridge for
 * the two-stage-asset kinds). Returns the created node id for sync node-creation
 * commands, undefined for sync non-creating commands, or a Promise of the same
 * for two-stage-asset commands (import-asset → Promise<string>, generation →
 * Promise<string[]>, mask-edit → Promise<string[]>).
 *
 * Throws CanvasCommandInvalidPayloadError (sync, before any runtime call) if the
 * payload fails the minimal required-shape gate (F2). Throws
 * CanvasCommandDeferredError (sync) for two-stage-asset kinds when no bridge is
 * passed — the apply is "not wired for this caller" (T2.2 wires production). With
 * a bridge, the asset path runs; resolve failures surface as
 * CanvasCommandAssetResolveError (tagged, never silent).
 *
 * The function is intentionally NON-async: sync commands + the F2 + no-bridge
 * throws stay synchronous so the PR1 contract + tests are unchanged.
 */
export const applyCanvasCommand = (
  command: CanvasCommand,
  runtime: CanvasActionRuntime,
  bridge?: CanvasCommandAssetBridge,
): CanvasCommandApplyReturn => {
  validateCanvasCommandPayload(command)
  switch (command.kind) {
    // ── Node creation ───────────────────────────────────────────────────────────
    case 'add-text-node':
      return invokeRuntimeWithTrimmedTrailingUndefineds(runtime.addTextNode, command.position, command.text)
    case 'add-frame-node':
      return invokeRuntimeWithTrimmedTrailingUndefineds(
        runtime.addFrameNode,
        command.position,
        command.size,
        command.title,
      )
    case 'add-ai-slot-node':
      return invokeRuntimeWithTrimmedTrailingUndefineds(
        runtime.addAiSlotNode,
        command.position,
        command.size,
        command.prompt,
      )
    case 'add-annotation-node':
      return invokeRuntimeWithTrimmedTrailingUndefineds(
        runtime.addAnnotationNode,
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
      invokeRuntimeWithTrimmedTrailingUndefineds(runtime.selectNodes, command.nodeIds, command.primaryNodeId)
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

    // ── Two-stage asset apply (PR2) ─────────────────────────────────────────────
    // These seven kinds need a CanvasCommandAssetBridge to resolve assetIds →
    // File/Blob via /api/assets (T1.5). With no bridge the apply is still "not
    // wired for this caller" → CanvasCommandDeferredError (the PR1 boundary +
    // tests stay green). With a bridge each kind dispatches to an async helper
    // and returns a Promise of the created node id(s). Each kind has its OWN case
    // (no shared fall-through) so the F3③ forcing function still catches a new
    // kind added without a case.
    case 'import-asset':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyImportAsset(command, bridge)
    case 'generate-variations':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyGenerateVariations(command, runtime, bridge)
    case 'generate-image-edit':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyGenerateImageEdit(command, runtime, bridge)
    case 'generate-beside-node':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyGenerateBesideNode(command, runtime, bridge)
    case 'generate-into-ai-slot':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyGenerateIntoAiSlot(command, runtime, bridge)
    case 'generate-from-annotation':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyGenerateFromAnnotation(command, runtime, bridge)
    case 'mask-edit':
      if (!bridge) throw new CanvasCommandDeferredError(command.kind, DEFERRED_REASON)
      return applyMaskEdit(command, bridge)
    default:
      // F3③ forcing function: a new CanvasCommandKind added to the union without a
      // case above makes `command` non-`never` here, failing type-check.
      return assertNeverCommand(command)
  }
}

// ─── two-stage asset apply helpers (PR2) ──────────────────────────────────────
// Async helpers — applyCanvasCommand returns their Promise WITHOUT awaiting,
// keeping itself non-async so the sync contract (sync returns + F2 + no-bridge
// throws all synchronous) holds. Each helper resolves the two-stage assetIds it
// needs via the bridge, then dispatches to the runtime method (generation) or
// back through the bridge (import / mask-edit submit).

/**
 * Resolve a single two-stage assetId → File via the bridge, ENFORCING the tagged
 * CanvasCommandAssetResolveError contract at the executor boundary. If the bridge
 * impl rejects with a plain Error (naive impl / network throw / response parse
 * error), it is re-wrapped here carrying the failed assetId — so the apply caller
 * ALWAYS sees a tagged resolve failure and can tell "asset invalid" apart from a
 * real generation/import failure, regardless of how the bridge impl throws. An
 * already-tagged CanvasCommandAssetResolveError passes through unchanged.
 */
const resolveAssetFileTagged = async (
  assetId: string,
  bridge: CanvasCommandAssetBridge,
): Promise<File> => {
  try {
    return await bridge.resolveAssetFile(assetId)
  } catch (error) {
    if (error instanceof CanvasCommandAssetResolveError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new CanvasCommandAssetResolveError(assetId, reason)
  }
}

/**
 * Resolve two-stage referenceAssetIds → File[] for generation options. Each id is
 * resolved via resolveAssetFileTagged so a failure is always tagged; Promise.all
 * propagates the first failure as a rejection so the apply caller sees a tagged
 * error, not a silent empty array. Empty/absent referenceAssetIds → [].
 */
const resolveReferenceFiles = async (
  assetIds: string[] | undefined,
  bridge: CanvasCommandAssetBridge,
): Promise<File[]> => {
  if (!assetIds || assetIds.length === 0) return []
  return Promise.all(assetIds.map((id) => resolveAssetFileTagged(id, bridge)))
}

/**
 * Map the serializable CanvasCommandGenerationOptions (referenceAssetIds) onto
 * the runtime CanvasGenerationOptions (referenceFiles: File[]). Shared scalar
 * fields (sceneId / createDerivationEdge / imgRatio / quality / model) pass
 * through; referenceAssetIds is stripped (command-only); signal is a runtime
 * concern and is never carried by the command. Returns undefined when the
 * command carries no options AND no reference files, so the runtime sees the
 * same "no options" shape it always has.
 */
const mapGenerationOptions = async (
  options: CanvasCommandGenerationOptions | undefined,
  bridge: CanvasCommandAssetBridge,
): Promise<CanvasGenerationOptions | undefined> => {
  const referenceFiles = await resolveReferenceFiles(options?.referenceAssetIds, bridge)
  if (!options) return referenceFiles.length ? { referenceFiles } : undefined
  // Strip referenceAssetIds (command-only); pass through the shared fields.
  const { referenceAssetIds: _referenceAssetIds, ...shared } = options
  void _referenceAssetIds
  return referenceFiles.length ? { ...shared, referenceFiles } : shared
}

const applyImportAsset = async (
  command: Extract<CanvasCommand, { kind: 'import-asset' }>,
  bridge: CanvasCommandAssetBridge,
): Promise<string> => {
  const file = await resolveAssetFileTagged(command.assetId, bridge)
  return bridge.addImportedAssetNode({
    assetId: command.assetId,
    file,
    mimeType: command.mimeType,
    originalName: command.originalName,
    position: command.position,
  })
}

const applyGenerateVariations = async (
  command: Extract<CanvasCommand, { kind: 'generate-variations' }>,
  runtime: CanvasActionRuntime,
  bridge: CanvasCommandAssetBridge,
): Promise<string[]> => {
  const options = await mapGenerationOptions(command.options, bridge)
  return runtime.generateVariations(command.sourceNodeId, command.variations, options)
}

const applyGenerateImageEdit = async (
  command: Extract<CanvasCommand, { kind: 'generate-image-edit' }>,
  runtime: CanvasActionRuntime,
  bridge: CanvasCommandAssetBridge,
): Promise<string[]> => {
  const options = await mapGenerationOptions(command.options, bridge)
  return runtime.generateImageEdit(
    command.sourceNodeId,
    command.operation,
    command.prompt,
    options,
  )
}

const applyGenerateBesideNode = async (
  command: Extract<CanvasCommand, { kind: 'generate-beside-node' }>,
  runtime: CanvasActionRuntime,
  bridge: CanvasCommandAssetBridge,
): Promise<string[]> => {
  const options = await mapGenerationOptions(command.options, bridge)
  return runtime.generateBesideNode(command.sourceNodeId, command.prompt, options)
}

const applyGenerateIntoAiSlot = async (
  command: Extract<CanvasCommand, { kind: 'generate-into-ai-slot' }>,
  runtime: CanvasActionRuntime,
  bridge: CanvasCommandAssetBridge,
): Promise<string[]> => {
  const options = await mapGenerationOptions(command.options, bridge)
  return runtime.generateIntoAiSlot(command.slotId, command.prompt, options)
}

const applyGenerateFromAnnotation = async (
  command: Extract<CanvasCommand, { kind: 'generate-from-annotation' }>,
  runtime: CanvasActionRuntime,
  bridge: CanvasCommandAssetBridge,
): Promise<string[]> => {
  const options = await mapGenerationOptions(command.options, bridge)
  return runtime.generateFromAnnotation(command.annotationNodeId, options)
}

/**
 * Assemble the ImageMaskSubmitPayload from the serializable mask-edit command:
 * resolve maskAssetId → mask Blob (if present) and markedImageAssetId →
 * markedImage Blob (if present); geometry (maskBounds + sourceSize) + scalars
 * (quality / model / subjectLabel / subjects) + the composed prompt ride
 * directly in the command. Mirrors the overlay's ImageMaskSubmitPayload shape
 * 1:1 (src/canvas/imageMaskGeometry.ts). File extends Blob, so the resolved
 * File is a valid Blob for mask / markedImage.
 */
const buildMaskEditPayload = async (
  command: Extract<CanvasCommand, { kind: 'mask-edit' }>,
  bridge: CanvasCommandAssetBridge,
): Promise<ImageMaskSubmitPayload> => {
  const mask = command.maskAssetId
    ? await resolveAssetFileTagged(command.maskAssetId, bridge)
    : undefined
  const markedImage = command.markedImageAssetId
    ? await resolveAssetFileTagged(command.markedImageAssetId, bridge)
    : undefined
  return {
    prompt: command.prompt,
    mask,
    maskBounds: command.maskBounds,
    sourceSize: command.sourceSize,
    quality: command.quality,
    model: command.model,
    subjectLabel: command.subjectLabel,
    subjects: command.subjects,
    markedImage,
  }
}

const applyMaskEdit = async (
  command: Extract<CanvasCommand, { kind: 'mask-edit' }>,
  bridge: CanvasCommandAssetBridge,
): Promise<string[]> => {
  const payload = await buildMaskEditPayload(command, bridge)
  return bridge.submitImageMaskEdit(command.sourceNodeId, payload)
}
