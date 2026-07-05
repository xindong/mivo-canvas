// rendererAdapter — canonical render-adapter contract (Phase 2b-1).
//
// Formalizes the spike (useLeaferSpikeRenderer) into a stable interface so a future
// LeaferRendererAdapter / DomRendererAdapter can sit behind one contract. The spike
// is NOT rewritten (0g-validated behavior preserved); this file is the contract +
// RendererSyncContext the 2b-2 wiring will implement.
//
// D1 (hard constraint): an adapter is a pure paint surface. It MUST NOT subscribe
// to Leafer events, MUST NOT read `zoomLayer.__` to back-write the store, and MUST
// NOT bidirectionally sync the camera. The camera is one-way: React/gesture →
// engine (zoomLayer.set or the engine-spike camera bridge). See useLeaferCameraSync
// for the formal camera hook + the D1 `leafer.on === 0` spy test.
//
// 0g three invariants (must hold under any adapter impl):
//  1. pan only walks the engine camera transform — zero React re-render, zero
//     visible-set recompute during pan; settle recomputes.
//  2. panorama-threshold LOD — screen projection < lodPx → solid-color rect.
//  3. zoom settle restores HD — LOD↔HD transition is testable behavior.

import type { RenderNode } from './projection'
import type { ViewportState } from './useLeaferSpikeRenderer'

/** A render adapter's identity + lifecycle. DOM goes through React declarative
 *  rendering (<DomRenderer>) and does not implement this interface directly; the
 *  Leafer adapter (2b-2) implements it. The contract is here so both surfaces
 *  answer to the same sync shape. */
export type RendererAdapter = {
  /** Which surface this adapter paints. */
  readonly mode: 'dom' | 'leafer'
  /** Mount into a host element. Idempotent; double-mount is a no-op. */
  mount(host: HTMLDivElement): void
  /** Tear down + release all resources. Idempotent; double-unmount is a no-op. */
  unmount(): void
  /** Reconcile the painted set to `nodes` — create/update/delete收支 must balance
   *  (no leak, no resurrected id). See rendererAdapter.test.ts. */
  sync(nodes: RenderNode[], ctx: RendererSyncContext): void
  /** One-way camera write. Pan walks this without a React commit (0g invariant 1). */
  setViewport(viewport: ViewportState): void
  /** Stable layer order (2b-2 z-order; no-op stub for 2b-1). */
  setLayerOrder?(order: ReadonlyArray<string>): void
}

/** Per-sync context the adapter needs beyond the node list. */
export type RendererSyncContext = {
  viewport: ViewportState
  /** Function form so the adapter can resolve a node's layer lazily (2b-2). */
  layerOf?: (nodeId: string) => number | undefined
  selectedNodeIds: ReadonlySet<string>
  /** True while a pan is in flight — adapter may freeze (0g invariant 1). */
  isPanning: boolean
  /** FU-11: 正在文字编辑的节点 id。line paint 用它在编辑空 label 时也断开线体
   *  （DOM 侧此刻已渲染编辑器）——与 DOM 的 lineLabelActive(editing||text) 同口径。 */
  editingNodeId?: string
}

/** A record of create/update/delete operations a sync performed. Contract tests
 *  assert the balance: every previously-painted id is either updated or deleted,
 *  every new id is created exactly once, and no id is both created and updated. */
export type RendererReconcileCounts = {
  created: number
  updated: number
  deleted: number
}

/**
 * Diff two id sets into a reconcile plan. Exported so adapter implementations +
 * tests share one definition of "收支平衡". The plan is the ground truth for the
 * `sync` contract: created ∩ deleted = ∅, updated ⊆ previous, created ⊆ next.
 */
export const diffReconcilePlan = (
  previousIds: ReadonlyArray<string>,
  nextIds: ReadonlyArray<string>,
): { created: Set<string>; updated: Set<string>; deleted: Set<string> } => {
  const prev = new Set(previousIds)
  const next = new Set(nextIds)
  const created = new Set<string>()
  const updated = new Set<string>()
  const deleted = new Set<string>()
  for (const id of next) {
    if (prev.has(id)) updated.add(id)
    else created.add(id)
  }
  for (const id of prev) {
    if (!next.has(id)) deleted.add(id)
  }
  return { created, updated, deleted }
}
