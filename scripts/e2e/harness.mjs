import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
import { attachDefaultMivoApiMocks } from './api-mocks.mjs'

export const createBaseUrl = (port) => `http://127.0.0.1:${port}`

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

export const startSmokeDevServer = ({ port, localAssetFixtureDir, eagleMockPort }) =>
  spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_API_MODE: 'dev-middleware',
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
    },
  })

export const startSmokeBffServer = ({
  port,
  localAssetFixtureDir,
  eagleMockPort,
  upstreamBaseUrl,
  bffToken,
  debugViewToken,
  enableLocalAssets,
  enableEagleProxy,
}) =>
  spawn('npm', ['run', 'start:server'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_PORT: String(port),
      MIVO_PUBLIC: '1',
      MIVO_BFF_TOKEN: bffToken,
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
      MIVO_DEBUG_VIEW_TOKEN: debugViewToken,
      MIVO_IMAGE_API_KEY: 'sk_test',
      MIVO_LLM_API_KEY: 'sk_test',
      MIVO_IMAGE_API_BASE: `${upstreamBaseUrl}/v1/images`,
      MIVO_LLM_API_BASE: `${upstreamBaseUrl}/v1`,
      MIVO_ENABLE_LOCAL_ASSETS: enableLocalAssets ? '1' : '0',
      MIVO_ENABLE_EAGLE_PROXY: enableEagleProxy ? '1' : '0',
    },
  })

export const stopSmokeDevServer = async (server) => {
  if (!server) return
  if (server.exitCode !== null || server.signalCode !== null) return

  await new Promise((resolve) => {
    const finish = () => resolve(null)
    const forceKillTimer = setTimeout(() => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL')
      }
    }, 2000)

    server.once('close', () => {
      clearTimeout(forceKillTimer)
      finish()
    })
    server.kill('SIGTERM')
  })
}

export const createSmokePage = async ({ baseUrl, generatedImageB64, extraHTTPHeaders, enableStoreBridgeModules = false }) => {
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

  await attachDefaultMivoApiMocks(page, { generatedImageB64, mivoEditRequests })

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
