# Leafer 0b Spike - final go/no-go

> Date: 2026-07-05
> Branch: `feat/leafer-0b-spike`
> Baseline: `origin/main @ 65c03f1`
> Gate: 20k Leafer pan p95 <= 33ms
> Verdict: **NO-GO for Phase 2b without a culling/virtualization spike first**

## Scope

Phase 0b implemented the smallest useful Leafer renderer:

- Leafer host with `hittable:false`, initialized only after the host has non-zero layout.
- One-way camera sync: React viewport -> `leafer.zoomLayer.set({ x, y, scaleX, scaleY })`.
- True Leafer paint for `image`, `frame`, and `markup rect`; those nodes are removed from DOM in `?renderer=leafer`.
- Text, connectors, markdown, AI slots, and non-rect markup remain DOM.
- Reconcile is id-based and updates only when paint-relevant node content changes; pan/zoom only syncs camera.
- Bench and visual tools now wait for actual Leafer paint evidence before accepting numbers.

`src/canvas/MivoCanvas.tsx` is still under the red line: `origin/main` 885 lines -> final 861 lines.

## Invalidated Data

The two earlier 0b runs are invalid and were moved to `bench/baselines/0b-invalid-*`.

What failed:

- Bench accepted `?renderer=leafer` numbers without proving Leafer actually painted.
- This allowed empty-canvas runs to look unrealistically fast, especially the prior 20k Leafer p95=10.4ms.
- Visual diff captured before Leafer paint settled, producing the earlier 10.47% diff.
- CDP tracing was unstable at 10k+ and could hang; the final matrix uses in-page rAF frame intervals plus Long Task data as the measurement source, with synthetic trace markers only for self-check shape.

Final validity checks:

- Each Leafer run records `renderState.leaferExpectedChildren`, `renderState.leaferChildren`, `renderState.leaferPixelNonEmpty`, and `renderState.leaferSyncVersion`.
- Bench rejects Leafer runs unless `children === expectedChildren`, expected is >0, and a canvas pixel sample is non-empty.
- Visual diff waits on the same evidence.

## Final Matrix

Runs: 3 each. Browser: Playwright Chromium. Viewport: 1920x1080. DPR: 1. Seed: 20260704.

| nodes | renderer | culling | pan p95 ms | zoom p95 ms | load ms | sync ms | heap delta MB | long tasks | Leafer children |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 5000 | dom | on | 43.3 | 33.4 | 2484.6 | 438.5 | 68.5 | 156 | 0 |
| 5000 | dom | off | 42.7 | 50.0 | 2451.6 | 455.3 | 68.5 | 168 | 0 |
| 5000 | leafer | on | 173.5 | 25.1 | 1781.2 | 431.8 | 39.9 | 152 | 3300 / 3300 |
| 5000 | leafer | off | 175.1 | 133.3 | 1784.5 | 435.0 | 46.2 | 160 | 3300 / 3300 |
| 10000 | dom | on | 58.6 | 91.8 | 5697.7 | 797.5 | 121.8 | 159 | 0 |
| 10000 | dom | off | 66.7 | 950.0 | 5745.0 | 813.3 | 127.4 | 177 | 0 |
| 10000 | leafer | on | 592.6 | 150.0 | 4431.2 | 808.4 | 89.0 | 155 | 6600 / 6600 |
| 10000 | leafer | off | 666.9 | 524.1 | 4461.9 | 797.7 | 89.4 | 164 | 6600 / 6600 |
| 20000 | dom | on | 100.1 | 149.9 | 13825.5 | 1555.6 | 242.9 | 232 | 0 |
| 20000 | dom | off | 125.1 | 150.0 | 14691.1 | 1559.1 | 300.8 | 249 | 0 |
| 20000 | leafer | on | 75.3 | 274.2 | 11379.6 | 1557.3 | 150.1 | 155 | 13200 / 13200 |
| 20000 | leafer | off | 83.4 | 66.9 | 12065.9 | 1553.1 | 130.8 | 169 | 13200 / 13200 |

All Leafer rows had `leaferPixelNonEmpty=true`.

## Interpretation

The gate fails: **20k Leafer pan p95 is 75.3ms with culling on and 83.4ms with culling off**, both above 33ms.

The final data still has one anomaly: 10k Leafer pan is much worse than 20k Leafer pan even though both prove full paint. This is stable across all three runs, so it is not the old empty-canvas race. The likely cause is workload shape and browser scheduling, not missing paint. Because the 20k measured value is already above the gate, this anomaly does not change the go/no-go decision.

Important constraint: current `--culling` does not cull Leafer paint. It only affects the remaining DOM nodes. Leafer still paints all image/frame nodes, so the culling comparison is not yet a true Leafer virtualization test.

## Visual And Coordinate Checks

`npm run visual:diff -- --candidate=leafer --port=4189`

- Final diff: **0.2897%**, threshold 5%, pass.
- Candidate evidence: `leaferExpectedChildren=3`, `leaferChildren=3`, `leaferPixelNonEmpty=true`.
- Earlier 10.47% diff was a timing artifact: capture happened before Leafer paint settled.

`npm run test:e2e:dev -- --scenario=coordinate-probe --renderer=both`

- Both DOM and Leafer coordinate probes pass.
- Default demo has only the three image nodes, so there are no shared text nodes to compare in that scene.
- The Leafer probe exposes painted-node screen rects; comparing the three demo image rects against DOM gives max delta **0 CSS px** across DPR1 zoom/pan samples.

## Decision

**NO-GO to proceed directly into Phase 2b formalization.**

Proceed first with a small Phase 0c: Leafer-level viewport culling / virtualization for image and frame nodes, using the same viewport rect semantics as DOM culling. Re-run the exact matrix with the same paint evidence gates.

Continue with Leafer only if Phase 0c brings 20k Leafer culling-on pan p95 to <=33ms and does not regress visual/coordinate checks. If Phase 0c still misses the gate, revisit renderer choice or move to a more aggressive WebGL/Pixi-style backend evaluation.

## Validation

- `npm run build` passed.
- `npm run lint` passed.
- `npm run test:unit` passed: 48 files, 554 passed, 12 skipped.
- `npm run verify:logging` passed.
- `node scripts/ci/structure-guard.mjs` passed: 0 FAIL, 1 existing warning.
- `npm run visual:diff -- --candidate=leafer --port=4189` passed.
- `npm run test:e2e:dev -- --scenario=coordinate-probe --renderer=both` passed.
