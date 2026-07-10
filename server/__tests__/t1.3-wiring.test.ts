// @vitest-environment node
// server/__tests__/t1.3-wiring.test.ts
// T1.3 main app wiring 烟测:驱动主 app,验 /api/{projects,canvas,user-state} 三路由确实 mount
// (app.ts 注册在 serveStatic + SPA fallback 之前)。若 mount 路径拼错/漏注册,请求会落到 SPA
// fallback 返 404 build_not_found(JSON),而非 200/404-unknown-* JSON。route 级契约不变量由
// routes/*.route.test.ts(最小 app + fresh backend)覆盖;本测只钉 wiring + 重置 singleton。
import { describe, it, expect, beforeEach } from 'vitest'
import { app, sharedPersistBackend } from '../app'

describe('T1.3 main app wiring(/api/{projects,canvas,user-state} mounted)', () => {
  beforeEach(() => sharedPersistBackend.__reset())

  it('GET /api/projects → 200 {projects:[]}(JSON,非 SPA fallback)', async () => {
    const res = await app.request('/api/projects', { headers: { 'x-mivo-api-key': 'mivo_wiring_a' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ projects: [] })
  })

  it('GET /api/canvas/:id → 404 unknown-canvas(JSON,非 SPA)', async () => {
    const res = await app.request('/api/canvas/missing', { headers: { 'x-mivo-api-key': 'mivo_wiring_a' } })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect((body as { error: string }).error).toBe('unknown-canvas')
  })

  it('GET /api/user-state → 200 {entries:{}}(JSON)', async () => {
    const res = await app.request('/api/user-state', { headers: { 'x-mivo-api-key': 'mivo_wiring_a' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: {} })
  })

  it('malformed key → 400(主 app 边界 rejectInvalidMivoApiKey 生效)', async () => {
    const res = await app.request('/api/projects', { headers: { 'x-mivo-api-key': 'bad' } })
    expect(res.status).toBe(400)
  })
})
