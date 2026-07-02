import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const eagleApiBase = process.env.MIVO_EAGLE_API_URL?.trim() || 'http://127.0.0.1:41595'
const mivoImageApiBase = 'https://llm-proxy.tapsvc.com/v1/images'
// Enhance endpoint (chat completions)
const mivoLlmApiBase = 'https://llm-proxy.tapsvc.com/v1'
const mivoEnhancePrimaryModel = 'moonshotai/kimi-k2.6'
const mivoEnhanceFallbackModel = 'qwen/qwen3.6-plus'
const mivoEnhancePrimaryTimeoutMs = 10_000
const mivoEnhanceFallbackTimeoutMs = 15_000
// SYNC NOTE: keep in sync with src/lib/modelCapabilities.ts
const mivoModelRatioMap: Record<string, string[]> = {
  'gpt-image-2': ['1:1', '3:2', '2:3', '16:9', '9:16'],
  'gemini-3-pro-image': ['1:1', '3:2', '2:3', '3:4', '4:3', '16:9', '9:16', '21:9', '5:4', '4:5'],
  'doubao-seedance-2-0-260128': ['1:1', '3:4', '4:3', '16:9', '9:16', '21:9'],
  'doubao-seedance-2-0-fast-260128': ['1:1', '3:4', '4:3', '16:9', '9:16', '21:9'],
}
const mivoModelDefaultRatio: Record<string, string> = {
  'gpt-image-2': '1:1',
  'gemini-3-pro-image': '1:1',
  'doubao-seedance-2-0-260128': '16:9',
  'doubao-seedance-2-0-fast-260128': '16:9',
}
const defaultMivoImageModel = 'gpt-image-2'
const mivoQualitySet = new Set(['low', 'medium', 'high'])
const mivoImageRequestMaxBytes = 40 * 1024 * 1024
const mivoJsonRequestMaxBytes = 1024 * 1024
const mivoUpstreamTimeoutMs = 110_000
const mivoEditUpstreamTimeoutMs = 180_000
const mivoImageSizeMap = {
  '1:1': {
    low: '1024x1024',
    medium: '2048x2048',
    high: '2880x2880',
  },
  '3:2': {
    low: '1536x1024',
    medium: '3072x2048',
    high: '3504x2336',
  },
  '2:3': {
    low: '1024x1536',
    medium: '2048x3072',
    high: '2336x3504',
  },
  '16:9': {
    low: '1824x1024',
    medium: '2048x1152',
    high: '3840x2160',
  },
  '9:16': {
    low: '1024x1824',
    medium: '1152x2048',
    high: '2160x3840',
  },
} as const

type MivoImageRatio = keyof typeof mivoImageSizeMap
type MivoImageQuality = keyof (typeof mivoImageSizeMap)['1:1']
type MivoImageResponse = {
  images: Array<{ b64: string }>
}

type ParsedMivoMultipart = {
  fields: Map<string, string[]>
  files: Map<string, File[]>
}

class RequestBodyTooLargeError extends Error {}
class UpstreamRequestTimeoutError extends Error {}

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

const fetchUpstreamWithTimeout = async (url: string, init: RequestInit, timeoutMs = mivoUpstreamTimeoutMs) => {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (isAbortError(error) && timedOut) {
      throw new UpstreamRequestTimeoutError('Image API request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

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

type EagleTag = string | {
  id?: string
  name?: string
  tag?: string
  count?: number
}

const requestJson = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return (await response.json()) as T
}

const readImageApiKey = (imageApiKey: string) => {
  const key = imageApiKey.trim()
  if (!key) throw new Error('MIVO_IMAGE_API_KEY is not set')
  return key
}

const sendMivoJson = (response: ServerResponse, status: number, payload: unknown) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

const readRequestBuffer = async (request: IncomingMessage, maxBytes: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0

    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        reject(new RequestBodyTooLargeError('Request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })

const readJsonRequest = async <T>(request: IncomingMessage) => {
  const buffer = await readRequestBuffer(request, mivoJsonRequestMaxBytes)
  if (!buffer.length) return {} as T
  return JSON.parse(buffer.toString('utf8')) as T
}

const headersFromIncomingRequest = (request: IncomingMessage) => {
  const headers = new Headers()
  Object.entries(request.headers).forEach(([key, value]) => {
    if (Array.isArray(value)) headers.set(key, value.join(', '))
    else if (value !== undefined) headers.set(key, value)
  })
  return headers
}

const parseMultipartRequest = async (request: IncomingMessage): Promise<ParsedMivoMultipart> => {
  const buffer = await readRequestBuffer(request, mivoImageRequestMaxBytes)
  const webRequest = new Request('http://127.0.0.1/api/mivo/edit', {
    method: request.method || 'POST',
    headers: headersFromIncomingRequest(request),
    body: buffer,
  })
  const formData = await webRequest.formData()
  const fields = new Map<string, string[]>()
  const files = new Map<string, File[]>()

  formData.forEach((value, key) => {
    if (value instanceof File) {
      const nextFiles = files.get(key) || []
      nextFiles.push(value)
      files.set(key, nextFiles)
      return
    }

    const nextValues = fields.get(key) || []
    nextValues.push(value)
    fields.set(key, nextValues)
  })

  return { fields, files }
}

const firstMultipartField = (fields: Map<string, string[]>, key: string) => fields.get(key)?.[0] || ''

const multipartFiles = (files: Map<string, File[]>, key: string) => files.get(key) || []

const appendFile = (formData: FormData, key: string, file: File) => {
  formData.append(key, file, file.name || `${key}.png`)
}

const normalizeMivoQuality = (quality: unknown): MivoImageQuality => {
  const value = typeof quality === 'string' && mivoQualitySet.has(quality) ? quality : 'medium'
  return value as MivoImageQuality
}

const normalizeMivoRatio = (imgRatio: unknown): MivoImageRatio => {
  const value = typeof imgRatio === 'string' && imgRatio in mivoImageSizeMap ? imgRatio : '1:1'
  return value as MivoImageRatio
}

const imageSizeFor = (imgRatio: unknown, quality: unknown) => {
  const ratio = normalizeMivoRatio(imgRatio)
  const normalizedQuality = normalizeMivoQuality(quality)
  return mivoImageSizeMap[ratio][normalizedQuality]
}

const normalizeMivoImages = (payload: unknown): MivoImageResponse => {
  const maybePayload = payload as {
    data?: Array<{ b64_json?: unknown }>
    images?: Array<{ b64?: unknown }>
  }
  const images = (maybePayload.data || [])
    .map((item) => (typeof item.b64_json === 'string' && item.b64_json.trim() ? { b64: item.b64_json } : undefined))
    .filter((item): item is { b64: string } => Boolean(item))

  if (!images.length && maybePayload.images) {
    images.push(
      ...maybePayload.images
        .map((item) => (typeof item.b64 === 'string' && item.b64.trim() ? { b64: item.b64 } : undefined))
        .filter((item): item is { b64: string } => Boolean(item)),
    )
  }

  if (!images.length) throw new Error('Image API returned no images')
  return { images }
}

const readUpstreamError = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } | string; message?: string }
    if (typeof payload.error === 'string') return payload.error
    return payload.error?.message || payload.message || `${response.status} ${response.statusText}`
  } catch {
    try {
      return await response.text()
    } catch {
      return `${response.status} ${response.statusText}`
    }
  }
}

const proxyMivoGenerate = async (
  request: IncomingMessage,
  response: ServerResponse,
  imageApiKey: string,
) => {
  try {
    if (request.method !== 'POST') {
      sendMivoJson(response, 405, { error: 'Method not allowed' })
      return
    }

    const body = await readJsonRequest<{
      prompt?: unknown
      imgRatio?: unknown
      quality?: unknown
      n?: unknown
      model?: unknown
    }>(request)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) {
      sendMivoJson(response, 400, { error: 'prompt is required' })
      return
    }

    const quality = normalizeMivoQuality(body.quality)
    const upstreamResponse = await fetchUpstreamWithTimeout(`${mivoImageApiBase}/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readImageApiKey(imageApiKey)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultMivoImageModel,
        prompt,
        n: Number.isFinite(Number(body.n)) ? Math.max(1, Math.min(4, Math.floor(Number(body.n)))) : 1,
        size: imageSizeFor(body.imgRatio, quality),
        quality,
      }),
    })

    if (!upstreamResponse.ok) {
      sendMivoJson(response, upstreamResponse.status, { error: await readUpstreamError(upstreamResponse) })
      return
    }

    sendMivoJson(response, 200, normalizeMivoImages(await upstreamResponse.json()))
  } catch (error) {
    sendMivoJson(
      response,
      error instanceof RequestBodyTooLargeError ? 413 : error instanceof UpstreamRequestTimeoutError ? 504 : 500,
      { error: error instanceof Error ? error.message : 'Unable to generate image' },
    )
  }
}

const proxyMivoEdit = async (
  request: IncomingMessage,
  response: ServerResponse,
  imageApiKey: string,
) => {
  try {
    if (request.method !== 'POST') {
      sendMivoJson(response, 405, { error: 'Method not allowed' })
      return
    }

    const { fields, files } = await parseMultipartRequest(request)
    const image = multipartFiles(files, 'image')[0]
    if (!image) {
      sendMivoJson(response, 400, { error: 'image is required' })
      return
    }

    const prompt = firstMultipartField(fields, 'prompt').trim()
    if (!prompt) {
      sendMivoJson(response, 400, { error: 'prompt is required' })
      return
    }

    const quality = normalizeMivoQuality(firstMultipartField(fields, 'quality'))
    const model = firstMultipartField(fields, 'model').trim() || defaultMivoImageModel
    const formData = new FormData()
    appendFile(formData, 'image', image)
    const mask = multipartFiles(files, 'mask')[0]
    if (mask) appendFile(formData, 'mask', mask)
    for (const reference of [...multipartFiles(files, 'reference[]'), ...multipartFiles(files, 'reference')]) {
      appendFile(formData, 'reference[]', reference)
    }
    formData.set('model', model)
    formData.set('prompt', prompt)
    formData.set('size', imageSizeFor(firstMultipartField(fields, 'imgRatio'), quality))
    formData.set('quality', quality)

    const upstreamResponse = await fetchUpstreamWithTimeout(
      `${mivoImageApiBase}/edits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readImageApiKey(imageApiKey)}`,
        },
        body: formData,
      },
      mivoEditUpstreamTimeoutMs,
    )

    if (!upstreamResponse.ok) {
      sendMivoJson(response, upstreamResponse.status, { error: await readUpstreamError(upstreamResponse) })
      return
    }

    sendMivoJson(response, 200, normalizeMivoImages(await upstreamResponse.json()))
  } catch (error) {
    sendMivoJson(
      response,
      error instanceof RequestBodyTooLargeError ? 413 : error instanceof UpstreamRequestTimeoutError ? 504 : 500,
      { error: error instanceof Error ? error.message : 'Unable to edit image' },
    )
  }
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

const eagleThumbnailFallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" rx="16" fill="#f3f0e8"/>
  <path d="M76 154l52-62 42 48 28-30 46 44H76z" fill="#c9c1b0"/>
  <circle cx="220" cy="82" r="22" fill="#d9d1c2"/>
</svg>`

const sendImageBuffer = (response: ServerResponse, file: Buffer, filePath: string) => {
  response.setHeader('Content-Type', mimeForFile(file, filePath))
  response.setHeader('Cache-Control', 'no-store')
  response.end(file)
}

const sendEagleThumbnailFallback = async (response: ServerResponse, itemId: string) => {
  try {
    const item = await readEagleItem(itemId)
    const filePath = await eagleOriginalPathFor(item)
    sendImageBuffer(response, await fs.readFile(filePath), filePath)
  } catch {
    response.statusCode = 200
    response.setHeader('Content-Type', 'image/svg+xml')
    response.setHeader('Cache-Control', 'no-store')
    response.end(eagleThumbnailFallbackSvg)
  }
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

// ─── enhance helpers ──────────────────────────────────────────────────────────

const buildEnhanceSystemPrompt = (allowedRatios: string[]) =>
  `You are an AI image generation prompt enhancer. Analyze the user input and return a single JSON object (no markdown fences) with these fields:
- scene: brief scene category (e.g. "portrait", "landscape", "product", "abstract", "illustration")
- reasoning: one sentence in Chinese explaining key enhancement decisions
- richPrompt: enhanced English image prompt — specific and vivid; faithfully preserve user intent; do NOT add entities the user did not mention; do NOT pile style words like masterpiece/8k/cinematic/high quality unless the user asked
- imgRatio: choose from allowed list: ${allowedRatios.join(', ')}; pick what best fits the scene composition
- quality: "low" (fast sketch), "medium" (standard), or "high" (fine detail/print)

Additional rules:
- Chinese or very short input → expand into a specific English visual description
- When history is provided → this is a refinement; evolve the previous richPrompt rather than starting fresh
- Output ONLY the JSON object, no surrounding text`

type EnhanceLlmResponse = {
  choices?: Array<{ message?: { content?: string } }>
}

type EnhanceParsed = {
  scene: string
  reasoning: string
  richPrompt: string
  imgRatio: string
  quality: string
}

const parseEnhanceJson = (raw: string): EnhanceParsed | null => {
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const parsed = JSON.parse(stripped) as Record<string, unknown>
    if (
      typeof parsed.scene === 'string' &&
      typeof parsed.reasoning === 'string' &&
      typeof parsed.richPrompt === 'string' &&
      typeof parsed.imgRatio === 'string' &&
      typeof parsed.quality === 'string'
    ) {
      return {
        scene: parsed.scene,
        reasoning: parsed.reasoning,
        richPrompt: parsed.richPrompt,
        imgRatio: parsed.imgRatio,
        quality: parsed.quality,
      }
    }
    return null
  } catch {
    return null
  }
}

const callEnhanceLlm = async (
  model: string,
  messages: Array<{ role: string; content: string }>,
  llmApiKey: string,
  timeoutMs: number,
): Promise<{ result: EnhanceParsed | null; reason: string }> => {
  try {
    const response = await fetchUpstreamWithTimeout(
      `${mivoLlmApiBase}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${llmApiKey}`,
          'Content-Type': 'application/json',
        },
        // No response_format: kimi faster without it; qwen hangs with json_object (probe-results.md)
        body: JSON.stringify({ model, messages }),
      },
      timeoutMs,
    )
    if (!response.ok) return { result: null, reason: 'upstream-error' }
    const payload = (await response.json()) as EnhanceLlmResponse
    const content = payload.choices?.[0]?.message?.content || ''
    const parsed = parseEnhanceJson(content)
    return { result: parsed, reason: parsed ? '' : 'bad-json' }
  } catch (error) {
    return {
      result: null,
      reason: error instanceof UpstreamRequestTimeoutError ? 'timeout' : 'upstream-error',
    }
  }
}

type EnhanceRequestBody = {
  prompt?: unknown
  modelId?: unknown
  history?: unknown
  hasSelectedImage?: unknown
  sceneId?: unknown
}

const proxyMivoEnhance = async (
  request: IncomingMessage,
  response: ServerResponse,
  llmApiKey: string,
) => {
  try {
    if (request.method !== 'POST') {
      sendMivoJson(response, 405, { error: 'Method not allowed' })
      return
    }

    if (!llmApiKey.trim()) {
      sendMivoJson(response, 200, { enhanced: false, degradedReason: 'no-key' })
      return
    }

    const body = await readJsonRequest<EnhanceRequestBody>(request)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) {
      sendMivoJson(response, 400, { error: 'prompt is required' })
      return
    }

    const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : 'gpt-image-2'
    const allowedRatios = mivoModelRatioMap[modelId] ?? mivoModelRatioMap['gpt-image-2']
    const defaultRatio = mivoModelDefaultRatio[modelId] ?? '1:1'

    type HistoryEntry = { role: string; content: string }
    const historyEntries: HistoryEntry[] = Array.isArray(body.history)
      ? (body.history as unknown[])
          .filter(
            (entry): entry is HistoryEntry =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as HistoryEntry).role === 'string' &&
              typeof (entry as HistoryEntry).content === 'string',
          )
          .slice(-6)
      : []

    const systemPrompt = buildEnhanceSystemPrompt(allowedRatios)
    const userContent =
      historyEntries.length > 0
        ? `Previous conversation:\n${historyEntries.map((e) => `${e.role}: ${e.content}`).join('\n')}\n\nNew request: ${prompt}`
        : prompt

    const llmMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]

    // Primary: kimi-k2.6 (10s)
    let { result, reason: degradedReason } = await callEnhanceLlm(mivoEnhancePrimaryModel, llmMessages, llmApiKey.trim(), mivoEnhancePrimaryTimeoutMs)

    // Fallback: qwen3.6-plus (15s) — no response_format per probe-results
    if (!result) {
      const fallback = await callEnhanceLlm(mivoEnhanceFallbackModel, llmMessages, llmApiKey.trim(), mivoEnhanceFallbackTimeoutMs)
      result = fallback.result
      if (!result) degradedReason = fallback.reason || degradedReason
    }

    if (!result) {
      sendMivoJson(response, 200, { enhanced: false, degradedReason })
      return
    }

    const clampedRatio = (allowedRatios as string[]).includes(result.imgRatio) ? result.imgRatio : defaultRatio
    const quality = ['low', 'medium', 'high'].includes(result.quality) ? result.quality : 'medium'

    sendMivoJson(response, 200, {
      scene: result.scene,
      reasoning: result.reasoning,
      richPrompt: result.richPrompt,
      imgRatio: clampedRatio,
      quality,
      enhanced: true,
    })
  } catch (error) {
    sendMivoJson(
      response,
      error instanceof RequestBodyTooLargeError ? 413 : 500,
      { error: error instanceof Error ? error.message : 'Unable to enhance prompt' },
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const localAssetLibraryPlugin = ({ imageApiKey, llmApiKey }: { imageApiKey: string; llmApiKey: string }): Plugin => ({
  name: 'mivo-local-asset-library',
  configureServer(server: ViteDevServer) {
    server.middlewares.use(async (request, response, next) => {
      const url = request.url || ''
      const requestUrl = new URL(url || '/', 'http://127.0.0.1')
      const pathname = requestUrl.pathname

      if (pathname === '/api/mivo/generate') {
        await proxyMivoGenerate(request, response, imageApiKey)
        return
      }

      if (pathname === '/api/mivo/edit') {
        await proxyMivoEdit(request, response, imageApiKey)
        return
      }

      if (pathname === '/api/mivo/enhance') {
        await proxyMivoEnhance(request, response, llmApiKey)
        return
      }

      if (pathname === '/api/mivo/local-assets') {
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

      if (pathname === '/api/mivo/eagle/status') {
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

      if (pathname === '/api/mivo/eagle/folders') {
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

      if (pathname === '/api/mivo/eagle/tags') {
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
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ tags: normalizedTags }))
        } catch (error) {
          response.statusCode = 502
          response.end(error instanceof Error ? error.message : 'Unable to read Eagle tags')
        }
        return
      }

      if (pathname.startsWith('/api/mivo/eagle/assets/') && pathname.endsWith('/thumbnail')) {
        try {
          const itemId = decodeURIComponent(
            pathname.slice('/api/mivo/eagle/assets/'.length, -'/thumbnail'.length) || '',
          )
          const thumbnailPath = await eagleThumbnailPathFor(itemId)
          sendImageBuffer(response, await fs.readFile(thumbnailPath), thumbnailPath)
        } catch {
          const itemId = decodeURIComponent(
            pathname.slice('/api/mivo/eagle/assets/'.length, -'/thumbnail'.length) || '',
          )
          await sendEagleThumbnailFallback(response, itemId)
        }
        return
      }

      if (pathname.startsWith('/api/mivo/eagle/assets/') && pathname.endsWith('/file')) {
        try {
          const itemId = decodeURIComponent(
            pathname.slice('/api/mivo/eagle/assets/'.length, -'/file'.length) || '',
          )
          const item = await readEagleItem(itemId)
          const filePath = await eagleOriginalPathFor(item)
          sendImageBuffer(response, await fs.readFile(filePath), filePath)
        } catch {
          response.statusCode = 404
          response.end('Eagle original not found')
        }
        return
      }

      if (pathname === '/api/mivo/eagle/assets') {
        try {
          const limit = requestUrl.searchParams.get('limit') || '80'
          const offset = requestUrl.searchParams.get('offset') || '0'
          const folderId = requestUrl.searchParams.get('folderId') || ''
          const tag = requestUrl.searchParams.get('tag') || requestUrl.searchParams.get('tags') || ''
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

          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ assets }))
        } catch (error) {
          response.statusCode = 502
          response.end(error instanceof Error ? error.message : 'Unable to read Eagle assets')
        }
        return
      }

      if (pathname === '/api/mivo/pinterest/status') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(
          JSON.stringify({
            connected: false,
            mode: 'prototype',
          }),
        )
        return
      }

      if (pathname.startsWith('/api/mivo/local-assets/')) {
        try {
          const id = decodeURIComponent(pathname.slice('/api/mivo/local-assets/'.length) || '')
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
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const imageApiKey = env.MIVO_IMAGE_API_KEY || process.env.MIVO_IMAGE_API_KEY || ''
  // LLM key for enhance endpoint: prefer dedicated key, fall back to image key
  const llmApiKey = env.MIVO_LLM_API_KEY || env.MIVO_IMAGE_API_KEY || ''

  return {
    plugins: [react(), localAssetLibraryPlugin({ imageApiKey, llmApiKey })],
  }
})
