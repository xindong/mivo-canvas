// chatAnonymousGate.test.ts
// G1-a chat 接线(DP-6R P1-1)匿名/未认证 UI 门控:server/shadow 模式未登录 → ChatComposer 禁用 +
// chatStore.sendMessage/appendNotice no-op(不写 anonymous chat IDB)。
//
// 验收(对齐 lead 追加范围第 3 条):
//  - server 模式未登录 → appendNotice no-op(messagesByScene 不变 = 不落 IDB)。
//  - server 模式已登录 → appendNotice 正常 append + enqueue。
//  - local 模式(零变化)→ 无 gate(本测试 mock persistMode=server,local 行为由既有表征测试覆盖)。
//
// 用 vi.mock 把 persistMode 钉成 server(test env 默认 local),驱动 gate 分支。

import { describe, expect, it, beforeEach, vi } from 'vitest'

// Hermetic setup(同 chatStore.test.ts):node env 无 DOM/localStorage;chatStore 经
// canvasDocumentModel→demoScenes→demoImages 在 module load 触发 scenes()→createDemoImage
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

// 钉 persistMode=server(必须在 import chatStore 之前;vi.mock 提升)。
vi.mock('../lib/persistMode', () => ({
  isLocalPersist: false,
  isShadowPersist: false,
  isServerPersist: true,
  persistMode: 'server' as const,
  getPersistMode: () => 'server' as const,
}))

import { useChatStore } from '../store/chatStore'
import { useAuthStore } from '../store/authSlice'
import { stopPersistWriteQueue, __resetPersistBoot } from './persistBoot'
import { __resetWriteQueueDb } from './writeRetryQueue'

beforeEach(async () => {
  stopPersistWriteQueue()
  __resetPersistBoot()
  await __resetWriteQueueDb()
  useChatStore.setState({ messagesByScene: {} })
  useAuthStore.setState({ user: null, status: 'unauthenticated' })
})

describe('G1-a chat 匿名门控 — server 模式未登录 → 拒写(不落 IDB)', () => {
  it('未登录 → appendNotice no-op(messagesByScene 不变,不写 IDB)', () => {
    useAuthStore.setState({ status: 'unauthenticated' })
    useChatStore.setState({ messagesByScene: {} })
    // act: appendNotice 在 server 模式 + 未登录 → 立即 return(no set, no enqueue)
    useChatStore.getState().appendNotice({ sceneId: 's1', origin: 'chat', prompt: 'p' })
    // 无 set() → messagesByScene 仍空(无 IDB 写)
    expect(useChatStore.getState().messagesByScene['s1']).toBeUndefined()
  })

  it('未登录 → sendMessage no-op(isBusy 不置 true,messagesByScene 不变)', async () => {
    useAuthStore.setState({ status: 'unauthenticated' })
    useChatStore.setState({ messagesByScene: {}, isBusy: false })
    // sendMessage 是 async + 复杂生成流;gate 在顶部 → 立即 return(isBusy 不置 true,不 append)。
    // 不传 referenceFiles 避免 saveReferenceAssets 触发文件 IO;gate 在 referenceAssetUrls 之前。
    await useChatStore.getState().sendMessage({ sceneId: 's1', text: 'hi' })
    expect(useChatStore.getState().isBusy).toBe(false) // gate return 在 isBusy 置 true 之前
    expect(useChatStore.getState().messagesByScene['s1']).toBeUndefined() // 无 message append
  })

  it('已登录 → appendNotice 正常 append(写 IDB;gate 放行)', () => {
    useAuthStore.setState({ status: 'authenticated' })
    useChatStore.setState({ messagesByScene: {} })
    useChatStore.getState().appendNotice({ sceneId: 's1', origin: 'chat', prompt: 'ok' })
    const msgs = useChatStore.getState().messagesByScene['s1']
    expect(msgs?.length).toBe(1)
    expect(msgs?.[0].text).toBe('ok')
    expect(msgs?.[0].kind).toBe('notice')
  })

  it('status=unknown(初始)→ 视为未认证,appendNotice no-op(server 模式不赌未定态)', () => {
    useAuthStore.setState({ status: 'unknown' })
    useChatStore.setState({ messagesByScene: {} })
    useChatStore.getState().appendNotice({ sceneId: 's1', origin: 'chat', prompt: 'p' })
    expect(useChatStore.getState().messagesByScene['s1']).toBeUndefined()
  })
})
