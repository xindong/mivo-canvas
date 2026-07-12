// chatWiring.integration.test.ts
// G1-a chat 接线(DP-6R P1-1)集成测试:hydrate + mutation enqueue + adapter per-actor wire。
//
// 验收(对齐 lead 追加范围):
//  - server 模式 chat hydrate:hydrateFromServer 拉 active canvas 的 per-actor chat collection → useChatStore 灌入。
//  - chat mutation 入队:appendNotice → enqueue → queue drain → POST /api/canvas/:id/chat(wired op,非 terminal)。
//  - dp6r per-actor 语义 stub:KEY_A 的 chat 对 KEY_B 不可见;匿名(无 key)→ 401 require-login。
//
// 本测试用注入 fetch/stub(不依赖真实 dp6r route——dp6r route 在另一分支,lead 安排 dp6r 先进 main)。
// local 模式(isLocalPersist=true,test env 默认)gate 关闭 → appendNotice 正常进行;queue 显式 start。

import { describe, expect, it, beforeEach, vi } from 'vitest'

// Hermetic setup(同 chatStore.test.ts):node env 无 DOM/localStorage;chatStore/canvasStore
// 经 canvasDocumentModel→demoScenes→demoImages 在 module load 触发 scenes()→createDemoImage
// →document.createElement 炸。装 in-memory localStorage(zustand persist)+ stub demoImage renderer。
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k) },
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
  }
  // node env 无 DOM;writeRetryQueue stop/start 调 window.addEventListener/removeEventListener('online')
  // 与 document.removeEventListener('visibilitychange')——给空实现规避;debugLogger 经
  // remoteDebugReporter flush,stub 之(chatStore.test.ts 同模式)。
  const noop = (): void => {}
  const eventTarget = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage, ...eventTarget }
  if (g.localStorage === undefined) g.localStorage = memStorage
  if (g.document === undefined) g.document = { ...eventTarget }
})
vi.mock('./demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))
vi.mock('../store/remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import { useChatStore } from '../store/chatStore'
import { useCanvasStore } from '../store/canvasStore'
import {
  startPersistWriteQueue,
  stopPersistWriteQueue,
  drainPersistQueue,
  hydrateFromServer,
  __resetPersistBoot,
} from './persistBoot'
import { __resetWriteQueueDb } from './writeRetryQueue'
import { createFetchServerPersistAdapter, HttpError } from './serverPersistAdapter'
import type { ServerPersistAdapter } from './serverPersistAdapter'
import type { ChatMessage } from '../store/chatStore'

const KEY_A = 'mivo_aaa_user_a'
const KEY_B = 'mivo_bbb_user_b'
const authHeaders = (key: string): Record<string, string> => ({ 'x-mivo-api-key': key })
const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

const makeChatMessage = (id: string, text: string): ChatMessage =>
  ({ id, role: 'user', kind: 'text', text, createdAt: 1, status: 'done' } as unknown as ChatMessage)

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
  useChatStore.setState({ messagesByScene: {} })
})

describe('G1-a chat — server hydrate 拉 per-actor chat collection', () => {
  it('hydrateFromServer(fakeAdapter) → active canvas 的 chat 灌入 useChatStore.messagesByScene', async () => {
    // active sceneId
    useCanvasStore.setState({ sceneId: 'c-active' })
    const serverMsgs = [makeChatMessage('m1', 'hello'), makeChatMessage('m2', 'world')]
    const fakeAdapter = {
      listProjects: async () => ({ projects: [] }),
      listCanvas: async () => ({ canvases: [] }),
      listChatMessages: async (canvasId: string) => {
        expect(canvasId).toBe('c-active')
        return { messages: serverMsgs.map((m, i) => ({ id: m.id, revision: i, orderKey: i, payload: m })) }
      },
    } as unknown as ServerPersistAdapter
    const fakeOpts = {
      fetch: async () => new Response(JSON.stringify({ entries: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
      baseUrl: '',
      getAuthHeaders: () => authHeaders(KEY_A),
    }
    await hydrateFromServer(fakeAdapter, fakeOpts)
    const msgs = useChatStore.getState().messagesByScene['c-active']
    expect(msgs?.length).toBe(2)
    expect(msgs?.[0].id).toBe('m1')
    expect(msgs?.[1].text).toBe('world')
  })
})

describe('G1-a chat — mutation enqueue(appendNotice → POST /api/canvas/:id/chat)', () => {
  it('appendNotice → enqueue → drain → POST chat,wire shape 正确', async () => {
    const calls: { method: string; path: string; body: unknown }[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: new URL(input, 'http://stub').pathname,
        body: init?.body ? JSON.parse(init.body as string) : null,
      })
      return new Response(JSON.stringify({ id: 'srv', revision: 0 }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    startPersistWriteQueue({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders(KEY_A) })
    useChatStore.getState().appendNotice({ sceneId: 'c1', origin: 'chat', prompt: '生成完毕' })
    await flush()
    await drainPersistQueue()
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/canvas/c1/chat' })
    expect(calls[0].body).toHaveProperty('message')
    // message payload 是 opaque ChatMessage(notice)
    const msg = (calls[0].body as { message: { text: string; kind: string } }).message
    expect(msg.text).toBe('生成完毕')
    expect(msg.kind).toBe('notice')
  })
})

describe('G1-a chat — adapter per-actor wire(dp6r 语义 stub:隔离 + 匿名 401)', () => {
  /** dp6r per-actor stub:KEY_A 的 chat 只对 KEY_A 可见;KEY_B 空;无 key → 401 require-login。 */
  const makeDp6rStub = () => {
    const byOwner: Record<string, ChatMessage[]> = { [KEY_A]: [makeChatMessage('a1', 'A-chat')], [KEY_B]: [] }
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = new URL(input, 'http://stub').pathname
      const headers = new Headers((init?.headers as Record<string, string>) ?? {})
      const key = headers.get('x-mivo-api-key')
      if (!key) return new Response(JSON.stringify({ error: 'require-login' }), { status: 401, headers: { 'content-type': 'application/json' } })
      if (method === 'GET' && path.startsWith('/api/canvas/') && path.endsWith('/chat')) {
        const msgs = byOwner[key] ?? []
        return new Response(JSON.stringify({ messages: msgs.map((m, i) => ({ id: m.id, revision: i, orderKey: i, payload: m })) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'POST' && path.startsWith('/api/canvas/') && path.endsWith('/chat')) {
        const b = JSON.parse((init?.body as string) ?? '{}') as { message: ChatMessage }
        byOwner[key] = [...(byOwner[key] ?? []), b.message]
        return new Response(JSON.stringify({ id: b.message.id, revision: 0 }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 404 })
    }
    return { fetch, byOwner }
  }

  it('KEY_A listChatMessages 返 A 的 chat;KEY_B 返空(per-actor 隔离)', async () => {
    const { fetch } = makeDp6rStub()
    const adapterA = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders(KEY_A) })
    const adapterB = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders(KEY_B) })
    const aMsgs = await adapterA.listChatMessages('c1')
    expect(aMsgs.messages.length).toBe(1)
    expect((aMsgs.messages[0].payload as ChatMessage).text).toBe('A-chat')
    const bMsgs = await adapterB.listChatMessages('c1')
    expect(bMsgs.messages.length).toBe(0) // B 看不到 A 的 chat
  })

  it('无 key(匿名)→ 401 require-login(HttpError;触发 UI 门控)', async () => {
    const { fetch } = makeDp6rStub()
    const adapter = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: () => ({}) })
    await expect(adapter.listChatMessages('c1')).rejects.toMatchObject({ name: 'HttpError', status: 401 })
  })

  it('KEY_A appendChatMessage → 写入 A 的 collection;B 仍看不到(KEY_B list 仍空——A 的新消息在 A collection)', async () => {
    const { fetch, byOwner } = makeDp6rStub()
    const adapterA = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders(KEY_A) })
    const adapterB = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: () => authHeaders(KEY_B) })
    await adapterA.appendChatMessage('c1', makeChatMessage('a2', 'A-new'))
    expect(byOwner[KEY_A].length).toBe(2)
    const bMsgs = await adapterB.listChatMessages('c1')
    expect(bMsgs.messages.length).toBe(0) // B collection 仍空
    // 确认匿名 append 也 401
    const adapterAnon = createFetchServerPersistAdapter({ fetch, baseUrl: '', getAuthHeaders: () => ({}) })
    await expect(adapterAnon.appendChatMessage('c1', makeChatMessage('x', 'x'))).rejects.toMatchObject({ name: 'HttpError', status: 401 })
    // 捕获 HttpError 类型供 executor 分类(401 → unauthorized,队列暂停)
    try {
      await adapterAnon.appendChatMessage('c1', makeChatMessage('y', 'y'))
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
    }
  })
})
