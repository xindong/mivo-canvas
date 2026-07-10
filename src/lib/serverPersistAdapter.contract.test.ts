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
  userStateNamespaceKind,
  USER_STATE_KEY_NAMESPACES,
} from '../../shared/persist-contract.ts'
import { unwiredServerPersistAdapter, type ServerPersistAdapter } from './serverPersistAdapter'
import type { NodeRecord } from '../kernel/records'

describe('T1.3 ServerPersistAdapter ↔ server contract 类型共享互锁(返修版二)', () => {
  it('shared wire 类型被 client + server 共同 import(互锁基础)', () => {
    expectTypeOf<UpsertResponse>().toEqualTypeOf<{ id: string; revision: Revision }>()
    expectTypeOf<ConflictBody>().toEqualTypeOf<{ error: 'revision-conflict'; id: string; currentRevision: Revision }>()
  })

  it('adapter 方法返回类型 = shared wire 响应类型(fetchCanvas/upsert/putUserState + #8/N9 asset seam)', () => {
    expectTypeOf<ServerPersistAdapter['fetchCanvas']>().returns.toMatchTypeOf<Promise<GetCanvasResponse | null>>()
    expectTypeOf<ServerPersistAdapter['upsertNode']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertEdge']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertAnchor']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
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
    expect(userStateNamespaceKind('canvas:c1:selection')).toBe('array')
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
})
