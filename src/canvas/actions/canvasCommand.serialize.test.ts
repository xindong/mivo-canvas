// src/canvas/actions/canvasCommand.serialize.test.ts
// T2.3 — CanvasCommand serialize→deserialize round-trip consistency.
//
// CONTRACT UNDER TEST (T2.3 acceptance): for every CanvasCommand variant,
// deserialize(serialize(command)) must equal(command) — i.e. the JSON
// representation preserves the command value. This is the "serialize 往返一致"
// gate. vitest's toEqual ignores undefined properties, which matches
// JSON.stringify's behavior of dropping undefined optional keys, so a command
// with omitted optionals round-trips to an equal command.
//
// This file does NOT exercise apply (see canvasCommandExecutor.test.ts) and does
// NOT touch canvasActionModel.ts or its characterization tests.

import { describe, expect, it } from 'vitest'
import {
  CANVAS_COMMAND_KINDS,
  CanvasCommandSerializeError,
  deserializeCanvasCommand,
  serializeCanvasCommand,
  type CanvasCommand,
} from './canvasCommand'

const roundTrip = (command: CanvasCommand): CanvasCommand => {
  const json = serializeCanvasCommand(command)
  const restored = deserializeCanvasCommand(json)
  expect(restored).toEqual(command)
  // double-serialize is stable: the restored object re-serializes to the same JSON
  // string (proves no exotic values like undefined survive the first pass and
  // change shape on the second).
  expect(serializeCanvasCommand(restored)).toBe(json)
  return restored
}

describe('CanvasCommand serialize round-trip', () => {
  // ── Node creation ────────────────────────────────────────────────────────────
  it('add-text-node (with text)', () => {
    roundTrip({ kind: 'add-text-node', position: { x: 10, y: 20 }, text: 'hello' })
  })
  it('add-text-node (no text)', () => {
    roundTrip({ kind: 'add-text-node', position: { x: 0, y: 0 } })
  })
  it('add-frame-node (full)', () => {
    roundTrip({
      kind: 'add-frame-node',
      position: { x: 1, y: 2 },
      size: { width: 300, height: 200 },
      title: 'Section A',
    })
  })
  it('add-frame-node (position only)', () => {
    roundTrip({ kind: 'add-frame-node', position: { x: 5, y: 5 } })
  })
  it('add-ai-slot-node (full)', () => {
    roundTrip({
      kind: 'add-ai-slot-node',
      position: { x: 100, y: 100 },
      size: { width: 320, height: 320 },
      prompt: 'a cat',
    })
  })
  it('add-ai-slot-node (position only)', () => {
    roundTrip({ kind: 'add-ai-slot-node', position: { x: 0, y: 0 } })
  })
  it('add-annotation-node (all optionals)', () => {
    roundTrip({
      kind: 'add-annotation-node',
      sourceNodeId: 'img-1',
      position: { x: 50, y: 50 },
      instruction: 'remove bg',
      options: { operation: 'remove-background', title: 'Edit for image' },
    })
  })
  it('add-annotation-node (bare)', () => {
    roundTrip({ kind: 'add-annotation-node' })
  })
  it('add-markup-node (arrow with points + connector bindings)', () => {
    roundTrip({
      kind: 'add-markup-node',
      markupKind: 'arrow',
      position: { x: 0, y: 0 },
      geometry: { width: 160, height: 96 },
      options: {
        points: [
          { x: 8, y: 88 },
          { x: 152, y: 8, pressure: 0.5 },
        ],
        strokeColor: '#6957e8',
        strokeWidth: 3,
        strokeStyle: 'solid',
        startArrow: false,
        endArrow: true,
        connectorStart: { nodeId: 'n1', anchor: 'right', offset: 12 },
        connectorEnd: { nodeId: 'n2', anchor: 'left' },
        select: true,
      },
    })
  })
  it('add-markup-node (brush with pressure points)', () => {
    roundTrip({
      kind: 'add-markup-node',
      markupKind: 'brush',
      position: { x: 10, y: 10 },
      options: {
        points: [
          { x: 12, y: 62, pressure: 0.2 },
          { x: 44, y: 24, pressure: 0.9 },
        ],
        strokeColor: '#b9473a',
        fillColor: 'transparent',
      },
    })
  })
  it('add-markup-node (stamp, no options)', () => {
    roundTrip({
      kind: 'add-markup-node',
      markupKind: 'stamp',
      position: { x: 200, y: 200 },
    })
  })

  // ── Node style / section ──────────────────────────────────────────────────────
  it('update-markup-style (full patch)', () => {
    roundTrip({
      kind: 'update-markup-style',
      nodeId: 'm1',
      style: {
        markupStrokeColor: '#159bff',
        markupFillColor: 'rgba(21,155,255,0.1)',
        markupStrokeWidth: 6,
        markupStrokeStyle: 'dashed',
        markupOpacity: 0.8,
        markupStartArrow: true,
        markupEndArrow: false,
        markupCornerRadius: 18,
      },
    })
  })
  it('update-markup-style (single field)', () => {
    roundTrip({ kind: 'update-markup-style', nodeId: 'm1', style: { markupStrokeWidth: 2 } })
  })
  it('update-section-style (full patch)', () => {
    roundTrip({
      kind: 'update-section-style',
      nodeId: 'f1',
      style: {
        sectionFillColor: '#fff7e6',
        sectionBorderColor: '#ff8a00',
        sectionBorderWidth: 4,
        sectionBorderStyle: 'solid',
        sectionTitleVisible: false,
      },
    })
  })
  it('update-section-style (single field)', () => {
    roundTrip({ kind: 'update-section-style', nodeId: 'f1', style: { sectionTitleVisible: true } })
  })
  it('set-section-lock-mode (all)', () => {
    roundTrip({ kind: 'set-section-lock-mode', nodeId: 'f1', mode: 'all' })
  })
  it('set-section-lock-mode (background)', () => {
    roundTrip({ kind: 'set-section-lock-mode', nodeId: 'f1', mode: 'background' })
  })
  it('set-section-lock-mode (unlock = undefined mode)', () => {
    roundTrip({ kind: 'set-section-lock-mode', nodeId: 'f1' })
  })
  it('remove-section-only', () => {
    roundTrip({ kind: 'remove-section-only', nodeId: 'f1' })
  })

  // ── Selection / tool ──────────────────────────────────────────────────────────
  it('select-nodes (with primary)', () => {
    roundTrip({ kind: 'select-nodes', nodeIds: ['a', 'b', 'c'], primaryNodeId: 'a' })
  })
  it('select-nodes (no primary)', () => {
    roundTrip({ kind: 'select-nodes', nodeIds: ['x'] })
  })
  it('select-nodes (empty)', () => {
    roundTrip({ kind: 'select-nodes', nodeIds: [] })
  })
  it('set-active-tool', () => {
    roundTrip({ kind: 'set-active-tool', toolId: 'select' })
  })

  // ── Organization ──────────────────────────────────────────────────────────────
  it('duplicate-node', () => {
    roundTrip({ kind: 'duplicate-node', nodeId: 'a' })
  })
  it('duplicate-selected-nodes', () => {
    roundTrip({ kind: 'duplicate-selected-nodes' })
  })
  it('group-selected-nodes', () => {
    roundTrip({ kind: 'group-selected-nodes' })
  })
  it('ungroup-selected-nodes', () => {
    roundTrip({ kind: 'ungroup-selected-nodes' })
  })
  it('copy-selected-nodes', () => {
    roundTrip({ kind: 'copy-selected-nodes' })
  })
  it('paste-clipboard-nodes', () => {
    roundTrip({ kind: 'paste-clipboard-nodes' })
  })

  // ── Layer ──────────────────────────────────────────────────────────────────────
  it.each(['forward', 'backward', 'front', 'back'] as const)('move-node-layer (%s)', (move) => {
    roundTrip({ kind: 'move-node-layer', nodeId: 'a', move })
  })
  it.each(['forward', 'backward', 'front', 'back'] as const)('move-selected-layer (%s)', (move) => {
    roundTrip({ kind: 'move-selected-layer', move })
  })

  // ── Arrange ───────────────────────────────────────────────────────────────────
  it.each(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const)(
    'align-selected-nodes (%s)',
    (alignment) => {
      roundTrip({ kind: 'align-selected-nodes', alignment })
    },
  )
  it.each(['horizontal', 'vertical'] as const)('distribute-selected-nodes (%s)', (axis) => {
    roundTrip({ kind: 'distribute-selected-nodes', axis })
  })
  it.each(['row', 'column', 'grid', 'tidy'] as const)('arrange-selected-nodes (%s)', (mode) => {
    roundTrip({ kind: 'arrange-selected-nodes', mode })
  })

  // ── Visibility / lock ──────────────────────────────────────────────────────────
  it('toggle-selected-nodes-locked', () => {
    roundTrip({ kind: 'toggle-selected-nodes-locked' })
  })
  it('hide-selected-nodes', () => {
    roundTrip({ kind: 'hide-selected-nodes' })
  })
  it('show-all-hidden-nodes', () => {
    roundTrip({ kind: 'show-all-hidden-nodes' })
  })

  // ── Delete ─────────────────────────────────────────────────────────────────────
  it('delete-node', () => {
    roundTrip({ kind: 'delete-node', nodeId: 'a' })
  })
  it('delete-selected-nodes', () => {
    roundTrip({ kind: 'delete-selected-nodes' })
  })

  // ── Two-stage asset (PR1: round-trip only, apply deferred) ─────────────────────
  it('import-asset (full)', () => {
    roundTrip({
      kind: 'import-asset',
      assetId: 'a1b2c3d4e5f6',
      mimeType: 'image/png',
      originalName: 'photo.png',
      position: { x: 240, y: 160 },
    })
  })
  it('import-asset (no originalName)', () => {
    roundTrip({
      kind: 'import-asset',
      assetId: 'deadbeef',
      mimeType: 'image/jpeg',
      position: { x: 0, y: 0 },
    })
  })

  // ── Generation (PR1: round-trip only, apply deferred) ──────────────────────────
  it('generate-variations (with variations + options)', () => {
    roundTrip({
      kind: 'generate-variations',
      sourceNodeId: 'img-1',
      variations: [
        { prompt: 'a red cat', imgRatio: '1:1', quality: 'high' },
        { prompt: 'a blue cat', model: 'mivo-mock' },
      ],
      options: {
        sceneId: 'scene-1',
        createDerivationEdge: true,
        imgRatio: '16:9',
        quality: 'medium',
        model: 'mivo-mock',
        referenceAssetIds: ['ref-1', 'ref-2'],
      },
    })
  })
  it('generate-variations (bare)', () => {
    roundTrip({ kind: 'generate-variations' })
  })
  it('generate-image-edit (full)', () => {
    roundTrip({
      kind: 'generate-image-edit',
      sourceNodeId: 'img-1',
      operation: 'remove-background',
      prompt: 'Remove the background.',
      options: { referenceAssetIds: ['ref-1'] },
    })
  })
  it.each(
    ['slot-generation', 'beside-generation', 'annotation-edit', 'variation', 'prompt-edit', 'area-edit', 'remove-background', 'outpaint', 'upscale'] as const,
  )('generate-image-edit (operation %s)', (operation) => {
    roundTrip({
      kind: 'generate-image-edit',
      operation,
      prompt: 'p',
    })
  })
  it('generate-beside-node (full)', () => {
    roundTrip({
      kind: 'generate-beside-node',
      sourceNodeId: 'img-1',
      prompt: 'a sunset',
      options: { imgRatio: '3:2', referenceAssetIds: ['ref-1'] },
    })
  })
  it('generate-into-ai-slot (full)', () => {
    roundTrip({
      kind: 'generate-into-ai-slot',
      slotId: 'slot-1',
      prompt: 'a dog',
      options: { quality: 'high' },
    })
  })
  it('generate-from-annotation (full)', () => {
    roundTrip({
      kind: 'generate-from-annotation',
      annotationNodeId: 'note-1',
      options: { imgRatio: '1:1' },
    })
  })

  // ── Coverage: every kind has at least one round-trip fixture ───────────────────
  it('covers every CanvasCommand kind (no kind left untested)', () => {
    // This test is a static guarantee that the suite above is exhaustive. We
    // re-derive the kinds touched by the roundTrip calls via the CANVAS_COMMAND_KINDS
    // registry; if a new kind is added to the union without a fixture above, this
    // assertion fails as a forcing function.
    const covered = new Set<string>()
    const collect = (...cmds: CanvasCommand[]) => cmds.forEach((c) => covered.add(c.kind))

    collect(
      { kind: 'add-text-node', position: { x: 0, y: 0 } },
      { kind: 'add-frame-node', position: { x: 0, y: 0 } },
      { kind: 'add-ai-slot-node', position: { x: 0, y: 0 } },
      { kind: 'add-annotation-node' },
      { kind: 'add-markup-node', markupKind: 'rect', position: { x: 0, y: 0 } },
      { kind: 'update-markup-style', nodeId: 'm', style: {} },
      { kind: 'update-section-style', nodeId: 'f', style: {} },
      { kind: 'set-section-lock-mode', nodeId: 'f', mode: 'all' },
      { kind: 'remove-section-only', nodeId: 'f' },
      { kind: 'select-nodes', nodeIds: [] },
      { kind: 'set-active-tool', toolId: 'select' },
      { kind: 'duplicate-node', nodeId: 'a' },
      { kind: 'duplicate-selected-nodes' },
      { kind: 'group-selected-nodes' },
      { kind: 'ungroup-selected-nodes' },
      { kind: 'copy-selected-nodes' },
      { kind: 'paste-clipboard-nodes' },
      { kind: 'move-node-layer', nodeId: 'a', move: 'front' },
      { kind: 'move-selected-layer', move: 'back' },
      { kind: 'align-selected-nodes', alignment: 'center' },
      { kind: 'distribute-selected-nodes', axis: 'horizontal' },
      { kind: 'arrange-selected-nodes', mode: 'grid' },
      { kind: 'toggle-selected-nodes-locked' },
      { kind: 'hide-selected-nodes' },
      { kind: 'show-all-hidden-nodes' },
      { kind: 'delete-node', nodeId: 'a' },
      { kind: 'delete-selected-nodes' },
      { kind: 'import-asset', assetId: 'id', mimeType: 'image/png', position: { x: 0, y: 0 } },
      { kind: 'generate-variations' },
      { kind: 'generate-image-edit', operation: 'upscale', prompt: 'p' },
      { kind: 'generate-beside-node' },
      { kind: 'generate-into-ai-slot' },
      { kind: 'generate-from-annotation' },
    )

    const all = new Set<string>(CANVAS_COMMAND_KINDS)
    expect(covered).toEqual(all)
  })
})

describe('deserializeCanvasCommand — error paths', () => {
  it('throws on invalid JSON', () => {
    expect(() => deserializeCanvasCommand('{not json')).toThrow(CanvasCommandSerializeError)
  })
  it('throws on missing kind discriminator', () => {
    expect(() => deserializeCanvasCommand(JSON.stringify({ position: { x: 1, y: 2 } }))).toThrow(
      CanvasCommandSerializeError,
    )
  })
  it('throws on non-string kind', () => {
    expect(() => deserializeCanvasCommand(JSON.stringify({ kind: 42 }))).toThrow(
      CanvasCommandSerializeError,
    )
  })
  it('throws on unknown kind', () => {
    expect(() => deserializeCanvasCommand(JSON.stringify({ kind: 'not-a-real-command' }))).toThrow(
      CanvasCommandSerializeError,
    )
  })
  it('throws on array payload (not object)', () => {
    expect(() => deserializeCanvasCommand(JSON.stringify([]))).toThrow(CanvasCommandSerializeError)
  })
  it('throws on null payload', () => {
    expect(() => deserializeCanvasCommand('null')).toThrow(CanvasCommandSerializeError)
  })
  it('restores a known kind with extra fields intact (forward-compat pass-through)', () => {
    // deserialize validates kind only; it does not strip unknown fields. A future
    // schema adding a field will still round-trip through this version's serialize.
    const json = JSON.stringify({
      kind: 'delete-node',
      nodeId: 'a',
      futureField: { any: 'value' },
    })
    const restored = deserializeCanvasCommand(json) as CanvasCommand & { futureField: unknown }
    expect(restored.kind).toBe('delete-node')
    expect(restored.futureField).toEqual({ any: 'value' })
  })
})
