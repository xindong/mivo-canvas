# DOM Virtualization 0e Spike - final go/no-go

> Date: 2026-07-05
> Branch: `feat/dom-0e-virtualization`
> Baseline: `origin/main @ d4b54e9`
> Gate: 20k DOM virtualized pan p95 <= 33ms, worst DPR, with duration / Long Task totals not anomalous
> Verdict: **NO-GO**

## Scope

Phase 0e tested the route-D hypothesis: keep the DOM renderer, but move viewport culling out of the per-pointermove pan path.

The spike is flag-gated behind `?virtualize=on`:

- Default `virtualize=off` and existing `?culling=on|off` semantics are unchanged.
- `MivoCanvas.tsx` no longer owns the culling filter directly; it calls `useCanvasVirtualization`.
- Legacy culling keeps the existing 520px overscan and selected-id pinning behavior.
- Virtualized mode uses 0px overscan for the most favorable pan result, freezes the materialized set during pan, moves the DOM layer imperatively, and commits the real React viewport after a 120ms settle.
- Virtualized mode does not pin all `selectedNodeIds`; it only pins the primary/edit/context nodes. `Ctrl+A` therefore does not materialize all 20k nodes.
- Materialization is scheduled by rAF batches. This is spike-grade, not a production scheduler.

`src/canvas/MivoCanvas.tsx` remains under the red line: `origin/main` 848 lines -> final 816 lines.

## Measurement Evidence

Bench now passes `virtualize=on|off` through to the page and rejects DOM virtualized rows unless:

- `.canvas-shell` reports `data-virtualize-active="true"`.
- `data-virtualize-pending="false"`.
- `virtualizeMaterializedNodeCount === virtualizeTargetNodeCount > 0`.
- DOM rendered node count is non-zero.
- A screenshot pixel sample over rendered DOM nodes is non-empty.

All final 0e rows below passed those gates.

## Profile Before Implementation

The first profile target was 20k DOM `culling=on` before 0e changes:

| row | rendered DOM | pan p95 ms | pan duration ms | pan long-task total ms | interpretation |
|---|---:|---:|---:|---:|---|
| DOM culling-on, pre-change single run | 14,462 | 59.2 | 119,534.5 | 117,284 | Per-pointermove React/viewport updates are expensive, but the row already materializes most of the board. |
| Existing freeze-only probe (`panCache=on` on DOM) | 14,462 | 691.4 | 99,745.1 | 98,794 | Avoiding React viewport commits alone is not enough; moving a huge DOM layer still creates long tasks. |
| 0e final virtualize, DPR1 median | 6,512 | 658.3 | 49,699.3 | 48,172 | Reducing materialized DOM cuts duration roughly in half, but is still far above the gate. |

Important correction: the earlier "20k culling-on only mounts 1,743 DOM nodes" number came from 0d Pixi, where Pixi painted image/frame/rect/text and the DOM layer only kept leftover nodes. The true DOM-renderer culling-on row materializes 14k+ nodes at the fixture's recommended zoom.

The root cause is therefore not just O(20k) filtering. At the recommended viewport scale (`0.08`), the viewport is a zoomed-out board view; even with overscan set to `0`, DOM virtualized mode still materializes thousands of nodes. Transforming and repainting that DOM layer dominates pan.

## Final Matrix

Runs: 3 each. Browser: Playwright Chromium. Viewport: 1920x1080. Seed: 20260704. Renderer: DOM. Culling: on. Virtualize: on. Drag segment skipped so pan/zoom stay isolated from node-move writes.

| nodes | DPR | pan p50 ms | pan p95 ms | pan duration ms | pan long tasks | pan long-task total ms | zoom p95 ms | materialized DOM | pixel |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 5,000 | 1 | 8.4 | 300.0 | 22,334.0 | 74 | 21,687 | 183.3 | 4,475 / 4,475 | true |
| 5,000 | 2 | 8.4 | 175.0 | 13,734.2 | 75 | 13,095 | 191.4 | 4,475 / 4,475 | true |
| 10,000 | 1 | 8.4 | 606.8 | 45,383.8 | 75 | 44,535 | 50.1 | 6,262 / 6,262 | true |
| 10,000 | 2 | 8.4 | 333.3 | 25,552.6 | 75 | 24,832 | 233.7 | 6,262 / 6,262 | true |
| 20,000 | 1 | 8.4 | 658.3 | 49,699.3 | 76 | 48,172 | 208.3 | 6,512 / 6,512 | true |
| 20,000 | 2 | 8.4 | 349.8 | 27,084.1 | 77 | 26,370 | 257.9 | 6,512 / 6,512 | true |

Worst DPR is DPR1. 20k pan p95 is **658.3ms**, which is above the 33ms GO line and above the 50ms gray-zone line.

Duration and Long Task totals are also high, so this is not just a p95 sampling artifact.

## Image Fixture Recon

One extra 20k DPR1 run used `--fixture-profile=large-images`, which expands image node dimensions while still using the real `/demo-assets/courage-*.jpg` files. This row is **not** a gate row because it changes geometry and viewport distribution.

| fixture | nodes | DPR | runs | pan p95 ms | pan duration ms | pan long-task total ms | zoom p95 ms | materialized DOM | note |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| large-images | 20,000 | 1 | 1 | 166.8 | 13,695.4 | 12,975 | 141.7 | 6,758 / 6,758 | Recon only; changed geometry makes it non-comparable to the mixed gate fixture. |

The faster p95 here should not be read as "large images are cheaper." It is a different layout distribution. The useful signal is that image-specific evaluation needs a dedicated fixture design instead of mutating the mixed gate fixture.

## Five-Way Comparison

| Source | Renderer / config | pan p95 ms | pan duration ms | pan long-task total ms | Render evidence |
|---|---|---:|---:|---:|---|
| 0b app | DOM culling on | 100.1 | 228,704.7 | 227,291 | 14,462 DOM nodes |
| 0b app | Leafer culling on | 75.3 | 95,805.0 | 90,291 | 13,200 / 13,200 Leafer children |
| 0c app | Leafer pan-cache on | 241.6 | 17,038.2 | 16,412 | 13,200 / 13,200 Leafer children, capture=1 |
| #91 bare probe | Pixi text skip | 26.1 | not comparable | not comparable | bare engine ceiling |
| #91 bare probe | Pixi per-node text | 50.1 | not comparable | not comparable | bare engine text bottleneck |
| 0d app | Pixi in-app BitmapText | 341.5 | 51,313.3 | 50,845 | 17,600 / 17,600 Pixi children |
| 0e app | DOM virtualize on | 658.3 | 49,699.3 | 48,172 | 6,512 / 6,512 DOM nodes, pixel non-empty |

The cross-phase pattern is now consistent: engine choice alone does not solve the app-layer cost, and DOM viewport virtualization alone does not solve zoomed-out all-board pan.

## Decision

**NO-GO for DOM virtualization alone as the 20k pan solution.**

The spike removes per-pointermove visible-set recomputation from the pan path and cuts materialized DOM from 14,462 to 6,512 at 20k. That helps total duration but remains an order of magnitude over the bar.

The next viable direction must reduce pan-time work below "thousands of live DOM nodes":

- zoom-threshold LOD / aggregation for tiny text, connectors, and image thumbnails;
- tile or bitmap cache so pan moves cached surfaces rather than individual DOM nodes;
- or a hybrid where DOM is reserved for editable near-field objects and far-field content is rasterized.

Pure DOM viewport windowing is not Figma-level enough for this fixture because the gate starts from a zoomed-out board view where too much content is legitimately visible.

## Validation

- `npm run build` passed.
- `npm run lint` passed.
- `npm run test:unit` passed: 55 files, 684 passed, 12 skipped.
- `npm run verify:logging` passed.
- `node scripts/ci/structure-guard.mjs` passed: 0 FAIL, 1 existing warning.
- `npm run visual:diff -- --candidate=dom --port=4199` passed: DOM-vs-DOM diff 0%.
