// server/lib/assetStore.ts
// T1.5 content-addressed asset store. assetId = sha256(canonical bytes) full hex (64) —
// content-addressed: identical canonical bytes → identical id → shared storage (dedup).
// The ROUTE (server/routes/assets.ts) hands sharp's canonical re-encode to upload(); the
// store is bytes-agnostic (it stores whatever Buffer + mimeType it's given).
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
// Uploader entitlement (P1.5) + separate uploader structure (P2-E): uploaders live in
// a DEDICATED structure (fs: <hash>.uploaders file, one ownerFp per line; memory: a
// Map<hash,Set>) — NOT on the record JSON, so a hot asset dedup'd by many owners can't
// bloat the record. readForOwner serves the uploader (first-uploader ownerFp is on the
// record; dedup uploaders are looked up via isUploader) OR any owner holding a live
// reference. A dedup uploader can always GET their own upload even though ownerFp
// (first uploader, used for quota) is someone else — content-addressed dedup must not
// strand the second uploader's read access.
//
// Grace + purge (docs/decisions/soft-delete-semantics.md §4):
// - refcount == 0 → stamp lastRefZeroAt (grace start). 7-day window covers single-
//   node undo + canvas restore. If refcount rises during grace → cancel delete.
// - Grace expired + still 0 → physically delete bytes + record + uploaders.
//
// Purge order (P1-B): within the hash lock, deleteIfStillEligible makes metadata
// invisible FIRST (atomic rename of <hash>.meta.json → a .tmp-tombstone), THEN unlinks
// bytes + uploaders + the tombstone. Any failure between can only leave "orphan bytes
// / orphan uploaders, NO record" — never "record present, bytes gone" (the half-state
// that would make a later GET find a record but read null bytes). The tombstone is a
// .tmp-* file so cleanOrphanTemps reaps it if its own cleanup unlink fails.
//
// Atomicity (P1.1): the backend contract is per-hash atomic primitives (no
// read-modify-write across the public boundary). The fs impl serializes per-hash
// ops with an in-process mutex and publishes bytes + metadata via temp-write +
// atomic rename (a crash mid-write never leaves a partial file). deleteIfStill-
// Eligible re-checks eligibility UNDER the lock, so a concurrent attach that
// resurrects the asset causes the sweep to abort the delete.
//
// Quota + hash-locked admission (P2-C): uploadWithQuota computes `used` under the
// per-OWNER lock, then calls a single hash-locked admitUpload primitive. Inside the
// hash lock: if the record already exists → register the uploader unconditionally
// (dedup, 0 new bytes, never trips quota — the race where B is at quota and A first-
// uploads the same bytes must still register B); if NEW → the quota gate runs BEFORE
// any bytes are written. Lock ordering is owner→hash (no path acquires hash then
// owner), so there is no deadlock.
//
// Quota eviction slow path (P2-F): when an over-quota NEW upload would be refused,
// first purge THIS owner's grace-expired refcount==0 assets (runPurgeSweep targeted),
// recompute `used`, then refuse only if still over. runPurgeSweep is also a callable
// entry for a periodic cron (recommended; see docs/decisions/soft-delete-semantics.md).
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
// Orphan tmp reaping (P2.6 + P2-D): cleanOrphanTemps reaps stale .tmp-* files left
// by a crashed writeAtomic, but SKIPS tmps that an in-progress writeAtomic is holding
// (the activeTmp set) — so a writer blocked longer than the age threshold is NOT
// mistaken for a crash. Only tmps both stale AND inactive are unlinked.
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

/**
 * G2.2:legacy owner 形态 = mivo-key 指纹(sha256[:16] hex;权威 keys.ts `fingerprintOfPlatformKey`
 * + owner.ts `isLegacyFormOwner` + persist/backend.ts `isLegacyFormOwnerId`,同一形态定义)。模块级常量,
 * 供 fs/memory backend 的 rekeyLegacyFormOwners + AssetStore service 的 countLegacyFormOwners 共用。
 * SSO username 为 email-style(含 @);DEV_ACTOR_ID=`mivo-dev-actor`——均不匹配 16-hex,故可机械区分。
 */
const ASSET_LEGACY_FINGERPRINT_RE = /^[0-9a-f]{16}$/

/** Typed error for an asset id that isn't lowercase sha256 hex64 (P2.6). */
export class InvalidAssetIdError extends Error {
  readonly assetId: string
  constructor(assetId: string) {
    super(`Invalid asset id (expected lowercase sha256 hex64): ${assetId}`)
    this.name = 'InvalidAssetIdError'
    this.assetId = assetId
  }
}

/**
 * A single reference keeping an asset alive. refcount = count of these.
 * - `ownerFp`: the attacher's owner fingerprint (FX-2) — who created THIS reference.
 * - `canvasId`: G2.2 — the canvas the attached node belongs to. Lets detach verify
 *   edit permission on the referencing canvas (decision 2) + lets attach gate ② check
 *   transitive view entitlement via a referencing canvas (decision 1). Optional: legacy
 *   references written before G2.2 carry no canvasId; readers MUST tolerate undefined
 *   (fall back to ownerFp / body-supplied canvasId).
 */
export type AssetReference = { nodeId: string; ownerFp: string; canvasId?: string }

export type AssetRecord = {
  /** content-addressed id = sha256(bytes) hex. */
  contentHash: string
  mimeType: string
  sizeBytes: number
  originalName: string
  /** First uploader's ownerFp (FX-2 fingerprintOfPlatformKey) — 归属打标 + quota
   *  attribution (ownerBytes sums records whose ownerFp matches). metadata only.
   *  The full uploader SET lives in a dedicated structure (P2-E) — not on the record
   *  JSON — so a many-uploader asset can't bloat the record. */
  ownerFp: string
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
  /** Atomic hash-locked quota admission (P2-C). Under the per-hash lock: if the record
   *  already exists → idempotently register the uploader (dedup, 0 new bytes, never
   *  trips quota — the B-at-quota + A-first-uploads-same-bytes race must still register
   *  B); if NEW → the quota gate runs BEFORE any bytes are written (refuse → return
   *  quota-exceeded without writing). */
  admitUpload(
    bytes: Buffer,
    init: AssetRecordInit,
    ownerFp: string,
    quotaBytes: number,
    used: number,
    now: number,
  ): Promise<
    | { kind: 'ok'; record: AssetRecord; newlyWritten: boolean; newlyCreated: boolean }
    | { kind: 'quota-exceeded'; used: number; quota: number; size: number }
  >
  getBytes(contentHash: string): Promise<Buffer | null>
  getRecord(contentHash: string): Promise<AssetRecord | null>
  /** Atomic: ensure a record exists (create with references=[] + lastRefZeroAt=now
   *  if absent). Returns the record + newlyCreated. */
  ensureRecord(init: AssetRecordInit, now: number): Promise<{ record: AssetRecord; newlyCreated: boolean }>
  /** Atomic: attach (assetId, nodeId, ownerFp) if a record exists. Idempotent.
   *  Returns the resulting record (or null if no record) + newlyAttached. */
  attachRef(contentHash: string, ref: AssetReference): Promise<{ record: AssetRecord | null; newlyAttached: boolean }>
  /** Atomic: detach (assetId, nodeId) if ownerFp matches. Idempotent + owner-checked.
   *  Stamps lastRefZeroAt on the >0→0 transition. Returns the detach result + record. */
  detachRef(contentHash: string, nodeId: string, ownerFp: string, now: number): Promise<{ result: DetachResult; record: AssetRecord | null }>
  /** Atomic (P1-B): re-check eligibility at `now` UNDER the lock; make metadata
   *  invisible FIRST (rename to tombstone), then delete bytes + uploaders + tombstone.
   *  Any failure leaves "orphan bytes/uploaders, no record" — never "record, no bytes". */
  deleteIfStillEligible(contentHash: string, now: number): Promise<{ deleted: boolean; reason: 'eligible' | 'not-eligible' | 'missing' }>
  listRecords(): Promise<AssetRecord[]>
  /** Sweep helper (P2.6 + P2-D): reap orphan `.tmp-*` files left by a crashed
   *  writeAtomic (rename/write threw before the tmp was cleaned). Skips tmps an
   *  in-progress writeAtomic is holding (the activeTmp set). Only files older than
   *  the threshold AND inactive are removed. Returns the count unlinked. No-op for
   *  backends without a tmp layer. */
  cleanOrphanTemps(now: number): Promise<number>
  /** Idempotently register an uploader for read entitlement (P1.5). Dedicated
   *  structure (P2-E — not the record JSON). Public entry; takes the per-hash lock. */
  registerUploader(contentHash: string, ownerFp: string): Promise<void>
  /** True iff ownerFp has been registered as an uploader of this asset (P1.5).
   *  Lock-free read (the .uploaders file is append-only + atomically renamed; a GET
   *  after a completed upload always sees the appended line). */
  isUploader(contentHash: string, ownerFp: string): Promise<boolean>
  /** Test/diagnostic: the uploader set for an asset (P2-E). */
  listUploaders(contentHash: string): Promise<string[]>
  /**
   * G2.2:asset 域 owner rekey——把 AssetRecord.ownerFp + references[].ownerFp + .uploaders 中为
   * legacy 指纹形态(16-hex)的 owner 重键为 SSO username(`resolver` 返回值)。两阶段(防 resolver
   * 中途抛留半迁移态):① 扫全 records+uploaders 收集 legacy owner 集合并 resolve;② 逐 record 在 hash
   * 锁内原地改 + 重写 .meta.json/.uploaders。resolver 返 undefined/空 → unmapped(留 legacy)。**可选**:
   * fs/memory 实装;返回 {migrated, unmapped}(owner 维度计数,非 record 维度)。
   */
  rekeyLegacyFormOwners?(
    resolver: (fingerprint: string) => string | undefined,
  ): Promise<{ migrated: number; unmapped: number }>
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
//          + <root>/<hash[0:2]>/<hash>.uploaders (one ownerFp per line — P2-E)
// 2-char sharding avoids a single flat dir of thousands of files.

const shardDir = (root: string, hash: string): string => path.join(root, hash.slice(0, 2))
const bytesPath = (root: string, hash: string): string => path.join(shardDir(root, hash), `${hash}.bin`)
const metaPath = (root: string, hash: string): string => path.join(shardDir(root, hash), `${hash}.meta.json`)
const uploadersPath = (root: string, hash: string): string => path.join(shardDir(root, hash), `${hash}.uploaders`)

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
// the read-modify-write on the meta JSON + uploaders file is race-free. Chained on
// the previous tail promise; the map entry is cleaned when the last op settles.
// Single BFF process — the PG backend (T1.1) must make these DB transactions instead.
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

// In-progress writeAtomic tmp set (P2-D). cleanOrphanTemps skips these so a writer
// blocked longer than the orphan age threshold is NOT mistaken for a crash. Module-
// scoped: tmp paths are absolute + pid+counter-suffixed → unique across backends.
const activeTmps = new Set<string>()

// temp-write + atomic rename (P1.1). The temp suffix is process-stable + monotonic
// so concurrent temps for the same hash can't collide (the mutex serializes them
// anyway; this is defense in depth). rename() is atomic on POSIX → a crash
// mid-write never publishes a partial file.
//
// P3-G: if writeFile/rename throws, the tmp is best-effort unlinked — but a cleanup
// FAILURE must not mask the original write/rename error. The cleanup is wrapped in
// its own try/catch; on cleanup failure the original error is rethrown with the
// cleanup error attached as `cause` (Node 16+ Error.cause), so diagnostics retain
// both. cleanOrphanTemps is the sweep backstop for a tmp this cleanup also can't
// reach (hard process crash).
let tempCounter = 0
const tempSuffix = (): string => `${process.pid}-${tempCounter++}`
const writeAtomic = async (finalPath: string, data: Buffer | string, encoding?: BufferEncoding): Promise<void> => {
  await ensureDir(path.dirname(finalPath))
  const tmp = `${finalPath}.tmp-${tempSuffix()}`
  activeTmps.add(tmp)
  try {
    if (encoding === undefined) await fs.writeFile(tmp, data as Buffer)
    else await fs.writeFile(tmp, data as string, encoding)
    await fs.rename(tmp, finalPath)
  } catch (error) {
    // P3-G: cleanup is best-effort; a cleanup failure must not mask the original.
    try {
      await ignoreMissing(tmp)
    } catch (cleanupError) {
      const enriched = error as Error & { cause?: unknown }
      if (!('cause' in enriched)) enriched.cause = cleanupError
    }
    throw error
  } finally {
    activeTmps.delete(tmp)
  }
}

/** Orphan tmp age threshold (P2.6). A writeAtomic in progress holds a fresh tmp +
 *  is in activeTmps; any tmp older than this AND inactive is from a crashed write and
 *  is reaped by cleanOrphanTemps. */
export const ASSET_TMP_ORPHAN_AGE_MS = 5 * 60 * 1000 // 5 min

/** True iff `name` is a writeAtomic tmp sibling OR a delete tombstone (P2.6 sweep). */
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

// Read the uploader set from the dedicated .uploaders file (P2-E). Lock-free for
// isUploader/listUploaders (append-only + atomic rename → consistent reads); called
// under the hash lock by registerUploaderLocked.
const readUploadersUnlocked = async (root: string, contentHash: string): Promise<string[]> => {
  try {
    const raw = await fs.readFile(uploadersPath(root, contentHash), 'utf8')
    return raw.split('\n').filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

// Idempotently append ownerFp to the .uploaders file (P1.5 + P2-E). Caller holds the
// per-hash lock (no concurrent register for the same hash). appendFile is atomic for
// the line on POSIX (O_APPEND) → a lock-free concurrent isUploader read sees either
// the old or the new complete file, never a partial line.
const registerUploaderLocked = async (root: string, contentHash: string, ownerFp: string): Promise<void> => {
  const existing = await readUploadersUnlocked(root, contentHash)
  if (existing.includes(ownerFp)) return // idempotent — no duplicate line
  await ensureDir(shardDir(root, contentHash))
  await fs.appendFile(uploadersPath(root, contentHash), `${ownerFp}\n`, 'utf8')
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
      if (!record) {
        record = { ...init, references: [], lastRefZeroAt: now }
        newlyCreated = true
        await writeAtomic(metaPath(root, init.contentHash), JSON.stringify(record, null, 2), 'utf8')
      }
      // P1.5 + P2-E: register the uploader in the dedicated .uploaders file (not on
      // the record). Idempotent.
      await registerUploaderLocked(root, init.contentHash, init.ownerFp)
      // P1.1 post-condition: bytes + record co-exist. We hold the per-hash lock, so
      // a concurrent sweep (same lock) can't have removed the bytes between the write
      // and this assert — the old two-stage design's metadata-without-bytes race is
      // structurally impossible here. fs.access throws if bytes are missing → upload
      // fails loudly rather than returning a half-state record.
      await fs.access(bp)
      return { record, newlyWritten, newlyCreated }
    })
  },

  async admitUpload(bytes, init, ownerFp, quotaBytes, used, now) {
    assertValidAssetId(init.contentHash)
    return withHashLock(init.contentHash, async () => {
      const existing = await readRecordUnlocked(root, init.contentHash)
      if (existing) {
        // P2-C: record already exists → dedup. Register the uploader unconditionally
        // (0 new bytes — never trips quota). This is the race winner's entitlement:
        // B at quota + A first-uploads the same bytes → B is still registered and can
        // GET, rather than being 413'd for bytes that already exist.
        await registerUploaderLocked(root, init.contentHash, ownerFp)
        return { kind: 'ok' as const, record: existing, newlyWritten: false, newlyCreated: false }
      }
      // NEW asset → quota gate BEFORE any bytes are written (P2-C). `used` was
      // computed under the owner lock (held by the caller), so it is stable across
      // this hash-locked admission.
      if (used + bytes.length > quotaBytes) {
        return { kind: 'quota-exceeded' as const, used, quota: quotaBytes, size: bytes.length }
      }
      const bp = bytesPath(root, init.contentHash)
      let newlyWritten = false
      try {
        await fs.access(bp)
      } catch {
        await writeAtomic(bp, bytes)
        newlyWritten = true
      }
      const record: AssetRecord = { ...init, references: [], lastRefZeroAt: now }
      await writeAtomic(metaPath(root, init.contentHash), JSON.stringify(record, null, 2), 'utf8')
      await registerUploaderLocked(root, init.contentHash, ownerFp)
      await fs.access(bp) // post-condition: bytes + record co-exist
      return { kind: 'ok' as const, record, newlyWritten, newlyCreated: true }
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
      const record: AssetRecord = { ...init, references: [], lastRefZeroAt: now }
      await writeAtomic(metaPath(root, init.contentHash), JSON.stringify(record, null, 2), 'utf8')
      await registerUploaderLocked(root, init.contentHash, init.ownerFp)
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
      // G2.2(decision 2):带 canvasId 的 ref 由 route 做 canvas-edit authz 授权后移除(service 信任 route
      // 授权,不做 ownerFp 校验——使 editor 能 detach owner 的 ref);无 canvasId 的 legacy ref 回退到
      // ownerFp 校验(decidable owner-mismatch,不静默,保既有 service 测试 + assetsAttachDetach 契约)。
      const ref = record.references[idx]
      if (!ref.canvasId && ref.ownerFp !== ownerFp) {
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
      // P1-B: make metadata invisible FIRST (atomic rename of meta.json → a
      // .tmp-tombstone). A reader (readRecordUnlocked reads *.meta.json only) now sees
      // no record → attach→missing, GET→404. If the rename throws non-ENOENT, the
      // record is still visible + bytes still present — consistent; a later sweep retries.
      const meta = metaPath(root, contentHash)
      const tomb = `${meta}.tmp-tombstone-${tempSuffix()}`
      try {
        await fs.rename(meta, tomb)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { deleted: false, reason: 'missing' as const } // raced away
        }
        throw error
      }
      // Bytes + uploaders + tombstone: best-effort, in that order. A failure here
      // leaves orphan bytes/uploaders + NO record — the acceptable half-state (a
      // future re-upload overwrites the bytes; cleanOrphanTemps reaps an old tomb).
      // It never leaves "record present, bytes gone" (the record is already invisible).
      try {
        await ignoreMissing(bytesPath(root, contentHash))
      } catch {
        // orphan bytes linger — no record points to them
      }
      try {
        await ignoreMissing(uploadersPath(root, contentHash))
      } catch {
        // orphan uploaders linger — readForOwner checks getRecord first, so this is
        // never consulted without a record
      }
      try {
        await ignoreMissing(tomb)
      } catch {
        // tombstone lingers — cleanOrphanTemps reaps it after the age threshold
      }
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
      const dir = path.join(root, shard)
      let files: string[]
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!isOrphanTmpName(file)) continue
        const p = path.join(dir, file)
        // P2-D: skip tmps an in-progress writeAtomic (or tombstone phase) is holding
        // — a writer blocked longer than the age threshold is NOT a crash.
        if (activeTmps.has(p)) continue
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

  async registerUploader(contentHash, ownerFp) {
    assertValidAssetId(contentHash)
    return withHashLock(contentHash, () => registerUploaderLocked(root, contentHash, ownerFp))
  },

  async isUploader(contentHash, ownerFp) {
    assertValidAssetId(contentHash)
    // Lock-free: the .uploaders file is append-only + atomically renamed on write;
    // a GET after a completed upload always observes the appended line.
    return (await readUploadersUnlocked(root, contentHash)).includes(ownerFp)
  },

  async listUploaders(contentHash) {
    assertValidAssetId(contentHash)
    return readUploadersUnlocked(root, contentHash)
  },

  async rekeyLegacyFormOwners(resolver) {
    // Phase 1:扫全 records + uploaders,收集 legacy owner 集合并 resolve(resolver 可能抛 → 此时未 mutation)。
    const records: AssetRecord[] = []
    let shards: string[]
    try {
      shards = await fs.readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { migrated: 0, unmapped: 0 }
      throw error
    }
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
          // skip malformed meta(同 listRecords,不崩 sweep)
        }
      }
    }
    const legacySet = new Set<string>()
    for (const r of records) {
      if (ASSET_LEGACY_FINGERPRINT_RE.test(r.ownerFp)) legacySet.add(r.ownerFp)
      for (const ref of r.references) {
        if (ASSET_LEGACY_FINGERPRINT_RE.test(ref.ownerFp)) legacySet.add(ref.ownerFp)
      }
      const uploaders = await readUploadersUnlocked(root, r.contentHash)
      for (const up of uploaders) {
        if (ASSET_LEGACY_FINGERPRINT_RE.test(up)) legacySet.add(up)
      }
    }
    const mapping = new Map<string, string>()
    let unmapped = 0
    for (const fp of legacySet) {
      const u = resolver(fp)
      if (u && u.length > 0) mapping.set(fp, u)
      else unmapped += 1
    }
    // Phase 2:逐 record 在 hash 锁内原地改 ownerFp + refs[].ownerFp + 重写 .uploaders(Map ops 同步,无 resolver 调用)。
    for (const r of records) {
      const hash = r.contentHash
      await withHashLock(hash, async () => {
        const record = await readRecordUnlocked(root, hash)
        if (!record) return
        let recChanged = false
        if (mapping.has(record.ownerFp)) {
          record.ownerFp = mapping.get(record.ownerFp)!
          recChanged = true
        }
        for (const ref of record.references) {
          if (mapping.has(ref.ownerFp)) {
            ref.ownerFp = mapping.get(ref.ownerFp)!
            recChanged = true
          }
        }
        if (recChanged) {
          await writeAtomic(metaPath(root, hash), JSON.stringify(record, null, 2), 'utf8')
        }
        const uploaders = await readUploadersUnlocked(root, hash)
        let upChanged = false
        const mapped = uploaders.map((up) => {
          if (mapping.has(up)) {
            upChanged = true
            return mapping.get(up)!
          }
          return up
        })
        if (upChanged) {
          const dedup = [...new Set(mapped)]
          await writeAtomic(uploadersPath(root, hash), dedup.join('\n') + '\n', 'utf8')
        }
      })
    }
    return { migrated: mapping.size, unmapped }
  },
})

// ─── In-memory backend (deterministic tests; no fs) ──────────────────────────
// Map ops are synchronous under the node event loop, so each method is already
// atomic w.r.t. a single hash — no mutex needed. Same contract as the fs backend.
export type MemoryAssetBackend = AssetStoreBackend & {
  _records: Map<string, AssetRecord>
  _bytes: Map<string, Buffer>
  _uploaders: Map<string, Set<string>>
}

export const createMemoryAssetBackend = (): MemoryAssetBackend => {
  const _records = new Map<string, AssetRecord>()
  const _bytes = new Map<string, Buffer>()
  const _uploaders = new Map<string, Set<string>>()

  const registerUploaderSync = (contentHash: string, ownerFp: string): void => {
    const set = _uploaders.get(contentHash) ?? new Set<string>()
    if (!set.has(ownerFp)) {
      set.add(ownerFp)
      _uploaders.set(contentHash, set)
    }
  }

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
        record = { ...init, references: [], lastRefZeroAt: now }
        _records.set(init.contentHash, record)
        newlyCreated = true
      }
      registerUploaderSync(init.contentHash, init.ownerFp)
      return { record, newlyWritten, newlyCreated }
    },

    async admitUpload(bytes, init, ownerFp, quotaBytes, used, now) {
      assertValidAssetId(init.contentHash)
      const existing = _records.get(init.contentHash)
      if (existing) {
        // P2-C: dedup → register uploader unconditionally (no charge).
        registerUploaderSync(init.contentHash, ownerFp)
        return { kind: 'ok' as const, record: existing, newlyWritten: false, newlyCreated: false }
      }
      if (used + bytes.length > quotaBytes) {
        return { kind: 'quota-exceeded' as const, used, quota: quotaBytes, size: bytes.length }
      }
      let newlyWritten = false
      if (!_bytes.has(init.contentHash)) {
        _bytes.set(init.contentHash, bytes)
        newlyWritten = true
      }
      const record: AssetRecord = { ...init, references: [], lastRefZeroAt: now }
      _records.set(init.contentHash, record)
      registerUploaderSync(init.contentHash, ownerFp)
      return { kind: 'ok' as const, record, newlyWritten, newlyCreated: true }
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
      const record: AssetRecord = { ...init, references: [], lastRefZeroAt: now }
      _records.set(init.contentHash, record)
      registerUploaderSync(init.contentHash, init.ownerFp)
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
      // G2.2(decision 2):带 canvasId 的 ref 由 route 做 canvas-edit authz 后移除;legacy ref(无 canvasId)
      // 回退 ownerFp 校验(owner-mismatch,decidable)。与 fs backend 同语义。
      const ref = record.references[idx]
      if (!ref.canvasId && ref.ownerFp !== ownerFp) {
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
      // P1-B: record invisible FIRST, then bytes, then uploaders — never the reverse.
      _records.delete(contentHash)
      _bytes.delete(contentHash)
      _uploaders.delete(contentHash)
      return { deleted: true, reason: 'eligible' }
    },

    async listRecords() {
      return [..._records.values()]
    },

    async cleanOrphanTemps() {
      // No tmp layer in the memory backend — nothing to reap.
      return 0
    },

    async registerUploader(contentHash, ownerFp) {
      assertValidAssetId(contentHash)
      registerUploaderSync(contentHash, ownerFp)
    },

    async isUploader(contentHash, ownerFp) {
      assertValidAssetId(contentHash)
      return _uploaders.get(contentHash)?.has(ownerFp) ?? false
    },

    async listUploaders(contentHash) {
      assertValidAssetId(contentHash)
      return [...(_uploaders.get(contentHash) ?? [])]
    },

    async rekeyLegacyFormOwners(resolver) {
      // Phase 1:收集 legacy owner 集合并 resolve(resolver 可能抛 → 此时未 mutation)。
      const legacySet = new Set<string>()
      for (const r of _records.values()) {
        if (ASSET_LEGACY_FINGERPRINT_RE.test(r.ownerFp)) legacySet.add(r.ownerFp)
        for (const ref of r.references) {
          if (ASSET_LEGACY_FINGERPRINT_RE.test(ref.ownerFp)) legacySet.add(ref.ownerFp)
        }
        const uploaders = _uploaders.get(r.contentHash) ?? new Set<string>()
        for (const up of uploaders) {
          if (ASSET_LEGACY_FINGERPRINT_RE.test(up)) legacySet.add(up)
        }
      }
      const mapping = new Map<string, string>()
      let unmapped = 0
      for (const fp of legacySet) {
        const u = resolver(fp)
        if (u && u.length > 0) mapping.set(fp, u)
        else unmapped += 1
      }
      // Phase 2:原地改 record.ownerFp + refs[].ownerFp + _uploaders(Map ops 同步,无 resolver 调用)。
      for (const r of _records.values()) {
        if (mapping.has(r.ownerFp)) r.ownerFp = mapping.get(r.ownerFp)!
        for (const ref of r.references) {
          if (mapping.has(ref.ownerFp)) ref.ownerFp = mapping.get(ref.ownerFp)!
        }
      }
      for (const [hash, set] of _uploaders) {
        const mapped = new Set<string>()
        let changed = false
        for (const up of set) {
          if (mapping.has(up)) { mapped.add(mapping.get(up)!); changed = true }
          else mapped.add(up)
        }
        if (changed) _uploaders.set(hash, mapped)
      }
      return { migrated: mapping.size, unmapped }
    },
  }
  return { ...backend, _records, _bytes, _uploaders }
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
  /** Atomic quota-reserved upload (P1.3 + P2-C + P2-F): per-owner lock serializes the
   *  used computation, a hash-locked admission primitive does dedup/quota/register
   *  atomically, and an over-quota NEW upload first purges THIS owner's grace-expired
   *  assets (slow path) before refusing. Dedup charges 0 new bytes → never trips. */
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
  /** Idempotent attach (P1.2): add (assetId, nodeId, ownerFp[, canvasId]) reference.
   *  G2.2: canvasId recorded on the reference so detach can verify edit on the referencing
   *  canvas (decision 2) + attach gate ② can check transitive view via a referencing canvas
   *  (decision 1). The route MUST pre-authorize canvas-edit before calling (service trusts route).
   *  `now` retained as 4th param for backward-compat with existing service tests (vestigial —
   *  attachRef does not stamp time); canvasId is the new 5th param. */
  attach(assetId: string, nodeId: string, ownerFp: string, now?: number, canvasId?: string): Promise<AttachResult>
  /** Idempotent detach (P1.2): remove (assetId, nodeId). G2.2: route pre-authorizes canvas-edit
   *  on the reference's canvas; service removes by nodeId (legacy refs w/o canvasId keep ownerFp check). */
  detach(assetId: string, nodeId: string, ownerFp: string, now?: number): Promise<DetachResult>
  /** Delete records + bytes whose grace has expired. Re-checks eligibility atomically
   *  per hash (P1.1): a concurrent attach during sweep aborts that asset's delete.
   *  Callable sweep entry — recommended cron (see docs/decisions/soft-delete-semantics.md). */
  runPurgeSweep(now?: number): Promise<{ purged: number; scanned: number }>
  /** Test/diagnostic: read a record (no IO side effect). */
  getRecord(assetId: string): Promise<AssetRecord | null>
  /** G2.2 gate ②:ownerFp 是该 asset 的 uploader 吗(dedup uploader 注册表,.uploaders)?转发 backend.isUploader。 */
  isUploader(assetId: string, ownerFp: string): Promise<boolean>
  /** Current reference count = references.length. */
  refcount(assetId: string): Promise<number>
  /** Per-owner total bytes (first-uploader attribution) — for the quota check (P1.4). */
  ownerBytes(ownerFp: string): Promise<number>
  /** Offline integrity scrub (P1.9): recompute sha256 for every record's bytes,
   *  report mismatches. Callable entry; no auto-fix. */
  scrubAssetIntegrity(): Promise<{ checked: number; mismatches: Array<{ contentHash: string; sizeBytes: number }> }>
  /**
   * G2.1 R2-1 三域 gate 的 assets 域 detector:统计 AssetRecord.ownerFp + references[].ownerFp +
   * .uploaders 中为 legacy 形态(mivo-key 指纹,sha256[:16] hex;权威 owner.ts `isLegacyFormOwner`/
   * keys.ts `fingerprintOfPlatformKey`)的 owner 数(去重)。strict 启动 gate
   * `assertStrictOwnerMigrationComplete` 调用:>0 → 拒启动(assets 域迁移未完成)。**可选**:
   * InMemory/fs 实扫(listRecords + listUploaders,可测);PG detector 随 G2.2 迁移落地,未实现时
   * strict 启动 fail-closed(owner.ts gate 显式拒绝)。覆盖 AssetRecord.ownerFp(first uploader 归属
   * 打标)+ references[].ownerFp(attach 方)+ .uploaders(dedup uploader 注册表)三处 legacy 指纹。
   */
  countLegacyFormOwners?(): Promise<number>
  /**
   * G2.2:asset 域 owner rekey——把 AssetRecord.ownerFp + references[].ownerFp + .uploaders 中为
   * legacy 指纹形态(16-hex)的 owner 重键为 SSO username。转发 backend.rekeyLegacyFormOwners。
   * unmapped>0 → strict gate 仍 no-go(明确拒迁)。返回 {migrated, unmapped}(owner 维度计数)。
   */
  migrateLegacyFormOwners?(
    resolver: (fingerprint: string) => string | undefined,
  ): Promise<{ migrated: number; unmapped: number }>
}

const nowOrDefault = (now: number | undefined): number => now ?? Date.now()

// Per-owner in-process mutex (P1.3). Serializes the used computation + admission so
// two concurrent uploads from the same owner can't both pass the quota gate. Chained
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

  // P2-F: targeted purge of ONE owner's grace-expired refcount==0 assets. Frees
  // quota room before an over-quota NEW upload is refused. (runPurgeSweep sweeps
  // all owners; this is the owner-scoped slow-path equivalent.)
  const purgeOwnerEligible = async (ownerFp: string, at: number): Promise<void> => {
    const records = await backend.listRecords()
    for (const record of records) {
      if (record.ownerFp !== ownerFp) continue
      if (!isPurgeEligible(record, at)) continue
      // deleteIfStillEligible re-checks eligibility UNDER the hash lock (a concurrent
      // attach that resurrected the asset aborts the delete).
      await backend.deleteIfStillEligible(record.contentHash, at)
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
      const at = nowOrDefault(now)
      let used = await ownerBytes(ownerFp)
      if (used + bytes.length > quotaBytes) {
        // P2-F slow path: an over-quota NEW upload first frees room by purging THIS
        // owner's grace-expired refcount==0 assets, then recomputes used. If still
        // over, admitUpload's hash-locked gate refuses (no bytes written).
        await purgeOwnerEligible(ownerFp, at)
        used = await ownerBytes(ownerFp)
      }
      const contentHash = computeContentHash(bytes)
      const outcome = await backend.admitUpload(
        bytes,
        { contentHash, mimeType, sizeBytes: bytes.length, originalName, ownerFp, createdAt: at },
        ownerFp,
        quotaBytes,
        used,
        at,
      )
      if (outcome.kind === 'quota-exceeded') return outcome
      const { record, newlyWritten } = outcome
      return {
        kind: 'ok' as const,
        result: {
          assetId: contentHash,
          mimeType: record.mimeType,
          originalName: record.originalName,
          sizeBytes: record.sizeBytes,
          deduped: !newlyWritten,
          refcount: record.references.length,
        },
      }
    })
  }

  const ownerBytes: AssetStore['ownerBytes'] = async (ownerFp) => {
    const records = await backend.listRecords()
    return records
      .filter((r) => r.ownerFp === ownerFp)
      .reduce((sum, r) => sum + r.sizeBytes, 0)
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
    // P1.5 + P2-E: ownerFp (first uploader) is on the record; dedup uploaders are in
    // the dedicated structure (isUploader); a referenced owner is in references. Any
    // of these → entitled. Else null (→ 404 — never leak existence, P2.5).
    const ownerAllowed =
      record.ownerFp === ownerFp ||
      (await backend.isUploader(assetId, ownerFp)) ||
      record.references.some((r) => r.ownerFp === ownerFp)
    if (!ownerAllowed) return null
    const bytes = await backend.getBytes(assetId)
    if (!bytes) return null
    if (bytes.length !== record.sizeBytes) return null // P1.9
    return { bytes, mimeType: record.mimeType }
  }

  const attach: AssetStore['attach'] = async (assetId, nodeId, ownerFp, _now, canvasId) => {
    assertValidAssetId(assetId)
    const { record, newlyAttached } = await backend.attachRef(assetId, { nodeId, ownerFp, canvasId })
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

  const isUploader: AssetStore['isUploader'] = async (assetId, ownerFp) => {
    assertValidAssetId(assetId)
    return backend.isUploader(assetId, ownerFp)
  }

  const refcount: AssetStore['refcount'] = async (assetId) => {
    assertValidAssetId(assetId)
    const r = await backend.getRecord(assetId)
    return r?.references.length ?? 0
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

  // G2.1 R2-1:legacy owner 形态 = mivo-key 指纹(sha256[:16] hex;模块级 ASSET_LEGACY_FINGERPRINT_RE,
  // 供 fs/memory backend rekeyLegacyFormOwners + 本 service countLegacyFormOwners 共用)。
  const countLegacyFormOwners: AssetStore['countLegacyFormOwners'] = async () => {
    // 扫 AssetRecord.ownerFp(first uploader 归属打标)+ references[].ownerFp(attach 方)+ .uploaders
    // (dedup uploader 注册表)三处 legacy 指纹;去重(同一 legacy ownerFp 多处计 1)。
    const legacy = new Set<string>()
    const records = await backend.listRecords()
    for (const record of records) {
      if (ASSET_LEGACY_FINGERPRINT_RE.test(record.ownerFp)) legacy.add(record.ownerFp)
      for (const ref of record.references) {
        if (ASSET_LEGACY_FINGERPRINT_RE.test(ref.ownerFp)) legacy.add(ref.ownerFp)
      }
      // uploader 注册表(可能含 dedup uploader 的 legacy 指纹;first uploader 已在 record.ownerFp 覆盖)
      const uploaders = await backend.listUploaders(record.contentHash)
      for (const up of uploaders) {
        if (ASSET_LEGACY_FINGERPRINT_RE.test(up)) legacy.add(up)
      }
    }
    return legacy.size
  }

  // G2.2:asset 域 owner rekey——转发 backend.rekeyLegacyFormOwners(fs/memory 实装)。backend 未实现
  // (PG asset backend,G2.2 后)→ 返回 not implemented(fail-closed,与启动 gate 一致)。
  const migrateLegacyFormOwners: AssetStore['migrateLegacyFormOwners'] = async (resolver) => {
    if (typeof backend.rekeyLegacyFormOwners !== 'function') {
      throw new Error('migrateLegacyFormOwners: backend does not implement rekeyLegacyFormOwners (PG asset backend lands after G2.2). The startup gate (assertStrictOwnerMigrationComplete) is real and enforced; strict cannot be flipped until all three domain detectors + migrations land.')
    }
    return backend.rekeyLegacyFormOwners(resolver)
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
    isUploader,
    refcount,
    ownerBytes,
    scrubAssetIntegrity,
    countLegacyFormOwners,
    migrateLegacyFormOwners,
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
