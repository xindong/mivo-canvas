// server/routes/sso-error-parity.test.ts
// G2.1 R2-3(F5 第二轮返修):ssoAuthErrorHandler 与 Hono 默认 onError 的 parity 锁定。
//
// 返修前现实现(非 SsoAuthError 分支)用 `instanceof HTTPException` + 直接 `return err.getResponse()`,
// 两个洞:① instanceof 漏掉 structural HTTPResponseError(有 getResponse 但非 HTTPException 子类);
// ② 直接 `err.getResponse()` 不走 `c.newResponse(res.body, res)` → 丢 pre-error `c.header()` 上下文。
// Hono 默认 onError:`"getResponse" in err` duck-type + `c.newResponse(res.body, res)`(保 pre-error header)+ console.error/500。
//
// 修法(Option A 精确复刻,finding 允许:"坚持 A 则按结构化 duck-type + c.newResponse 精确复刻"):
// 非 SsoAuthError 分支改 `"getResponse" in err` duck-type + `c.newResponse(res.body, res)`;
// SsoAuthError 仍 c.json 401 JSON 契约(走 c.newResponse,亦保 pre-error header)。
//
// 参数化 parity:普通 Error / HTTPException / structural HTTPResponseError × 默认 vs custom handler,
// 含 pre-error header 保留;Hono 升级漂移或本 handler 误改时报警。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ssoAuthErrorHandler, SsoAuthError } from '../lib/owner'
import { ArchivedCanvasWriteError, ArchivedParentWriteError, ConcurrentParentChangeError } from '../persist/backend'
import type { AppEnv } from '../lib/types'

/** structural HTTPResponseError:有 getResponse 但非 HTTPException 子类(测 duck-type 兜底)。 */
class StructuralResponseError extends Error {
  private readonly res: Response
  constructor(res: Response) {
    super('structural-response-error')
    this.name = 'StructuralResponseError'
    this.res = res
  }
  getResponse(): Response {
    return this.res
  }
}

const PRE_HEADER = { name: 'X-Pre-Error', value: 'preserved' }

const buildApp = (useCustom: boolean): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  if (useCustom) app.onError(ssoAuthErrorHandler)
  app.get('/throw/:kind', (c) => {
    c.header(PRE_HEADER.name, PRE_HEADER.value) // pre-error header(测 c.newResponse 保留)
    const kind = c.req.param('kind')
    if (kind === 'sso') throw new SsoAuthError('test-reason')
    if (kind === 'http') throw new HTTPException(503, { message: 'service-down' })
    if (kind === 'structural') {
      throw new StructuralResponseError(
        new Response('blocked-body', { status: 418, headers: { 'x-structural': 'yes' } }),
      )
    }
    // P3 item 7:typed 409(CR-6 archived / SG-1 parent-archived / CAS concurrent-parent-change)走 structural 分支
    if (kind === 'archived-canvas') throw new ArchivedCanvasWriteError('c1')
    if (kind === 'archived-parent') throw new ArchivedParentWriteError('p1')
    if (kind === 'concurrent-parent') throw new ConcurrentParentChangeError('c1')
    throw new Error('boom')
  })
  return app
}

afterEach(() => vi.restoreAllMocks())

describe('G2.1 R2-3 — ssoAuthErrorHandler parity(普通 Error / HTTPException / structural × 默认 vs custom + pre-error header)', () => {
  it('普通 Error:custom = default(500 "Internal Server Error" + console.error,不吞)', async () => {
    const errSpyDef = vi.spyOn(console, 'error').mockImplementation(() => {})
    const def = buildApp(false)
    const rDef = await def.request('/throw/plain')
    errSpyDef.mockRestore()

    const errSpyCust = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cust = buildApp(true)
    const rCust = await cust.request('/throw/plain')

    expect(rCust.status).toBe(500)
    expect(rDef.status).toBe(500)
    expect(await rCust.text()).toBe('Internal Server Error')
    expect(await rDef.text()).toBe('Internal Server Error')
    // F5 复现的 consoleErrors 1→0 修复锁定:custom 也 console.error(不吞普通错误)
    expect(errSpyCust).toHaveBeenCalled()
  })

  it('HTTPException:custom = default(503 + message body + pre-error header 保留)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const def = buildApp(false)
    const cust = buildApp(true)
    const rDef = await def.request('/throw/http')
    const rCust = await cust.request('/throw/http')
    expect(rCust.status).toBe(503)
    expect(rDef.status).toBe(503)
    expect(await rCust.text()).toBe('service-down')
    expect(await rDef.text()).toBe('service-down')
    // pre-error header 保留(c.newResponse(res.body, res),非直接 err.getResponse())
    expect(rCust.headers.get(PRE_HEADER.name.toLowerCase())).toBe(PRE_HEADER.value)
    expect(rDef.headers.get(PRE_HEADER.name.toLowerCase())).toBe(PRE_HEADER.value)
  })

  it('structural HTTPResponseError:custom = default(418 + body + pre-error header;duck-type 兜底)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const def = buildApp(false)
    const cust = buildApp(true)
    const rDef = await def.request('/throw/structural')
    const rCust = await cust.request('/throw/structural')
    expect(rCust.status).toBe(418)
    expect(rDef.status).toBe(418)
    expect(await rCust.text()).toBe('blocked-body')
    expect(await rDef.text()).toBe('blocked-body')
    expect(rCust.headers.get('x-structural')).toBe('yes')
    // pre-error header 保留
    expect(rCust.headers.get(PRE_HEADER.name.toLowerCase())).toBe(PRE_HEADER.value)
    expect(rDef.headers.get(PRE_HEADER.name.toLowerCase())).toBe(PRE_HEADER.value)
  })

  it('SsoAuthError:custom → 401 JSON {error,message}(intentional mapping,非 default 500)+ pre-error header 保留', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cust = buildApp(true)
    const r = await cust.request('/throw/sso')
    expect(r.status).toBe(401)
    const body = await r.json()
    expect(body).toEqual({ error: 'unauthorized', message: 'test-reason' })
    // c.json 走 c.newResponse → pre-error header 保留
    expect(r.headers.get(PRE_HEADER.name.toLowerCase())).toBe(PRE_HEADER.value)
  })

  // P3 item 7:typed 409(CR-6 archived / SG-1 parent-archived / CAS concurrent-parent-change)走顶层 onError
  //   structural 分支 → 补一条结构化 telemetry(console.warn JSON: event/error/id/path),不改错误语义(409 响应仍走 getResponse)。
  it.each([
    { kind: 'archived-canvas', wantStatus: 409, wantId: 'c1', wantName: 'ArchivedCanvasWriteError' },
    { kind: 'archived-parent', wantStatus: 409, wantId: 'p1', wantName: 'ArchivedParentWriteError' },
    { kind: 'concurrent-parent', wantStatus: 409, wantId: 'c1', wantName: 'ConcurrentParentChangeError' },
  ])('typed-409 ($kind) → 409 响应不变 + console.warn telemetry(item 7,不改语义)', async ({ kind, wantStatus, wantId, wantName }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cust = buildApp(true)
    const r = await cust.request(`/throw/${kind}`)
    // 语义不变:409 + getResponse body
    expect(r.status).toBe(wantStatus)
    const body = (await r.json()) as { error?: string; id?: string }
    expect(body.id).toBe(wantId)
    // telemetry:一条结构化 JSON,含 event/error/id/path(不改错误语义,仅观测)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(payload.event).toBe('typed-409')
    expect(payload.error).toBe(wantName)
    expect(payload.id).toBe(wantId)
    expect(payload.path).toBe('/throw/' + kind)
  })
})
