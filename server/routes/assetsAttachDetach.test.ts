// assetsAttachDetach.test.ts
// G1-a P1-2 seam:asset attach/detach HTTP 路由(server/routes/assets.ts 新增)端到端。
//
// assetStore.attach/detach 已实现(内容寻址 + refcount = references.length + owner-checked),
// 但此前无 HTTP 入口 → refcount 恒 0。本测试覆盖新路由:
//  - attach 0→1 幂等(already-attached no-op);missing asset → 404 {kind:'missing'}。
//  - detach 1→0 幂等(already-detached no-op)。
//  - 跨 owner detach → 403 {kind:'owner-mismatch'} 且 ref 不变(decidable,不静默)。
// 节点生命周期调用方(node create/delete attach/detach)属 G1-c,本测试只验 route seam。

import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import sharp from 'sharp'
import { createAssetRoutes } from './assets'
import { createMemoryAssetBackend, type AssetStoreBackend } from '../lib/assetStore'
import { resetDecodeGate } from '../lib/decodeGate'
import type { AppEnv } from '../lib/types'

const MIVO_KEY_A = 'mivo_aaa_user_a'
const MIVO_KEY_B = 'mivo_bbb_user_b'
const hdr = (key: string): Record<string, string> => ({ 'x-mivo-api-key': key })

const buildApp = (backend: AssetStoreBackend): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api', createAssetRoutes({ backend }))
  return app
}

const realPng = async (): Promise<Buffer> =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()

const canonicalOf = async (bytes: Buffer): Promise<Buffer> => sharp(bytes, { animated: true }).toFormat('png').toBuffer()
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** upload an asset (KEY_A) → 返 assetId。 */
const uploadAsset = async (app: Hono<AppEnv>, key = MIVO_KEY_A): Promise<string> => {
  const bytes = await realPng()
  const form = new FormData()
  form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
  const res = await app.request('/api/assets', { method: 'POST', headers: hdr(key), body: form })
  expect(res.status).toBe(200)
  return ((await res.json()) as { assetId: string }).assetId
}

const attach = (app: Hono<AppEnv>, assetId: string, nodeId: string, key = MIVO_KEY_A) =>
  app.request(`/api/assets/${assetId}/attach`, {
    method: 'POST',
    headers: { ...hdr(key), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId }),
  })
const detach = (app: Hono<AppEnv>, assetId: string, nodeId: string, key = MIVO_KEY_A) =>
  app.request(`/api/assets/${assetId}/detach`, {
    method: 'POST',
    headers: { ...hdr(key), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId }),
  })

beforeEach(() => resetDecodeGate())

describe('G1-a P1-2 seam — POST /api/assets/:id/attach', () => {
  it('attach 0→1:首次 {kind:"attached"};同 (assetId,nodeId) 再 attach → {kind:"already-attached"}(幂等)', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const assetId = await uploadAsset(app)
    const r1 = await attach(app, assetId, 'n1')
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ kind: 'attached' })
    // 幂等:再 attach 同 (assetId, nodeId) → already-attached(no-op)
    const r2 = await attach(app, assetId, 'n1')
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ kind: 'already-attached' })
  })

  it('attach missing asset(合法 hex64 但无 record)→ 404 {kind:"missing"}(decidable,不静默)', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const missingId = '0'.repeat(64) // 合法 hex64 shape,但无 record
    const r = await attach(app, missingId, 'n1')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ kind: 'missing' })
  })

  it('attach 缺 nodeId → 400;invalid asset id(非 hex64)→ 404', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const assetId = await uploadAsset(app)
    const noNodeId = await app.request(`/api/assets/${assetId}/attach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(noNodeId.status).toBe(400)
    const badId = await attach(app, 'not-a-hash', 'n1')
    expect(badId.status).toBe(404)
  })
})

describe('G1-a P1-2 seam — POST /api/assets/:id/detach', () => {
  it('detach 1→0:attach 后 detach → {kind:"detached"};再 detach → {kind:"already-detached"}(幂等)', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const assetId = await uploadAsset(app)
    await attach(app, assetId, 'n1')
    const r1 = await detach(app, assetId, 'n1')
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ kind: 'detached' })
    // 幂等:ref 已不在 → already-detached
    const r2 = await detach(app, assetId, 'n1')
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ kind: 'already-detached' })
  })

  it('detach missing asset → 404 {kind:"missing"}(幂等 intent 已满足)', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const missingId = '0'.repeat(64)
    const r = await detach(app, missingId, 'n1')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ kind: 'missing' })
  })

  it('跨 owner detach → 403 {kind:"owner-mismatch"} 且 ref 不变(KEY_A 仍可 detach)', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const assetId = await uploadAsset(app, MIVO_KEY_A)
    await attach(app, assetId, 'n1', MIVO_KEY_A) // ref ownerFp = A
    // KEY_B(不同指纹)尝试 detach A 的 ref → owner-mismatch,不静默成功
    const cross = await detach(app, assetId, 'n1', MIVO_KEY_B)
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ kind: 'owner-mismatch' })
    // ref 不变:KEY_A 仍能 detach(detach 成功证明 ref 还在,跨 owner 没动它)
    const okAgain = await detach(app, assetId, 'n1', MIVO_KEY_A)
    expect(okAgain.status).toBe(200)
    expect(await okAgain.json()).toEqual({ kind: 'detached' })
  })
})

describe('G1-a P1-2 seam — refcount 经 attach/detach 变化(内容寻址 refcount = references.length)', () => {
  it('upload refcount=0;attach → 重新 upload 同图 refcount=1;detach 后 refcount=0', async () => {
    const app = buildApp(createMemoryAssetBackend())
    const bytes = await realPng()
    const canonical = await canonicalOf(bytes)
    const assetId = sha256Hex(canonical)
    const form = () => {
      const f = new FormData()
      f.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
      return f
    }
    // 首次 upload:refcount=0(upload 不 attach)
    const r1 = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_A), body: form() })
    const b1 = (await r1.json()) as { refcount: number }
    expect(b1.refcount).toBe(0)
    // attach n1
    await attach(app, assetId, 'n1')
    // 重新 upload 同图(dedup):refcount=1(ref 已存在)
    const r2 = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_A), body: form() })
    const b2 = (await r2.json()) as { refcount: number; deduped: boolean }
    expect(b2.refcount).toBe(1)
    expect(b2.deduped).toBe(true)
    // detach n1 → refcount 回 0
    await detach(app, assetId, 'n1')
    const r3 = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_A), body: form() })
    const b3 = (await r3.json()) as { refcount: number }
    expect(b3.refcount).toBe(0)
  })
})
