import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createPinterestRoutes } from './pinterest'
import type { AppEnv } from '../lib/types'

const buildApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()
  app.route('/api/mivo', createPinterestRoutes())
  return app
}

describe('pinterest routes — placeholder', () => {
  const app = buildApp()

  it('GET 200 {connected:false, mode:"prototype"}', async () => {
    const res = await app.request('/api/mivo/pinterest/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = (await res.json()) as { connected: boolean; mode: string }
    expect(body).toEqual({ connected: false, mode: 'prototype' })
  })

  it('POST 200 same as GET (D6 no method guard)', async () => {
    const res = await app.request('/api/mivo/pinterest/status', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connected: boolean; mode: string }
    expect(body).toEqual({ connected: false, mode: 'prototype' })
  })

  it('PUT 200 same as GET (D6 no method guard)', async () => {
    const res = await app.request('/api/mivo/pinterest/status', { method: 'PUT' })
    expect(res.status).toBe(200)
  })
})
