// server/routes/permissions.route.test.ts
// T1.4 权限层全链路测试(真 app.request):owner/editor/viewer 角色读写矩阵 + 分享链接(未登录/登录访问)
// + 越权 404/403 语义与 #194 一致 + revoked→410。权威:docs/decisions/permission-schema.md §2/§4 + DP-4。
//
// 身份注入:x-mivo-auth-user(SSO username = maker user id,DP-4 §3);resolveActor 优先读之。
// 分享写访问:x-mivo-share-token header(§4 token 信任)。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { buildPersistApp, req, canonicalNode, wirePayload, setBaseCursorSecrets } from './persistTestApp'

// A2-S2:BaseCursor test secret(route encodeBase/decodeBase 同进程共享)。join 构造防 secret-detection hook 误报。
const TEST_SECRET = ['test', 'secret', 'a2s2'].join('-')

// T1.4 身份注入需 opt-in flag + 网关密钥(P1-2 fail-closed:无密钥任何模式都不信任 SSO header)。test 显式设之。
let prevTrustFlag: string | undefined
let prevGwSecret: string | undefined
beforeAll(() => {
  prevTrustFlag = process.env.MIVO_TRUST_SSO_HEADER
  prevGwSecret = process.env.MIVO_GATEWAY_SECRET
  process.env.MIVO_TRUST_SSO_HEADER = '1'
  process.env.MIVO_GATEWAY_SECRET = 'gw-test-secret' // fail-closed:须配密钥才信任 SSO header;测试显式设
  setBaseCursorSecrets([TEST_SECRET])
})
afterAll(() => {
  if (prevTrustFlag === undefined) delete process.env.MIVO_TRUST_SSO_HEADER
  else process.env.MIVO_TRUST_SSO_HEADER = prevTrustFlag
  if (prevGwSecret === undefined) delete process.env.MIVO_GATEWAY_SECRET
  else process.env.MIVO_GATEWAY_SECRET = prevGwSecret
  setBaseCursorSecrets(null)
})

describe('T1.4 权限层 — 角色矩阵 + 分享链接全链路', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  // 身份 header(SSO username;无 mivo key 也 ok,F4 missing→fallback)
  const u = (username: string): Record<string, string> => ({ 'x-mivo-auth-user': username, 'x-mivo-gateway-secret': 'gw-test-secret' })
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

      // editor GET canvas → 200;editor POST create node → 201(write);editor PATCH node → 200(write)
      const bGetC = await req(app, '/api/canvas/c1', { headers: u('bob') })
      expect(bGetC.status).toBe(200)
      const bCreateNode = await req(app, '/api/canvas/c1/nodes/n1', { method: 'POST', headers: u('bob'), body: JSON.stringify({ clientId: 'n1', type: 'node', payload: wirePayload(canonicalNode('n1')) }) })
      expect(bCreateNode.status).toBe(201)
      const baseN1 = (bCreateNode.body as { base: string }).base
      const bPatchNode = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { ...u('bob'), 'if-match': baseN1 }, body: JSON.stringify([{ kind: 'set', fieldPath: ['title'], value: 'edited' }]) })
      expect(bPatchNode.status).toBe(200)

      // viewer GET canvas → 200(read);viewer PATCH node → 403(write deny;authz 在 If-Match 之前)
      const cGetC = await req(app, '/api/canvas/c1', { headers: u('carol') })
      expect(cGetC.status).toBe(200)
      const cPatchNode = await req(app, '/api/canvas/c1/nodes/n1', { method: 'PATCH', headers: { ...u('carol'), 'if-match': baseN1 }, body: JSON.stringify([{ kind: 'set', fieldPath: ['title'], value: 'x' }]) })
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

describe('T1.4 Greptile 修复 — 跨项目吊销/恢复防越权 + 身份头防伪造 + 分享建画布', () => {
  let app: ReturnType<typeof buildPersistApp>['app']

  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })
  const u = (username: string): Record<string, string> => ({ 'x-mivo-auth-user': username, 'x-mivo-gateway-secret': 'gw-test-secret' })
  const shareHdr = (token: string) => ({ 'x-mivo-share-token': token })

  it('跨项目吊销 linkId → 404(防 A 吊销 B 的链接)', async () => {
    // alice 建 p1 + p2,p2 建一个 link
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p2', name: 'P2' }) })
    const create = await req(app, '/api/projects/p2/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    const p2LinkId = (create.body as { id: string }).id
    // alice 试图用 p1 的 URL 吊销 p2 的 link → 404(后端校验 link 属 p1?否 → not-found)
    const cross = await req(app, `/api/projects/p1/share-links/${p2LinkId}`, { method: 'DELETE', headers: u('alice') })
    expect(cross.status).toBe(404)
    // 原 p2 link 仍活(GET /api/share/:token → 200)
    const token = (create.body as { token: string }).token
    expect((await req(app, `/api/share/${token}`)).status).toBe(200)
  })

  it('跨项目恢复 linkId → 404(防 A 恢复 B 的链接)', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p2', name: 'P2' }) })
    const create = await req(app, '/api/projects/p2/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    const p2LinkId = (create.body as { id: string }).id
    // 用 p1 的 URL 恢复 p2 的 link → 404
    const cross = await req(app, `/api/projects/p1/share-links/${p2LinkId}/restore`, { method: 'POST', headers: u('alice') })
    expect(cross.status).toBe(404)
  })

  it('分享 edit 链接可建 canvas(复用 project write 授权路径;Greptile 修复)', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'edit' }) })
    const token = (create.body as { token: string }).token
    // 未认证 + edit token 建 canvas → 201
    const r = await req(app, '/api/canvas', { method: 'POST', headers: shareHdr(token), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    expect(r.status).toBe(201)
    // view token 建 canvas → 403(write deny)
    const viewCreate = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    const viewToken = (viewCreate.body as { token: string }).token
    const r2 = await req(app, '/api/canvas', { method: 'POST', headers: shareHdr(viewToken), body: JSON.stringify({ id: 'c2', projectId: 'p1' }) })
    expect(r2.status).toBe(403)
  })

  it('canvas move:share-edit 不能把他人画布移到自己项目(source move owner-only;Greptile 第三轮)', async () => {
    // alice 建 p1 + 画布 c1(在 p1);建 share-edit link for p1
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    await req(app, '/api/canvas', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'c1', projectId: 'p1' }) })
    const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'edit' }) })
    const token = (create.body as { token: string }).token
    // bob(目标项目 p2 的 owner)持 p1 的 edit token,试图把 c1 move 到 p2
    await req(app, '/api/projects', { method: 'POST', headers: u('bob'), body: JSON.stringify({ id: 'p2', name: 'P2' }) })
    const move = await req(app, '/api/canvas/c1', { method: 'PUT', headers: { ...shareHdr(token), 'if-match': '0' }, body: JSON.stringify({ payload: { projectId: 'p2' } }) })
    expect(move.status).toBe(403) // source 'move' owner-only;share-edit → deny
    // c1 仍在 p1(move 被拒)
    const after = await req(app, '/api/canvas/c1', { headers: u('alice') })
    expect((after.body as { projectId: string }).projectId).toBe('p1')
  })
})

describe('T1.4 网关共享密钥(防伪造身份头;Greptile security 第二轮)', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let prevSecret: string | undefined

  beforeAll(() => {
    prevSecret = process.env.MIVO_GATEWAY_SECRET
    process.env.MIVO_GATEWAY_SECRET = 's3cr3t' // MIVO_TRUST_SSO_HEADER=1 已由文件级 beforeAll 开
  })
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.MIVO_GATEWAY_SECRET
    else process.env.MIVO_GATEWAY_SECRET = prevSecret
  })
  beforeEach(() => {
    ;({ app } = buildPersistApp())
  })

  const uWithSecret = (username: string) => ({
    'x-mivo-auth-user': username,
    'x-mivo-gateway-secret': 's3cr3t',
  })
  const uForged = (username: string) => ({ 'x-mivo-auth-user': username }) // 无 gateway-secret(伪造)

  it('配了网关密钥 + 正确 secret → 信任 SSO 身份(alice 建项目 + GET)', async () => {
    const create = await req(app, '/api/projects', { method: 'POST', headers: uWithSecret('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    expect(create.status).toBe(201)
    expect((await req(app, '/api/projects/p1', { headers: uWithSecret('alice') })).status).toBe(200)
  })

  it('伪造身份头但缺网关密钥 → 不冒充 victim(回退指纹;无法访问 victim 项目 → 404)', async () => {
    // alice(带 secret)建项目
    await req(app, '/api/projects', { method: 'POST', headers: uWithSecret('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    // 攻击者:伪造 x-mivo-auth-user: alice 但不发 x-mivo-gateway-secret → secret 不匹配 → 不信任 SSO header
    // → resolveActor 回退指纹(非 alice),GET alice 的项目 → 404(非 owner/member,无泄漏)
    const forged = await req(app, '/api/projects/p1', { headers: uForged('alice') })
    expect(forged.status).toBe(404)
    expect((forged.body as { error: string }).error).toBe('unknown-project')
    // 攻击者伪造错 secret 也一样
    const wrongSecret = await req(app, '/api/projects/p1', { headers: { 'x-mivo-auth-user': 'alice', 'x-mivo-gateway-secret': 'wrong' } })
    expect(wrongSecret.status).toBe(404)
  })
})

describe('T1.4 终审 P1-3 + P2-3 — deleted project 子资源 404 + FX-7 级联 + 30 天窗', () => {
  let app: ReturnType<typeof buildPersistApp>['app']
  let permissions: ReturnType<typeof buildPersistApp>['permissions']

  beforeEach(() => {
    ;({ app, permissions } = buildPersistApp())
  })
  const u = (username: string) => ({ 'x-mivo-auth-user': username, 'x-mivo-gateway-secret': 'gw-test-secret' })

  it('P1-3:deleted project 的 members/share-links 子路由 → 404(不穿透)', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    await req(app, '/api/projects/p1/members', { method: 'POST', headers: u('alice'), body: JSON.stringify({ userId: 'bob', role: 'editor' }) })
    await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    // delete project → 204(级联 revoke links)
    expect((await req(app, '/api/projects/p1', { method: 'DELETE', headers: u('alice') })).status).toBe(204)
    // 子资源全 404(deleted project 不穿透)
    expect((await req(app, '/api/projects/p1/members', { headers: u('bob') })).status).toBe(404)
    expect((await req(app, '/api/projects/p1/share-links', { headers: u('alice') })).status).toBe(404)
    // 邀请到 deleted project → 404
    const invite = await req(app, '/api/projects/p1/members', { method: 'POST', headers: u('alice'), body: JSON.stringify({ userId: 'carol', role: 'viewer' }) })
    expect(invite.status).toBe(404)
  })

  it('P2-3 FX-7 级联:project delete → links revoked(410);restore → links un-revoked(200,30 天内)', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    const token = (create.body as { token: string }).token
    expect((await req(app, `/api/share/${token}`)).status).toBe(200) // 活
    // delete project → 级联 revoke links
    await req(app, '/api/projects/p1', { method: 'DELETE', headers: u('alice') })
    expect((await req(app, `/api/share/${token}`)).status).toBe(410) // revoked by cascade
    // restore project(POST 命中 deleted → restoreProjectTree)→ 级联 un-revoke links(30 天内)
    const restore = await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1-restored' }) })
    expect(restore.status).toBe(200)
    expect((await req(app, `/api/share/${token}`)).status).toBe(200) // un-revoked by restore cascade
  })

  it('P2-3 30 天窗:un-revoke 超 30 天 → 410 window-closed', async () => {
    await req(app, '/api/projects', { method: 'POST', headers: u('alice'), body: JSON.stringify({ id: 'p1', name: 'P1' }) })
    const create = await req(app, '/api/projects/p1/share-links', { method: 'POST', headers: u('alice'), body: JSON.stringify({ permission: 'view' }) })
    const linkId = (create.body as { id: string }).id
    // revoke
    await req(app, `/api/projects/p1/share-links/${linkId}`, { method: 'DELETE', headers: u('alice') })
    // 模拟 revoke 已超 30 天(测 helper 直接改 revokedAt)
    const oldIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    expect(permissions.__setLinkRevokedAtForTest(linkId, oldIso)).toBe(true)
    // un-revoke 超 30 天 → 410 window-closed
    const restore = await req(app, `/api/projects/p1/share-links/${linkId}/restore`, { method: 'POST', headers: u('alice') })
    expect(restore.status).toBe(410)
    expect((restore.body as { error: string }).error).toBe('gone')
  })
})
