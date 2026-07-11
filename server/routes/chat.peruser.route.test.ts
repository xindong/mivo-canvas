// server/routes/chat.peruser.route.test.ts
// DP-6R chat per-user 重拆 路由级验收(真实 app.request 全链路;SSO 成员 + share-link)。
// 验收(计划 §3):
//   ① A/B 同画布各自 POST 普通消息+任务卡,双方 GET 只见自己;
//   ② owner↔editor 互不见;
//   ③ 匿名 share-link 访客 chat 读写 → 401 require-login;
//   ④ 旧 owner chat 迁移后仅原 owner 可见(成员不获复制);
//   ⑤ 删/恢复画布不串 actor collection。
//
// 身份注入:x-mivo-auth-user(SSO username = maker user id,DP-4 §3);MIVO_TRUST_SSO_HEADER=1 + 网关密钥
// (P1-2 fail-closed)。chat-message 存储 owner=actor(per-actor 私有),画布 authz 只证 actor 可访问画布。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { buildPersistApp, req } from './persistTestApp'
import type { InMemoryPersistBackend } from '../persist/backend'

// T1.4 身份注入需 opt-in flag + 网关密钥(fail-closed)。test 显式设之,复用 permissions.route.test.ts 模式。
let prevTrustFlag: string | undefined
let prevGwSecret: string | undefined
beforeAll(() => {
  prevTrustFlag = process.env.MIVO_TRUST_SSO_HEADER
  prevGwSecret = process.env.MIVO_GATEWAY_SECRET
  process.env.MIVO_TRUST_SSO_HEADER = '1'
  process.env.MIVO_GATEWAY_SECRET = 'gw-test-secret'
})
afterAll(() => {
  if (prevTrustFlag === undefined) delete process.env.MIVO_TRUST_SSO_HEADER
  else process.env.MIVO_TRUST_SSO_HEADER = prevTrustFlag
  if (prevGwSecret === undefined) delete process.env.MIVO_GATEWAY_SECRET
  else process.env.MIVO_GATEWAY_SECRET = prevGwSecret
})

describe('DP-6R chat per-user — 路由级验收', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let backend: InMemoryPersistBackend

  beforeEach(() => {
    ;({ app, backend } = buildPersistApp())
  })

  // 身份 header(SSO username;网关密钥通过)。
  const u = (username: string): Record<string, string> => ({ 'x-mivo-auth-user': username, 'x-mivo-gateway-secret': 'gw-test-secret' })
  const shareHdr = (token: string) => ({ 'x-mivo-share-token': token })

  // setup:alice(owner)建 project p1 + canvas c1;邀请 bob(editor)。
  const setup = async (): Promise<void> => {
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C1' }) })
    await req(app, '/api/projects/p1/members', { method: 'POST', headers: u('alice'), body: JSON.stringify({ userId: 'bob', role: 'editor' }) })
  }

  it('①② A/B 同画布各自 POST 普通消息+任务卡,双方 GET 只见自己;owner↔editor 互不见', async () => {
    await setup()
    // alice(owner)POST 普通消息 + 任务卡
    const aNormal = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('alice'), body: JSON.stringify({ message: { id: 'a-normal', role: 'user', text: 'hi from alice' } }) })
    expect(aNormal.status).toBe(201)
    const aTask = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('alice'), body: JSON.stringify({ message: { id: 'a-task', role: 'task', kind: 'inpaint', status: 'ready' } }) })
    expect(aTask.status).toBe(201)
    // bob(editor)POST 普通消息 + 任务卡
    const bNormal = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('bob'), body: JSON.stringify({ message: { id: 'b-normal', role: 'user', text: 'hi from bob' } }) })
    expect(bNormal.status).toBe(201)
    const bTask = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('bob'), body: JSON.stringify({ message: { id: 'b-task', role: 'task', kind: 'inpaint', status: 'ready' } }) })
    expect(bTask.status).toBe(201)

    // alice GET → 只见 alice 的 2 条(普通+任务卡)
    const aList = await req(app, '/api/canvas/c1/chat', { headers: u('alice') })
    expect(aList.status).toBe(200)
    const aIds = (aList.body as { messages: { id: string }[] }).messages.map((m) => m.id).sort()
    expect(aIds).toEqual(['a-normal', 'a-task'])
    // bob GET → 只见 bob 的 2 条
    const bList = await req(app, '/api/canvas/c1/chat', { headers: u('bob') })
    expect(bList.status).toBe(200)
    const bIds = (bList.body as { messages: { id: string }[] }).messages.map((m) => m.id).sort()
    expect(bIds).toEqual(['b-normal', 'b-task'])
    // 互不见:alice 不含 bob 的;bob 不含 alice 的
    expect(aIds).not.toContain('b-normal')
    expect(bIds).not.toContain('a-normal')
  })

  it('③ 匿名 share-link 访客 chat 读写 → 401/403(决策:无稳定 identity 的 chat 读写一律拒;view link 可访问画布)', async () => {
    await setup()
    // alice 建 view 分享链接
    const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    expect(create.status).toBe(201)
    const token = (create.body as { token: string }).token
    // 带 view token GET canvas → 200(画布按链接角色可访问)
    const canvasGet = await req(app, '/api/canvas/c1', { headers: shareHdr(token) })
    expect(canvasGet.status).toBe(200)
    // 带 view token GET chat → 401 require-login(view 可读画布,但 chat per-user 需稳定 identity)
    const chatGet = await req(app, '/api/canvas/c1/chat', { headers: shareHdr(token) })
    expect(chatGet.status).toBe(401)
    expect((chatGet.body as { error: string }).error).toBe('require-login')
    // 带 view token POST chat → 403 forbidden(view 不能写画布,authz deny 在 requireLogin 之前;决策"一律 401/403")
    const chatPost = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: shareHdr(token), body: JSON.stringify({ message: { id: 'anon-1', text: 'sneak' } }) })
    expect(chatPost.status).toBe(403)
    expect((chatPost.body as { error: string }).error).toBe('forbidden')
    // edit link:edit token 可写画布,但 chat 仍需登录 → POST chat 401 require-login
    const editCreate = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'edit' }) })
    const editToken = (editCreate.body as { token: string }).token
    const editChatGet = await req(app, '/api/canvas/c1/chat', { headers: shareHdr(editToken) })
    expect(editChatGet.status).toBe(401)
    expect((editChatGet.body as { error: string }).error).toBe('require-login')
    const editChatPost = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: shareHdr(editToken), body: JSON.stringify({ message: { id: 'anon-2', text: 'sneak' } }) })
    expect(editChatPost.status).toBe(401)
    expect((editChatPost.body as { error: string }).error).toBe('require-login')
    // 验证 anon 未写入任何 actor collection(backend 直查)
    expect((await backend.listByCanvas('alice', 'c1', 'chat-message')).records).toHaveLength(0)
  })

  it('④ 旧 owner chat(ownerId=canvasOwner)迁移后仅原 owner 可见;成员不获复制', async () => {
    await setup()
    // 模拟"旧数据":直接 backend 在 canvas owner(alice)名下塞 chat-message(重拆前的共享 collection 形态)。
    // alice 的 actor === canvasOwner('alice'),故重拆后 owner GET 仍见;bob 不获复制。
    await backend.ensureCreateChild('alice', 'c1', 'chat-message', 'old-m1', { role: 'user', text: 'old' }, { method: 'POST', resourceKind: 'chat-message' })
    await backend.ensureCreateChild('alice', 'c1', 'chat-message', 'old-m2', { role: 'task', status: 'done' }, { method: 'POST', resourceKind: 'chat-message' })
    // alice GET → 见旧 2 条
    const aList = await req(app, '/api/canvas/c1/chat', { headers: u('alice') })
    expect(aList.status).toBe(200)
    expect(((aList.body as { messages: { id: string }[] }).messages.map((m) => m.id)).sort()).toEqual(['old-m1', 'old-m2'])
    // bob GET → 空(成员不获复制;旧数据不迁到成员)
    const bList = await req(app, '/api/canvas/c1/chat', { headers: u('bob') })
    expect(bList.status).toBe(200)
    expect((bList.body as { messages: unknown[] }).messages).toHaveLength(0)
  })

  it('⑤ 删/恢复画布不串 actor collection:各 actor chat 活记录不动,restore 后各见自己', async () => {
    await setup()
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('alice'), body: JSON.stringify({ message: { id: 'a-m', text: 'A' } }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('bob'), body: JSON.stringify({ message: { id: 'b-m', text: 'B' } }) })
    // alice DELETE canvas(owner-only manage)→ 204
    const del = await req(app, '/api/canvas/c1', { method: 'DELETE', headers: u('alice') })
    expect(del.status).toBe(204)
    // canvas 软删 → 各 actor GET chat → 404(canvas 不可见,route authz 先 404,不暴露 chat)
    expect((await req(app, '/api/canvas/c1/chat', { headers: u('alice') })).status).toBe(404)
    expect((await req(app, '/api/canvas/c1/chat', { headers: u('bob') })).status).toBe(404)
    // per-actor chat-message 活记录仍在(backend 直查,未触;不串)
    expect((await backend.listByCanvas('alice', 'c1', 'chat-message', { includeDeleted: true })).records.map((r) => r.id)).toEqual(['a-m'])
    expect((await backend.listByCanvas('bob', 'c1', 'chat-message', { includeDeleted: true })).records.map((r) => r.id)).toEqual(['b-m'])
    // restore canvas(POST c1,project p1 live)→ restoreCanvasTree
    const restore = await req(app, '/api/canvas', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C1' }) })
    expect(restore.status).toBe(200)
    // 各 actor GET chat → 各见自己(不串)
    const aList = await req(app, '/api/canvas/c1/chat', { headers: u('alice') })
    expect((aList.body as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['a-m'])
    const bList = await req(app, '/api/canvas/c1/chat', { headers: u('bob') })
    expect((bList.body as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['b-m'])
  })

  it('chat PATCH/DELETE per-actor:actor 只能改/删自己;非己 msgId → 不触他人(actor A 删 B 的 msgId → 404)', async () => {
    await setup()
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('alice'), body: JSON.stringify({ message: { id: 'a-m', text: 'A' } }) })
    await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('bob'), body: JSON.stringify({ message: { id: 'b-m', text: 'B' } }) })
    // bob DELETE alice 的 'a-m'(bob 名下无 a-m)→ 404 unknown-message,alice 的 a-m 不受影响
    const del = await req(app, '/api/canvas/c1/chat/a-m', { method: 'DELETE', headers: u('bob') })
    expect(del.status).toBe(404)
    expect((del.body as { error: string }).error).toBe('unknown-message')
    expect(((await req(app, '/api/canvas/c1/chat', { headers: u('alice') })).body as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['a-m'])
    // alice PATCH 自己的 a-m(If-Match:0)→ 200
    const patch = await req(app, '/api/canvas/c1/chat/a-m', { method: 'PATCH', headers: { ...u('alice'), 'if-match': '0' }, body: JSON.stringify({ payload: { id: 'a-m', text: 'A-edit' } }) })
    expect(patch.status).toBe(200)
    // bob PATCH alice 的 a-m → upsert 到 bob 名下(create 己方副本,不触 alice 的 a-m)
    const bPatch = await req(app, '/api/canvas/c1/chat/a-m', { method: 'PATCH', headers: { ...u('bob'), 'if-match': '0' }, body: JSON.stringify({ payload: { id: 'a-m', text: 'bob-copy' } }) })
    expect(bPatch.status).toBe(200)
    // alice 的 a-m 仍是 alice 的(edit 不串);bob 现在也有自己的 a-m(bob-copy)
    const aList = await req(app, '/api/canvas/c1/chat', { headers: u('alice') })
    expect((aList.body as { messages: { id: string; payload: { text: string } }[] }).messages.find((m) => m.id === 'a-m')?.payload.text).toBe('A-edit')
    const bList = await req(app, '/api/canvas/c1/chat', { headers: u('bob') })
    // bob 先 POST b-m(orderKey 0),PATCH a-m 创建 bob 的 a-m 副本(orderKey 1)→ 顺序 [b-m, a-m]
    expect((bList.body as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['b-m', 'a-m'])
  })
})
