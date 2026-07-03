import { Hono } from 'hono'
import { jsonResponse } from '../lib/response'
import type { App, AppEnv } from '../lib/types'

// Migrated from vite.config.ts L1577-L1586. Hardcoded placeholder — no upstream,
// no env, no auth. Always returns { connected: false, mode: 'prototype' }.
// D6 (known-quirk, preserved): no method guard — app.all returns the same 200
// response for any method. Pinterest is a public placeholder with no host-file
// access, so it is NOT gated by MIVO_ENABLE_* (always on).
export const createPinterestRoutes = (): App => {
  const app: App = new Hono<AppEnv>()
  app.all('/pinterest/status', () => jsonResponse({ connected: false, mode: 'prototype' }))
  return app
}
