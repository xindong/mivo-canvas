import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Static contract suite (runs in `npm run test:unit`). Validates every committed
// capture under __captures__/ against its invariant, and every contract JSON's
// capture/captures ref resolves to a file. Fast, no server.
//
// The LIVE diff suite (SC1.2: "BFF 与 dev middleware 基线逐字段 diff = 0") lives
// in `scripts/contract-diff.mjs`, invoked via `npm run contract:diff`. That script
// parameterizes the target (dev middleware or BFF url) and emits a per-field diff
// report; see server/contracts/README.md.

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
