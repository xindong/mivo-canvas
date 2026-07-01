# Render Adapter Rotation Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route canvas node rendering through a small v2 render adapter and make `transform.rotation` visible in the DOM/SVG canvas.

**Architecture:** Add a pure `canvasRenderAdapter` module that normalizes `MivoCanvasNode` into CSS-ready render data. `CanvasNodeView` consumes that adapter for outer geometry and first-pass paint styles while legacy fields remain available.

**Tech Stack:** TypeScript, React, CSS, Vitest.

---

### Task 1: Adapter Tests

**Files:**
- Create: `src/canvas/canvasRenderAdapter.ts`
- Create: `src/canvas/canvasRenderAdapter.test.ts`

- [ ] Write a failing test that maps v2 transform to `translate(...) rotate(...)`.
- [ ] Write a failing test that omits `rotate(...)` when rotation is zero.
- [ ] Write failing tests that extract frame, markup, and text paint tokens from v2 semantic fields with legacy fallback.

### Task 2: Adapter Implementation

**Files:**
- Create: `src/canvas/canvasRenderAdapter.ts`

- [ ] Implement `nodeRenderBoxFor(node)`.
- [ ] Implement `frameRenderStyleFor(node)`.
- [ ] Implement `markupRenderStyleFor(node)`.
- [ ] Implement `textRenderStyleFor(node)`.
- [ ] Run `npm run test:unit -- src/canvas/canvasRenderAdapter.test.ts`.

### Task 3: CanvasNodeView Bridge

**Files:**
- Modify: `src/canvas/CanvasNodeView.tsx`

- [ ] Replace direct outer `width`, `height`, and `transform` construction with `nodeRenderBoxFor`.
- [ ] Replace frame CSS variables with `frameRenderStyleFor`.
- [ ] Replace markup fill/stroke reads with `markupRenderStyleFor`.
- [ ] Replace text color reads with `textRenderStyleFor`.

### Task 4: Verification

**Files:**
- No new files.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run build`.
- [ ] Run `npm run lint`.
- [ ] Start `npm run dev -- --host 127.0.0.1`.
