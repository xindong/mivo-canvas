# Mivo Document Model v2 Design

## Goal

Move MivoCanvas from a demo-oriented flat node shape toward a semantic design document model that can be understood by the UI, AI workflow, and future renderers without forcing a full canvas rewrite.

## First-Phase Scope

This phase adds a compatible v2 layer on top of the current `MivoCanvasNode` model:

- Keep existing top-level fields such as `x`, `y`, `width`, `height`, `assetUrl`, `textColor`, and markup fields so the current React/SVG renderer keeps working.
- Add semantic fields for `transform`, `fills`, `strokes`, `effects`, `layout`, `constraints`, `asset`, and `relations`.
- Provide normalization helpers that derive v2 fields from legacy fields and keep legacy geometry synchronized from `transform`.
- Provide a small command API for future AI/editor operations to use instead of manually patching arbitrary node fields.
- Cover the new model bridge with unit tests.

## Architecture

The new model is intentionally additive. `MivoCanvasNode` remains the runtime object used by the existing store and renderer, but it can now carry v2 semantic fields. A new document model module owns normalization and command helpers so future rendering adapters, AI snapshots, import/export, and store mutations have one shared vocabulary.

The store should not be rewritten in this phase. It can continue using current helpers, while targeted mutation paths call the new command helpers where the behavior directly overlaps. This avoids a high-risk migration and creates a path for later UI features such as rotation, unified fills/strokes, blend modes, and layout.

## Data Model

`transform` stores document-space geometry:

- `x`
- `y`
- `width`
- `height`
- `rotation`

`fills` stores ordered paint layers:

- solid color fills
- image fills referencing an asset

`strokes` stores outline styling:

- color
- width
- style
- opacity

`effects` stores render effects such as shadow, blur, and opacity. This phase defines the type but does not add new UI for effects.

`layout` and `constraints` are typed placeholders for future frame and auto-layout behavior. This phase defines their shape only.

`asset` stores a normalized asset reference:

- url
- mime type
- original name
- size bytes

`relations` stores model-level relationships:

- parents
- section
- target
- connectors
- AI workflow links

## Commands

The first command API should be small and deterministic:

- `normalizeCanvasNodeV2(node)` returns a new node with v2 fields populated and legacy geometry synchronized.
- `normalizeCanvasNodesV2(nodes)` normalizes an array.
- `setNodeTransform(node, patch)` updates semantic transform and legacy geometry.
- `setNodeFills(node, fills)` updates semantic fills and legacy fill-related fields where appropriate.
- `setNodeStrokes(node, strokes)` updates semantic strokes and legacy stroke-related fields where appropriate.
- `setNodeAsset(node, asset)` updates semantic asset and legacy asset fields.
- `setNodeRelations(node, relations)` updates semantic relations and legacy relation fields.

Commands return new objects and do not mutate input nodes.

## Rendering Strategy

The current DOM/SVG renderer remains the visible path. New renderer adapter work should read from normalized v2 fields but fall back to legacy fields. Rotation is enabled structurally by `transform.rotation`, but this phase does not need to make every interaction rotation-aware.

## Testing

Unit tests should verify:

- legacy geometry becomes a v2 transform
- transform updates keep `x`, `y`, `width`, and `height` in sync
- image nodes derive image fills and asset refs
- markup and frame legacy styles become fills/strokes
- relations are derived without mutating existing arrays
- command helpers preserve unrelated node data

## Out Of Scope

- Full renderer migration to Canvas/WebGL
- Complete Figma-style auto layout
- Multiplayer operations or CRDT
- Import/export format migration
- Rotated hit testing and resize handles
