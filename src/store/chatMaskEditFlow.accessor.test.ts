// src/store/chatMaskEditFlow.accessor.test.ts — A7a 返修 P2-1:accessor 不变量隔离测试。
//
// D-4 依赖倒置:chatMaskEditFlow 不再 value-import useChatStore,改由 chatStore 在装配时
// 经 setChatStoreAccessor 注入实例。不变量两条:
//   ① 未注入时 chatStore() 必抛 accessor-not-initialized(防静默 null 解引用);
//   ② chatStore 模块加载时必须调 setChatStoreAccessor(useChatStore)(注入不变量)。
//
// 现有 chatMaskEditFlow.test.ts:112 静态 import useChatStore → 触发 chatStore.ts:870 注入 →
// 所有用例只走 initialized path,删 throw / 改静默 fallback 都不会红。本文件用
// vi.resetModules + 动态 import 拿 fresh 模块,断 cascade(mock canvasStore)使 chatStore
// 不被自动拉起,从而能测到「未注入」负路径;再单独动态 import chatStore 测正向注入。
//
// 正确性门(不提交破坏):删 throw / 漏 :870 注入 / 改静默 fallback 三种破坏,本文件必须红。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// FIX-A:chatStore persist 在 node env 需 localStorage(Test B 动态 import 真 chatStore)。
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
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage }
  if (g.localStorage === undefined) g.localStorage = memStorage
})

// mock 集(同 chatMaskEditFlow.test.ts):mock canvasStore 断 chatMaskEditFlow→canvasStore→…→chatStore
// cascade,使 fresh 动态 import chatMaskEditFlow 时 chatStore 不被拉起 → accessor 保持 null。
vi.mock('../lib/demoImages', () => ({ createDemoImage: () => 'data:image/png;base64,mock' }))
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_b: Blob, name: string, type: string) => ({ assetUrl: 'mock', name, type, sizeBytes: 1, title: name, hasTransparency: false, size: '1x1', dimensions: undefined, sourceDimensions: { width: 1, height: 1 } })),
  saveImportedAsset: vi.fn(),
  readImportedAssetFile: vi.fn(),
}))
vi.mock('../lib/mivoImageClient', () => ({
  enhanceMivoPrompt: vi.fn(),
  MivoImageRequestError: class MivoImageRequestError extends Error { kind = ''; constructor(m: string, k: string) { super(m); this.name = 'MivoImageRequestError'; this.kind = k } },
}))
vi.mock('./remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))
vi.mock('./generationFacade', () => ({ generationFacade: { prepareChatSlot: vi.fn(), generateIntoAiSlot: vi.fn(), generateBesideNode: vi.fn(), getSceneChangeInfo: vi.fn() } }))
vi.mock('../canvas/maskEditGeneration', () => ({ runMaskEditGeneration: vi.fn(), removeMaskEditPlaceholder: vi.fn(), prepareMaskEditPlaceholder: vi.fn(() => ({ slotId: 's', baselineSnapshot: undefined })) }))
vi.mock('./canvasStore', () => ({ useCanvasStore: { getState: () => ({ sceneId: 'scene-1', canvases: { 'scene-1': { title: 'S1' } } }) } }))
vi.mock('../lib/mivoTaskClient', () => ({ cancelTask: vi.fn(() => Promise.resolve()), submitEditTask: vi.fn(), pollTask: vi.fn(), taskPollIntervalMs: () => 10000, kindForFailedTask: () => 'upstream-error' }))

const beginArgs = {
  sceneId: 'scene-1',
  source: { id: 'n1', type: 'image', title: 'src' },
  prompt: 'p',
  slotId: 'slot-1',
  imgRatio: '1:1',
} as never

describe('chatMaskEditFlow accessor 不变量(D-4 / A7a 返修 P2-1)', () => {
  beforeEach(() => { vi.resetModules() })

  it('① 未注入 accessor → beginMaskEditMessage 抛 accessor-not-initialized(非静默 null)', async () => {
    // 动态 import chatMaskEditFlow,不先 import chatStore → cascade 被 canvasStore mock 断 →
    // chatStore 不加载 → setChatStoreAccessor 不被调 → accessor 仍 null。
    const flow = await import('./chatMaskEditFlow')
    expect(() => flow.beginMaskEditMessage(beginArgs)).toThrow('chatStore accessor not initialized')
  })

  it('② 注入 fake store 后 beginMaskEditMessage 不抛 accessor 错误(恢复)', async () => {
    const flow = await import('./chatMaskEditFlow')
    flow.setChatStoreAccessor({ getState: () => ({ messagesByScene: {} }), setState: () => {} } as never)
    expect(() => flow.beginMaskEditMessage(beginArgs)).not.toThrow()
  })

  it('③ 动态 import chatStore 触发 :870 注入 → beginMaskEditMessage 不抛(注入不变量)', async () => {
    // 动态 import 真 chatStore:chatStore 加载 → 装配时调 setChatStoreAccessor(useChatStore)
    // (chatStore.ts 末尾)。若该注入被删 → accessor 仍 null → beginMaskEditMessage 抛 → 红。
    await import('./chatStore')
    const flow = await import('./chatMaskEditFlow')
    expect(() => flow.beginMaskEditMessage(beginArgs)).not.toThrow()
  })
})
