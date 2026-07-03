import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// ─── P1-c BFF diff hook ──────────────────────────────────────────────────────
// This file is the SC1.2 skeleton: "BFF 与 dev middleware 基线逐字段 diff = 0".
//  1. Static suite (always runs in `npm run test:unit`): validates every committed
//     capture under __captures__/ against its invariant, and every contract JSON's
//     capture/captures ref resolves to a file. Fast, no server.
//  2. Live suite (only when MIVO_CONTRACT_LIVE=1): issues the same requests against
//     a target and asserts the live response matches the invariant. The target is
//     `MIVO_CONTRACT_TARGET_URL` if set (→ BFF in P1-c), otherwise an ephemeral
//     vite dev server started in beforeAll. P1-c workflow:
//       MIVO_CONTRACT_TARGET_URL=http://127.0.0.1:3000 MIVO_CONTRACT_LIVE=1 npm run test:unit
//     A green run means BFF responses match the dev-middleware baseline (diff=0 on
//     the locked fields). Intended-changes (see contract JSONs) are exempted per-scenario.

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE_DIR = join(HERE, '__captures__')

const CONTRACT_FILES = [
  'generate.json',
  'edit.json',
  'enhance.json',
  'debug-logs.json',
  'local-assets.json',
  'eagle.json',
  'pinterest-status.json',
  'platform-helpers.json',
] as const

type Capture = {
  scenario: string
  response: {
    status?: number
    headers?: Record<string, string | null>
    body?: unknown
    transportError?: string
  }
}

const readCapture = (name: string): Capture =>
  JSON.parse(readFileSync(join(CAPTURE_DIR, `${name}.json`), 'utf8')) as Capture

const listCaptureNames = (): string[] =>
  readdirSync(CAPTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))

const loadContractJsons = (): unknown[] =>
  CONTRACT_FILES.map((f) => JSON.parse(readFileSync(join(HERE, f), 'utf8')))

const collectCaptureRefs = (objs: unknown[]): string[] => {
  const out: string[] = []
  const walk = (obj: unknown): void => {
    if (Array.isArray(obj)) {
      obj.forEach(walk)
      return
    }
    if (obj && typeof obj === 'object') {
      const o = obj as Record<string, unknown>
      if (typeof o.capture === 'string') out.push(o.capture)
      if (Array.isArray(o.captures)) {
        for (const c of o.captures) if (typeof c === 'string') out.push(c)
      }
      Object.values(o).forEach(walk)
    }
  }
  objs.forEach(walk)
  return out
}

// ─── Invariants: one per capture. These are the locked fields the BFF must reproduce. ───
const bodyAs = <T>(c: Capture): T => c.response.body as T

const INVARIANTS: Record<string, (c: Capture) => void> = {
  'generate-405': (c) => {
    expect(c.response.status).toBe(405)
    expect(bodyAs<{ error: string }>(c).error).toBe('Method not allowed')
  },
  'generate-400-no-prompt': (c) => {
    expect(c.response.status).toBe(400)
    expect(bodyAs<{ error: string }>(c).error).toBe('prompt is required')
  },
  'generate-413': (c) => {
    expect(c.response.transportError).toBe('ECONNRESET')
  },
  'generate-500-no-platform-key': (c) => {
    expect(c.response.status).toBe(500)
    expect(bodyAs<{ error: string }>(c).error).toContain('MIVO_PLATFORM_KEY')
  },
  'generate-500-no-image-key': (c) => {
    expect(c.response.status).toBe(500)
    expect(bodyAs<{ error: string }>(c).error).toBe('MIVO_IMAGE_API_KEY is not set')
  },
  'edit-405': (c) => {
    expect(c.response.status).toBe(405)
    expect(bodyAs<{ error: string }>(c).error).toBe('Method not allowed')
  },
  'edit-400-no-image': (c) => {
    expect(c.response.status).toBe(400)
    expect(bodyAs<{ error: string }>(c).error).toBe('image is required')
  },
  'edit-400-no-prompt': (c) => {
    expect(c.response.status).toBe(400)
    expect(bodyAs<{ error: string }>(c).error).toBe('prompt is required')
  },
  'edit-413': (c) => {
    expect(c.response.transportError).toBe('ECONNRESET')
  },
  'edit-500-no-platform-key': (c) => {
    expect(c.response.status).toBe(500)
    expect(bodyAs<{ error: string }>(c).error).toContain('MIVO_PLATFORM_KEY')
  },
  'enhance-405': (c) => {
    expect(c.response.status).toBe(405)
    expect(bodyAs<{ error: string }>(c).error).toBe('Method not allowed')
  },
  'enhance-200-no-key': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ enhanced: boolean }>(c).enhanced).toBe(false)
    expect(bodyAs<{ degradedReason: string }>(c).degradedReason).toBe('no-key')
  },
  'debug-logs-405': (c) => {
    expect(c.response.status).toBe(405)
    expect(bodyAs<{ ok: boolean }>(c).ok).toBe(false)
    expect(bodyAs<{ error: string }>(c).error).toBe('Method not allowed')
  },
  'debug-logs-post-200': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ ok: boolean }>(c).ok).toBe(true)
    expect(typeof bodyAs<{ accepted: number }>(c).accepted).toBe('number')
  },
  'debug-logs-post-filter-level': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ accepted: number }>(c).accepted).toBe(2)
  },
  'debug-logs-post-413': (c) => {
    expect(c.response.transportError).toBe('ECONNRESET')
  },
  'debug-logs-post-400': (c) => {
    expect(c.response.status).toBe(400)
    expect(bodyAs<{ ok: boolean }>(c).ok).toBe(false)
    expect(typeof bodyAs<{ error: string }>(c).error).toBe('string')
  },
  'debug-logs-get-403': (c) => {
    expect(c.response.status).toBe(403)
    expect(bodyAs<{ ok: boolean }>(c).ok).toBe(false)
    expect(bodyAs<{ error: string }>(c).error).toBe('Debug report token required')
  },
  'debug-logs-get-200-header-token': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ ok: boolean }>(c).ok).toBe(true)
  },
  'debug-logs-get-200-query-token': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ ok: boolean }>(c).ok).toBe(true)
  },
  'local-assets-list-200': (c) => {
    expect(c.response.status).toBe(200)
    expect(Array.isArray(bodyAs<{ assets: unknown[] }>(c).assets)).toBe(true)
  },
  'local-assets-list-post-200': (c) => {
    expect(c.response.status).toBe(200)
    expect(Array.isArray(bodyAs<{ assets: unknown[] }>(c).assets)).toBe(true)
  },
  'local-assets-file-200': (c) => {
    expect(c.response.status).toBe(200)
    expect(c.response.headers?.['content-type']).toBe('image/svg+xml')
    expect(c.response.headers?.['cache-control']).toBe('no-store')
  },
  'local-assets-file-403-traversal': (c) => {
    expect(c.response.status).toBe(403)
    expect(c.response.headers?.['content-type']).toBeNull()
    expect(c.response.body).toBe('Asset path is outside allowed roots')
  },
  'local-assets-file-404': (c) => {
    expect(c.response.status).toBe(404)
    expect(c.response.body).toBe('Local asset not found')
  },
  'eagle-status-offline': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ connected: boolean }>(c).connected).toBe(false)
  },
  'eagle-folders-502': (c) => {
    expect(c.response.status).toBe(502)
    expect(c.response.headers?.['content-type']).toBeNull()
  },
  'eagle-tags-502': (c) => {
    expect(c.response.status).toBe(502)
    expect(c.response.headers?.['content-type']).toBeNull()
  },
  'eagle-assets-502': (c) => {
    expect(c.response.status).toBe(502)
    expect(c.response.headers?.['content-type']).toBeNull()
  },
  'eagle-assets-file-404': (c) => {
    expect(c.response.status).toBe(404)
    expect(c.response.body).toBe('Eagle original not found')
  },
  'eagle-assets-thumbnail-svg-fallback': (c) => {
    expect(c.response.status).toBe(200)
    expect(c.response.headers?.['content-type']).toBe('image/svg+xml')
    expect(c.response.headers?.['cache-control']).toBe('no-store')
  },
  'pinterest-status-200': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ connected: boolean }>(c).connected).toBe(false)
    expect(bodyAs<{ mode: string }>(c).mode).toBe('prototype')
  },
  'pinterest-status-post-200': (c) => {
    expect(c.response.status).toBe(200)
    expect(bodyAs<{ connected: boolean }>(c).connected).toBe(false)
    expect(bodyAs<{ mode: string }>(c).mode).toBe('prototype')
  },
}

// ─── Static suite ────────────────────────────────────────────────────────────
describe('server/contracts — static baseline', () => {
  it('every capture file is well-formed (scenario + status|transportError)', () => {
    const names = listCaptureNames()
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const c = readCapture(name)
      expect(c.scenario, `${name}.scenario`).toBe(name)
      const hasStatus = typeof c.response.status === 'number'
      const hasErr = typeof c.response.transportError === 'string'
      expect(hasStatus || hasErr, `${name} must have status or transportError`).toBe(true)
    }
  })

  it('every capture satisfies its invariant', () => {
    for (const name of listCaptureNames()) {
      const inv = INVARIANTS[name]
      expect(inv, `no invariant registered for ${name}`).toBeDefined()
      inv(readCapture(name))
    }
  })

  it('every contract JSON parses and every capture/captures ref resolves', () => {
    const refs = collectCaptureRefs(loadContractJsons())
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const rel = ref.replace(/^__captures__\//, '')
      expect(existsSync(join(CAPTURE_DIR, rel)), `missing capture ${ref}`).toBe(true)
    }
  })
})
// ─── Live suite (env-gated; does NOT run in default `npm run test:unit`) ─────
const runLive = process.env.MIVO_CONTRACT_LIVE === '1'
const TARGET = process.env.MIVO_CONTRACT_TARGET_URL ?? ''

type FetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string | FormData
}

const execFetch = async (base: string, path: string, init: FetchInit = {}): Promise<Capture> => {
  try {
    const res = await fetch(base + path, init)
    const text = await res.text()
    let body: unknown = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = text
    }
    return {
      scenario: '',
      response: {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type'),
          'cache-control': res.headers.get('cache-control'),
        },
        body,
      },
    }
  } catch (err) {
    const e = err as { cause?: { code?: string }; message?: string }
    return { scenario: '', response: { transportError: e.cause?.code ?? e.message ?? 'fetch-error' } }
  }
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#000"/></svg>'
const debugToken = ['test', 'token'].join('-')

// Curated subset exercising every contract family (405 / 400 / 403 / no-key / traversal /
// eagle-offline / placeholder / non-GET method / multipart). 413 is covered statically.
const LIVE_CASES: Array<{ name: string; run: (base: string) => Promise<Capture> }> = [
  { name: 'generate-405', run: (b) => execFetch(b, '/api/mivo/generate', { method: 'GET' }) },
  {
    name: 'generate-400-no-prompt',
    run: (b) => execFetch(b, '/api/mivo/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  },
  {
    name: 'generate-500-no-platform-key',
    run: (b) => execFetch(b, '/api/mivo/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', model: 'gpt-image-2' }) }),
  },
  { name: 'enhance-405', run: (b) => execFetch(b, '/api/mivo/enhance', { method: 'GET' }) },
  {
    name: 'enhance-200-no-key',
    run: (b) => execFetch(b, '/api/mivo/enhance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a cat' }) }),
  },
  { name: 'debug-logs-get-403', run: (b) => execFetch(b, '/api/mivo/debug-logs', { method: 'GET' }) },
  {
    name: 'debug-logs-post-200',
    run: (b) => execFetch(b, '/api/mivo/debug-logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ level: 'warning', source: 'S', message: 'm', timestamp: 1 }] }) }),
  },
  {
    name: 'local-assets-file-403-traversal',
    run: (b) => execFetch(b, `/api/mivo/local-assets/${Buffer.from('/etc/passwd').toString('base64url')}`, { method: 'GET' }),
  },
  { name: 'eagle-status-offline', run: (b) => execFetch(b, '/api/mivo/eagle/status', { method: 'GET' }) },
  { name: 'pinterest-status-200', run: (b) => execFetch(b, '/api/mivo/pinterest/status', { method: 'GET' }) },
  { name: 'local-assets-list-post-200', run: (b) => execFetch(b, '/api/mivo/local-assets', { method: 'POST' }) },
  {
    name: 'edit-400-no-image',
    run: (b) => {
      const fd = new FormData()
      fd.append('prompt', 'x')
      return execFetch(b, '/api/mivo/edit', { method: 'POST', body: fd })
    },
  },
]

describe.skipIf(!runLive)('server/contracts — live (target = dev middleware or MIVO_CONTRACT_TARGET_URL)', () => {
  let base: string
  let server: { close: () => Promise<void> } | undefined
  let assetDir: string
  let debugLogDir: string

  beforeAll(async () => {
    if (TARGET) {
      base = TARGET
      return
    }
    // Start an ephemeral dev server with the same key-free env as the capture script.
    assetDir = await mkdtemp(join(tmpdir(), 'mivo-contract-live-assets-'))
    debugLogDir = await mkdtemp(join(tmpdir(), 'mivo-contract-live-logs-'))
    await writeFile(join(assetDir, 'test.svg'), SVG, 'utf8')
    process.env.MIVO_ASSET_DIR = assetDir
    process.env.MIVO_DEBUG_LOG_DIR = debugLogDir
    process.env.MIVO_DEBUG_VIEW_TOKEN = debugToken
    process.env.MIVO_EAGLE_API_URL = 'http://127.0.0.1:59999'
    const { createServer } = await import('vite')
    const s = await createServer({
      root: process.cwd(),
      logLevel: 'silent',
      server: { port: 0, host: '127.0.0.1' },
      appType: 'custom',
    })
    await s.listen()
    server = s
    const address = s.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error(`unexpected dev server address: ${String(address)}`)
    }
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (server) await server.close()
    if (assetDir) await rm(assetDir, { recursive: true, force: true })
    if (debugLogDir) await rm(debugLogDir, { recursive: true, force: true })
  })

  for (const c of LIVE_CASES) {
    it(`${c.name} matches baseline invariant`, async () => {
      const live = await c.run(base)
      const inv = INVARIANTS[c.name]
      expect(inv, `no invariant for ${c.name}`).toBeDefined()
      inv(live)
    })
  }
})
