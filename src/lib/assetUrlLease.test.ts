import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireAssetUrl, __leaseMapSize } from './assetUrlLease'
import { debugLogger } from '../store/debugLogStore'

// Mock resolveAssetUrl so tests don't touch IDB. The mock calls the (spied)
// URL.createObjectURL at call-time so the global call count reflects what the
// lease would do in production.
const realRevokeObjectURL = URL.revokeObjectURL.bind(URL)

const resolveAssetUrlMock = vi.fn(async (assetUrl?: string): Promise<string> => {
  if (!assetUrl) return ''
  // Simulate the real path: IDB hit → create a blob URL; IDB miss → ''.
  if (assetUrl.endsWith('-miss')) return ''
  const blob = new Blob([assetUrl], { type: 'image/png' })
  // Call through the spy (installed per-test in beforeEach) — not a bound real,
  // so the spy sees the call.
  return URL.createObjectURL(blob)
})

vi.mock('./assetStorage', () => ({
  isImportedAssetUrl: (url?: string) => Boolean(url?.startsWith('mivo-asset:')),
  resolveAssetUrl: (assetUrl?: string) => resolveAssetUrlMock(assetUrl),
}))

// Stub debugLogger so tests can assert log calls without touching the zustand
// store. Only `warn` is exercised by assetUrlLease; log/error are no-ops.
vi.mock('../store/debugLogStore', () => ({
  debugLogger: {
    warn: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  },
}))

const debugWarn = vi.mocked(debugLogger.warn)

beforeEach(() => {
  resolveAssetUrlMock.mockClear()
  // Spies per test so call counts are isolated. createObjectURL is left as the
  // real impl (the mock calls through it); revokeObjectURL is also real so node
  // actually invalidates blobs between lease lifecycles.
  vi.spyOn(URL, 'createObjectURL')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(realRevokeObjectURL)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const ASSET = 'mivo-asset:abc'
const ASSET_MISS = 'mivo-asset:abc-miss'

describe('acquireAssetUrl — pass-through (no refcount, no revoke)', () => {
  it('returns empty url + noop release for empty input', async () => {
    const lease = await acquireAssetUrl('')
    expect(lease.url).toBe('')
    expect(lease.release()).toBeUndefined()
    expect(__leaseMapSize()).toBe(0)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('returns the URL as-is for non-mivo-asset: URLs (http)', async () => {
    const url = 'https://example.com/cat.png'
    const lease = await acquireAssetUrl(url)
    expect(lease.url).toBe(url)
    lease.release()
    expect(__leaseMapSize()).toBe(0)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('does not call resolveAssetUrl for pass-through URLs', async () => {
    await acquireAssetUrl('https://example.com/x.png')
    expect(resolveAssetUrlMock).not.toHaveBeenCalled()
  })
})

describe('acquireAssetUrl — repeat acquire shares one blob (refcount)', () => {
  it('three acquires for the same URL call createObjectURL exactly once', async () => {
    const a = await acquireAssetUrl(ASSET)
    const b = await acquireAssetUrl(ASSET)
    const c = await acquireAssetUrl(ASSET)

    expect(resolveAssetUrlMock).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    // All three share the SAME blob URL string.
    expect(b.url).toBe(a.url)
    expect(c.url).toBe(a.url)
    expect(a.url.startsWith('blob:')).toBe(true)
    expect(__leaseMapSize()).toBe(1)

    // Not revoked until the last release.
    a.release()
    b.release()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    c.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(a.url)
    expect(__leaseMapSize()).toBe(0)
  })

  it('release is idempotent — extra releases do not underflow or double-revoke', async () => {
    const a = await acquireAssetUrl(ASSET)
    const url = a.url
    a.release()
    a.release()
    a.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
    expect(__leaseMapSize()).toBe(0)
  })

  it('re-acquiring after full release produces a fresh lease lifecycle (entry was deleted)', async () => {
    const first = await acquireAssetUrl(ASSET)
    first.release()

    const second = await acquireAssetUrl(ASSET)
    expect(second.url.startsWith('blob:')).toBe(true)
    second.release()
    // Two createObjectURL calls total (one per lease lifecycle — the entry was
    // deleted on release, so re-acquire re-resolves).
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})

describe('acquireAssetUrl — concurrent acquires (in-flight dedup)', () => {
  it('concurrent acquires share the in-flight promise (one createObjectURL)', async () => {
    // Don't await — fire all three synchronously so they overlap on the in-flight.
    const p1 = acquireAssetUrl(ASSET)
    const p2 = acquireAssetUrl(ASSET)
    const p3 = acquireAssetUrl(ASSET)
    const [a, b, c] = await Promise.all([p1, p2, p3])

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(a.url).toBe(b.url)
    expect(b.url).toBe(c.url)

    a.release()
    b.release()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    c.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(__leaseMapSize()).toBe(0)
  })
})

describe('acquireAssetUrl — pending-unmount (release after resolve)', () => {
  it('releasing an acquired lease before any other consumer revokes the blob', async () => {
    const a = await acquireAssetUrl(ASSET)
    const url = a.url
    a.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
    expect(__leaseMapSize()).toBe(0)
  })

  it('a concurrent acquire whose sibling unmounted early still resolves to the shared blob', async () => {
    // Acquire #1 (starts the in-flight), release it immediately after resolve;
    // acquire #2 started concurrently sees the shared entry + refcount.
    const p1 = acquireAssetUrl(ASSET)
    const p2 = acquireAssetUrl(ASSET)
    const a = await p1
    // #1 releases — but #2 still holds a reference, so the blob must survive.
    a.release()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    const b = await p2
    expect(b.url).toBe(a.url)
    b.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(__leaseMapSize()).toBe(0)
  })
})

describe('acquireAssetUrl — IDB miss', () => {
  it('returns empty url + noop release and drops the entry (no revoke, no shared blob)', async () => {
    const a = await acquireAssetUrl(ASSET_MISS)
    expect(a.url).toBe('')
    a.release()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(__leaseMapSize()).toBe(0)
  })

  it('concurrent miss acquires do not leak an entry', async () => {
    const [a, b] = await Promise.all([acquireAssetUrl(ASSET_MISS), acquireAssetUrl(ASSET_MISS)])
    expect(a.url).toBe('')
    expect(b.url).toBe('')
    a.release()
    b.release()
    expect(__leaseMapSize()).toBe(0)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })
})

describe('acquireAssetUrl — A→B→A switching (lease lifecycle)', () => {
  it('switching assets releases the old blob and acquires a new one', async () => {
    const assetB = 'mivo-asset:def'
    const a = await acquireAssetUrl(ASSET)
    const urlA = a.url
    const b = await acquireAssetUrl(assetB)
    const urlB = b.url

    expect(urlA).not.toBe(urlB)
    expect(__leaseMapSize()).toBe(2)

    a.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urlA)
    expect(__leaseMapSize()).toBe(1)

    // Re-acquire A — its entry was deleted on release, so a fresh lease lifecycle.
    const a2 = await acquireAssetUrl(ASSET)
    a2.release()
    b.release()
    expect(__leaseMapSize()).toBe(0)
  })
})

describe('acquireAssetUrl — resolution reject does not poison the cache (N-02)', () => {
  const ASSET_FAIL = 'mivo-asset:fail-once'
  const rejectionError = new Error('boom: resolveAssetUrl rejected')

  beforeEach(() => {
    // First call rejects, subsequent calls resolve normally (re-resolution path).
    resolveAssetUrlMock
      .mockReset()
      .mockImplementationOnce(async () => {
        throw rejectionError
      })
      .mockImplementation(async (assetUrl?: string): Promise<string> => {
        if (!assetUrl) return ''
        const blob = new Blob([assetUrl], { type: 'image/png' })
        return URL.createObjectURL(blob)
      })
    debugWarn.mockClear()
  })

  it('originating acquire rejects → entry is deleted → next acquire re-resolves (not poisoned)', async () => {
    // First acquire rejects. The entry must be dropped so it isn't cached as a
    // rejected promise (poisoned cache).
    await expect(acquireAssetUrl(ASSET_FAIL)).rejects.toThrow(rejectionError)
    expect(__leaseMapSize()).toBe(0)
    // Failure path must log a warn (state changed: entry deleted) per logging rules.
    expect(debugWarn).toHaveBeenCalledTimes(1)
    expect(debugWarn).toHaveBeenCalledWith(
      'Asset Lease',
      expect.stringContaining(`asset resolution rejected for ${ASSET_FAIL}`),
    )

    // Second acquire must re-resolve from scratch (not hit a poisoned in-flight),
    // producing a fresh blob URL lease.
    const lease = await acquireAssetUrl(ASSET_FAIL)
    expect(lease.url.startsWith('blob:')).toBe(true)
    expect(__leaseMapSize()).toBe(1)
    expect(resolveAssetUrlMock).toHaveBeenCalledTimes(2)

    lease.release()
    expect(__leaseMapSize()).toBe(0)
  })

  it('concurrent acquire on a rejecting in-flight: reject surfaces + entry deleted + next acquire re-resolves', async () => {
    // Fire two overlapping acquires so #2 dedups on #1's in-flight (rejected) promise.
    const p1 = acquireAssetUrl(ASSET_FAIL)
    const p2 = acquireAssetUrl(ASSET_FAIL)
    await expect(p1).rejects.toThrow(rejectionError)
    await expect(p2).rejects.toThrow(rejectionError)

    // The poisoned entry must have been dropped by the catch path.
    expect(__leaseMapSize()).toBe(0)
    // Both acquire paths hit the rejection; each logs a warn on cleanup.
    expect(debugWarn).toHaveBeenCalledTimes(2)
    expect(debugWarn).toHaveBeenCalledWith(
      'Asset Lease',
      expect.stringContaining(`asset resolution rejected for ${ASSET_FAIL}`),
    )

    // Next acquire re-resolves instead of hitting the rejected in-flight.
    const lease = await acquireAssetUrl(ASSET_FAIL)
    expect(lease.url.startsWith('blob:')).toBe(true)
    lease.release()
    expect(__leaseMapSize()).toBe(0)
  })
})
