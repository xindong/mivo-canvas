// MaskCropOverlayHost — host for the mask + crop edit overlays (Phase 3b).
//
// 3b moved both edit overlays out of the image DOM node (mask) / dom-canvas-layer
// (crop) into EditOverlayLayer (canvas-shell direct child, screen space). This
// component owns the mask naturalSize resolution (useMaskEditOverlay) + the
// EditOverlayLayer mount, so MivoCanvas only passes primitives + callbacks —
// keeping MivoCanvas under the structure-guard line budget.
//
// D1: EditOverlayLayer is a paint/interaction surface above the canvas; it does
// NOT subscribe to Leafer events or back-write the store. Hit-test short-circuits
// edit-state overlays (hitTest HitTestEditKind) — the overlay owns its own input.

import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { Viewport } from '../render/EditOverlayLayer'
import type { MaskInitialClientPoint } from './maskPointPending'
import type { ImageMaskSubmitPayload } from './imageMaskGeometry'
import type { ImageCropBox } from './ImageCropOverlay'
import { EditOverlayLayer } from '../render/EditOverlayLayer'
import { ImageMaskEditOverlay } from './ImageMaskEditOverlay'
import { ImageCropOverlay } from './ImageCropOverlay'
import { useMaskEditOverlay } from './useMaskEditOverlay'

export type MaskCropOverlayHostProps = {
  maskEditNodeId: string | undefined
  visibleNodes: readonly MivoCanvasNode[]
  viewport: Viewport
  cropNode: MivoCanvasNode | undefined
  maskEditSubmittingNodeId?: string
  initialClientPoint?: MaskInitialClientPoint
  onSubmitMaskEdit: (
    nodeId: string,
    resolvedAssetUrl: string,
    payload: ImageMaskSubmitPayload,
  ) => Promise<void>
  onCancelMaskEdit: () => void
  onInitialMaskClientPointHandled: (
    nodeId: string,
    outcome: 'consumed' | 'discarded',
    reason?: string,
  ) => void
  onCommitCrop: (box: ImageCropBox) => void
  onCancelCrop: () => void
}

/**
 * Screen-space host for the mask + crop edit overlays. Mount as a direct child of
 * .canvas-shell (sibling of .dom-canvas-layer). The host is pointer-events:none;
 * each overlay opts in with pointer-events:auto where it needs input.
 */
export function MaskCropOverlayHost({
  maskEditNodeId,
  visibleNodes,
  viewport,
  cropNode,
  maskEditSubmittingNodeId,
  initialClientPoint,
  onSubmitMaskEdit,
  onCancelMaskEdit,
  onInitialMaskClientPointHandled,
  onCommitCrop,
  onCancelCrop,
}: MaskCropOverlayHostProps) {
  const { maskEditNode, resolvedMaskAssetUrl, maskNaturalSize } = useMaskEditOverlay(
    maskEditNodeId,
    visibleNodes,
  )

  return (
    <EditOverlayLayer>
      {maskEditNode && resolvedMaskAssetUrl && maskNaturalSize ? (
        <ImageMaskEditOverlay
          node={maskEditNode}
          resolvedAssetUrl={resolvedMaskAssetUrl}
          naturalSize={maskNaturalSize}
          viewport={viewport}
          submitting={maskEditSubmittingNodeId === maskEditNode.id}
          initialClientPoint={
            initialClientPoint?.nodeId === maskEditNode.id ? initialClientPoint : undefined
          }
          onCancel={onCancelMaskEdit}
          onSubmit={(payload) => onSubmitMaskEdit(maskEditNode.id, resolvedMaskAssetUrl, payload)}
          onInitialClientPointHandled={onInitialMaskClientPointHandled}
        />
      ) : null}
      {cropNode ? (
        <ImageCropOverlay
          node={cropNode}
          viewport={viewport}
          onCommit={onCommitCrop}
          onCancel={onCancelCrop}
        />
      ) : null}
    </EditOverlayLayer>
  )
}
