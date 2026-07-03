import fs from 'node:fs/promises'
import path from 'node:path'

// Migrated from vite.config.ts L9, L159-L190, L1033-L1099. See server/contracts/eagle.json
// for the dev-middleware baseline. D5 (upstream timeout) is the only intentional change.

export const eagleApiBase = (): string => process.env.MIVO_EAGLE_API_URL?.trim() || 'http://127.0.0.1:41595'

// D5 (intentional change): the dev middleware's requestJson / eagle fetches had NO
// upstream timeout (vite.config.ts L186-L190) — a hanging Eagle API hung the request
// indefinitely. The BFF applies a default 10s timeout, overridable via env.
export const eagleTimeoutMs = (): number => {
  const raw = Number(process.env.MIVO_EAGLE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000
}

export type EagleApiResponse<T> = {
  status: 'success' | 'error'
  data?: T
  message?: string
}

export type EagleItem = {
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

export type EagleTag = string | {
  id?: string
  name?: string
  tag?: string
  count?: number
}

// requestJson with D5 timeout. On timeout the abort surfaces as a thrown error
// to the caller, which maps to the same offline shape (502 / connected:false)
// as a connection failure — so the externally observable behavior matches the
// dev-middleware offline baseline, just bounded in time.
export const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), eagleTimeoutMs())
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timeoutId)
  }
}

export const eagleApi = async <T>(route: string, params?: URLSearchParams): Promise<T> => {
  const url = new URL(route, eagleApiBase())
  params?.forEach((value, key) => url.searchParams.set(key, value))
  const payload = await requestJson<EagleApiResponse<T>>(url.toString())
  if (payload.status !== 'success') {
    throw new Error(payload.message || `Eagle API failed: ${route}`)
  }
  return payload.data as T
}

export const eagleThumbnailPathFor = async (itemId: string): Promise<string> => {
  const thumbnailPath = await eagleApi<string>('/api/item/thumbnail', new URLSearchParams({ id: itemId }))
  return decodeURI(thumbnailPath)
}

export const readEagleItem = async (itemId: string): Promise<EagleItem> =>
  eagleApi<EagleItem>('/api/item/info', new URLSearchParams({ id: itemId }))

export const eagleOriginalPathFor = async (item: EagleItem): Promise<string> => {
  const thumbnailPath = await eagleThumbnailPathFor(item.id)
  const itemDirectory = path.dirname(thumbnailPath)
  const expectedFilename = item.ext ? `${item.name}.${item.ext}` : undefined
  const expectedPath = expectedFilename ? path.join(itemDirectory, expectedFilename) : undefined

  if (expectedPath) {
    try {
      await fs.access(expectedPath)
      return expectedPath
    } catch {
      // Fall through to directory scan; Eagle item names can contain normalized punctuation.
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

// Static fallback SVG (vite.config.ts L1050-L1054). Served when an Eagle
// thumbnail read fails AND the original file also can't be resolved.
export const eagleThumbnailFallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" rx="16" fill="#f3f0e8"/>
  <path d="M76 154l52-62 42 48 28-30 46 44H76z" fill="#c9c1b0"/>
  <circle cx="220" cy="82" r="22" fill="#d9d1c2"/>
</svg>`
