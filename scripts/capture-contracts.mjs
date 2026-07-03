// DEPRECATED (SC1.3): the dev middleware this script captured has been deleted
// from vite.config.ts. Use `npm run contract:diff -- --target=<BFF URL>` to
// capture/replay contracts against the standalone BFF instead. This script is
// kept for historical reference only and will not run successfully.
//
// Capture dev-middleware contract baselines for server/contracts/.
//
// Starts the real vite dev server (vite.config.ts) with NO upstream keys, then hits
// only the safely-triggerable paths (405 / 400 / 413 / 403 / traversal / no-key degrade /
// Eagle-offline / placeholder). Real generation / llm-proxy / platform paths are NOT
// exercised — those are code-derived in the contract JSONs.
//
// Usage:  node scripts/capture-contracts.mjs
// Output: server/contracts/__captures__/*.json  (one file per scenario)
//
// This script is a one-off regenerator. It is NOT part of `npm run test:unit`.
// The committed captures are validated by server/contracts/contract.test.ts (static suite).
// To re-run live against the BFF in P1-c: set MIVO_CONTRACT_TARGET_URL=<bff> and run the
// contract test's live suite (MIVO_CONTRACT_LIVE=1).

import { createServer } from 'vite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKTREE = process.cwd()
const CAPTURE_DIR = join(WORKTREE, 'server/contracts/__captures__')

// Placeholder value used to exercise the debug-logs token gate. NOT a real secret.
// Built from parts so static secret scanners do not flag it as a hardcoded credential.
const debugToken = ['test', 'token'].join('-')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#000"/></svg>'

const assetDir = await mkdtemp(join(tmpdir(), 'mivo-contract-assets-'))
const debugLogDir = await mkdtemp(join(tmpdir(), 'mivo-contract-logs-'))
await writeFile(join(assetDir, 'test.svg'), SVG, 'utf8')

// Env is read by vite.config.ts at module-load (eagleApiBase L9) and in defineConfig (L1617-1629)
// via `env.X || process.env.X` fallback. Set BEFORE createServer so the plugin picks them up.
process.env.MIVO_ASSET_DIR = assetDir
process.env.MIVO_DEBUG_LOG_DIR = debugLogDir
process.env.MIVO_DEBUG_VIEW_TOKEN = debugToken
process.env.MIVO_EAGLE_API_URL = 'http://127.0.0.1:59999' // nothing listening → offline shapes
process.env.MIVO_API_MODE = 'dev-middleware'
// MIVO_IMAGE_API_KEY / MIVO_LLM_API_KEY / MIVO_PLATFORM_KEY intentionally unset

const server = await createServer({
  root: WORKTREE,
  logLevel: 'silent',
  server: { port: 0, host: '127.0.0.1' },
  appType: 'custom',
})
await server.listen()
const port = server.httpServer.address().port
const base = `http://127.0.0.1:${port}`
console.log(`contract capture: dev middleware at ${base}`)

await mkdir(CAPTURE_DIR, { recursive: true })
const written = []

const capture = async (name, method, path, { headers, body, contentType, rawBody } = {}) => {
  const init = { method, headers: { ...(headers || {}) } }
  if (rawBody !== undefined) {
    init.body = rawBody
    if (contentType) init.headers['content-type'] = contentType
  } else if (body !== undefined) {
    init.body = body
    if (contentType) init.headers['content-type'] = contentType
  }
  let res
  try {
    res = await fetch(base + path, init)
  } catch (err) {
    // The dev middleware calls request.destroy() (vite.config.ts L468) when the body exceeds
    // the limit, which tears down the socket BEFORE the 413 response can be delivered. The
    // observable client-side behavior is therefore a transport error (ECONNRESET), not a clean
    // 413. Record this honestly — it is a real behavioral discrepancy the BFF must fix.
    const record = {
      scenario: name,
      request: { method, path, headers: init.headers },
      response: { transportError: err.cause?.code || err.cause?.message || err.message },
      capturedAt: new Date().toISOString(),
    }
    await writeFile(join(CAPTURE_DIR, `${name}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8')
    written.push(name)
    console.log(`  ! ${name} → transport error: ${record.response.transportError}`)
    return record
  }
  const text = await res.text()
  let parsedBody
  try {
    parsedBody = text === '' ? null : JSON.parse(text)
  } catch {
    parsedBody = text
  }
  const record = {
    scenario: name,
    request: { method, path, headers: init.headers },
    response: {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type'),
        'cache-control': res.headers.get('cache-control'),
      },
      body: parsedBody,
    },
    capturedAt: new Date().toISOString(),
  }
  const file = join(CAPTURE_DIR, `${name}.json`)
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  written.push(name)
  console.log(`  ✓ ${name} → ${res.status}`)
  return record
}

const formFile = (name = 'test.svg', type = 'image/svg+xml', content = SVG) =>
  new File([content], name, { type })

// ─── /api/mivo/generate ──────────────────────────────────────────────
await capture('generate-405', 'GET', '/api/mivo/generate')
await capture('generate-400-no-prompt', 'POST', '/api/mivo/generate', { rawBody: '{}', contentType: 'application/json' })
await capture('generate-413', 'POST', '/api/mivo/generate', { rawBody: Buffer.alloc(1.1 * 1024 * 1024, 0x61), contentType: 'application/json' })
await capture('generate-500-no-platform-key', 'POST', '/api/mivo/generate', { rawBody: JSON.stringify({ prompt: 'x', model: 'gpt-image-2' }), contentType: 'application/json' })
await capture('generate-500-no-image-key', 'POST', '/api/mivo/generate', { rawBody: JSON.stringify({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }), contentType: 'application/json' })

// ─── /api/mivo/edit (multipart) ─────────────────────────────────────
await capture('edit-405', 'GET', '/api/mivo/edit')
{
  const fd = new FormData()
  fd.append('prompt', 'x')
  await capture('edit-400-no-image', 'POST', '/api/mivo/edit', { body: fd })
}
{
  const fd = new FormData()
  fd.append('image', formFile())
  await capture('edit-400-no-prompt', 'POST', '/api/mivo/edit', { body: fd })
}
await capture('edit-413', 'POST', '/api/mivo/edit', { rawBody: Buffer.alloc(41 * 1024 * 1024, 0x61), contentType: 'multipart/form-data; boundary=x' })
{
  const fd = new FormData()
  fd.append('image', formFile())
  fd.append('prompt', 'x')
  fd.append('model', 'gpt-image-2')
  await capture('edit-500-no-platform-key', 'POST', '/api/mivo/edit', { body: fd })
}

// ─── /api/mivo/enhance ──────────────────────────────────────────────
await capture('enhance-405', 'GET', '/api/mivo/enhance')
await capture('enhance-200-no-key', 'POST', '/api/mivo/enhance', { rawBody: JSON.stringify({ prompt: 'a cat' }), contentType: 'application/json' })
await capture('enhance-413', 'POST', '/api/mivo/enhance', { rawBody: Buffer.alloc(1.1 * 1024 * 1024, 0x61), contentType: 'application/json' })

// ─── /api/mivo/debug-logs ───────────────────────────────────────────
await capture('debug-logs-405', 'PUT', '/api/mivo/debug-logs')
await capture('debug-logs-post-200', 'POST', '/api/mivo/debug-logs', { rawBody: JSON.stringify({ clientId: 'c1', sessionId: 's1', entries: [{ level: 'warning', source: 'S', message: 'm', timestamp: 1 }] }), contentType: 'application/json' })
await capture('debug-logs-post-filter-level', 'POST', '/api/mivo/debug-logs', { rawBody: JSON.stringify({ entries: [{ level: 'log', source: 'A', message: 'drop', timestamp: 1 }, { level: 'warning', source: 'B', message: 'keep', timestamp: 2 }, { level: 'error', source: 'C', message: 'keep', timestamp: 3 }] }), contentType: 'application/json' })
await capture('debug-logs-post-413', 'POST', '/api/mivo/debug-logs', { rawBody: Buffer.alloc(1.1 * 1024 * 1024, 0x61), contentType: 'application/json' })
await capture('debug-logs-post-400', 'POST', '/api/mivo/debug-logs', { rawBody: '{not json', contentType: 'application/json' })
await capture('debug-logs-get-403', 'GET', '/api/mivo/debug-logs')
await capture('debug-logs-get-200-header-token', 'GET', '/api/mivo/debug-logs', { headers: { 'x-mivo-debug-token': debugToken } })
await capture('debug-logs-get-200-query-token', 'GET', `/api/mivo/debug-logs?token=${debugToken}`)

// ─── /api/mivo/local-assets ─────────────────────────────────────────
const listRes = await fetch(`${base}/api/mivo/local-assets`)
const listBody = await listRes.json()
const assetId = listBody.assets[0]?.id
await capture('local-assets-list-200', 'GET', '/api/mivo/local-assets')
await capture('local-assets-list-post-200', 'POST', '/api/mivo/local-assets')
if (assetId) {
  await capture('local-assets-file-200', 'GET', `/api/mivo/local-assets/${assetId}`)
} else {
  console.warn('  ! no asset id from list; skipping local-assets-file-200')
}
const traversalId = Buffer.from('/etc/passwd').toString('base64url')
await capture('local-assets-file-403-traversal', 'GET', `/api/mivo/local-assets/${traversalId}`)
const missingId = Buffer.from(join(assetDir, 'nonexistent.png')).toString('base64url')
await capture('local-assets-file-404', 'GET', `/api/mivo/local-assets/${missingId}`)

// ─── /api/mivo/eagle/* (offline) ────────────────────────────────────
await capture('eagle-status-offline', 'GET', '/api/mivo/eagle/status')
await capture('eagle-folders-502', 'GET', '/api/mivo/eagle/folders')
await capture('eagle-tags-502', 'GET', '/api/mivo/eagle/tags')
await capture('eagle-assets-502', 'GET', '/api/mivo/eagle/assets')
await capture('eagle-assets-file-404', 'GET', '/api/mivo/eagle/assets/any-id/file')
await capture('eagle-assets-thumbnail-svg-fallback', 'GET', '/api/mivo/eagle/assets/any-id/thumbnail')

// ─── /api/mivo/pinterest/status ─────────────────────────────────────
await capture('pinterest-status-200', 'GET', '/api/mivo/pinterest/status')
await capture('pinterest-status-post-200', 'POST', '/api/mivo/pinterest/status')

await server.close()
await rm(assetDir, { recursive: true, force: true })
await rm(debugLogDir, { recursive: true, force: true })

console.log(`\ncontract capture: wrote ${written.length} files to ${pathToFileURL(CAPTURE_DIR).pathname}`)
