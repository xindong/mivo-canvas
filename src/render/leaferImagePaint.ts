// leaferImagePaint — Phase 3c: formalize image paint onto Leafer behind the
// RendererAdapter contract.
//
// The 0g spike painted images inline (useLeaferSpikeRenderer) with
// `new Image({ url: node.assetUrl })` — which BREAKS for `mivo-asset:` URLs
// (Leafer's internal <img> cannot resolve the custom protocol, so imported
// assets never appeared in leafer mode) and ignored `imageCrop` entirely. This
// module routes image paint through the contract so:
//
//   - the real loadable URL comes from `acquireAssetUrl` (Phase 3a lease: a
//     reference-counted blob URL for `mivo-asset:`, pass-through for http/local/
//     data). Leafer object destroy/delete MUST release — the lease balance is
//     asserted in leaferImagePaint.test.ts (acquire/release symmetric, including
//     the Leafer delete path and the LOD kind-swap path).
//   - crop is reproduced via a `Group(overflow: 'hidden')` at the node box + a
//     child `Image` at the CSS-equivalent negative-offset local position
//     (CanvasNodeView imageCropStyle: left=-(crop.x/crop.width)*100%,
//     width=100/crop.width% — see cropChildLocal).
//   - create/update/delete 收支 goes through `diffReconcilePlan` (the
//     RendererAdapter contract's ground-truth diff — see rendererAdapter.ts).
//   - LOD is preserved (0g invariant 2): below threshold → solid Rect, no lease;
//     above → real bitmap, lease. A kind swap releases/acquires as needed so the
//     lease balance holds across zoom-driven LOD↔HD transitions.
//
// D1 (hard constraint): pure paint. `hittable:false` is set on the Leafer root
// (useLeaferHost), not per-object; this module never subscribes to Leafer events
// and never touches the engine camera layer. z-order uses the 2b-2 Layer enum —
// images are Layer.Content (Layer.Frame is reserved for frame/section nodes).
// Since 4a every object also carries an explicit `zIndex` from ctx.layerOf
// (layer band × document order, built once per sync by the hook), so document
// order holds ACROSS paint modules (a markup shape drawn after an image stacks
// above it, exactly like the DOM) instead of relying on per-module insertion order.
//
// 0g three invariants: pan walks the camera only — this module's `sync` is NOT
// called during pan (the spike's paint effect re-runs on node/signature change,
// not on viewport.x/y); LOD threshold solid-rect; zoom settle restores HD via a
// kind swap on the next sync after settle.

import { Group, Image, Rect } from 'leafer-ui'
import type { Leafer } from 'leafer-ui'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { acquireAssetUrl } from '../lib/assetUrlLease'
import { debugLogger } from '../store/debugLogStore'
import { Layer } from './layers'
import {
  diffReconcilePlan,
  type RendererReconcileCounts,
  type RendererSyncContext,
} from './rendererAdapter'
import { engineLodFillFor, shouldUseEngineLod } from './engineSpikeLod'
import type { ViewportState } from './useLeaferSpikeRenderer'

type ImageObject = Image | Group | Rect
type ImageEntryKind = 'image' | 'image-crop' | 'lod-rect'

type ImageEntry = {
  nodeId: string
  object: ImageObject
  kind: ImageEntryKind
  /** Inner Image for 'image-crop' (url is set on this, not the Group). For
   *  'image' the `object` itself is the Image. 'lod-rect' has none. */
  innerImage?: Image
  /** Tracked so an assetUrl change triggers re-acquire (not geometry-only update). */
  assetUrl?: string
  /** Set when the lease resolves; released on delete / kind-swap / assetUrl change. */
  releaseFn?: () => void
  /** True while acquireAssetUrl is pending. */
  leaseInFlight?: boolean
  /** Set on destroy so the async lease .then releases instead of applying the URL. */
  disposed?: boolean
}

export type LeaferImagePaint = {
  /** Reconcile painted images to `nodes`. Returns create/update/delete counts
   *  (收支 balance: every prev id is either updated or deleted, every new id is
   *  created exactly once, no id is both — asserted in leaferImagePaint.test.ts). */
  sync(nodes: MivoCanvasNode[], ctx: RendererSyncContext): RendererReconcileCounts
  /** Release all leases + remove all objects (Leafer destroy / mode-switch path). */
  dispose(): void
  /** Painted entry count (for stats + lease-balance assertions). */
  paintedCount(): number
}

export const SOURCE = 'Leafer Image'

const clampDim = (value: number) => Math.max(1, value)

/**
 * Crop child geometry mirroring the DOM CSS negative-offset technique
 * (CanvasNodeView imageCropStyle). The image is scaled so the crop region fills
 * the node box (imageW = nodeW / crop.width) and offset so crop.x/y maps to the
 * node origin. Inside a Group(overflow:hidden) at the node box, the child Image
 * local position is the negative offset, so only the node region is visible.
 *
 * Equivalent to the CSS: left=-(crop.x/crop.width)*100%, top=-(crop.y/crop.height)*100%,
 * width=100/crop.width%, height=100/crop.height%, objectFit:fill.
 */
export const cropChildLocal = (
  nodeWidth: number,
  nodeHeight: number,
  crop: NonNullable<MivoCanvasNode['imageCrop']>,
): { x: number; y: number; width: number; height: number } => {
  const imageWidth = nodeWidth / crop.width
  const imageHeight = nodeHeight / crop.height
  // -0 (from crop.x===0) is normalized to +0 so consumers get a clean 0, not a
  // negative-zero that breaks strict-equality assertions and reads oddly in CSS.
  const x = -crop.x * imageWidth
  const y = -crop.y * imageHeight
  return {
    x: x === 0 ? 0 : x,
    y: y === 0 ? 0 : y,
    width: imageWidth,
    height: imageHeight,
  }
}

/** Layer an image node paints in (2b-2 z-order). Images are always Content;
 *  Layer.Frame is reserved for frame/section nodes. Exported so tests + the
 *  spike sort image objects by the same layer value the DOM zIndex reads. */
export const imageLayer = (): Layer => Layer.Content

const desiredKindFor = (node: MivoCanvasNode, viewport: ViewportState): ImageEntryKind => {
  if (shouldUseEngineLod(node, viewport)) return 'lod-rect'
  return node.imageCrop ? 'image-crop' : 'image'
}

type CreatedObject = { object: ImageObject; innerImage?: Image }

const createObject = (node: MivoCanvasNode, kind: ImageEntryKind, zIndex?: number): CreatedObject => {
  const x = node.x
  const y = node.y
  const width = clampDim(node.width)
  const height = clampDim(node.height)
  const zProps = zIndex !== undefined ? { zIndex } : {}
  if (kind === 'lod-rect') {
    return {
      object: new Rect({
        x,
        y,
        width,
        height,
        fill: engineLodFillFor(node),
        strokeWidth: 0,
        ...zProps,
      }),
    }
  }
  if (kind === 'image-crop') {
    const crop = node.imageCrop
    if (!crop) {
      // Defensive: desiredKindFor only returns 'image-crop' when imageCrop exists,
      // but a stale kind on a node whose crop was just cleared falls back to plain
      // image geometry rather than crashing.
      return { object: new Image({ x, y, width, height, ...zProps }) }
    }
    const group = new Group({ x, y, width, height, overflow: 'hidden', ...zProps })
    const child = new Image(cropChildLocal(width, height, crop))
    group.add(child)
    return { object: group, innerImage: child }
  }
  return { object: new Image({ x, y, width, height, ...zProps }) }
}

const setProps = (object: ImageObject, props: Record<string, unknown>) => {
  ;(object as { set: (props: unknown) => void }).set(props)
}

const applyUrl = (entry: ImageEntry, url: string) => {
  if (entry.kind === 'image-crop' && entry.innerImage) {
    setProps(entry.innerImage, { url })
    return
  }
  if (entry.kind === 'image') {
    setProps(entry.object, { url })
  }
}

const updateGeometry = (entry: ImageEntry, node: MivoCanvasNode, zIndex?: number) => {
  const x = node.x
  const y = node.y
  const width = clampDim(node.width)
  const height = clampDim(node.height)
  // zIndex rides along on update too: the document index can shift (node
  // inserted/removed elsewhere) without this node's own fields changing.
  const zProps = zIndex !== undefined ? { zIndex } : {}
  if (entry.kind === 'lod-rect') {
    setProps(entry.object, { x, y, width, height, fill: engineLodFillFor(node), ...zProps })
    return
  }
  if (entry.kind === 'image-crop') {
    setProps(entry.object, { x, y, width, height, ...zProps })
    const crop = node.imageCrop
    if (crop && entry.innerImage) {
      setProps(entry.innerImage, cropChildLocal(width, height, crop))
    }
    return
  }
  setProps(entry.object, { x, y, width, height, ...zProps })
}

/**
 * Create a Leafer image paint module bound to one Leafer instance. The spike
 * creates one when Leafer inits and disposes it when Leafer is destroyed; all
 * image nodes seen by `sync` are reconciled against the previous call's set.
 */
export const createLeaferImagePaint = (leafer: Leafer): LeaferImagePaint => {
  const entries = new Map<string, ImageEntry>()

  const releaseLease = (entry: ImageEntry) => {
    if (entry.releaseFn) {
      entry.releaseFn()
      entry.releaseFn = undefined
    }
  }

  /**
   * Acquire a lease for `assetUrl` and apply the resolved URL when it lands.
   * Two async races are handled by the .then:
   *   - entry disposed (node deleted / kind swapped / Leafer destroyed) while the
   *     lease was in flight → release immediately, do not apply.
   *   - assetUrl changed again while this lease was in flight → release, the
   *     newer acquire will apply the current URL.
   * Both ensure the lease is released exactly once (no leak, no double-release).
   */
  const acquireLease = (entry: ImageEntry, assetUrl: string | undefined) => {
    entry.assetUrl = assetUrl
    entry.leaseInFlight = true
    void acquireAssetUrl(assetUrl)
      .then(({ url, release }) => {
        entry.leaseInFlight = false
        if (entry.disposed) {
          release()
          return
        }
        if (entry.assetUrl !== assetUrl) {
          release()
          return
        }
        entry.releaseFn = release
        applyUrl(entry, url)
        if (!url) {
          debugLogger.warn(
            SOURCE,
            `lease resolved empty url for ${assetUrl ?? '(none)'} (IDB miss or pass-through empty) — image will stay blank`,
          )
        }
      })
      .catch((error) => {
        entry.leaseInFlight = false
        debugLogger.error(
          SOURCE,
          `acquire failed for ${assetUrl ?? '(none)'}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  const destroyEntry = (entry: ImageEntry) => {
    entry.disposed = true
    releaseLease(entry)
    entry.object.remove()
  }

  const sync: LeaferImagePaint['sync'] = (nodes, ctx) => {
    const prevIds = [...entries.keys()]
    const nextIds = nodes.map((node) => node.id)
    const plan = diffReconcilePlan(prevIds, nextIds)
    let created = 0
    let updated = 0
    let deleted = 0

    for (const id of plan.deleted) {
      const entry = entries.get(id)
      if (entry) {
        destroyEntry(entry)
        entries.delete(id)
      }
      deleted += 1
    }

    for (const node of nodes) {
      const existing = entries.get(node.id)
      const desired = desiredKindFor(node, ctx.viewport)
      const isNew = plan.created.has(node.id)
      const zIndex = ctx.layerOf?.(node.id)

      if (isNew || !existing) {
        const { object, innerImage } = createObject(node, desired, zIndex)
        const entry: ImageEntry = { nodeId: node.id, object, kind: desired, innerImage }
        entries.set(node.id, entry)
        leafer.add(object)
        created += 1
        if (desired !== 'lod-rect') acquireLease(entry, node.assetUrl)
        continue
      }

      if (existing.kind !== desired) {
        // LOD↔HD or crop add/remove: destroy + recreate under a new kind. The old
        // entry's in-flight lease (if any) sees disposed=true and releases; the
        // new entry acquires fresh if it's a bitmap kind.
        destroyEntry(existing)
        const { object, innerImage } = createObject(node, desired, zIndex)
        const fresh: ImageEntry = { nodeId: node.id, object, kind: desired, innerImage }
        entries.set(node.id, fresh)
        leafer.add(object)
        if (desired !== 'lod-rect') acquireLease(fresh, node.assetUrl)
      } else {
        updateGeometry(existing, node, zIndex)
        if (desired !== 'lod-rect' && existing.assetUrl !== node.assetUrl) {
          releaseLease(existing)
          acquireLease(existing, node.assetUrl)
        }
      }
      updated += 1
    }

    return { created, updated, deleted }
  }

  const dispose: LeaferImagePaint['dispose'] = () => {
    for (const entry of entries.values()) destroyEntry(entry)
    entries.clear()
  }

  const paintedCount: LeaferImagePaint['paintedCount'] = () => entries.size

  return { sync, dispose, paintedCount }
}
