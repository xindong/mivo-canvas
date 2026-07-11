// src/canvas/actions/canvasCommand.ts
// T2.3 — CanvasCommand: a serializable JSON union for the canvas *effect* layer.
//
// WHY THIS EXISTS (arch-migration-execution-plan.md §4 P2 T2.3, review-plan-a F3)
// canvasActionModel.ts builds menu/toolbar items whose `onClick` is a UI *closure*
// capturing non-serializable values (File, Blob, AbortSignal, React callbacks).
// That closure layer is the UI-intent layer and stays as-is — its characterization
// tests (canvasActionModel.characterization.test.ts) are a hard "do not modify"
// constraint. This module introduces the *effect* layer: a discriminated union of
// the state-changing operations the runtime exposes, expressed as plain JSON so
// they can be serialized for replay / collaboration (CRDT-ready groundwork).
//
// LAYERING
//   UI intent layer  = canvasActionModel.ts closures (onClick → runtime)         [unchanged]
//   Effect layer    = CanvasCommand (this file) + canvasCommandExecutor.ts        [NEW]
//   Wiring (onClick → emit command) = T2.2 (separate lane, after T2.1 lands)      [NOT this PR]
//
// TWO-STAGE ASSETS (the three hard pieces: import-asset, mask edit, generation/edit)
// The non-serializable Blobs in generation options (referenceFiles) and the import
// file itself are NOT carried by the command. Instead the UI stage uploads them to
// /api/assets (T1.5 #195, content-addressed: assetId = sha256) and the command only
// carries the resulting `assetId` / `referenceAssetIds`. The executor's apply seam
// resolves assetId → Blob at apply time. That resolution (and therefore the apply
// for asset + generation commands) lands in the T2.3 *second* slice (PR2); this PR
// ships the type + serialize round-trip + the sync-command apply seam only.
//
// INVARIANTS
// - Every CanvasCommand is JSON-serializable (no File/Blob/AbortSignal/functions).
// - serialize→deserialize is identity-preserving (toEqual; undefined optional keys
//   are dropped by JSON.stringify, which vitest's toEqual treats as equal).
// - The `kind` registry is kept exhaustive with the union via a compile-time guard.

import type {
  AiWorkflowOperation,
  CanvasId,
  ConnectorBinding,
  MarkupKind,
  MarkupPoint,
  MarkupStrokeStyle,
  MivoCanvasNode,
  SectionLockMode,
  ToolId,
} from '../../types/mivoCanvas'
import type { GenerationRatio, MivoImageQuality, VariationParam } from '../../types/generation'
import type {
  DistributionAxis,
  SelectionAlignment,
  SelectionArrangeMode,
} from '../../store/canvasStateTypes'
import type { LayerMove } from './canvasActionTypes'
// Type-only (verbatimModuleSyntax): erased at runtime, so canvasCommand stays free
// of the overlay's DOM-canvas runtime while keeping mask shape 1:1 with the real
// submit surface (ImageMaskSubmitPayload in imageMaskGeometry.ts).
import type { ImageMaskBounds, MaskEditModelId, MaskEditSubject } from '../imageMaskGeometry'

// ─── shared primitive shapes ───────────────────────────────────────────────────

export type CanvasCommandPoint = { x: number; y: number }
export type CanvasCommandSize = { width: number; height: number }

/**
 * Serializable counterpart of CanvasGenerationOptions (canvasStateTypes.ts).
 * The non-serializable `referenceFiles: File[]` and `signal: AbortSignal` are
 * replaced: reference image Blobs are uploaded to /api/assets first (two-stage),
 * so the command carries `referenceAssetIds` (content-hash ids) instead. `signal`
 * is a runtime concern and is never serialized.
 */
export type CanvasCommandGenerationOptions = {
  sceneId?: CanvasId
  createDerivationEdge?: boolean
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  model?: string
  /** Two-stage asset: reference image Blobs uploaded → content-hash assetIds. Resolved to File[] at apply (PR2). */
  referenceAssetIds?: string[]
}

/**
 * Markup style patch — mirrors CanvasActionRuntime.updateMarkupStyle's style arg
 * (Pick<Partial<MivoCanvasNode>, …>). Using the same Pick keeps the command shape
 * in lockstep with the runtime contract; if the node grows a field, this still
 * type-checks against the runtime.
 */
export type CanvasMarkupStylePatch = Partial<
  Pick<
    MivoCanvasNode,
    | 'markupStrokeColor'
    | 'markupFillColor'
    | 'markupStrokeWidth'
    | 'markupStrokeStyle'
    | 'markupOpacity'
    | 'markupStartArrow'
    | 'markupEndArrow'
    | 'markupCornerRadius'
  >
>

/** Section style patch — mirrors CanvasActionRuntime.updateSectionStyle's style arg. */
export type CanvasSectionStylePatch = Partial<
  Pick<
    MivoCanvasNode,
    | 'sectionFillColor'
    | 'sectionBorderColor'
    | 'sectionBorderWidth'
    | 'sectionBorderStyle'
    | 'sectionTitleVisible'
  >
>

/**
 * Markup node creation options — serializable subset of CanvasActionRuntime.addMarkupNode's
 * options arg. All fields are plain JSON (points are coords; connectors bind by node id).
 */
export type CanvasMarkupNodeOptions = {
  points?: MarkupPoint[]
  text?: string
  strokeColor?: string
  fillColor?: string
  strokeWidth?: number
  strokeStyle?: MarkupStrokeStyle
  startArrow?: boolean
  endArrow?: boolean
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  select?: boolean
}

/** Annotation creation options — mirrors CanvasActionRuntime.addAnnotationNode's options arg. */
export type CanvasAnnotationOptions = {
  operation?: AiWorkflowOperation
  title?: string
}

// ─── CanvasCommand union ───────────────────────────────────────────────────────

export type CanvasCommand =
  // ── Node creation ──────────────────────────────────────────────────────────────
  | { kind: 'add-text-node'; position: CanvasCommandPoint; text?: string }
  | { kind: 'add-frame-node'; position: CanvasCommandPoint; size?: CanvasCommandSize; title?: string }
  | { kind: 'add-ai-slot-node'; position: CanvasCommandPoint; size?: CanvasCommandSize; prompt?: string }
  | {
      kind: 'add-annotation-node'
      sourceNodeId?: string
      position?: CanvasCommandPoint
      instruction?: string
      options?: CanvasAnnotationOptions
    }
  | {
      kind: 'add-markup-node'
      markupKind: MarkupKind
      position: CanvasCommandPoint
      geometry?: CanvasCommandSize
      options?: CanvasMarkupNodeOptions
    }
  // ── Node style / section ──────────────────────────────────────────────────────
  | { kind: 'update-markup-style'; nodeId: string; style: CanvasMarkupStylePatch }
  | { kind: 'update-section-style'; nodeId: string; style: CanvasSectionStylePatch }
  | { kind: 'set-section-lock-mode'; nodeId: string; mode?: SectionLockMode }
  | { kind: 'remove-section-only'; nodeId: string }
  // ── Selection / tool ──────────────────────────────────────────────────────────
  | { kind: 'select-nodes'; nodeIds: string[]; primaryNodeId?: string }
  | { kind: 'set-active-tool'; toolId: ToolId }
  // ── Organization ──────────────────────────────────────────────────────────────
  | { kind: 'duplicate-node'; nodeId: string }
  | { kind: 'duplicate-selected-nodes' }
  | { kind: 'group-selected-nodes' }
  | { kind: 'ungroup-selected-nodes' }
  | { kind: 'copy-selected-nodes' }
  | { kind: 'paste-clipboard-nodes' }
  // ── Layer ──────────────────────────────────────────────────────────────────────
  | { kind: 'move-node-layer'; nodeId: string; move: LayerMove }
  | { kind: 'move-selected-layer'; move: LayerMove }
  // ── Arrange ───────────────────────────────────────────────────────────────────
  | { kind: 'align-selected-nodes'; alignment: SelectionAlignment }
  | { kind: 'distribute-selected-nodes'; axis: DistributionAxis }
  | { kind: 'arrange-selected-nodes'; mode: SelectionArrangeMode }
  // ── Visibility / lock ──────────────────────────────────────────────────────────
  | { kind: 'toggle-selected-nodes-locked' }
  | { kind: 'hide-selected-nodes' }
  | { kind: 'show-all-hidden-nodes' }
  // ── Delete ─────────────────────────────────────────────────────────────────────
  | { kind: 'delete-node'; nodeId: string }
  | { kind: 'delete-selected-nodes' }
  // ── Two-stage asset (PR1: type + round-trip only; apply deferred to PR2) ───────
  // import-asset: UI picks a File → POST /api/assets → assetId; command carries
  // assetId (NOT the Blob). Apply (PR2) resolves assetId → assetUrl and adds the
  // node. NOTE: the import path goes through the app-layer addImportedFileNode seam,
  // not CanvasActionRuntime directly — see PR2 for the bridge.
  | {
      kind: 'import-asset'
      assetId: string
      mimeType: string
      originalName?: string
      position: CanvasCommandPoint
    }
  // ── Generation (PR1: type + round-trip only; apply deferred to PR2) ───────────
  // The three "hard pieces" (review-plan-a.md:43-48): import-asset, mask-edit, and
  // generation/edit reference images. All carry Blobs that must be two-stage
  // uploaded to assetIds before the command is emitted. generate-image-edit is the
  // NON-mask edit path (operation + prompt + referenceAssetIds); the mask-edit hard
  // piece has its OWN kind below (brush mask Blob + Set-of-Mark marked image Blob +
  // geometry), 1:1 with the overlay's submit surface. Apply is deferred because
  // referenceAssetIds / assetId → File[] needs /api/assets resolution (PR2).
  | {
      kind: 'generate-variations'
      sourceNodeId?: string
      variations?: VariationParam[]
      options?: CanvasCommandGenerationOptions
    }
  | {
      kind: 'generate-image-edit'
      sourceNodeId?: string
      operation: AiWorkflowOperation
      prompt: string
      options?: CanvasCommandGenerationOptions
    }
  | {
      kind: 'generate-beside-node'
      sourceNodeId?: string
      prompt?: string
      options?: CanvasCommandGenerationOptions
    }
  | {
      kind: 'generate-into-ai-slot'
      slotId?: string
      prompt?: string
      options?: CanvasCommandGenerationOptions
    }
  | {
      kind: 'generate-from-annotation'
      annotationNodeId?: string
      options?: CanvasCommandGenerationOptions
    }
  // ── Mask edit (PR1: type + round-trip only; apply deferred to PR2) ────────────
  // The mask-edit hard piece (review-plan-a.md:45): serializable counterpart of
  // ImageMaskSubmitPayload (src/canvas/imageMaskGeometry.ts). Two-stage asset rule:
  // the two Blobs the overlay carries (brush mask PNG + Set-of-Mark marked image)
  // are uploaded to /api/assets first, so this command references them by assetId;
  // geometry (maskBounds + sourceSize) and scalars (quality/model/subjects) ride
  // directly in the payload. canvasActionModel dispatches mask edit as its own menu
  // item (onStartImageMaskEdit, :167-173) — 1:1 with a dedicated kind, not folded
  // into generate-image-edit. Apply (PR2) resolves maskAssetId/markedImageAssetId →
  // Blobs via /api/assets. brush fixture (mask from brush/point regions) and area
  // fixture (mask from box/ellipse/loop regions) are both exercised in round-trip.
  | {
      kind: 'mask-edit'
      /** Image node being locally repainted — mirrors ImageMaskEditOverlay's node.id. */
      sourceNodeId: string
      /** Composed final prompt (recognizer chips + user text) sent to the edit model. */
      prompt: string
      /** Two-stage: brush mask Blob (PNG) uploaded → assetId. Present when regions drew a mask. */
      maskAssetId?: string
      /** Two-stage: Set-of-Mark marked image Blob (full source copy + red anchor rings) → assetId. */
      markedImageAssetId?: string
      /** Geometry (direct): bbox of all mask regions in natural image pixels. */
      maskBounds?: ImageMaskBounds
      /** Geometry (direct): natural source image size (px) — drives mask canvas sizing. Required. */
      sourceSize: CanvasCommandSize
      /** Scalar: quality preset (model-dependent default; maskEditQualityFor). */
      quality?: MivoImageQuality
      /** Scalar: mask-edit model selector (gemini platform edit vs gpt alpha-mask inpainting). */
      model?: MaskEditModelId
      /** Scalar: single-anchor legacy recognizer label for what the selection contains. */
      subjectLabel?: string
      /** Geometry+labels (direct): per-marked-object label + bounds + edit action. */
      subjects?: MaskEditSubject[]
    }

// ─── kind registry (exhaustive with the union) ────────────────────────────────

/** All CanvasCommand `kind` values, in declared order. Runtime-usable (serialize validation). */
export const CANVAS_COMMAND_KINDS = [
  'add-text-node',
  'add-frame-node',
  'add-ai-slot-node',
  'add-annotation-node',
  'add-markup-node',
  'update-markup-style',
  'update-section-style',
  'set-section-lock-mode',
  'remove-section-only',
  'select-nodes',
  'set-active-tool',
  'duplicate-node',
  'duplicate-selected-nodes',
  'group-selected-nodes',
  'ungroup-selected-nodes',
  'copy-selected-nodes',
  'paste-clipboard-nodes',
  'move-node-layer',
  'move-selected-layer',
  'align-selected-nodes',
  'distribute-selected-nodes',
  'arrange-selected-nodes',
  'toggle-selected-nodes-locked',
  'hide-selected-nodes',
  'show-all-hidden-nodes',
  'delete-node',
  'delete-selected-nodes',
  'import-asset',
  'generate-variations',
  'generate-image-edit',
  'generate-beside-node',
  'generate-into-ai-slot',
  'generate-from-annotation',
  'mask-edit',
] as const

export type CanvasCommandKind = (typeof CANVAS_COMMAND_KINDS)[number]

const CANVAS_COMMAND_KIND_SET: ReadonlySet<string> = new Set(CANVAS_COMMAND_KINDS)

/** Kinds whose apply is implemented in THIS PR (sync document mutations).
 * `as const` preserves the literal subset so the partition type guards below can
 * check it against CanvasCommandKind; consumers treat it as a readonly kind list. */
export const CANVAS_COMMAND_APPLIED_KINDS = [
  'add-text-node',
  'add-frame-node',
  'add-ai-slot-node',
  'add-annotation-node',
  'add-markup-node',
  'update-markup-style',
  'update-section-style',
  'set-section-lock-mode',
  'remove-section-only',
  'select-nodes',
  'set-active-tool',
  'duplicate-node',
  'duplicate-selected-nodes',
  'group-selected-nodes',
  'ungroup-selected-nodes',
  'copy-selected-nodes',
  'paste-clipboard-nodes',
  'move-node-layer',
  'move-selected-layer',
  'align-selected-nodes',
  'distribute-selected-nodes',
  'arrange-selected-nodes',
  'toggle-selected-nodes-locked',
  'hide-selected-nodes',
  'show-all-hidden-nodes',
  'delete-node',
  'delete-selected-nodes',
] as const

/** Two-stage-asset kinds: apply is async (PR2 landed it) and needs a
 * CanvasCommandAssetBridge to resolve assetIds → File/Blob via /api/assets
 * (T1.5 #195). applyCanvasCommand throws CanvasCommandDeferredError for these
 * kinds when no bridge is passed (the apply is "not wired for this caller" —
 * T2.2 wires production). `as const` preserves the literal subset for the
 * partition type guards below; it is also the structural sync-vs-async-asset
 * partition (sync kinds are in CANVAS_COMMAND_APPLIED_KINDS). */
export const CANVAS_COMMAND_DEFERRED_KINDS = [
  'import-asset',
  'generate-variations',
  'generate-image-edit',
  'generate-beside-node',
  'generate-into-ai-slot',
  'generate-from-annotation',
  'mask-edit',
] as const

// Compile-time drift guard: every CanvasCommand variant's `kind` must appear in
// CANVAS_COMMAND_KINDS, and vice versa. If either side drifts this fails to
// type-check, forcing the array and union back into sync.
type _UnionKind = CanvasCommand extends { kind: infer K extends string } ? K : never
const _assertExhaustiveKinds: _UnionKind extends CanvasCommandKind
  ? CanvasCommandKind extends _UnionKind
    ? true
    : 'array-has-kind-not-in-union'
  : 'union-has-kind-not-in-array' = true
void _assertExhaustiveKinds

// Compile-time partition guard (F3②): APPLIED ∪ DEFERRED must exactly cover
// CANVAS_KINDS with no missing/extra/typo'd kind. Disjointness (a kind listed in
// BOTH) is NOT caught by union arithmetic — the disjoint + exact-count assertion
// lives in canvasCommand.serialize.test.ts as a runtime check. Together they make
// the partition a real gate: a new kind lands in the union only if it is also in
// CANVAS_COMMAND_KINDS, and in exactly one of APPLIED / DEFERRED.
type _AppliedKind = (typeof CANVAS_COMMAND_APPLIED_KINDS)[number]
type _DeferredKind = (typeof CANVAS_COMMAND_DEFERRED_KINDS)[number]
const _assertAppliedAreKinds: _AppliedKind extends CanvasCommandKind
  ? true
  : 'applied-list-has-non-kind' = true
const _assertDeferredAreKinds: _DeferredKind extends CanvasCommandKind
  ? true
  : 'deferred-list-has-non-kind' = true
type _Partition = _AppliedKind | _DeferredKind
const _assertPartitionCoversAllKinds: CanvasCommandKind extends _Partition
  ? _Partition extends CanvasCommandKind
    ? true
    : 'partition-has-extra-non-kind'
  : 'partition-missing-a-kind' = true
void _assertAppliedAreKinds
void _assertDeferredAreKinds
void _assertPartitionCoversAllKinds

// ─── serialize / deserialize ───────────────────────────────────────────────────

export class CanvasCommandSerializeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanvasCommandSerializeError'
  }
}

/**
 * Serialize a CanvasCommand to a JSON string. Plain JSON.stringify suffices because
 * the union is structurally constrained to JSON-primitive fields (see INVARIANTS).
 * Stable key order is NOT guaranteed — consumers must compare by value, not string.
 */
export const serializeCanvasCommand = (command: CanvasCommand): string =>
  JSON.stringify(command)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Deserialize a JSON string into a CanvasCommand. Validates the `kind` discriminator
 * against the registry; a missing/unknown kind throws CanvasCommandSerializeError
 * rather than returning a silently-wrong object.
 *
 * NOTE (limitation): this validates the kind discriminator only, not the full
 * per-kind payload shape. Deep payload validation of untrusted remote commands is
 * a collaboration-replay concern (T2.2+); for round-trip of locally-serialized
 * commands (this PR's contract), kind validation is sufficient.
 */
export const deserializeCanvasCommand = (json: string): CanvasCommand => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new CanvasCommandSerializeError(
      `Command JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!isPlainObject(parsed) || typeof parsed.kind !== 'string') {
    throw new CanvasCommandSerializeError(
      `Command missing string discriminator "kind": ${json.slice(0, 160)}`,
    )
  }

  if (!CANVAS_COMMAND_KIND_SET.has(parsed.kind)) {
    throw new CanvasCommandSerializeError(`Unknown CanvasCommand kind "${parsed.kind}"`)
  }

  return parsed as CanvasCommand
}
