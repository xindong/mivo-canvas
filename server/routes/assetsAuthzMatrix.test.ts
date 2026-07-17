// assetsAuthzMatrix.test.ts
// G2.2 D4:attach/detach/upload 权限路由矩阵——owner/editor/viewer/匿名share(view/edit) × attach/detach/upload。
// 双后端组合:InMemory(总是跑)+ PG(MIVO_PG_TEST=1 时跑;镜像同矩阵,SC2 双绿)。
//
// 矩阵(decision 1/2 双门谓词):
//   - upload(POST /api/assets):owner-scoped,任何已认证 actor 可上传(成为 uploader);矩阵各角色 upload 均 200。
//   - attach:gate ① actor 对目标 canvas 有 write + node 属该 canvas;gate ② actor 是 uploader OR 己方 ref OR
//     经引用画布获 view(read)entitlement(actorHasCanvasAccess;**不支持 share-token 传递性 view**——share token 是
//     per-request 目标画布凭证,不能证明对其他画布的访问;share-edit 用户 attach owner 的 asset 若非 uploader → 403)。
//   - detach:gate ① 目标引用所在 canvas 的 write 权(新 ref ref.canvasId;legacy ref 回退 ownerFp 校验)。
//
// 预期(owner/editor/viewer/share-view/share-edit × attach/detach/upload):
//   owner:     upload 200 | attach 200(uploader+write) | detach 200(write)
//   editor:    upload 200 | attach 200(view-via-referencing-canvas:editor 对引用画布有 read) | detach 200(write)
//   viewer:    upload 200 | attach 403(viewer=read,no write,gate① fail) | detach 403
//   share-view: upload 200 | attach 403(share-view=read,no write) | detach 403
//   share-edit: upload 200 | attach 403(gate① write ok 但 gate② 无 asset 关系;share-token 不支持传递性 view)
//             | detach 200(gate① write ok via resolveCanvasAccess share-edit 处理)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import sharp from 'sharp'
import { Pool } from 'pg'
import { createAssetRoutes } from './assets'
import { createAssetStore, createMemoryAssetBackend, createFsAssetBackend, type AssetStore } from '../lib/assetStore'
import { resetDecodeGate } from '../lib/decodeGate'
import { fingerprintOfPlatformKey } from '../lib/keys'
import { createPersistBackend, type PersistBackend } from '../persist/backend'
import { InMemoryPermissionBackend, type PermissionBackend } from '../lib/permissions'
import { PgPersistBackend } from '../persist/pgBackend'
import { PgPermissionBackend } from '../persist/pgPermissionBackend'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppEnv } from '../lib/types'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'

const MIVO_KEY_OWNER = 'mivo_owner_aaa'
const MIVO_KEY_EDITOR = 'mivo_editor_bb'
const MIVO_KEY_VIEWER = 'mivo_viewer_cc'
const MIVO_KEY_SHARE_EDIT = 'mivo_shareedit_dd'
const MIVO_KEY_OUTSIDER = 'mivo_outsider_ee' // 对 owner 画布无任何关系(非 member,无 share token)
const FP_OWNER = fingerprintOfPlatformKey(MIVO_KEY_OWNER)
const FP_EDITOR = fingerprintOfPlatformKey(MIVO_KEY_EDITOR)
const FP_VIEWER = fingerprintOfPlatformKey(MIVO_KEY_VIEWER)
const FP_OUTSIDER = fingerprintOfPlatformKey(MIVO_KEY_OUTSIDER)
const hdr = (key: string, shareToken?: string): Record<string, string> => {
  const h: Record<string, string> = { 'x-mivo-api-key': key }
  if (shareToken) h['x-mivo-share-token'] = shareToken
  return h
}

const realPng = async (color: { r: number; g: number; b: number } = { r: 255, g: 0, b: 0 }): Promise<Buffer> =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer()

type Fixture = {
  app: Hono<AppEnv>
  ids: { project: string; canvas: string; node: string; node2: string }
  assetId: string
  tokens: { view: string; edit: string }
}

const buildApp = (persist: PersistBackend, permissions: PermissionBackend, assetStore: AssetStore): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api', createAssetRoutes({ store: assetStore, persist, permissions }))
  return app
}

/**
 * Seed:OWNER 创建 project P + canvas C + nodes N/N2 + 上传 asset A + attach A 到 N/C(owner ref)。
 * + 加 EDITOR/VIEWER 为 P 成员 + 建 share-link view/edit。返回 ids + tokens + assetId。
 */
const seedFixture = async (
  persist: PersistBackend,
  permissions: PermissionBackend,
  _assetStore: AssetStore,
  app: Hono<AppEnv>,
  suffix: string,
): Promise<Fixture> => {
  const ids = { project: `p-${suffix}`, canvas: `c-${suffix}`, node: `n-${suffix}`, node2: `n2-${suffix}` }
  await persist.ensureCreate(FP_OWNER, 'project', ids.project, { title: 'p' }, { method: 'POST', resourceKind: 'project' })
  await persist.createCanvasWithCollection(FP_OWNER, ids.canvas, { projectId: ids.project }, { method: 'POST', resourceKind: 'canvas' })
  await persist.ensureCreateChild(FP_OWNER, ids.canvas, 'node', ids.node, { type: 'image' }, { method: 'POST', resourceKind: 'node' })
  await persist.ensureCreateChild(FP_OWNER, ids.canvas, 'node', ids.node2, { type: 'image' }, { method: 'POST', resourceKind: 'node' })
  await permissions.upsertMember(ids.project, FP_EDITOR, 'editor')
  await permissions.upsertMember(ids.project, FP_VIEWER, 'viewer')
  const viewLink = await permissions.createShareLink(ids.project, 'view', FP_OWNER)
  const editLink = await permissions.createShareLink(ids.project, 'edit', FP_OWNER)
  const bytes = await realPng()
  const form = new FormData()
  form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
  const upRes = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_OWNER), body: form })
  expect(upRes.status).toBe(200)
  const assetId = ((await upRes.json()) as { assetId: string }).assetId
  const attRes = await app.request(`/api/assets/${assetId}/attach`, {
    method: 'POST',
    headers: { ...hdr(MIVO_KEY_OWNER), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: ids.node, canvasId: ids.canvas }),
  })
  expect(attRes.status).toBe(200)
  return { app, ids, assetId, tokens: { view: viewLink.token, edit: editLink.token } }
}

const attachReq = (app: Hono<AppEnv>, f: Fixture, key: string, shareToken: string | undefined, nodeId = f.ids.node2, canvasId = f.ids.canvas) =>
  app.request(`/api/assets/${f.assetId}/attach`, {
    method: 'POST',
    headers: { ...hdr(key, shareToken), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, canvasId }),
  })
const detachReq = (app: Hono<AppEnv>, f: Fixture, key: string, shareToken: string | undefined, nodeId = f.ids.node, canvasId = f.ids.canvas) =>
  app.request(`/api/assets/${f.assetId}/detach`, {
    method: 'POST',
    headers: { ...hdr(key, shareToken), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, canvasId }),
  })
let uploadCounter = 0
const uploadReq = async (app: Hono<AppEnv>, key: string) => {
  // 每次不同颜色 → 不同 content hash → 不与 owner 的红色 asset dedup(否则会把该角色注册成 owner asset
  //   的 uploader,污染 attach gate ② 的 isUploader 判定)。
  uploadCounter += 1
  const bytes = await realPng({ r: (uploadCounter % 64) * 4, g: ((uploadCounter * 7) % 64) * 4, b: ((uploadCounter * 13) % 64) * 4 })
  const form = new FormData()
  form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
  return app.request('/api/assets', { method: 'POST', headers: hdr(key), body: form })
}

/** GET /api/assets/:id with optional share token. P1-1: read entitlement via referencing canvas. */
const getReq = (app: Hono<AppEnv>, f: Fixture, key: string, shareToken?: string) =>
  app.request(`/api/assets/${f.assetId}`, { method: 'GET', headers: hdr(key, shareToken) })

/**
 * 矩阵断言(双后端共用;makeBackends 构造 persist+permissions+assetStore+app)。
 */
const runMatrix = (
  label: string,
  makeBackends: () => Promise<{ persist: PersistBackend; permissions: PermissionBackend; assetStore: AssetStore; app: Hono<AppEnv> }>,
): void => {
  let counter = 0
  beforeEach(() => { counter += 1 })

  it(`${label} owner: upload 200 | attach 200(uploader+write) | detach 200(write)`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `own-${counter}`)
    expect((await uploadReq(app, MIVO_KEY_OWNER)).status).toBe(200)
    expect((await attachReq(app, f, MIVO_KEY_OWNER, undefined)).status).toBe(200)
    expect((await detachReq(app, f, MIVO_KEY_OWNER, undefined)).status).toBe(200)
  })

  it(`${label} editor: upload 200 | attach 200(view-via-referencing-canvas) | detach 200(write)`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `ed-${counter}`)
    expect((await uploadReq(app, MIVO_KEY_EDITOR)).status).toBe(200)
    // editor attach A 到 N2/C:gate① editor write on C ✓;gate② A referenced in C(owner ref,canvasId=C),
    //   editor 对 C 有 read(member editor)→ view-via-referencing-canvas ✓ → 200。
    expect((await attachReq(app, f, MIVO_KEY_EDITOR, undefined)).status).toBe(200)
    expect((await detachReq(app, f, MIVO_KEY_EDITOR, undefined)).status).toBe(200)
  })

  it(`${label} viewer: upload 200 | attach 403(no write) | detach 403(no write)`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `vw-${counter}`)
    expect((await uploadReq(app, MIVO_KEY_VIEWER)).status).toBe(200)
    expect((await attachReq(app, f, MIVO_KEY_VIEWER, undefined)).status).toBe(403)
    expect((await detachReq(app, f, MIVO_KEY_VIEWER, undefined)).status).toBe(403)
  })

  it(`${label} share-view: upload 200 | attach 403 | detach 403`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `sv-${counter}`)
    expect((await uploadReq(app, MIVO_KEY_SHARE_EDIT)).status).toBe(200)
    expect((await attachReq(app, f, MIVO_KEY_SHARE_EDIT, f.tokens.view)).status).toBe(403)
    expect((await detachReq(app, f, MIVO_KEY_SHARE_EDIT, f.tokens.view)).status).toBe(403)
  })

  it(`${label} share-edit: upload 200 | attach 403(gate② fail,share-token 不支持传递性 view) | detach 200`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `se-${counter}`)
    expect((await uploadReq(app, MIVO_KEY_SHARE_EDIT)).status).toBe(200)
    expect((await attachReq(app, f, MIVO_KEY_SHARE_EDIT, f.tokens.edit)).status).toBe(403)
    expect((await detachReq(app, f, MIVO_KEY_SHARE_EDIT, f.tokens.edit)).status).toBe(200)
  })

  it(`${label} P1-1 GET 矩阵:owner/editor/viewer/share-view/share-edit 对引用画布有 read → 200;outsider → 404`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `get-${counter}`)
    // asset A 已 attach 到 N/C(owner ref,canvasId=C);各角色对 C 有 read → view-via-referencing-canvas → 200。
    expect((await getReq(app, f, MIVO_KEY_OWNER)).status).toBe(200) // uploader
    expect((await getReq(app, f, MIVO_KEY_EDITOR)).status).toBe(200) // editor member,read on C
    expect((await getReq(app, f, MIVO_KEY_VIEWER)).status).toBe(200) // viewer member,read on C
    expect((await getReq(app, f, MIVO_KEY_SHARE_EDIT, f.tokens.view)).status).toBe(200) // share-view,read on C
    expect((await getReq(app, f, MIVO_KEY_SHARE_EDIT, f.tokens.edit)).status).toBe(200) // share-edit,read on C
    // outsider(非 member,无 share token,非 uploader)→ 无 read entitlement → 404(无存在性泄漏)。
    expect((await getReq(app, f, MIVO_KEY_OUTSIDER)).status).toBe(404)
  })

  it(`${label} P1-4 复合键:两 canvas 同 nodeId attach(service 级)→ 两条独立 ref;detach 一方不影响他方`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `p14-${counter}`)
    // service 级直接 attach(bypass route gate①)——复合键是 service 层 defense-in-depth:route gate① 已按
    //   persist (owner,type,id) 全局键阻同 nodeId 跨 canvas,但未来 G1-c 节点生命周期调用方若不走路由 gate①,
    //   service 仍须按 (canvasId,nodeId) 复合键防同 nodeId 跨 canvas 串引用(sol 实测:裸 nodeId dedup →
    //   canvas-b attach 返 already-attached 只留 canvas-a 的 ref)。canvas-a/canvas-b 是任意字符串(service 不验存在)。
    const rA = await assetStore.attach(f.assetId, f.ids.node, FP_OWNER, undefined, 'canvas-a')
    expect(rA).toEqual({ kind: 'attached' }) // seed ref canvasId=f.ids.canvas;新复合键 (canvas-a,node) → attached
    const rB = await assetStore.attach(f.assetId, f.ids.node, FP_OWNER, undefined, 'canvas-b')
    expect(rB).toEqual({ kind: 'attached' }) // (canvas-b,node) 与 (canvas-a,node)/(f.ids.canvas,node) 均不同
    // 幂等:同 (canvas-a, node) 再 attach → already-attached。
    const rA2 = await assetStore.attach(f.assetId, f.ids.node, FP_OWNER, undefined, 'canvas-a')
    expect(rA2).toEqual({ kind: 'already-attached' })
    const rec = await assetStore.getRecord(f.assetId)
    expect(rec!.references.length).toBe(3) // seed + canvas-a + canvas-b
    // detach (canvas-a, node) 只删该复合键;canvas-b + seed ref 保留。
    const dA = await assetStore.detach(f.assetId, f.ids.node, FP_OWNER, undefined, 'canvas-a')
    expect(dA).toEqual({ kind: 'detached' })
    const rec2 = await assetStore.getRecord(f.assetId)
    expect(rec2!.references.length).toBe(2)
    expect(rec2!.references.some((r) => r.canvasId === 'canvas-a')).toBe(false)
    expect(rec2!.references.some((r) => r.canvasId === 'canvas-b')).toBe(true)
  })

  it(`${label} SC1:无关系攻击者(outsider,非 member 非 uploader 无 share token)+ 他人 asset hash → attach 403`, async () => {
    const { persist, permissions, assetStore, app } = await makeBackends()
    const f = await seedFixture(persist, permissions, assetStore, app, `sc1-${counter}`)
    // outsider 自建可编辑 canvas+node(对自有 canvas 有 write)。
    const atkIds = { project: `p-atk-${counter}`, canvas: `c-atk-${counter}`, node: `n-atk-${counter}`, node2: `n2-atk-${counter}` }
    await persist.ensureCreate(FP_OUTSIDER, 'project', atkIds.project, { title: 'atk' }, { method: 'POST', resourceKind: 'project' })
    await persist.createCanvasWithCollection(FP_OUTSIDER, atkIds.canvas, { projectId: atkIds.project }, { method: 'POST', resourceKind: 'canvas' })
    await persist.ensureCreateChild(FP_OUTSIDER, atkIds.canvas, 'node', atkIds.node, { type: 'image' }, { method: 'POST', resourceKind: 'node' })
    // outsider 用 OWNER 的 hash attach 到自己的 canvas+node:
    //   gate① outsider write on atk-canvas ✓(owner of atk);gate② 非 uploader + 对 owner 的 C 无 read(非 member,
    //   无 share token)→ 无 view-via-referencing-canvas → 403(decidable,SC1)。
    const cross = await app.request(`/api/assets/${f.assetId}/attach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_OUTSIDER), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: atkIds.node, canvasId: atkIds.canvas }),
    })
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ error: 'forbidden' })
  })
}

beforeEach(() => resetDecodeGate())

// ── InMemory 矩阵 ──
describe('G2.2 D4 — attach/detach/upload 权限矩阵 (InMemory)', () => {
  runMatrix('InMemory', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    return { persist, permissions, assetStore, app: buildApp(persist, permissions, assetStore) }
  })
})

// G2.2 P1-4 残留2:route detach 键选择(exact / legacy fallback 不回填 / 无 body canvasId+新 ref / 双 canvas 不同 owner 同 nodeId)。
describe('G2.2 P1-4 残留2 — route detach 复合键选择(InMemory route 级)', () => {
  const seedOwnerCanvas = async (persist: PersistBackend, ownerKey: string, ids: { project: string; canvas: string; node: string }) => {
    const fp = fingerprintOfPlatformKey(ownerKey)
    await persist.ensureCreate(fp, 'project', ids.project, { title: 'p' }, { method: 'POST', resourceKind: 'project' })
    await persist.createCanvasWithCollection(fp, ids.canvas, { projectId: ids.project }, { method: 'POST', resourceKind: 'canvas' })
    await persist.ensureCreateChild(fp, ids.canvas, 'node', ids.node, { type: 'image' }, { method: 'POST', resourceKind: 'node' })
    return fp
  }

  it('exact:body 带 canvasId 命中精确 (canvasId,nodeId) 复合键 → detached', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    const app = buildApp(persist, permissions, assetStore)
    const f = await seedFixture(persist, permissions, assetStore, app, 'exact') // owner ref (node, canvas)
    const r = await detachReq(app, f, MIVO_KEY_OWNER, undefined) // body {nodeId, canvasId=f.ids.canvas}
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ kind: 'detached' })
  })

  it('legacy fallback:body 带 canvasId 但只有 legacy ref(无 canvasId)→ 命中 legacy ref + 传 undefined(禁回填)→ detached(非 already-detached)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    const app = buildApp(persist, permissions, assetStore)
    // service 级 attach 一个 legacy ref(无 canvasId)——模拟 G2.2 前写入的 ref。
    const bytes = await realPng()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
    const upRes = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_OWNER), body: form })
    const assetId = ((await upRes.json()) as { assetId: string }).assetId
    const fpOwner = fingerprintOfPlatformKey(MIVO_KEY_OWNER)
    await assetStore.attach(assetId, 'legacy-node', fpOwner) // legacy ref(无 canvasId)
    // route detach 带 canvasId(精确 (canvasId, 'legacy-node') 不存在)→ legacy fallback 命中 (null, 'legacy-node')
    //   + 传 ref.canvasId=undefined(禁回填 bodyCanvasId)→ backend 按 (null, nodeId) 命中 → detached。
    const r = await app.request(`/api/assets/${assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'legacy-node', canvasId: 'c-not-the-legacy-ref' }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ kind: 'detached' })
  })

  it('CR-6 legacy 路径:legacy ref(canvas-less)其 node 落在已归档 canvas → detach → 409 {error:"archived"}', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    const app = buildApp(persist, permissions, assetStore)
    // seed owner project + canvas + 真实 node(在 canvas 上)。
    const ids = { project: 'p-arch', canvas: 'c-arch', node: 'n-arch', node2: 'n2-arch' }
    await persist.ensureCreate(FP_OWNER, 'project', ids.project, { title: 'p' }, { method: 'POST', resourceKind: 'project' })
    await persist.createCanvasWithCollection(FP_OWNER, ids.canvas, { projectId: ids.project }, { method: 'POST', resourceKind: 'canvas' })
    await persist.ensureCreateChild(FP_OWNER, ids.canvas, 'node', ids.node, { type: 'image' }, { method: 'POST', resourceKind: 'node' })
    // upload asset(owner)。
    const bytes = await realPng()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
    const upRes = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_OWNER), body: form })
    expect(upRes.status).toBe(200)
    const assetId = ((await upRes.json()) as { assetId: string }).assetId
    // 创建 legacy ref(canvas-less)指向真实 node(模拟 G2.2 前写入的 ref)。
    await assetStore.attach(assetId, ids.node, FP_OWNER)
    // 归档 canvas(其上 node 仍在,canvas meta status→archived)。
    await persist.archiveCanvasTree(FP_OWNER, ids.canvas)
    // detach 带 canvasId='c-not-the-legacy-ref' → 精确 (canvasId,node) 不存在 → legacy fallback 命中 (null,node)
    //   → ref.canvasId undefined → CR-6 legacy 守卫:persist.get(FP_OWNER,'node',node) 命中 → canvasId=c-arch →
    //   persist.get(FP_OWNER,'canvas',c-arch) status=archived → 409 {error:'archived', id:c-arch}。
    const r = await app.request(`/api/assets/${assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: ids.node, canvasId: 'c-not-the-legacy-ref' }),
    })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'archived', id: ids.canvas })
  })

  it('无 body canvasId + 新 ref(有 canvasId)→ 只匹配 legacy(无)→ already-detached(新 ref 须显式 canvasId)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    const app = buildApp(persist, permissions, assetStore)
    const f = await seedFixture(persist, permissions, assetStore, app, 'nobody') // owner ref (node, canvas) 有 canvasId
    // route detach 只带 nodeId(无 canvasId)→ 只匹配 legacy ref(无,因 owner ref 有 canvasId)→ already-detached。
    const r = await app.request(`/api/assets/${f.assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: f.ids.node }), // 无 canvasId
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ kind: 'already-detached' })
    // ref 仍在(未误删):带 canvasId 仍可 detach。
    const r2 = await detachReq(app, f, MIVO_KEY_OWNER, undefined)
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ kind: 'detached' })
  })

  it('双 canvas 不同 owner 同 nodeId:两 ref 独立;detach 一方不影响他方(route 级,sol 指出不同 owner 可构造)', async () => {
    const persist = createPersistBackend()
    const permissions = new InMemoryPermissionBackend()
    const assetStore = createAssetStore(createMemoryAssetBackend())
    const app = buildApp(persist, permissions, assetStore)
    // A 的 canvas-a + node 'n-shared';B 的 canvas-b + node 'n-shared'(不同 persist owner → 两 node record)。
    const aIds = { project: 'pA', canvas: 'cA', node: 'n-shared' }
    const bIds = { project: 'pB', canvas: 'cB', node: 'n-shared' }
    await seedOwnerCanvas(persist, MIVO_KEY_OWNER, aIds)
    await seedOwnerCanvas(persist, MIVO_KEY_EDITOR, bIds)
    // B 加为 A 的 project viewer(使 B 对 canvas-a 有 read → gate② view-via-canvas-a 可 attach A 的 asset)。
    await permissions.upsertMember(aIds.project, FP_EDITOR, 'viewer')
    // A 上传 + attach 到 (n-shared, cA)。
    const bytes = await realPng()
    const form = new FormData()
    form.append('image', new File([bytes], 'a.png', { type: 'image/png' }), 'a.png')
    const upRes = await app.request('/api/assets', { method: 'POST', headers: hdr(MIVO_KEY_OWNER), body: form })
    const assetId = ((await upRes.json()) as { assetId: string }).assetId
    const attA = await app.request(`/api/assets/${assetId}/attach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n-shared', canvasId: 'cA' }),
    })
    expect(attA.status).toBe(200)
    // B attach 同 asset 到 (n-shared, cB):gate① B write on cB ✓ + node n-shared in cB ✓;gate② B 对 cA 有 read(viewer member)→ view-via-cA ✓。
    const attB = await app.request(`/api/assets/${assetId}/attach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_EDITOR), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n-shared', canvasId: 'cB' }),
    })
    expect(attB.status).toBe(200)
    expect(await attB.json()).toEqual({ kind: 'attached' }) // 非已存在附加——复合键 (cB, n-shared) ≠ (cA, n-shared)
    // A detach (n-shared, cA):只删 (cA, n-shared);(cB, n-shared) 保留。
    const detA = await app.request(`/api/assets/${assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_OWNER), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n-shared', canvasId: 'cA' }),
    })
    expect(detA.status).toBe(200)
    expect(await detA.json()).toEqual({ kind: 'detached' })
    // B 仍可 detach (n-shared, cB)——证明 cA detach 没误删 cB 的 ref。
    const detB = await app.request(`/api/assets/${assetId}/detach`, {
      method: 'POST',
      headers: { ...hdr(MIVO_KEY_EDITOR), 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n-shared', canvasId: 'cB' }),
    })
    expect(detB.status).toBe(200)
    expect(await detB.json()).toEqual({ kind: 'detached' })
  })
})

// ── PG 矩阵(MIVO_PG_TEST=1 时跑;镜像同矩阵,SC2 PG 组合双绿)──
const pgConn = () => ({
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_UNIT_DB_AUTHZ || 'mivocanvas_unit_authz',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
  maxConnections: 8,
  idleTimeoutMs: 5000,
  connectionTimeoutMs: 5000,
})

async function ensureAuthzDb(): Promise<void> {
  const cfg = pgConn()
  const admin = new Pool({ host: cfg.host, port: cfg.port, database: 'postgres', user: cfg.user, password: cfg.password, max: 1 })
  try {
    const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [cfg.database])
    if (res.rowCount === 0) {
      const dbName = String(cfg.database).replace(/"/g, '')
      await admin.query(`CREATE DATABASE "${dbName}"`)
    }
  } finally {
    await admin.end()
  }
}

;(PG_TEST_ENABLED ? describe : describe.skip)('G2.2 D4 — attach/detach/upload 权限矩阵 (PG)', () => {
  let sharedPool: Pool
  let persist: PgPersistBackend
  let permissions: PgPermissionBackend

  beforeAll(async () => {
    await ensureAuthzDb()
    const cfg = pgConn()
    sharedPool = new Pool({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, max: 8 })
    persist = new PgPersistBackend(cfg, sharedPool)
    permissions = new PgPermissionBackend(cfg, sharedPool)
    await persist.migrate()
    await Promise.all([persist.ready, permissions.ready])
  })
  afterAll(async () => {
    await persist.destroy()
    await permissions.destroy()
    await sharedPool.end()
  })
  beforeEach(async () => {
    // reset:permissions 先(share FK→projects),再 persist(TRUNCATE projects/canvases/persist_records/...)。
    await permissions.__reset()
    await persist.__reset()
  })

  runMatrix('PG', async () => {
    const assetDir = mkdtempSync(join(tmpdir(), 'mivo-authz-pg-'))
    const assetStore = createAssetStore(createFsAssetBackend(assetDir))
    return { persist, permissions, assetStore, app: buildApp(persist, permissions, assetStore) }
  })
})
