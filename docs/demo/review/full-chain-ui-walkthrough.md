GD_REVIEW_DECISION: APPROVED

# MivoCanvas Demo Full Chain + UI Walkthrough

Date: 2026-07-02  
Branch / HEAD: `demo/canvas-ai` / `b97249b`  
Dev server: `http://127.0.0.1:5176` with `MIVO_ASSET_DIR=_tmp/debug/mivocanvas-full-walkthrough/local-assets`  
Evidence bundle: `_tmp/debug/mivocanvas-full-walkthrough/full-walkthrough-results.json`  
Screenshots: 22 current evidence screenshots referenced by the JSON under `_tmp/debug/mivocanvas-full-walkthrough/` (the directory also contains two older scratch screenshots from an aborted script run).

Scope note: this walkthrough used real browser interaction. M1/M2 image API responses were controlled at the browser route layer for deterministic UI and node/edge verification, so this report does not claim a fresh paid/live `gpt-image-2` upstream call. Eagle was verified against the real local Eagle API.

## Commands

| Check | Result | Evidence |
|---|---:|---|
| `npm run build` | PASS | `tsc -b && vite build`; Vite `8.0.16`; `2069 modules transformed`; only chunk-size warning for `index-MnkG_uCE.js` 814.65 kB. |
| Browser walkthrough script | PASS | `_tmp/debug/mivocanvas-full-walkthrough/full-walkthrough.mjs`; all recorded module sections PASS. |
| `npm run test:e2e` | PASS | Output: `E2E smoke test passed`. |
| Console / network | PASS | Unexpected `console.error`: 0. One browser resource error came from intentional `/api/mivo/generate` 500 used to capture error state. `badResponses`: 0. |

## Four-Dimension Verdict

| Dimension | Verdict | Evidence |
|---|---:|---|
| Full function chain | PASS | M1/M2/M4/M5/M6 matrix below; generated/edited results created new image nodes and edges. |
| UI state clarity | PASS | Empty, loading, disabled, selected, error, retry, drawer loading/ready, lightbox, mask selected states all visible in screenshots. |
| Overlap / obstruction | PASS | Bottom action bar did not overlap zoom controls or AI panel; mask toolbar/prompt did not overlap in vertical or horizontal image cases; Eagle drawer drag was not intercepted by backdrop. |
| Style consistency | PASS | Screenshots keep the original Mivo left sidebar, canvas grid, neutral panel surfaces, compact typography, and drawer/panel visual language. New demo surfaces do not visually replace the source product frame. |

## Module Matrix

| Module | Verdict | Evidence |
|---|---:|---|
| M1 text-to-image | PASS | Empty state `_tmp/debug/mivocanvas-full-walkthrough/01b-m1-empty-canvas.png`; loading `_tmp/debug/mivocanvas-full-walkthrough/02-m1-loading-state.png`; result `_tmp/debug/mivocanvas-full-walkthrough/03-m1-text-result-edge.png`; result delta `images +1`, `edges +1`. |
| M1 error/retry | PASS | Error `_tmp/debug/mivocanvas-full-walkthrough/04-m1-error-state.png`; retry result `_tmp/debug/mivocanvas-full-walkthrough/05-m1-retry-result.png`; retry delta `images +1`, `edges +1`. |
| M1 image-to-image | PASS | Reference chip `_tmp/debug/mivocanvas-full-walkthrough/06-m1-reference-chip.png`; result `_tmp/debug/mivocanvas-full-walkthrough/07-m1-image-to-image-result-edge.png`; edit request fields `image:1`, `reference[]:1`; result delta `images +1`, `edges +1`. |
| M2 mask edit | PASS | Vertical and horizontal sources each passed point / box / brush: every run `regionCount=1`, `/api/mivo/edit` 200, request fields `image:1`, `mask:1`, source retained, `images +1`, `edges +1`. Screenshots: `_tmp/debug/mivocanvas-full-walkthrough/08-m2-vertical-overlay-point.png`, `_tmp/debug/mivocanvas-full-walkthrough/08-m2-horizontal-overlay-point.png`, `_tmp/debug/mivocanvas-full-walkthrough/10-m2-final-derived-edges.png`. |
| M4 local assets / clipboard | PASS | Local drawer `_tmp/debug/mivocanvas-full-walkthrough/11-m4-local-assets-drawer.png`; detail `_tmp/debug/mivocanvas-full-walkthrough/12-m4-local-detail.png`; add-to-canvas `_tmp/debug/mivocanvas-full-walkthrough/13-m4-local-add-to-canvas.png`; clipboard paste `_tmp/debug/mivocanvas-full-walkthrough/14-m4-clipboard-paste.png`. |
| M4 real Eagle | PASS | Eagle connected: version `4.0.0`, `folderCount=3`; all assets `112`, tags `26`, tag `UI Design` yielded `75`; lightbox, right-click copy paste `+1`, multi-copy paste `+2`, drawer drag `+1`; thumbnail 404 count `0`. Screenshots `15` through `20` in the evidence dir. |
| M5 node/edge binding | PASS | M1 and M2 paths both produced non-destructive new image nodes and new derivation edges; M2 explicitly retained source image for all 6 mask runs. |
| M6 bottom action bar | PASS | `_tmp/debug/mivocanvas-full-walkthrough/21-m6-toolbar-controls.png`; no selection disables local repaint, selected image enables it, `生成` opens AI panel, `局部重绘` opens mask overlay, `选择/移动` cancels overlay. |

M3 is intentionally absent from this demo plan per `master-plan.md` non-goal.

## Known P2 Rechecks

| Known issue | Verdict | Evidence |
|---|---:|---|
| Horizontal image overlay control obstruction | PASS | Horizontal point/box/brush all had `toolbarPromptOverlap=false`, `regionCount=1`, edit 200, new node + edge. Key screenshot: `_tmp/debug/mivocanvas-full-walkthrough/08-m2-horizontal-overlay-point.png`. |
| Eagle drawer drag blocked by backdrop | PASS | Dragging first Eagle card to `.asset-library-drawer-backdrop` produced `drawerDragImageDelta=1`; screenshot `_tmp/debug/mivocanvas-full-walkthrough/20-m4-eagle-drawer-drag-to-canvas.png`. |

## Findings

No P1/P2/P3 product findings in this walkthrough.

Residual note: live llm-proxy/gpt-image latency, quota, and image semantics were not re-measured in this UI walkthrough because the browser route returned deterministic image payloads. The user-facing frontend chain, UI states, non-destructive node/edge binding, and real Eagle integration all passed.
