// layers — canonical render layer order (P3-0a, roadmap §8).
//
// Current main branch uses DOM-order stacking (no inline zIndex in src —
// verified via `grep -rn "zIndex" src`). The Layer enum assigns explicit zIndex
// values so P3-0b's InteractionAdapter + overlay containers can rely on a single
// declared order instead of JSX positional fragility.
//
// D2's AnchorOverlay (PR #35, feat/p2-d2-anchor-dom) already uses zIndex:50 for
// its floating instruction panel — that matches `Layer.FloatingUI` here.
//
// Mapping to current DOM order (MivoCanvas.tsx, back→front):
//   1. frame / section backgrounds              → Layer.Frame
//   2. content nodes (image/text/markup/...)     → Layer.Content
//   3. selected node elevation (DOM-order lift)  → Layer.SelectedElevated
//   4. drag preview / marquee / ghost            → Layer.Preview
//   5. selection handles / resize handles        → Layer.Handles
//   6. floating UI (anchor overlay panel, ctx menu, popovers) → Layer.FloatingUI
//
// Edit-state overlays (crop/mask/text-edit) short-circuit hit-test and render
// ABOVE FloatingUI — they are not a stable layer but an ephemeral top-most
// surface (see hitTest.editState short-circuit rule, README §编辑态短路).

export const Layer = {
  Frame: 0,
  Content: 10,
  SelectedElevated: 20,
  Preview: 30,
  Handles: 40,
  FloatingUI: 50,
  // Ephemeral edit surface (crop/mask/text-edit). Highest; not a stable layer.
  EditOverlay: 60,
} as const

export type Layer = typeof Layer[keyof typeof Layer]

// CSS value for `z-index` style. Use: style={{ zIndex: layerZIndex(Layer.Handles) }}.
export const layerZIndex = (layer: Layer): number => layer

// Human-readable name for debugging / React data-attr.
export const layerName = (layer: Layer): string => {
  switch (layer) {
    case Layer.Frame:
      return 'frame'
    case Layer.Content:
      return 'content'
    case Layer.SelectedElevated:
      return 'selected-elevated'
    case Layer.Preview:
      return 'preview'
    case Layer.Handles:
      return 'handles'
    case Layer.FloatingUI:
      return 'floating-ui'
    case Layer.EditOverlay:
      return 'edit-overlay'
    default:
      return 'unknown'
  }
}

// CSS variable name (declared in App.css :root) for each layer. App.css defines:
//   :root {
//     --layer-frame: 0; --layer-content: 10; --layer-selected-elevated: 20;
//     --layer-preview: 30; --layer-handles: 40; --layer-floating-ui: 50;
//     --layer-edit-overlay: 60;
//   }
// Canvas-layer rules use `z-index: var(--layer-handles)` so DOM z-order reads from
// the same source as layerZIndex() (inline styles) and RenderNode.layer (hit-test).
// Keep the :root values in App.css in sync with the Layer enum above.
export const LayerCssVar = {
  Frame: '--layer-frame',
  Content: '--layer-content',
  SelectedElevated: '--layer-selected-elevated',
  Preview: '--layer-preview',
  Handles: '--layer-handles',
  FloatingUI: '--layer-floating-ui',
  EditOverlay: '--layer-edit-overlay',
} as const

// `var(...)` expression for a layer — for CSS-in-JS / dynamic stylesheets that want
// the indirection. Inline React styles should use layerZIndex() (numeric) instead,
// so the value is available without a CSS variable lookup.
export const layerCssVar = (layer: Layer): string => {
  switch (layer) {
    case Layer.Frame:
      return `var(${LayerCssVar.Frame})`
    case Layer.Content:
      return `var(${LayerCssVar.Content})`
    case Layer.SelectedElevated:
      return `var(${LayerCssVar.SelectedElevated})`
    case Layer.Preview:
      return `var(${LayerCssVar.Preview})`
    case Layer.Handles:
      return `var(${LayerCssVar.Handles})`
    case Layer.FloatingUI:
      return `var(${LayerCssVar.FloatingUI})`
    case Layer.EditOverlay:
      return `var(${LayerCssVar.EditOverlay})`
    default:
      return `var(${LayerCssVar.Content})`
  }
}
