import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
import { attachDefaultMivoApiMocks } from './api-mocks.mjs'

export const createBaseUrl = (port) => `http://127.0.0.1:${port}`

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

export const startSmokeDevServer = ({ port, localAssetFixtureDir, eagleMockPort, apiMode = 'dev-middleware' }) =>
  spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_API_MODE: apiMode,
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
      MIVO_DEBUG_LOG_DIR: path.resolve('test-artifacts/debug-logs'),
    },
  })

export const stopSmokeDevServer = (server) => {
  if (server && !server.killed) {
    server.kill('SIGTERM')
  }
}

export const createSmokePage = async ({ baseUrl, generatedImageB64 }) => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 1 })

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })

  const errors = []
  const mivoEditRequests = []

  await attachDefaultMivoApiMocks(page, { generatedImageB64, mivoEditRequests })

  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('__MIVO_E2E_EXPECTED_ERROR__')) errors.push(message.text())
  })

  return {
    browser,
    errors,
    mivoEditRequests,
    page,
  }
}
