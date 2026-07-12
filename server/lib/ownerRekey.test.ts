// ownerRekey.test.ts
// G2.2 D3:三域 owner rekey(fingerprint→SSO username)端到端——InMemory 三 backend(persist + permissions + assets)
// seed legacy 指纹 owner → migrateAllDomainsLegacyOwnersToUsernameForm → 三域 detector=0 → strict gate 通过。
// + unmapped no-go:resolver 返 undefined → unmapped>0,detector 仍 >0,strict gate 拒启动(fail-closed)。

import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryPersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend } from './permissions'
import { createAssetStore, createMemoryAssetBackend, createFsAssetBackend } from './assetStore'
import {
  assertStrictOwnerMigrationComplete,
  buildStartupDetectors,
  migrateAllDomainsLegacyOwnersToUsernameForm,
} from './owner'

// legacy 指纹形态(16-hex,sha256[:16]);SSO username(email-style,含 @)。
const FP_ALICE = 'a1b2c3d4e5f6a7b8'
const FP_BOB = '0123456789abcdef'
const USERNAME_ALICE = 'alice@xd.com'
const USERNAME_BOB = 'bob@xd.com'

const buildBackends = () => ({
  persist: new InMemoryPersistBackend(),
  permissions: new InMemoryPermissionBackend(),
  assetStore: createAssetStore(createMemoryAssetBackend()),
})

const seedLegacy = async (b: ReturnType<typeof buildBackends>): Promise<void> => {
  // persist 域:project + canvas under FP_ALICE(ownerId=指纹);chat-message under FP_ALICE(actor=指纹);
  // idempotency index entry under FP_ALICE。
  await b.persist.ensureCreate(FP_ALICE, 'project', 'p1', { title: 'p' }, { method: 'POST', resourceKind: 'project', idempotencyKey: 'k1' })
  await b.persist.createCanvasWithCollection(FP_ALICE, 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
  await b.persist.ensureCreateChild(FP_ALICE, 'c1', 'chat-message', 'm1', { text: 'hi' }, { method: 'POST', resourceKind: 'chat-message' })
  // permissions 域:share_link created_by=FP_ALICE。
  await b.permissions.createShareLink('p1', 'view', FP_ALICE)
  // assets 域:record.ownerFp=FP_ALICE + reference.ownerFp=FP_ALICE + uploader=FP_ALICE。
  const bytes = Buffer.from('fake-bytes-alice')
  const { assetId } = await b.assetStore.upload(bytes, 'image/png', 'a.png', FP_ALICE)
  await b.assetStore.attach(assetId, 'n1', FP_ALICE)
}

describe('G2.2 D3 — 三域 owner rekey(InMemory persist + permissions + assets)', () => {
  it('seed 后三域 detector 报 legacy>0(指纹 owner 存在)', async () => {
    const b = buildBackends()
    await seedLegacy(b)
    expect(await b.persist.countLegacyFormOwners!()).toBe(1)
    expect(await b.permissions.countLegacyFormOwners!()).toBe(1)
    expect(await b.assetStore.countLegacyFormOwners!()).toBe(1)
  })

  it('migrateAllDomainsLegacyOwnersToUsernameForm:resolver 全映射 → 三域 migrated + detector=0 + strict gate 通过', async () => {
    const b = buildBackends()
    await seedLegacy(b)
    const resolver = (fp: string): string | undefined => {
      if (fp === FP_ALICE) return USERNAME_ALICE
      if (fp === FP_BOB) return USERNAME_BOB
      return undefined
    }
    const r = await migrateAllDomainsLegacyOwnersToUsernameForm(b, resolver)
    expect(r.failed).toEqual([])
    expect(r.unmapped).toBe(0)
    expect(r.migrated).toBeGreaterThanOrEqual(1) // 至少 FP_ALICE 一处(三域各计,但 owner 维度去重可能跨域累计)
    // 三域 detector 全 0(rekey 后无 legacy 指纹)。
    expect(await b.persist.countLegacyFormOwners!()).toBe(0)
    expect(await b.permissions.countLegacyFormOwners!()).toBe(0)
    expect(await b.assetStore.countLegacyFormOwners!()).toBe(0)
    // strict gate 通过(strict + 三域 0 legacy → 不拒启动)。
    const detectors = buildStartupDetectors({ persist: b.persist, permissions: b.permissions, assetStore: b.assetStore })
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors)).resolves.toBeUndefined()
  })

  it('unmapped no-go:resolver 返 undefined → unmapped>0,detector 仍 >0,strict gate 拒启动(fail-closed)', async () => {
    const b = buildBackends()
    await seedLegacy(b)
    // resolver 对 FP_ALICE 返 undefined(不可唯一映射 → no-go)。
    const resolver = (): string | undefined => undefined
    const r = await migrateAllDomainsLegacyOwnersToUsernameForm(b, resolver)
    expect(r.unmapped).toBeGreaterThanOrEqual(1)
    expect(r.migrated).toBe(0)
    // 三域 detector 仍 >0(legacy 留存,no-go)。
    expect(await b.persist.countLegacyFormOwners!()).toBe(1)
    expect(await b.permissions.countLegacyFormOwners!()).toBe(1)
    expect(await b.assetStore.countLegacyFormOwners!()).toBe(1)
    // strict gate 拒启动(fail-closed;legacy>0)。
    const detectors = buildStartupDetectors({ persist: b.persist, permissions: b.permissions, assetStore: b.assetStore })
    await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors)).rejects.toThrow(/legacy-form owner/)
  })

  it('migrate 幂等:再跑一次(已 username 形态不再匹配 16-hex)→ migrated=0,unmapped=0,detector 仍 0', async () => {
    const b = buildBackends()
    await seedLegacy(b)
    const resolver = (fp: string): string | undefined => (fp === FP_ALICE ? USERNAME_ALICE : undefined)
    await migrateAllDomainsLegacyOwnersToUsernameForm(b, resolver)
    // 第二次跑:无 legacy 残留 → 0 迁移。
    const r2 = await migrateAllDomainsLegacyOwnersToUsernameForm(b, resolver)
    expect(r2.migrated).toBe(0)
    expect(r2.unmapped).toBe(0)
    expect(await b.persist.countLegacyFormOwners!()).toBe(0)
  })

  it('rekey 后 owner GET /chat 仍见历史(归属未丢):persist 按 username 查得 chat-message', async () => {
    const b = buildBackends()
    await seedLegacy(b)
    const resolver = (fp: string): string | undefined => (fp === FP_ALICE ? USERNAME_ALICE : undefined)
    await migrateAllDomainsLegacyOwnersToUsernameForm(b, resolver)
    // owner 按 username 查 chat-message(G2.2 §3.1 验收:换键后 owner GET /chat 仍见历史)。
    const list = await b.persist.listByOwner(USERNAME_ALICE, 'chat-message')
    expect(list.records.length).toBe(1)
    expect(list.records[0].id).toBe('m1')
    expect(list.records[0].ownerId).toBe(USERNAME_ALICE)
    // idempotency_index replay 不串:按 username 查 idem 命中。
    const repl = await b.persist.get(USERNAME_ALICE, 'project', 'p1')
    expect(repl.kind).toBe('found')
  })
})

describe('G2.2/P1-3 — fs detector/rekey strict scan(坏 meta fail-closed,防 strict gate 假绿)', () => {
  const BAD_HASH = 'ab' + '0'.repeat(62) // valid hex64, shard prefix 'ab'

  it('malformed meta JSON → countLegacyFormOwners 抛错(不静默跳)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mivo-strict-'))
    try {
      mkdirSync(join(dir, 'ab'), { recursive: true })
      writeFileSync(join(dir, 'ab', `${BAD_HASH}.meta.json`), '{ not valid json')
      const store = createAssetStore(createFsAssetBackend(dir))
      await expect(store.countLegacyFormOwners!()).rejects.toThrow(/strict scan: malformed meta JSON/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('meta schema invalid(缺 contentHash/references)→ 抛错带路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mivo-strict-'))
    try {
      mkdirSync(join(dir, 'ab'), { recursive: true })
      // valid JSON 但缺 contentHash/references → schema invalid。
      writeFileSync(join(dir, 'ab', `${BAD_HASH}.meta.json`), JSON.stringify({ foo: 'bar' }))
      const store = createAssetStore(createFsAssetBackend(dir))
      await expect(store.countLegacyFormOwners!()).rejects.toThrow(/strict scan: meta schema invalid/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('valid record → countLegacyFormOwners 不抛;空 store(根 ENOENT)→ 返 0', async () => {
    // 空 store(根目录不存在)→ 合法空,返 0(不抛)。
    const emptyStore = createAssetStore(createFsAssetBackend(join(tmpdir(), `mivo-empty-${Date.now()}`)))
    expect(await emptyStore.countLegacyFormOwners!()).toBe(0)
    // valid record(legacy ownerFp)→ 返 1。
    const dir = mkdtempSync(join(tmpdir(), 'mivo-strict-ok-'))
    try {
      const store = createAssetStore(createFsAssetBackend(dir))
      await store.upload(Buffer.from('valid-bytes'), 'image/png', 'a.png', FP_ALICE)
      expect(await store.countLegacyFormOwners!()).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('malformed meta → migrateLegacyFormOwners 也抛错(rekey 用同 strict scan)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mivo-strict-rekey-'))
    try {
      mkdirSync(join(dir, 'ab'), { recursive: true })
      writeFileSync(join(dir, 'ab', `${BAD_HASH}.meta.json`), '{ broken')
      const store = createAssetStore(createFsAssetBackend(dir))
      await expect(store.migrateLegacyFormOwners!(() => USERNAME_ALICE)).rejects.toThrow(/strict scan/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G2.2/P1-2 — persist rekey dp4 §3.1 no-go 预审(legacy chat owner === canvas owner)', () => {
  it('legacy chat-message owner_id ≠ canvas owner → persist migrate 抛错 no-go(不静默 carry over)', async () => {
    const persist = new InMemoryPersistBackend()
    await persist.ensureCreate(FP_ALICE, 'project', 'p1', { title: 'p' }, { method: 'POST', resourceKind: 'project' })
    await persist.createCanvasWithCollection(FP_ALICE, 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    // anomalous:legacy chat-message under FP_BOB(≠ canvas owner FP_ALICE)→ dp4 §3.1 no-go。
    await persist.ensureCreateChild(FP_BOB, 'c1', 'chat-message', 'm-bob', { text: 'hi' }, { method: 'POST', resourceKind: 'chat-message' })
    const resolver = (fp: string): string | undefined => (fp === FP_ALICE ? USERNAME_ALICE : fp === FP_BOB ? USERNAME_BOB : undefined)
    // 直接调 persist 域 migrate(orchestrator 把域错误捕入 failed,但 persist 域本身须 no-go 抛错)。
    await expect(persist.migrateLegacyOwnersToUsernameForm!(resolver))
      .rejects.toThrow(/dp4 §3\.1 no-go: legacy chat-message.*owner_id.*!== canvas.*owner/)
    // 未 mutation(no-go 前 0 mutation):FP_BOB 名下 chat 仍在。
    const list = await persist.listByOwner(FP_BOB, 'chat-message')
    expect(list.records.length).toBe(1)
    expect(list.records[0].ownerId).toBe(FP_BOB)
  })

  it('legacy chat-message owner_id === canvas owner(正常)→ migrate 不抛(owner 自己的 chat)', async () => {
    const persist = new InMemoryPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    await persist.ensureCreate(FP_ALICE, 'project', 'p1', { title: 'p' }, { method: 'POST', resourceKind: 'project' })
    await persist.createCanvasWithCollection(FP_ALICE, 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
    await persist.ensureCreateChild(FP_ALICE, 'c1', 'chat-message', 'm-alice', { text: 'hi' }, { method: 'POST', resourceKind: 'chat-message' })
    const resolver = (fp: string): string | undefined => (fp === FP_ALICE ? USERNAME_ALICE : undefined)
    const r = await migrateAllDomainsLegacyOwnersToUsernameForm({ persist, permissions, assetStore }, resolver)
    expect(r.failed).toEqual([])
    // owner GET /chat 仍见(换键后 owner_id = username)。
    const list = await persist.listByOwner(USERNAME_ALICE, 'chat-message')
    expect(list.records.length).toBe(1)
  })
})

describe('G2.2/P2-5 — orchestrator assets 域 fallback FS store(service off + 磁盘 legacy assets)', () => {
  it('assetStore:null 时按 resolveAssetStoreDir() 构造 FS store 迁移磁盘 legacy assets(不静默跳)', async () => {
    // 用独立 temp dir 作 asset root(避免污染 ~/.mivo-canvas/assets)。
    const dir = mkdtempSync(join(tmpdir(), 'mivo-p25-'))
    const prevDir = process.env.MIVO_ASSET_STORE_DIR
    process.env.MIVO_ASSET_STORE_DIR = dir
    try {
      // seed:磁盘上放一个 legacy ownerFp asset。
      const seedStore = createAssetStore(createFsAssetBackend(dir))
      await seedStore.upload(Buffer.from('p25-bytes'), 'image/png', 'a.png', FP_ALICE)
      // detector(assetStore=null → buildStartupDetectors 构造 FS detector)报 legacy=1。
      const persist = new InMemoryPersistBackend()
      const permissions = new InMemoryPermissionBackend()
      const before = await buildStartupDetectors({ persist, permissions, assetStore: null })
        .find((d) => d.domain === 'assets')!.countLegacyFormOwners!()
      expect(before).toBe(1)
      // orchestrator(assetStore=null)→ 内部构造 FS store 迁移磁盘 legacy assets。
      const r = await migrateAllDomainsLegacyOwnersToUsernameForm(
        { persist, permissions, assetStore: null },
        (fp) => (fp === FP_ALICE ? USERNAME_ALICE : undefined),
      )
      expect(r.failed).toEqual([])
      expect(r.migrated).toBeGreaterThanOrEqual(1)
      // 迁移后磁盘 record ownerFp = username;detector=0。
      const after = await buildStartupDetectors({ persist, permissions, assetStore: null })
        .find((d) => d.domain === 'assets')!.countLegacyFormOwners!()
      expect(after).toBe(0)
      // strict gate 通过(三域 0 legacy)。
      const detectors = buildStartupDetectors({ persist, permissions, assetStore: null })
      await expect(assertStrictOwnerMigrationComplete({ MIVO_SSO_STRICT: '1' }, detectors)).resolves.toBeUndefined()
    } finally {
      if (prevDir === undefined) delete process.env.MIVO_ASSET_STORE_DIR
      else process.env.MIVO_ASSET_STORE_DIR = prevDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
