# Pixi 0d In-App Spike - final go/no-go

> Date: 2026-07-05
> Branch: `feat/pixi-0d-in-app-spike`
> Baseline: `origin/main @ 3592f4f`
> Gate: 20k Pixi in-app pan p95 <= 33ms, with duration / Long Task totals not anomalous
> Verdict: **NO-GO**

## Scope

Phase 0d integrated the smallest app-level Pixi renderer after Leafer 0c failed the pan-cache gate.

The spike is flag-gated behind `?renderer=pixi`:

- `pixi.js@8.19.0` is a main dependency, but renderer code uses dynamic `import('pixi.js')`.
- Default `dom` mode is unchanged; invalid renderer values still fall back to `dom`.
- Pixi paints `image`, `frame`, `markup rect`, and `text`.
- Text uses Pixi `BitmapText` with an installed tintable bitmap font atlas. It does not use per-node `Pixi.Text`.
- Pixi children use `eventMode='none'`; app interaction remains on the existing React shell.
- Camera sync is one-way: React viewport -> Pixi stage position/scale.
- Pixi CullerPlugin is not enabled. The final matrix keeps the app's existing DOM culling mode on, so leftover DOM connectors are culled by the existing app path while Pixi draws all Pixi children.

`src/canvas/MivoCanvas.tsx` remains at the red line: `origin/main` 848 lines -> final 848 lines.

## Measurement Evidence

Phase 0d extends the 0b/0c evidence gates:

- `pixiExpectedChildren`
- `pixiChildren`
- `pixiPixelNonEmpty`
- `pixiSyncVersion`
- `pixiTextStrategy=bitmap`
- `pixiTexturePoolSize`

Bench rejects Pixi rows unless expected children are non-zero, children match expected, pixel sampling proves a non-empty WebGL canvas, and the text strategy is `bitmap`.

All final rows below passed those gates.

## Final Matrix

Runs: 3 each. Browser: Playwright Chromium. Viewport: 1920x1080. DPR: 1. Seed: 20260704. Renderer: Pixi. App culling: on. Pixi CullerPlugin: off. Drag segment skipped so pan/zoom stay isolated from node-move writes.

| nodes | pan p50 ms | pan p95 ms | pan duration ms | pan long tasks | pan long task total ms | zoom p95 ms | heap delta MB | Pixi children | DOM rendered | evidence |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 5000 | 58.4 | 108.4 | 16888.8 | 229 | 14754 | 166.2 | 77.1 | 4400 / 4400 | 600 | bitmap, pixel non-empty |
| 10000 | 125.0 | 249.9 | 33883.4 | 236 | 30708 | 225.1 | 155.3 | 8800 / 8800 | 1165 | bitmap, pixel non-empty |
| 20000 | 183.3 | 341.5 | 51313.3 | 301 | 50845 | 300.0 | 275.3 | 17600 / 17600 | 1743 | bitmap, pixel non-empty |

## Four-Way 20k Comparison

| Source | Renderer / config | Text path | Image texture path | pan p95 ms | pan duration ms | pan long task total ms | Render evidence |
|---|---|---|---|---:|---:|---:|---|
| 0b app | DOM culling on | DOM | DOM images | 100.1 | 228704.7 | 227291 | 14462 DOM nodes |
| 0b app | Leafer culling on | DOM text | Leafer image/frame/rect | 75.3 | 95805.0 | 90291 | 13200 / 13200 Leafer |
| 0c app | Leafer pan-cache on | DOM text | frozen Leafer canvas during pan | 241.6 | 17038.2 | 16412 | 13200 / 13200 Leafer, capture=1 |
| #91 bare probe | Pixi text skip | skipped | 8 shared 256px generated textures | 26.1 | not comparable | not comparable | bare engine ceiling |
| #91 bare probe | Pixi per-node text | Pixi.Text per node | 8 shared 256px generated textures | 50.1 | not comparable | not comparable | bare engine, text bottleneck |
| 0d app | Pixi in-app | BitmapText atlas | 3 shared real demo JPG textures | 341.5 | 51313.3 | 50845 | 17600 / 17600 Pixi |

## Interpretation

The in-app Pixi spike fails the gate by a wide margin:

- 20k pan p95 is **341.5ms**, above both the 33ms GO line and the 50ms gray-zone line.
- Duration and Long Task totals are also large: 51.3s pan duration and 50.8s long-task total.
- The data is monotonic across 5k -> 10k -> 20k, so this is not the 0b rAF sampling inversion.

The result is much worse than the #91 bare Pixi probe. The likely causes are cumulative rather than a single bug:

- #91 was an engine-ceiling page with no React, no zustand store writes, no app shell, and no leftover DOM layer. 0d runs inside MivoCanvas and still has DOM connectors / overlays.
- #91 used generated 256px placeholder image textures. 0d uses the real `/demo-assets/courage-*.jpg` textures shared across image sprites. This is more honest for app integration, but not the same texture workload.
- 0d proves BitmapText is wired, but the app-level Pixi stage still contains 17,600 Pixi children at 20k. Transforming the stage through the existing React viewport loop does not approach the bare-render ceiling.
- App DOM culling reduces leftover DOM nodes to 1,743 at 20k, but it does not cull the Pixi stage itself. Pixi still draws every Pixi child each frame, by design for this spike.

The important negative signal is that even after applying the one required text optimization, app integration cost and real texture/stage shape erase the bare-probe headroom.

## Decision

**NO-GO for rewriting Phase 2-4 around Pixi based on this spike.**

Do not proceed with a Pixi migration on the assumption that the engine swap alone clears the 20k pan bar.

If Pixi remains a candidate, the next experiment would need to be a different architecture, not this minimal renderer:

- Pixi-side viewport/tile virtualization instead of drawing all Pixi children.
- A realistic image texture strategy: atlas / mipmap / downsample policy for many unique artwork textures.
- A camera path that avoids React pointermove commits, measured separately from user-facing DOM overlays.

Those are substantial renderer-architecture tasks, so they should be compared against alternative engines / canvas cache designs before changing the roadmap.

## Validation

- `npm run build` passed.
- `npm run lint` passed.
- `npx npm@11.16.0 ci` passed.
- `npm run test:unit` passed: 54 files, 658 passed, 12 skipped.
- `npm run verify:logging` passed.
- `node scripts/ci/structure-guard.mjs` passed: 0 FAIL, 1 existing warning.
- `npm run visual:diff -- --candidate=dom --port=4199` passed: DOM-vs-DOM diff 0%.
