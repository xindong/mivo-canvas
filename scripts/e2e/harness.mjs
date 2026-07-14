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
// Resolve the logical name through the app's OWN persist user id so the harness
// reads/writes the same physical key the app uses (single source of truth:
// anonymous → raw, authenticated → namespaced, no hard-coded userId). The user
// id is read from the `__MIVO_E2E__` bridge (populated by main.tsx in BOTH dev
// and prod topologies); the namespacing rule is replicated here on the Node
// side. mainfix R3: the previous browser-side `import('/src/lib/persistUserId.ts')`
// worked in dev (vite serves /src) but under prod's static dist server /src has
// no file → 404 fallback returned index.html → the browser logged "Failed to
// load module script: MIME text/html" — the try/catch DID catch the promise
// rejection and fell back to the raw name, but the browser had ALREADY emitted
// the MIME console error before the catch ran, which the e2e-smoke console-error
// guard collected → gated chat-generation red in prod (dev served /src so no
// error). Reading the bridge global involves NO /src module fetch, so no MIME
// error in either topology. Falls back to the raw name when the bridge isn't
// reachable — a fresh page before the app hydrates, or a non-app context — in
// which case the app's `migrateToNamespaced` claims the legacy raw key on its
// first authenticated read (the migration scenario's v1-inject path still works).
// resolvePersistKey: resolve the physical IDB key the app uses for a logical persist
// name. Two paths, both single-sourced through the app's __MIVO_E2E__ bridge so the
// harness never hardcodes the userId, the kernel flag, or the v11 split-key layout:
//
//  - No `domain` (default): chat / settings / legacy canvas single-blob → the FX-6
//    name:uid namespacing (anonymous → raw name). Unchanged from mainfix R3.
//  - `domain: 'document' | 'session'`: the canvas persist DOCUMENT/SESSION domains.
//    Under kernel=new the app (docKernelPersistAdapter) writes canvas state to the
//    SPLIT keys `name:uid:document` / `name:uid:session`, NOT the legacy single-blob
//    `name:uid` key. The harness asks the bridge's getCanvasPersistDocumentKey/
//    SessionKey (which route through the app's OWN namespacedKey + the adapter's
//    documentKey/sessionKey) for the physical key — so the harness reads the SAME key
//    the app writes under EITHER kernel. Under kernel=legacy the bridge returns the
//    single-blob key (canvases always lived there), so domain-aware reads are
//    kernel-agnostic and legacy has zero behaviour change.
//
//    This fixed mask-hydration SC-15, which was stable-red under kernel=new because
//    the pre-reload canvas assertion read the legacy single-blob key while the app
//    had durably persisted the generating ai-slot to the :document split key (proven
//    via a runtime IDB getAll dump: the :document key held the generating slot, the
//    legacy single-blob key was absent). The chat assertion was unaffected (chat uses
//    idbStateStorage = single-blob under both kernels, correctly resolved by the
//    no-domain path).
//
//  Failure semantics (SC-15 R2 P2): the NO-domain path keeps the broad-catch legacy
//  fallback to the raw name (chat/settings/anonymous/pre-hydrate — these callers passed
//  no domain, so degrading to the raw name IS the documented legacy behaviour, not a
//  silent split-key mismatch). The DOMAIN path is FAIL-CLOSED: it validates the domain
//  enum, requires the bridge + matching getter, and propagates any evaluate exception
//  with cause. A split-key probe must never silently read a stale blob off the wrong
//  physical key (false green) or mask a product persistence bug as a probe timeout
//  (misleading red) — the silent-failure family this round eliminates. The app's
//  migrateToNamespaced still claims the legacy raw key on its first authenticated read
//  in the no-domain fallback case.
export const resolvePersistKey = async (page, name, { domain } = {}) => {
  // No `domain` (default): chat / settings / legacy canvas single-blob. This compat
  // path is UNCHANGED from mainfix R3 — the broad catch stays here on purpose. These
  // callers passed no domain, so a resolver failure degrading to the raw name is the
  // documented legacy semantics (the app's migrateToNamespaced then claims the legacy
  // raw key on its first authenticated read), NOT a silent split-key mismatch.
  if (domain === undefined) {
    try {
      return await page.evaluate(({ n }) => {
        const bridge = globalThis.__MIVO_E2E__
        const uid = bridge && typeof bridge.getPersistUserId === 'function' ? bridge.getPersistUserId() : null
        return uid && uid !== 'anonymous' ? `${n}:${uid}` : n
      }, { n: name })
    } catch {
      return name
    }
  }

  // domain-explicit path — FAIL-CLOSED (SC-15 R2 P2). page.evaluate takes EXACTLY ONE
  // arg, so name + domain are wrapped in an object; Playwright throws "Too many
  // arguments" on >1 trailing arg, which the old broad catch would have swallowed into
  // a raw-name fallback reading the WRONG IDB key. A probe that asked for a canvas split
  // key must NOT silently degrade to a legacy/raw key when the resolver itself is broken:
  // that reads a stale blob on the wrong physical key (false green) or masks a product
  // persistence bug as a probe timeout (misleading red). Validate the domain enum,
  // require the bridge + the matching getter, and propagate any exception with cause.
  if (domain !== 'document' && domain !== 'session') {
    throw new Error(`resolvePersistKey: invalid domain '${String(domain)}' (expected 'document' | 'session')`)
  }
  try {
    return await page.evaluate(({ n, d }) => {
      const bridge = globalThis.__MIVO_E2E__
      if (!bridge) {
        throw new Error(`resolvePersistKey: __MIVO_E2E__ bridge absent (domain='${d}')`)
      }
      const getter = d === 'document' ? bridge.getCanvasPersistDocumentKey : bridge.getCanvasPersistSessionKey
      if (typeof getter !== 'function') {
        const which = d === 'document' ? 'Document' : 'Session'
        throw new Error(`resolvePersistKey: bridge missing getCanvasPersist${which}Key (domain='${d}')`)
      }
      return getter(n)
    }, { n: name, d: domain })
  } catch (err) {
    throw new Error(`resolvePersistKey: domain='${domain}' resolve failed for '${name}'`, { cause: err })
  }
}

/** Read a persisted KV value (the raw JSON string zustand persist stored).
 *  `opts.domain` ('document' | 'session') routes through the kernel-aware split-key
 *  resolver for canvas persist; omit for chat/settings/legacy single-blob. */
export const readPersistedKv = async (page, key, opts = {}) => {
  const physical = await resolvePersistKey(page, key, opts)
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
 *  setItem promise, so the read might lag the state change).
 *
 *  Returns the raw string once predicate(raw) is true, or `null` on timeout. NEVER
 *  returns a non-null blob whose content failed the predicate — that was the SC-15
 *  false-green (a `generating` blob passed an `error`/`failed` predicate check because
 *  callers only did `if (!raw) throw`). Callers must assert predicate semantics, not
 *  just key existence; the honest `null` return forces that. */
export const waitForPersistedKv = async (page, key, predicate, { timeout = 2000, interval = 50, ...keyOpts } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const raw = await readPersistedKv(page, key, keyOpts)
    if (raw !== null && predicate(raw)) return raw
    await new Promise((r) => setTimeout(r, interval))
  }
  // SC-15 R2 (probe honesty): predicate never satisfied within timeout → return null.
  // The previous `return readPersistedKv(page, key)` returned whatever non-null blob
  // lived under the key even when its content failed the predicate — so callers that
  // only checked truthiness passed on a non-empty but semantically WRONG blob. That
  // was exactly the SC-15 false-green that masked the durable-settle bug (a generating
  // blob passed the error/failed assertion). Returning null forces callers to fail
  // loudly when the predicate is never met, instead of silently passing.
  return null
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
  // mainfix R3: the __MIVO_E2E_ENABLED__ flag now lives in createSmokePage (set
  // unconditionally so the bridge populates in dev too, letting resolvePersistKey
  // read getPersistUserId without a /src import). Here we only install the route
  // interception that serves canvasStore/chatStore bridge modules under prod's
  // static dist server (where /src/store/*.ts would otherwise 404).
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

// A2-S4 Block 5 F2: e2e server 档 PG 专用命名(与生产 mivocanvas/mivo 硬区隔)。
// harness 默认库名/用户名硬编码 e2e 专用,不接受 process.env 覆盖 DB 名/用户名
// (MIVO_PG_HOST/PORT/PASSWORD 可覆盖:本地 55443 / CI 5432 / 密码不同;但 DB/USER 硬区隔)。
const E2E_PG_DB = 'mivocanvas_e2e'
const E2E_PG_USER = 'mivo_e2e'
const E2E_PG_PASSWORD_DEFAULT = 'mivo-e2e-test'
const E2E_BASE_CURSOR_SECRET_DEFAULT = 'e2e-basecursor-secret'
const E2E_PLATFORM_KEY_DEFAULT = 'mivo_e2e_persist'
const E2E_RESET_TOKEN_DEFAULT = 'e2e-reset-token'

// F2: server 档 PG fail-fast 白名单校验。harness 启动 BFF 与调 reset 前调用。
// MIVO_PG_HOST 必须 127.0.0.1/localhost(防连生产远程 PG);MIVO_PG_DB 必须 === mivocanvas_e2e
// (与生产名 mivocanvas 硬区隔)。不满足 throw(fail-visible,不静默改写/不连生产)。
// 校验 process.env:若父 shell 设了危险值(如 MIVO_PG_DB=mivocanvas 生产名),直接拒跑。
export const assertE2ePgWhitelist = () => {
  const host = process.env.MIVO_PG_HOST ?? '127.0.0.1'
  const db = process.env.MIVO_PG_DB ?? E2E_PG_DB
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `[e2e F2] MIVO_PG_HOST="${host}" 非 127.0.0.1/localhost(fail-visible,防连生产远程 PG)。` +
      ` server 档只允许本机 PG;用 docker compose -f ops/postgres/docker-compose.e2e.yml 起本地。`,
    )
  }
  if (db !== E2E_PG_DB) {
    throw new Error(
      `[e2e F2] MIVO_PG_DB="${db}" 非 "${E2E_PG_DB}"(fail-visible,防连生产同名库 mivocanvas)。` +
      ` e2e 专用命名与生产硬区隔;本地 PG 库须为 mivocanvas_e2e(重建见 docker-compose.e2e.yml / createdb)。`,
    )
  }
}

// F3: persist/PG/reset 相关 env 键(剥离父 env 串扰)。local/shadow 档 BFF 必须 memory 不连 PG;
// 父 shell 残留 MIVO_PERSIST_BACKEND=pg / MIVO_PG_* / MIVO_E2E_RESET_TOKEN / MIVO_E2E_HARNESS
// 会被 ...process.env 带入 → local/shadow 档误连 PG 或挂载 reset 端点。剥离后按 mode 确定性重注。
const PERSIST_ENV_KEYS = [
  'VITE_MIVO_PERSIST',
  'MIVO_PERSIST_BACKEND',
  'MIVO_PG_HOST', 'MIVO_PG_PORT', 'MIVO_PG_DB', 'MIVO_PG_USER', 'MIVO_PG_PASSWORD',
  'MIVO_PLATFORM_KEY', 'MIVO_E2E_RESET_TOKEN', 'MIVO_E2E_HARNESS', 'MIVO_BASE_CURSOR_SECRET',
]
const stripPersistEnv = (env) => {
  const out = { ...env }
  for (const key of PERSIST_ENV_KEYS) delete out[key]
  return out
}

export const startSmokeDevServer = ({ port, localAssetFixtureDir, eagleMockPort, bffPort, persistMode = 'local' }) => {
  killStaleDevServer(port)
  return spawnBackgroundProcess(localBin('vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...stripPersistEnv(process.env),
      MIVO_PORT: String(bffPort),
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
      // P2-C1b: fast task polling so the progressive /tasks/:id mock (10→30→60→
      // done) completes in ~150ms instead of 3s, keeping chat-generation fast.
      VITE_MIVO_TASK_POLL_INTERVAL_MS: '50',
      // F3: 前端 persist 三态永远显式设(含 local;防父 env 残留 VITE_MIVO_PERSIST=server 串扰 local 档)。
      // persistMode.ts 读 import.meta.env[VITE_MIVO_PERSIST](最高优先级,覆盖 URL ?persist=)。
      VITE_MIVO_PERSIST: persistMode,
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
  persistMode = 'local',
}) => {
  // F2: server 档构造 env 前 fail-fast 白名单校验(防连生产 PG;在 spawn BFF 前)。
  if (persistMode === 'server') assertE2ePgWhitelist()
  return spawnBackgroundProcess(localBin('tsx'), ['server/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...stripPersistEnv(process.env),
      MIVO_PORT: String(port),
      // P1-b: dev stub is now opt-in (MIVO_DEV_AUTH_STUB=1 && non-prod && non-public).
      // e2e local topology (isPublic=false) needs the stub ON so /api/auth/me returns
      // the fake logged-in user for auto-prompt/userchip scenarios. Under isPublic=true
      // (MIVO_PUBLIC=1) the stub is force-off regardless — harmless there.
      MIVO_DEV_AUTH_STUB: '1',
      ...(isPublic ? { MIVO_PUBLIC: '1' } : {}),
      // R5(G2.1 同源三元组安全硬化):生产同源判定需"可信外部 scheme"——直连 prod 拓扑下
      // app 与 BFF 同监听 securityPort,浏览器同源 POST Origin=http://127.0.0.1:port;显式配
      // MIVO_PUBLIC_ORIGIN 让同源 POST 放行(无此配置 → 无法可信判定外部 scheme → fail-closed →
      // debug/canvas-interactions/mask/mask-reflow 4 场景浏览器同源 debugLogger POST 全 403 红回归)。
      // 真实生产部署:网关后由 ops 配 https 的 PUBLIC_ORIGIN(或受信 X-Forwarded-Proto);e2e 直连用 http。
      ...(isPublic ? { MIVO_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` } : {}),
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
      MIVO_DEBUG_VIEW_TOKEN: debugViewToken,
      MIVO_IMAGE_API_KEY: process.env.MIVO_IMAGE_API_KEY || 'sk_test',
      MIVO_LLM_API_KEY: process.env.MIVO_LLM_API_KEY || process.env.MIVO_IMAGE_API_KEY || 'sk_test',
      MIVO_ENABLE_LOCAL_ASSETS: enableLocalAssets ? '1' : '0',
      MIVO_ENABLE_EAGLE_PROXY: enableEagleProxy ? '1' : '0',
      // F3: BaseCursor codec secret(createChild/patchDomainOps 签发 base;baseCursor.ts fail-closed:
      // 无 secret → encodeBase throw → 500)。shadow 双写 + server HTTP 冒烟均触发 encodeBase,所有档总设。
      MIVO_BASE_CURSOR_SECRET: process.env.MIVO_BASE_CURSOR_SECRET ?? E2E_BASE_CURSOR_SECRET_DEFAULT,
      ...(upstreamBaseUrl
        ? {
            MIVO_IMAGE_API_BASE: `${upstreamBaseUrl}/v1/images`,
            MIVO_LLM_API_BASE: `${upstreamBaseUrl}/v1`,
          }
        : {}),
      // F2/F3: persist env 按 mode 确定性构造(stripPersistEnv 已剥父 env 串扰)。
      //  - local/shadow: 显式 BFF memory(不注 PG/reset/sentinel → reset 端点三重保险不挂载)。
      //  - server: 经 F2 白名单 + e2e 专用命名(库/用户硬编码 mivocanvas_e2e/mivo_e2e,与生产硬区隔);
      //    host/port/password 接受 process.env 覆盖(本地 55443 / CI 5432);MIVO_E2E_HARNESS=1 sentinel
      //    让 reset 端点三重保险挂载(app.ts isE2eResetEnabled)。MIVO_PLATFORM_KEY → legacy actor 稳定 owner。
      ...(persistMode === 'server'
        ? {
            MIVO_PERSIST_BACKEND: 'pg',
            MIVO_PG_HOST: process.env.MIVO_PG_HOST ?? '127.0.0.1',
            MIVO_PG_PORT: process.env.MIVO_PG_PORT ?? '55443',
            MIVO_PG_DB: E2E_PG_DB,
            MIVO_PG_USER: E2E_PG_USER,
            MIVO_PG_PASSWORD: process.env.MIVO_PG_PASSWORD ?? E2E_PG_PASSWORD_DEFAULT,
            MIVO_PLATFORM_KEY: process.env.MIVO_PLATFORM_KEY ?? E2E_PLATFORM_KEY_DEFAULT,
            MIVO_E2E_RESET_TOKEN: process.env.MIVO_E2E_RESET_TOKEN ?? E2E_RESET_TOKEN_DEFAULT,
            MIVO_E2E_HARNESS: '1',
          }
        : {
            MIVO_PERSIST_BACKEND: 'memory',
          }),
    },
  })
}

// A2-S4 Block 5: server 档测试数据清理——每轮结束清掉测试创建的 project/canvas/asset,不留残留污染下一轮。
// 调 POST /api/__e2e/reset(app.ts createE2eResetRoute;三重保险挂载:token+sentinel+非生产+非public 任一不满足 → 404)。
// PG 档 __reset TRUNCATE persist_records + 权限表;memory 档同步清空。local/shadow 档无需 reset(IDB
// persist 由 clearAllStorage 清浏览器侧;此函数对 404 返 ok=false 不阻断,仅供 server 档 harness 调用)。
// F2: 调 reset 前再校验白名单(防进程间 env 被改连生产;与启动 BFF 同一校验)。
// F4: 设计为可重入 + 幂等(reset 端点本身幂等),供 e2e-persist-smoke finally 兜底调用;调用方应 try/catch,
//   清理失败不吞原始测试错误(见 e2e-persist-smoke.mjs aggregateErrors)。
//
// 返回 {ok,backend?}:ok=true 清理成功;ok=false 且 reason 含 'not mounted' = 端点未挂载(local/shadow 档预期,
// 三重保险任一不满足);非 404 的失败抛错(fail visibly,不静默吞——server 档 reset 失败须阻断,否则残留污染下一轮)。
export const resetServerPersist = async (bffBaseUrl, resetToken) => {
  // F2: 调 reset 前再校验白名单(防进程间 env 被改连生产)。
  assertE2ePgWhitelist()
  const res = await fetch(`${bffBaseUrl}/api/__e2e/reset`, {
    method: 'POST',
    headers: { 'x-e2e-reset-token': resetToken ?? '' },
  })
  if (res.status === 404) {
    return { ok: false, reason: 'reset endpoint not mounted (三重保险:token+sentinel+非生产+非public 任一不满足;local/shadow 档无需 server reset)' }
  }
  if (res.status === 403) {
    throw new Error(`resetServerPersist: forbidden (x-e2e-reset-token mismatch; BFF MIVO_E2E_RESET_TOKEN vs harness resetToken)`)
  }
  if (res.status !== 200) {
    const body = await res.text().catch(() => '')
    throw new Error(`resetServerPersist: unexpected status ${res.status}: ${body}`)
  }
  const json = await res.json().catch(() => ({}))
  return { ok: true, backend: json.backend }
}


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
  // mainfix R3: flip the e2e bridge flag in BOTH topologies so main.tsx populates
  // `__MIVO_E2E__` (incl. getPersistUserId) everywhere. Previously only
  // installE2EStoreBridge (prod-only) set it, so dev never had the bridge and
  // resolvePersistKey had to browser-import /src/lib/persistUserId.ts — which
  // 404s under prod's static dist server. The route interception itself stays
  // prod-only (installE2EStoreBridge below); only the flag is universal.
  await context.addInitScript(() => {
    window.__MIVO_E2E_ENABLED__ = true
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
