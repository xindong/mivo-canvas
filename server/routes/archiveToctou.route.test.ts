// server/routes/archiveToctou.route.test.ts
// CR-6 缺口2(PR-A #266 backlog):per-canvas TOCTOU 检查时守卫——route 级并发穿透回归。
//
// 窗口:route authzCanvas('write') 在 check-time 判 status,backend 写入在 write-time 落盘;两者之间
// 并发 archive 提交 → 旧实现写入照常成功(穿透:archived canvas 收到子记录写)。本套件用 backend 子类
// 在「authz 已过、写入将发生」的精确时点插入 archiveCanvasTree(确定性复现竞态,非 sleep 赌时序),
// 断言:写入被 write-time 守卫(ArchivedCanvasWriteError → 顶层 ssoAuthErrorHandler structural 分支)
// 拒绝为 409 {error:'archived', id},且 archived canvas 零新增子记录。
//
// PG 路径等价证据:backend.contract.dual.test.ts「CR-6 缺口2」describe(memory+PG 双后端,写入时刻已
// archived → throw)+ pgBackend.assertCanvasWritableInTrx 的事务内 SELECT...FOR UPDATE(与 archive tree
// 的 canvas 行 UPDATE 串行化——archive 先提交则守卫必见 archived,写先锁行则 archive 阻塞;测试设施无
// 事务中途暂停注入点,采用「事务语义单测 + 说明」,见 PR 描述)。
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { ssoAuthErrorHandler } from '../lib/owner'
import { createCanvasRoutes } from './canvas'
import { createProjectsRoutes } from './projects'
import { InMemoryPersistBackend, type EnsureChildResult, type UpsertChildResult, type PersistType } from '../persist/backend'
import { InMemoryPermissionBackend } from '../lib/permissions'
import { fingerprintOfPlatformKey } from '../lib/keys'

const KEY_A = 'mivo_toctou_owner'
const FP_A = fingerprintOfPlatformKey(KEY_A)
const hdr = (key: string): Record<string, string> => ({ 'x-mivo-api-key': key, 'content-type': 'application/json' })

/** 竞态注入 backend:在指定写方法进入时(= route authz 已通过后)先提交 archive,再走真实写路径。 */
class RaceInjectingBackend extends InMemoryPersistBackend {
  /** 置 canvasId → 下一次子写前先 archive 它(单发,防 seed 阶段误触发)。 */
  armArchiveBeforeWrite: { ownerId: string; canvasId: string } | undefined

  private async fireIfArmed(canvasId: string): Promise<void> {
    const armed = this.armArchiveBeforeWrite
    if (armed && armed.canvasId === canvasId) {
      this.armArchiveBeforeWrite = undefined
      await this.archiveCanvasTree(armed.ownerId, armed.canvasId)
    }
  }

  override async ensureCreateChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<EnsureChildResult> {
    await this.fireIfArmed(canvasId)
    return super.ensureCreateChild(ownerId, canvasId, type, id, payload, opts)
  }

  override async upsertChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { base?: number; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; strictUpdate?: boolean },
  ): Promise<UpsertChildResult> {
    await this.fireIfArmed(canvasId)
    return super.upsertChild(ownerId, canvasId, type, id, payload, opts)
  }
}

const buildRaceApp = (): { app: Hono<AppEnv>; backend: RaceInjectingBackend } => {
  const backend = new RaceInjectingBackend()
  const permissions = new InMemoryPermissionBackend()
  const app = new Hono<AppEnv>()
  app.onError(ssoAuthErrorHandler) // mirror app.ts:structural getResponse 错误(含 ArchivedCanvasWriteError)统一映射
  app.route('/api/projects', createProjectsRoutes({ backend, permissions }))
  app.route('/api/canvas', createCanvasRoutes({ backend, permissions }))
  return { app, backend }
}

const seed = async (backend: RaceInjectingBackend): Promise<void> => {
  await backend.ensureCreate(FP_A, 'project', 'p1', { name: 'P' }, { method: 'POST', resourceKind: 'project' })
  await backend.createCanvasWithCollection(FP_A, 'c1', { projectId: 'p1' }, { method: 'POST', resourceKind: 'canvas' })
}

describe('CR-6 缺口2 — route 级 TOCTOU 并发模拟(authz 通过后、写入前并发 archive)', () => {
  it('chat POST:authz(active)通过 → 写前 archive 提交 → 409 archived,零新增 chat-message(不再穿透)', async () => {
    const { app, backend } = buildRaceApp()
    await seed(backend)
    backend.armArchiveBeforeWrite = { ownerId: FP_A, canvasId: 'c1' }
    const res = await app.request('/api/canvas/c1/chat', {
      method: 'POST',
      headers: hdr(KEY_A),
      body: JSON.stringify({ message: { id: 'm-race', text: 'hello' } }),
    })
    // 旧实现:authz 时 active → 放行,写入落在已 archived canvas → 201 穿透。
    // 新实现:write-time 守卫在写入临界区重验 → 409 archived(与 route check-time 契约同形)。
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'archived', id: 'c1' })
    // 穿透面归零:archived canvas 上零新增 chat-message。
    const msgs = await backend.listByCanvas(FP_A, 'c1', 'chat-message', { includeDeleted: true, includeArchived: true })
    expect(msgs.records).toHaveLength(0)
    // canvas 确已 archived(竞态注入真实提交)。
    const meta = await backend.get(FP_A, 'canvas', 'c1')
    expect(meta.kind === 'found' && meta.record.status).toBe('archived')
  })

  it('对照组:未注入竞态时同一请求 201(守卫不误伤正常写)', async () => {
    const { app, backend } = buildRaceApp()
    await seed(backend)
    const res = await app.request('/api/canvas/c1/chat', {
      method: 'POST',
      headers: hdr(KEY_A),
      body: JSON.stringify({ message: { id: 'm-ok', text: 'hello' } }),
    })
    expect(res.status).toBe(201)
  })

  it('竞态后续:同 canvas 再写(check-time 已见 archived)→ 仍 409;unarchive 后恢复 201', async () => {
    const { app, backend } = buildRaceApp()
    await seed(backend)
    backend.armArchiveBeforeWrite = { ownerId: FP_A, canvasId: 'c1' }
    await app.request('/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm1', text: 'x' } }) })
    // 第二发:窗口已关(authz check-time 即 409,同一契约体)。
    const res2 = await app.request('/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm2', text: 'y' } }) })
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual({ error: 'archived', id: 'c1' })
    await backend.unarchiveCanvasTree(FP_A, 'c1')
    const res3 = await app.request('/api/canvas/c1/chat', { method: 'POST', headers: hdr(KEY_A), body: JSON.stringify({ message: { id: 'm3', text: 'z' } }) })
    expect(res3.status).toBe(201)
  })
})
