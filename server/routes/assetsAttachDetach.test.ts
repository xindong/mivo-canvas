// assetsAttachDetach.test.ts
// G2.2(decision 1/2):asset attach/detach canvas-authz 双门谓词端到端。
//
// attach 须同时过两道门:① actor 对目标 canvas 有 edit 权 + node 属该 canvas(权威反查);
// ② actor 是 uploader 或经引用画布获 view entitlement。detach 验引用画布 edit 权。
//
// 本测试覆盖:
//  - owner attach 0→1(gate ① owner write + gate ② uploader)→ 200 attached;幂等 already-attached。
//  - owner detach 1→0 → 200 detached;幂等 already-detached。
//  - missing asset → 404 {kind:'missing'};missing canvasId/nodeId → 400;invalid asset id → 404。
//  - SC1 负例:攻击者(OWNER_B)自建可编辑 canvas + 他人(OWNER_A)asset hash → attach 403。
//  - legacy 路径:ownerFp ref(无 canvasId 的 service 直调)→ owner-mismatch 保既有契约。
//
// 完整 owner/editor/viewer/匿名share × attach/detach/upload 矩阵见 assetsAuthzMatrix.test.ts(D4)。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import sharp from 'sharp'
import { createAssetRoutes } from './assets'
import { createAssetStore, createMemoryAssetBackend, type AssetStoreBackend, type AssetStore } from '../lib/assetStore'
import { resetDecodeGate } from '../lib/decodeGate'
import { fingerprintOfPlatformKey } from '../lib/keys'
import { createPersistBackend, type PersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend, type PermissionBackend } from '../lib/permissions'
import type { AppEnv } from '../lib/types'

const MIVO_KEY_A = 'mivo_aaa_user_a'
const MIVO_KEY_B = 'mivo_bbb_user_b'
const hdr = (key: string): Record<string, string> => ({ 'x-mivo-api-key': key })

const buildApp = (backend: AssetStoreBackend, persist: PersistBackend, permissions: PermissionBackend): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api', createAssetRoutes({ backend, persist, permissions }))
  return app
}

const realPng = async (): Promise<Buffer> =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()

const canonicalOf = async (bytes: Buffer): Promise<Buffer> => sharp(bytes, { animated: true }).toFormat('png').toBuffer()
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Seed a project + canvas + node for `ownerKey` (ownerId = fingerprint). Returns the ids.
 * Mirror how routes create them (ensureCreate project → createCanvasWithCollection → ensureCreateChild node).
 */
const seedCanvas = async (
  persist: PersistBackend,
  ownerKey: string,
  ids: { project: string; canvas: string; node: string },
): Promise<void> => {
  const ownerId = fingerprintOfPlatformKey(ownerKey)
  await persist.ensureCreate(ownerId, 'project', ids.project, { title: 'p' }, { method: 'POST', resourceKind: 'project' })
  await persist.createCanvasWithCollection(ownerId, ids.canvas, { projectId: ids.project, title: 'c' }, { method: 'POST', resourceKind: 'canvas' })
  await persist.ensureCreateChild(ownerId, ids.canvas, 'node', ids.node, { type: 'image' }, { method: 'POST', resourceKind: 'node' })
}

/** upload an asset (key) → 返 assetId。 */
const uploadAsset = async (app: Hono<AppEnv>, key = MIVO_KEY_A): Promise<string> => {
  const bytes = await realPng()
  const form = new FormData()
  form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
  const res = await app.request('/api/assets', { method: 'POST', headers: hdr(key), body: form })
  expect(res.status).toBe(200)
  return ((await res.json()) as { assetId: string }).assetId
}

const attach = (app: Hono<AppEnv>, assetId: string, nodeId: string, canvasId: string, key = MIVO_KEY_A) =>
  app.request(`/api/assets/${assetId}/attach`, {
    method: 'POST',
    headers: { ...hdr(key), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, canvasId }),
  })
const detach = (app: Hono<AppEnv>, assetId: string, nodeId: string, canvasId: string, key = MIVO_KEY_A) =>
  app.request(`/api/assets/${assetId}/detach`, {
    method: 'POST',
    headers: { ...hdr(key), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, canvasId }),
  })

beforeEach(() => resetDecodeGate())

describe('G2.2 decision 1/2 — POST /api/assets/:id/attach 双门谓词', () => {
  it('owner attach 0→1:gate ① owner write + gate ② uploader → 200 attached;幂等 → already-attached', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const assetId = await uploadAsset(app)
    const r1 = await attach(app, assetId, ids.node, ids.canvas)
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ kind: 'attached' })
    // 幂等:同 (assetId, nodeId, canvasId) 再 attach → already-attached
    const r2 = await attach(app, assetId, ids.node, ids.canvas)
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ kind: 'already-attached' })
  })

  it('attach missing asset(合法 hex64 无 record)→ 404 {kind:"missing"}', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const missingId = '0'.repeat(64)
    const r = await attach(app, missingId, ids.node, ids.canvas)
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ kind: 'missing' })
  })

  it('attach 缺 canvasId → 400;invalid asset id → 404;node 不属 canvas → 404 unknown-node', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const assetId = await uploadAsset(app)
    // 缺 canvasId
    const noCanvas = await app.request(`/api/assets/${assetId}/attach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: ids.node }),
    })
    expect(noCanvas.status).toBe(400)
    // invalid asset id(非 hex64)
    const badId = await app.request(`/api/assets/not-a-hash/attach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: ids.node, canvasId: ids.canvas }),
    })
    expect(badId.status).toBe(404)
    // node 不属该 canvas(node id 在该 canvas 不存在)→ 404 unknown-node
    const wrongNode = await attach(app, assetId, 'node-not-in-canvas', ids.canvas)
    expect(wrongNode.status).toBe(404)
    expect(await wrongNode.json()).toEqual({ error: 'unknown-node' })
  })

  it('SC1 负例:攻击者(OWNER_B)自建可编辑 canvas + 他人(OWNER_A)asset hash → attach 403', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    // A 上传 asset(A 持有 hash)
    const assetId = await uploadAsset(app, MIVO_KEY_A)
    // B 自建可编辑 canvas + node(B 是 owner,有 edit 权)
    const bIds = { project: 'pB', canvas: 'cB', node: 'nB' }
    await seedCanvas(persist, MIVO_KEY_B, bIds)
    // B 用 A 的 hash attach 到自己的 canvas+node:
    //   gate ① B 对 cB 有 write(owner)→ 过;gate ② B 非 uploader + 无引用画布 view → 403。
    const cross = await attach(app, assetId, bIds.node, bIds.canvas, MIVO_KEY_B)
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ error: 'forbidden' })
    // A 仍可正常 attach 自己的 asset 到自己的 canvas(gate ② uploader)→ 200
    const aIds = { project: 'pA', canvas: 'cA', node: 'nA' }
    await seedCanvas(persist, MIVO_KEY_A, aIds)
    const okAgain = await attach(app, assetId, aIds.node, aIds.canvas, MIVO_KEY_A)
    expect(okAgain.status).toBe(200)
    expect(await okAgain.json()).toEqual({ kind: 'attached' })
  })
})

describe('G2.2 decision 2 — POST /api/assets/:id/detach canvas-edit authz', () => {
  it('owner detach 1→0:attach 后 detach → 200 detached;幂等 → already-detached', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const assetId = await uploadAsset(app)
    await attach(app, assetId, ids.node, ids.canvas)
    const r1 = await detach(app, assetId, ids.node, ids.canvas)
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ kind: 'detached' })
    // 幂等:ref 已不在 → already-detached
    const r2 = await detach(app, assetId, ids.node, ids.canvas)
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ kind: 'already-detached' })
  })

  it('detach missing asset → 404 {kind:"missing"}(幂等 intent 已满足)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const missingId = '0'.repeat(64)
    const r = await detach(app, missingId, 'n1', 'c1')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ kind: 'missing' })
  })

  it('SC1 detach 负例:B 对 A 的 ref 所在 canvas 无 edit 权(非成员)→ 404 unknown-canvas(无泄漏);ref 不变(A 仍可 detach)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const aIds = { project: 'pA', canvas: 'cA', node: 'nA' }
    await seedCanvas(persist, MIVO_KEY_A, aIds)
    const assetId = await uploadAsset(app, MIVO_KEY_A)
    await attach(app, assetId, aIds.node, aIds.canvas, MIVO_KEY_A) // ref ownerFp=FP_A, canvasId=cA
    // B 尝试 detach A 在 cA 的 ref:B 对 cA 是非成员(无 member 行,无 share token)→ 404 unknown-canvas
    //   (无存在泄漏,G2.1 proof-gate 语义:非成员/无分享 deny → 404;成员/分享越权 deny → 403)。
    const cross = await detach(app, assetId, aIds.node, aIds.canvas, MIVO_KEY_B)
    expect(cross.status).toBe(404)
    expect(await cross.json()).toEqual({ error: 'unknown-canvas' })
    // ref 不变:A 仍能 detach(canvas-edit authz 过 + service 跳 ownerFp 检查因 ref 有 canvasId)
    const okAgain = await detach(app, assetId, aIds.node, aIds.canvas, MIVO_KEY_A)
    expect(okAgain.status).toBe(200)
    expect(await okAgain.json()).toEqual({ kind: 'detached' })
  })
})

describe('G2.2 — refcount 经 attach/detach 变化(内容寻址 refcount = references.length)', () => {
  it('upload refcount=0;attach → 重新 upload 同图 refcount=1;detach 后 refcount=0', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const bytes = await realPng()
    const canonical = await canonicalOf(bytes)
    const assetId = sha256Hex(canonical)
    const form = () => {
      const f = new FormData()
      f.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
      return f
    }
    const r1 = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_A), body: form() })
    expect(((await r1.json()) as { refcount: number }).refcount).toBe(0)
    await attach(app, assetId, ids.node, ids.canvas)
    const r2 = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_A), body: form() })
    const b2 = (await r2.json()) as { refcount: number; deduped: boolean }
    expect(b2.refcount).toBe(1)
    expect(b2.deduped).toBe(true)
    await detach(app, assetId, ids.node, ids.canvas)
    const r3 = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_A), body: form() })
    expect(((await r3.json()) as { refcount: number }).refcount).toBe(0)
  })
})

describe('CR-6(Phase 2 归档 write-guard)— archived canvas attach/detach → 409 {error:"archived"}', () => {
  // 守卫在 server/lib/projectAuthz.ts resolveCanvasAccess(canAccessCanvas deny 后、return ok 前),对齐
  // routes/canvas.ts authzCanvas:145-146;补齐资产 attach/detach 路径(走 resolveCanvasAccess 'write')的 CR-6
  // 覆盖(此前仅 authzCanvas 覆盖画布子记录写,资产 attach/detach 漏)。read/manage 放行(守卫只 write/move):
  // assets.ts:297 resolveCanvasAccess 'read'(资产可见性)+ attach gate ② actorHasCanvasAccess('read') 均不触发。
  it('archived canvas attach → 409 {error:"archived", id}(owner write 过 authz,archived write-guard 拒;非 403/404)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const assetId = await uploadAsset(app)
    // 归档画布(本 app 只挂 asset 路由,无 /:id/archive,直接调 persist.archiveCanvasTree)。
    const ownerId = fingerprintOfPlatformKey(MIVO_KEY_A)
    await persist.archiveCanvasTree(ownerId, ids.canvas)
    const r = await attach(app, assetId, ids.node, ids.canvas)
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'archived', id: ids.canvas })
  })

  it('archived canvas detach → 409 {error:"archived", id}(已有 ref 的 archived 画布 detach 被 write-guard 拒)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const app = buildApp(createMemoryAssetBackend(), persist, permissions)
    const ids = { project: 'p1', canvas: 'c1', node: 'n1' }
    await seedCanvas(persist, MIVO_KEY_A, ids)
    const assetId = await uploadAsset(app)
    // active 态先 attach 一条 ref(供 detach 目标)。
    const attached = await attach(app, assetId, ids.node, ids.canvas)
    expect(attached.status).toBe(200)
    // 归档画布 → detach 走 resolveCanvasAccess(ref.canvasId, 'write') 撞 archived guard → 409。
    const ownerId = fingerprintOfPlatformKey(MIVO_KEY_A)
    await persist.archiveCanvasTree(ownerId, ids.canvas)
    const r = await detach(app, assetId, ids.node, ids.canvas)
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'archived', id: ids.canvas })
  })
})

// P3 item 6:legacy detach 多 owner 歧义维持现状分支 → console.warn 计数留痕(行为不变,仍走 legacy detach)。
describe('P3 item 6 — legacy detach 多 owner 歧义计数日志', () => {
  const buildAppWithStore = (backend: AssetStoreBackend, persist: PersistBackend, permissions: PermissionBackend): { app: Hono<AppEnv>; store: AssetStore } => {
    const store = createAssetStore(backend)
    const app = new Hono<AppEnv>()
    app.route('/api', createAssetRoutes({ store, persist, permissions }))
    return { app, store }
  }

  it('多 owner 撞名且无己方命中 → 歧义维持现状(legacy detach) + console.warn 留痕', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const { app, store } = buildAppWithStore(createMemoryAssetBackend(), persist, permissions)
    // 两个不同 owner 各自建同名 node 'n1'(live,挂各自 canvas)→ findNodeOwners('n1') 返 2 候选,无 ownerA 命中
    await seedCanvas(persist, MIVO_KEY_B, { project: 'pB', canvas: 'cB', node: 'n1' })
    await seedCanvas(persist, 'mivo_ccc_user_c', { project: 'pC', canvas: 'cC', node: 'n1' })
    // ownerA 上传 asset(无 n1 node)+ 直接 store.attach 建 legacy ref(canvasId=undefined,ownerFp=ownerA)
    const assetId = await uploadAsset(app)
    const ownerA = fingerprintOfPlatformKey(MIVO_KEY_A)
    await store.attach(assetId, 'n1', ownerA) // legacy ref(无 canvasId)
    // ownerA detach(无 bodyCanvasId → legacy ref 命中,ref.ownerFp===ownerFp)→ 歧义分支 → console.warn + legacy detach 200
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await app.request(`/api/assets/${assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1' }),
    })
    const warnCalls = warnSpy.mock.calls // P3:mockRestore 会清 mock.calls,先捕获
    warnSpy.mockRestore()
    // 行为不变:legacy detach 走 store.detach(owner 匹配)→ 200 detached
    expect(res.status).toBe(200)
    // 留痕:一条结构化 JSON(event/candidateCount/nodeId)
    const ambiguityCalls = warnCalls.filter((c) => {
      try { return JSON.parse(c[0] as string).event === 'detach-multi-owner-ambiguity' } catch { return false }
    })
    expect(ambiguityCalls).toHaveLength(1)
    const payload = JSON.parse(ambiguityCalls[0]![0] as string)
    expect(payload.candidateCount).toBe(2)
    expect(payload.nodeId).toEqual(expect.any(String)) // shortHash(nodeId),非裸 nodeId
  })

  it('仅 1 候选或己方命中 → 不触发歧义日志(不误记)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const { app, store } = buildAppWithStore(createMemoryAssetBackend(), persist, permissions)
    // 仅 ownerB 建 n1(liveCandidates=1)→ 不歧义(走 authoritative 单候选判定或 legacy detach,无歧义日志)
    await seedCanvas(persist, MIVO_KEY_B, { project: 'pB', canvas: 'cB', node: 'n1' })
    const assetId = await uploadAsset(app)
    const ownerA = fingerprintOfPlatformKey(MIVO_KEY_A)
    await store.attach(assetId, 'n1', ownerA)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await app.request(`/api/assets/${assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_A), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1' }),
    })
    const warnCalls = warnSpy.mock.calls
    warnSpy.mockRestore()
    expect(res.status).toBe(200)
    const ambiguityCalls = warnCalls.filter((c) => {
      try { return JSON.parse(c[0] as string).event === 'detach-multi-owner-ambiguity' } catch { return false }
    })
    expect(ambiguityCalls).toHaveLength(0) // 单候选不歧义,不记
  })
})
