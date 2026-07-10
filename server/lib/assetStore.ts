// server/lib/assetStore.ts
// T1.5 content-addressed asset store. assetId = sha256(bytes) full hex (64) —
// content-addressed: identical bytes → identical id → shared storage (dedup).
//
// Refcount model (P1.2 — reference table, NOT a stored counter):
// - The asset record holds a REFERENCE TABLE: references = [{ nodeId, ownerFp }].
//   refcount is DERIVED = references.length. There is no counter to drift.
// - upload() is a single uploadIfAbsent primitive (P1.1): bytes + record + uploader
//   registration under ONE per-hash lock. It does NOT attach a reference, does NOT
//   auto +1. Liveness comes from attach() — wired to the node lifecycle in T1.3.
//   Until T1.3 wires it, a freshly uploaded asset sits at refcount 0 and enters the
//   7-day grace window; that is the accepted T1.5 灰度 limitation (default gate is
//   local IDB; server mode is opt-in for testing).
// - attach(assetId, nodeId, ownerFp) is IDEMPOTENT: a duplicate (same nodeId) is
//   a no-op, so archive restore re-importing the same node does NOT inflate
//   refcount (no drift — the P1.2 fix).
// - detach(assetId, nodeId, ownerFp) is idempotent AND owner-checked: a cross-owner
//   detach returns { kind: 'owner-mismatch' } (decidable, not silent). A missing
//   asset returns { kind: 'missing' } (decidable).
//
// Uploader entitlement (P1.5): record.uploaders is the SET of owners who have
// successfully POSTed these bytes (idempotent on dedup). readForOwner serves the
// uploader OR any owner holding a live reference. A dedup uploader can always GET
// their own upload even though ownerFp (first uploader, used for quota) is someone
// else — content-addressed dedup must not strand the second uploader's read access.
//
// Grace + purge (docs/decisions/soft-delete-semantics.md §4):
// - refcount == 0 → stamp lastRefZeroAt (grace start). 7-day window covers single-
//   node undo + canvas restore. If refcount rises during grace → cancel delete.
// - Grace expired + still 0 → physically delete bytes + record (irreversible).
//
// Atomicity (P1.1): the backend contract is per-hash atomic primitives (no
// read-modify-write across the public boundary). The fs impl serializes per-hash
// ops with an in-process mutex and publishes bytes + metadata via temp-write +
// atomic rename (a crash mid-write never leaves a partial file). deleteIfStill-
// Eligible re-checks eligibility UNDER the lock, so a concurrent attach that
// resurrects the asset causes the sweep to abort the delete.
//
// Path traversal (P2.6): every public AssetStore method AND every fs backend
// method validates lowercase sha256 hex64 and throws InvalidAssetIdError — a
// non-hash id never reaches fs (assertion: zero fs calls on an invalid id).
//
// Integrity (P1.9): GET does NOT recompute sha256 per request. sha256 is verified
// once at write time (contentHash IS the hash of the bytes); the read path does a
// cheap size check (bytes.length === record.sizeBytes). scrubAssetIntegrity() is an
// offline callable that recomputes sha256 for every record and reports mismatches.
//
// Storage backend is swappable via AssetStoreBackend. The fs impl is the dev /
// pre-PG backend. T1.1 lands PG → swap createFsAssetBackend for a PG backend; the
// AssetStore service layer (reference logic) stays identical.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import os from 'node:os'

/** Grace period before a refcount==0 asset's bytes are physically deleted. */
export const ASSET_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** sha256 full hex (64 lowercase). Asset ids are validated against this everywhere. */
export const ASSET_ID_RE = /^[0-9a-f]{64}$/

/** Typed error for an asset id that isn't lowercase sha256 hex64 (P2.6). */
export class InvalidAssetIdError extends Error {
  readonly assetId: string
  constructor(assetId: string) {
    super(`Invalid asset id (expected lowercase sha256 hex64): ${assetId}`)
    this.name = 'InvalidAssetIdError'
    this.assetId = assetId
  }
}

/** A single reference keeping an asset alive. refcount = count of these. */
export type AssetReference = { nodeId: string; ownerFp: string }

export type AssetRecord = {
  /** content-addressed id = sha256(bytes) hex. */
  contentHash: string
  mimeType: string
  sizeBytes: number
  originalName: string
  /** First uploader's ownerFp (FX-2 fingerprintOfPlatformKey) — 归属打标 + quota
   *  attribution (ownerBytes sums records whose ownerFp matches). metadata only. */
  ownerFp: string
  /** Uploader owner set (P1.5 — read entitlement). Every owner who has successfully
   *  POSTed these bytes is idempotently registered here, so a dedup uploader can GET
   *  their upload even though ownerFp (first uploader) is someone else. Initialized
   *  [ownerFp] on create; ownerFp is always uploaders[0]. */
  uploaders: string[]
  /** The reference table. refcount = references.length (derived, not a stored counter). */
  references: AssetReference[]
  createdAt: number
  /** Wall-clock ms when references last dropped to 0 (grace start). null while refs > 0.
   *  Stamped at creation too if created with 0 refs (uploaded, no attach yet). */
  lastRefZeroAt: number | null
}

/** Fields needed to create a fresh record (references/lastRefZeroAt are derived). */
export type AssetRecordInit = Pick<
  AssetRecord,
  'contentHash' | 'mimeType' | 'sizeBytes' | 'originalName' | 'ownerFp' | 'createdAt'
>

export type UploadedAsset = {
  assetId: string
  mimeType: string
  originalName: string
  sizeBytes: number
  /** true if the content hash already existed (bytes reused). */
  deduped: boolean
  /** Current reference count (= references.length at upload time). */
  refcount: number
}

/** Outcome of an atomic quota-reserved upload (P1.3). The check-then-upload is
 *  serialized per-owner under withOwnerLock so two concurrent uploads from the same
 *  owner can't both pass the gate. Dedup (existing record) adds 0 new bytes and must
 *  NOT trip the quota — a re-upload of already-stored bytes is always allowed. */
export type QuotaUploadOutcome =
  | { kind: 'ok'; result: UploadedAsset }
  | { kind: 'quota-exceeded'; used: number; quota: number; size: number }

export type AttachResult =
  | { kind: 'attached' } // new reference inserted
  | { kind: 'already-attached' } // idempotent: (assetId, nodeId) already present
  | { kind: 'missing' } // no record/bytes — attach refused (decidable, not silent)

export type DetachResult =
  | { kind: 'detached' } // reference removed
  | { kind: 'already-detached' } // idempotent: reference wasn't present
  | { kind: 'missing' } // no record
  | { kind: 'owner-mismatch' } // cross-owner illegal detach (decidable)

/**
 * Per-hash atomic backend contract (P1.1). Every method is atomic w.r.t. a single
 * contentHash: concurrent calls for the same hash serialize, and no intermediate
 * state is observable. The service layer never does read-modify-write across the
 * boundary — each mutating op is a single atomic primitive.
 */
export type AssetStoreBackend = {
  /** Atomic write-if-absent for bytes. Returns true if newly written. */
  ensureBytes(contentHash: string, bytes: Buffer): Promise<boolean>
  /** Atomic upload-if-absent (P1.1): write bytes (if absent) + ensure record (if
   *  absent) + idempotently register the uploader (P1.5), ALL under the SAME per-hash
   *  lock. Before returning, asserts bytes + record co-exist (no metadata-without-
   *  bytes — the sweep, which takes the same lock, can't delete bytes between the
   *  two writes as it could in the old two-stage ensureBytes→ensureRecord design). */
  uploadIfAbsent(
    bytes: Buffer,
    init: AssetRecordInit,
    now: number,
  ): Promise<{ record: AssetRecord; newlyWritten: boolean; newlyCreated: boolean }>
  getBytes(contentHash: string): Promise<Buffer | null>
  getRecord(contentHash: string): Promise<AssetRecord | null>
  /** Atomic: ensure a record exists (create with references=[] + uploaders=[ownerFp]
   *  + lastRefZeroAt=now if absent). Returns the record + newlyCreated. */
  ensureRecord(init: AssetRecordInit, now: number): Promise<{ record: AssetRecord; newlyCreated: boolean }>
  /** Atomic: attach (assetId, nodeId, ownerFp) if a record exists. Idempotent.
   *  Returns the resulting record (or null if no record) + newlyAttached. */
  attachRef(contentHash: string, ref: AssetReference): Promise<{ record: AssetRecord | null; newlyAttached: boolean }>
  /** Atomic: detach (assetId, nodeId) if ownerFp matches. Idempotent + owner-checked.
   *  Stamps lastRefZeroAt on the >0→0 transition. Returns the detach result + record. */
  detachRef(contentHash: string, nodeId: string, ownerFp: string, now: number): Promise<{ result: DetachResult; record: AssetRecord | null }>
  /** Atomic: re-check eligibility at `now` UNDER the lock; delete bytes+record if still
   *  eligible. Aborts if a concurrent op resurrected the asset. */
  deleteIfStillEligible(contentHash: string, now: number): Promise<{ deleted: boolean; reason: 'eligible' | 'not-eligible' | 'missing' }>
  listRecords(): Promise<AssetRecord[]>
  /** Sweep helper (P2.6): reap orphan `.tmp-*` files left by a crashed writeAtomic
   *  (rename/write threw before the tmp was cleaned). Only files older than the
   *  threshold are removed — a writeAtomic in progress holds a fresh tmp. Returns
   *  the count of temps unlinked. No-op for backends without a tmp layer. */
  cleanOrphanTemps(now: number): Promise<number>
}

// sha256 full hex — content-addressed id. Full 256-bit (unlike ownerFp's 16-hex
// sharding truncation, which is for a high-entropy routing key): here collisions
// mean data corruption, so full sha256 is the safe choice.
export const computeContentHash = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Throw on a non-hex64 id (P2.6 — public boundary guard). */
export const assertValidAssetId = (assetId: string): void => {
  if (!ASSET_ID_RE.test(assetId)) throw new InvalidAssetIdError(assetId)
}

/**
 * Resolve the fs asset-store root from env. Default: an OS app-data dir OUTSIDE
 * the repo (P1.4 — never write blobs into the tracked repo, so `git status` on a
 * dev worktree stays clean). MIVO_ASSET_STORE_DIR overrides for deployments that
 * want a specific persistent volume. .gitignore also pins data/assets as a
 * fallback for anyone who points it there.
 */
export const resolveAssetStoreDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env.MIVO_ASSET_STORE_DIR?.trim()
  if (configured) return configured
  const home = env.HOME || os.homedir()
  return path.join(home, '.mivo-canvas', 'assets')
}

// ─── fs backend ──────────────────────────────────────────────────────────────
// Layout: <root>/<hash[0:2]>/<hash>.bin + <root>/<hash[0:2]>/<hash>.meta.json
// 2-char sharding avoids a single flat dir of thousands of files.

const shardDir = (root: string, hash: string): string => path.join(root, hash.slice(0, 2))
const bytesPath = (root: string, hash: string): string => path.join(shardDir(root, hash), `${hash}.bin`)
const metaPath = (root: string, hash: string): string => path.join(shardDir(root, hash), `${hash}.meta.json`)

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true })
}

const ignoreMissing = async (p: string): Promise<void> => {
  try {
    await fs.unlink(p)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

// Per-hash in-process mutex (P1.1). Serializes mutating ops on the same hash so
// the read-modify-write on the meta JSON is race-free. Chained on the previous
// tail promise; the map entry is cleaned when the last op settles. Single BFF
// process — the PG backend (T1.1) must make these DB transactions instead.
const locks = new Map<string, Promise<void>>()
const withHashLock = <T>(hash: string, fn: () => Promise<T>): Promise<T> => {
  const prev = locks.get(hash) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  const swallowed = next.then(
    () => undefined,
    () => undefined,
  )
  locks.set(hash, swallowed)
  void swallowed.finally(() => {
    if (locks.get(hash) === swallowed) locks.delete(hash)
  })
  return next
}

// temp-write + atomic rename (P1.1). The temp suffix is process-stable + monotonic
// so concurrent temps for the same hash can't collide (the mutex serializes them
// anyway; this is defense in depth). rename() is atomic on POSIX → a crash
// mid-write never publishes a partial file.
//
// P2.6: if writeFile/rename throws, the tmp is best-effort unlinked before rethrow
// so a crashed write never leaves a stale .tmp-* (cleanOrphanTemps is the sweep
// backstop for the case where even this cleanup is skipped by a hard process crash).
let tempCounter = 0
const tempSuffix = (): string => `${process.pid}-${tempCounter++}`
const writeAtomic = async (finalPath: string, data: Buffer | string, encoding?: BufferEncoding): Promise<void> => {
  await ensureDir(path.dirname(finalPath))
  const tmp = `${finalPath}.tmp-${tempSuffix()}`
  try {
    if (encoding === undefined) await fs.writeFile(tmp, data as Buffer)
    else await fs.writeFile(tmp, data as string, encoding)
    await fs.rename(tmp, finalPath)
  } catch (error) {
    await ignoreMissing(tmp)
    throw error
  }
}

/** Orphan tmp age threshold (P2.6). A writeAtomic in progress holds a fresh tmp;
 *  any tmp older than this is from a crashed write and is reaped by cleanOrphanTemps. */
export const ASSET_TMP_ORPHAN_AGE_MS = 5 * 60 * 1000 // 5 min

/** True iff `name` is a writeAtomic tmp sibling (P2.6 sweep reap target). */
const isOrphanTmpName = (name: string): boolean => name.includes('.tmp-')

// Read a record without the lock (callers hold the lock already + have validated).
const readRecordUnlocked = async (root: string, contentHash: string): Promise<AssetRecord | null> => {
  try {
    const raw = await fs.readFile(metaPath(root, contentHash), 'utf8')
    return JSON.parse(raw) as AssetRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const createFsAssetBackend = (root: string): AssetStoreBackend => ({
  async ensureBytes(contentHash, bytes) {
    assertValidAssetId(contentHash)
    const p = bytesPath(root, contentHash)
    return withHashLock(contentHash, async () => {
      try {
        await fs.access(p)
        return false // already stored
      } catch {
        // not present — write below
      }
      await writeAtomic(p, bytes)
      return true
    })
  },

  async uploadIfAbsent(bytes, init, now) {
    assertValidAssetId(init.contentHash)
    return withHashLock(init.contentHash, async () => {
      const bp = bytesPath(root, init.contentHash)
      let newlyWritten = false
      try {
        await fs.access(bp)
      } catch {
        await writeAtomic(bp, bytes)
        newlyWritten = true
      }
      let record = await readRecordUnlocked(root, init.contentHash)
      let newlyCreated = false
      let dirty = false
      if (!record) {
        record = { ...init, references: [], uploaders: [init.ownerFp], lastRefZeroAt: now }
        newlyCreated = true
        dirty = true
      } else if (!record.uploaders?.includes(init.ownerFp)) {
        // P1.5: idempotently register this uploader for read entitlement (a dedup
        // uploader must be able to GET their own upload even though ownerFp — the
        // first uploader — is someone else). Seed with [ownerFp] if the set is
        // missing (pre-P1.5 record migrated on first dedup).
        record = { ...record, uploaders: [...(record.uploaders ?? [record.ownerFp]), init.ownerFp] }
        dirty = true
      }
      if (dirty) {
        await writeAtomic(metaPath(root, init.contentHash), JSON.stringify(record, null, 2), 'utf8')
      }
      // P1.1 post-condition: bytes + record co-exist. We hold the per-hash lock, so
      // a concurrent sweep (same lock) can't have removed the bytes between the write
      // and this assert — the old two-stage design's metadata-without-bytes race is
      // structurally impossible here. fs.access throws if bytes are missing → upload
      // fails loudly rather than returning a half-state record.
      await fs.access(bp)
      return { record, newlyWritten, newlyCreated }
    })
  },

  async getBytes(contentHash) {
    assertValidAssetId(contentHash)
    try {
      return await fs.readFile(bytesPath(root, contentHash))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },

  async getRecord(contentHash) {
    assertValidAssetId(contentHash)
    return readRecordUnlocked(root, contentHash)
  },

  async ensureRecord(init, now) {
    assertValidAssetId(init.contentHash)
    return withHashLock(init.contentHash, async () => {
      const existing = await readRecordUnlocked(root, init.contentHash)
      if (existing) return { record: existing, newlyCreated: false }
      const record: AssetRecord = { ...init, references: [], uploaders: [init.ownerFp], lastRefZeroAt: now }
      await writeAtomic(metaPath(root, init.contentHash), JSON.stringify(record, null, 2), 'utf8')
      return { record, newlyCreated: true }
    })
  },

  async attachRef(contentHash, ref) {
    assertValidAssetId(contentHash)
    return withHashLock(contentHash, async () => {
      const record = await readRecordUnlocked(root, contentHash)
      if (!record) return { record: null, newlyAttached: false }
      const exists = record.references.some((r) => r.nodeId === ref.nodeId)
      if (exists) return { record, newlyAttached: false }
      record.references = [...record.references, ref]
      record.lastRefZeroAt = null // any ref → cancel a pending grace window
      await writeAtomic(metaPath(root, contentHash), JSON.stringify(record, null, 2), 'utf8')
      return { record, newlyAttached: true }
    })
  },

  async detachRef(contentHash, nodeId, ownerFp, now) {
    assertValidAssetId(contentHash)
    return withHashLock(contentHash, async () => {
      const record = await readRecordUnlocked(root, contentHash)
      if (!record) return { result: { kind: 'missing' as const }, record: null }
      const idx = record.references.findIndex((r) => r.nodeId === nodeId)
      if (idx === -1) return { result: { kind: 'already-detached' as const }, record }
      if (record.references[idx].ownerFp !== ownerFp) {
        return { result: { kind: 'owner-mismatch' as const }, record }
      }
      const refs = record.references.filter((r) => r.nodeId !== nodeId)
      const atZero = refs.length === 0
      record.references = refs
      // Stamp grace start only on the >0→0 transition; preserve an existing start
      // on 0→0 (idempotent re-detach); clear on any >0 state.
      record.lastRefZeroAt = atZero ? record.lastRefZeroAt ?? now : null
      await writeAtomic(metaPath(root, contentHash), JSON.stringify(record, null, 2), 'utf8')
      return { result: { kind: 'detached' as const }, record }
    })
  },

  async deleteIfStillEligible(contentHash, now) {
    assertValidAssetId(contentHash)
    return withHashLock(contentHash, async () => {
      const record = await readRecordUnlocked(root, contentHash)
      if (!record) return { deleted: false, reason: 'missing' as const }
      // Re-check eligibility UNDER the lock: a concurrent attach/detach that
      // resurrected the asset would have taken the mutex first and flipped
      // lastRefZeroAt to null / raised refs. If still eligible here, delete.
      if (!isPurgeEligible(record, now)) return { deleted: false, reason: 'not-eligible' as const }
      await ignoreMissing(bytesPath(root, contentHash))
      await ignoreMissing(metaPath(root, contentHash))
      return { deleted: true, reason: 'eligible' as const }
    })
  },

  async listRecords() {
    let shards: string[]
    try {
      shards = await fs.readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: AssetRecord[] = []
    for (const shard of shards) {
      let files: string[]
      try {
        files = await fs.readdir(path.join(root, shard))
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.meta.json')) continue
        try {
          const raw = await fs.readFile(path.join(root, shard, file), 'utf8')
          records.push(JSON.parse(raw) as AssetRecord)
        } catch {
          // Skip malformed meta — never crash the sweeper on a single bad file.
        }
      }
    }
    return records
  },

  async cleanOrphanTemps(now) {
    let shards: string[]
    try {
      shards = await fs.readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let cleaned = 0
    for (const shard of shards) {
      const shardDir = path.join(root, shard)
      let files: string[]
      try {
        files = await fs.readdir(shardDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!isOrphanTmpName(file)) continue
        const p = path.join(shardDir, file)
        try {
          const st = await fs.stat(p)
          if (now - st.mtimeMs > ASSET_TMP_ORPHAN_AGE_MS) {
            await ignoreMissing(p)
            cleaned += 1
          }
        } catch {
          // stat failed (file raced away) — skip; never crash the sweep on one tmp.
        }
      }
    }
    return cleaned
  },
})

// ─── In-memory backend (deterministic tests; no fs) ──────────────────────────
// Map ops are synchronous under the node event loop, so each method is already
// atomic w.r.t. a single hash — no mutex needed. Same contract as the fs backend.
export type MemoryAssetBackend = AssetStoreBackend & {
  _records: Map<string, AssetRecord>
  _bytes: Map<string, Buffer>
}

export const createMemoryAssetBackend = (): MemoryAssetBackend => {
  const _records = new Map<string, AssetRecord>()
  const _bytes = new Map<string, Buffer>()
  const backend: AssetStoreBackend = {
    async ensureBytes(contentHash, bytes) {
      assertValidAssetId(contentHash)
      if (_bytes.has(contentHash)) return false
      _bytes.set(contentHash, bytes)
      return true
    },
    async uploadIfAbsent(bytes, init, now) {
      assertValidAssetId(init.contentHash)
      // Map ops are synchronous under the node event loop → atomic per-hash with no
      // interleaving. Same contract as the fs backend's locked primitive.
      let newlyWritten = false
      if (!_bytes.has(init.contentHash)) {
        _bytes.set(init.contentHash, bytes)
        newlyWritten = true
      }
      let record = _records.get(init.contentHash)
      let newlyCreated = false
      if (!record) {
        record = { ...init, references: [], uploaders: [init.ownerFp], lastRefZeroAt: now }
        _records.set(init.contentHash, record)
        newlyCreated = true
      } else if (!record.uploaders?.includes(init.ownerFp)) {
        record = { ...record, uploaders: [...(record.uploaders ?? [record.ownerFp]), init.ownerFp] }
        _records.set(init.contentHash, record)
      }
      return { record, newlyWritten, newlyCreated }
    },
    async getBytes(contentHash) {
      assertValidAssetId(contentHash)
      return _bytes.get(contentHash) ?? null
    },
    async getRecord(contentHash) {
      assertValidAssetId(contentHash)
      return _records.get(contentHash) ?? null
    },
    async ensureRecord(init, now) {
      assertValidAssetId(init.contentHash)
      const existing = _records.get(init.contentHash)
      if (existing) return { record: existing, newlyCreated: false }
      const record: AssetRecord = { ...init, references: [], uploaders: [init.ownerFp], lastRefZeroAt: now }
      _records.set(init.contentHash, record)
      return { record, newlyCreated: true }
    },
    async attachRef(contentHash, ref) {
      assertValidAssetId(contentHash)
      const record = _records.get(contentHash)
      if (!record) return { record: null, newlyAttached: false }
      const exists = record.references.some((r) => r.nodeId === ref.nodeId)
      if (!exists) {
        record.references = [...record.references, ref]
        record.lastRefZeroAt = null
        _records.set(contentHash, record)
      }
      return { record, newlyAttached: !exists }
    },
    async detachRef(contentHash, nodeId, ownerFp, now) {
      assertValidAssetId(contentHash)
      const record = _records.get(contentHash)
      if (!record) return { result: { kind: 'missing' }, record: null }
      const idx = record.references.findIndex((r) => r.nodeId === nodeId)
      if (idx === -1) return { result: { kind: 'already-detached' }, record }
      if (record.references[idx].ownerFp !== ownerFp) {
        return { result: { kind: 'owner-mismatch' }, record }
      }
      const refs = record.references.filter((r) => r.nodeId !== nodeId)
      const atZero = refs.length === 0
      record.references = refs
      record.lastRefZeroAt = atZero ? record.lastRefZeroAt ?? now : null
      _records.set(contentHash, record)
      return { result: { kind: 'detached' }, record }
    },
    async deleteIfStillEligible(contentHash, now) {
      assertValidAssetId(contentHash)
      const record = _records.get(contentHash)
      if (!record) return { deleted: false, reason: 'missing' }
      if (!isPurgeEligible(record, now)) return { deleted: false, reason: 'not-eligible' }
      _bytes.delete(contentHash)
      _records.delete(contentHash)
      return { deleted: true, reason: 'eligible' }
    },
    async listRecords() {
      return [..._records.values()]
    },
    async cleanOrphanTemps() {
      // No tmp layer in the memory backend — nothing to reap.
      return 0
    },
  }
  return { ...backend, _records, _bytes }
}

// ─── Service layer (reference logic, backend-agnostic) ──────────────────────

export type AssetStore = {
  /** Upload bytes → content-addressed id. ensureBytes + ensureRecord only — does
   *  NOT attach a reference (P1.2). deduped = bytes already existed. */
  upload(
    bytes: Buffer,
    mimeType: string,
    originalName: string,
    ownerFp: string,
    now?: number,
  ): Promise<UploadedAsset>
  /** Atomic quota-reserved upload (P1.3): per-owner lock serializes the quota check
   *  + upsert. Dedup (existing record) charges 0 new bytes → never trips quota. */
  uploadWithQuota(
    bytes: Buffer,
    mimeType: string,
    originalName: string,
    ownerFp: string,
    quotaBytes: number,
    now?: number,
  ): Promise<QuotaUploadOutcome>
  /** Read bytes + mimeType for GET /api/assets/:id. null if not stored / purged /
   *  size-mismatch (P1.9 cheap integrity guard). No authz (see readForOwner). */
  read(assetId: string): Promise<{ bytes: Buffer; mimeType: string } | null>
  /** Owner-scoped read (P2.5): serves bytes only if ownerFp is the uploader OR has
   *  a live reference. Else null (→ 404; never 403 — don't leak existence). */
  readForOwner(
    assetId: string,
    ownerFp: string,
  ): Promise<{ bytes: Buffer; mimeType: string } | null>
  /** Idempotent attach (P1.2): add (assetId, nodeId, ownerFp) reference. */
  attach(assetId: string, nodeId: string, ownerFp: string, now?: number): Promise<AttachResult>
  /** Idempotent owner-checked detach (P1.2): remove (assetId, nodeId). */
  detach(assetId: string, nodeId: string, ownerFp: string, now?: number): Promise<DetachResult>
  /** Delete records + bytes whose grace has expired. Re-checks eligibility atomically
   *  per hash (P1.1): a concurrent attach during sweep aborts that asset's delete. */
  runPurgeSweep(now?: number): Promise<{ purged: number; scanned: number }>
  /** Test/diagnostic: read a record (no IO side effect). */
  getRecord(assetId: string): Promise<AssetRecord | null>
  /** Current reference count = references.length. */
  refcount(assetId: string): Promise<number>
  /** Per-owner total bytes (first-uploader attribution) — for the quota check (P1.4). */
  ownerBytes(ownerFp: string): Promise<number>
  /** Offline integrity scrub (P1.9): recompute sha256 for every record's bytes,
   *  report mismatches. Callable entry; no auto-fix. */
  scrubAssetIntegrity(): Promise<{ checked: number; mismatches: Array<{ contentHash: string; sizeBytes: number }> }>
}

const nowOrDefault = (now: number | undefined): number => now ?? Date.now()

// Per-owner in-process mutex (P1.3). Serializes the quota-check + upload so two
// concurrent uploads from the same owner can't both pass the quota gate. Chained
// on the previous tail promise; cleaned when the last op settles. Single BFF
// process — the PG backend (T1.1) must make this a DB-level row lock instead.
const ownerLocks = new Map<string, Promise<void>>()
const withOwnerLock = <T>(ownerFp: string, fn: () => Promise<T>): Promise<T> => {
  const prev = ownerLocks.get(ownerFp) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  const swallowed = next.then(
    () => undefined,
    () => undefined,
  )
  ownerLocks.set(ownerFp, swallowed)
  void swallowed.finally(() => {
    if (ownerLocks.get(ownerFp) === swallowed) ownerLocks.delete(ownerFp)
  })
  return next
}

export const createAssetStore = (backend: AssetStoreBackend): AssetStore => {
  const upload: AssetStore['upload'] = async (bytes, mimeType, originalName, ownerFp, now) => {
    const contentHash = computeContentHash(bytes)
    const at = nowOrDefault(now)
    // P1.1: single atomic primitive — bytes + record + uploader registration under
    // ONE per-hash lock (no metadata-without-bytes race vs the old two-stage design).
    const { record, newlyWritten } = await backend.uploadIfAbsent(
      bytes,
      { contentHash, mimeType, sizeBytes: bytes.length, originalName, ownerFp, createdAt: at },
      at,
    )
    return {
      assetId: contentHash,
      mimeType: record.mimeType,
      originalName: record.originalName,
      sizeBytes: record.sizeBytes,
      deduped: !newlyWritten,
      refcount: record.references.length,
    }
  }

  const uploadWithQuota: AssetStore['uploadWithQuota'] = async (
    bytes,
    mimeType,
    originalName,
    ownerFp,
    quotaBytes,
    now,
  ) => {
    return withOwnerLock(ownerFp, async () => {
      const used = await ownerBytes(ownerFp)
      if (used + bytes.length > quotaBytes) {
        // Dedup (record already exists) adds 0 new bytes — must not trip quota on a
        // re-upload. Only refuse when this would actually store NEW bytes.
        const existing = await backend.getRecord(computeContentHash(bytes))
        if (!existing) {
          return { kind: 'quota-exceeded' as const, used, quota: quotaBytes, size: bytes.length }
        }
      }
      const result = await upload(bytes, mimeType, originalName, ownerFp, now)
      return { kind: 'ok' as const, result }
    })
  }

  const read: AssetStore['read'] = async (assetId) => {
    assertValidAssetId(assetId)
    const bytes = await backend.getBytes(assetId)
    if (!bytes) return null
    const record = await backend.getRecord(assetId)
    // P1.9: cheap size check (no per-request sha256 recompute). A mismatch means
    // the bytes don't match stored metadata → likely corruption; don't serve.
    if (record && bytes.length !== record.sizeBytes) return null
    const mimeType = record?.mimeType ?? 'application/octet-stream'
    return { bytes, mimeType }
  }

  const readForOwner: AssetStore['readForOwner'] = async (assetId, ownerFp) => {
    assertValidAssetId(assetId)
    const record = await backend.getRecord(assetId)
    if (!record) return null
    // P1.5: a dedup uploader is entitled to GET their own upload. ownerFp (first
    // uploader) is always in uploaders, so this subsumes the first-uploader check;
    // the ownerFp fallback covers a pre-P1.5 record whose uploaders set is missing.
    const ownerAllowed =
      record.uploaders?.includes(ownerFp) ||
      record.ownerFp === ownerFp ||
      record.references.some((r) => r.ownerFp === ownerFp)
    if (!ownerAllowed) return null // → 404 (don't leak existence — P2.5)
    const bytes = await backend.getBytes(assetId)
    if (!bytes) return null
    if (bytes.length !== record.sizeBytes) return null // P1.9
    return { bytes, mimeType: record.mimeType }
  }

  const attach: AssetStore['attach'] = async (assetId, nodeId, ownerFp) => {
    assertValidAssetId(assetId)
    const { record, newlyAttached } = await backend.attachRef(assetId, { nodeId, ownerFp })
    if (!record) return { kind: 'missing' }
    return newlyAttached ? { kind: 'attached' } : { kind: 'already-attached' }
  }

  const detach: AssetStore['detach'] = async (assetId, nodeId, ownerFp, now) => {
    assertValidAssetId(assetId)
    const { result } = await backend.detachRef(assetId, nodeId, ownerFp, nowOrDefault(now))
    return result
  }

  const runPurgeSweep: AssetStore['runPurgeSweep'] = async (now) => {
    const at = nowOrDefault(now)
    const records = await backend.listRecords()
    let purged = 0
    for (const record of records) {
      if (!isPurgeEligible(record, at)) continue
      const { deleted } = await backend.deleteIfStillEligible(record.contentHash, at)
      if (deleted) purged += 1
    }
    // P2.6: sweep also reaps orphan .tmp-* files left by a crashed writeAtomic. Side
    // effect only — not surfaced in the return ({purged, scanned} is pinned by the
    // existing characterization tests; cleanOrphanTemps is exercised directly too).
    await backend.cleanOrphanTemps(at)
    return { purged, scanned: records.length }
  }

  const getRecord: AssetStore['getRecord'] = async (assetId) => {
    assertValidAssetId(assetId)
    return backend.getRecord(assetId)
  }

  const refcount: AssetStore['refcount'] = async (assetId) => {
    assertValidAssetId(assetId)
    const r = await backend.getRecord(assetId)
    return r?.references.length ?? 0
  }

  const ownerBytes: AssetStore['ownerBytes'] = async (ownerFp) => {
    const records = await backend.listRecords()
    return records
      .filter((r) => r.ownerFp === ownerFp)
      .reduce((sum, r) => sum + r.sizeBytes, 0)
  }

  const scrubAssetIntegrity: AssetStore['scrubAssetIntegrity'] = async () => {
    const records = await backend.listRecords()
    const mismatches: Array<{ contentHash: string; sizeBytes: number }> = []
    for (const record of records) {
      const bytes = await backend.getBytes(record.contentHash)
      if (!bytes) {
        mismatches.push({ contentHash: record.contentHash, sizeBytes: -1 })
        continue
      }
      const actual = computeContentHash(bytes)
      if (actual !== record.contentHash) {
        mismatches.push({ contentHash: record.contentHash, sizeBytes: bytes.length })
      }
    }
    return { checked: records.length, mismatches }
  }

  return {
    upload,
    uploadWithQuota,
    read,
    readForOwner,
    attach,
    detach,
    runPurgeSweep,
    getRecord,
    refcount,
    ownerBytes,
    scrubAssetIntegrity,
  }
}

// ─── Purge judgment (pure; testable without IO) ──────────────────────────────

/**
 * Pure predicate: is this asset eligible for physical deletion at `now`?
 * refcount==0 AND the 7-day grace window has elapsed since lastRefZeroAt.
 */
export const isPurgeEligible = (record: AssetRecord, now: number): boolean =>
  record.references.length === 0 &&
  record.lastRefZeroAt !== null &&
  now - record.lastRefZeroAt >= ASSET_GRACE_PERIOD_MS

/** Pure helper: remaining ms in the grace window (negative if already eligible). */
export const graceRemainingMs = (record: AssetRecord, now: number): number =>
  record.references.length === 0 && record.lastRefZeroAt !== null
    ? record.lastRefZeroAt + ASSET_GRACE_PERIOD_MS - now
    : Number.POSITIVE_INFINITY
