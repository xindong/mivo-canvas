# Mivo Canvas Demo

Mivo Canvas is an early interaction demo for the desktop-style AI art canvas discussed in the product notes. The first pass focuses on reviewable workflow instead of real AI integration:

- collapsible Codex-style project sidebar
- floating right-side AI generation parameter panel over the canvas
- central infinite-canvas-style workspace with canvas tools
- Section creation for visually grouping references on the infinite canvas
- FigJam-style markup tools for arrows, lines, rectangles, ellipses, freehand strokes, and lightweight notes
- group/ungroup, lock/unlock, hide/show-all, and fit-selection/fit-all organization actions
- selected-image floating action toolbar with crop and a compact AI edit menu
- double-click-to-open detail dialog for image, Markdown, PDF, and Video nodes
- original-asset download from image context menus
- non-destructive image cropping with crop metadata
- image nodes with generation memory
- Markdown, PDF, and Video asset nodes with original-file storage, canvas previews, detail previews, and shared organization actions
- Cowart-inspired mock AI workflow foundations: AI image slots, annotation edit notes, prompt/area image edits, generated-beside results, non-destructive derivation links, and an AI-readable canvas context snapshot
- review scenes tucked into the project sidebar
- simulated beside generation and 4-variation generation
- Mivo JSON archive copy, export, and import with embedded local assets
- local/Eagle/Pinterest Assets workspace with a shared source connector model
- local persistence through Zustand

## Product direction notes

- New canvas features should start by checking mature GitHub references before implementation.
- New user-facing features must follow the [Development Feedback Rule](docs/development-logging.md): emit Debug Log entries through `debugLogger` for diagnosable state changes, workflow results, skipped paths, and failures, and use `toastFeedback` for short user-visible success, info, warning, and error outcomes.
- Current image handling follows the same broad model used by mature infinite-canvas tools: keep the original asset separate from the canvas node that displays it.
- Local imports are stored as original blobs in IndexedDB. Canvas resizing, transparent PNG display, and crop windows only affect the node display frame.
- The Assets workspace uses the shared `AssetSource` / `AssetItem` model in `src/app/assetLibraryModel.ts` so Local, Eagle, Pinterest, and future sources can render through the same browser, details panel, drag payload, and canvas import path.
- The local source reads image files through a Vite dev middleware. By default it checks `~/Desktop/Images` and `~/Desktop/images`; set `MIVO_ASSET_DIR=/path/to/images npm run dev` to point it at another folder.
- Asset tiles show the source filename, format, decoded dimensions, and file size. Single-click opens a metadata detail panel; double-click adds the asset to the current canvas. Drag payloads and double-click imports both preserve the source file by importing a fresh original blob into IndexedDB before creating a canvas image node.
- Eagle is connected through its local Web API, defaulting to `http://127.0.0.1:41595`. Keep Eagle open, then switch the Assets source to `Eagle libraries` to read recent images, tags, source URLs, thumbnails, and originals. Set `MIVO_EAGLE_API_URL` if Eagle is exposed on a different host or port.
- Pinterest is currently a user-facing OAuth interaction prototype. Open `Assets` -> `Pinterest boards` -> `Add source` to review the intended product flow: users only see `Connect Pinterest`, status, refresh, and disconnect controls. App IDs, app secrets, scopes, and redirect URLs are intentionally not exposed in the UI. The real connector should later be backed by Mivo account services or a secure desktop credential store.
- Canvas asset import is centralized in `src/lib/canvasAssetImport.ts`. File picker import and drag-drop support images, Markdown (`.md`/`.markdown`), PDF, and common video files (`.mp4`, `.m4v`, `.mov`, `.webm`) through the same pipeline. Clipboard paste currently keeps the stable image path. Local folder assets and future Eagle/Pinterest connectors should enter the canvas through this pipeline so original assets remain untouched.
- Imported non-image files are stored as original blobs in IndexedDB just like images. Markdown nodes keep the original text for canvas/AI context and render a formatted document card on the canvas with `react-markdown` + `remark-gfm`, including headings, lists, task lists, tables, blockquotes, code blocks, links, images, and strikethrough. Short Markdown files default to `Full` canvas display and auto-fit their page height with a `ResizeObserver`; long Markdown files with many lines, characters, or images default to `Preview` display so the canvas keeps a movable fixed-height card while the details dialog remains the full reading surface. Markdown details use document-specific metadata, `Rendered` / `Raw` viewing, and `Copy Markdown` rather than image-generation prompt fields. PDF nodes use a lightweight canvas card plus browser-native detail viewer, and Video nodes read `videoWidth`/`videoHeight` from metadata so canvas thumbnails keep the real source aspect ratio. Video thumbnails use `preload="metadata"`, a centered play affordance, and a compact media label so large boards do not eagerly play or fully decode media.
- Detail surfaces use a shared product pattern: large type-aware preview on the left, compact source/status metadata and implemented actions on the right, and a denser asset-library detail panel for single-clicked Local/Eagle/Pinterest items. Future file types should add their preview, metadata, and actions through this structure rather than creating separate one-off panels.
- Floating quick toolbars stay action-focused and no longer expose `Details`; opening details is a canvas-level double-click behavior, with right-click detail actions kept as a fallback.
- Markdown and Video selections do not show download-only quick toolbars; PDF keeps `Download original` as a direct file action.
- Floating quick toolbars avoid broad `Copy` actions and most destructive `Delete` actions. Copy remains available through keyboard shortcuts and right-click menus, while dangerous deletes stay in the full context menu except for high-frequency temporary Markup cleanup.
- Multi-selection quick toolbars include FigJam-inspired layout helpers. `Align` keeps edge/center alignment and distribution actions, while `Arrange` can tidy selected objects into a row, column, or adaptive grid without resizing them. Connector line/arrow nodes are ignored by these tidy actions so relationship marks are not accidentally rearranged. Smart Selection spacing is now modeled in `src/canvas/smartSelection.ts`: it detects row, column, and simple grid selections, renders lightweight canvas-level gap handles, and dragging any gap handle adjusts the whole row/column/grid axis to a uniform spacing instead of only pushing one neighbor.
- Crop is currently a first-pass rectangular display crop. It stores normalized `imageCrop` metadata and does not rewrite the original file.
- Sections are canvas organization nodes inspired by FigJam. They sit behind artwork by default, can be created with the Section tool (`F`) or the blank-canvas context menu, and support free resize, rename, style presets, lock modes, hide/show, focus, remove-only, duplicate, and delete-with-contents actions.
- Section membership is tracked on nodes with `sectionId`: dragging objects into/out of a Section updates membership, resizing a Section recalculates covered content, and moving a Section carries its contents.
- Section resize no longer has a practical hard canvas limit. Minimum sizes are still enforced, but large planning boards should not silently stop at a fixed demo size.
- Section drag-in feedback is boundary-only and uses the full moving selection, so multi-object drags only highlight a Section when the moved selection will land in that same Section.
- Section lock modes are separated into `Lock all` and `Lock background only`. `Lock all` freezes contained objects; `Lock background only` freezes the Section container while preserving editability of its contents.
- Markup is modeled as its own `markup` node type instead of being baked into images. Markup nodes store `markupKind`, points, stroke/fill style, dash style, opacity, and an optional `targetNodeId`, so annotations can later be read by AI workflows without mutating the referenced asset.
- The first Markup tool set keeps Arrow (`A`), Line (`L`), Rectangle (`R`), Ellipse (`O`), and Brush (`P`) behind one hoverable Draw toolbar button so future shapes can expand the same second-level tool tray. Markup note (`N`) remains separate from shape drawing.
- Drawn markup can be placed directly over existing canvas objects, returns to Select after placement, and does not immediately show the purple edit frame. A second click selects it; arrow and line markup then expose endpoint handles for FigJam-style direction editing, while filled shapes use the normal bounding-box resize handles. Double-clicking any markup shape edits text inside that object instead of opening image details.
- Markup text belongs to the markup node itself. Rectangles, ellipses, freehand strokes, and notes render text inside their bounds; arrow and line labels sit at the connector midpoint and move with endpoint edits. Empty markup text clears only the label, while empty newly-created text nodes are still removed so invisible text boxes are not left on the canvas.
- Markup text editing uses a transparent editor in the same visual position as the final label. Arrow and line labels also split the visible stroke around the text, closer to FigJam's connector-label treatment.
- Arrow and line markup can bind each endpoint to nearby canvas objects through `connectorStart` and `connectorEnd` metadata. Endpoints snap only near the center or edge hot zones, and edge bindings keep a specific offset along the nearest top/right/bottom/left edge; the interior remains free for loose arrows. Bound endpoints show filled handles and automatically follow the connected object when it moves or resizes.
- Connector bindings are serializable canvas semantics. AI context snapshots include `connectorStart`, `connectorEnd`, and `connector` links when both sides are bound, so future agents can read visual relationships rather than only spatial proximity.
- Selected markup exposes compact icon-only quick actions for editing text, fill color, a combined Line menu, arrowhead style, rectangle corner radius, duplicate, layer front, and delete. The Line menu combines stroke color, dashed/solid style, and thin/medium/bold stroke choices so outline editing stays in one place.
- Color quick-toolbar menus use a shared swatch palette instead of text-only color rows. Fill actions render the current color directly as a circular chip in the toolbar, while line actions render a compact line preview for current stroke color, weight, and dash state. Section fill/line and Markup fill/line actions keep accessible labels while using compact FigJam-style chips, including a checkerboard chip for transparent/no-fill states.
- Text color chips reuse the same selected-ring and swatch sizing as Section and Markup palettes. If Mivo later needs custom color picking beyond presets, `react-colorful` is the preferred candidate because it is a small, dependency-free React/Preact picker with TypeScript support.
- Arrow and line hit-testing uses a transparent stroke around the visible line instead of the full bounding rectangle, so diagonal arrows do not block nearby image selections. Holding Shift while drawing constrains rectangles/ellipses to squares/circles, constrains lines/arrows to 45-degree increments, and turns Brush into a straight constrained stroke.
- AI annotation edit notes intentionally use a different blue-accent style from yellow Markup notes so product-facing AI instructions and general visual markups do not read as the same object family.
- Object organization is modeled as reusable node metadata (`groupId`, `locked`, `hidden`) rather than image-only behavior, so Markdown, video, PDF, and future plugin nodes can share the same context menu and toolbar actions. Context menus and quick toolbars currently favor implemented actions over disabled roadmap items.
- Cowart is used as an interaction reference, not an architecture template. Mivo borrows the AI workflow ideas of holder/slot generation, annotation-driven edits, placing results beside the source, never overwriting originals, and exposing canvas state to AI; Mivo still keeps its current React/Leafer product and engine direction.
- AI workflow metadata is stored on nodes as `aiWorkflow`. Results point back to their source slot, annotation, or image through `sourceNodeIds`, `slotId`, and `annotationNodeId`, while original imported assets remain untouched for details, export, future AI reference, and asset-library handoff. AI placement and context snapshot helpers live in `src/store/aiCanvasWorkflow.ts`; generated-beside placement ignores the source object's containing Section as an obstacle, and AI context links are de-duplicated by relation kind and endpoints.
- Image quick-toolbar AI actions are modeled as future-ready operations: `prompt-edit`, `area-edit`, `remove-background`, `outpaint`, and `upscale`. The current demo creates editable prompt/area annotation notes or mock beside-results while preserving operation metadata for a later real AI adapter.
- The right-side AI panel can create an AI image slot, fill the selected slot with a mock result, add an editable annotation note for a selected object, generate a mock revised result from that note, generate a mock result beside the selection, and preview the serializable AI canvas context.
- Viewport position and zoom are persisted per canvas. Trackpad/mouse-wheel scrolling pans the canvas, `Ctrl`/`Command` + wheel zooms around the pointer, `Shift+1` fits all objects, `Shift+2` fits the current selection, and `Ctrl/Command+0` resets to the default camera.
- Rendering strategy: Mivo currently keeps canvas objects as DOM/SVG nodes for fast iteration and rich editing controls, but avoids persistent `will-change: transform` on the canvas layer or nodes because browser raster caches can make zoomed text, images, and SVG markups blurry until a repaint. The DOM layer now uses viewport culling with generous overscan, while selected, cropped, and context-menu nodes stay mounted for stable interaction.
- Performance direction: follow the mature infinite-canvas pattern of "store everything, render only what is near the viewport". Future image-heavy boards should add image LOD/thumbnail resolution selection based on on-screen size and device pixel ratio. If DOM/SVG becomes the bottleneck for very large boards, move static artwork to a Canvas/WebGL-backed layer while keeping DOM overlays for text editing, handles, menus, and active tools.
- Canvas node type knowledge now starts in `src/canvas/nodeTypes/canvasNodeRegistry.ts`. Each node type declares its render kind, default size, import behavior, and capabilities there, while `src/canvas/nodeTypes/nodeCapabilities.ts` owns the shared capability vocabulary.
- Selection, rendering, and node creation now read from that registry for capabilities, render kind, and default sizes. New node families such as plugin output, audio, web snapshots, or richer document viewers should be introduced through the registry first, then wired into store/import behavior.
- Action runtime types live in `src/canvas/actions/canvasActionTypes.ts`. Common actions remain in the base action model, while node-specific right-click and quick-toolbar actions are composed through `contextMenuExtensionsByNodeType` and `quickToolbarExtensionsByNodeType`.
- Useful references reviewed for this direction:
  - [FigJam quick bar study](docs/figjam-quickbar-study.md), Mivo's public-behavior quick-bar specification and implementation checklist.
  - [OpenPencil](https://github.com/open-pencil/open-pencil), especially the idea of keeping editor behavior behind shared document/tree, selection, command/menu, and tool abstractions. Mivo treats it as an architecture reference for editor modularity, not a direct UI clone.
  - [zhongerxin/cowart](https://github.com/zhongerxin/cowart), especially AI image holders, annotation screenshot edits, generated-beside placement, original-preserving workflows, page-local assets, and AI-readable canvas/selection state.
  - [tldraw](https://github.com/tldraw/tldraw), especially the asset/shape separation model and node-level shape behaviors.
  - [tldraw performance docs](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/sdk-features/performance.mdx), especially viewport culling, efficient zoom, geometry caching, and image LOD/resolution scaling.
  - [Excalidraw](https://github.com/excalidraw/excalidraw), especially frame-style organization and lightweight canvas object actions.
  - [Excalidraw renderer source](https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/renderer), especially canvas-context redraw, visible element filtering, and DPR-aware rendering rather than relying on browser-scaled DOM caches.
  - [Konva performance tips](https://github.com/konvajs/site/blob/master/source/docs/performance/All_Performance_Tips.md), especially the rules to compute as little as possible, draw as little as possible, manage layers carefully, and treat pixel ratio as a quality/performance tradeoff.
  - [PDF.js](https://github.com/mozilla/pdf.js), especially the mature browser PDF rendering route for future page thumbnails and per-page previews.
  - [react-pdf](https://github.com/wojtekmaj/react-pdf), especially its React wrapper approach around PDF.js for a future componentized PDF node/detail viewer.
  - [react-markdown](https://github.com/remarkjs/react-markdown), especially rendering Markdown into React elements instead of injecting raw HTML.
  - [remark-gfm](https://github.com/remarkjs/remark-gfm), especially GitHub Flavored Markdown support for tables, task lists, strikethrough, and autolinks.
  - [Excalidraw bound arrow text discussion](https://github.com/excalidraw/excalidraw/issues/5010), especially the expectation that double-clicking a line/arrow can add text connected to that line/arrow.
  - [Figma FigJam connector docs](https://help.figma.com/hc/en-us/articles/1500004414542-Create-diagrams-and-flows-with-connectors-in-FigJam), especially connector customization with text, endpoints, stroke weight, and line style.
  - [Figma FigJam text docs](https://help.figma.com/hc/en-us/articles/1500004291281-Create-text-and-links-in-FigJam), especially the idea that shapes, stickies, text objects, and connectors can all own editable text.
  - [Rough.js](https://github.com/rough-stuff/rough), especially the idea of keeping hand-drawn markups as vector-like drawing instructions rather than rasterizing them into source images.
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
