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
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=rotation
 *       # FU-8 旋转对照：注入旋转 image/rect/ellipse/note/line/arrow + connector
 *       # 固定文档（bench 同款 replaceSnapshot 注入），DOM vs Leafer 像素对照
 */

const DEFAULT_PORT = 4179
const DEFAULT_DPR = 1
const DIFF_THRESHOLD_PERCENT = 5.0

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
    fixture: null,
  }
  for (const entry of argv) {
    if (entry.startsWith('--baseline=')) options.baseline = entry.slice('--baseline='.length) || 'dom'
    else if (entry.startsWith('--candidate=')) options.candidate = entry.slice('--candidate='.length) || 'dom'
    else if (entry.startsWith('--fixture=')) options.fixture = entry.slice('--fixture='.length) || null
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

/**
 * FU-8 / Phase 4b 旋转对照 fixture：旋转 image / rect / ellipse / note / dashed
 * line / 双头 arrow + 一对 connector 绑定节点。rotation 走 V2 transform（store
 * normalize 保留）；connector 的 markupPoints 由 replaceSnapshot 内的
 * normalizeCanvasGraph 归一化 —— DOM 与 Leafer 消费同一份归一化输出。
 * 坐标按默认 viewport (420,240,scale 1) 全部落在 1920×1080 视口内。
 */
const rotationFixtureNodes = () => {
  const node = (props) => ({ status: 'ready', title: props.id, ...props })
  const rotated = (props, rotation) => ({
    ...node(props),
    transform: { x: props.x, y: props.y, width: props.width, height: props.height, rotation },
  })
  return [
    rotated({ id: 'rot-image', type: 'image', x: 40, y: 40, width: 216, height: 384, assetUrl: '/demo-assets/courage-1.jpg' }, 30),
    rotated({ id: 'rot-rect', type: 'markup', markupKind: 'rect', x: 340, y: 60, width: 160, height: 120, markupFillColor: '#ffeecc', markupStrokeColor: '#112233', markupStrokeWidth: 4 }, 45),
    rotated({ id: 'rot-ellipse', type: 'markup', markupKind: 'ellipse', x: 560, y: 60, width: 160, height: 120 }, 20),
    rotated({ id: 'rot-note', type: 'markup', markupKind: 'note', x: 780, y: 80, width: 140, height: 140 }, -15),
    rotated({ id: 'rot-line', type: 'markup', markupKind: 'line', x: 340, y: 260, width: 220, height: 120, markupStrokeWidth: 4, markupStrokeStyle: 'dashed', markupPoints: [{ x: 10, y: 110 }, { x: 210, y: 10 }] }, 25),
    node({ id: 'flat-arrow', type: 'markup', markupKind: 'arrow', x: 620, y: 260, width: 240, height: 140, markupStrokeWidth: 3, markupOpacity: 0.82, markupStartArrow: true, markupPoints: [{ x: 10, y: 10 }, { x: 230, y: 130 }] }),
    node({ id: 'conn-a', type: 'markup', markupKind: 'rect', x: 40, y: 520, width: 120, height: 90 }),
    node({ id: 'conn-b', type: 'markup', markupKind: 'rect', x: 400, y: 620, width: 120, height: 90 }),
    node({
      id: 'conn-arrow',
      type: 'markup',
      markupKind: 'arrow',
      x: 160,
      y: 560,
      width: 240,
      height: 100,
      markupPoints: [{ x: 0, y: 0 }, { x: 240, y: 100 }],
      connectorStart: { nodeId: 'conn-a', anchor: 'right', offset: 0.5 },
      connectorEnd: { nodeId: 'conn-b', anchor: 'left', offset: 0.5 },
    }),
  ]
}

const fixtureNodesFor = (fixture) => {
  if (!fixture) return null
  if (fixture === 'rotation') return rotationFixtureNodes()
  throw new Error(`Unknown --fixture value: ${fixture}`)
}

const captureScreenshot = async ({ browser, port, renderer, dpr, label, fixture }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const fixtureNodes = fixtureNodesFor(fixture)
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (fixtureNodes) {
    // bench 同款：注入文档不写 IDB（persistIdbStorage 读此 flag），两次采集互不污染。
    await page.addInitScript(() => {
      globalThis.__MIVO_BENCH_PERSIST_SKIP__ = true
    })
  }
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
  if (fixtureNodes) {
    // 注入固定文档（replaceSnapshot 内部跑 normalizeCanvasGraph → connector
    // markupPoints 归一化，DOM/Leafer 消费同一输出）。
    await page.evaluate(async (nodes) => {
      const { useCanvasStore } = await import('/src/store/canvasStore.ts')
      const snapshot = useCanvasStore.getState().getSnapshot()
      useCanvasStore.getState().replaceSnapshot({
        ...snapshot,
        nodes,
        edges: [],
        tasks: [],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      })
    }, fixtureNodes)
    if (renderer === 'leafer') {
      await page.waitForFunction(
        (mode) => {
          const shell = document.querySelector('.canvas-shell')
          const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
          const children = Number(shell?.getAttribute('data-leafer-children') || 0)
          return shell?.getAttribute('data-renderer-mode') === mode &&
            expected > 0 &&
            children === expected &&
            shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
        },
        'leafer',
        { timeout: 15000 },
      )
    } else {
      // dom 模式等注入的旋转图片位图落地（唯一的异步资源）。
      await page.waitForSelector('.dom-node img[src="/demo-assets/courage-1.jpg"]')
    }
    await page.waitForTimeout(300)
  } else if (renderer === 'leafer') {
    // leafer 模式 image/frame 由 Leafer 画，DOM 无 <img>；等 data-renderer-mode + paint 证据稳定
    await page.waitForFunction(
      (mode) => {
        const shell = document.querySelector('.canvas-shell')
        const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
        const children = Number(shell?.getAttribute('data-leafer-children') || 0)
        return shell?.getAttribute('data-renderer-mode') === mode &&
          expected > 0 &&
          children === expected &&
          shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
      },
      'leafer',
      { timeout: 15000 },
    )
    await page.waitForTimeout(300)
  } else {
    await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
    await page.waitForTimeout(300)
  }

  const shell = page.locator('.canvas-shell')
  const renderState = await page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    return {
      rendererMode: shell?.getAttribute('data-renderer-mode') || 'dom',
      leaferExpectedChildren: Number(shell?.getAttribute('data-leafer-expected-children') || 0),
      leaferChildren: Number(shell?.getAttribute('data-leafer-children') || 0),
      leaferPixelNonEmpty: shell?.getAttribute('data-leafer-pixel-nonempty') === 'true',
    }
  })
  const pngBuffer = await shell.screenshot({ type: 'png' })
  const png = PNG.sync.read(pngBuffer)
  await context.close()
  return { label, renderer, renderState, png, pngBuffer }
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
      fixture: options.fixture,
    })
    const candidate = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.candidate,
      dpr: options.dpr,
      label: 'candidate',
      fixture: options.fixture,
    })

    const diff = diffImages(baseline, candidate)
    const fixtureSuffix = options.fixture ? `-${options.fixture}` : ''
    const baselinePath = `${options.outputDir}/baseline-${options.baseline}${fixtureSuffix}.png`
    const candidatePath = `${options.outputDir}/candidate-${options.candidate}${fixtureSuffix}.png`
    const diffPath = `${options.outputDir}/diff-${options.baseline}-vs-${options.candidate}${fixtureSuffix}.png`
    const reportPath = `${options.outputDir}/diff-report${fixtureSuffix}.json`

    await writeFile(`${projectRoot}/${baselinePath}`, PNG.sync.write(baseline.png))
    await writeFile(`${projectRoot}/${candidatePath}`, PNG.sync.write(candidate.png))
    await writeFile(`${projectRoot}/${diffPath}`, PNG.sync.write(diff.diffPng))
    await writeFile(
      `${projectRoot}/${reportPath}`,
      `${JSON.stringify({
        baseline: { renderer: options.baseline, ...baseline.renderState, path: baselinePath },
        candidate: { renderer: options.candidate, ...candidate.renderState, path: candidatePath },
        diff: {
          mismatchedPixels: diff.mismatchedPixels,
          totalPixels: diff.totalPixels,
          diffPercent: diff.diffPercent,
          thresholdPercent: DIFF_THRESHOLD_PERCENT,
          passed: diff.passed,
          artifactPath: diffPath,
        },
        dpr: options.dpr,
        fixture: options.fixture,
      }, null, 2)}\n`,
    )

    const status = diff.diffPercent <= DIFF_THRESHOLD_PERCENT ? 'PASS' : 'FAIL'
    console.log(`[visual-diff] ${status} baseline=${options.baseline} candidate=${options.candidate} dpr=${options.dpr}${options.fixture ? ` fixture=${options.fixture}` : ''} diff=${diff.diffPercent}% (threshold ${DIFF_THRESHOLD_PERCENT}%)`)
    console.log(`[visual-diff] baseline rendererMode=${baseline.renderState.rendererMode} candidate rendererMode=${candidate.renderState.rendererMode}`)
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
