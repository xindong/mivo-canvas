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
