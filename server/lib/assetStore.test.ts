import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import {
  ASSET_GRACE_PERIOD_MS,
  ASSET_TMP_ORPHAN_AGE_MS,
  computeContentHash,
  createAssetStore,
  createFsAssetBackend,
  createMemoryAssetBackend,
  isPurgeEligible,
  graceRemainingMs,
  InvalidAssetIdError,
  type AssetRecord,
  type AssetStoreBackend,
} from './assetStore'

const pngBytes = (marker: string): Buffer => {
  // Minimal PNG signature + marker so each is a distinct, real-image-sniffable blob.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, Buffer.from(marker, 'utf8')])
}

const OWNER_A = 'fp_aaaaaaaaaaaaaaaa'
const OWNER_B = 'fp_bbbbbbbbbbbbbbbb'
const OWNER_C = 'fp_cccccccccccccccc'

describe('assetStore — upload (ensureBytes only, no auto +1)', () => {
  it('same bytes → same assetId, bytes stored once, refcount=0 (no attach in T1.5)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('hello')

    const r1 = await store.upload(bytes, 'image/png', 'a.png', OWNER_A, 1000)
    const r2 = await store.upload(bytes, 'image/png', 'b.png', OWNER_B, 2000)

    expect(r1.assetId).toBe(r2.assetId)
    expect(r1.deduped).toBe(false)
    expect(r2.deduped).toBe(true) // bytes reused
    expect(r1.refcount).toBe(0) // upload does NOT attach (P1.2)
    expect(r2.refcount).toBe(0)
    expect(be._bytes.size).toBe(1) // dedup: single physical copy
    expect(computeContentHash(bytes)).toBe(r1.assetId)
    expect(r1.assetId).toHaveLength(64) // full sha256 hex
  })

  it('different bytes → different assetId, refcount=0 each, two copies', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const r1 = await store.upload(pngBytes('one'), 'image/png', 'a.png', OWNER_A, 1000)
    const r2 = await store.upload(pngBytes('two'), 'image/png', 'b.png', OWNER_A, 2000)
    expect(r1.assetId).not.toBe(r2.assetId)
    expect(r1.refcount).toBe(0)
    expect(r2.refcount).toBe(0)
    expect(be._bytes.size).toBe(2)
  })

  it('ownerFp 归属打标: first uploader stamped; dedup re-upload preserves first owner', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('shared')
    await store.upload(bytes, 'image/png', 'a.png', OWNER_A, 1000)
    await store.upload(bytes, 'image/png', 'b.png', OWNER_B, 2000) // dedup
    const rec = await store.getRecord(computeContentHash(bytes))
    expect(rec?.ownerFp).toBe(OWNER_A) // first uploader preserved (owner 不丢)
    expect(rec?.references).toEqual([]) // no attach yet
    expect(rec?.lastRefZeroAt).toBe(1000) // 0 refs from creation → grace-stamped
  })
})

describe('assetStore — attach / detach (idempotent reference table, P1.2)', () => {
  it('attach raises refcount + clears grace window', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('x')
    const { assetId } = await store.upload(bytes, 'image/png', 'x.png', OWNER_A, 1000)
    expect(await store.refcount(assetId)).toBe(0)
    const res = await store.attach(assetId, 'node-1', OWNER_A, 2000)
    expect(res).toEqual({ kind: 'attached' })
    const rec = await store.getRecord(assetId)
    expect(rec?.references).toEqual([{ nodeId: 'node-1', ownerFp: OWNER_A }])
    expect(rec?.lastRefZeroAt).toBeNull() // cleared
    expect(await store.refcount(assetId)).toBe(1)
  })

  it('duplicate attach is idempotent (no double-count) — archive restore does not drift', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('x')
    const { assetId } = await store.upload(bytes, 'image/png', 'x.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_A, 2000)
    const dup = await store.attach(assetId, 'node-1', OWNER_A, 3000) // re-attach (restore)
    expect(dup).toEqual({ kind: 'already-attached' })
    expect(await store.refcount(assetId)).toBe(1) // no drift
  })

  it('multi-node shared asset: distinct nodeIds → refcount = N', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('shared')
    const { assetId } = await store.upload(bytes, 'image/png', 's.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_A, 2000)
    await store.attach(assetId, 'node-2', OWNER_A, 3000)
    await store.attach(assetId, 'node-3', OWNER_B, 4000) // cross-owner reference
    expect(await store.refcount(assetId)).toBe(3)
    const rec = await store.getRecord(assetId)
    expect(rec?.references.map((r) => r.nodeId).sort()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  it('detach 2→1 keeps asset alive; detach 1→0 stamps grace', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('x')
    const { assetId } = await store.upload(bytes, 'image/png', 'x.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_A, 2000)
    await store.attach(assetId, 'node-2', OWNER_A, 3000)
    await store.detach(assetId, 'node-1', OWNER_A, 5000) // 2→1
    expect(await store.refcount(assetId)).toBe(1)
    expect((await store.getRecord(assetId))?.lastRefZeroAt).toBeNull()
    await store.detach(assetId, 'node-2', OWNER_A, 6000) // 1→0
    const rec = await store.getRecord(assetId)
    expect(rec?.references).toEqual([])
    expect(rec?.lastRefZeroAt).toBe(6000)
  })

  it('duplicate detach is idempotent (0→0 preserves grace start)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('x')
    const { assetId } = await store.upload(bytes, 'image/png', 'x.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_A, 2000)
    await store.detach(assetId, 'node-1', OWNER_A, 5000) // 1→0
    const again = await store.detach(assetId, 'node-1', OWNER_A, 6000) // idempotent
    expect(again).toEqual({ kind: 'already-detached' })
    const rec = await store.getRecord(assetId)
    expect(rec?.lastRefZeroAt).toBe(5000) // preserved, not reset
  })

  it('cross-owner illegal detach → owner-mismatch (decidable, not silent)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('shared')
    const { assetId } = await store.upload(bytes, 'image/png', 's.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_A, 2000)
    const res = await store.detach(assetId, 'node-1', OWNER_B, 3000) // B detaches A's ref
    expect(res).toEqual({ kind: 'owner-mismatch' })
    expect(await store.refcount(assetId)).toBe(1) // untouched
  })

  it('attach/detach on missing assetId → missing (decidable, not silent)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    expect(await store.attach('0'.repeat(64), 'node-1', OWNER_A, 1000)).toEqual({ kind: 'missing' })
    expect(await store.detach('0'.repeat(64), 'node-1', OWNER_A, 1000)).toEqual({ kind: 'missing' })
  })

  it('refcount resurrects: 0 (in grace) → attach clears grace window', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('x')
    const { assetId } = await store.upload(bytes, 'image/png', 'x.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_A, 2000)
    await store.detach(assetId, 'node-1', OWNER_A, 5000) // 1→0, grace at 5000
    await store.attach(assetId, 'node-1', OWNER_A, 8000) // undo / restore resurrects
    const rec = await store.getRecord(assetId)
    expect(rec?.references).toHaveLength(1)
    expect(rec?.lastRefZeroAt).toBeNull() // grace cancelled
  })
})

describe('assetStore — purge judgment (pure)', () => {
  const base = (over: Partial<AssetRecord>): AssetRecord => ({
    contentHash: 'a'.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 100,
    originalName: 'a.png',
    ownerFp: OWNER_A,
    references: [],
    createdAt: 1000,
    lastRefZeroAt: null,
    ...over,
  })

  it('references > 0 → never eligible', () => {
    expect(isPurgeEligible(base({ references: [{ nodeId: 'n', ownerFp: OWNER_A }], lastRefZeroAt: null }), 9_999_999)).toBe(false)
    expect(isPurgeEligible(base({ references: [{ nodeId: 'n', ownerFp: OWNER_A }], lastRefZeroAt: 0 }), 9_999_999)).toBe(false)
  })

  it('refcount==0 + within grace → not eligible', () => {
    expect(isPurgeEligible(base({ lastRefZeroAt: 5000 }), 6000)).toBe(false)
    expect(isPurgeEligible(base({ lastRefZeroAt: 5000 }), 5000 + ASSET_GRACE_PERIOD_MS - 1)).toBe(false)
  })

  it('refcount==0 + grace expired → eligible', () => {
    expect(isPurgeEligible(base({ lastRefZeroAt: 5000 }), 5000 + ASSET_GRACE_PERIOD_MS)).toBe(true)
    expect(isPurgeEligible(base({ lastRefZeroAt: 5000 }), 5000 + ASSET_GRACE_PERIOD_MS + 9999)).toBe(true)
  })

  it('refcount==0 but lastRefZeroAt null → not eligible (defensive)', () => {
    expect(isPurgeEligible(base({ lastRefZeroAt: null }), 9_999_999)).toBe(false)
  })

  it('graceRemainingMs: Infinity while alive; finite in grace; negative when eligible', () => {
    expect(graceRemainingMs(base({ references: [{ nodeId: 'n', ownerFp: OWNER_A }] }), 1000)).toBe(Infinity)
    expect(graceRemainingMs(base({ lastRefZeroAt: 5000 }), 6000)).toBe(ASSET_GRACE_PERIOD_MS - 1000)
    expect(graceRemainingMs(base({ lastRefZeroAt: 5000 }), 5000 + ASSET_GRACE_PERIOD_MS)).toBe(0)
    expect(graceRemainingMs(base({ lastRefZeroAt: 5000 }), 5000 + ASSET_GRACE_PERIOD_MS + 5000)).toBe(-5000)
  })
})

describe('assetStore — runPurgeSweep + deleteIfStillEligible (P1.1 atomicity)', () => {
  it('purges only grace-expired refcount==0 records; leaves alive + in-grace', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const NOW = 100_000_000
    const alive = await store.upload(pngBytes('alive'), 'image/png', 'alive.png', OWNER_A, 1000)
    await store.attach(alive.assetId, 'n-alive', OWNER_A, 2000)
    const inGrace = await store.upload(pngBytes('grace'), 'image/png', 'grace.png', OWNER_A, 1000)
    await store.attach(inGrace.assetId, 'n-grace', OWNER_A, 2000)
    const expired = await store.upload(pngBytes('expired'), 'image/png', 'expired.png', OWNER_A, 1000)
    await store.attach(expired.assetId, 'n-exp', OWNER_A, 2000)
    await store.detach(inGrace.assetId, 'n-grace', OWNER_A, NOW - 1000) // recently → in grace
    await store.detach(expired.assetId, 'n-exp', OWNER_A, NOW - ASSET_GRACE_PERIOD_MS - 1000) // grace expired
    const result = await store.runPurgeSweep(NOW)
    expect(result.scanned).toBe(3)
    expect(result.purged).toBe(1)
    expect(await store.getRecord(alive.assetId)).not.toBeNull() // refcount 1, kept
    expect(await store.getRecord(inGrace.assetId)).not.toBeNull() // in grace, kept
    expect(await store.getRecord(expired.assetId)).toBeNull() // grace expired, purged
    expect(be._bytes.has(expired.assetId)).toBe(false)
    expect(be._bytes.has(inGrace.assetId)).toBe(true)
  })

  it('sweep is a no-op when nothing is eligible', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const { assetId } = await store.upload(pngBytes('a'), 'image/png', 'a.png', OWNER_A, 1000)
    await store.attach(assetId, 'n', OWNER_A, 2000)
    const result = await store.runPurgeSweep(9_999_999)
    expect(result).toEqual({ scanned: 1, purged: 0 })
  })

  it('P1.1: a concurrent attach during sweep aborts that asset delete (resurrection)', async () => {
    // Memory backend is atomic per-hash (sync ops), so deleteIfStillEligible
    // re-checks under no interleaving. Emulate the resurrection race: make an
    // asset eligible, then attach BEFORE the sweep's deleteIfStillEligible call.
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const NOW = 100_000_000
    const { assetId } = await store.upload(pngBytes('x'), 'image/png', 'x.png', OWNER_A, 1000)
    await store.attach(assetId, 'n', OWNER_A, 2000)
    await store.detach(assetId, 'n', OWNER_A, NOW - ASSET_GRACE_PERIOD_MS - 1000) // grace expired
    // A concurrent attach resurrects BEFORE the sweep delete runs.
    await store.attach(assetId, 'n', OWNER_A, NOW - 1)
    const result = await store.runPurgeSweep(NOW)
    expect(result.purged).toBe(0) // sweep aborts: asset no longer eligible
    expect(await store.getRecord(assetId)).not.toBeNull()
    expect(be._bytes.has(assetId)).toBe(true)
  })
})

describe('assetStore — fs backend atomicity (P1.1)', () => {
  let root: string
  const tmpBackend = async (): Promise<AssetStoreBackend> => {
    root = await mkdtemp(join(tmpdir(), 'mivo-asset-store-'))
    return createFsAssetBackend(root)
  }

  it('concurrent same-hash uploads: bytes stored once, record once, first owner preserved', async () => {
    const be = await tmpBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('concurrent')
    // 8 concurrent uploads of the SAME bytes from 2 owners.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.upload(bytes, 'image/png', `f${i}.png`, i % 2 === 0 ? OWNER_A : OWNER_B, 1000 + i),
      ),
    )
    const assetId = results[0].assetId
    expect(results.every((r) => r.assetId === assetId)).toBe(true)
    expect(results.filter((r) => r.deduped)).toHaveLength(7) // 1 new, 7 dedup
    expect(results.every((r) => r.refcount === 0)).toBe(true) // upload doesn't attach
    const rec = await store.getRecord(assetId)
    expect(rec?.ownerFp).toBe(OWNER_A) // first uploader (owner 不丢)
    expect(rec?.references).toEqual([])
    // exactly one .bin + one .meta.json on disk
    const shard = join(root, assetId.slice(0, 2))
    const files = await fs.readdir(shard)
    expect(files.filter((f) => f.endsWith('.bin'))).toHaveLength(1)
    expect(files.filter((f) => f.endsWith('.meta.json'))).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  it('concurrent distinct-nodeId attaches: refcount == request count (no lost updates)', async () => {
    const be = await tmpBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('attaches')
    const { assetId } = await store.upload(bytes, 'image/png', 'a.png', OWNER_A, 1000)
    // 10 concurrent attaches of DISTINCT nodeIds — under the per-hash mutex each
    // lands; without atomicity some would be lost (read-modify-write race).
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.attach(assetId, `node-${i}`, OWNER_A, 2000 + i)))
    expect(await store.refcount(assetId)).toBe(10) // == request count, owner 不丢
    const rec = await store.getRecord(assetId)
    expect(rec?.references).toHaveLength(10)
    expect(rec?.lastRefZeroAt).toBeNull()
    await rm(root, { recursive: true, force: true })
  })

  it('listRecords on missing root returns [] (ENOENT tolerated)', async () => {
    const be = createFsAssetBackend(join(tmpdir(), 'mivo-nonexistent-asset-store-xyz'))
    expect(await be.listRecords()).toEqual([])
  })
})

describe('assetStore — path traversal guard (P2.6)', () => {
  const invalidIds = ['not-a-hash', '../etc/passwd', 'XYZ', '0'.repeat(63), 'g'.repeat(64), '']

  it('service-layer methods throw InvalidAssetIdError on a non-hex64 id', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    for (const id of invalidIds) {
      await expect(store.read(id)).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(store.attach(id, 'n', OWNER_A)).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(store.detach(id, 'n', OWNER_A)).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(store.getRecord(id)).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(store.refcount(id)).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(store.readForOwner(id, OWNER_A)).rejects.toBeInstanceOf(InvalidAssetIdError)
    }
  })

  it('fs backend rejects an invalid id with ZERO fs calls (spy on fs methods)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-pt-'))
    const be = createFsAssetBackend(root)
    // Spy on the fs operations the backend would use. assertValidAssetId throws
    // before any of them is reached, so none must be called.
    const spies = [
      vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'access'),
      vi.spyOn(fs, 'rename'),
      vi.spyOn(fs, 'unlink'),
      vi.spyOn(fs, 'mkdir'),
      vi.spyOn(fs, 'readdir'),
    ]
    try {
      await expect(be.getRecord('../etc/passwd')).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(be.ensureBytes('../etc/passwd', Buffer.from('x'))).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(be.getBytes('../etc/passwd')).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(
        be.ensureRecord({ contentHash: '../etc/passwd', mimeType: 'image/png', sizeBytes: 1, originalName: 'a', ownerFp: OWNER_A, createdAt: 1 }, 1),
      ).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(be.attachRef('../etc/passwd', { nodeId: 'n', ownerFp: OWNER_A })).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(be.detachRef('../etc/passwd', 'n', OWNER_A, 1)).rejects.toBeInstanceOf(InvalidAssetIdError)
      await expect(be.deleteIfStillEligible('../etc/passwd', 1)).rejects.toBeInstanceOf(InvalidAssetIdError)
      for (const s of spies) expect(s).not.toHaveBeenCalled()
    } finally {
      for (const s of spies) s.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('assetStore — integrity scrub + owner quota (P1.9 / P1.4)', () => {
  it('scrubAssetIntegrity: clean store → 0 mismatches; corrupted bytes → reported', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const good = pngBytes('good')
    const bad = pngBytes('bad')
    await store.upload(good, 'image/png', 'g.png', OWNER_A, 1000)
    const { assetId: badId } = await store.upload(bad, 'image/png', 'b.png', OWNER_A, 1000)
    // Corrupt the stored bytes for `bad` so sha256 no longer matches the id.
    be._bytes.set(badId, Buffer.from('totally-different-content'))
    const report = await store.scrubAssetIntegrity()
    expect(report.checked).toBe(2)
    expect(report.mismatches).toEqual([{ contentHash: badId, sizeBytes: 'totally-different-content'.length }])
  })

  it('read cheap size check (P1.9): a size mismatch → null (no sha256 recompute per request)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('sz')
    const { assetId } = await store.upload(bytes, 'image/png', 's.png', OWNER_A, 1000)
    expect(await store.read(assetId)).not.toBeNull()
    // Shrink the stored bytes → size mismatches record.sizeBytes → read refuses.
    be._bytes.set(assetId, bytes.subarray(0, 4))
    expect(await store.read(assetId)).toBeNull()
  })

  it('ownerBytes: sums sizeBytes for the first-uploader owner (quota accounting)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    await store.upload(pngBytes('a'), 'image/png', 'a.png', OWNER_A, 1000) // 13 bytes (8 sig + 1 marker)
    await store.upload(pngBytes('bb'), 'image/png', 'b.png', OWNER_A, 1000) // 14 bytes
    await store.upload(pngBytes('ccc'), 'image/png', 'c.png', OWNER_B, 1000) // 15 bytes, B's
    const aBytes = await store.ownerBytes(OWNER_A)
    const bBytes = await store.ownerBytes(OWNER_B)
    expect(aBytes).toBe(pngBytes('a').length + pngBytes('bb').length)
    expect(bBytes).toBe(pngBytes('ccc').length)
  })
})

describe('assetStore — readForOwner (P2.5 owner-scoped read)', () => {
  it('uploader can read; a different owner gets null (→ 404)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('owner-scoped')
    const { assetId } = await store.upload(bytes, 'image/png', 'o.png', OWNER_A, 1000)
    expect((await store.readForOwner(assetId, OWNER_A))?.bytes.equals(bytes)).toBe(true)
    expect(await store.readForOwner(assetId, OWNER_B)).toBeNull() // cross-owner → null
  })

  it('a referenced owner can read; an unreferenced owner gets null', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('refs')
    const { assetId } = await store.upload(bytes, 'image/png', 'r.png', OWNER_A, 1000)
    await store.attach(assetId, 'node-1', OWNER_B, 2000) // B holds a reference
    expect((await store.readForOwner(assetId, OWNER_B))?.bytes.equals(bytes)).toBe(true)
    expect(await store.readForOwner(assetId, OWNER_C)).toBeNull()
  })
})

describe('assetStore — upload atomicity (P1.1 single-primitive fs barrier)', () => {
  // Real fs barrier: the single uploadIfAbsent primitive holds ONE per-hash lock
  // across bytes+record writes, so a concurrent sweep (same lock) can never delete
  // bytes between the two writes (the old two-stage ensureBytes→ensureRecord race
  // that left "metadata present, bytes gone").
  it('concurrent upload + sweep never leaves metadata-without-bytes (real fs)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-p11-'))
    try {
      const be = createFsAssetBackend(root)
      const store = createAssetStore(be)
      const bytes = pngBytes('barrier')
      const hash = computeContentHash(bytes)
      const NOW = 100_000_000
      // Seed an asset that is ELIGIBLE for purge (refcount 0, grace expired) — the
      // exact state where a sweep could delete bytes+record mid-upload in the old design.
      const { assetId } = await store.upload(bytes, 'image/png', 'b.png', OWNER_A, 1000)
      await store.attach(assetId, 'n', OWNER_A, 2000)
      await store.detach(assetId, 'n', OWNER_A, NOW - ASSET_GRACE_PERIOD_MS - 5000)
      expect(assetId).toBe(hash)

      // Hammer: concurrent dedup uploads + sweeps. After each iteration the invariant
      // record ⇔ bytes MUST hold (never one without the other).
      for (let i = 0; i < 25; i++) {
        await Promise.allSettled([
          store.upload(bytes, 'image/png', 'b.png', OWNER_A, NOW + i),
          store.runPurgeSweep(NOW + i),
        ])
        const record = await store.getRecord(hash)
        const onDiskBytes = await fs.readFile(join(root, hash.slice(0, 2), `${hash}.bin`)).catch(() => null)
        expect(Boolean(record)).toBe(onDiskBytes !== null) // no metadata-without-bytes
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uploadIfAbsent registers the uploader + asserts bytes+record co-exist on return', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('single')
    const { assetId, deduped } = await store.upload(bytes, 'image/png', 's.png', OWNER_A, 1000)
    expect(deduped).toBe(false)
    const rec = await store.getRecord(assetId)
    // P2-E: uploaders live in the dedicated structure, not on the record.
    expect(await be.listUploaders(assetId)).toEqual([OWNER_A])
    // bytes + record both present (post-condition of the single primitive).
    expect(await be.getBytes(assetId)).not.toBeNull()
    expect(rec).not.toBeNull()
  })
})

describe('assetStore — uploadWithQuota atomicity (P1.3)', () => {
  it('concurrent same-owner NEW uploads: one ok, one quota-exceeded; final used <= quota', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const a = pngBytes('aaaaa') // distinct hash from b (new bytes)
    const b = pngBytes('bbbbb')
    // QUOTA sized so exactly ONE fits: first upload (used 0 → SIZE) is ok, second
    // (used SIZE → 2*SIZE) trips. Dynamically sized so it tracks the fixture.
    const QUOTA = a.length + 1
    expect(a.length).toBe(b.length)
    // The per-owner lock serializes: first acquires → used 0 → fits → upload (used SIZE);
    // second → used SIZE → SIZE+SIZE > QUOTA → no existing record (different hash) → 413.
    const outcomes = await Promise.all([
      store.uploadWithQuota(a, 'image/png', 'a.png', OWNER_A, QUOTA, 1000),
      store.uploadWithQuota(b, 'image/png', 'b.png', OWNER_A, QUOTA, 2000),
    ])
    expect(outcomes.filter((o) => o.kind === 'ok')).toHaveLength(1)
    expect(outcomes.filter((o) => o.kind === 'quota-exceeded')).toHaveLength(1)
    expect(await store.ownerBytes(OWNER_A)).toBeLessThanOrEqual(QUOTA)
    expect(be._records.size).toBe(1) // only the winner was stored
  })

  it('dedup (existing record) charges 0 new bytes — never trips quota', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('dedup-quota')
    const QUOTA = bytes.length // fill the quota exactly on the first upload
    const first = await store.uploadWithQuota(bytes, 'image/png', 'a.png', OWNER_A, QUOTA, 1000)
    expect(first.kind).toBe('ok')
    // Re-uploading the SAME bytes (dedup) adds 0 new bytes. used(==QUOTA) +
    // bytes.length > QUOTA would naive-reject, but the dedup path sees the existing
    // record and lets it through — a re-upload must never strand on quota.
    const second = await store.uploadWithQuota(bytes, 'image/png', 'a.png', OWNER_A, QUOTA, 2000)
    expect(second.kind).toBe('ok')
    expect(await store.ownerBytes(OWNER_A)).toBe(QUOTA) // unchanged — 0 new bytes
  })

  it('a NEW over-quota upload is refused BEFORE any bytes are written', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const QUOTA = 5 // any png (38 bytes) exceeds
    const bytes = pngBytes('refuse')
    const outcome = await store.uploadWithQuota(bytes, 'image/png', 'r.png', OWNER_A, QUOTA, 1000)
    expect(outcome.kind).toBe('quota-exceeded')
    expect(be._bytes.size).toBe(0) // nothing stored
    expect(be._records.size).toBe(0)
  })
})

describe('assetStore — dedup uploader entitlement (P1.5)', () => {
  it('a dedup uploader can GET their upload (ownerFp is the first uploader, not them)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('shared')
    const hash = computeContentHash(bytes)
    // A uploads (first → ownerFp = A), B uploads same bytes (dedup → ownerFp stays A).
    await store.upload(bytes, 'image/png', 'a.png', OWNER_A, 1000)
    await store.upload(bytes, 'image/png', 'b.png', OWNER_B, 2000)
    const rec = await store.getRecord(hash)
    expect(rec?.ownerFp).toBe(OWNER_A) // first uploader preserved (quota attribution)
    // P2-E: uploaders live in the dedicated structure, not on the record.
    expect(await be.listUploaders(hash)).toContain(OWNER_A)
    expect(await be.listUploaders(hash)).toContain(OWNER_B) // B registered as a dedup uploader
    // B is entitled to GET even though ownerFp is A and B holds no live reference.
    const hit = await store.readForOwner(hash, OWNER_B)
    expect(hit).not.toBeNull()
    expect(hit?.bytes.equals(bytes)).toBe(true)
  })

  it('idempotent re-upload by the same uploader does not duplicate the uploaders entry', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('idempotent')
    const hash = computeContentHash(bytes)
    await store.upload(bytes, 'image/png', 'a.png', OWNER_A, 1000)
    await store.upload(bytes, 'image/png', 'a2.png', OWNER_A, 2000) // same owner, dedup
    expect(await be.listUploaders(hash)).toEqual([OWNER_A]) // no duplicate entry
  })
})

describe('assetStore — writeAtomic tmp cleanup + orphan sweep (P2.6)', () => {
  it('a failed rename does not leave a stale .tmp-* (best-effort unlink + rethrow)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-p26-'))
    try {
      const be = createFsAssetBackend(root)
      const store = createAssetStore(be)
      const bytes = pngBytes('fail')
      // Force writeAtomic's rename to throw once. The catch must unlink the tmp and
      // rethrow — no orphan .tmp-* left behind.
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename EBUSY'))
      await expect(store.upload(bytes, 'image/png', 'f.png', OWNER_A, 1000)).rejects.toThrow('rename EBUSY')
      renameSpy.mockRestore()
      const shards = await fs.readdir(root)
      for (const shard of shards) {
        const files = await fs.readdir(join(root, shard))
        expect(files.filter((f) => f.includes('.tmp-'))).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleanOrphanTemps reaps old tmps but leaves a fresh in-progress tmp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-tmp-'))
    try {
      const be = createFsAssetBackend(root)
      const shardDir = join(root, 'ab')
      await fs.mkdir(shardDir, { recursive: true })
      // OLD orphan tmp (mtime past the threshold) → reaped.
      const oldTmp = join(shardDir, `${'a'.repeat(64)}.bin.tmp-999-old`)
      await fs.writeFile(oldTmp, Buffer.from('stale'))
      const pastTime = (Date.now() / 1000) - (ASSET_TMP_ORPHAN_AGE_MS / 1000) - 60 // 1 min past threshold
      await fs.utimes(oldTmp, pastTime, pastTime)
      // FRESH tmp (current mtime) → left alone (a write in progress).
      const freshTmp = join(shardDir, `${'b'.repeat(64)}.bin.tmp-1-fresh`)
      await fs.writeFile(freshTmp, Buffer.from('writing'))
      const cleaned = await be.cleanOrphanTemps(Date.now())
      expect(cleaned).toBe(1)
      await expect(fs.access(oldTmp)).rejects.toBeDefined() // reaped
      await expect(fs.access(freshTmp)).resolves.toBeUndefined() // left
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runPurgeSweep reaps orphan tmps as a side effect (no tmp → 0 cleaned, return shape unchanged)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const { assetId } = await store.upload(pngBytes('a'), 'image/png', 'a.png', OWNER_A, 1000)
    await store.attach(assetId, 'n', OWNER_A, 2000)
    const result = await store.runPurgeSweep(9_999_999)
    expect(result).toEqual({ scanned: 1, purged: 0 }) // closed contract unchanged
  })
})

// P1-B: purge order. deleteIfStillEligible makes metadata invisible FIRST (rename to
// a .tmp-tombstone), THEN deletes bytes. A failure between the two can only leave
// "orphan bytes, no record" — never "record present, bytes gone".
describe('assetStore — purge order (P1-B tombstone)', () => {
  it('a failed tombstone cleanup (EIO on unlink) leaves record invisible + attach→missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-p1b-'))
    try {
      const be = createFsAssetBackend(root)
      const store = createAssetStore(be)
      const bytes = pngBytes('p1b')
      const hash = computeContentHash(bytes)
      const NOW = 100_000_000
      const { assetId } = await store.upload(bytes, 'image/png', 'b.png', OWNER_A, 1000)
      await store.attach(assetId, 'n', OWNER_A, 2000)
      await store.detach(assetId, 'n', OWNER_A, NOW - ASSET_GRACE_PERIOD_MS - 5000)
      expect(assetId).toBe(hash)

      // P1-B: the meta rename (→ tombstone) makes the record invisible BEFORE the
      // bytes/uploaders/tombstone unlinks. Inject EIO on EVERY post-rename unlink so
      // all cleanups fail — the record must STILL be invisible (rename already hid it),
      // and the delete returns deleted:true (best-effort cleanups are swallowed).
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async () => {
        const err: NodeJS.ErrnoException = new Error('EIO')
        err.code = 'EIO'
        throw err
      })
      let res: { deleted: boolean; reason: string }
      try {
        res = await be.deleteIfStillEligible(hash, NOW)
      } finally {
        unlinkSpy.mockRestore()
      }
      expect(res.deleted).toBe(true)

      // Record invisible: readRecordUnlocked reads *.meta.json (the rename hid it).
      expect(await store.getRecord(hash)).toBeNull()
      // A concurrent attach sees no record → missing (decidable, not silent).
      expect(await store.attach(hash, 'n-resurrect', OWNER_A, NOW + 1)).toEqual({ kind: 'missing' })
      // Orphan bytes may linger (cleanup failed) — a re-upload overwrites them +
      // recreates the record (the invariant recovers; spy is restored).
      const re = await store.upload(bytes, 'image/png', 'b2.png', OWNER_A, NOW + 2)
      expect(re.assetId).toBe(hash)
      expect(await store.getRecord(hash)).not.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('memory backend deletes record FIRST then bytes (same invariant: never record-no-bytes)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const NOW = 100_000_000
    const { assetId } = await store.upload(pngBytes('mem-p1b'), 'image/png', 'a.png', OWNER_A, 1000)
    await store.attach(assetId, 'n', OWNER_A, 2000)
    await store.detach(assetId, 'n', OWNER_A, NOW - ASSET_GRACE_PERIOD_MS - 1000)
    const res = await be.deleteIfStillEligible(assetId, NOW)
    expect(res).toEqual({ deleted: true, reason: 'eligible' })
    expect(await store.getRecord(assetId)).toBeNull()
    expect(be._bytes.has(assetId)).toBe(false) // bytes also gone
    expect(be._uploaders.has(assetId)).toBe(false) // uploaders also gone
  })
})

// P2-C: quota + hash-locked admission. owner lock computes used; a single hash-locked
// admitUpload primitive does dedup/quota/register atomically. The race: B is at quota,
// A first-uploads the SAME bytes concurrently → B must still be registered (not 413'd)
// and B GET → 200.
describe('assetStore — quota + hash-locked admission (P2-C)', () => {
  it('B at quota + A first-uploads same bytes (race) → B registered + B GET 200', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const bytes = pngBytes('p2c-shared')
    const hash = computeContentHash(bytes)
    // Fill B's quota exactly with a DISTINCT asset so B is at quota.
    const filler = pngBytes('p2c-filler') // distinct hash
    const QUOTA = filler.length + bytes.length // filler fills it; B's share-out = filler
    await store.uploadWithQuota(filler, 'image/png', 'f.png', OWNER_B, QUOTA, 1000)
    expect(await store.ownerBytes(OWNER_B)).toBe(filler.length) // B at quota (room for 0 new)

    // Concurrent: A (owner 0 used) first-uploads `bytes`; B (at quota) uploads same
    // `bytes`. Whichever wins the hash lock writes the record; the other sees it
    // exists → dedup → registered (0 new bytes, never trips quota).
    const [aOut, bOut] = await Promise.all([
      store.uploadWithQuota(bytes, 'image/png', 'a.png', OWNER_A, QUOTA, 2000),
      store.uploadWithQuota(bytes, 'image/png', 'b.png', OWNER_B, QUOTA, 3000),
    ])
    expect(aOut.kind).toBe('ok')
    expect(bOut.kind).toBe('ok') // NOT quota-exceeded — dedup registered B
    if (bOut.kind !== 'ok') return
    expect(bOut.result.assetId).toBe(hash)
    expect(bOut.result.deduped).toBe(true) // B is the dedup uploader
    // B is registered as a dedup uploader → readForOwner(B) entitled → 200.
    expect(await be.isUploader(hash, OWNER_B)).toBe(true)
    expect((await store.readForOwner(hash, OWNER_B))?.bytes.equals(bytes)).toBe(true)
    // ownerFp stays the first uploader (A here, since A had room) — quota attribution intact.
    expect((await store.getRecord(hash))?.ownerFp).toBe(OWNER_A)
  })

  it('admitUpload refuses a NEW over-quota upload BEFORE any bytes are written', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const QUOTA = 5
    const bytes = pngBytes('p2c-refuse')
    const outcome = await store.uploadWithQuota(bytes, 'image/png', 'r.png', OWNER_A, QUOTA, 1000)
    expect(outcome.kind).toBe('quota-exceeded')
    expect(be._bytes.size).toBe(0)
    expect(be._records.size).toBe(0)
  })

  it('concurrent same-owner NEW uploads → one ok, one quota-exceeded; final used <= quota', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const a = pngBytes('p2c-aaaaa')
    const b = pngBytes('p2c-bbbbb')
    const QUOTA = a.length + 1
    const outcomes = await Promise.all([
      store.uploadWithQuota(a, 'image/png', 'a.png', OWNER_A, QUOTA, 1000),
      store.uploadWithQuota(b, 'image/png', 'b.png', OWNER_A, QUOTA, 2000),
    ])
    expect(outcomes.filter((o) => o.kind === 'ok')).toHaveLength(1)
    expect(outcomes.filter((o) => o.kind === 'quota-exceeded')).toHaveLength(1)
    expect(await store.ownerBytes(OWNER_A)).toBeLessThanOrEqual(QUOTA)
    expect(be._records.size).toBe(1)
  })
})

// P2-D: cleanOrphanTemps skips tmps an in-progress writeAtomic is holding, so a writer
// blocked longer than the orphan age threshold is NOT mistaken for a crash.
describe('assetStore — cleanOrphanTemps active tmp skip (P2-D)', () => {
  it('an in-progress writeAtomic tmp (blocked rename) is not reaped even past the age threshold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-p2d-'))
    try {
      const be = createFsAssetBackend(root)
      const store = createAssetStore(be)
      const bytes = pngBytes('p2d-block')
      const hash = computeContentHash(bytes)
      const shard = join(root, hash.slice(0, 2))

      // Block writeAtomic's rename so the tmp lingers in activeTmps, then let the
      // REAL rename through (so writeAtomic completes after release — fs.access(bp)
      // post-condition must find the renamed bin).
      let resolveRename: () => void
      const renameBlock = new Promise<void>((r) => {
        resolveRename = r
      })
      const realRename = fs.rename.bind(fs)
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
        await renameBlock // block until the test releases
        return realRename(oldPath as never, newPath as never) as never
      })

      const uploadP = store.upload(bytes, 'image/png', 'b.png', OWNER_A, 1000)
      // Wait for the tmp to appear on disk (writeFile done, rename blocked).
      await vi.waitFor(async () => {
        const files = await fs.readdir(shard)
        expect(files.some((f) => f.includes('.tmp-'))).toBe(true)
      })

      // Make the tmp "old" (past the threshold) to prove the skip is by active-set
      // membership, not by age.
      const files = await fs.readdir(shard)
      const tmpName = files.find((f) => f.includes('.tmp-'))!
      const tmpPath = join(shard, tmpName)
      const pastTime = Date.now() / 1000 - ASSET_TMP_ORPHAN_AGE_MS / 1000 - 60
      await fs.utimes(tmpPath, pastTime, pastTime)

      const cleaned = await be.cleanOrphanTemps(Date.now())
      expect(cleaned).toBe(0) // active tmp NOT reaped
      await expect(fs.access(tmpPath)).resolves.toBeUndefined() // still there

      // Release the blocked rename — writeAtomic finishes, tmp renamed away.
      resolveRename!()
      await uploadP
      renameSpy.mockRestore()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// P2-F: over-quota slow path. An over-quota NEW upload first purges THIS owner's
// grace-expired refcount==0 assets, recomputes used, then refuses only if still over.
describe('assetStore — quota eviction slow path (P2-F)', () => {
  it('over-quota upload first purges owner eligible assets, then succeeds if room freed', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const NOW = 100_000_000
    // A stale asset owned by OWNER_A: refcount 0, grace expired → eligible for purge.
    const stale = pngBytes('p2f-stale')
    const QUOTA = stale.length // the stale asset fills the quota exactly
    const { assetId: staleId } = await store.upload(stale, 'image/png', 's.png', OWNER_A, 1000)
    // (no attach → refcount 0; grace-stamp at creation)
    await store.attach(staleId, 'n', OWNER_A, 2000)
    await store.detach(staleId, 'n', OWNER_A, NOW - ASSET_GRACE_PERIOD_MS - 1000) // grace expired
    expect(await store.ownerBytes(OWNER_A)).toBe(stale.length) // at quota

    // A NEW upload (different bytes) would exceed quota — the slow path purges the
    // stale asset first, freeing room, then the NEW upload succeeds.
    const fresh = pngBytes('p2f-fresh')
    expect(fresh.length).toBe(stale.length) // same size — only fits if stale is purged
    const out = await store.uploadWithQuota(fresh, 'image/png', 'f.png', OWNER_A, QUOTA, NOW)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    // The stale asset was purged (room freed); the fresh asset is stored.
    expect(await store.getRecord(staleId)).toBeNull()
    expect(await store.getRecord(out.result.assetId)).not.toBeNull()
    expect(await store.ownerBytes(OWNER_A)).toBeLessThanOrEqual(QUOTA)
  })

  it('over-quota upload with nothing eligible to purge → quota-exceeded (no bytes written)', async () => {
    const be = createMemoryAssetBackend()
    const store = createAssetStore(be)
    const QUOTA = 5
    const bytes = pngBytes('p2f-refuse')
    const out = await store.uploadWithQuota(bytes, 'image/png', 'r.png', OWNER_A, QUOTA, 1000)
    expect(out.kind).toBe('quota-exceeded')
    expect(be._bytes.size).toBe(0)
    expect(be._records.size).toBe(0)
  })
})

// P3-G: writeAtomic cleanup preserves the original write/rename error; a cleanup
// failure attaches as `cause` but does not mask it.
describe('assetStore — writeAtomic cause chain (P3-G)', () => {
  it('rename fails + cleanup unlink fails → thrown error is the original rename error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mivo-asset-p3g-'))
    try {
      const be = createFsAssetBackend(root)
      const store = createAssetStore(be)
      const bytes = pngBytes('p3g')
      // rename throws EBUSY; the cleanup unlink throws EIO. The thrown error must be
      // the rename EBUSY (the original), not the cleanup EIO.
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename EBUSY'))
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('cleanup EIO'))
      let thrown: unknown
      try {
        await store.upload(bytes, 'image/png', 'f.png', OWNER_A, 1000)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('rename EBUSY') // original, not cleanup EIO
      // cleanup was attempted (cause attached).
      expect(unlinkSpy).toHaveBeenCalled()
      unlinkSpy.mockRestore()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
