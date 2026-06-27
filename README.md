# Mivo Canvas Demo

Mivo Canvas is an early interaction demo for the desktop-style AI art canvas discussed in the product notes. The first pass focuses on reviewable workflow instead of real AI integration:

- collapsible Codex-style project sidebar
- floating right-side AI generation parameter panel over the canvas
- central infinite-canvas-style workspace with canvas tools
- Section creation for visually grouping references on the infinite canvas
- group/ungroup, lock/unlock, hide/show-all, and fit-selection/fit-all organization actions
- selected-image floating action toolbar
- click-to-open image detail dialog
- original-asset download from image context menus
- non-destructive image cropping with crop metadata
- image nodes with generation memory
- Cowart-inspired mock AI workflow foundations: AI image slots, annotation edit notes, generated-beside results, non-destructive derivation links, and an AI-readable canvas context snapshot
- review scenes tucked into the project sidebar
- simulated beside generation and 4-variation generation
- Mivo JSON archive copy, export, and import with embedded local assets
- local persistence through Zustand

## Product direction notes

- New canvas features should start by checking mature GitHub references before implementation.
- Current image handling follows the same broad model used by mature infinite-canvas tools: keep the original asset separate from the canvas node that displays it.
- Local imports are stored as original blobs in IndexedDB. Canvas resizing, transparent PNG display, and crop windows only affect the node display frame.
- Crop is currently a first-pass rectangular display crop. It stores normalized `imageCrop` metadata and does not rewrite the original file.
- Sections are canvas organization nodes inspired by FigJam. They sit behind artwork by default, can be created with the Section tool (`F`) or the blank-canvas context menu, and support free resize, rename, style presets, lock modes, hide/show, focus, remove-only, duplicate, and delete-with-contents actions.
- Section membership is tracked on nodes with `sectionId`: dragging objects into/out of a Section updates membership, resizing a Section recalculates covered content, and moving a Section carries its contents.
- Section resize no longer has a practical hard canvas limit. Minimum sizes are still enforced, but large planning boards should not silently stop at a fixed demo size.
- Section drag-in feedback is boundary-only and uses the full moving selection, so multi-object drags only highlight a Section when the moved selection will land in that same Section.
- Section lock modes are separated into `Lock all` and `Lock background only`. `Lock all` freezes contained objects; `Lock background only` freezes the Section container while preserving editability of its contents.
- Object organization is modeled as reusable node metadata (`groupId`, `locked`, `hidden`) rather than image-only behavior, so future Markdown, video, PDF, and plugin nodes can share the same context menu and toolbar actions. Context menus and quick toolbars currently favor implemented actions over disabled roadmap items.
- Cowart is used as an interaction reference, not an architecture template. Mivo borrows the AI workflow ideas of holder/slot generation, annotation-driven edits, placing results beside the source, never overwriting originals, and exposing canvas state to AI; Mivo still keeps its current React/Leafer product and engine direction.
- AI workflow metadata is stored on nodes as `aiWorkflow`. Results point back to their source slot, annotation, or image through `sourceNodeIds`, `slotId`, and `annotationNodeId`, while original imported assets remain untouched for details, export, future AI reference, and asset-library handoff. AI placement and context snapshot helpers live in `src/store/aiCanvasWorkflow.ts`; generated-beside placement ignores the source object's containing Section as an obstacle, and AI context links are de-duplicated by relation kind and endpoints.
- The right-side AI panel can create an AI image slot, fill the selected slot with a mock result, add an editable annotation note for a selected object, generate a mock revised result from that note, generate a mock result beside the selection, and preview the serializable AI canvas context.
- Viewport position and zoom are persisted per canvas. Reset view still returns to the default camera.
- Useful references reviewed for this direction:
  - [zhongerxin/cowart](https://github.com/zhongerxin/cowart), especially AI image holders, annotation screenshot edits, generated-beside placement, original-preserving workflows, page-local assets, and AI-readable canvas/selection state.
  - [tldraw](https://github.com/tldraw/tldraw), especially the asset/shape separation model.
  - [Excalidraw](https://github.com/excalidraw/excalidraw), especially frame-style organization and lightweight canvas object actions.
  - [tldraw local images example](https://tldraw.dev/examples/local-images).
  - [xiaoiver/infinite-canvas-tutorial](https://github.com/xiaoiver/infinite-canvas-tutorial), especially camera, grid, event system, picking, culling, batching, and spatial-indexing lessons for the canvas engine layer.
  - [react-image-crop](https://github.com/dominictobias/react-image-crop), especially controlled crop state and percent crop ideas.
  - [Fabric.js cropping discussion](https://github.com/fabricjs/fabric.js/issues/1081), especially storing crop area while restoring the original image.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Verify

```bash
npm run build
npm run lint
npm run test:e2e
```

The current visible canvas layer is implemented with React DOM nodes so the demo is immediately reviewable. LeaferJS is installed and initialized as the intended canvas-engine base, but the visible layer is kept separate until the Leafer rendering path is fully validated.
