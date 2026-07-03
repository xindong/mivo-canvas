import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createLocalAssetsRoutes } from './local-assets'
import { encodeAssetPath } from '../lib/assets'
import type { AppEnv } from '../lib/types'

// Builds a minimal app mounting only the local-assets sub-app, mirroring how
// server/index.ts mounts it under /api/mivo.
const buildApp = (enabled: boolean): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api/mivo', createLocalAssetsRoutes({ enabled }))
  return app
}

describe('local-assets routes', () => {
  let root: string
  let outside: string
  let app: Hono<AppEnv>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mivo-la-root-'))
    outside = await mkdtemp(join(tmpdir(), 'mivo-la-outside-'))
    await writeFile(join(root, 'test.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')
    await writeFile(join(outside, 'secret.txt'), 'TOPSECRET', 'utf8')
    // D2 test fixture: a symlink inside the root pointing to a file outside.
    await symlink(join(outside, 'secret.txt'), join(root, 'link.svg'))
    process.env.MIVO_ASSET_DIR = root
    app = buildApp(true)
  })

  afterAll(async () => {
    delete process.env.MIVO_ASSET_DIR
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('list 200 — assets array', async () => {
    const res = await app.request('/api/mivo/local-assets')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = (await res.json()) as { root: string; assets: unknown[] }
    expect(Array.isArray(body.assets)).toBe(true)
    expect(body.assets.length).toBeGreaterThan(0)
  })

  it('file 200 — image/svg+xml + no-store', async () => {
    const id = encodeAssetPath(join(root, 'test.svg'))
    const res = await app.request(`/api/mivo/local-assets/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('traversal /etc/passwd → 403, no Content-Type (D3 preserved)', async () => {
    const id = encodeAssetPath('/etc/passwd')
    const res = await app.request(`/api/mivo/local-assets/${id}`)
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBeNull()
    expect(await res.text()).toBe('Asset path is outside allowed roots')
  })

  it('traversal ../outside → 403 (lexical pre-check)', async () => {
    const id = encodeAssetPath(join(root, '..', 'secret.txt'))
    const res = await app.request(`/api/mivo/local-assets/${id}`)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Asset path is outside allowed roots')
  })

  it('symlink escape → 403 (D2 realpath guard)', async () => {
    const id = encodeAssetPath(join(root, 'link.svg'))
    const res = await app.request(`/api/mivo/local-assets/${id}`)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Asset path is outside allowed roots')
  })

  it('file not found (inside root) → 404, no Content-Type', async () => {
    const id = encodeAssetPath(join(root, 'nonexistent.png'))
    const res = await app.request(`/api/mivo/local-assets/${id}`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBeNull()
    expect(await res.text()).toBe('Local asset not found')
  })

  it('POST list → 200 same as GET (D6 no method guard)', async () => {
    const res = await app.request('/api/mivo/local-assets', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assets: unknown[] }
    expect(Array.isArray(body.assets)).toBe(true)
  })

  it('disabled → 404 (SC1.4)', async () => {
    const disabled = buildApp(false)
    const res = await disabled.request('/api/mivo/local-assets')
    expect(res.status).toBe(404)
  })

  it('disabled file → 404 (SC1.4)', async () => {
    const disabled = buildApp(false)
    const id = encodeAssetPath(join(root, 'test.svg'))
    const res = await disabled.request(`/api/mivo/local-assets/${id}`)
    expect(res.status).toBe(404)
  })
})
