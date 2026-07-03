// anchorModel — P2-D1 Anchor MVP pure helpers (roadmap §7 组 D).
//
// EXPERIMENTAL field: see {@link ExperimentalAnchor} in types/mivoCanvas. This module
// is the single source of truth for anchor validation/normalization + the immutable
// node operations the store actions delegate to. It has NO store import (pure), so it
// unit-tests in isolation. Migration rule (roadmap §9 P4-a): either收编为 the formal
// CanvasAnchor type, or remove this module + the field + the store actions.

import type { ExperimentalAnchor, ExperimentalAnchorType, MivoCanvasNode } from '../types/mivoCanvas'

export type { ExperimentalAnchor, ExperimentalAnchorType }

// --- ids ---------------------------------------------------------------------

export const createAnchorId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `anchor-${crypto.randomUUID()}`
    : `anchor-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

// --- validation / normalization ----------------------------------------------

// Validate a single anchor's shape. Returns a clean anchor (whitelisted fields,
// box width/height enforced) or null if invalid. box missing width/height → null
// (cloneNode drops it and warns).
const validateAnchor = (anchor: unknown): ExperimentalAnchor | null => {
  if (!anchor || typeof anchor !== 'object') return null
  const a = anchor as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id) return null
  if (a.type !== 'point' && a.type !== 'box') return null
  if (typeof a.targetNodeId !== 'string' || !a.targetNodeId) return null
  if (typeof a.x !== 'number' || !Number.isFinite(a.x)) return null
  if (typeof a.y !== 'number' || !Number.isFinite(a.y)) return null
  if (typeof a.instruction !== 'string') return null
  if (typeof a.createdAt !== 'number' || !Number.isFinite(a.createdAt)) return null
  if (a.type === 'box') {
    if (typeof a.width !== 'number' || !Number.isFinite(a.width) || a.width <= 0) return null
    if (typeof a.height !== 'number' || !Number.isFinite(a.height) || a.height <= 0) return null
  }
  if (a.resultNodeIds !== undefined && !Array.isArray(a.resultNodeIds)) return null
  if (Array.isArray(a.resultNodeIds) && !a.resultNodeIds.every((r) => typeof r === 'string')) return null

  const clean: ExperimentalAnchor = {
    id: a.id,
    type: a.type,
    targetNodeId: a.targetNodeId,
    x: a.x,
    y: a.y,
    instruction: a.instruction,
    createdAt: a.createdAt,
  }
  if (a.type === 'box') {
    clean.width = a.width as number
    clean.height = a.height as number
  }
  if (Array.isArray(a.resultNodeIds)) clean.resultNodeIds = [...(a.resultNodeIds as string[])]
  return clean
}

// Deep-copy + validate + drop invalid anchors. Used by cloneNode (nodeFactory) so
// clipboard / history / persist copies never carry shared refs or bad shape. `warn`
// logs each dropped anchor in development (callers that clone always pass warn=true).
export const normalizeAnchors = (anchors: unknown, warn = false): ExperimentalAnchor[] | undefined => {
  if (!Array.isArray(anchors)) return undefined
  const out: ExperimentalAnchor[] = []
  for (const raw of anchors) {
    const clean = validateAnchor(raw)
    if (clean) out.push(clean)
    else if (warn)
      console.warn('[mivo] experimental anchor dropped: invalid shape (box missing width/height or missing required fields)')
  }
  return out.length ? out : undefined
}

// --- construction from user input --------------------------------------------

export type AnchorInput = {
  type: ExperimentalAnchorType
  targetNodeId: string
  x: number
  y: number
  instruction: string
  /** Required when type==='box'. */
  width?: number
  height?: number
}

/** Build a committed anchor from user input (assigns id + createdAt). Returns undefined on invalid input. */
export const createAnchor = (input: AnchorInput): ExperimentalAnchor | undefined => {
  if (!input.targetNodeId) return undefined
  if (typeof input.x !== 'number' || !Number.isFinite(input.x)) return undefined
  if (typeof input.y !== 'number' || !Number.isFinite(input.y)) return undefined
  if (typeof input.instruction !== 'string') return undefined
  if (input.type === 'box') {
    if (typeof input.width !== 'number' || !Number.isFinite(input.width) || input.width <= 0) return undefined
    if (typeof input.height !== 'number' || !Number.isFinite(input.height) || input.height <= 0) return undefined
  }
  const anchor: ExperimentalAnchor = {
    id: createAnchorId(),
    type: input.type,
    targetNodeId: input.targetNodeId,
    x: input.x,
    y: input.y,
    instruction: input.instruction,
    createdAt: Date.now(),
  }
  if (input.type === 'box') {
    anchor.width = input.width
    anchor.height = input.height
  }
  return anchor
}

// --- immutable node operations (return NEW node) ------------------------------

const withAnchors = (
  node: MivoCanvasNode,
  anchors: ExperimentalAnchor[] | undefined,
): MivoCanvasNode =>
  anchors && anchors.length ? { ...node, experimentalAnchors: anchors } : { ...node, experimentalAnchors: undefined }

/** Append a committed anchor. Returns a new node. */
export const addAnchorToNode = (node: MivoCanvasNode, anchor: ExperimentalAnchor): MivoCanvasNode => {
  const existing = node.experimentalAnchors ?? []
  return withAnchors(node, [...existing, anchor])
}

/** Update one anchor's instruction. No-op (returns same node) if the anchor id is absent. */
export const updateAnchorInstruction = (
  node: MivoCanvasNode,
  anchorId: string,
  instruction: string,
): MivoCanvasNode => {
  const existing = node.experimentalAnchors
  if (!existing) return node
  let changed = false
  const next = existing.map((a) => {
    if (a.id === anchorId) {
      changed = true
      return { ...a, instruction }
    }
    return a
  })
  return changed ? withAnchors(node, next) : node
}

/** Remove one anchor by id. No-op if absent. Clears experimentalAnchors when the last one is removed. */
export const removeAnchorFromNode = (node: MivoCanvasNode, anchorId: string): MivoCanvasNode => {
  const existing = node.experimentalAnchors
  if (!existing) return node
  const next = existing.filter((a) => a.id !== anchorId)
  if (next.length === existing.length) return node
  return withAnchors(node, next)
}

/** Record the result node ids produced by generation triggered from an anchor. No-op if the anchor is absent. */
export const recordAnchorResultOnNode = (
  node: MivoCanvasNode,
  anchorId: string,
  resultNodeIds: string[],
): MivoCanvasNode => {
  const existing = node.experimentalAnchors
  if (!existing) return node
  let changed = false
  const next = existing.map((a) => {
    if (a.id === anchorId) {
      changed = true
      return { ...a, resultNodeIds: [...resultNodeIds] }
    }
    return a
  })
  return changed ? withAnchors(node, next) : node
}
