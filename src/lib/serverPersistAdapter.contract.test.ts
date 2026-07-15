// src/lib/serverPersistAdapter.contract.test.ts
// T1.3 前置:PersistAdapter 接口 ↔ 服务端契约类型共享互锁(返修 #5 + N1/N4/N5/N9)。
// 互锁机制:server/routes/* 与本 ServerPersistAdapter 共同 import shared/persist-contract.ts
// 的 wire 类型。任一侧改 shape → 编译期 break(tsc -b 覆盖 server + app 两 project,均含 shared)。
//
// **铁律**:本文件只做**类型层互锁**(expectTypeOf)——不是"往返测试"。真实的 canonical fixture
// 往返(wire payload 经 encoder PATCH 真实 route 200 + GET 回读 envelope revision 回填)由
// server/routes/canvas.route.test.ts N1 用例覆盖(驱动真实 Hono route)。本文件不重复手写 JSON 往返。

import { describe, expect, it, expectTypeOf } from 'vitest'
import type {
  CanvasMeta,
  CanvasChildUpsertResponse,
  ConflictBody,
  CreateAssetResponse,
  GetCanvasResponse,
  PreconditionRequiredBody,
  Project,
  RecordEntry,
  ResolvedAsset,
  ReuseConflictBody,
  Revision,
  TooLargeBody,
  UnknownResourceBody,
  UpsertRequest,
  UpsertResponse,
  UserStateEntry,
  NodePayload,
  EdgePayload,
  AnchorPayload,
} from '../../shared/persist-contract.ts'
import {
  isUserStateKeyNamespaceAllowed,
  parseIfMatch,
  resolveBaseRevision,
  scanForSensitiveFields,
  scanUserStateKeyForCredential,
  userStateNamespaceKind,
  USER_STATE_KEY_NAMESPACES,
  validateChildPayload,
} from '../../shared/persist-contract.ts'
import { unwiredServerPersistAdapter, type ServerPersistAdapter } from './serverPersistAdapter'
import type { NodeRecord } from '../kernel/records'

describe('T1.3 ServerPersistAdapter ↔ server contract 类型共享互锁(返修版二)', () => {
  it('shared wire 类型被 client + server 共同 import(互锁基础)', () => {
    // A2-S3(lead ②,Plan C 收尾):strictify 仅 canvas child 域——拆 CanvasChildUpsertResponse(seq+base 必填)
    //   extends UpsertResponse(optional)。canvas child(PATCH/POST upsertNode/Edge/Anchor)返必填型 → exact type;
    //   chat(DP-6R per-actor,独立 orderRevision 游标,不进 canvas_seq)/user-state(无序流)仍用 UpsertResponse
    //   (optional,不填 seq/base——不发明未经终审的语义)。原 TODO(A2-S3) 锚点兑现:恢复 toEqualTypeOf。
    // UpsertResponse 仍 optional(chat/userState 用):toMatchTypeOf 松绑保留。
    expectTypeOf<UpsertResponse>().toMatchTypeOf<{ id: string; revision: Revision }>()
    // canvas child 域:seq+base 必填 → exact type test 恢复(lead ②)。CanvasChildUpsertResponse = UpsertResponse &
    //   {seq:number;base:string}(intersection);exact 断言经 adapter 方法返回类型锚定(下 it:upsertNode/Edge/Anchor
    //   returns.toEqualTypeOf<Promise<CanvasChildUpsertResponse>>)——standalone expectTypeOf<intersection>() 触发
    //   vitest 0-arg overload 误选,故不走 standalone 形式;adapter-return 锚定即 exact type 恢复点。
    expectTypeOf<ConflictBody>().toEqualTypeOf<{ error: 'revision-conflict'; id: string; currentRevision: Revision }>()
  })

  it('adapter 方法返回类型 = shared wire 响应类型(fetchCanvas/upsert/putUserState + #8/N9 asset seam)', () => {
    expectTypeOf<ServerPersistAdapter['fetchCanvas']>().returns.toMatchTypeOf<Promise<GetCanvasResponse | null>>()
    // A2-S3:canvas child 域 upsert 返 CanvasChildUpsertResponse(seq+base 必填)→ exact type(lead ②)。
    expectTypeOf<ServerPersistAdapter['upsertNode']>().returns.toEqualTypeOf<Promise<CanvasChildUpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertEdge']>().returns.toEqualTypeOf<Promise<CanvasChildUpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertAnchor']>().returns.toEqualTypeOf<Promise<CanvasChildUpsertResponse>>()
    // chat/userState 仍 UpsertResponse(optional,不填 seq/base)→ toMatchTypeOf 保留(非 canvas child 域)。
    expectTypeOf<ServerPersistAdapter['appendChatMessage']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['putUserState']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['getUserState']>().returns.toMatchTypeOf<Promise<UserStateEntry | null>>()
    expectTypeOf<ServerPersistAdapter['deleteEdge']>().returns.toMatchTypeOf<Promise<void>>()
    expectTypeOf<ServerPersistAdapter['deleteAnchor']>().returns.toMatchTypeOf<Promise<void>>()
    expectTypeOf<ServerPersistAdapter['listCanvas']>().returns.toMatchTypeOf<Promise<{ canvases: CanvasMeta[] }>>()
    expectTypeOf<ServerPersistAdapter['uploadAsset']>().returns.toMatchTypeOf<Promise<CreateAssetResponse>>()
    // N9:resolve seam 返回 bytes+mime(ResolvedAsset),不返 AssetRef 元数据
    expectTypeOf<ServerPersistAdapter['resolveAsset']>().returns.toMatchTypeOf<Promise<ResolvedAsset | null>>()
    expectTypeOf<ResolvedAsset>().toEqualTypeOf<{ bytes: Uint8Array; mimeType: string }>()
  })

  it('返修 #5/N1:wire body 不携带 id/revision——UpsertRequest 仅 {payload};transport payload = Omit<Record,id|revision>', () => {
    const node = { id: 'n1', type: 'image', title: 't', revision: 3 } as unknown as NodeRecord
    const req: UpsertRequest<NodeRecord> = { payload: node }
    expectTypeOf<UpsertRequest<NodeRecord>>().toMatchTypeOf<{ payload: NodeRecord }>()
    expectTypeOf<UpsertRequest<NodeRecord>>().not.toHaveProperty('revision')
    expect(req.payload).toBe(node)
    // N1:transport payload 逐 type Omit id/revision
    expectTypeOf<NodePayload>().not.toHaveProperty('id')
    expectTypeOf<NodePayload>().not.toHaveProperty('revision')
    expectTypeOf<EdgePayload>().not.toHaveProperty('id')
    expectTypeOf<EdgePayload>().toHaveProperty('createdAt') // domain createdAt 保留
    expectTypeOf<AnchorPayload>().not.toHaveProperty('id')
    expectTypeOf<AnchorPayload>().toHaveProperty('createdAt')
  })

  it('返修 #5:Kernel↔Server revision 往返——envelope 唯一真相,baseRevision 经 If-Match 解析', () => {
    const entry: RecordEntry = { id: 'n1', revision: 5, orderKey: 2, payload: { type: 'image' } }
    const ifMatch = String(entry.revision)
    expect(resolveBaseRevision(ifMatch)).toBe(5)
    const res: UpsertResponse = { id: 'n1', revision: 6 }
    expect(res.revision).toBe(6)
    expectTypeOf<RecordEntry>().toMatchTypeOf<{ id: string; revision: Revision; orderKey: number; payload: unknown }>()
  })

  it('返修 #5:CanvasMeta metaRevision 与 contentVersion 分名(GET /api/canvas/:id 响应)', () => {
    expectTypeOf<CanvasMeta>().toHaveProperty('metaRevision')
    expectTypeOf<CanvasMeta>().toHaveProperty('contentVersion')
    expectTypeOf<CanvasMeta>().not.toHaveProperty('revision')
    expectTypeOf<CanvasMeta>().toHaveProperty('sourceTemplateId')
    const meta: CanvasMeta = {
      id: 'c1', projectId: 'p1', title: 't',
      createdAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:01:00Z',
      metaRevision: 2, contentVersion: 5,
    }
    expect(meta.metaRevision).toBe(2)
    expect(meta.contentVersion).toBe(5)
  })

  it('返修 #6:RecordEntry 带 orderKey(稳定排序,ORDER BY orderKey)', () => {
    const e: RecordEntry = { id: 'n1', revision: 0, orderKey: 0, payload: { type: 'image' } }
    expect(e.orderKey).toBe(0)
    expectTypeOf<RecordEntry>().toHaveProperty('orderKey')
  })

  it('返修 #1:project 全局唯一——跨 owner 同 id → 409 project-exists body', () => {
    const err = { error: 'project-exists' as const, id: 'p1' }
    expect(err.error).toBe('project-exists')
  })

  it('返修 #4:428 Precondition Required body(existing 缺 If-Match base)', () => {
    const body: PreconditionRequiredBody = { error: 'precondition-required', id: 'n1' }
    expect(body.error).toBe('precondition-required')
  })

  it('返修 #12:413 TooLargeBody 统一契约体', () => {
    const body: TooLargeBody = { error: 'request-body-too-large', limit: 1048576 }
    expect(body.limit).toBe(1048576)
  })

  it('返修 N4:422 ReuseConflictBody(同 idem key 不同 body)契约体', () => {
    const body: ReuseConflictBody = { error: 'idempotency-key-reuse', key: 'k1' }
    expect(body.error).toBe('idempotency-key-reuse')
  })

  it('404 不存在 body 跨 owner 同形(无存在泄漏,§1/#1;返修 #2 新增 unknown-collection)', () => {
    const u: UnknownResourceBody = { error: 'unknown-canvas' }
    expect(u.error).toBe('unknown-canvas')
    const coll: UnknownResourceBody = { error: 'unknown-collection' }
    expect(coll.error).toBe('unknown-collection')
  })

  it('返修 #9/N6:DP-7 frozen namespace + 递归敏感扫描(大小写/连字符/camelCase/前缀/嵌套/URL 编码变体)', () => {
    // frozen namespace(逐项 exact regex,含 canvas suffix;未知 suffix 拒)
    expect(isUserStateKeyNamespaceAllowed('canvas:c1:selection')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('canvas:c1:camera')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('canvas:c1:chat-draft')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('pref:tool')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('panel:library')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('gateway-key')).toBe(false) // 不在 frozen 集(两把 key 天然拒)
    expect(isUserStateKeyNamespaceAllowed('mivo-key')).toBe(false)
    expect(isUserStateKeyNamespaceAllowed('canvas:c1:bogus')).toBe(false) // N6:未知 suffix 拒
    expect(isUserStateKeyNamespaceAllowed('random:stuff')).toBe(false)
    expect(userStateNamespaceKind('recent:projects')).toBe('array')
    expect(userStateNamespaceKind('pref:tool')).toBe('string')
    expect(userStateNamespaceKind('canvas:c1:selection')).toBe('string-array') // F7:只收 string[]
    expect(userStateNamespaceKind('canvas:c1:camera')).toBe('object')
    expect(userStateNamespaceKind('canvas:c1:chat-draft')).toBe('string')
    // 递归敏感扫描:字段名(大小写/连字符/camelCase 变体)
    expect(scanForSensitiveFields({ secret: 'x' })).toBe('secret')
    expect(scanForSensitiveFields({ userApiKey: 'x' })).toBe('userApiKey')
    expect(scanForSensitiveFields({ 'api-key': 'x' })).toBe('api-key')
    expect(scanForSensitiveFields({ AccessToken: 'x' })).toBe('AccessToken')
    expect(scanForSensitiveFields({ Authorization: 'x' })).toBe('Authorization')
    expect(scanForSensitiveFields({ nested: { password: 'x' } })).toBe('nested.password')
    expect(scanForSensitiveFields([{ a: 1 }, { token: 'y' }])).toBe('[1].token')
    // N6:凭据格式值(规范后大小写/URL 编码变体均命中)
    expect(scanForSensitiveFields({ data: 'mivo_stolenkey' })).toBe('data')
    expect(scanForSensitiveFields({ data: 'sk-xxxxxxxx' })).toBe('data')
    expect(scanForSensitiveFields({ data: 'MIVO_uppercase' })).toBe('data') // 大小写不敏感
    expect(scanForSensitiveFields({ data: 'Sk-mixedcase' })).toBe('data')
    expect(scanForSensitiveFields({ data: '%6divo_encoded' })).toBe('data') // URL 编码变体(decode → mivo_)
    // 干净 value 不拒
    expect(scanForSensitiveFields({ selection: ['n1', 'n2'] })).toBeNull()
    expect(scanForSensitiveFields({ camera: { x: 1, y: 2, zoom: 0.5 } })).toBeNull()
    expect(USER_STATE_KEY_NAMESPACES).toContain('canvas:')
  })

  it('返修 N5:If-Match 严格——十进制非负 safe integer(1.5/1e2/0x10/NaN/负数/超界全拒;区分 missing vs invalid)', () => {
    // missing(无 header)→ missing
    expect(parseIfMatch(undefined).kind).toBe('missing')
    expect(parseIfMatch('').kind).toBe('missing')
    // valid
    expect(parseIfMatch('0')).toEqual({ kind: 'value', revision: 0 })
    expect(parseIfMatch('42')).toEqual({ kind: 'value', revision: 42 })
    // invalid(非十进制非负 safe integer)
    expect(parseIfMatch('1.5').kind).toBe('invalid')
    expect(parseIfMatch('1e2').kind).toBe('invalid')
    expect(parseIfMatch('0x10').kind).toBe('invalid')
    expect(parseIfMatch('-1').kind).toBe('invalid')
    expect(parseIfMatch('abc').kind).toBe('invalid')
    expect(parseIfMatch(' 5').kind).toBe('invalid')
    expect(parseIfMatch('99999999999999999999999').kind).toBe('invalid') // 超 Number.MAX_SAFE_INTEGER
    // resolveBaseRevision(legacy alias)missing/invalid 均 undefined
    expect(resolveBaseRevision('1.5')).toBeUndefined()
    expect(resolveBaseRevision('42')).toBe(42)
  })

  it('Project wire 形状(client listProjects/createProject 消费)', () => {
    const p: Project = {
      id: 'p1', name: 'proj', ownerId: 'owner-a',
      createdAt: 't0', updatedAt: 't1', revision: 0, isDeleted: false,
    }
    expect(p.id).toBe('p1')
    expectTypeOf<Project['ownerId']>().toBeString()
  })

  it('unwired impl fail visibly(所有方法 reject,不静默成功 — Karpathy 规则 12)', async () => {
    await expect(unwiredServerPersistAdapter.fetchCanvas('c1')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.upsertNode('c1', {} as NodeRecord)).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.putUserState('k', 'v')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.deleteNode('c1', 'n1')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.deleteEdge('c1', 'e1')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.uploadAsset(new Uint8Array(), { mimeType: 'image/png', originalName: 'x.png' })).rejects.toThrow(/not wired/)
  })

  // ── 返修三 F1-F7 shared-level 互锁/单元(逐字复现场景)──

  it('F4:canvas id 全局唯一——跨 owner 同 canvas id → 409 canvas-exists body', () => {
    const err = { error: 'canvas-exists' as const, id: 'c1' }
    expect(err.error).toBe('canvas-exists')
    expectTypeOf(err).toMatchTypeOf<{ error: 'canvas-exists'; id: string }>()
  })

  it('F5:adapter.reorderChildren 带 baseContentVersion(第 4 参)+ 返 contentVersion(并发 seam;unwired fail visibly)', async () => {
    // 返 {reordered, contentVersion}(非 void,client 据此作下次 If-Match base)
    expectTypeOf<ServerPersistAdapter['reorderChildren']>().returns.toMatchTypeOf<
      Promise<{ reordered: number; contentVersion: Revision }>
    >()
    // 第 4 参 baseContentVersion?: Revision 传入(编译期签名互锁);unwired 仍 fail visibly。
    await expect(unwiredServerPersistAdapter.reorderChildren('c1', 'node', ['n1'], 0)).rejects.toThrow(/not wired/)
  })

  it('P2-4/F5:adapter.reorderChildren 第 4 参 baseContentVersion 必填(@ts-expect-error 负向类型互锁;纯类型层)', () => {
    // F5 seam 必填:不传 baseContentVersion → TS 编译错误;@ts-expect-error 钉住(若改回 optional,directive 失效 → 编译报错)。
    // 箭头包裹仅类型层触发,不实际调用(unwired runtime 会 reject)。
    // @ts-expect-error baseContentVersion is required (F5 seam mandatory)
    const _noBase = (a: ServerPersistAdapter) => a.reorderChildren('c1', 'node', ['n1'])
    void _noBase
  })

  it('F3:scanForSensitiveFields 对 object key best-effort decode+lower 再匹配;scanUserStateKeyForCredential 扫 key 段', () => {
    // F3:URL 编码 field name(%61piKey → decode apiKey → 命中 forbidden-value),path 返 raw key
    expect(scanForSensitiveFields({ '%61piKey': 'stolen' })).toBe('%61piKey')
    expect(scanForSensitiveFields({ '%41pi-key': 'x' })).toBe('%41pi-key') // %41=A → Api-key → match
    // 完整 user-state key credential 段扫描(按 `:` 切段,任一段 mivo_/sk- 前缀)
    expect(scanUserStateKeyForCredential('canvas:mivo_xxx:selection')).toBe('mivo_xxx')
    expect(scanUserStateKeyForCredential('canvas:%6divo_xxx:selection')).toBe('%6divo_xxx') // decode → mivo_xxx
    expect(scanUserStateKeyForCredential('panel:sk-leaked')).toBe('sk-leaked')
    expect(scanUserStateKeyForCredential('canvas:MIVO_upper:selection')).toBe('MIVO_upper') // 大小写不敏感
    expect(scanUserStateKeyForCredential('canvas:c1:selection')).toBeNull() // 干净 key
    expect(scanUserStateKeyForCredential('recent:projects')).toBeNull()
    // 既有 case 不回归(raw key path 返回,match 用 normalized)
    expect(scanForSensitiveFields({ 'api-key': 'x' })).toBe('api-key')
    expect(scanForSensitiveFields({ userApiKey: 'x' })).toBe('userApiKey')
    expect(scanForSensitiveFields({ data: '%6divo_encoded' })).toBe('data') // value 仍走 isCredentialValue
  })

  it('F6(schema-aware,lead 裁定 B):status/tasks 仅 schema 未定义处拒;aiWorkflow.status 放行;optional 类型;transform nested', () => {
    const base = {
      type: 'image', title: 't',
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      fills: [] as unknown[], strokes: [] as unknown[], effects: [] as unknown[], relations: {} as Record<string, unknown>,
    }
    // 干净 canonical → ok
    expect(validateChildPayload('node', { ...base }, 'n1').ok).toBe(true)
    // F6 schema-aware(lead 裁定 B):aiWorkflow.status 是 AI_WORKFLOW schema 合法字段 → 放行(不 forbidden)。
    //   生产 bug 回归:#256 server cutover 后 Block 1 ai-slot 占位 create(带 aiWorkflow.status)旧版被 400 拒;schema-aware 后放行。
    const fAi = validateChildPayload('node', { ...base, aiWorkflow: { kind: 'slot', status: 'empty', sourceNodeIds: ['n2'], prompt: 'p' } }, 'n1')
    expect(fAi.ok).toBe(true) // ★ aiWorkflow.status 放行(create 路由不再 400)
    // envelope 防线仍立:relations 内藏 status(schema 未定义)→ forbidden-field path=relations.status
    const f1 = validateChildPayload('node', { ...base, relations: { status: 'ready' } }, 'n1')
    expect(f1.ok).toBe(false)
    if (!f1.ok) expect(f1.body).toMatchObject({ reason: 'forbidden-field', field: 'relations.status' })
    // layout 内藏 status(schema 未定义:layout 字段是 mode/direction/gap/padding,无 status)→ forbidden-field(envelope 防线)
    const fLay = validateChildPayload('node', { ...base, layout: { mode: 'auto', status: 'ready' } }, 'n1')
    expect(fLay.ok).toBe(false)
    if (!fLay.ok) expect(fLay.body).toMatchObject({ reason: 'forbidden-field', field: 'layout.status' })
    // tasks 嵌套在 fills item(schema-aware:fill 元素须带 kind 选 variant,variant solid 的 fields 不含 tasks)→ forbidden-field(fills[0].tasks)
    const f2 = validateChildPayload('node', { ...base, fills: [{ kind: 'solid', tasks: [] }] }, 'n1')
    if (!f2.ok) expect(f2.body).toMatchObject({ reason: 'forbidden-field', field: 'fills[0].tasks' })
    // optional 类型校验:fontSize:'x' → bad-type
    const f3 = validateChildPayload('node', { ...base, fontSize: 'x' }, 'n1')
    if (!f3.ok) expect(f3.body).toMatchObject({ reason: 'bad-type', field: 'fontSize' })
    // optional 类型校验:textAutoWidth:'yes'(非 bool)→ bad-type
    const f4 = validateChildPayload('node', { ...base, textAutoWidth: 'yes' }, 'n1')
    if (!f4.ok) expect(f4.body).toMatchObject({ reason: 'bad-type', field: 'textAutoWidth' })
    // transform 内坏类型 → bad-type field=transform.x
    const f5 = validateChildPayload('node', { ...base, transform: { x: 'bad', y: 0, width: 100, height: 100, rotation: 0 } }, 'n1')
    if (!f5.ok) expect(f5.body).toMatchObject({ reason: 'bad-type', field: 'transform.x' })
    // transform nested unknown key → unknown-field field=transform.bogus
    const f6 = validateChildPayload('node', { ...base, transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, bogus: 1 } }, 'n1')
    if (!f6.ok) expect(f6.body).toMatchObject({ reason: 'unknown-field', field: 'transform.bogus' })
    // 既有顶层 forbidden 不回归:status 顶层 → forbidden-field field=status
    const f7 = validateChildPayload('node', { ...base, status: 'ready' }, 'n1')
    if (!f7.ok) expect(f7.body).toMatchObject({ reason: 'forbidden-field', field: 'status' })
  })

  it('F7:userStateNamespaceKind selection → string-array(与 SessionStore 对齐)', () => {
    expect(userStateNamespaceKind('canvas:c1:selection')).toBe('string-array')
    expect(userStateNamespaceKind('canvas:c1:camera')).toBe('object')
    expect(userStateNamespaceKind('canvas:c1:chat-draft')).toBe('string')
    expect(userStateNamespaceKind('recent:projects')).toBe('array') // recent 仍收任意 array
  })

  // ── 返修四 F3/P1-2:双重编码绕过(fixed-point decode 收口)──

  it('P1-2/F3:双重编码 field name + credential value/key 段全命中(normalizeForScan fixed-point decode)', () => {
    // 双重编码 field name(%2561piKey → %61piKey → apiKey)→ 命中 forbidden-value,path 返 raw key
    expect(scanForSensitiveFields({ '%2561piKey': 'stolen' })).toBe('%2561piKey')
    // 双重编码凭据格式值(%256divo_xxx → %6divo_xxx → mivo_xxx)→ 命中
    expect(scanForSensitiveFields({ data: '%256divo_xxx' })).toBe('data')
    // 双重编码 sk- 段(%2553k-test → %53k-test → Sk-test → sk-test)→ 命中
    expect(scanForSensitiveFields({ data: '%2553k-test' })).toBe('data')
    // user-state key 段双重编码(canvas:%256divo_xxx:selection → mivo_xxx;canvas:%2553k-test:selection → sk-test)
    expect(scanUserStateKeyForCredential('canvas:%256divo_xxx:selection')).toBe('%256divo_xxx')
    expect(scanUserStateKeyForCredential('canvas:%2553k-test:selection')).toBe('%2553k-test')
    // 三重编码(%252561piKey → %2561piKey → %61piKey → apiKey)仍命中(5 次上限内)
    expect(scanForSensitiveFields({ '%252561piKey': 'x' })).toBe('%252561piKey')
    // 既有单层编码不回归
    expect(scanForSensitiveFields({ '%61piKey': 'stolen' })).toBe('%61piKey')
    expect(scanForSensitiveFields({ data: '%6divo_encoded' })).toBe('data')
    expect(scanUserStateKeyForCredential('canvas:%6divo_xxx:selection')).toBe('%6divo_xxx')
    // 干净 key/value 不误报
    expect(scanForSensitiveFields({ selection: ['n1'] })).toBeNull()
    expect(scanUserStateKeyForCredential('canvas:c1:selection')).toBeNull()
  })

  // ── 返修五 F3/P1-2:真不动点 decode(循环至不再变化 + 累计输出长度阈值,非固定层数)──

  it('P1-2/F3 返修五:6 层编码 %252525252561piKey 命中(旧 5 次上限阻断第 6 次 → 漏);真不动点循环至 apiKey', () => {
    // 6 层:%252525252561piKey → decode 6 次到 apiKey(每层 %25 → %);旧 normalizeForScan 固定 5 次循环
    // 阻断第 6 次,停在 %61piKey 漏报。返修五真不动点循环至不再变化 → 第 6 次 decode 命中 apiKey。
    expect(scanForSensitiveFields({ '%252525252561piKey': 'x' })).toBe('%252525252561piKey')
    // 6 层 mivo_ 凭据值:%25252525256divo_xxx → decode 6 次到 mivo_xxx → 命中
    expect(scanForSensitiveFields({ data: '%25252525256divo_xxx' })).toBe('data')
    // 6 层 sk- 凭据值:%252525252553k-test → decode 6 次到 sk-test → 命中
    expect(scanForSensitiveFields({ data: '%252525252553k-test' })).toBe('data')
    // 6 层 user-state key 段
    expect(scanUserStateKeyForCredential('canvas:%25252525256divo_xxx:selection')).toBe('%25252525256divo_xxx')
  })

  it('P1-2/F3 返修六:超长输入不卡死 + 超预算 fail-closed(不返回部分结果漏报)', () => {
    // 1) 超长无 % 字面串:fixed-point 立即返回(单次循环,不卡死;非 credential → null)
    expect(scanForSensitiveFields({ data: 'a'.repeat(200_000) })).toBeNull()
    // 2) 多层 % 编码但累计解码在预算内(收敛至非 credential):不卡死、不误报 → null(钉死,非 null||'data' 两头堵)
    //    %25×50000 + 61piKey → 3 pass 收敛到 %×49999+apikey(非 mivo_/sk- credential value)→ null
    expect(scanForSensitiveFields({ data: '%25'.repeat(50_000) + '61piKey' })).toBeNull()
    // 3) 超长编码 + 真凭据 + 超预算:fail-closed 视作命中(旧 fail-open 返部分值 %6divo_secret<pad> 漏报 → 200)
    //    %256divo_secret + 600KB 填充:pass1 → %6divo_secret<pad>(无 mivo_ 前缀),累计输出超 MAX_DECODE_TOTAL
    //    → suspicious → 'data'(fail-closed,不返回部分结果)
    expect(scanForSensitiveFields({ data: '%256divo_secret' + 'x'.repeat(600_000) })).toBe('data')
  })

  it('P1-2/F3 返修六:malformed %(尾部孤立 %)分段安全解码 → 真凭据仍命中(旧 catch 返 raw 漏报)', () => {
    // %6divo_secret% → 分段解码 %6d→m + 保留尾部 % → mivo_secret% → 命中 mivo_ 前缀
    //   (旧 decodeURIComponent 抛 → catch 返 %6divo_secret% 无 mivo_ 前缀 → 漏报)
    expect(scanForSensitiveFields({ data: '%6divo_secret%' })).toBe('data')
    // %61piKey% 作 field name → 分段 %61→a + 保留尾部 % → apiKey% → 命中敏感名 apiKey(path 返 raw key)
    expect(scanForSensitiveFields({ '%61piKey%': 'x' })).toBe('%61piKey%')
    // 坏尾 user-state key 段:canvas:%6divo_secret%:selection → 段 %6divo_secret% 分段解码 → mivo_secret% → 命中 mivo_
    expect(scanUserStateKeyForCredential('canvas:%6divo_secret%:selection')).toBe('%6divo_secret%')
    // 干净孤立 %(如 "discount 50% off")不误杀:分段保留 %,非 credential → null
    //   (选分段解码而非整体 fail-closed 的理由:整体 fail-closed 会误杀含孤立 % 的良性值)
    expect(scanForSensitiveFields({ data: 'discount 50% off' })).toBeNull()
  })

  // ── 返修四 F6/P1-3:递归 exact schema 走私样本全 400(数组逐元素/nested object)──

  it('P1-3/F6:递归 exact——markupPoints 元素走私字段/fills 元素坏类型/generation.maskBounds 坏值+extra 全 400;canonical 全 200', () => {
    const base = {
      type: 'image', title: 't',
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      fills: [{ id: 'f1', kind: 'solid', color: '#fff', opacity: 1, visible: true }] as unknown[],
      strokes: [] as unknown[], effects: [] as unknown[], relations: {} as Record<string, unknown>,
    }
    // 干净 canonical(含 fills 元素全字段)→ ok
    expect(validateChildPayload('node', { ...base }, 'n1').ok).toBe(true)

    // 走私 1:markupPoints 元素 smuggled 字段 → unknown-field path=markupPoints[0].bogus
    const s1 = validateChildPayload('node', { ...base, markupPoints: [{ x: 0, y: 0, bogus: 1 }] }, 'n1')
    expect(s1.ok).toBe(false)
    if (!s1.ok) expect(s1.body).toMatchObject({ reason: 'unknown-field', field: 'markupPoints[0].bogus' })

    // 走私 2:fills 元素坏类型(id 非 string)→ bad-type path=fills[0].id
    const s2 = validateChildPayload('node', { ...base, fills: [{ id: 1, kind: 'solid', color: '#fff', opacity: 1, visible: true }] }, 'n1')
    expect(s2.ok).toBe(false)
    if (!s2.ok) expect(s2.body).toMatchObject({ reason: 'bad-type', field: 'fills[0].id' })

    // 走私 3:generation.maskBounds 坏值 + extra → unknown-field path=generation.maskBounds.extra(unknown 先于 type)
    const s3 = validateChildPayload('node', { ...base, generation: { prompt: 'p', model: 'm', maskBounds: { x: 'bad', y: 0, width: 1, height: 1, extra: 1 } } }, 'n1')
    expect(s3.ok).toBe(false)
    if (!s3.ok) expect(s3.body).toMatchObject({ reason: 'unknown-field', field: 'generation.maskBounds.extra' })

    // 走私 4:fills 元素走私字段(kind=solid 但带 scaleMode)→ unknown-field path=fills[0].scaleMode
    const s4 = validateChildPayload('node', { ...base, fills: [{ id: 'f1', kind: 'solid', color: '#fff', opacity: 1, visible: true, scaleMode: 'fill' }] }, 'n1')
    expect(s4.ok).toBe(false)
    if (!s4.ok) expect(s4.body).toMatchObject({ reason: 'unknown-field', field: 'fills[0].scaleMode' })

    // 走私 5:effects 未知 kind → unknown-field path=effects[0].kind(union dispatch 拒未知 tag)
    const s5 = validateChildPayload('node', { ...base, effects: [{ id: 'e1', kind: 'bogus', radius: 1, visible: true }] }, 'n1')
    expect(s5.ok).toBe(false)
    if (!s5.ok) expect(s5.body).toMatchObject({ reason: 'unknown-field', field: 'effects[0].kind' })

    // 走私 6:experimentalAnchors 元素走私字段 → unknown-field path=experimentalAnchors[0].smuggled
    const s6 = validateChildPayload('node', { ...base, experimentalAnchors: [{ id: 'a1', type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, smuggled: true }] }, 'n1')
    expect(s6.ok).toBe(false)
    if (!s6.ok) expect(s6.body).toMatchObject({ reason: 'unknown-field', field: 'experimentalAnchors[0].smuggled' })

    // 走私 7:relations 未知 key(aiWorkflow 不在 relations,canonical 留顶层)→ unknown-field path=relations.aiWorkflow
    const s7 = validateChildPayload('node', { ...base, relations: { aiWorkflow: { kind: 'slot' } } }, 'n1')
    expect(s7.ok).toBe(false)
    if (!s7.ok) expect(s7.body).toMatchObject({ reason: 'unknown-field', field: 'relations.aiWorkflow' })

    // 走私 8:aiWorkflow 缺必填 kind → missing-field path=aiWorkflow.kind(operation 非禁止键,不触发 forbidden)
    const s8 = validateChildPayload('node', { ...base, aiWorkflow: { operation: 'variation' } }, 'n1')
    expect(s8.ok).toBe(false)
    if (!s8.ok) expect(s8.body).toMatchObject({ reason: 'missing-field', field: 'aiWorkflow.kind' })

    // 合法 image fill + shadow effect + box anchor + 全 nested canonical → ok
    const full = {
      ...base,
      fills: [{ id: 'f1', kind: 'image', assetUrl: 'http://x', opacity: 1, visible: true, scaleMode: 'fill' }],
      effects: [{ id: 'e1', kind: 'shadow', color: '#000', x: 1, y: 1, blur: 2, spread: 0, opacity: 0.5, visible: true }],
      experimentalAnchors: [{ id: 'a1', type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, width: 10, height: 10, resultNodeIds: ['n3'] }],
      generation: { prompt: 'p', model: 'm', maskBounds: { x: 0, y: 0, width: 1, height: 1 }, maskSourceSize: { width: 100, height: 100 } },
      aiWorkflow: { kind: 'slot', sourceNodeIds: ['n2'] },
      layout: { mode: 'auto', direction: 'horizontal', gap: 4, padding: { top: 1, right: 1, bottom: 1, left: 1 } },
      constraints: { horizontal: 'left', vertical: 'top' },
      asset: { url: 'http://x', mimeType: 'image/png', sizeBytes: 10 },
      annotationBounds: { x: 0, y: 0, width: 1, height: 1 },
      imageCrop: { x: 0, y: 0, width: 1, height: 1 },
      assetSourceDimensions: { width: 100, height: 100 },
      markupPoints: [{ x: 0, y: 0, pressure: 0.5 }],
    }
    expect(validateChildPayload('node', full, 'n1').ok).toBe(true)
  })

  // ── 返修五 F6/P2-3:枚举 predicate(从 src/types 单一来源)+ anchor type 判别 union ──

  it('P2-3/F6:markupKind/markupBrushKind/markupStampKind/sectionLockMode/markdownDisplayMode 枚举 predicate——bogus 全 400;合法 200', () => {
    const base = {
      type: 'markup', title: 't',
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      fills: [] as unknown[], strokes: [] as unknown[], effects: [] as unknown[], relations: {} as Record<string, unknown>,
    }
    // 合法枚举 → ok
    expect(validateChildPayload('node', { ...base, markupKind: 'arrow' }, 'n1').ok).toBe(true)
    expect(validateChildPayload('node', { ...base, markupKind: 'stamp', markupStampKind: 'heart' }, 'n1').ok).toBe(true)
    expect(validateChildPayload('node', { ...base, markupBrushKind: 'highlighter', sectionLockMode: 'background', markdownDisplayMode: 'preview' }, 'n1').ok).toBe(true)
    // bogus 枚举 → bad-type(返修五:旧 scalar(isStr) 只校验是 string,放行 'bogus';现 enum predicate 拒)
    const e1 = validateChildPayload('node', { ...base, markupKind: 'bogus' }, 'n1')
    expect(e1.ok).toBe(false)
    if (!e1.ok) expect(e1.body).toMatchObject({ reason: 'bad-type', field: 'markupKind' })
    const e2 = validateChildPayload('node', { ...base, markupKind: 'stamp', markupStampKind: 'bogus' }, 'n1')
    expect(e2.ok).toBe(false)
    if (!e2.ok) expect(e2.body).toMatchObject({ reason: 'bad-type', field: 'markupStampKind' })
    const e3 = validateChildPayload('node', { ...base, markupBrushKind: 'bogus' }, 'n1')
    expect(e3.ok).toBe(false)
    if (!e3.ok) expect(e3.body).toMatchObject({ reason: 'bad-type', field: 'markupBrushKind' })
    const e4 = validateChildPayload('node', { ...base, sectionLockMode: 'bogus' }, 'n1')
    expect(e4.ok).toBe(false)
    if (!e4.ok) expect(e4.body).toMatchObject({ reason: 'bad-type', field: 'sectionLockMode' })
    const e5 = validateChildPayload('node', { ...base, markdownDisplayMode: 'bogus' }, 'n1')
    expect(e5.ok).toBe(false)
    if (!e5.ok) expect(e5.body).toMatchObject({ reason: 'bad-type', field: 'markdownDisplayMode' })
  })

  it('P2-3/F6:anchor type 判别 union——box 必填 width+height(missing-field);point 拒 width/height(unknown-field);bogus/缺 type 400', () => {
    // 顶层 anchor wire payload(id 来自 path,Omit)
    const pointAnchor = { type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1 }
    const boxAnchor = { type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, width: 10, height: 10 }
    expect(validateChildPayload('anchor', pointAnchor, 'a1').ok).toBe(true)
    expect(validateChildPayload('anchor', boxAnchor, 'a1').ok).toBe(true)
    // box 缺 width → missing-field(width)
    const eBox = validateChildPayload('anchor', { type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, height: 10 }, 'a1')
    expect(eBox.ok).toBe(false)
    if (!eBox.ok) expect(eBox.body).toMatchObject({ reason: 'missing-field', field: 'width' })
    // box 缺 height → missing-field(height)
    const eBox2 = validateChildPayload('anchor', { type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, width: 10 }, 'a1')
    expect(eBox2.ok).toBe(false)
    if (!eBox2.ok) expect(eBox2.body).toMatchObject({ reason: 'missing-field', field: 'height' })
    // point 带 width → unknown-field(width)
    const ePoint = validateChildPayload('anchor', { type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, width: 10 }, 'a1')
    expect(ePoint.ok).toBe(false)
    if (!ePoint.ok) expect(ePoint.body).toMatchObject({ reason: 'unknown-field', field: 'width' })
    // point 带 height → unknown-field(height)
    const ePoint2 = validateChildPayload('anchor', { type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, height: 10 }, 'a1')
    expect(ePoint2.ok).toBe(false)
    if (!ePoint2.ok) expect(ePoint2.body).toMatchObject({ reason: 'unknown-field', field: 'height' })
    // bogus type → unknown-field(type)(union 拒未知 tag)
    const eBogus = validateChildPayload('anchor', { type: 'bogus', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1 }, 'a1')
    expect(eBogus.ok).toBe(false)
    if (!eBogus.ok) expect(eBogus.body).toMatchObject({ reason: 'unknown-field', field: 'type' })
    // 缺 type → missing-field(type)
    const eNoType = validateChildPayload('anchor', { targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1 }, 'a1')
    expect(eNoType.ok).toBe(false)
    if (!eNoType.ok) expect(eNoType.body).toMatchObject({ reason: 'missing-field', field: 'type' })

    // node 内嵌 experimentalAnchors 元素(带 id,id 必填)
    const nodeBase = {
      type: 'image', title: 't',
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      fills: [] as unknown[], strokes: [] as unknown[], effects: [] as unknown[], relations: {} as Record<string, unknown>,
    }
    // 合法 box anchor 元素(带 id)→ ok
    expect(validateChildPayload('node', { ...nodeBase, experimentalAnchors: [{ id: 'a1', type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, width: 10, height: 10 }] }, 'n1').ok).toBe(true)
    // box 元素缺 width → missing-field
    const eBoxElem = validateChildPayload('node', { ...nodeBase, experimentalAnchors: [{ id: 'a1', type: 'box', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, height: 10 }] }, 'n1')
    expect(eBoxElem.ok).toBe(false)
    if (!eBoxElem.ok) expect(eBoxElem.body).toMatchObject({ reason: 'missing-field', field: 'experimentalAnchors[0].width' })
    // point 元素带 width → unknown-field
    const ePointElem = validateChildPayload('node', { ...nodeBase, experimentalAnchors: [{ id: 'a1', type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1, width: 10 }] }, 'n1')
    expect(ePointElem.ok).toBe(false)
    if (!ePointElem.ok) expect(ePointElem.body).toMatchObject({ reason: 'unknown-field', field: 'experimentalAnchors[0].width' })
    // 元素缺 id → missing-field(id)
    const eNoId = validateChildPayload('node', { ...nodeBase, experimentalAnchors: [{ type: 'point', targetNodeId: 'n2', x: 0, y: 0, instruction: 'i', createdAt: 1 }] }, 'n1')
    expect(eNoId.ok).toBe(false)
    if (!eNoId.ok) expect(eNoId.body).toMatchObject({ reason: 'missing-field', field: 'experimentalAnchors[0].id' })
  })
})
