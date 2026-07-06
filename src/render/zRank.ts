// zRank — single source for node → z-order rank (layer + within-layer renderOrder).
//
// 2b-2 z-order: projection.projectNode writes RenderNode.layer / renderOrder, the
// Leafer hook builds the child zIndex map from the same policy (leaferZOrderMapFor),
// and hitTest.defaultZOrderCompare reads them back. Before this module, the layer
// policy was hardcoded in THREE places (projection.projectNode, leaferShapePaint
// .shapeLayerFor + .leaferZOrderMapFor) — `node.type === 'frame' ? Frame : Content`
// duplicated, and renderOrder was a flat 0 everywhere. The V2 stamp work lifts stamp
// above every other Content node (incl. a selected image) by giving it renderOrder 1;
// centralizing the policy here means DOM zIndex, Leafer child order, and hit-test all
// follow one rule instead of three drifting hardcodes.
//
// Red line (review P2-1): renderOrder is render-only. documentModelV2 / persistence
// never carries it — projectNode attaches it on the render side, same as `layer` /
// `surface`. No new Layer tier is introduced (stamp stays in Layer.Content; it wins
// via renderOrder, the within-layer tiebreaker — not by jumping to a new band), and
// brush/line/note are NOT elevated here (out of scope for V2 stamp).

import { Layer } from './layers'
import type { MivoCanvasNode } from '../types/mivoCanvas'

/**
 * Stable layer a node paints in. Frame → Layer.Frame (bottom); every other type →
 * Layer.Content. Single source — projection.projectNode, leaferShapePaint
 * .shapeLayerFor and .leaferZOrderMapFor all call this so the DOM zIndex, Leafer
 * child order and hit-test comparator read one policy.
 */
export const layerForNode = (node: MivoCanvasNode): Layer =>
  node.type === 'frame' ? Layer.Frame : Layer.Content

/**
 * Within-layer render rank (2nd z-order tiebreaker, after layer, before selected).
 * stamp → 1 (paints + hit-tests above every other Content node, including a
 * SELECTED image — defaultZOrderCompare checks renderOrder before `selected`, so a
 * stamp at renderOrder 1 outranks a selected image at renderOrder 0 inside the same
 * Layer.Content). Everything else → 0 (document order / selected lift own the rest).
 *
 * Not persisted; render-only. projectNode attaches it; leaferZOrderMapFor encodes it
 * into the Leafer child zIndex band so Leafer stacks the same way.
 */
export const renderZRankForNode = (node: MivoCanvasNode): number =>
  node.type === 'markup' && node.markupKind === 'stamp' ? 1 : 0
