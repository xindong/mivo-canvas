import { Hono } from 'hono'
import fs from 'node:fs/promises'
import {
  eagleApi,
  eagleOriginalPathFor,
  eagleThumbnailFallbackSvg,
  eagleThumbnailPathFor,
  readEagleItem,
  type EagleItem,
  type EagleTag,
} from '../lib/eagle'
import { imageExtensions } from '../lib/assets'
import { sendImageBuffer } from '../lib/image'
import { jsonResponse, plainTextNoContentType } from '../lib/response'
import type { App, AppEnv } from '../lib/types'

// Migrated from vite.config.ts L1445-L1575 (six sub-routes).
// See server/contracts/eagle.json for the dev-middleware baseline.
// Intentional changes / preserved quirks vs dev middleware:
//   - D5 (intentional change): upstream fetch now has a default 10s timeout
//     (MIVO_EAGLE_TIMEOUT_MS overrides). Timeout surfaces as the same offline
//     shape (502 / connected:false) as a connection failure.
//   - D4 (known-quirk, preserved): error shapes are inconsistent across
//     sub-routes — status=JSON, folders/tags/assets=502 plain text,
//     file=404 plain text, most without Content-Type. Not normalized here.
//   - D6 (known-quirk, preserved): no method guard — app.all returns the same
//     response for any method.
//   - SSRF boundary (preserved): host fixed to MIVO_EAGLE_API_URL; all routes
//     are hardcoded strings. Bounded by construction.
//
// Routes are registered under /api/mivo via app.route('/api/mivo', ...) in
// server/index.ts. The url/thumbnailUrl fields in the assets-list response are
// absolute (client-facing) and intentionally NOT rewritten to relative.
export const createEagleRoutes = ({ enabled }: { enabled: boolean }): App => {
  const app: App = new Hono<AppEnv>()

  app.all('/eagle/status', async (c) => {
    if (!enabled) return c.notFound()
    try {
      const [applicationInfo, libraryInfo] = await Promise.all([
        eagleApi<{ version?: string; platform?: string }>('/api/application/info'),
        eagleApi<{ folders?: unknown[]; libPath?: string; libraryPath?: string }>('/api/library/info'),
      ])
      return jsonResponse({
        connected: true,
        version: applicationInfo.version,
        platform: applicationInfo.platform,
        folderCount: libraryInfo.folders?.length || 0,
        libraryPath: libraryInfo.libPath || libraryInfo.libraryPath,
      })
    } catch (error) {
      return jsonResponse({
        connected: false,
        message: error instanceof Error ? error.message : 'Eagle is not reachable',
      })
    }
  })

  app.all('/eagle/folders', async (c) => {
    if (!enabled) return c.notFound()
    try {
      const folders = await eagleApi<unknown[]>('/api/folder/list')
      return jsonResponse({ folders })
    } catch (error) {
      return plainTextNoContentType(c, error instanceof Error ? error.message : 'Unable to read Eagle folders', 502)
    }
  })

  app.all('/eagle/tags', async (c) => {
    if (!enabled) return c.notFound()
    try {
      const tags = await eagleApi<EagleTag[]>('/api/tag/list')
      const normalizedTags = tags.flatMap((tag) => {
        const name = typeof tag === 'string' ? tag : tag.name || tag.tag || tag.id || ''
        if (!name.trim()) return []
        return {
          id: typeof tag === 'string' ? name : tag.id || name,
          name,
          ...(typeof tag === 'string' || tag.count === undefined ? {} : { count: tag.count }),
        }
      })
      return jsonResponse({ tags: normalizedTags })
    } catch (error) {
      return plainTextNoContentType(c, error instanceof Error ? error.message : 'Unable to read Eagle tags', 502)
    }
  })

  // Specific :id/thumbnail and :id/file routes are registered before the bare
  // /eagle/assets list route so Hono's router matches the longer paths first.
  app.all('/eagle/assets/:id/thumbnail', async (c) => {
    if (!enabled) return c.notFound()
    const itemId = decodeURIComponent(c.req.param('id') || '')
    try {
      const thumbnailPath = await eagleThumbnailPathFor(itemId)
      return sendImageBuffer(c, await fs.readFile(thumbnailPath), thumbnailPath)
    } catch {
      // Fallback: try the original file, else static SVG (vite.config.ts L1062-L1073).
      try {
        const item = await readEagleItem(itemId)
        const filePath = await eagleOriginalPathFor(item)
        return sendImageBuffer(c, await fs.readFile(filePath), filePath)
      } catch {
        c.header('Content-Type', 'image/svg+xml')
        c.header('Cache-Control', 'no-store')
        return c.body(eagleThumbnailFallbackSvg)
      }
    }
  })

  app.all('/eagle/assets/:id/file', async (c) => {
    if (!enabled) return c.notFound()
    const itemId = decodeURIComponent(c.req.param('id') || '')
    try {
      const item = await readEagleItem(itemId)
      const filePath = await eagleOriginalPathFor(item)
      return sendImageBuffer(c, await fs.readFile(filePath), filePath)
    } catch {
      return plainTextNoContentType(c, 'Eagle original not found', 404)
    }
  })

  app.all('/eagle/assets', async (c) => {
    if (!enabled) return c.notFound()
    try {
      const limit = c.req.query('limit') || '80'
      const offset = c.req.query('offset') || '0'
      const folderId = c.req.query('folderId') || ''
      const tag = c.req.query('tag') || c.req.query('tags') || ''
      const params = new URLSearchParams({ limit, offset })
      if (folderId) params.set('folderId', folderId)
      if (tag) params.set('tags', tag)

      const items = await eagleApi<EagleItem[]>('/api/item/list', params)
      const assets = items
        .filter((item) => imageExtensions.has(`.${item.ext?.toLowerCase() || ''}`))
        .map((item) => ({
          id: item.id,
          name: `${item.name}.${item.ext || 'image'}`,
          title: item.name,
          format: (item.ext || '').toUpperCase(),
          sizeBytes: item.size || 0,
          width: item.width,
          height: item.height,
          tags: item.tags || [],
          folders: item.folders || [],
          sourceUrl: item.url,
          sourcePath: 'Eagle library',
          updatedAt: item.modificationTime || 0,
          url: `/api/mivo/eagle/assets/${encodeURIComponent(item.id)}/file`,
          thumbnailUrl: `/api/mivo/eagle/assets/${encodeURIComponent(item.id)}/thumbnail`,
        }))
      return jsonResponse({ assets })
    } catch (error) {
      return plainTextNoContentType(c, error instanceof Error ? error.message : 'Unable to read Eagle assets', 502)
    }
  })

  return app
}
