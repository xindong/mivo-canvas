// assetUrlLease — reference-counted asset URL lease (Phase 3a, lease track).
//
// Wraps assetStorage.resolveAssetUrl with a per-assetUrl refcount so multiple
// consumers mounting the same imported asset share ONE blob URL (one
// createObjectURL call) instead of one each. The blob is revoked only when the
// last consumer releases. This is the foundation for Leafer Image (3c) and any
// other renderer that needs a stable blob URL without double-revoking shared
// blobs.
//
// Design: plans/leafer-designs/phase3a-asset-lease-metrics.md §1.1-1.8.
//
// Red lines:
// - pass-through: empty / non-mivo-asset: URLs are NOT refcounted and NOT
//   revoked (resolveAssetUrl returns them as-is; nothing to revoke).
// - release is delivered ONLY after the acquire promise resolves (1.6), so
//   there is no "release before acquire" race. Pending-unmount is handled by
//   the hook's cancelled flag (1.5) — the hook releases in its .then when it
//   sees it was cancelled.
// - release is idempotent (released flag) and revokes only when refCount hits 0.

import { debugLogger } from '../store/debugLogStore'
import { isImportedAssetUrl, resolveAssetUrl } from './assetStorage'

export type AssetLease = {
  url: string
  release: () => void
}

type LeaseEntry = {
  blobUrl: string
  refCount: number
  /** Shared in-flight resolution promise; concurrent acquires dedup on this. */
  inFlight: Promise<string>
}

const leaseMap = new Map<string, LeaseEntry>()
const LEASE_SOURCE = 'Asset Lease'

const isLeaseable = (assetUrl?: string): assetUrl is string =>
  Boolean(assetUrl && isImportedAssetUrl(assetUrl))

const noopRelease = () => {}

const makeRelease = (assetUrl: string) => {
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = leaseMap.get(assetUrl)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    if (entry.refCount < 0) {
      // True imbalance — a release was called more times than acquire. Surface
      // it; clamp so a subsequent acquire isn't poisoned by a negative count.
      debugLogger.warn(LEASE_SOURCE, `refCount underflow for ${assetUrl} (${entry.refCount}); clamped`)
      entry.refCount = 0
    }
    leaseMap.delete(assetUrl)
    if (entry.blobUrl) {
      URL.revokeObjectURL(entry.blobUrl)
    }
  }
}

/**
 * Acquire a leased asset URL. Concurrent acquires for the same `mivo-asset:` URL
 * share one createObjectURL call (deduped via the in-flight promise). Each
 * successful acquire MUST be balanced by exactly one `release()` call; the last
 * release revokes the blob URL.
 *
 * Empty / non-mivo-asset: URLs pass through untouched (no refcount, no revoke).
 * IDB misses (resolveAssetUrl returns '') return `{ url: '', release: noop }`
 * and drop the entry so the next acquire re-attempts resolution.
 */
export const acquireAssetUrl = async (assetUrl?: string): Promise<AssetLease> => {
  if (!isLeaseable(assetUrl)) {
    return { url: assetUrl || '', release: noopRelease }
  }

  const existing = leaseMap.get(assetUrl)
  if (existing) {
    existing.refCount += 1
    const blobUrl = await existing.inFlight
    // IDB miss / non-blob resolution: the originating acquire will drop the entry.
    // Hand back a no-op release — there is no blob to revoke.
    if (!blobUrl || !blobUrl.startsWith('blob:')) {
      return { url: blobUrl, release: noopRelease }
    }
    return { url: blobUrl, release: makeRelease(assetUrl) }
  }

  const inFlight = resolveAssetUrl(assetUrl)
  const entry: LeaseEntry = { blobUrl: '', refCount: 1, inFlight }
  leaseMap.set(assetUrl, entry)

  const blobUrl = await inFlight
  entry.blobUrl = blobUrl

  if (!blobUrl || !blobUrl.startsWith('blob:')) {
    // IDB miss or pass-through resolution — nothing to revoke. Drop the entry so
    // the next acquire re-attempts resolution instead of caching a miss.
    leaseMap.delete(assetUrl)
    return { url: blobUrl, release: noopRelease }
  }

  return { url: blobUrl, release: makeRelease(assetUrl) }
}

/** Test-only: expose the live entry count for assertions. Not exported to app code. */
export const __leaseMapSize = () => leaseMap.size
