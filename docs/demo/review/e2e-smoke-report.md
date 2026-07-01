GD_REVIEW_DECISION: APPROVED

# P5.5 E2E Smoke Report

Scope: branch `demo/canvas-ai`, base HEAD `6160c38`. Fix round changed only `src/canvas/ImageMaskEditOverlay.tsx`, `vite.config.ts`, `scripts/e2e-*.mjs`, and this report.

## Commands

| Command | Result | Evidence |
|---|---:|---|
| `npm run build` | PASS | `tsc -b && vite build`; Vite `8.0.16`; `2069 modules transformed`; only chunk-size warning. |
| `npm run test:e2e` | PASS | `E2E smoke test passed`. Script now asserts M4 masonry/lightbox selectors and M2 vertical+horizontal mask tools. |

## Fixed Findings

| Finding | Result | Evidence |
|---|---:|---|
| P1 M2 floating toolbar/prompt overlap | PASS | Floating controls are stacked as one clamped block. Targeted run showed `controlGap=10` for all vertical/horizontal point/box/brush flows. |
| P2 Eagle thumbnail 404 console errors | PASS | Real Eagle `127.0.0.1:41595` run: `thumbnail404s=0`, `consoleErrors=0`, `badResponses=0`. |

## M2 True Mouse Recheck

Each row used real mouse interaction, produced `regionCount=1`, got `/api/mivo/edit` 200, sent `image:1 + mask:1`, created `+1` image node, created/advanced an edit edge from the original source, and kept the original source image.

| Source | Tool | Mask size | Transparent pixels | New image | Edge | Control gap |
|---|---|---:|---:|---:|---:|---:|
| vertical `ref-hero` | point | `1080x1920` | `7038` | `+1` | `1` | `10px` |
| vertical `ref-hero` | box | `1080x1920` | `101032` | `+1` | `2` | `10px` |
| vertical `ref-hero` | brush | `1080x1920` | `54268` | `+1` | `3` | `10px` |
| horizontal source | point | `1600x900` | `7038` | `+1` | `1` | `10px` |
| horizontal source | box | `1600x900` | `69984` | `+1` | `2` | `10px` |
| horizontal source | brush | `1600x900` | `63441` | `+1` | `3` | `10px` |

## Eagle Real Connector Recheck

| Flow | Result | Evidence |
|---|---:|---|
| Eagle status | PASS | connected `true`, Eagle `4.0.0`, `folderCount=3`. |
| Tags + masonry | PASS | `26` tags; selected `UI Design`; tag count `75`, All count `112`. |
| Lightbox | PASS | Opened first card; `.asset-lightbox-image ready`. |
| Right-click copy/paste | PASS | Internal paste added `+1` image node. |
| Multi-select copy/paste | PASS | Two selected cards pasted `+2` image nodes. |
| Drawer-open drag into canvas | PASS | Dragged Eagle card onto backdrop outside drawer; canvas gained `+1` image node. |
| Console/network | PASS | `thumbnail404s=0`, `consoleErrors=0`, `badResponses=0`. |

## Function Matrix

| Area | Result | Evidence |
|---|---:|---|
| M1 text-to-image / image-to-image | PASS | `npm run test:e2e` covers generation stubs; previous targeted pass retained. |
| M1 cancel/retry/error/empty-b64 | PASS | Previous targeted pass retained; empty b64 still guarded by client validation. |
| M2 local repaint | PASS | Vertical + horizontal point/box/brush rechecked above. |
| M4 Eagle | PASS | Real Eagle rechecked above with 0 thumbnail 404 and 0 console errors. |
| M6 bottom toolbar | PASS | `生成` opens M1 panel; `局部重绘` opens M2; `选择/移动` closes overlay; no sidebar/zoom overlap in smoke coverage. |
| Existing canvas interactions | PASS | `npm run test:e2e` covers pan/zoom, box select, multi-select, move, resize, align, undo/redo, import/export, paste/import flows. |

## Net

GO. The two prior FAIL gates are fixed and rechecked: M2 vertical/horizontal three-tool repaint works, and real Eagle browsing no longer emits thumbnail 404 console errors.
