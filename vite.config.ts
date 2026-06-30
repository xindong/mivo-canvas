import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const eagleApiBase = process.env.MIVO_EAGLE_API_URL?.trim() || 'http://127.0.0.1:41595'

const mimeFor = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

const mimeForFile = (file: Buffer, filePath: string) => {
  if (file.length >= 12 && file.subarray(0, 4).toString('ascii') === 'RIFF' && file.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }

  if (file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }

  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) {
    return 'image/jpeg'
  }

  if (file.length >= 6 && file.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif'
  }

  const textPrefix = file.subarray(0, 160).toString('utf8').trimStart()
  if (textPrefix.startsWith('<svg') || textPrefix.startsWith('<?xml')) return 'image/svg+xml'

  return mimeFor(filePath)
}

const localAssetRoots = () => {
  const configured = process.env.MIVO_ASSET_DIR?.trim()
  const desktop = path.join(os.homedir(), 'Desktop')
  const candidates = configured
    ? [configured]
    : [
        path.join(desktop, 'Images'),
        path.join(desktop, 'images'),
      ]

  return candidates.map((candidate) => path.resolve(candidate))
}

const encodeAssetPath = (filePath: string) => Buffer.from(filePath).toString('base64url')

const decodeAssetPath = (id: string) => Buffer.from(id, 'base64url').toString('utf8')

const isInsideRoot = (filePath: string, roots: string[]) => {
  const resolved = path.resolve(filePath)
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
}

type EagleApiResponse<T> = {
  status: 'success' | 'error'
  data?: T
  message?: string
}

type EagleItem = {
  id: string
  name: string
  size?: number
  ext?: string
  tags?: string[]
  folders?: string[]
  url?: string
  annotation?: string
  modificationTime?: number
  width?: number
  height?: number
}

const requestJson = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return (await response.json()) as T
}

const eagleApi = async <T>(route: string, params?: URLSearchParams) => {
  const url = new URL(route, eagleApiBase)
  params?.forEach((value, key) => url.searchParams.set(key, value))
  const payload = await requestJson<EagleApiResponse<T>>(url.toString())

  if (payload.status !== 'success') {
    throw new Error(payload.message || `Eagle API failed: ${route}`)
  }

  return payload.data as T
}

const eagleThumbnailPathFor = async (itemId: string) => {
  const thumbnailPath = await eagleApi<string>('/api/item/thumbnail', new URLSearchParams({ id: itemId }))
  return decodeURI(thumbnailPath)
}

const eagleOriginalPathFor = async (item: EagleItem) => {
  const thumbnailPath = await eagleThumbnailPathFor(item.id)
  const itemDirectory = path.dirname(thumbnailPath)
  const expectedFilename = item.ext ? `${item.name}.${item.ext}` : undefined
  const expectedPath = expectedFilename ? path.join(itemDirectory, expectedFilename) : undefined

  if (expectedPath) {
    try {
      await fs.access(expectedPath)
      return expectedPath
    } catch {
      // Fall through to directory scan because Eagle item names can contain normalized punctuation.
    }
  }

  const files = await fs.readdir(itemDirectory)
  const file = files.find((filename) => {
    if (filename === 'metadata.json' || filename.endsWith('_thumbnail.png')) return false
    if (!item.ext) return true
    return path.extname(filename).slice(1).toLowerCase() === item.ext.toLowerCase()
  })

  if (!file) throw new Error(`Unable to resolve Eagle original for ${item.id}`)
  return path.join(itemDirectory, file)
}

const readEagleItem = async (itemId: string) => eagleApi<EagleItem>('/api/item/info', new URLSearchParams({ id: itemId }))

const readLocalAssets = async () => {
  const roots = localAssetRoots()
  const existingRootCandidates = (
    await Promise.all(
      roots.map(async (root) => {
        try {
          const stat = await fs.stat(root)
          if (!stat.isDirectory()) return undefined

          return {
            root,
            realRoot: await fs.realpath(root),
          }
        } catch {
          return undefined
        }
      }),
    )
  ).filter(Boolean) as Array<{ root: string; realRoot: string }>
  const seenRootPaths = new Set<string>()
  const existingRoots = existingRootCandidates
    .filter(({ realRoot }) => {
      const key = realRoot.toLowerCase()
      if (seenRootPaths.has(key)) return false
      seenRootPaths.add(key)
      return true
    })
    .map(({ root }) => root)

  const assetsByPath = new Map<string, {
    id: string
    name: string
    title: string
    format: string
    sizeBytes: number
    sourcePath: string
    updatedAt: number
    url: string
  }>()
  const assets = (
    await Promise.all(
      existingRoots.map(async (root) => {
        const entries = await fs.readdir(root, { withFileTypes: true })

        return Promise.all(
          entries
            .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
            .map(async (entry) => {
              const filePath = path.join(root, entry.name)
              const stat = await fs.stat(filePath)
              const realFilePath = await fs.realpath(filePath)
              const id = encodeAssetPath(filePath)

              return {
                key: realFilePath.toLowerCase(),
                id,
                name: entry.name,
                title: entry.name.replace(/\.[^.]+$/, ''),
                format: path.extname(entry.name).slice(1).toUpperCase(),
                sizeBytes: stat.size,
                sourcePath: filePath.replace(os.homedir(), '~'),
                updatedAt: stat.mtimeMs,
                url: `/api/mivo/local-assets/${id}`,
              }
            }),
        )
      }),
    )
  )
    .flat()
    .reduce((items, asset) => {
      if (!items.has(asset.key)) {
        const { key, ...localAsset } = asset
        items.set(key, localAsset)
      }
      return items
    }, assetsByPath)

  return {
    root: existingRoots[0]?.replace(os.homedir(), '~') || '~/Desktop/images',
    assets: [...assets.values()].sort((left, right) => right.updatedAt - left.updatedAt),
  }
}

const localAssetLibraryPlugin = (): Plugin => ({
  name: 'mivo-local-asset-library',
  configureServer(server: ViteDevServer) {
    server.middlewares.use(async (request, response, next) => {
      const url = request.url || ''

      if (url === '/api/mivo/local-assets') {
        try {
          const payload = await readLocalAssets()
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(payload))
        } catch (error) {
          response.statusCode = 500
          response.end(error instanceof Error ? error.message : 'Unable to read local assets')
        }
        return
      }

      if (url === '/api/mivo/eagle/status') {
        try {
          const [applicationInfo, libraryInfo] = await Promise.all([
            eagleApi<{ version?: string; platform?: string }>('/api/application/info'),
            eagleApi<{ folders?: unknown[]; libPath?: string; libraryPath?: string }>('/api/library/info'),
          ])
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(
            JSON.stringify({
              connected: true,
              version: applicationInfo.version,
              platform: applicationInfo.platform,
              folderCount: libraryInfo.folders?.length || 0,
              libraryPath: libraryInfo.libPath || libraryInfo.libraryPath,
            }),
          )
        } catch (error) {
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(
            JSON.stringify({
              connected: false,
              message: error instanceof Error ? error.message : 'Eagle is not reachable',
            }),
          )
        }
        return
      }

      if (url === '/api/mivo/eagle/folders') {
        try {
          const folders = await eagleApi<unknown[]>('/api/folder/list')
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ folders }))
        } catch (error) {
          response.statusCode = 502
          response.end(error instanceof Error ? error.message : 'Unable to read Eagle folders')
        }
        return
      }

      if (url.startsWith('/api/mivo/eagle/assets/') && url.endsWith('/thumbnail')) {
        try {
          const itemId = decodeURIComponent(
            url.slice('/api/mivo/eagle/assets/'.length, -'/thumbnail'.length).split('?')[0] || '',
          )
          const thumbnailPath = await eagleThumbnailPathFor(itemId)
          const file = await fs.readFile(thumbnailPath)
          response.setHeader('Content-Type', mimeForFile(file, thumbnailPath))
          response.setHeader('Cache-Control', 'no-store')
          response.end(file)
        } catch {
          response.statusCode = 404
          response.end('Eagle thumbnail not found')
        }
        return
      }

      if (url.startsWith('/api/mivo/eagle/assets/') && url.endsWith('/file')) {
        try {
          const itemId = decodeURIComponent(
            url.slice('/api/mivo/eagle/assets/'.length, -'/file'.length).split('?')[0] || '',
          )
          const item = await readEagleItem(itemId)
          const filePath = await eagleOriginalPathFor(item)
          const file = await fs.readFile(filePath)
          response.setHeader('Content-Type', mimeForFile(file, filePath))
          response.setHeader('Cache-Control', 'no-store')
          response.end(file)
        } catch {
          response.statusCode = 404
          response.end('Eagle original not found')
        }
        return
      }

      if (url.startsWith('/api/mivo/eagle/assets')) {
        try {
          const requestUrl = new URL(url, 'http://127.0.0.1')
          const limit = requestUrl.searchParams.get('limit') || '80'
          const offset = requestUrl.searchParams.get('offset') || '0'
          const folderId = requestUrl.searchParams.get('folderId') || ''
          const keyword = requestUrl.searchParams.get('q') || ''
          const params = new URLSearchParams({ limit, offset })

          if (folderId) params.set('folderId', folderId)
          if (keyword) params.set('keyword', keyword)

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

          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ assets }))
        } catch (error) {
          response.statusCode = 502
          response.end(error instanceof Error ? error.message : 'Unable to read Eagle assets')
        }
        return
      }

      if (url === '/api/mivo/pinterest/status') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(
          JSON.stringify({
            connected: false,
            mode: 'prototype',
          }),
        )
        return
      }

      if (url.startsWith('/api/mivo/local-assets/')) {
        try {
          const id = decodeURIComponent(url.slice('/api/mivo/local-assets/'.length).split('?')[0] || '')
          const filePath = decodeAssetPath(id)
          const roots = localAssetRoots()

          if (!isInsideRoot(filePath, roots)) {
            response.statusCode = 403
            response.end('Asset path is outside allowed roots')
            return
          }

          const file = await fs.readFile(filePath)
          response.setHeader('Content-Type', mimeForFile(file, filePath))
          response.setHeader('Cache-Control', 'no-store')
          response.end(file)
        } catch {
          response.statusCode = 404
          response.end('Local asset not found')
        }
        return
      }

      next()
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localAssetLibraryPlugin()],
})
