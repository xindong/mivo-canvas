// src/lib/authClient.test.ts
// SSO 网关方案:fetchMe 对齐网关 /api/auth/me 契约(200 已登录 / 401 未登录)。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchMe } from './authClient'

const mockFetch = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response)

afterEach(() => vi.restoreAllMocks())

describe('fetchMe (SSO gateway contract)', () => {
  it('200 authenticated + username/display_name → user(id=username, name=display_name, avatar=null)', async () => {
    mockFetch(200, {
      authenticated: true,
      username: 'zhuzan@xd.com',
      display_name: '朱赞',
      is_admin: false,
      services: ['mivo_canvas'],
    })
    const me = await fetchMe()
    expect(me).toEqual({
      authenticated: true,
      user: { id: 'zhuzan@xd.com', name: '朱赞', avatar: null },
    })
  })

  it('200 without display_name → name falls back to username', async () => {
    mockFetch(200, { authenticated: true, username: 'zhuzan@xd.com' })
    const me = await fetchMe()
    expect(me.user?.name).toBe('zhuzan@xd.com')
    expect(me.user?.avatar).toBeNull()
  })

  it('200 with avatar_url → user.avatar = avatar_url (img; future SSO field)', async () => {
    mockFetch(200, {
      authenticated: true,
      username: 'zhuzan@xd.com',
      display_name: '朱赞',
      avatar_url: 'https://example.com/zhu.png',
    })
    const me = await fetchMe()
    expect(me.user?.avatar).toBe('https://example.com/zhu.png')
  })

  it('401 → {authenticated:false, user:null} (not a throw; gateway not-logged-in)', async () => {
    mockFetch(401, { detail: 'Not authenticated' })
    const me = await fetchMe()
    expect(me).toEqual({ authenticated: false, user: null })
  })

  it('200 authenticated=false → {authenticated:false, user:null}', async () => {
    mockFetch(200, { authenticated: false })
    const me = await fetchMe()
    expect(me).toEqual({ authenticated: false, user: null })
  })

  it('200 authenticated=true but no username → {authenticated:false, user:null}', async () => {
    mockFetch(200, { authenticated: true })
    const me = await fetchMe()
    expect(me).toEqual({ authenticated: false, user: null })
  })

  it('500 → throws AuthError (real error, not 401)', async () => {
    mockFetch(500, { error: 'boom' })
    await expect(fetchMe()).rejects.toMatchObject({ name: 'AuthError', status: 500 })
  })
})
