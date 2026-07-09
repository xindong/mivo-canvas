// src/store/authSlice.characterization.test.ts
//
// T0.4② 表征测试（arch-migration-execution-plan.md v3，三票评审通过）
// ----------------------------------------------------------------------------
// 目的：SSO 网关身份链路（authSlice + authClient）迁移到新架构前，钉死当前
// 可观测行为。表征测试 = 录现状，不改行为；疑似 bug 钉现状并单列进 PR
// "现状疑点" 段，不在本次修改。迁移后这些断言必须保持等价 —— 行为漂移
// 即迁移 bug。
//
// 测法约束（项目 vitest 默认 node 环境，无 jsdom/happy-dom）：
//   - window / fetch 用 vi.stubGlobal 注入 mock，与 rendererMode.test.ts 同款。
//   - debugLogger 用 vi.mock 替换为 vi.fn() spy —— 既隔离 remoteDebugReporter
//     副作用（warn/error 会触发 window.setTimeout + 潜在 fetch），又能断言
//     日志契约（source / 消息前缀）。
//   - 跳转类行为只断言 window.location.href 被赋成预期 URL（意图），不真跳。
//   - useAuthStore 是单例，用 setState 在 beforeEach 复位到初始态。
//
// ── 断言数 baseline ──────────────────────────────────────────────────────────
//  expect() 调用总数：51
//  分块：fetchMe 7 场景(13) · hydrate 6 场景(24) · login 1 场景(2)
//        · logout 1 场景(6) · markUnauthenticated 2 场景(4) · 门控初始态(2)
//  迁移后重跑本文件，断言总数与分块不应回退；新增可加，不可静默删减。
// ────────────────────────────────────────────────────────────────────────────
// 现状疑点（仅记录，不修改）：
//   A. fetchMe：网关 200 + authenticated=true 但缺 username → 静默退化为未登录，
//      无任何日志/告警。迁移若引入 username 兜底须保持等价或显式改契约。
//   B. fetchMe 与 hydrate 对错误行为不同（不可写"同样关态"）：
//      fetchMe 自身对 fetch reject / res.json() reject 原样 reject（不吞不
//      转成 AuthError），仅 401 返回未登录、non-2xx 非 401 抛 AuthError；
//      hydrate 才 catch fetch/json/500 reject 后置 status=unauthenticated +
//      warn。用户侧无法区分 "session 过期" 与 "网络断开"，均为登出体验。
//   C. login 的 redirect 基 = window.location.href（含 query/hash，回当前页）；
//      logout 的 redirect 基 = window.location.origin + '/'（回站点根）。非对称，
//      迁移须保持该差异或显式统一。
//   D. markUnauthenticated 的幂等守卫与 mivoTaskClient.onProtectedApi401 的
//      外层守卫形成双重防护（两层都查 status==='unauthenticated'），冗余但无害。
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMe, AuthError } from '../lib/authClient'
import { useAuthStore } from './authSlice'

// vi.mock 工厂在 import 之前执行，spy 必须经 vi.hoisted 创建才能在工厂里引用。
const { logSpy, warnSpy, errorSpy } = vi.hoisted(() => ({
  logSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}))

vi.mock('./debugLogStore', () => ({
  // authSlice 只依赖 debugLogger；其余导出给同图其他潜在引用占位，避免 undefined。
  debugLogger: { log: logSpy, warn: warnSpy, error: errorSpy },
  useDebugLogStore: {
    getState: () => ({ entries: [], addEntry: vi.fn(), clear: vi.fn() }),
  },
  installConsoleCapture: () => {},
}))

// node 环境无真 Response，用最小形状覆盖 fetchMe 读取的字段（status / ok / json）。
const meResponse = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
})

// window.location mock：href 可读可写（login 读当前页 + 写跳转 URL；logout 读 origin）。
const freshWindow = (href = 'http://localhost:5173/app', origin = 'http://localhost:5173') => ({
  location: { href, origin, pathname: '/app', search: '' },
})

describe('authClient.fetchMe — /api/auth/me 响应映射（可测缝隙）', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('200 + authenticated + username + display_name + avatar_url → 完整用户', async () => {
    fetchMock.mockResolvedValueOnce(
      meResponse(200, {
        authenticated: true,
        username: 'zhuzan@xd.com',
        display_name: '朱赞',
        avatar_url: 'https://cdn/avatar.png',
      }),
    )
    const me = await fetchMe()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me') // 钉端点契约
    expect(me).toEqual({
      authenticated: true,
      user: { id: 'zhuzan@xd.com', name: '朱赞', avatar: 'https://cdn/avatar.png' },
    })
  })

  it('200 + authenticated + username 无 display_name/avatar → name 退回 username，avatar=null', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(200, { authenticated: true, username: 'op@xd.com' }))
    const me = await fetchMe()
    expect(me.authenticated).toBe(true)
    expect(me.user).toEqual({ id: 'op@xd.com', name: 'op@xd.com', avatar: null })
  })

  it('200 + authenticated:false → 未登录（不抛）', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(200, { authenticated: false }))
    const me = await fetchMe()
    expect(me).toEqual({ authenticated: false, user: null })
  })

  it('200 + authenticated:true 但缺 username → 静默退化为未登录（疑点 A）', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(200, { authenticated: true }))
    const me = await fetchMe()
    expect(me).toEqual({ authenticated: false, user: null })
  })

  it('401 → 未登录，不抛（网关未登录 / dev 桩 fallback 契约）', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(401, { detail: 'Not authenticated' }))
    const me = await fetchMe()
    expect(me).toEqual({ authenticated: false, user: null })
  })

  it('non-2xx 非 401（500）→ 抛 AuthError(me_failed_<status>)，带 .status / .name', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(500, {}))
    let caught: unknown
    try {
      await fetchMe()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AuthError)
    expect((caught as AuthError).message).toBe('me_failed_500')
    expect((caught as AuthError).status).toBe(500)
    expect((caught as AuthError).name).toBe('AuthError')
  })

  it('200 OK 但 body 非 JSON / res.json() reject → fetchMe 原样 reject，不吞不转成 AuthError（疑点 B）', async () => {
    // fetchMe 在 res.ok 后直接 await res.json()，无 catch —— json() reject 会原样冒泡。
    const jsonErr = new SyntaxError('Unexpected token < in JSON at position 0')
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => {
        throw jsonErr
      },
    })
    let caught: unknown
    try {
      await fetchMe()
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(jsonErr) // 原样 reject —— 同一引用，未被吞/转义
    expect(caught).not.toBeInstanceOf(AuthError) // 不被转成 AuthError
  })
})

describe('useAuthStore.hydrate — /me 各响应下的状态迁移', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    useAuthStore.setState({ user: null, status: 'unknown' })
    logSpy.mockClear()
    warnSpy.mockClear()
    errorSpy.mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('200 authenticated+user → status=authenticated + 会话已恢复日志，不告警', async () => {
    fetchMock.mockResolvedValueOnce(
      meResponse(200, { authenticated: true, username: 'zhuzan@xd.com', display_name: '朱赞' }),
    )
    await useAuthStore.getState().hydrate()
    const s = useAuthStore.getState()
    expect(s.status).toBe('authenticated')
    expect(s.user).toEqual({ id: 'zhuzan@xd.com', name: '朱赞', avatar: null })
    expect(logSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('会话已恢复'))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('401 → status=unauthenticated + 未登录 info 日志（预期态不告警）', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(401, { detail: 'Not authenticated' }))
    await useAuthStore.getState().hydrate()
    const s = useAuthStore.getState()
    expect(s.status).toBe('unauthenticated')
    expect(s.user).toBeNull()
    expect(logSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('未登录'))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('200 authenticated=false → status=unauthenticated + 未登录 info 日志', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(200, { authenticated: false }))
    await useAuthStore.getState().hydrate()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(logSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('未登录'))
  })

  it('500（非 401 真错误）→ status=unauthenticated + 会话恢复失败 warn，含 me_failed_500（疑点 B）', async () => {
    fetchMock.mockResolvedValueOnce(meResponse(500, {}))
    await useAuthStore.getState().hydrate()
    const s = useAuthStore.getState()
    expect(s.status).toBe('unauthenticated')
    expect(s.user).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'Auth',
      expect.stringContaining('会话恢复失败'),
    )
    // 同一次 warn 调用消息里携带错误码（一条消息两段断言，钉 msg 拼接契约）
    expect(warnSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('me_failed_500'))
  })

  it('fetch 抛网络错 → status=unauthenticated + warn，含 err.message（疑点 B）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await useAuthStore.getState().hydrate()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('会话恢复失败'))
    expect(warnSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('Failed to fetch'))
  })

  it('200 OK 但 body 非 JSON / res.json() reject → hydrate catch 后关态 + warn 含错误消息（疑点 B）', async () => {
    // fetchMe 对 res.json() reject 原样 reject（见上一 describe），hydrate catch 后关态 + warn。
    const jsonErr = new SyntaxError('Unexpected token < in JSON at position 0')
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => {
        throw jsonErr
      },
    })
    await useAuthStore.getState().hydrate()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('会话恢复失败'))
    expect(warnSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('Unexpected token <'))
  })
})

describe('useAuthStore.login — SSO 网关整页跳转意图', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('跳转 URL = SSO_LOGIN_URL?service=mivo_canvas&redirect=<encoded 当前 href>，并打 info 日志（疑点 C）', async () => {
    const w = freshWindow('http://localhost:5173/app?q=1')
    vi.stubGlobal('window', w)
    logSpy.mockClear()
    await useAuthStore.getState().login()
    const expectedRedirect = encodeURIComponent('http://localhost:5173/app?q=1')
    expect(w.location.href).toBe(
      `https://auth.dsworks.cn/login?service=mivo_canvas&redirect=${expectedRedirect}`,
    )
    expect(logSpy).toHaveBeenCalledWith('Auth', expect.stringContaining('跳转 SSO 网关登录'))
  })
})

describe('useAuthStore.logout — 乐观清态 + SSO 登出跳转意图', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('先清本地态(user=null,status=unauthenticated)再用 origin+/ 跳网关登出（疑点 C）', async () => {
    // href 用 Object.defineProperty setter：赋值瞬间采样 store，钉"set 清态在 href 跳转之前"的时序。
    // 若迁移把 redirect 赋值提前到 set 之前，setter 触发时 status 仍是 authenticated，本用例会失败。
    let assignedHref = ''
    let setterSnapshot: { user: unknown; status: string } | null = null
    const w = {
      location: {
        href: 'http://localhost:5173/app',
        origin: 'https://mivo.example.cn',
        pathname: '/app',
        search: '',
      },
    }
    Object.defineProperty(w.location, 'href', {
      enumerable: true,
      configurable: true,
      get: () => assignedHref,
      set: (v: string) => {
        // 赋值瞬间采样 store —— 钉 logout 实现"先 set 清态再 href 跳转"的顺序
        setterSnapshot = { ...useAuthStore.getState() }
        assignedHref = v
      },
    })
    vi.stubGlobal('window', w)
    useAuthStore.setState({ user: { id: 'u', name: 'U', avatar: null }, status: 'authenticated' })
    logSpy.mockClear()
    await useAuthStore.getState().logout()
    // 时序断言：href setter 触发瞬间，本地态已被清成未登录（钉"先清态后跳转"）
    expect(setterSnapshot).not.toBeNull()
    expect(setterSnapshot!.user).toBeNull()
    expect(setterSnapshot!.status).toBe('unauthenticated')
    // 事后断言：跳转完成后本地态仍保持未登录
    expect(useAuthStore.getState().user).toBeNull()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    // logout redirect 基 = origin + '/'（区别于 login 的 href）
    const expectedRedirect = encodeURIComponent('https://mivo.example.cn/')
    expect(w.location.href).toBe(
      `https://auth.dsworks.cn/api/auth/logout?service=mivo_canvas&redirect=${expectedRedirect}`,
    )
  })
})

describe('useAuthStore.markUnauthenticated — 401 受保护 API 关态（幂等，不重复刷）', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, status: 'unknown' })
    logSpy.mockClear()
    warnSpy.mockClear()
  })

  it('从 authenticated 关态 → user 清空 + status=unauthenticated，订阅触发一次', () => {
    useAuthStore.setState({ user: { id: 'u', name: 'U', avatar: null }, status: 'authenticated' })
    const listener = vi.fn()
    const unsub = useAuthStore.subscribe(listener)
    useAuthStore.getState().markUnauthenticated()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1) // 状态真变更 → 订阅触发一次
    unsub()
  })

  it('已 unauthenticated 再调 → 幂等守卫挡住 set，订阅不触发（疑点 D 双重守卫的内层）', () => {
    useAuthStore.setState({ user: null, status: 'unauthenticated' })
    const listener = vi.fn()
    const unsub = useAuthStore.subscribe(listener)
    useAuthStore.getState().markUnauthenticated()
    expect(listener).not.toHaveBeenCalled() // 守卫挡住，无 set → 无订阅通知
    unsub()
  })
})

describe('未登录门控初始态', () => {
  it('模块加载即初始态 {user:null, status:unknown} —— hydrate 前门控未开', () => {
    useAuthStore.setState({ user: null, status: 'unknown' })
    const s = useAuthStore.getState()
    expect(s.status).toBe('unknown')
    expect(s.user).toBeNull()
  })
})
