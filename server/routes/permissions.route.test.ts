// server/routes/permissions.route.test.ts
// T1.4 权限层全链路测试(真 app.request):owner/editor/viewer 角色读写矩阵 + 分享链接(未登录/登录访问)
// + 越权 404/403 语义与 #194 一致 + revoked→410。权威:docs/decisions/permission-schema.md §2/§4 + DP-4。
//
// 身份注入:x-mivo-auth-user(SSO username = maker user id,DP-4 §3);resolveActor 优先读之。
// 分享写访问:x-mivo-share-token header(§4 token 信任)。
import { describe, it, expect, beforeEach } from 'vitest'
import { buildPersistApp, req, canonicalNode, wirePayload } from './persistTestApp'

describe('T1.4 权限层 — 角色矩阵 + 分享链接全链路', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  // 身份 header(SSO username;无 mivo key 也 ok,F4 missing→fallback)
  const u = (username: string): Record<string, string> => ({ 'x-mivo-auth-user': username })
  const shareHdr = (token: string) => ({ 'x-mivo-share-token': token })

  // ── 建项目 + 邀请成员 的 setup ──
  const setupProject = async (owner = 'alice', id = 'p1', name = 'P1') => {
    const r = await req(app, '/api/projects', { method: 'POST', headers: u(owner), body: JSON.stringify({ id, name }) })
    expect(r.status).toBe(201)
    return r.body as { id: string; ownerId: string; revision: number }
  }
  const invite = async (owner: string, projectId: string, userId: string, role: 'editor' | 'viewer') => {
    const r = await req(app, `/api/projects/${projectId}/members`, {
      method: 'POST', headers: u(owner), body: JSON.stringify({ userId, role }),
    })
    expect(r.status).toBe(201)
    return r.body
  }

  // ── 角色读写矩阵(permission-schema.md §2)──
  describe('角色读写矩阵(owner/editor/viewer)', () => {
    it('A(owner)建项目 + 邀请 B(editor)/C(viewer);逐角色断言读写矩阵', async () => {
      const proj = await setupProject('alice', 'p1')
      expect(proj.ownerId).toBe('alice')
      await invite('alice', 'p1', 'bob', 'editor')
      await invite('alice', 'p1', 'carol', 'viewer')

      // owner:GET/PATCH/DELETE allow(manage)
      const aGet = await req(app, '/api/projects/p1', { headers: u('alice') })
      expect(aGet.status).toBe(200)
      const aPatch = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...u('alice'), 'if-match': '0' }, body: JSON.stringify({ name: 'A1' }) })
      expect(aPatch.status).toBe(200)
      // (不实际 DELETE,后面单独验)

      // editor(B):GET 200、PATCH 200、DELETE 403
      const bGet = await req(app, '/api/projects/p1', { headers: u('bob') })
      expect(bGet.status).toBe(200)
      const bPatch = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...u('bob'), 'if-match': `${(aPatch.body as { revision: number }).revision}` }, body: JSON.stringify({ name: 'B1' }) })
      expect(bPatch.status).toBe(200)
      const bDel = await req(app, '/api/projects/p1', { method: 'DELETE', headers: u('bob') })
      expect(bDel.status).toBe(403)
      expect((bDel.body as { error: string }).error).toBe('forbidden')

      // viewer(C):GET 200、PATCH 403、DELETE 403
      const cGet = await req(app, '/api/projects/p1', { headers: u('carol') })
      expect(cGet.status).toBe(200)
      const cPatch = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...u('carol'), 'if-match': `${(bPatch.body as { revision: number }).revision}` }, body: JSON.stringify({ name: 'C1' }) })
      expect(cPatch.status).toBe(403)
      const cDel = await req(app, '/api/projects/p1', { method: 'DELETE', headers: u('carol') })
      expect(cDel.status).toBe(403)

      // 非成员(E):GET → 404(无存在泄漏,与 #194 一致)
      const eGet = await req(app, '/api/projects/p1', { headers: u('eve') })
      expect(eGet.status).toBe(404)
      expect((eGet.body as { error: string }).error).toBe('unknown-project')
      // E list 不含 p1
      const eList = await req(app, '/api/projects', { headers: u('eve') })
      expect((eList.body as { projects: unknown[] }).projects).toHaveLength(0)

      // owner DELETE → 204(仅 owner)
      const aDel = await req(app, '/api/projects/p1', { method: 'DELETE', headers: u('alice') })
      expect(aDel.status).toBe(204)
    })

    it('editor/viewer 在 canvas + 子资源上的读写矩阵(editor 写 node ok;viewer 写 403)', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      await invite('alice', 'p1', 'carol', 'viewer')

      // editor 建画布(write on project)→ 201;viewer 建画布 → 403
      const bCanvas = await req(app, '/api/canvas', { method: 'POST', headers: u('bob'), body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'C1' }) })
      expect(bCanvas.status).toBe(201)
      const cCanvas = await req(app, '/api/canvas', { method: 'POST', headers: u('carol'), body: JSON.stringify({ id: 'c-x', projectId: 'p1' }) })
      expect(cCanvas.status).toBe(403)

      // editor GET canvas → 200;editor PATCH node → 200(write)
      const bGetC = await req(app, '/api/canvas/c1', { headers: u('bob') })
      expect(bGetC.status).toBe(200)
      const bPatchNode = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { ...u('bob'), 'if-match': '0' }, body: JSON.stringify({ payload: wirePayload(canonicalNode('n1')) }) })
      expect(bPatchNode.status).toBe(200)

      // viewer GET canvas → 200(read);viewer PATCH node → 403(write deny)
      const cGetC = await req(app, '/api/canvas/c1', { headers: u('carol') })
      expect(cGetC.status).toBe(200)
      const cPatchNode = await req(app, '/api/canvas/c1/nodes/n2', { method: 'PATCH', headers: { ...u('carol'), 'if-match': '0' }, body: JSON.stringify({ payload: wirePayload(canonicalNode('n2')) }) })
      expect(cPatchNode.status).toBe(403)

      // editor POST chat → 201(write);viewer POST chat → 403
      const bChat = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('bob'), body: JSON.stringify({ message: { id: 'm1', text: 'hi' } }) })
      expect(bChat.status).toBe(201)
      const cChat = await req(app, '/api/canvas/c1/chat', { method: 'POST', headers: u('carol'), body: JSON.stringify({ message: { id: 'm2' } }) })
      expect(cChat.status).toBe(403)

      // editor DELETE canvas → 403(manage,仅 owner);viewer DELETE canvas → 403
      expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: u('bob') })).status).toBe(403)
      expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: u('carol') })).status).toBe(403)
      // owner DELETE canvas → 204
      expect((await req(app, '/api/canvas/c1', { method: 'DELETE', headers: u('alice') })).status).toBe(204)
    })

    it('被分享项目出现在对方列表(GET /api/projects 合并 owned + shared)', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      const bList = await req(app, '/api/projects', { headers: u('bob') })
      expect(bList.status).toBe(200)
      const projects = (bList.body as { projects: { id: string }[] }).projects
      expect(projects.map((p) => p.id)).toContain('p1')
    })
  })

  // ── 成员管理(manage;仅 owner)──
  describe('成员管理(仅 owner 可邀请/改 role/移除)', () => {
    it('editor/viewer 邀请他人 → 403(forbidden)', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      const bInvite = await req(app, '/api/projects/p1/members', { method: 'POST', headers: u('bob'), body: JSON.stringify({ userId: 'dave', role: 'viewer' }) })
      expect(bInvite.status).toBe(403)
    })

    it('非成员 GET members → 404;成员 GET members → 200(合成 owner 行)', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      // 非成员 → 404
      expect((await req(app, '/api/projects/p1/members', { headers: u('eve') })).status).toBe(404)
      // 成员 list → 含 owner 派生行 + editor
      const list = await req(app, '/api/projects/p1/members', { headers: u('bob') })
      expect(list.status).toBe(200)
      const members = (list.body as { members: { userId: string; role: string }[] }).members
      const roles = Object.fromEntries(members.map((m) => [m.userId, m.role]))
      expect(roles['alice']).toBe('owner') // 派生 owner
      expect(roles['bob']).toBe('editor')
    })

    it('A PATCH member 改 role editor→viewer;B 随之失写权', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      // B 能写
      const bPatch1 = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...u('bob'), 'if-match': '0' }, body: JSON.stringify({ name: 'B1' }) })
      expect(bPatch1.status).toBe(200)
      // A 改 B 为 viewer
      const changeRole = await req(app, '/api/projects/p1/members/bob', { method: 'PATCH', headers: u('alice'), body: JSON.stringify({ userId: 'bob', role: 'viewer' }) })
      expect(changeRole.status).toBe(200)
      expect((changeRole.body as { role: string }).role).toBe('viewer')
      // B 失写权 → 403
      const bPatch2 = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...u('bob'), 'if-match': `${(bPatch1.body as { revision: number }).revision}` }, body: JSON.stringify({ name: 'B2' }) })
      expect(bPatch2.status).toBe(403)
    })

    it('A 移除 B;B 随之 GET → 404(非成员)', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      expect((await req(app, '/api/projects/p1', { headers: u('bob') })).status).toBe(200)
      const remove = await req(app, '/api/projects/p1/members/bob', { method: 'DELETE', headers: u('alice') })
      expect(remove.status).toBe(204)
      expect((await req(app, '/api/projects/p1', { headers: u('bob') })).status).toBe(404)
    })

    it('拒邀 owner role(派生,§3)→ 400', async () => {
      await setupProject('alice', 'p1')
      const r = await req(app, '/api/projects/p1/members', { method: 'POST', headers: u('alice'), body: JSON.stringify({ userId: 'bob', role: 'owner' }) })
      expect(r.status).toBe(400)
    })
  })

  // ── 分享链接(token 驱动;未登录/登录访问;revoke→410)──
  describe('分享链接(view/edit permission;token 不可枚举;revoke→410)', () => {
    it('A 建 view link;未登录 GET /api/share/:token → 200;带 token PATCH → 403(view 不能写)', async () => {
      await setupProject('alice', 'p1')
      const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
      expect(create.status).toBe(201)
      const token = (create.body as { token: string }).token
      expect(token.length).toBeGreaterThan(20) // 密码学随机

      // 未登录(无任何 header)公开访问 → 200
      const pub = await req(app, `/api/share/${token}`)
      expect(pub.status).toBe(200)
      expect((pub.body as { project: { id: string }; permission: string }).project.id).toBe('p1')
      expect((pub.body as { permission: string }).permission).toBe('view')

      // 带 view token PATCH project → 403(view 不能写)
      const wPatch = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...shareHdr(token), 'if-match': '0' }, body: JSON.stringify({ name: 'X' }) })
      expect(wPatch.status).toBe(403)
      // 带 view token GET → 200(read)
      expect((await req(app, '/api/projects/p1', { headers: shareHdr(token) })).status).toBe(200)
    })

    it('A 建 edit link;带 token PATCH → 200(edit 能写);DELETE → 403(link 不授 manage)', async () => {
      await setupProject('alice', 'p1')
      const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'edit' }) })
      const token = (create.body as { token: string }).token
      // edit token PATCH → 200
      const wPatch = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...shareHdr(token), 'if-match': '0' }, body: JSON.stringify({ name: 'E1' }) })
      expect(wPatch.status).toBe(200)
      // edit token DELETE project → 403(链接不授 manage)
      const wDel = await req(app, '/api/projects/p1', { method: 'DELETE', headers: shareHdr(token) })
      expect(wDel.status).toBe(403)
    })

    it('revoke → GET /api/share/:token → 410;un-revoke → 200', async () => {
      await setupProject('alice', 'p1')
      const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
      const linkId = (create.body as { id: string }).id
      const token = (create.body as { token: string }).token
      expect((await req(app, `/api/share/${token}`)).status).toBe(200)
      // revoke
      const rev = await req(app, `/api/projects/p1/share-links/${linkId}`, { method: 'DELETE', headers: u('alice') })
      expect(rev.status).toBe(200)
      expect((rev.body as { revokedAt: string }).revokedAt).toBeTruthy()
      // revoked → 410
      expect((await req(app, `/api/share/${token}`)).status).toBe(410)
      // un-revoke → 200
      const unrev = await req(app, `/api/projects/p1/share-links/${linkId}/restore`, { method: 'POST', headers: u('alice') })
      expect(unrev.status).toBe(200)
      expect((unrev.body as { revokedAt: string | null }).revokedAt).toBeNull()
      expect((await req(app, `/api/share/${token}`)).status).toBe(200)
    })

    it('未知 token → 404(无存在泄漏);token 不属此 project 的写访问 → 404', async () => {
      await setupProject('alice', 'p1')
      expect((await req(app, '/api/share/nonexistent-token-xxx')).status).toBe(404)
      // 用 P2 的 token 访问 P1(不属)→ 写访问 404(当未知处理)
      await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p2', name: 'P2' }) })
      const create = await req(app, '/api/projects/p2/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'edit' }) })
      const token = (create.body as { token: string }).token
      const cross = await req(app, '/api/projects/p1', { method: 'PATCH', headers: { ...shareHdr(token), 'if-match': '0' }, body: JSON.stringify({ name: 'X' }) })
      expect(cross.status).toBe(404)
    })

    it('editor 建分享链接 → 403(manage,仅 owner)', async () => {
      await setupProject('alice', 'p1')
      await invite('alice', 'p1', 'bob', 'editor')
      const r = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('bob'), body: JSON.stringify({ permission: 'view' }) })
      expect(r.status).toBe(403)
    })
  })

  // ── 越权 404/403 语义与 #194 一致(非成员=404 无泄漏;成员越权=403)──
  describe('越权 404/403 语义(与 #194 一致)', () => {
    it('跨 owner 资源 GET → 404 unknown-* (同 #194,无存在泄漏)', async () => {
      await setupProject('alice', 'p1')
      const bobGet = await req(app, '/api/projects/p1', { headers: u('bob') }) // bob 非成员
      expect(bobGet.status).toBe(404)
      expect((bobGet.body as { error: string }).error).toBe('unknown-project')
      // 与 never-existed 的 404 body 一致(无泄漏)
      const never = await req(app, '/api/projects/never-existed', { headers: u('bob') })
      expect(never.body).toEqual(bobGet.body)
    })

    it('canvas 跨 owner GET → 404 unknown-canvas(同 #194)', async () => {
      await setupProject('alice', 'p1')
      await req(app, '/api/canvas', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
      const cross = await req(app, '/api/canvas/c1', { headers: u('eve') })
      expect(cross.status).toBe(404)
      expect((cross.body as { error: string }).error).toBe('unknown-canvas')
    })
  })
})
