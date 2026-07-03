import { Hono } from 'hono'
import fs from 'node:fs/promises'
import { decodeAssetPath, localAssetRoots, readLocalAssets, resolveAssetFile } from '../lib/assets'
import { sendImageBuffer } from '../lib/image'
import { jsonResponse, plainTextNoContentType } from '../lib/response'
import type { App, AppEnv } from '../lib/types'

// Migrated from vite.config.ts L1433-L1443 (list) and L1588-L1609 (file).
// See server/contracts/local-assets.json for the dev-middleware baseline.
// Intentional changes / preserved quirks vs dev middleware:
//   - D2 (intentional change): serving guard upgraded from lexical path.resolve
//     to fs.realpath (symlink-safe). 403 response shape preserved exactly.
//   - D3 (known-quirk, preserved): 403 / 404 / 500 are plain text with NO
//     Content-Type header.
//   - D6 (known-quirk, preserved): no method guard — app.all returns the same
//     200 response for POST/PUT/DELETE as for GET.
export const createLocalAssetsRoutes = ({ enabled }: { enabled: boolean }): App => {
  const app: App = new Hono<AppEnv>()

  app.all('/local-assets', async (c) => {
    if (!enabled) return c.notFound()
    try {
      const payload = await readLocalAssets()
      return jsonResponse(payload)
    } catch (error) {
      return plainTextNoContentType(c, error instanceof Error ? error.message : 'Unable to read local assets', 500)
    }
  })

  app.all('/local-assets/:id', async (c) => {
    if (!enabled) return c.notFound()
    const id = decodeURIComponent(c.req.param('id') || '')
    const filePath = decodeAssetPath(id)
    const resolution = await resolveAssetFile(filePath, localAssetRoots())

    if (resolution.kind === 'missing') {
      return plainTextNoContentType(c, 'Local asset not found', 404)
    }
    if (resolution.kind === 'outside') {
      return plainTextNoContentType(c, 'Asset path is outside allowed roots', 403)
    }
    try {
      const file = await fs.readFile(resolution.realFile)
      return sendImageBuffer(c, file, resolution.realFile)
    } catch {
      return plainTextNoContentType(c, 'Local asset not found', 404)
    }
  })

  return app
}
