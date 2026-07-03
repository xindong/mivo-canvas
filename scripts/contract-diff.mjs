// contract:diff — SC1.2 execution entry.
//
// Replays every committed capture in server/contracts/__captures__/ against a
// target (the dev middleware or a BFF url) and emits a per-field diff report.
// diff=0 means the target reproduces the dev-middleware baseline on the locked
// fields; intended changes (D1/D7/...) are listed separately and verified
// against their own expectation.
//
// Usage:
//   npm run contract:diff                                   # target=dev (all groups)
//   npm run contract:diff -- --target=http://127.0.0.1:8080 # BFF url (all groups)
//   npm run contract:diff -- --target=http://127.0.0.1:8080 --group=debug-logs
//   MIVO_CONTRACT_TARGET_URL=http://127.0.0.1:8080 npm run contract:diff -- --group=debug-logs
//
// Exit 0 = no unexpected diffs. Exit 1 = at least one unexpected diff.

import { createServer } from 'vite'
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKTREE = process.cwd()
const CAPTURE_DIR = join(WORKTREE, 'server/contracts/__captures__')

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#000"/></svg>'
const debugToken = ['test', 'token'].join('-')

// ─── Args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']
}))
const TARGET_ARG = args.target ?? process.env.MIVO_CONTRACT_TARGET_URL ?? 'dev'
const GROUP = args.group ?? ''
const IS_DEV = TARGET_ARG === 'dev'

// ─── Capture loading ─────────────────────────────────────────────────────────
const loadCaptures = async () => {
  const files = (await readdir(CAPTURE_DIR)).filter((f) => f.endsWith('.json'))
  const map = new Map()
  for (const f of files) {
    const cap = JSON.parse(await readFile(join(CAPTURE_DIR, f), 'utf8'))
    map.set(cap.scenario, cap)
  }
  return map
}

// ─── Body factories ──────────────────────────────────────────────────────────
const json = (obj) => JSON.stringify(obj)
const bigBuf = (mb) => Buffer.alloc(Math.ceil(mb * 1024 * 1024), 0x61)
const formPromptOnly = () => { const fd = new FormData(); fd.append('prompt', 'x'); return fd }
const formImageOnly = () => { const fd = new FormData(); fd.append('image', new File([SVG], 'test.svg', { type: 'image/svg+xml' })); return fd }
const formImagePrompt = (model) => {
  const fd = new FormData()
  fd.append('image', new File([SVG], 'test.svg', { type: 'image/svg+xml' }))
  fd.append('prompt', 'x')
  if (model) fd.append('model', model)
  return fd
}
const traversalId = Buffer.from('/etc/passwd').toString('base64url')
const expandHome = (value) => value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
const readLocalAssetsList = async (base) => {
  const res = await fetch(`${base}/api/mivo/local-assets`)
  return res.json()
}
const missingAssetId = async (base) => {
  const body = await readLocalAssetsList(base)
  return Buffer.from(join(expandHome(body.root), 'nonexistent.png')).toString('base64url')
}
const firstAssetId = async (base) => {
  const body = await readLocalAssetsList(base)
  return body.assets[0]?.id ? `/api/mivo/local-assets/${body.assets[0].id}` : '/api/mivo/local-assets/none'
}

// ─── Scenarios: request spec + locked fields + intended changes ──────────────
// Each lock is [label, getter(capture-like) -> string]. The runner compares
// getter(live) vs getter(baseline capture). Identical getters for both sides.
const L = {
  status: (r) => (r.response.transportError ? 'transport:error' : `status:${r.response.status}`),
  ct: (r) => r.response.headers?.['content-type'] ?? 'null',
  bodyError: (r) => r.response.body?.error ?? 'none',
  bodyOk: (r) => r.response.body?.ok ?? 'none',
  bodyAccepted: (r) => r.response.body?.accepted ?? 'none',
  bodyConnected: (r) => r.response.body?.connected ?? 'none',
  bodyMode: (r) => r.response.body?.mode ?? 'none',
  bodyEnhanced: (r) => r.response.body?.enhanced ?? 'none',
  bodyDegraded: (r) => r.response.body?.degradedReason ?? 'none',
  bodyAssetsArr: (r) => Array.isArray(r.response.body?.assets) ? 'array' : 'not-array',
  bodyExact: (r) => JSON.stringify(r.response.body ?? null),
}

const SCENARIOS = [
  // generate
  { name: 'generate-405', group: 'generate', method: 'GET', path: '/api/mivo/generate', locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'generate-400-no-prompt', group: 'generate', method: 'POST', path: '/api/mivo/generate', body: json({}), ct: 'application/json', locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'generate-413', group: 'generate', method: 'POST', path: '/api/mivo/generate', body: bigBuf(1.1), ct: 'application/json', locks: [['status', L.status]] },
  { name: 'generate-500-no-platform-key', group: 'generate', method: 'POST', path: '/api/mivo/generate', body: json({ prompt: 'x', model: 'gpt-image-2' }), ct: 'application/json', locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'generate-500-no-image-key', group: 'generate', method: 'POST', path: '/api/mivo/generate', body: json({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }), ct: 'application/json', locks: [['status', L.status], ['body.error', L.bodyError]] },
  // edit
  { name: 'edit-405', group: 'edit', method: 'GET', path: '/api/mivo/edit', locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'edit-400-no-image', group: 'edit', method: 'POST', path: '/api/mivo/edit', body: formPromptOnly(), locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'edit-400-no-prompt', group: 'edit', method: 'POST', path: '/api/mivo/edit', body: formImageOnly(), locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'edit-413', group: 'edit', method: 'POST', path: '/api/mivo/edit', body: bigBuf(41), ct: 'multipart/form-data; boundary=x', locks: [['status', L.status]] },
  { name: 'edit-500-no-platform-key', group: 'edit', method: 'POST', path: '/api/mivo/edit', body: formImagePrompt('gpt-image-2'), locks: [['status', L.status], ['body.error', L.bodyError]] },
  // enhance
  { name: 'enhance-405', group: 'enhance', method: 'GET', path: '/api/mivo/enhance', locks: [['status', L.status], ['body.error', L.bodyError]] },
  { name: 'enhance-200-no-key', group: 'enhance', method: 'POST', path: '/api/mivo/enhance', body: json({ prompt: 'a cat' }), ct: 'application/json', locks: [['status', L.status], ['enhanced', L.bodyEnhanced], ['degradedReason', L.bodyDegraded]] },
  // debug-logs
  { name: 'debug-logs-405', group: 'debug-logs', method: 'PUT', path: '/api/mivo/debug-logs', locks: [['status', L.status], ['ok', L.bodyOk], ['body.error', L.bodyError]] },
  { name: 'debug-logs-post-200', group: 'debug-logs', method: 'POST', path: '/api/mivo/debug-logs', body: json({ clientId: 'c1', sessionId: 's1', entries: [{ level: 'warning', source: 'S', message: 'm', timestamp: 1 }] }), ct: 'application/json', locks: [['status', L.status], ['ok', L.bodyOk], ['accepted', L.bodyAccepted]] },
  { name: 'debug-logs-post-filter-level', group: 'debug-logs', method: 'POST', path: '/api/mivo/debug-logs', body: json({ entries: [{ level: 'log', source: 'A', message: 'drop', timestamp: 1 }, { level: 'warning', source: 'B', message: 'keep', timestamp: 2 }, { level: 'error', source: 'C', message: 'keep', timestamp: 3 }] }), ct: 'application/json', locks: [['status', L.status], ['ok', L.bodyOk], ['accepted', L.bodyAccepted]] },
  { name: 'debug-logs-post-413', group: 'debug-logs', method: 'POST', path: '/api/mivo/debug-logs', body: bigBuf(1.1), ct: 'application/json', locks: [['status', L.status]] },
  { name: 'debug-logs-post-400', group: 'debug-logs', method: 'POST', path: '/api/mivo/debug-logs', body: '{not json', ct: 'application/json', locks: [['status', L.status], ['ok', L.bodyOk]] },
  { name: 'debug-logs-get-403', group: 'debug-logs', method: 'GET', path: '/api/mivo/debug-logs', locks: [['status', L.status], ['ok', L.bodyOk], ['body.error', L.bodyError]] },
  { name: 'debug-logs-get-200-header-token', group: 'debug-logs', method: 'GET', path: '/api/mivo/debug-logs', headers: { 'x-mivo-debug-token': debugToken }, locks: [['status', L.status], ['ok', L.bodyOk]] },
  { name: 'debug-logs-get-200-query-token', group: 'debug-logs', method: 'GET', path: `/api/mivo/debug-logs?token=${debugToken}`, locks: [['status', L.status], ['ok', L.bodyOk]] },
  // local-assets
  { name: 'local-assets-list-200', group: 'local-assets', method: 'GET', path: '/api/mivo/local-assets', locks: [['status', L.status], ['assets', L.bodyAssetsArr]] },
  { name: 'local-assets-list-post-200', group: 'local-assets', method: 'POST', path: '/api/mivo/local-assets', locks: [['status', L.status], ['assets', L.bodyAssetsArr]] },
  { name: 'local-assets-file-200', group: 'local-assets', method: 'GET', path: firstAssetId, locks: [['status', L.status], ['content-type', L.ct], ['body', L.bodyExact]] },
  { name: 'local-assets-file-403-traversal', group: 'local-assets', method: 'GET', path: `/api/mivo/local-assets/${traversalId}`, locks: [['status', L.status], ['content-type', L.ct], ['body', L.bodyExact]] },
  { name: 'local-assets-file-404', group: 'local-assets', method: 'GET', path: async (base) => `/api/mivo/local-assets/${await missingAssetId(base)}`, locks: [['status', L.status], ['content-type', L.ct], ['body', L.bodyExact]] },
  // eagle
  { name: 'eagle-status-offline', group: 'eagle', method: 'GET', path: '/api/mivo/eagle/status', locks: [['status', L.status], ['connected', L.bodyConnected]] },
  { name: 'eagle-folders-502', group: 'eagle', method: 'GET', path: '/api/mivo/eagle/folders', locks: [['status', L.status], ['content-type', L.ct]] },
  { name: 'eagle-tags-502', group: 'eagle', method: 'GET', path: '/api/mivo/eagle/tags', locks: [['status', L.status], ['content-type', L.ct]] },
  { name: 'eagle-assets-502', group: 'eagle', method: 'GET', path: '/api/mivo/eagle/assets', locks: [['status', L.status], ['content-type', L.ct]] },
  { name: 'eagle-assets-file-404', group: 'eagle', method: 'GET', path: '/api/mivo/eagle/assets/any-id/file', locks: [['status', L.status], ['content-type', L.ct], ['body', L.bodyExact]] },
  { name: 'eagle-assets-thumbnail-svg-fallback', group: 'eagle', method: 'GET', path: '/api/mivo/eagle/assets/any-id/thumbnail', locks: [['status', L.status], ['content-type', L.ct]] },
  // pinterest
  { name: 'pinterest-status-200', group: 'pinterest', method: 'GET', path: '/api/mivo/pinterest/status', locks: [['status', L.status], ['body', L.bodyExact]] },
  { name: 'pinterest-status-post-200', group: 'pinterest', method: 'POST', path: '/api/mivo/pinterest/status', locks: [['status', L.status], ['body', L.bodyExact]] },
]

// Intended changes: per scenario, the BFF expectation that intentionally differs
// from the dev baseline. Verified against the live response; if it does NOT match,
// the diff is UNEXPECTED (the intended change was not implemented correctly).
const INTENDED = {
  'debug-logs-post-413': {
    id: 'D1',
    class: 'intentionalChange',
    note: 'clean 413 vs dev ECONNRESET',
    allowedDiffs: ['status'],
    match: (live) => live.response.status === 413,
  },
  'generate-413': {
    id: 'D1',
    class: 'intentionalChange',
    note: 'clean 413 vs dev ECONNRESET',
    allowedDiffs: ['status'],
    match: (live) => live.response.status === 413,
  },
  'edit-413': {
    id: 'D1',
    class: 'intentionalChange',
    note: 'clean 413 vs dev ECONNRESET',
    allowedDiffs: ['status'],
    match: (live) => live.response.status === 413,
  },
  'local-assets-file-403-traversal': {
    id: 'D3',
    class: 'frameworkDiff',
    note: '@hono/node-server forces text/plain on header-less 403',
    allowedDiffs: ['content-type'],
    match: (live) => live.response.status === 403 && L.ct(live) === 'text/plain; charset=UTF-8',
  },
  'local-assets-file-404': {
    id: 'D3',
    class: 'frameworkDiff',
    note: '@hono/node-server forces text/plain on header-less 404',
    allowedDiffs: ['content-type'],
    match: (live) => live.response.status === 404 && L.ct(live) === 'text/plain; charset=UTF-8',
  },
  'eagle-folders-502': {
    id: 'D4',
    class: 'frameworkDiff',
    note: '@hono/node-server forces text/plain on header-less 502',
    allowedDiffs: ['content-type'],
    match: (live) => live.response.status === 502 && L.ct(live) === 'text/plain; charset=UTF-8',
  },
  'eagle-tags-502': {
    id: 'D4',
    class: 'frameworkDiff',
    note: '@hono/node-server forces text/plain on header-less 502',
    allowedDiffs: ['content-type'],
    match: (live) => live.response.status === 502 && L.ct(live) === 'text/plain; charset=UTF-8',
  },
  'eagle-assets-502': {
    id: 'D4',
    class: 'frameworkDiff',
    note: '@hono/node-server forces text/plain on header-less 502',
    allowedDiffs: ['content-type'],
    match: (live) => live.response.status === 502 && L.ct(live) === 'text/plain; charset=UTF-8',
  },
  'eagle-assets-file-404': {
    id: 'D4',
    class: 'frameworkDiff',
    note: '@hono/node-server forces text/plain on header-less 404',
    allowedDiffs: ['content-type'],
    match: (live) => live.response.status === 404 && L.ct(live) === 'text/plain; charset=UTF-8',
  },
}

// ─── Live request + capture-shaped response ──────────────────────────────────
const execFetch = async (base, s) => {
  const path = typeof s.path === 'function' ? await s.path(base) : s.path
  const init = { method: s.method, headers: { connection: 'close', ...(s.headers || {}) } }
  if (s.body !== undefined) {
    init.body = s.body
    if (s.ct) init.headers['content-type'] = s.ct
  }
  try {
    const res = await fetch(base + path, init)
    const text = await res.text()
    let body = null
    try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
    return { response: { status: res.status, headers: { 'content-type': res.headers.get('content-type'), 'cache-control': res.headers.get('cache-control') }, body } }
  } catch (err) {
    const e = err.cause?.code || err.cause?.message || err.message
    return { response: { transportError: e } }
  }
}

// ─── Diff ────────────────────────────────────────────────────────────────────
const diffScenario = (live, baseline, s) => {
  const diffs = []
  for (const [label, getter] of s.locks) {
    const lv = getter(live)
    const bv = getter(baseline)
    if (lv !== bv) diffs.push({ label, baseline: bv, live: lv })
  }
  return diffs
}

// ─── Dev server (target=dev) ─────────────────────────────────────────────────
const startDev = async () => {
  const assetDir = await mkdtemp(join(tmpdir(), 'mivo-diff-assets-'))
  const debugLogDir = await mkdtemp(join(tmpdir(), 'mivo-diff-logs-'))
  await writeFile(join(assetDir, 'test.svg'), SVG, 'utf8')
  process.env.MIVO_ASSET_DIR = assetDir
  process.env.MIVO_DEBUG_LOG_DIR = debugLogDir
  process.env.MIVO_DEBUG_VIEW_TOKEN = debugToken
  process.env.MIVO_EAGLE_API_URL = 'http://127.0.0.1:59999'
  const server = await createServer({ root: WORKTREE, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' }, appType: 'custom' })
  await server.listen()
  const port = server.httpServer.address().port
  return { base: `http://127.0.0.1:${port}`, server, assetDir, debugLogDir }
}

// ─── Main ────────────────────────────────────────────────────────────────────
const main = async () => {
  const captures = await loadCaptures()
  let devCtx = null
  let base
  if (IS_DEV) {
    devCtx = await startDev()
    base = devCtx.base
    console.log(`contract:diff target=dev (vite dev at ${base})`)
  } else {
    base = TARGET_ARG
    console.log(`contract:diff target=${base}${GROUP ? ` group=${GROUP}` : ''}`)
  }
  console.log('')

  const scenarios = SCENARIOS.filter((s) => !GROUP || s.group === GROUP)
  let match = 0, intended = 0, unexpected = 0

  for (const s of scenarios) {
    const baseline = captures.get(s.name)
    if (!baseline) {
      console.log(`  ✗ ${s.name}  NO BASELINE CAPTURE`)
      unexpected++
      continue
    }
    const live = await execFetch(base, s)
    const diffs = diffScenario(live, baseline, s)
    const intendedEntry = !IS_DEV ? INTENDED[s.name] : undefined

    if (diffs.length === 0) {
      console.log(`  ✓ ${s.name.padEnd(34)} diff=0`)
      match++
      continue
    }
    if (intendedEntry) {
      // Verify the live matches the intended expectation.
      const liveStatus = live.response.status
      const onlyAllowedDiffs = diffs.every((d) => intendedEntry.allowedDiffs.includes(d.label))
      if (onlyAllowedDiffs && intendedEntry.match(live)) {
        console.log(`  ~ ${s.name.padEnd(34)} INTENDED ${intendedEntry.id} (${intendedEntry.class}): ${intendedEntry.note}`)
        intended++
      } else {
        const got = liveStatus ?? `transport:${live.response.transportError}`
        console.log(`  ✗ ${s.name.padEnd(34)} UNEXPECTED (intended ${intendedEntry.id} not met; got ${got})`)
        for (const d of diffs) console.log(`      ${d.label}: baseline=${d.baseline} live=${d.live}`)
        unexpected++
      }
      continue
    }
    console.log(`  ✗ ${s.name.padEnd(34)} DIFFERS`)
    for (const d of diffs) console.log(`      ${d.label}: baseline=${d.baseline} live=${d.live}`)
    unexpected++
  }

  if (devCtx) {
    await devCtx.server.close()
    await rm(devCtx.assetDir, { recursive: true, force: true })
    await rm(devCtx.debugLogDir, { recursive: true, force: true })
  }

  console.log(`\nSummary: ${match} match, ${intended} intended, ${unexpected} unexpected diff`)
  process.exit(unexpected > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('contract:diff failed:', err)
  process.exit(2)
})
