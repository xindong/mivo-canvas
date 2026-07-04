import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { projectRoot } from './bench/fixture-lib.mjs'

/**
 * 视觉 diff harness（Leafer 接入 PR-1 / Phase 0a 工装）。
 *
 * 固定场景、固定 DPR、禁动画（prefers-reduced-motion + 禁 transition），
 * 生成 baseline + candidate 截图 + diff 百分比 + diff artifact。
 *
 * 当前只支持 DOM 渲染（leafer renderer 未实现，等同 dom）。
 * 默认 DOM-vs-DOM 自检：同场景两次截图，diff 应 = 0%。
 *
 * 用法：
 *   node scripts/visual-diff.mjs                         # DOM vs DOM 自检
 *   node scripts/visual-diff.mjs --candidate=leafer      # DOM baseline vs leafer candidate（占位）
 *   node scripts/visual-diff.mjs --dpr=2                 # 固定 DPR=2
 *   node scripts/visual-diff.mjs --port=4180             # 自定义 dev 端口
 */

const DEFAULT_PORT = 4179
const DEFAULT_DPR = 1
const DIFF_THRESHOLD_PERCENT = 1.0

const DEFAULT_BROWSER_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const parseArgs = (argv) => {
  const options = {
    baseline: 'dom',
    candidate: 'dom',
    dpr: DEFAULT_DPR,
    port: DEFAULT_PORT,
    headless: true,
    outputDir: 'test-artifacts/visual-diff',
  }
  for (const entry of argv) {
    if (entry.startsWith('--baseline=')) options.baseline = entry.slice('--baseline='.length) || 'dom'
    else if (entry.startsWith('--candidate=')) options.candidate = entry.slice('--candidate='.length) || 'dom'
    else if (entry.startsWith('--dpr=')) {
      const dpr = Number.parseInt(entry.slice('--dpr='.length), 10)
      if (Number.isFinite(dpr) && dpr > 0) options.dpr = dpr
    } else if (entry.startsWith('--port=')) {
      const port = Number.parseInt(entry.slice('--port='.length), 10)
      if (Number.isFinite(port) && port > 0) options.port = port
    } else if (entry.startsWith('--output=')) options.outputDir = entry.slice('--output='.length) || options.outputDir
    else if (entry === '--headed') options.headless = false
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForServer = async (url, timeoutMs = 60000) => {
  const startedAt = Date.now()
  let lastError = new Error('Timed out waiting for dev server')
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          response.resume()
          response.statusCode && response.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`))
        })
        request.on('error', reject)
      })
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await sleep(500)
    }
  }
  throw lastError
}

const startDevServer = async (port) => {
  const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: projectRoot,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverLog = []
  const remember = (chunk) => {
    const text = chunk.toString()
    serverLog.push(text)
    if (serverLog.length > 40) serverLog.shift()
  }
  server.stdout.on('data', remember)
  server.stderr.on('data', remember)

  try {
    await waitForServer(`http://127.0.0.1:${port}`, 60000)
  } catch (error) {
    server.kill('SIGTERM')
    const detail = serverLog.join('').trim()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`)
  }

  return {
    server,
    async stop() {
      if (server.exitCode != null) return
      server.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(5000)])
      if (server.exitCode == null) server.kill('SIGKILL')
    },
  }
}

const captureScreenshot = async ({ browser, port, renderer, dpr, label }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`http://127.0.0.1:${port}/?renderer=${encodeURIComponent(renderer)}`, { waitUntil: 'networkidle' })
  await page.addStyleTag({
    content: [
      '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}',
      'html,body{caret-color:transparent!important;}',
    ].join(''),
  })
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`http://127.0.0.1:${port}/?renderer=${encodeURIComponent(renderer)}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.canvas-shell')
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
  await page.waitForTimeout(300)

  const shell = page.locator('.canvas-shell')
  const rendererMode = await page.evaluate(() => document.querySelector('.canvas-shell')?.getAttribute('data-renderer-mode') || 'dom')
  const pngBuffer = await shell.screenshot({ type: 'png' })
  const png = PNG.sync.read(pngBuffer)
  await context.close()
  return { label, renderer, rendererMode, png, pngBuffer }
}

const diffImages = (baseline, candidate) => {
  const { width, height } = baseline.png
  if (candidate.png.width !== width || candidate.png.height !== height) {
    throw new Error(`Screenshot size mismatch: baseline ${width}x${height} vs candidate ${candidate.png.width}x${candidate.png.height}`)
  }
  const diff = new PNG({ width, height })
  const mismatchedPixels = pixelmatch(baseline.png.data, candidate.png.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: false,
  })
  const totalPixels = width * height
  const diffPercent = Number(((mismatchedPixels / totalPixels) * 100).toFixed(4))
  const passed = diffPercent <= DIFF_THRESHOLD_PERCENT
  return { mismatchedPixels, totalPixels, diffPercent, passed, diffPng: diff }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(`${projectRoot}/${options.outputDir}`, { recursive: true })

  const devServer = await startDevServer(options.port)
  const browser = await chromium.launch({ headless: options.headless, args: DEFAULT_BROWSER_FLAGS })

  try {
    const baseline = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.baseline,
      dpr: options.dpr,
      label: 'baseline',
    })
    const candidate = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.candidate,
      dpr: options.dpr,
      label: 'candidate',
    })

    const diff = diffImages(baseline, candidate)
    const baselinePath = `${options.outputDir}/baseline-${options.baseline}.png`
    const candidatePath = `${options.outputDir}/candidate-${options.candidate}.png`
    const diffPath = `${options.outputDir}/diff-${options.baseline}-vs-${options.candidate}.png`
    const reportPath = `${options.outputDir}/diff-report.json`

    await writeFile(`${projectRoot}/${baselinePath}`, PNG.sync.write(baseline.png))
    await writeFile(`${projectRoot}/${candidatePath}`, PNG.sync.write(candidate.png))
    await writeFile(`${projectRoot}/${diffPath}`, PNG.sync.write(diff.diffPng))
    await writeFile(
      `${projectRoot}/${reportPath}`,
      `${JSON.stringify({
        baseline: { renderer: options.baseline, rendererModeActual: baseline.rendererMode, path: baselinePath },
        candidate: { renderer: options.candidate, rendererModeActual: candidate.rendererMode, path: candidatePath },
        diff: {
          mismatchedPixels: diff.mismatchedPixels,
          totalPixels: diff.totalPixels,
          diffPercent: diff.diffPercent,
          thresholdPercent: DIFF_THRESHOLD_PERCENT,
          passed: diff.passed,
          artifactPath: diffPath,
        },
        dpr: options.dpr,
      }, null, 2)}\n`,
    )

    const status = diff.diffPercent <= DIFF_THRESHOLD_PERCENT ? 'PASS' : 'FAIL'
    console.log(`[visual-diff] ${status} baseline=${options.baseline} candidate=${options.candidate} dpr=${options.dpr} diff=${diff.diffPercent}% (threshold ${DIFF_THRESHOLD_PERCENT}%)`)
    console.log(`[visual-diff] baseline rendererMode=${baseline.rendererMode} candidate rendererMode=${candidate.rendererMode}`)
    console.log(`[visual-diff] artifacts: ${reportPath}, ${diffPath}`)

    if (!diff.passed) {
      process.exitCode = 1
    }
  } finally {
    await browser.close()
    await devServer.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
