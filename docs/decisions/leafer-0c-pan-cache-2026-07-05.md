# Leafer 0c Pan-Cache Spike - final go/no-go

> Date: 2026-07-05
> Branch: `feat/leafer-0c-pan-cache`
> Baseline: `origin/main @ 5d8fbb7`
> Gate: 20k Leafer pan-cache pan p95 <= 33ms
> Verdict: **NO-GO for the committed pan-cache spike**

## Scope

Phase 0c tested whether the pan path can avoid redrawing Leafer primitives while the viewport is moving.

The committed spike is flag-gated behind `?panCache=on` and keeps default DOM / Leafer behavior unchanged:

- Pan start freezes the current Leafer canvas in place and records pan-cache evidence counters.
- During pan, React viewport state is not updated per pointermove. The shell, DOM overlay, and frozen Leafer canvas are moved imperatively.
- The normal Leafer camera sync skips `zoomLayer.set` while the canvas is frozen.
- Pan end commits the final viewport once, debounces 150ms, clears the canvas transform, and applies one final `zoomLayer.set`.
- Bench records `panCacheActual`, `leaferPanCacheCaptures`, and post-pan render state.

LOD was not implemented because the pan-cache result is still far above the gate.

`src/canvas/MivoCanvas.tsx` remains under the red line: `origin/main` 849 lines -> final 848 lines.

## Measurement Evidence

The Phase 0b evidence gates remain mandatory:

- `leaferExpectedChildren`
- `leaferChildren`
- `leaferPixelNonEmpty`
- `leaferSyncVersion`

Phase 0c adds pan-cache-specific evidence:

- Bench URL includes `panCache=on|off`.
- The page exposes `data-leafer-pan-cache-enabled`, `data-leafer-pan-cache-frozen`, `data-leafer-pan-cache-captures`, and last pan delta.
- A pan-cache-on run is rejected unless the shell reports pan-cache enabled and at least one pan-cache capture after the pan action.

All final rows below had `leaferChildren === leaferExpectedChildren` and `leaferPixelNonEmpty=true`.

## Final Matrix

Runs: 3 each. Browser: Playwright Chromium. Viewport: 1920x1080. DPR: 1. Seed: 20260704. Renderer: Leafer. Culling: on. Drag segment skipped so pan/zoom stay isolated from node-move writes.

| nodes | pan-cache | pan p50 ms | pan p95 ms | pan duration ms | pan long tasks | pan long task total ms | zoom p95 ms | Leafer children | captures |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 5000 | off | 16.8 | 133.5 | 10255.9 | 101 | 6868 | 33.2 | 3300 / 3300 | 0 |
| 5000 | on | 8.4 | 75.0 | 6156.8 | 77 | 5546 | 66.1 | 3300 / 3300 | 1 |
| 10000 | off | 33.3 | 301.6 | 22500.7 | 111 | 18017 | 41.6 | 6600 / 6600 | 0 |
| 10000 | on | 8.7 | 183.3 | 13183.1 | 76 | 12628 | 41.0 | 6600 / 6600 | 1 |
| 20000 | off | 40.9 | 458.3 | 30381.1 | 101 | 24638 | 34.1 | 13200 / 13200 | 0 |
| 20000 | on | 8.5 | 241.6 | 17038.2 | 75 | 16412 | 91.7 | 13200 / 13200 | 1 |

## Interpretation

The pan-cache direction helps but does not pass the gate:

- 20k pan p95 improves from 458.3ms to 241.6ms.
- 20k pan duration improves from 30381.1ms to 17038.2ms.
- 20k pan long-task total improves from 24638ms to 16412ms.
- The result is still **7.3x above** the 33ms p95 target.

The spike proves that avoiding per-pointermove React state updates and skipping Leafer camera sync during pan reduces work. It also shows that a single transformed canvas is not enough: the browser still spends too much time in the pan action, likely from input dispatch, compositor/raster work around the large Leafer canvas, and the final settle work. A formal tile cache would need to move smaller cached surfaces, not one full-scene canvas.

## 10k Anomaly Follow-Up

The Phase 0b final table had an apparent inversion: 10k Leafer pan p95 was 592.6ms while 20k Leafer pan p95 was 75.3ms.

That inversion was not missing-paint: both rows had full children evidence. The 0b raw runs show the real workload still scaled up at 20k:

| 0b row | pan p95 ms | pan duration ms | long task total ms | frames sampled |
|---|---:|---:|---:|---:|
| 10k Leafer on | 592.6 | 43771.5 | 39425 | 301-302 |
| 20k Leafer on | 75.3 | 95805.0 | 90291 | 183-189 |

The lower 20k p95 was a rAF-sampling artifact under heavier main-thread blocking: fewer animation frames were sampled while total time and long-task time more than doubled. Phase 0c therefore reports p95 together with duration and Long Task totals. In the final 0c matrix, the same fixture sizes are monotonic for p95, duration, children count, and long-task total.

## Decision

**NO-GO for the committed pan-cache spike.**

Do not proceed to formalize this exact "freeze one Leafer canvas and transform it" implementation as Phase 2b. It is useful evidence that pan-time redraw avoidance matters, but it is not close enough to the bar.

Next recommendation:

- Compare against the parallel Pixi / engine probe before investing more Leafer-specific work.
- If Leafer remains under consideration, the next Leafer experiment should be a real tile / viewport cache: fixed-size cached surfaces, dirty-tile invalidation, and small-surface transforms during pan. The current full-canvas transform should be treated as a lower-bound architecture probe, not the production design.
- Keep the 0c evidence gates for any future renderer test: painted children, non-empty pixels, pan-cache capture count, pan p95, duration, and Long Task totals.

## Validation

- `npm run build` passed.
- `npm run lint` passed.
- `npm run test:unit` passed: 54 files, 654 passed, 12 skipped.
- `npm run verify:logging` passed.
- `node scripts/ci/structure-guard.mjs` passed: 0 FAIL, 1 existing warning.
- `npm run visual:diff -- --candidate=leafer --port=4189` passed: diff 0.2897% under the 5% threshold.
- `npm run test:e2e:dev -- --scenario=coordinate-probe --renderer=both` passed.
