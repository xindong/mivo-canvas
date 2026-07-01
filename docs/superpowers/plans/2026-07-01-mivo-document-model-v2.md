# Mivo Document Model v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compatible semantic Document Model v2 layer for MivoCanvas nodes.

**Architecture:** Keep the current `MivoCanvasNode` runtime object and add optional v2 semantic fields plus pure normalization and command helpers. Wire only low-risk store paths to the new helpers in this phase.

**Tech Stack:** TypeScript, React, Zustand, Vite, Vitest.

---

### Task 1: Unit Test Harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Add Vitest as a dev dependency.
- [ ] Add `test:unit` script using `vitest run`.
- [ ] Run `npm install` to update the lockfile.
- [ ] Run `npm run test:unit` and expect no tests found before adding tests.

### Task 2: v2 Types And Normalization Tests

**Files:**
- Modify: `src/types/mivoCanvas.ts`
- Create: `src/model/documentModelV2.ts`
- Create: `src/model/documentModelV2.test.ts`

- [ ] Write failing tests for deriving transform, fills, strokes, asset, and relations from legacy nodes.
- [ ] Add v2 type definitions to `src/types/mivoCanvas.ts`.
- [ ] Implement `normalizeCanvasNodeV2` and `normalizeCanvasNodesV2`.
- [ ] Run `npm run test:unit -- src/model/documentModelV2.test.ts` and expect pass.

### Task 3: Command Helpers

**Files:**
- Modify: `src/model/documentModelV2.ts`
- Modify: `src/model/documentModelV2.test.ts`

- [ ] Write failing tests for `setNodeTransform`, `setNodeFills`, `setNodeStrokes`, `setNodeAsset`, and `setNodeRelations`.
- [ ] Implement immutable command helpers.
- [ ] Run targeted unit tests and expect pass.

### Task 4: Store Bridge

**Files:**
- Modify: `src/store/canvasStore.ts`

- [ ] Normalize cloned nodes through v2 helpers.
- [ ] Use `setNodeTransform` in geometry update paths.
- [ ] Use style commands in markup, section, text, and asset update paths where direct mapping is obvious.
- [ ] Keep legacy fields intact for current UI.

### Task 5: Verification

**Files:**
- No new files.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run build`.
- [ ] Run `npm run lint`.
- [ ] Summarize any remaining gaps before continuing to renderer adapter work.
