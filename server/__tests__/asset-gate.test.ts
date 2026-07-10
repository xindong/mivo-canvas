import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveFeatureFlags } from '../lib/env'

// P1.4: the content-addressed asset service mounts ONLY when
// MIVO_ENABLE_ASSET_SERVICE=1 (default off). This test pins (a) the env→flag
// resolution and (b) the app-level mount gate: flag off → POST and GET to
// /api/assets return 404 (the route is not mounted, and a GET does NOT fall
// through to the SPA fallback).

describe('resolveFeatureFlags — asset service flag (P1.4)', () => {
  const orig = process.env.MIVO_ENABLE_ASSET_SERVICE
  afterEach(() => {
    if (orig === undefined) delete process.env.MIVO_ENABLE_ASSET_SERVICE
    else process.env.MIVO_ENABLE_ASSET_SERVICE = orig
  })

  it('default (unset) → assetServiceEnabled=false', () => {
    delete process.env.MIVO_ENABLE_ASSET_SERVICE
    expect(resolveFeatureFlags().assetServiceEnabled).toBe(false)
  })

  it('MIVO_ENABLE_ASSET_SERVICE=0 → false (explicit off)', () => {
    process.env.MIVO_ENABLE_ASSET_SERVICE = '0'
    expect(resolveFeatureFlags().assetServiceEnabled).toBe(false)
  })

  it('MIVO_ENABLE_ASSET_SERVICE=1 → true (explicit on)', () => {
    process.env.MIVO_ENABLE_ASSET_SERVICE = '1'
    expect(resolveFeatureFlags().assetServiceEnabled).toBe(true)
  })
})

describe('app mount gate — flag off → /api/assets 404 (P1.4)', () => {
  const orig = process.env.MIVO_ENABLE_ASSET_SERVICE
  afterEach(() => {
    vi.resetModules()
    if (orig === undefined) delete process.env.MIVO_ENABLE_ASSET_SERVICE
    else process.env.MIVO_ENABLE_ASSET_SERVICE = orig
  })

  it('flag off → POST /api/assets 404 (write route not mounted)', async () => {
    delete process.env.MIVO_ENABLE_ASSET_SERVICE
    vi.resetModules()
    const { app } = await import('../app')
    const res = await app.request('/api/assets', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(404)
  })

  it('flag off → GET /api/assets/:id 404 (read route not mounted, no SPA fallback)', async () => {
    delete process.env.MIVO_ENABLE_ASSET_SERVICE
    vi.resetModules()
    const { app } = await import('../app')
    const res = await app.request(`/api/assets/${'0'.repeat(64)}`)
    expect(res.status).toBe(404)
    // The SPA fallback would serve text/html 200; assert we did NOT get that.
    expect(res.headers.get('content-type')?.includes('text/html')).toBeFalsy()
  })
})
