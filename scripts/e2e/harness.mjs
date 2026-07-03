import { spawn, spawnSync, execSync } from 'node:child_process'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
import { attachDefaultMivoApiMocks } from './api-mocks.mjs'

export const createBaseUrl = (port) => `http://127.0.0.1:${port}`

// killStaleDevServer: detect and kill a leftover dev server from a prior failed
// e2e run. A stale dev server keeps the old debug log dir and breaks
// --strictPort restarts.
const killStaleDevServer = (port) => {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim()
    if (!pids) return
    console.warn(`[harness] killing stale dev server on port ${port} (pids: ${pids.replace(/\n/g, ' ')})`)
    execSync(`kill ${pids.replace(/\n/g, ' ')} 2>/dev/null || true`, { stdio: 'ignore' })
  } catch {
    // lsof/kill unavailable - skip; --strictPort will fail visibly if occupied.
  }
}

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
  return spawnBackgroundProcess('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_PORT: String(bffPort),
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
    },
  })
}

export const startSmokeBffServer = ({
  port,
  localAssetFixtureDir,
  eagleMockPort,
  upstreamBaseUrl,
  bffToken,
  debugViewToken,
  enableLocalAssets,
  enableEagleProxy,
  isPublic = true,
}) =>
  spawnBackgroundProcess('npm', ['run', 'start:server'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_PORT: String(port),
      ...(isPublic ? { MIVO_PUBLIC: '1', MIVO_BFF_TOKEN: bffToken } : {}),
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
  const page = await context.newPage()

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })

  const errors = []
  const mivoEditRequests = []

  if (enableApiRouteMocks) {
    await attachDefaultMivoApiMocks(page, { generatedImageB64, mivoEditRequests })
  }

  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('__MIVO_E2E_EXPECTED_ERROR__')) errors.push(message.text())
  })

  return {
    browser,
    context,
    errors,
    mivoEditRequests,
    page,
  }
}
