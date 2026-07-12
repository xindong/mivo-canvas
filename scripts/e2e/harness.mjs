import { spawn, spawnSync, execSync } from 'node:child_process'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
import { attachDefaultMivoApiMocks } from './api-mocks.mjs'

export const createBaseUrl = (port) => `http://127.0.0.1:${port}`

// FU4-2: IndexedDB-backed persist helpers. The app's two stores (canvas + chat) now
// persist to IDB ('mivo-canvas-persist' / 'kv'), so e2e scenarios that read/write the
// persisted state or clear storage between scenarios must go through IDB, not
// localStorage. These helpers open their own short-lived connection (coexists with
// the app's long-lived one) and clear/Read/write the KV store. deleteDatabase is NOT
// used because the app's open connection blocks it.
//
// NOTE: page.evaluate callbacks run in the BROWSER, so they cannot reference Node-side
// closures (IDB_NAME/IDB_STORE). The DB + store names are inlined as string literals
// inside each evaluate body. Keep them in sync if they ever change.

/**
 * Clear all persist storage: localStorage + sessionStorage (migration markers) +
 * the IDB KV store. Safe to call while the app has an open IDB connection (uses a
 * readwrite clear, NOT deleteDatabase). Runs in-page via page.evaluate.
 */
export const clearAllStorage = async (page) => {
  await page.evaluate(async () => {
    try { localStorage.clear() } catch { /* opaque origin */ }
    try { sessionStorage.clear() } catch { /* opaque origin */ }
    try {
      await new Promise((resolve) => {
        const req = indexedDB.open('mivo-canvas-persist', 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('kv')) {
            req.result.createObjectStore('kv', { keyPath: 'key' })
          }
        }
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(); return }
          try {
            const tx = db.transaction('kv', 'readwrite')
            tx.objectStore('kv').clear()
            tx.oncomplete = () => { db.close(); resolve() }
            tx.onerror = () => { db.close(); resolve() }
          } catch {
            db.close()
            resolve()
          }
        }
        req.onerror = () => resolve()
      })
    } catch {
      // IDB unavailable — nothing to clear
    }
  })
}

// FX-6 (#183): the app namespaces its IDB persist keys by the current auth
// userId — anonymous → raw `name`; authenticated → `name:<userId>`. The e2e dev
// topology turns the auth dev stub ON (harness.startSmokeBffServer sets
// MIVO_DEV_AUTH_STUB=1, dev stub /api/auth/me returns username `dev@local`),
// so canvasStore/chatStore persist under `mivo-canvas-demo:dev@local` /
// `mivo-chat-demo:dev@local`, NOT the raw names the scenarios pass in. Before
// this fix the harness read the raw key and found nothing (chat-generation,
// mask-cross-scene, mask-hydration all timed out on persist assertions) even
// though the app had written the data — under the namespaced key.
//
// Resolve the logical name through the app's OWN `namespacedKey` so the harness
// reads/writes the same physical key the app uses (single source of truth:
// anonymous → raw, authenticated → namespaced, no hard-coded userId). Falls back
// to the raw name when the module isn't reachable — a fresh page before the app
// hydrates, or a non-app context — in which case the app's
// `migrateToNamespaced` claims the legacy raw key on its first authenticated
// read (the migration scenario's v1-inject path still works).
const resolvePersistKey = async (page, name) => {
  try {
    return await page.evaluate(async (logical) => {
      try {
        const mod = await import('/src/lib/persistUserId.ts')
        if (mod && typeof mod.namespacedKey === 'function') return mod.namespacedKey(logical)
      } catch {
        // module not yet served (pre-hydration) or page is not the app — caller
        // falls back to the raw name; migrateToNamespaced handles legacy claims.
      }
      return logical
    }, name)
  } catch {
    return name
  }
}

/** Read a persisted KV value (the raw JSON string zustand persist stored). */
export const readPersistedKv = async (page, key) => {
  const physical = await resolvePersistKey(page, key)
  return page.evaluate(async (k) => {
    return new Promise((resolve) => {
      const req = indexedDB.open('mivo-canvas-persist', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv', { keyPath: 'key' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(null); return }
        try {
          const tx = db.transaction('kv', 'readonly')
          const getReq = tx.objectStore('kv').get(k)
          getReq.onsuccess = () => resolve(getReq.result ? getReq.result.value : null)
          tx.oncomplete = () => db.close()
          tx.onerror = () => { db.close(); resolve(null) }
        } catch {
          db.close()
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    })
  }, physical)
}

/** Write a persisted KV value (put upsert). Used by the migration scenario to inject
 *  legacy v1 state before the app rehydrates from IDB. Writes the RAW logical name
 *  (NOT namespaced) on purpose: legacy injection simulates a pre-FX-6 session whose
 *  state lived under the un-suffixed key, and the app's `migrateToNamespaced` claims
 *  it on first authenticated read. Resolving through `namespacedKey` here would race
 *  with the chat store's own async write to the namespaced key and clobber v1. */
export const writePersistedKv = async (page, key, value) => {
  await page.evaluate(async ({ k, v }) => {
    return new Promise((resolve) => {
      const req = indexedDB.open('mivo-canvas-persist', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv', { keyPath: 'key' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(); return }
        try {
          const tx = db.transaction('kv', 'readwrite')
          tx.objectStore('kv').put({ key: k, value: v })
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => { db.close(); resolve() }
        } catch {
          db.close()
          resolve()
        }
      }
      req.onerror = () => resolve()
    })
  }, { k: key, v: value })
}

/** Poll readPersistedKv until predicate(rawString) returns true or timeout. Used for
 *  persist checks where the IDB write is async (zustand persist fire-and-forgets the
 *  setItem promise, so the read might lag the state change). */
export const waitForPersistedKv = async (page, key, predicate, { timeout = 2000, interval = 50 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const raw = await readPersistedKv(page, key)
    if (raw !== null && predicate(raw)) return raw
    await new Promise((r) => setTimeout(r, interval))
  }
  return readPersistedKv(page, key)
}

// killStaleDevServer: detect and kill leftover dev/bff servers from a prior failed
// e2e run *within the current worker's port-base segment only*. A stale dev/bff server
// keeps the old debug log dir and breaks --strictPort restarts.
//
// 多 worker 并行隔离:每个 worker 用不同的 MIVO_E2E_PORT_BASE(见 e2e-runner.mjs)。
// 这里只清自己 base 段 [base, base+SEGMENT_SIZE) 内残留的端口,不会误杀别的 worker 的
// dev server。dev port=base+index*10+attempt,bff=dev+1,单次 run 实际只用其中 2 个端口,
// 但前次失败可能残留 attempt 偏移或 bff 端口,所以遍历整个段兜底。
const SEGMENT_SIZE = 50
const killStaleDevServer = (port) => {
  const base = Number(process.env.MIVO_E2E_PORT_BASE ?? port)
  // 防御:若显式传入的 port 不在自己 base 段内(配置错误),只杀该 port 不展开范围,
  // 避免误杀。正常情况下 port = base + index*10 + attempt 必然落在段内。
  const inSegment = port >= base && port < base + SEGMENT_SIZE
  const targets = inSegment
    ? Array.from({ length: SEGMENT_SIZE }, (_, i) => base + i)
    : [port]
  try {
    const pids = execSync(`lsof -ti:${targets.join(',')} 2>/dev/null || true`, { encoding: 'utf8' }).trim()
    if (!pids) return
    console.warn(`[harness] killing stale dev/bff servers in base range [${base}, ${base + SEGMENT_SIZE}) (pids: ${pids.replace(/\n/g, ' ')})`)
    execSync(`kill ${pids.replace(/\n/g, ' ')} 2>/dev/null || true`, { stdio: 'ignore' })
  } catch {
    // lsof/kill unavailable - skip; --strictPort will fail visibly if occupied.
  }
}

const localBin = (name) =>
  path.resolve('node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

const e2eBridgeModules = {
  canvasStore: [
    "const bridge = globalThis.__MIVO_E2E__",
    "if (!bridge?.useCanvasStore) throw new Error('Missing E2E store bridge: useCanvasStore')",
    'export const useCanvasStore = bridge.useCanvasStore',
  ].join('\n'),
  chatStore: [
    "const bridge = globalThis.__MIVO_E2E__",
    "if (!bridge?.useChatStore) throw new Error('Missing E2E store bridge: useChatStore')",
    'export const useChatStore = bridge.useChatStore',
  ].join('\n'),
}

export const installE2EStoreBridge = async (context) => {
  await context.addInitScript(() => {
    window.__MIVO_E2E_ENABLED__ = true
  })
  await context.route('**/src/store/canvasStore.ts*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      headers: { 'cache-control': 'no-store' },
      body: e2eBridgeModules.canvasStore,
    })
  })
  await context.route('**/src/store/chatStore.ts*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      headers: { 'cache-control': 'no-store' },
      body: e2eBridgeModules.chatStore,
    })
  })
}

export const prepareSmokeArtifacts = async () => {
  await mkdir('test-artifacts', { recursive: true })
  await rm(path.resolve('test-artifacts/debug-logs'), { recursive: true, force: true })
}

export const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output)
        return
      }

      reject(new Error(`${command} ${args.join(' ')} failed with ${code}\n${output}`))
    })
  })

const spawnBackgroundProcess = (command, args, options) => {
  const child = spawn(command, args, options)
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk)
  })
  return child
}

export const startSmokeDevServer = ({ port, localAssetFixtureDir, eagleMockPort, bffPort }) => {
  killStaleDevServer(port)
  return spawnBackgroundProcess(localBin('vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_PORT: String(bffPort),
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
      // P2-C1b: fast task polling so the progressive /tasks/:id mock (10→30→60→
      // done) completes in ~150ms instead of 3s, keeping chat-generation fast.
      VITE_MIVO_TASK_POLL_INTERVAL_MS: '50',
    },
  })
}

export const startSmokeBffServer = ({
  port,
  localAssetFixtureDir,
  eagleMockPort,
  upstreamBaseUrl,
  debugViewToken,
  enableLocalAssets,
  enableEagleProxy,
  isPublic = true,
}) =>
  spawnBackgroundProcess(localBin('tsx'), ['server/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_PORT: String(port),
      // P1-b: dev stub is now opt-in (MIVO_DEV_AUTH_STUB=1 && non-prod && non-public).
      // e2e local topology (isPublic=false) needs the stub ON so /api/auth/me returns
      // the fake logged-in user for auto-prompt/userchip scenarios. Under isPublic=true
      // (MIVO_PUBLIC=1) the stub is force-off regardless — harmless there.
      MIVO_DEV_AUTH_STUB: '1',
      ...(isPublic ? { MIVO_PUBLIC: '1' } : {}),
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
      MIVO_DEBUG_VIEW_TOKEN: debugViewToken,
      MIVO_IMAGE_API_KEY: process.env.MIVO_IMAGE_API_KEY || 'sk_test',
      MIVO_LLM_API_KEY: process.env.MIVO_LLM_API_KEY || process.env.MIVO_IMAGE_API_KEY || 'sk_test',
      MIVO_ENABLE_LOCAL_ASSETS: enableLocalAssets ? '1' : '0',
      MIVO_ENABLE_EAGLE_PROXY: enableEagleProxy ? '1' : '0',
      ...(upstreamBaseUrl
        ? {
            MIVO_IMAGE_API_BASE: `${upstreamBaseUrl}/v1/images`,
            MIVO_LLM_API_BASE: `${upstreamBaseUrl}/v1`,
          }
        : {}),
    },
  })

const killChildTree = (proc, signal) => {
  if (!proc?.pid || process.platform === 'win32') return
  spawnSync('pkill', [`-${signal}`, '-P', String(proc.pid)], { stdio: 'ignore' })
}

const stopProcess = async (proc) => {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolve) => {
    const finish = () => resolve(null)
    const forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          killChildTree(proc, 'KILL')
          proc.kill('SIGKILL')
        } catch {
          finish()
        }
      }
    }, 2000)

    proc.once('close', () => {
      clearTimeout(forceKillTimer)
      finish()
    })
    try {
      killChildTree(proc, 'TERM')
      proc.kill('SIGTERM')
    } catch {
      finish()
    }
  })
}

export const stopSmokeDevServer = async (server) => {
  if (!server) return
  if (server.bff || server.dev) {
    await Promise.all([stopProcess(server.bff), stopProcess(server.dev)])
    return
  }
  await stopProcess(server)
}

export const createSmokePage = async ({
  baseUrl,
  generatedImageB64,
  extraHTTPHeaders,
  enableStoreBridgeModules = false,
  enableApiRouteMocks = true,
  mockAuthMe = false,
}) => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1512, height: 900 },
    deviceScaleFactor: 1,
    extraHTTPHeaders,
  })
  if (enableStoreBridgeModules) {
    await installE2EStoreBridge(context)
  }
  // feat/auth-sso: dev stub returns logged-in + fresh IDB has no keys → AutoPrompt
  // would auto-open the settings panel on every scenario's first load, intercepting
  // clicks. Default-suppress here (all scenarios). The auto-prompt-settings scenario
  // opts back in by setting the flag false via its own addInitScript (runs after, wins).
  await context.addInitScript(() => {
    window.__MIVO_E2E_DISABLE_AUTO_PROMPT__ = true
  })
  const page = await context.newPage()

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })

  const errors = []
  const mivoEditRequests = []

  if (enableApiRouteMocks) {
    await attachDefaultMivoApiMocks(page, { generatedImageB64, mivoEditRequests })
  }

  // feat/auth-sso: prod 拓扑 MIVO_PUBLIC=1 → dev 桩硬关 → BFF /api/auth/me 返 401。
  // 浏览器 console 会把 401 当 "Failed to load resource" 错误报出,触发 console-error
  // guard。prod e2e 代表"无 SSO 会话的未登录态",mock /api/auth/me → 200
  // {authenticated:false}(对齐 auto-prompt-settings Flow 2 既有做法)避免 401 console
  // 污染;fetchMe 见 200+authenticated=false → 未登录(不抛)。dev 拓扑用真 dev 桩 200,
  // 不 mock。assertPublicModeSecurity 走 Node fetch 不经浏览器 route,仍验真 401。
  if (mockAuthMe) {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false, detail: 'Not authenticated' }),
      }),
    )
  }

  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('__MIVO_E2E_EXPECTED_ERROR__')) errors.push(message.text())
  })

  // 浏览器未捕获异常转 stdout(只诊断,不进 errors 数组不阻断 run),便于 e2e 失败时定位。
  page.on('pageerror', (error) => {
    console.log(`[browser pageerror] ${error.message}`)
  })

  return {
    browser,
    context,
    errors,
    mivoEditRequests,
    page,
  }
}
