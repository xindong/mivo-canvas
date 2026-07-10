// src/lib/serverPersistAdapter.contract.test.ts
// T1.3 前置:PersistAdapter 接口 ↔ 服务端契约类型共享互锁(返修 #5 Kernel↔Server 往返)。
// 互锁机制:server/routes/* 与本 ServerPersistAdapter 共同 import shared/persist-contract.ts
// 的 wire 类型。任一侧改 shape → 编译期 break(tsc -b 覆盖 server + app 两 project,均含 shared)。
// 本测试用 expectTypeOf(类型层)+ JSON round-trip(运行时层)双保险,并钉 unwired impl fail visibly。

import { describe, expect, it, expectTypeOf } from 'vitest'
import type {
  AssetRef,
  CanvasMeta,
  ConflictBody,
  CreateAssetResponse,
  GetCanvasResponse,
  PreconditionRequiredBody,
  Project,
  RecordEntry,
  Revision,
  TooLargeBody,
  UnknownResourceBody,
  UpsertRequest,
  UpsertResponse,
  UserStateEntry,
} from '../../shared/persist-contract.ts'
import {
  isUserStateKeyNamespaceAllowed,
  resolveBaseRevision,
  scanForSensitiveFields,
  userStateNamespaceKind,
  USER_STATE_KEY_NAMESPACES,
} from '../../shared/persist-contract.ts'
import { unwiredServerPersistAdapter, type ServerPersistAdapter } from './serverPersistAdapter'
import type { NodeRecord } from '../kernel/records'

describe('T1.3 ServerPersistAdapter ↔ server contract 类型共享互锁(返修版)', () => {
  it('shared wire 类型被 client + server 共同 import(互锁基础)', () => {
    expectTypeOf<UpsertResponse>().toEqualTypeOf<{ id: string; revision: Revision }>()
    expectTypeOf<ConflictBody>().toEqualTypeOf<{ error: 'revision-conflict'; id: string; currentRevision: Revision }>()
  })

  it('adapter 方法返回类型 = shared wire 响应类型(fetchCanvas/upsert/putUserState + 返修 #8 asset seam)', () => {
    expectTypeOf<ServerPersistAdapter['fetchCanvas']>().returns.toMatchTypeOf<Promise<GetCanvasResponse | null>>()
    expectTypeOf<ServerPersistAdapter['upsertNode']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertEdge']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertAnchor']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['appendChatMessage']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['putUserState']>().returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['getUserState']>().returns.toMatchTypeOf<Promise<UserStateEntry | null>>()
    // 返修 #8:edge/anchor delete + canvas 枚举 + asset seam
    expectTypeOf<ServerPersistAdapter['deleteEdge']>().returns.toMatchTypeOf<Promise<void>>()
    expectTypeOf<ServerPersistAdapter['deleteAnchor']>().returns.toMatchTypeOf<Promise<void>>()
    expectTypeOf<ServerPersistAdapter['listCanvas']>().returns.toMatchTypeOf<Promise<{ canvases: CanvasMeta[] }>>()
    expectTypeOf<ServerPersistAdapter['uploadAsset']>().returns.toMatchTypeOf<Promise<CreateAssetResponse>>()
    expectTypeOf<ServerPersistAdapter['resolveAsset']>().returns.toMatchTypeOf<Promise<AssetRef | null>>()
  })

  it('返修 #5:wire body 不携带 revision——UpsertRequest<NodeRecord> 仅 {payload}(base 走 If-Match)', () => {
    const node = { id: 'n1', type: 'image', title: 't', revision: 3 } as unknown as NodeRecord
    const req: UpsertRequest<NodeRecord> = { payload: node }
    expectTypeOf<UpsertRequest<NodeRecord>>().toMatchTypeOf<{ payload: NodeRecord }>()
    // wire body 无 revision 字段(shared 类型已删,返修 #5)
    expectTypeOf<UpsertRequest<NodeRecord>>().not.toHaveProperty('revision')
    expect(req.payload).toBe(node)
  })

  it('返修 #5:Kernel↔Server revision 往返——envelope 唯一真相,baseRevision 经 If-Match 解析', () => {
    // client 读 envelope revision(RecordEntry.revision)= base;PATCH 时作 If-Match header(不在 body)
    const entry: RecordEntry = { id: 'n1', revision: 5, orderKey: 2, payload: { type: 'image' } }
    const ifMatch = String(entry.revision)
    expect(resolveBaseRevision(ifMatch)).toBe(5)
    // server 返 UpsertResponse(envelope revision post-bump);client sync = envelope revision,不双写 payload
    const res: UpsertResponse = { id: 'n1', revision: 6 }
    expect(res.revision).toBe(6)
    // payload 内 NodeRecord.revision 是 kernel 镜像,wire 不作为真相(返修 #5)
    expectTypeOf<RecordEntry>().toMatchTypeOf<{ id: string; revision: Revision; orderKey: number; payload: unknown }>()
  })

  it('返修 #5:CanvasMeta metaRevision 与 contentVersion 分名(GET /api/canvas/:id 响应)', () => {
    expectTypeOf<CanvasMeta>().toHaveProperty('metaRevision')
    expectTypeOf<CanvasMeta>().toHaveProperty('contentVersion')
    expectTypeOf<CanvasMeta>().not.toHaveProperty('revision')
    expectTypeOf<CanvasMeta>().toHaveProperty('sourceTemplateId') // 返修 #8
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

  it('404 不存在 body 跨 owner 同形(无存在泄漏,§1/#1;返修 #2 新增 unknown-collection)', () => {
    const u: UnknownResourceBody = { error: 'unknown-canvas' }
    expect(u.error).toBe('unknown-canvas')
    const coll: UnknownResourceBody = { error: 'unknown-collection' }
    expect(coll.error).toBe('unknown-collection')
  })

  it('返修 #9:DP-7 namespace allowlist + 递归敏感扫描(大小写/连字符/camelCase/前缀/嵌套)', () => {
    // namespace allowlist
    expect(isUserStateKeyNamespaceAllowed('canvas:c1:selection')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('pref:tool')).toBe(true)
    expect(isUserStateKeyNamespaceAllowed('gateway-key')).toBe(false) // 不在 allowlist(两把 key 天然拒)
    expect(isUserStateKeyNamespaceAllowed('mivo-key')).toBe(false)
    expect(isUserStateKeyNamespaceAllowed('random:stuff')).toBe(false)
    expect(userStateNamespaceKind('recent:projects')).toBe('array')
    expect(userStateNamespaceKind('pref:tool')).toBe('string')
    // 递归敏感扫描:字段名(大小写/连字符/camelCase 变体)
    expect(scanForSensitiveFields({ secret: 'x' })).toBe('secret')
    expect(scanForSensitiveFields({ userApiKey: 'x' })).toBe('userApiKey')
    expect(scanForSensitiveFields({ 'api-key': 'x' })).toBe('api-key')
    expect(scanForSensitiveFields({ AccessToken: 'x' })).toBe('AccessToken')
    expect(scanForSensitiveFields({ Authorization: 'x' })).toBe('Authorization')
    // 嵌套
    expect(scanForSensitiveFields({ nested: { password: 'x' } })).toBe('nested.password')
    expect(scanForSensitiveFields([{ a: 1 }, { token: 'y' }])).toBe('[1].token')
    // 凭据格式值(形如 mivo_/sk-)
    expect(scanForSensitiveFields({ data: 'mivo_stolenkey' })).toBe('data')
    expect(scanForSensitiveFields({ data: 'sk-xxxxxxxx' })).toBe('data')
    // 干净 value 不拒
    expect(scanForSensitiveFields({ selection: ['n1', 'n2'] })).toBeNull()
    expect(scanForSensitiveFields({ camera: { x: 1, y: 2, zoom: 0.5 } })).toBeNull()
    expect(USER_STATE_KEY_NAMESPACES).toContain('canvas:')
  })

  it('返修 #5:wire fixture JSON round-trip(GetCanvasResponse 整体可序列化,跨设备原样在)', () => {
    const wire: GetCanvasResponse = {
      id: 'c1', projectId: 'p1', title: 'canvas',
      createdAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:01:00Z',
      metaRevision: 2, contentVersion: 3,
      nodes: [{ id: 'n1', revision: 0, orderKey: 0, payload: { type: 'image' } }],
      edges: [], anchors: [],
    }
    const round = JSON.parse(JSON.stringify(wire)) as GetCanvasResponse
    expect(round.id).toBe('c1')
    expect(round.metaRevision).toBe(2)
    expect(round.contentVersion).toBe(3)
    expect(round.nodes[0].revision).toBe(0)
    expect(round.nodes[0].orderKey).toBe(0)
    expect(round.nodes[0].payload).toEqual({ type: 'image' })
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
