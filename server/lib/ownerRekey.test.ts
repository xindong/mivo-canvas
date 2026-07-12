// ownerRekey.test.ts
// G2.2 D3:三域 owner rekey(fingerprint→SSO username)端到端——InMemory 三 backend(persist + permissions + assets)
// seed legacy 指纹 owner → migrateAllDomainsLegacyOwnersToUsernameForm → 三域 detector=0 → strict gate 通过。
// + unmapped no-go:resolver 返 undefined → unmapped>0,detector 仍 >0,strict gate 拒启动(fail-closed)。

import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import { InMemoryPersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend } from './permissions'
import { createAssetStore, createMemoryAssetBackend } from './assetStore'
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
