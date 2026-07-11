// src/canvas/actions/canvasCommandExecutorTestFactories.ts
// Shared test factory for the canvasCommandExecutor test suite. Extracted so both
// the PR1 sync-dispatch tests (canvasCommandExecutor.test.ts) and the PR2
// two-stage-asset apply tests (canvasCommandExecutor.deferred.test.ts) can build
// a fully-mocked CanvasActionRuntime without duplicating the ~30-method spy block
// (structure-guard caps non-allowlist files at 900 lines).
// Not a test file (no describe/it) — a pure factory module imported by both suites.

import { vi } from 'vitest'
import type { CanvasActionRuntime } from './canvasActionTypes'

/**
 * Build a fully-mocked CanvasActionRuntime. Only the method spies are exercised
 * by applyCanvasCommand; the data fields (context / counts) are filler so the
 * type is satisfied. Returns the runtime typed as CanvasActionRuntime with each
 * method a vi.fn so tests can assert dispatch intent + args.
 */
export const createMockRuntime = (): CanvasActionRuntime => {
  const methods = {
    setActiveTool: vi.fn(),
    addTextNode: vi.fn(() => 'text-id'),
    addFrameNode: vi.fn(() => 'frame-id'),
    addAiSlotNode: vi.fn(() => 'slot-id'),
    addAnnotationNode: vi.fn(() => 'note-id'),
    addMarkupNode: vi.fn(() => 'markup-id'),
    updateMarkupStyle: vi.fn(),
    updateSectionStyle: vi.fn(),
    setSectionLockMode: vi.fn(),
    removeSectionOnly: vi.fn(),
    selectNodes: vi.fn(),
    generateVariations: vi.fn(async () => []),
    generateImageEdit: vi.fn(async () => []),
    generateBesideNode: vi.fn(async () => []),
    generateIntoAiSlot: vi.fn(async () => []),
    generateFromAnnotation: vi.fn(async () => []),
    duplicateNode: vi.fn(),
    duplicateSelectedNodes: vi.fn(),
    groupSelectedNodes: vi.fn(),
    ungroupSelectedNodes: vi.fn(),
    copySelectedNodes: vi.fn(),
    pasteClipboardNodes: vi.fn(),
    moveNodeLayer: vi.fn(),
    moveSelectedLayer: vi.fn(),
    alignSelectedNodes: vi.fn(),
    distributeSelectedNodes: vi.fn(),
    arrangeSelectedNodes: vi.fn(),
    toggleSelectedNodesLocked: vi.fn(),
    hideSelectedNodes: vi.fn(),
    showAllHiddenNodes: vi.fn(),
    deleteNode: vi.fn(),
    deleteSelectedNodes: vi.fn(),
  }
  return {
    context: {} as CanvasActionRuntime['context'],
    clipboardCount: 0,
    hiddenCount: 0,
    allNodeIds: [],
    canvasPosition: undefined,
    onOpenDetails: undefined,
    onFitAll: undefined,
    onFitSelection: undefined,
    onCreateTextAt: undefined,
    onCreateFrameAt: undefined,
    onEditText: undefined,
    onRenameNode: undefined,
    onImportAssetAt: undefined,
    onCropNode: undefined,
    onStartImageMaskEdit: undefined,
    onDownloadOriginal: undefined,
    ...methods,
  } as unknown as CanvasActionRuntime & typeof methods
}
