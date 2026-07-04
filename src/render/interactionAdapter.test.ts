import { describe, expect, it } from 'vitest'
import type { RenderNode } from './projection'
import { isEditStateActive, resolveHitTarget } from './interactionAdapter'

const makeNode = (overrides: Partial<RenderNode> & { id: string }): RenderNode => ({
  type: 'image',
  status: 'ready',
  title: 'n',
  geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
  hidden: false,
  locked: false,
  favorited: false,
  selected: false,
  fills: [],
  strokes: [],
  ...overrides,
})

describe('isEditStateActive', () => {
  it('is false when no edit state', () => {
    expect(isEditStateActive(undefined)).toBe(false)
    expect(isEditStateActive({})).toBe(false)
  })
  it('is false when only one field set', () => {
    expect(isEditStateActive({ activeEditNodeId: 'n1' })).toBe(false)
    expect(isEditStateActive({ activeEditKind: 'mask' })).toBe(false)
  })
  it('is true when both nodeId + kind set', () => {
    expect(isEditStateActive({ activeEditNodeId: 'n1', activeEditKind: 'mask' })).toBe(true)
    expect(isEditStateActive({ activeEditNodeId: 'n1', activeEditKind: 'crop' })).toBe(true)
    expect(isEditStateActive({ activeEditNodeId: 'n1', activeEditKind: 'text-edit' })).toBe(true)
  })
})

describe('resolveHitTarget', () => {
  const nodes = [
    makeNode({ id: 'back', geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } }),
    makeNode({ id: 'front', geometry: { x: 50, y: 50, width: 100, height: 100, rotation: 0 } }),
  ]

  it('delegates to topmostHit (front-most node hit on overlap)', () => {
    // back-to-front: [back, front]; point (75,75) is in both → front wins.
    const target = resolveHitTarget(nodes, { x: 75, y: 75 })
    expect(target).toEqual({ kind: 'node', nodeId: 'front' })
  })

  it('returns null for empty canvas', () => {
    expect(resolveHitTarget(nodes, { x: 999, y: 999 })).toBeNull()
  })

  it('short-circuits to edit-overlay-cancel when edit state is active (no hit-test)', () => {
    // Point is on a node, but edit state active → edit overlay owns pointer;
    // shell returns a cancel target for the caller to route to the cancel handler.
    const target = resolveHitTarget(nodes, { x: 75, y: 75 }, {
      editState: { activeEditNodeId: 'n1', activeEditKind: 'mask' },
    })
    expect(target).toEqual({ kind: 'edit-overlay-cancel', nodeId: 'n1', editKind: 'mask' })
  })

  it('edit-overlay-cancel carries the active editKind for mask/crop/text-edit', () => {
    for (const editKind of ['mask', 'crop', 'text-edit'] as const) {
      const target = resolveHitTarget(nodes, { x: 75, y: 75 }, {
        editState: { activeEditNodeId: 'edit-node', activeEditKind: editKind },
      })
      expect(target).toEqual({ kind: 'edit-overlay-cancel', nodeId: 'edit-node', editKind })
    }
  })

  it('does NOT short-circuit when edit state is incomplete', () => {
    // Only nodeId set (no kind) → not active → hit-test proceeds.
    const target = resolveHitTarget(nodes, { x: 75, y: 75 }, {
      editState: { activeEditNodeId: 'n1' },
    })
    expect(target).toEqual({ kind: 'node', nodeId: 'front' })
  })
})
