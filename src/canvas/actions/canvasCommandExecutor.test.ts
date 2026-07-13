// src/canvas/actions/canvasCommandExecutor.test.ts
// T2.3 — applyCanvasCommand dispatch tests (effect-layer seam).
//
// WHAT THIS PROVES
// For every sync document-mutation command, applyCanvasCommand dispatches to the
// correct CanvasActionRuntime method with the correct arguments — a 1:1 mapping
// that is the inverse of what T2.2 will wire (onClick → emit command). The
// dispatch assertions mirror the style of canvasActionModel.characterization.test.ts
// (mock runtime + vi.fn spy + toHaveBeenCalledWith), but live entirely in the
// effect layer — they do not import or touch canvasActionModel.ts.
//
// Deferred commands (import-asset, generation) assert they throw
// CanvasCommandDeferredError so the PR1/PR2 boundary is visible in test output.

import { describe, expect, it, vi } from 'vitest'
import {
  applyCanvasCommand,
  CanvasCommandDeferredError,
  CanvasCommandInvalidPayloadError,
} from './canvasCommandExecutor'
import { createMockRuntime } from './canvasCommandExecutorTestFactories'
import {
  CANVAS_COMMAND_DEFERRED_KINDS,
  deserializeCanvasCommand,
  serializeCanvasCommand,
} from './canvasCommand'

describe('applyCanvasCommand — node creation dispatch', () => {
  it('add-text-node → addTextNode(position, text); returns new id', () => {
    const rt = createMockRuntime()
    const id = applyCanvasCommand(
      { kind: 'add-text-node', position: { x: 1, y: 2 }, text: 'hi' },
      rt,
    )
    expect(vi.mocked(rt.addTextNode)).toHaveBeenCalledWith({ x: 1, y: 2 }, 'hi')
    expect(id).toBe('text-id')
  })
  it('add-text-node (no text) → addTextNode(position)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'add-text-node', position: { x: 0, y: 0 } }, rt)
    expect(vi.mocked(rt.addTextNode).mock.calls[0]).toEqual([{ x: 0, y: 0 }])
  })
  it('add-frame-node → addFrameNode(position, size, title); returns new id', () => {
    const rt = createMockRuntime()
    const id = applyCanvasCommand(
      {
        kind: 'add-frame-node',
        position: { x: 5, y: 5 },
        size: { width: 300, height: 200 },
        title: 'S',
      },
      rt,
    )
    expect(vi.mocked(rt.addFrameNode)).toHaveBeenCalledWith(
      { x: 5, y: 5 },
      { width: 300, height: 200 },
      'S',
    )
    expect(id).toBe('frame-id')
  })
  it('add-ai-slot-node → addAiSlotNode(position, size, prompt)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand(
      {
        kind: 'add-ai-slot-node',
        position: { x: 1, y: 1 },
        size: { width: 320, height: 320 },
        prompt: 'cat',
      },
      rt,
    )
    expect(vi.mocked(rt.addAiSlotNode)).toHaveBeenCalledWith(
      { x: 1, y: 1 },
      { width: 320, height: 320 },
      'cat',
    )
  })
  it('add-frame-node (position only) → addFrameNode(position)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'add-frame-node', position: { x: 9, y: 9 } }, rt)
    expect(vi.mocked(rt.addFrameNode).mock.calls[0]).toEqual([{ x: 9, y: 9 }])
  })
  it('add-ai-slot-node (position only) → addAiSlotNode(position)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'add-ai-slot-node', position: { x: 3, y: 4 } }, rt)
    expect(vi.mocked(rt.addAiSlotNode).mock.calls[0]).toEqual([{ x: 3, y: 4 }])
  })
  it('add-annotation-node → addAnnotationNode(sourceNodeId, position, instruction, options)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand(
      {
        kind: 'add-annotation-node',
        sourceNodeId: 'img-1',
        position: { x: 50, y: 50 },
        instruction: 'rm bg',
        options: { operation: 'remove-background', title: 'Edit for image' },
      },
      rt,
    )
    expect(vi.mocked(rt.addAnnotationNode)).toHaveBeenCalledWith(
      'img-1',
      { x: 50, y: 50 },
      'rm bg',
      { operation: 'remove-background', title: 'Edit for image' },
    )
  })
  it('add-annotation-node (source only) → addAnnotationNode(sourceNodeId)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'add-annotation-node', sourceNodeId: 'img-1' }, rt)
    expect(vi.mocked(rt.addAnnotationNode).mock.calls[0]).toEqual(['img-1'])
  })
  it('add-markup-node → addMarkupNode(kind, position, geometry, options)', () => {
    const rt = createMockRuntime()
    const options = {
      points: [{ x: 8, y: 88 }],
      strokeColor: '#6957e8',
      endArrow: true,
    }
    applyCanvasCommand(
      {
        kind: 'add-markup-node',
        markupKind: 'arrow',
        position: { x: 0, y: 0 },
        geometry: { width: 160, height: 96 },
        options,
      },
      rt,
    )
    expect(vi.mocked(rt.addMarkupNode)).toHaveBeenCalledWith(
      'arrow',
      { x: 0, y: 0 },
      { width: 160, height: 96 },
      options,
    )
  })
})

describe('applyCanvasCommand — style / section dispatch', () => {
  it('update-markup-style → updateMarkupStyle(nodeId, style)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand(
      { kind: 'update-markup-style', nodeId: 'm1', style: { markupStrokeWidth: 2 } },
      rt,
    )
    expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStrokeWidth: 2 })
  })
  it('update-section-style → updateSectionStyle(nodeId, style)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand(
      { kind: 'update-section-style', nodeId: 'f1', style: { sectionTitleVisible: false } },
      rt,
    )
    expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionTitleVisible: false })
  })
  it('set-section-lock-mode (with mode) → setSectionLockMode(nodeId, mode)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'set-section-lock-mode', nodeId: 'f1', mode: 'all' }, rt)
    expect(vi.mocked(rt.setSectionLockMode)).toHaveBeenCalledWith('f1', 'all')
  })
  it('set-section-lock-mode (unlock) → setSectionLockMode(nodeId, undefined)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'set-section-lock-mode', nodeId: 'f1' }, rt)
    expect(vi.mocked(rt.setSectionLockMode)).toHaveBeenCalledWith('f1', undefined)
  })
  it('remove-section-only → removeSectionOnly(nodeId)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'remove-section-only', nodeId: 'f1' }, rt)
    expect(vi.mocked(rt.removeSectionOnly)).toHaveBeenCalledWith('f1')
  })
})

describe('applyCanvasCommand — selection / tool dispatch', () => {
  it('select-nodes → selectNodes(nodeIds, primaryNodeId)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand(
      { kind: 'select-nodes', nodeIds: ['a', 'b'], primaryNodeId: 'a' },
      rt,
    )
    expect(vi.mocked(rt.selectNodes)).toHaveBeenCalledWith(['a', 'b'], 'a')
  })
  it('select-nodes (no primary) → selectNodes(nodeIds)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'select-nodes', nodeIds: ['a'] }, rt)
    expect(vi.mocked(rt.selectNodes).mock.calls[0]).toEqual([['a']])
  })
  it('set-active-tool → setActiveTool(toolId)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'set-active-tool', toolId: 'text' }, rt)
    expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('text')
  })
})

describe('applyCanvasCommand — organization dispatch', () => {
  it('duplicate-node → duplicateNode(nodeId)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'duplicate-node', nodeId: 'a' }, rt)
    expect(vi.mocked(rt.duplicateNode)).toHaveBeenCalledWith('a')
  })
  it('duplicate-selected-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'duplicate-selected-nodes' }, rt)
    expect(vi.mocked(rt.duplicateSelectedNodes)).toHaveBeenCalledTimes(1)
  })
  it('group-selected-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'group-selected-nodes' }, rt)
    expect(vi.mocked(rt.groupSelectedNodes)).toHaveBeenCalledTimes(1)
  })
  it('ungroup-selected-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'ungroup-selected-nodes' }, rt)
    expect(vi.mocked(rt.ungroupSelectedNodes)).toHaveBeenCalledTimes(1)
  })
  it('copy-selected-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'copy-selected-nodes' }, rt)
    expect(vi.mocked(rt.copySelectedNodes)).toHaveBeenCalledTimes(1)
  })
  it('paste-clipboard-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'paste-clipboard-nodes' }, rt)
    expect(vi.mocked(rt.pasteClipboardNodes)).toHaveBeenCalledTimes(1)
  })
})

describe('applyCanvasCommand — layer dispatch', () => {
  it('move-node-layer → moveNodeLayer(nodeId, move)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'move-node-layer', nodeId: 'a', move: 'front' }, rt)
    expect(vi.mocked(rt.moveNodeLayer)).toHaveBeenCalledWith('a', 'front')
  })
  it('move-selected-layer → moveSelectedLayer(move)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'move-selected-layer', move: 'back' }, rt)
    expect(vi.mocked(rt.moveSelectedLayer)).toHaveBeenCalledWith('back')
  })
})

describe('applyCanvasCommand — arrange dispatch', () => {
  it('align-selected-nodes → alignSelectedNodes(alignment)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'align-selected-nodes', alignment: 'center' }, rt)
    expect(vi.mocked(rt.alignSelectedNodes)).toHaveBeenCalledWith('center')
  })
  it('distribute-selected-nodes → distributeSelectedNodes(axis)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'distribute-selected-nodes', axis: 'vertical' }, rt)
    expect(vi.mocked(rt.distributeSelectedNodes)).toHaveBeenCalledWith('vertical')
  })
  it('arrange-selected-nodes → arrangeSelectedNodes(mode)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'arrange-selected-nodes', mode: 'grid' }, rt)
    expect(vi.mocked(rt.arrangeSelectedNodes)).toHaveBeenCalledWith('grid')
  })
})

describe('applyCanvasCommand — visibility / lock dispatch', () => {
  it('toggle-selected-nodes-locked → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'toggle-selected-nodes-locked' }, rt)
    expect(vi.mocked(rt.toggleSelectedNodesLocked)).toHaveBeenCalledTimes(1)
  })
  it('hide-selected-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'hide-selected-nodes' }, rt)
    expect(vi.mocked(rt.hideSelectedNodes)).toHaveBeenCalledTimes(1)
  })
  it('show-all-hidden-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'show-all-hidden-nodes' }, rt)
    expect(vi.mocked(rt.showAllHiddenNodes)).toHaveBeenCalledTimes(1)
  })
})

describe('applyCanvasCommand — delete dispatch', () => {
  it('delete-node → deleteNode(nodeId)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'delete-node', nodeId: 'a' }, rt)
    expect(vi.mocked(rt.deleteNode)).toHaveBeenCalledWith('a')
  })
  it('delete-selected-nodes → called once', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'delete-selected-nodes' }, rt)
    expect(vi.mocked(rt.deleteSelectedNodes)).toHaveBeenCalledTimes(1)
  })
})

describe('applyCanvasCommand — return value contract', () => {
  it('creation commands return the runtime-returned node id', () => {
    const rt = createMockRuntime()
    vi.mocked(rt.addTextNode).mockReturnValue('custom-id')
    const id = applyCanvasCommand(
      { kind: 'add-text-node', position: { x: 0, y: 0 } },
      rt,
    )
    expect(id).toBe('custom-id')
  })
  it('add-annotation-node returns undefined when runtime returns undefined', () => {
    const rt = createMockRuntime()
    vi.mocked(rt.addAnnotationNode).mockReturnValue(undefined)
    const id = applyCanvasCommand({ kind: 'add-annotation-node' }, rt)
    expect(vi.mocked(rt.addAnnotationNode).mock.calls[0]).toEqual([])
    expect(id).toBeUndefined()
  })
  it('non-creation commands return undefined', () => {
    const rt = createMockRuntime()
    const id = applyCanvasCommand({ kind: 'delete-node', nodeId: 'a' }, rt)
    expect(id).toBeUndefined()
  })
})

describe('applyCanvasCommand — deferred (PR2 boundary)', () => {
  it.each(CANVAS_COMMAND_DEFERRED_KINDS)('%s throws CanvasCommandDeferredError', (kind) => {
    const rt = createMockRuntime()
    // Build a minimal valid command of the given kind. We only need the command
    // to be a well-typed CanvasCommand variant whose apply hits the deferred case.
    const command = buildDeferredCommand(kind)
    expect(() => applyCanvasCommand(command, rt)).toThrow(CanvasCommandDeferredError)
    const thrown = (() => {
      try {
        applyCanvasCommand(command, rt)
      } catch (error) {
        return error as CanvasCommandDeferredError
      }
    })()
    expect(thrown?.commandKind).toBe(kind)
  })

  it('deferred throw message references the two-stage asset / PR2 reason', () => {
    const rt = createMockRuntime()
    try {
      applyCanvasCommand(
        { kind: 'generate-image-edit', operation: 'upscale', prompt: 'p' },
        rt,
      )
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasCommandDeferredError)
      expect((error as CanvasCommandDeferredError).reason).toMatch(/asset|PR2|referenceAssetIds/)
    }
  })

  it('mask-edit deferred throw carries the correct kind + reason (F1 apply seam)', () => {
    const rt = createMockRuntime()
    try {
      applyCanvasCommand(
        {
          kind: 'mask-edit',
          sourceNodeId: 'img',
          prompt: 'p',
          sourceSize: { width: 1, height: 1 },
        },
        rt,
      )
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasCommandDeferredError)
      const deferred = error as CanvasCommandDeferredError
      expect(deferred.commandKind).toBe('mask-edit')
      expect(deferred.reason).toMatch(/asset|PR2|maskAssetId|markedImageAssetId/)
    }
  })
})

describe('applyCanvasCommand — invalid payload gating (F2)', () => {
  // Malformed payloads pass deserializeCanvasCommand (kind-only, by design — deep
  // validation is a T2.2+ collaboration-replay concern) but must NOT reach the
  // runtime as a bare TypeError. validateCanvasCommandPayload runs before the
  // switch and throws a tagged CanvasCommandInvalidPayloadError; the runtime spy
  // must record zero calls. Payloads are constructed via deserialize to mirror the
  // real attack path (untrusted JSON → deserialize → apply).
  it('throws on missing required field (add-text-node missing position)', () => {
    const rt = createMockRuntime()
    const cmd = deserializeCanvasCommand(JSON.stringify({ kind: 'add-text-node' }))
    expect(() => applyCanvasCommand(cmd, rt)).toThrow(CanvasCommandInvalidPayloadError)
    expect(vi.mocked(rt.addTextNode)).not.toHaveBeenCalled()
  })

  it('throws on missing nodeId (delete-node)', () => {
    const rt = createMockRuntime()
    const cmd = deserializeCanvasCommand(JSON.stringify({ kind: 'delete-node' }))
    expect(() => applyCanvasCommand(cmd, rt)).toThrow(CanvasCommandInvalidPayloadError)
    expect(vi.mocked(rt.deleteNode)).not.toHaveBeenCalled()
  })

  it('throws on wrong-type array field (select-nodes nodeIds is a string)', () => {
    const rt = createMockRuntime()
    const cmd = deserializeCanvasCommand(
      JSON.stringify({ kind: 'select-nodes', nodeIds: 'not-an-array' }),
    )
    expect(() => applyCanvasCommand(cmd, rt)).toThrow(CanvasCommandInvalidPayloadError)
    expect(vi.mocked(rt.selectNodes)).not.toHaveBeenCalled()
  })

  it('throws on nested field missing (add-text-node position missing x/y)', () => {
    const rt = createMockRuntime()
    const cmd = deserializeCanvasCommand(JSON.stringify({ kind: 'add-text-node', position: {} }))
    expect(() => applyCanvasCommand(cmd, rt)).toThrow(CanvasCommandInvalidPayloadError)
    expect(vi.mocked(rt.addTextNode)).not.toHaveBeenCalled()
  })

  it('throws on non-finite numeric value after JSON (NaN → null; fail-closed)', () => {
    // 顺带 (F2): JSON.stringify turns NaN / ±Infinity into null. A null where a
    // finite number is required is caught by the minimal shape check — the command
    // does not silently reach the runtime. -0 serializes to 0 (a valid coordinate)
    // and is intentionally allowed.
    const rt = createMockRuntime()
    const json = serializeCanvasCommand({ kind: 'add-text-node', position: { x: NaN, y: 1 } })
    expect(json).toContain('"x":null') // proves NaN serialized to null
    const cmd = deserializeCanvasCommand(json)
    expect(() => applyCanvasCommand(cmd, rt)).toThrow(CanvasCommandInvalidPayloadError)
    expect(vi.mocked(rt.addTextNode)).not.toHaveBeenCalled()
  })

  it('tagged error carries commandKind + field + reason', () => {
    const rt = createMockRuntime()
    const cmd = deserializeCanvasCommand(JSON.stringify({ kind: 'delete-node' }))
    let thrown: CanvasCommandInvalidPayloadError | undefined
    try {
      applyCanvasCommand(cmd, rt)
    } catch (error) {
      thrown = error as CanvasCommandInvalidPayloadError
    }
    expect(thrown).toBeInstanceOf(CanvasCommandInvalidPayloadError)
    expect(thrown?.commandKind).toBe('delete-node')
    expect(thrown?.field).toBe('nodeId')
    expect(thrown?.reason).toContain('string')
  })

  it('does not regress: well-formed command still dispatches (negative control)', () => {
    const rt = createMockRuntime()
    applyCanvasCommand({ kind: 'delete-node', nodeId: 'a' }, rt)
    expect(vi.mocked(rt.deleteNode)).toHaveBeenCalledWith('a')
  })
})

/**
 * Build a minimally-valid command for a deferred kind (for the deferred-throws test).
 * Kept here rather than in canvasCommand.ts because it is test-only scaffolding.
 */
function buildDeferredCommand(kind: string): CanvasCommandForTest {
  switch (kind) {
    case 'import-asset':
      return { kind, assetId: 'a', mimeType: 'image/png', position: { x: 0, y: 0 } } as CanvasCommandForTest
    case 'generate-variations':
      return { kind } as CanvasCommandForTest
    case 'generate-image-edit':
      return { kind, operation: 'upscale', prompt: 'p' } as CanvasCommandForTest
    case 'generate-beside-node':
      return { kind } as CanvasCommandForTest
    case 'generate-into-ai-slot':
      return { kind } as CanvasCommandForTest
    case 'generate-from-annotation':
      return { kind } as CanvasCommandForTest
    case 'mask-edit':
      return {
        kind,
        sourceNodeId: 'n',
        prompt: 'p',
        sourceSize: { width: 1, height: 1 },
      } as CanvasCommandForTest
    default:
      throw new Error(`buildDeferredCommand: ${kind} is not a deferred kind`)
  }
}

type CanvasCommandForTest = Parameters<typeof applyCanvasCommand>[0]
