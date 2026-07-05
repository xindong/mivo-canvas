// EditOverlayLayer — screen-space overlay host above the canvas layer (Phase 2b-2).
//
// Lives as a DIRECT child of .canvas-shell (NOT inside .dom-canvas-layer's
// viewport transform), so children position in SCREEN space via
// toContainer(cx, cy) = { x: cx*scale+vx, y: cy*scale+vy } — the same math the
// DOM .dom-canvas-layer applies internally (translate(vx,vy) scale(s)), but here
// each child computes its own left/top so the host stays transform-free.
//
// The host is `pointer-events: none`; edit-state children (mask/crop/text-edit)
// opt in with `pointer-events: auto` only where they need input. This keeps the
// overlay from blocking canvas gestures outside the edited node.
//
// 2b-2 delivers the host + the toContainer contract ONLY. 3b migrates the mask
// (ImageMaskEditOverlay) + crop (image-crop-overlay) surfaces here so they share
// one screen-space surface with identical viewport math, instead of each rolling
// its own positioning. MivoCanvas does not mount this in 2b-2 (no behavior change,
// visual diff 0%); mounting lands with the 3b migration.
//
// D1 (hard constraint): this is a paint/interaction surface above the canvas. It
// MUST NOT subscribe to Leafer events or read zoomLayer internals to back-write
// the store. Hit-test short-circuits edit-state overlays (hitTest HitTestEditKind)
// — the overlay owns its own input, the canvas hit-test is bypassed while active.

import { type CSSProperties, type ReactNode } from 'react'
import { Layer, layerZIndex } from './layers'

/** Screen-space viewport (matches the DOM .dom-canvas-layer transform). */
export type Viewport = { x: number; y: number; scale: number }

/**
 * Canvas → screen for an overlay child. cx/cy are canvas-space coords; the result
 * is the screen-space {x, y} (= CSS left/top) the child should use. The host is
 * full-size absolute over .canvas-shell, so children position relative to it.
 *
 * Equivalent to the .dom-canvas-layer transform applied to a single point:
 * translate(vx, vy) scale(s) on (cx, cy) → (cx*s + vx, cy*s + vy).
 */
// toContainer is a pure utility co-located with the overlay host (single contract
// file). react-refresh only-export-components is intentional — the host component
// is the single component export; toContainer is the math contract 3b consumers
// + tests import.
// eslint-disable-next-line react-refresh/only-export-components
export const toContainer = (
  viewport: Viewport,
  cx: number,
  cy: number,
): { x: number; y: number } => ({
  x: cx * viewport.scale + viewport.x,
  y: cy * viewport.scale + viewport.y,
})

/** Host style: covers .canvas-shell, ignores pointer, sits at the EditOverlay layer. */
const hostStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: layerZIndex(Layer.EditOverlay),
}

export type EditOverlayLayerProps = {
  /** Children render in screen space; each positions itself via toContainer. */
  children?: ReactNode
  /** Extra className on the host (e.g. 'mask-edit-active' / 'crop-edit-active'). */
  className?: string
}

/**
 * Screen-space overlay host. Mount as a direct child of .canvas-shell (sibling of
 * .dom-canvas-layer, NOT inside its transform). The host is pointer-events:none;
 * children opt in with pointer-events:auto where they need input.
 */
export const EditOverlayLayer = ({ children, className }: EditOverlayLayerProps) => (
  <div
    className={`edit-overlay-layer${className ? ` ${className}` : ''}`}
    style={hostStyle}
    data-testid="edit-overlay-layer"
  >
    {children}
  </div>
)
