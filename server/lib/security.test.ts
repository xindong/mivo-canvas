import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { resolveFeatureFlags } from './env'
import { createLocalAssetsRoutes } from '../routes/local-assets'
import { createEagleRoutes } from '../routes/eagle'
import type { AppEnv } from './types'

// SC1.4 production safety model: local-assets and eagle/* default ON in local
// mode, OFF in public mode (MIVO_PUBLIC=1). Explicit MIVO_ENABLE_* overrides.
// Tests cover the flag resolver (pure) and the end-to-end 404 behavior.

describe('SC1.4 feature-flag resolver', () => {
  it('local mode (no MIVO_PUBLIC) → both ON', () => {
    const flags = resolveFeatureFlags({})
    expect(flags.isPublic).toBe(false)
    expect(flags.localAssetsEnabled).toBe(true)
    expect(flags.eagleProxyEnabled).toBe(true)
  })

  it('public mode (MIVO_PUBLIC=1) → both OFF', () => {
    const flags = resolveFeatureFlags({ MIVO_PUBLIC: '1' })
    expect(flags.isPublic).toBe(true)
    expect(flags.localAssetsEnabled).toBe(false)
    expect(flags.eagleProxyEnabled).toBe(false)
  })

  it('public + MIVO_ENABLE_LOCAL_ASSETS=1 → local-assets ON, eagle OFF', () => {
    const flags = resolveFeatureFlags({ MIVO_PUBLIC: '1', MIVO_ENABLE_LOCAL_ASSETS: '1' })
    expect(flags.localAssetsEnabled).toBe(true)
    expect(flags.eagleProxyEnabled).toBe(false)
  })

  it('public + MIVO_ENABLE_EAGLE_PROXY=1 → eagle ON, local-assets OFF', () => {
    const flags = resolveFeatureFlags({ MIVO_PUBLIC: '1', MIVO_ENABLE_EAGLE_PROXY: '1' })
    expect(flags.localAssetsEnabled).toBe(false)
    expect(flags.eagleProxyEnabled).toBe(true)
  })

  it('local + MIVO_ENABLE_LOCAL_ASSETS=0 → local-assets OFF (explicit wins over local default)', () => {
    const flags = resolveFeatureFlags({ MIVO_ENABLE_LOCAL_ASSETS: '0' })
    expect(flags.localAssetsEnabled).toBe(false)
    expect(flags.eagleProxyEnabled).toBe(true)
  })

  it('public + both explicit ON → both ON', () => {
    const flags = resolveFeatureFlags({
      MIVO_PUBLIC: '1',
      MIVO_ENABLE_LOCAL_ASSETS: '1',
      MIVO_ENABLE_EAGLE_PROXY: '1',
    })
    expect(flags.localAssetsEnabled).toBe(true)
    expect(flags.eagleProxyEnabled).toBe(true)
  })

  it('garbage values fall through to default (not 1/0 → mode-based)', () => {
    const flags = resolveFeatureFlags({ MIVO_PUBLIC: 'yes', MIVO_ENABLE_LOCAL_ASSETS: 'true' })
    expect(flags.isPublic).toBe(false)
    expect(flags.localAssetsEnabled).toBe(true)
  })
})

describe('SC1.4 endpoint gating (integration)', () => {
  const buildApp = (flags: ReturnType<typeof resolveFeatureFlags>): Hono<AppEnv> => {
    const app = new Hono<AppEnv>()
    app.route('/api/mivo', createLocalAssetsRoutes({ enabled: flags.localAssetsEnabled }))
    app.route('/api/mivo', createEagleRoutes({ enabled: flags.eagleProxyEnabled }))
    return app
  }

  it('public mode → local-assets 404', async () => {
    const app = buildApp(resolveFeatureFlags({ MIVO_PUBLIC: '1' }))
    const res = await app.request('/api/mivo/local-assets')
    expect(res.status).toBe(404)
  })

  it('public mode → eagle 404', async () => {
    const app = buildApp(resolveFeatureFlags({ MIVO_PUBLIC: '1' }))
    const res = await app.request('/api/mivo/eagle/status')
    expect(res.status).toBe(404)
  })

  it('public + explicit enable → local-assets 200', async () => {
    const app = buildApp(resolveFeatureFlags({ MIVO_PUBLIC: '1', MIVO_ENABLE_LOCAL_ASSETS: '1' }))
    // MIVO_ASSET_DIR unset + ~/Desktop/Images likely absent → list 200 with empty assets
    const res = await app.request('/api/mivo/local-assets')
    expect(res.status).toBe(200)
  })

  it('public + explicit enable → eagle status 200 (offline, connected:false)', async () => {
    const saved = process.env.MIVO_EAGLE_API_URL
    process.env.MIVO_EAGLE_API_URL = 'http://127.0.0.1:59999'
    try {
      const app = buildApp(resolveFeatureFlags({ MIVO_PUBLIC: '1', MIVO_ENABLE_EAGLE_PROXY: '1' }))
      const res = await app.request('/api/mivo/eagle/status')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { connected: boolean }
      expect(body.connected).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.MIVO_EAGLE_API_URL
      else process.env.MIVO_EAGLE_API_URL = saved
    }
  })

  it('local mode → local-assets 200', async () => {
    const app = buildApp(resolveFeatureFlags({}))
    const res = await app.request('/api/mivo/local-assets')
    expect(res.status).toBe(200)
  })

  it('local + explicit disable → local-assets 404', async () => {
    const app = buildApp(resolveFeatureFlags({ MIVO_ENABLE_LOCAL_ASSETS: '0' }))
    const res = await app.request('/api/mivo/local-assets')
    expect(res.status).toBe(404)
  })
})
