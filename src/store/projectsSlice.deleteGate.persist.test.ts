// projectsSlice.deleteGate.persist.test.ts
// PR-C2 P1-1:archived project 彻底删除的 active-child 闸门必须在任何持久化入队之前 fail-closed。
//
// 审查结论:整树删除分支按 projectId 删全部子画布不查 status,而侧栏把「archived 父下的
// active 子」防御性展示为 active standalone(用户可见可编辑);确认弹窗 canvasCount 只统计
// archived 子 → 宣告范围 < 实际删除 = 静默数据丢失。修法为 blocked(不删、零 enqueue、warn)。
//
// 本文件钉 persistMode=server(镜像 documentSlice.persist.test.ts 的 hermetic 结构),用计数
// fetch 验证 wire 层:
//  - blocked 路径:drain 后零请求(无 DELETE /api/projects、无 DELETE /api/canvas)。
//  - 全 archived 回归路径:DELETE 正常入队发出(闸门不误伤合法整树删除)。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k) },
    setItem: (k: string, v: string) => store.set(k, String(v)),
  }
  const noop = (): void => {}
  const eventTarget = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage, ...eventTarget }
  if (g.localStorage === undefined) g.localStorage = memStorage
  if (g.document === undefined) g.document = { ...eventTarget }
})
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))
// 钉 persistMode=server(必须在 import canvasStore 之前;vi.mock 提升)。test env 默认 local。
vi.mock('../lib/persistMode', () => ({
  isLocalPersist: false,
  isShadowPersist: false,
  isServerPersist: true,
  persistMode: 'server' as const,
  getPersistMode: () => 'server' as const,
}))

import { useCanvasStore } from './canvasStore'
import { startPersistWriteQueue, stopPersistWriteQueue, __resetPersistBoot } from '../lib/persistBoot'
import { __resetWriteQueueDb } from '../lib/writeRetryQueue'
import type { CanvasDocument, CanvasProject } from '../types/mivoCanvas'

const KEY_A = 'mivo_aaa_user_a'
const authHeaders = (): Record<string, string> => ({ 'x-mivo-api-key': KEY_A })
const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 计数 fetch + 记录 wire shape(method/path)。返 200/204 让非画布 op success。 */
const makeCountingFetch = () => {
  const calls: { method: string; path: string }[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(input, 'http://stub').pathname
    calls.push({ method, path })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ id: 'srv', revision: 0, metaRevision: 0, contentVersion: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

const project = (id: string, status: 'active' | 'archived'): CanvasProject => ({
  id,
  name: id,
  createdAt: '2026-07-18T00:00:00.000Z',
  status,
})
const canvas = (
  title: string,
  projectId?: string,
  status: 'active' | 'archived' = 'active',
): CanvasDocument => ({
  title,
  projectId,
  status,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeIds: [],
})

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
})

describe('PR-C2 P1-1 — archived project 彻底删除的 active-child 闸门(server 模式零 enqueue)', () => {
  it('存在 active 脏子画布 → blocked:store 原样 + drain 后零 wire 请求', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.setState({
      projects: [project('p-dirty', 'archived')],
      canvases: {
        dirtyChild: canvas('dirty active child', 'p-dirty', 'active'),
        archivedChild: canvas('archived child', 'p-dirty', 'archived'),
        survivor: canvas('outside survivor'),
      },
      sceneId: 'survivor',
    } as never)

    const result = useCanvasStore.getState().deleteProject('p-dirty')
    await flush()
    const { drainPersistQueue } = await import('../lib/persistBoot')
    await drainPersistQueue()

    expect(result).toEqual({ status: 'blocked', reason: 'active-child' })
    expect(useCanvasStore.getState().projects.find((p) => p.id === 'p-dirty')?.status).toBe('archived')
    expect(useCanvasStore.getState().canvases.dirtyChild?.status).toBe('active')
    expect(useCanvasStore.getState().canvases.archivedChild?.status).toBe('archived')
    // 零 enqueue:blocked 在 enqueuePersistWrite 之前返回 → 无任何 DELETE/POST 出网。
    expect(calls).toEqual([])
  })

  it('全部子画布已 archived → 正常整树删除(回归):DELETE project + 级联 DELETE canvas 入队发出', async () => {
    const { fetch, calls } = makeCountingFetch()
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders() })
    useCanvasStore.setState({
      projects: [project('p-clean', 'archived')],
      canvases: {
        archivedChild: canvas('archived child', 'p-clean', 'archived'),
        survivor: canvas('outside survivor'),
      },
      sceneId: 'survivor',
    } as never)

    const result = useCanvasStore.getState().deleteProject('p-clean')
    await flush()
    const { drainPersistQueue } = await import('../lib/persistBoot')
    await drainPersistQueue()

    expect(result).toEqual({ status: 'deleted' })
    expect(useCanvasStore.getState().projects.find((p) => p.id === 'p-clean')).toBeUndefined()
    expect(useCanvasStore.getState().canvases.archivedChild).toBeUndefined()
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path)
    expect(deletes).toContain('/api/projects/p-clean')
    expect(deletes.some((p) => p.startsWith('/api/canvas/'))).toBe(true)
  })
})
