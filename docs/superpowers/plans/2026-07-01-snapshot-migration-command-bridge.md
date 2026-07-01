# Snapshot Migration And Command Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize Document Model v2 persistence and route high-value canvas/AI operations through command helpers without adding rotation UI.

**Architecture:** Add pure snapshot normalization utilities for import/export and local persistence. Add a small AI canvas command helper for generated result nodes, then use it in mock AI generation paths while keeping current UI behavior.

**Tech Stack:** TypeScript, Zustand, Vitest.

---

### Task 1: Snapshot Normalization

**Files:**
- Create: `src/model/canvasSnapshotModel.ts`
- Create: `src/model/canvasSnapshotModel.test.ts`
- Modify: `src/lib/canvasArchive.ts`
- Modify: `src/lib/snapshotValidation.ts`
- Modify: `src/store/canvasStore.ts`

- [ ] Write failing tests that legacy snapshots are normalized with v2 node fields.
- [ ] Write failing tests that inconsistent v2 nodes are repaired from legacy geometry/asset/relation fields.
- [ ] Implement `normalizeCanvasSnapshotV2`.
- [ ] Use it on archive export, archive import, store snapshots, and snapshot replacement.

### Task 2: AI Command Bridge

**Files:**
- Create: `src/model/aiCanvasCommands.ts`
- Create: `src/model/aiCanvasCommands.test.ts`
- Modify: `src/store/mockGeneration.ts`
- Modify: `src/store/canvasStore.ts`

- [ ] Write failing tests for creating beside, slot, annotation, image-edit, and variation result nodes.
- [ ] Implement immutable command helpers that use v2 node normalization and relation commands.
- [ ] Replace duplicated AI result node construction in store/mock adapter with the command helper.

### Task 3: Verification

**Files:**
- No new files.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run build`.
- [ ] Run `npm run lint`.
