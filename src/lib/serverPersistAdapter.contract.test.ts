// src/lib/serverPersistAdapter.contract.test.ts
// T1.3 前置:PersistAdapter 接口 ↔ 服务端契约类型共享互锁(lead §3 任务 #3 选项一)。
// 互锁机制:server/routes/* 与本 ServerPersistAdapter 共同 import shared/persist-contract.ts
// 的 wire 类型。任一侧改 shape → 编译期 break(tsc -b 覆盖 server + app 两 project,均含 shared)。
// 本测试用 expectTypeOf(类型层)+ JSON round-trip(运行时层)双保险,并钉 unwired impl fail visibly。

import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'
import type {
  ConflictBody,
  GetCanvasResponse,
  Project,
  RecordEntry,
  Revision,
  UnknownResourceBody,
  UpsertRequest,
  UpsertResponse,
  UserStateEntry,
} from '../../shared/persist-contract.ts'
import {
  isUserStateKeyForbidden,
  USER_STATE_FORBIDDEN_KEY_NAMES,
} from '../../shared/persist-contract.ts'
import { unwiredServerPersistAdapter, type ServerPersistAdapter } from './serverPersistAdapter'
import type { NodeRecord } from '../kernel/records'

describe('T1.3 ServerPersistAdapter ↔ server contract 类型共享互锁', () => {
  it('shared wire 类型被 client + server 共同 import(互锁基础)', () => {
    // 这行 import 本身能编译 = shared 模块在 tsconfig.app(server 用 tsconfig.server)均被 include,
    // 两 project 共编译同一 shared/persist-contract.ts → 任一侧改 shape 双侧 break。
    expectTypeOf<UpsertResponse>().toEqualTypeOf<{ id: string; revision: Revision }>()
    expectTypeOf<ConflictBody>().toEqualTypeOf<{ error: 'revision-conflict'; id: string; currentRevision: Revision }>()
  })

  it('adapter 方法返回类型 = shared wire 响应类型(fetchCanvas/upsert/putUserState)', () => {
    expectTypeOf<ServerPersistAdapter['fetchCanvas']>()
      .returns.toMatchTypeOf<Promise<GetCanvasResponse | null>>()
    expectTypeOf<ServerPersistAdapter['upsertNode']>()
      .returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertEdge']>()
      .returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['upsertAnchor']>()
      .returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['appendChatMessage']>()
      .returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['putUserState']>()
      .returns.toMatchTypeOf<Promise<UpsertResponse>>()
    expectTypeOf<ServerPersistAdapter['getUserState']>()
      .returns.toMatchTypeOf<Promise<UserStateEntry | null>>()
  })

  it('client UpsertRequest shape = server PATCH/PUT body shape(节点级 PATCH FX-4 baseRevision)', () => {
    // client upsertNode 把 (node, baseRevision) 组成 UpsertRequest<NodeRecord> PATCH 给服务端;
    // 服务端 readJsonBody<UpsertRequest<unknown>> 解析同形(payload 不透明)。
    const node = { id: 'n1', type: 'image', title: 't', revision: 3 } as unknown as NodeRecord
    const req: UpsertRequest<NodeRecord> = { payload: node, revision: 3 }
    expectTypeOf<UpsertRequest<NodeRecord>>().toMatchTypeOf<{ payload: NodeRecord; revision?: Revision }>()
    expect(req.payload).toBe(node)
    expect(req.revision).toBe(3)
  })

  it('GetCanvasResponse per-record revision 让 client 下次 PATCH 带正确 If-Match', () => {
    const entry: RecordEntry = { id: 'n1', revision: 5, payload: { type: 'image' } }
    expectTypeOf<GetCanvasResponse['nodes']>().toMatchTypeOf<RecordEntry[]>()
    expect(entry.revision).toBe(5) // envelope revision = canonical;base for next PATCH
  })

  it('Project wire 形状(client listProjects/createProject 消费)', () => {
    const p: Project = {
      id: 'p1', name: 'proj', ownerId: 'owner-a',
      createdAt: 't0', updatedAt: 't1', revision: 0, isDeleted: false,
    }
    expect(p.id).toBe('p1')
    expectTypeOf<Project['ownerId']>().toBeString()
  })

  it('404 不存在 body 跨 owner 同形(无存在泄漏,§1)', () => {
    const u: UnknownResourceBody = { error: 'unknown-canvas' }
    expect(u.error).toBe('unknown-canvas')
  })

  it('DP-7 排除清单服务端兜底(client 期望 PUT forbidden-key → 400)', () => {
    expect(isUserStateKeyForbidden('gateway-key')).toBe(true)
    expect(isUserStateKeyForbidden('mivo-key')).toBe(true)
    expect(isUserStateKeyForbidden('canvas:c1:selection')).toBe(false)
    expect(isUserStateKeyForbidden('user-session-token')).toBe(true)
    expect(USER_STATE_FORBIDDEN_KEY_NAMES.has('gateway-key')).toBe(true)
  })

  it('wire fixture JSON round-trip(GetCanvasResponse 整体可序列化,跨设备原样在)', () => {
    const wire: GetCanvasResponse = {
      id: 'c1', projectId: 'p1', title: 'canvas',
      createdAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:01:00Z', revision: 2,
      nodes: [{ id: 'n1', revision: 0, payload: { type: 'image' } }],
      edges: [], anchors: [],
    }
    const round = JSON.parse(JSON.stringify(wire)) as GetCanvasResponse
    expect(round.id).toBe('c1')
    expect(round.nodes[0].revision).toBe(0)
    expect(round.nodes[0].payload).toEqual({ type: 'image' })
  })

  it('unwired impl fail visibly(所有方法 reject,不静默成功 — Karpathy 规则 12)', async () => {
    await expect(unwiredServerPersistAdapter.fetchCanvas('c1')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.upsertNode('c1', {} as NodeRecord)).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.putUserState('k', 'v')).rejects.toThrow(/not wired/)
    await expect(unwiredServerPersistAdapter.deleteNode('c1', 'n1')).rejects.toThrow(/not wired/)
  })
})
