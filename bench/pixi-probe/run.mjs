// PixiJS bare-render probe driver for MivoCanvas engine-selection comparison.
//
// Drives the standalone page at bench/pixi-probe/index.html with Playwright using the
// IDENTICAL pan/zoom gesture (coordinates, steps, wheel deltas, 150ms settle) from
// scripts/bench/collect.mjs, so the resulting p95 frame numbers are directly comparable
// to the committed 0b Leafer/DOM baselines in bench/baselines/0b-*.json.
//
// It reuses scripts/bench/fixture-lib.mjs for fixture paths + generation so the probe
// renders the exact same bench-dom-mixed-*.json data the 0b matrix used.
//
// Output: bench/pixi-probe/results/pixi-<nodes>x<text>-dpr<dpr>-<date>.json
// (structure mirrors bench/baselines/0b-*.json for easy side-by-side comparison)
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { chromium } from 'playwright'
import {
  DEFAULT_FIXTURE_SEED,
  fixturePathFor,
  projectRoot,
  writeFixtureFiles,
} from '../../scripts/bench/fixture-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROBE_DIR = __dirname
const RESULTS_DIR = resolve(PROBE_DIR, 'results')
const VITE_BIN = resolve(projectRoot, 'node_modules/vite/bin/vite.js')

const DEFAULT_PORT = 5189
const DEFAULT_RUNS = 3
const DEFAULT_BROWSER_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const round = (value, digits = 3) => (value == null ? null : Number(value.toFixed(digits)))
const sum = (values) => values.reduce((total, value) => total + value, 0)

const percentile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return round(sorted[index])
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
}

const deviation = (values) => {
  if (values.length < 2) return 0
  const mean = sum(values) / values.length
  const variance = sum(values.map((value) => (value - mean) ** 2)) / values.length
  return round(Math.sqrt(variance))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const parseList = (rawValue, parser) =>
  Array.from(
    new Set(
      String(rawValue || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => parser(entry)),
    ),
  )

const parseArgs = (argv) => {
  const options = {
    nodes: [5000, 10000, 20000],
    dprs: [1],
    runs: DEFAULT_RUNS,
    text: 'on',
    culling: 'off',
    port: DEFAULT_PORT,
    headless: true,
    date: new Date().toISOString().slice(0, 10),
    seed: DEFAULT_FIXTURE_SEED,
  }
  for (const entry of argv) {
    if (entry.startsWith('--nodes=')) {
      options.nodes = parseList(entry.slice('--nodes='.length), (v) => {
        const n = Number.parseInt(v, 10)
        if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --nodes value: ${v}`)
        return n
      })
    } else if (entry.startsWith('--dpr=')) {
      options.dprs = parseList(entry.slice('--dpr='.length), (v) => {
        const n = Number.parseFloat(v)
        if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --dpr value: ${v}`)
        return n
      })
    } else if (entry.startsWith('--runs=')) {
      options.runs = Number.parseInt(entry.slice('--runs='.length), 10)
    } else if (entry.startsWith('--text=')) {
      options.text = entry.slice('--text='.length) === 'skip' ? 'skip' : 'on'
    } else if (entry.startsWith('--culling=')) {
      options.culling = entry.slice('--culling='.length) === 'on' ? 'on' : 'off'
    } else if (entry.startsWith('--port=')) {
      options.port = Number.parseInt(entry.slice('--port='.length), 10)
    } else if (entry === '--headed') {
      options.headless = false
    } else if (entry.startsWith('--date=')) {
      options.date = entry.slice('--date='.length)
    } else {
      throw new Error(`Unknown argument: ${entry}`)
    }
  }
  return options
}

// --- dev server (vite serves the probe dir; pixi.js resolved from probe/node_modules) ---
const waitForServer = async (url, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const { ok } = await fetch(url)
      if (ok || ok === false) return
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error(`Server not ready at ${url} within ${timeoutMs}ms`)
}

const startDevServer = async (port) => {
  // Vite 8 CLI: root is positional, and `--log` is no longer a CLI flag (configure via
  // vite.config if needed). We keep stderr captured and only surface it on failure.
  const server = spawn(
    process.execPath,
    [VITE_BIN, 'serve', PROBE_DIR, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: projectRoot, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const serverLog = []
  const remember = (chunk) => {
    const text = chunk.toString()
    serverLog.push(text)
    if (serverLog.length > 60) serverLog.shift()
    if (process.env.PIXI_PROBE_VERBOSE) process.stderr.write(text)
  }
  server.stdout.on('data', remember)
  server.stderr.on('data', remember)
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, 60000)
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
      await Promise.race([new Promise((r) => server.once('exit', r)), sleep(5000)])
      if (server.exitCode == null) server.kill('SIGKILL')
    },
  }
}

const loadFixture = async (nodeCount) => JSON.parse(await readFile(fixturePathFor(nodeCount), 'utf8'))

// --- pan/zoom: verbatim from scripts/bench/collect.mjs (same coords/steps/wheel) ---
const panCanvas = async (page) => {
  const shell = page.locator('.canvas-shell')
  const box = await shell.boundingBox()
  if (!box) throw new Error('Missing canvas-shell bounding box')
  const startX = box.x + box.width * 0.42
  const startY = box.y + box.height * 0.52
  const path = [
    { x: box.x + box.width * 0.72, y: box.y + box.height * 0.48 },
    { x: box.x + box.width * 0.62, y: box.y + box.height * 0.34 },
    { x: box.x + box.width * 0.79, y: box.y + box.height * 0.58 },
    { x: box.x + box.width * 0.57, y: box.y + box.height * 0.64 },
  ]
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (const point of path) {
    await page.mouse.move(point.x, point.y, { steps: 18 })
  }
  await page.mouse.up()
  await page.waitForTimeout(150)
}

const zoomCanvas = async (page) => {
  const shell = page.locator('.canvas-shell')
  const box = await shell.boundingBox()
  if (!box) throw new Error('Missing canvas-shell bounding box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  try {
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -220)
      await page.waitForTimeout(40)
    }
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 180)
      await page.waitForTimeout(40)
    }
  } finally {
    await page.keyboard.up('Control')
  }
  await page.waitForTimeout(150)
}

const summariseCapture = (capture) => {
  const frames = capture.frames || []
  const longTasks = capture.longTasks || []
  const longTaskDurations = longTasks.map((entry) => entry.duration)
  const p50FrameMs = percentile(frames, 50)
  const p95FrameMs = percentile(frames, 95)
  return {
    durationMs: round(capture.durationMs),
    frameCount: frames.length,
    p50FrameMs,
    p95FrameMs,
    fpsAtP50: p50FrameMs ? round(1000 / p50FrameMs, 2) : null,
    fpsAtP95: p95FrameMs ? round(1000 / p95FrameMs, 2) : null,
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(sum(longTaskDurations), 3),
    longTaskMaxMs: round(Math.max(...longTaskDurations, 0), 3),
  }
}

const aggregateRuns = (runs) => {
  const overallP95Values = runs.map((run) => run.overall.p95FrameMs).filter((v) => v != null)
  const overallP50Values = runs.map((run) => run.overall.p50FrameMs).filter((v) => v != null)
  const heapUsedValues = runs.map((run) => run.heap.usedMb).filter((v) => v != null)
  const heapDeltaValues = runs.map((run) => run.heap.deltaMb).filter((v) => v != null)
  const longTaskCountValues = runs.map((run) => run.overall.longTaskCount)
  const longTaskTotalValues = runs.map((run) => run.overall.longTaskTotalMs)

  const perAction = {}
  for (const label of ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom']) {
    const summaries = runs.map((run) => run.actions[label])
    perAction[label] = {
      p50FrameMs: median(summaries.map((s) => s.p50FrameMs).filter((v) => v != null)),
      p95FrameMs: median(summaries.map((s) => s.p95FrameMs).filter((v) => v != null)),
      durationMs: median(summaries.map((s) => s.durationMs).filter((v) => v != null)),
      longTaskCount: median(summaries.map((s) => s.longTaskCount)),
      longTaskTotalMs: median(summaries.map((s) => s.longTaskTotalMs)),
    }
  }

  const loadFixtureMsValues = runs.map((run) => run.loadFixtureMs).filter((v) => v != null)
  const renderSyncMsValues = runs.map((run) => run.renderSyncMs).filter((v) => v != null)

  return {
    runs: runs.length,
    loadFixtureMs: median(loadFixtureMsValues),
    renderSyncMs: median(renderSyncMsValues),
    overall: {
      p50FrameMs: median(overallP50Values),
      p95FrameMs: median(overallP95Values),
      heapBeforeMb: median(runs.map((run) => run.heap.beforeMb).filter((v) => v != null)),
      heapAfterRenderMb: median(runs.map((run) => run.heap.afterRenderMb).filter((v) => v != null)),
      heapUsedMb: median(heapUsedValues),
      heapDeltaMb: median(heapDeltaValues),
      longTaskCount: median(longTaskCountValues),
      longTaskTotalMs: median(longTaskTotalValues),
    },
    actions: perAction,
    stability: {
      p95MinMs: round(Math.min(...overallP95Values), 3),
      p95MaxMs: round(Math.max(...overallP95Values), 3),
      p95StdDevMs: deviation(overallP95Values),
      spreadMs: round(Math.max(...overallP95Values) - Math.min(...overallP95Values), 3),
    },
  }
}

const runSingleCapture = async ({ browser, fixture, dpr, runIndex, port, textStrategy, culling }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const url = `http://127.0.0.1:${port}/?dpr=${dpr}&text=${textStrategy}&culling=${culling}`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.addStyleTag({
    content: [
      '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}',
      'html,body{caret-color:transparent!important;}',
    ].join(''),
  })
  await page.waitForSelector('.canvas-shell')
  // wait for the probe runtime to boot (pixi Application.init is async)
  await page.waitForFunction(() => globalThis.__MIVO_PIXI_BENCH__?.ready === true, { timeout: 30000 })

  const cdpSession = await context.newCDPSession(page)
  const beforeHeap = await cdpSession.send('Runtime.getHeapUsage')
  const browserVersion = await browser.version()

  const runAction = async (label, action) => {
    await page.evaluate((name) => globalThis.__MIVO_PIXI_BENCH__.startCapture(name), label)
    await action()
    const capture = await page.evaluate((name) => globalThis.__MIVO_PIXI_BENCH__.stopCapture(name), label)
    return { summary: summariseCapture(capture) }
  }

  // 20k loadFixture creates ~20k Pixi display objects (4400 of them Text, which each
  // render a canvas) — page.evaluate waits indefinitely (no timeout), so a slow
  // reference machine won't abort the run. The action() wrapper still times the
  // segment via the in-page performance.measure.
  const load = await runAction('loadFixture', async () => {
    await page.evaluate(
      (inputFixture) => globalThis.__MIVO_PIXI_BENCH__.loadFixture(inputFixture),
      fixture,
    )
  })
  const renderSync = await runAction('render-sync', async () => {
    await page.evaluate(
      (inputFixture) => globalThis.__MIVO_PIXI_BENCH__.waitForRender(inputFixture),
      fixture,
    )
  })
  const renderState = await page.evaluate(() => globalThis.__MIVO_PIXI_BENCH__.getRenderState())
  if (renderState.rendererMode !== 'pixi') {
    throw new Error(`Probe renderer mismatch: expected pixi, got "${renderState.rendererMode}"`)
  }
  if (renderState.cullingMode !== culling) {
    throw new Error(`Probe culling mismatch: requested "${culling}", got "${renderState.cullingMode}"`)
  }
  if (renderState.totalNodeCount !== fixture.meta.nodeCount) {
    throw new Error(`Probe fixture not settled: expected ${fixture.meta.nodeCount}, got ${renderState.totalNodeCount}`)
  }
  if (!renderState.pixelNonEmpty) {
    throw new Error(
      `Probe pixel evidence empty (samples=${renderState.pixelSampleCount}) — canvas blank, run is bogus`,
    )
  }
  const afterRenderHeap = await cdpSession.send('Runtime.getHeapUsage')

  const pan = await runAction('canvas-pan', () => panCanvas(page))
  const zoom = await runAction('canvas-zoom', () => zoomCanvas(page))
  const afterRunHeap = await cdpSession.send('Runtime.getHeapUsage')

  const overall = {
    p50FrameMs: round(Math.max(pan.summary.p50FrameMs ?? 0, zoom.summary.p50FrameMs ?? 0), 3),
    p95FrameMs: round(Math.max(pan.summary.p95FrameMs ?? 0, zoom.summary.p95FrameMs ?? 0), 3),
    longTaskCount: pan.summary.longTaskCount + zoom.summary.longTaskCount,
    longTaskTotalMs: round(pan.summary.longTaskTotalMs + zoom.summary.longTaskTotalMs, 3),
  }

  const mb = (heap) => round(heap.usedSize / 1024 / 1024, 3)

  const result = {
    runIndex,
    browser: {
      chromiumVersion: browserVersion,
      viewport: { width: 1920, height: 1080 },
      dpr,
    },
    renderer: {
      requested: 'pixi',
      actual: 'pixi',
      cullingRequested: culling,
      cullingActual: culling,
    },
    textStrategy,
    culling,
    texturePoolSize: renderState.texturePoolSize,
    loadFixtureMs: load.summary.durationMs,
    renderSyncMs: renderSync.summary.durationMs,
    renderState,
    heap: {
      beforeMb: mb(beforeHeap),
      afterRenderMb: mb(afterRenderHeap),
      afterRunMb: mb(afterRunHeap),
      usedMb: round(mb(afterRunHeap) - mb(beforeHeap), 3),
      deltaMb: round(mb(afterRenderHeap) - mb(beforeHeap), 3),
    },
    overall,
    actions: {
      loadFixture: load.summary,
      'render-sync': renderSync.summary,
      'canvas-pan': pan.summary,
      'canvas-zoom': zoom.summary,
    },
  }

  // Explicit teardown: destroy the Pixi app + textures so GPU VRAM is released before
  // the context closes (prevents cross-run VRAM accumulation → GPU process crash).
  try {
    await page.evaluate(() => globalThis.__MIVO_PIXI_BENCH__.destroy())
  } catch (err) {
    process.stderr.write(`[pixi-probe] destroy warning: ${err?.message || err}\n`)
  }
  await context.close()
  return result
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(RESULTS_DIR, { recursive: true })
  // generate fixtures (5k+ are gitignored; writeFixtureFiles is idempotent)
  await writeFixtureFiles({ nodeCounts: options.nodes, seed: options.seed })

  const devServer = await startDevServer(options.port)

  try {
    const configs = []
    for (const nodeCount of options.nodes) {
      const fixture = await loadFixture(nodeCount)
      // Launch a FRESH browser per node count. Pixi uploads textures to GPU VRAM and
      // even with explicit app.destroy() the browser process's GPU memory fragments
      // across many contexts; a fresh browser per node count eliminates the
      // accumulation that crashed 10k run 2 when reusing one browser across sizes.
      const browser = await chromium.launch({
        headless: options.headless,
        args: DEFAULT_BROWSER_FLAGS,
      })
      try {
        const dprResults = []
        for (const dpr of options.dprs) {
          const runs = []
          for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
            process.stderr.write(
              `[pixi-probe] nodes=${nodeCount} dpr=${dpr} text=${options.text} culling=${options.culling} run ${runIndex}/${options.runs}…\n`,
            )
            const run = await runSingleCapture({
              browser,
              fixture,
            dpr,
            runIndex,
            port: options.port,
            textStrategy: options.text,
            culling: options.culling,
          })
          runs.push(run)
        }
        dprResults.push({ dpr, median: aggregateRuns(runs), runs })
      }
      const gateValues = dprResults.map((r) => ({
        dpr: r.dpr,
        p95FrameMs: r.median.overall.p95FrameMs,
        panP95FrameMs: r.median.actions['canvas-pan'].p95FrameMs,
        zoomP95FrameMs: r.median.actions['canvas-zoom'].p95FrameMs,
        loadFixtureMs: r.median.loadFixtureMs,
        renderSyncMs: r.median.renderSyncMs,
        textStrategy: options.text,
        culling: options.culling,
        totalNodeCount: r.runs[0]?.renderState.totalNodeCount,
        renderedChildren: r.runs[0]?.renderState.pixiChildren,
        pixelNonEmpty: r.runs[0]?.renderState.pixelNonEmpty,
      }))
      const worstP95 = Math.max(...gateValues.map((r) => r.p95FrameMs ?? 0))
      configs.push({
        nodeCount,
        fixture: fixture.meta,
        dprResults,
        gate: {
          thresholdMs: 33,
          dprP95FrameMs: gateValues,
          worstP95FrameMs: round(worstP95, 3),
          status: worstP95 <= 33 ? 'pass' : 'fail',
        },
      })
      } finally {
        await browser.close()
      }
    }

    const outputPath = resolve(
      RESULTS_DIR,
      `pixi-${options.nodes.join('x')}-${options.text}-culling${options.culling}-dpr${options.dprs.join('')}-${options.date}.json`,
    )
    const baseline = {
      protocol: {
        roadmapSection: 'engine-selection probe (PixiJS bare-render ceiling)',
        renderer: 'pixi',
        rendererModeActual: 'pixi',
        culling: options.culling,
        cullingModeActual: options.culling,
        date: options.date,
        referenceMachine: 'same-machine-only',
        browser: 'Chromium via Playwright',
        viewport: { width: 1920, height: 1080 },
        dprs: options.dprs,
        runsPerConfig: options.runs,
        seed: options.seed,
        motion: 'prefers-reduced-motion + transition/animation disabled',
        syncMeasurement: 'pixi Application.init + scene-graph build until children count + pixel non-empty',
        segments: ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom'],
        heapMeasurements: ['before-load', 'after-render', 'after-run'],
        textStrategy: options.text,
        cullingStrategy: options.culling === 'on' ? 'Pixi CullerPlugin auto-cull vs renderer.screen; per-child cullArea' : 'off (draw all children every frame)',
        textureStrategy: '8 canvas-generated placeholder textures, cycled across image sprites (batched)',
        note: 'Engine-ceiling probe — no React/store/DOM overhead. NOT comparable 1:1 to integrated app Leafer numbers; see REPORT.md asymmetry section.',
      },
      configs,
    }
    await writeFile(outputPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8')

    // console summary
    process.stdout.write('\n=== PixiJS probe summary ===\n')
    process.stdout.write(
      `text=${options.text}  culling=${options.culling}  dpr=${options.dprs.join(',')}  runs=${options.runs}\n`,
    )
    process.stdout.write(
      'nodes   panP95ms  zoomP95ms  overallP95ms  loadMs   renderMs  heapDeltaMb  status\n',
    )
    for (const c of configs) {
      const g = c.gate.dprP95FrameMs[0]
      process.stdout.write(
        `${String(c.nodeCount).padStart(6)}  ` +
          `${String(g.panP95FrameMs).padStart(8)}  ` +
          `${String(g.zoomP95FrameMs).padStart(8)}  ` +
          `${String(g.p95FrameMs).padStart(12)}  ` +
          `${String(g.loadFixtureMs).padStart(7)}  ` +
          `${String(g.renderSyncMs).padStart(7)}  ` +
          `${String(c.dprResults[0].median.overall.heapDeltaMb).padStart(10)}  ` +
          `${c.gate.status.toUpperCase()}\n`,
      )
    }
    process.stdout.write(`\nJSON: ${outputPath}\n`)
  } finally {
    // browsers are closed per-nodeCount in the loop above; only the dev server remains.
    await devServer.stop()
  }
}

main().catch((err) => {
  console.error('[pixi-probe] fatal:', err)
  process.exit(1)
})
