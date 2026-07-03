// viewportMatrix — canonical screen↔canvas transform (P3-0a, SC6.1).
//
// Single source of truth for the viewport matrix. Supersedes the inline math in
// canvasInteraction.clientPointToCanvas (screen→canvas) and the ad-hoc
// `viewport.x + x * viewport.scale` container-local conversions scattered in
// MivoCanvas.tsx / D2 AnchorOverlay. P3-0b rewires useViewport + the controller
// to read from here; P3-0a only provides the module + tests (no behavior change).
//
// Coordinate spaces:
//   - canvas space: node transform.x/y live here (unaffected by viewport).
//   - screen space: clientX/clientY from PointerEvent (CSS px, DPR-adjusted via
//     getBoundingClientRect; DPR does NOT enter the matrix — rect is already CSS px).
//   - container-local: screen minus rect.left/top (children of the transformed
//     canvas-content layer use this; = canvasToScreen - {rect.left, rect.top}).
//
// canvas → screen:  screen = canvas * scale + translate
//   where translate = viewport.{x,y} + rect.{left,top}, scale = viewport.scale.
// screen → canvas:  canvas = (screen - translate) / scale.

export type Viewport = {
  x: number
  y: number
  scale: number
}

export type ViewportRect = {
  left: number
  top: number
  width: number
  height: number
}

export type CanvasPoint = {
  x: number
  y: number
}

// Uniform scale + translate (no rotation/shear in the viewport). Keeping this
// axis-aligned lets hit-test + anchor projection stay in closed form.
export type ViewportMatrix = {
  scale: number
  translateX: number
  translateY: number
}

export const createViewportMatrix = (viewport: Viewport, rect: ViewportRect): ViewportMatrix => ({
  scale: viewport.scale,
  translateX: viewport.x + rect.left,
  translateY: viewport.y + rect.top,
})

// canvas → screen.
export const applyMatrix = (matrix: ViewportMatrix, canvasX: number, canvasY: number): CanvasPoint => ({
  x: canvasX * matrix.scale + matrix.translateX,
  y: canvasY * matrix.scale + matrix.translateY,
})

// Returns the inverse (screen → canvas). Precomputed so callers can batch many
// points through `applyMatrix` without re-inverting per point.
export const invertMatrix = (matrix: ViewportMatrix): ViewportMatrix => ({
  scale: 1 / matrix.scale,
  translateX: -matrix.translateX / matrix.scale,
  translateY: -matrix.translateY / matrix.scale,
})

// screen → canvas. Bit-for-bit identical to canvasInteraction.clientPointToCanvas
// (kept here as the canonical implementation; clientPointToCanvas stays as the
// legacy delegate until P3-0b rewires useViewport).
export const screenToCanvas = (
  rect: ViewportRect | undefined,
  viewport: Viewport,
  clientX: number,
  clientY: number,
): CanvasPoint => {
  if (!rect) return { x: 0, y: 0 }
  return applyMatrix(invertMatrix(createViewportMatrix(viewport, rect)), clientX, clientY)
}

// canvas → screen (full: includes rect.left/top). For container-local positioning
// (children of the transformed canvas-content layer), subtract rect.left/top from
// the result, or use canvasToContainer.
export const canvasToScreen = (
  rect: ViewportRect | undefined,
  viewport: Viewport,
  canvasX: number,
  canvasY: number,
): CanvasPoint => {
  if (!rect) return { x: 0, y: 0 }
  return applyMatrix(createViewportMatrix(viewport, rect), canvasX, canvasY)
}

// canvas → container-local (screen minus rect origin). Use this for DOM children
// that live INSIDE the transformed canvas-content layer (their parent already
// applied translate+scale, so they only need the intra-layer offset).
export const canvasToContainer = (viewport: Viewport, canvasX: number, canvasY: number): CanvasPoint => ({
  x: canvasX * viewport.scale + viewport.x,
  y: canvasY * viewport.scale + viewport.y,
})

// container-local → canvas (inverse of canvasToContainer).
export const containerToCanvas = (viewport: Viewport, containerX: number, containerY: number): CanvasPoint => ({
  x: (containerX - viewport.x) / viewport.scale,
  y: (containerY - viewport.y) / viewport.scale,
})
