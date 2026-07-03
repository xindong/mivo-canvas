import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'
import {
  DEFAULT_FIXTURE_SEED,
  SUPPORTED_DPRS,
  SUPPORTED_NODE_COUNTS,
  fixturePathFor,
  projectRoot,
  writeFixtureFiles,
} from './fixture-lib.mjs'

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
  'toplevel',
].join(',')

const DEFAULT_PORT = 4173
const DEFAULT_RUNS = 5
const DEFAULT_DATE = '2026-07-04'
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

const parseList = (rawValue, parser) =>
  Array.from(
    new Set(
      rawValue
        .split(',')
        .map((part) => parser(part.trim()))
        .filter((value) => value != null),
    ),
  )

const parseNodeCounts = (rawValue) => {
  const counts = parseList(rawValue, (part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : null
  })
  if (!counts.length) throw new Error(`Invalid --nodes value: ${rawValue}`)
  for (const count of counts) {
    if (!SUPPORTED_NODE_COUNTS.includes(count)) {
      throw new Error(`Unsupported node count: ${count}`)
    }
  }
  return counts
}

const parseDprs = (rawValue) => {
  const dprs = parseList(rawValue, (part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : null
  })
  if (!dprs.length) throw new Error(`Invalid --dpr value: ${rawValue}`)
  for (const dpr of dprs) {
    if (!SUPPORTED_DPRS.includes(dpr)) {
      throw new Error(`Unsupported DPR: ${dpr}`)
    }
  }
  return dprs
}

const parseArgs = (argv) => {
  const options = {
    nodes: [100],
    dprs: [...SUPPORTED_DPRS],
    runs: DEFAULT_RUNS,
    port: DEFAULT_PORT,
    renderer: 'dom',
    seed: DEFAULT_FIXTURE_SEED,
    date: DEFAULT_DATE,
    output: undefined,
    note: '初测,P2 完成后须重测出正式 gate 值',
    outputType: 'dom-baseline-initial',
    gateStatus: 'initial',
    mainSha: undefined,
    supersedes: undefined,
    headless: true,
  }

  for (const entry of argv) {
    if (entry.startsWith('--nodes=')) {
      options.nodes = parseNodeCounts(entry.slice('--nodes='.length))
      continue
    }

    if (entry.startsWith('--dpr=')) {
      options.dprs = parseDprs(entry.slice('--dpr='.length))
      continue
    }

    if (entry.startsWith('--runs=')) {
      const runs = Number.parseInt(entry.slice('--runs='.length), 10)
      if (!Number.isFinite(runs) || runs <= 0) throw new Error(`Invalid --runs value: ${entry}`)
      options.runs = runs
      continue
    }

    if (entry.startsWith('--port=')) {
      const port = Number.parseInt(entry.slice('--port='.length), 10)
      if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid --port value: ${entry}`)
      options.port = port
      continue
    }

    if (entry.startsWith('--renderer=')) {
      options.renderer = entry.slice('--renderer='.length).trim() || 'dom'
      continue
    }

    if (entry.startsWith('--seed=')) {
      const seed = Number.parseInt(entry.slice('--seed='.length), 10)
      if (!Number.isFinite(seed)) throw new Error(`Invalid --seed value: ${entry}`)
      options.seed = seed
      continue
    }

    if (entry.startsWith('--date=')) {
      options.date = entry.slice('--date='.length).trim() || DEFAULT_DATE
      continue
    }

    if (entry.startsWith('--output=')) {
      options.output = entry.slice('--output='.length).trim()
      continue
    }

    if (entry.startsWith('--note=')) {
      options.note = entry.slice('--note='.length).trim() || options.note
      continue
    }

    if (entry.startsWith('--output-type=')) {
      options.outputType = entry.slice('--output-type='.length).trim() || options.outputType
      continue
    }

    if (entry.startsWith('--gate-status=')) {
      options.gateStatus = entry.slice('--gate-status='.length).trim() || options.gateStatus
      continue
    }

    if (entry.startsWith('--main-sha=')) {
      options.mainSha = entry.slice('--main-sha='.length).trim() || undefined
      continue
    }

    if (entry.startsWith('--supersedes=')) {
      options.supersedes = entry.slice('--supersedes='.length).trim() || undefined
      continue
    }

    if (entry === '--headed') {
      options.headless = false
    }
  }

  return options
}

const defaultOutputPathFor = ({ renderer, nodes, date }) => {
  const sorted = [...nodes].sort((a, b) => a - b)
  const label =
    sorted.includes(500) && sorted.includes(1000)
      ? `${renderer}-500-1000-${date}.json`
      : `${renderer}-${sorted.join('-')}-${date}.json`
  return `bench/baselines/${label}`
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
    if (serverLog.length > 40) {
      serverLog.shift()
    }
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
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        sleep(5000),
      ])
      if (server.exitCode == null) {
        server.kill('SIGKILL')
      }
    },
  }
}

const loadFixture = async (nodeCount) => JSON.parse(await readFile(fixturePathFor(nodeCount), 'utf8'))

const installBenchRuntime = async (page) => {
  await page.evaluate(() => {
    const waitFrames = (count = 1) =>
      new Promise((resolve) => {
        let remaining = count
        const step = () => {
          remaining -= 1
          if (remaining <= 0) {
            resolve()
            return
          }
          window.requestAnimationFrame(step)
        }
        window.requestAnimationFrame(step)
      })

    const state = {
      capture: undefined,
      observer: undefined,
    }

    const ensureObserver = () => {
      if (state.observer || typeof PerformanceObserver === 'undefined') return
      state.observer = new PerformanceObserver((list) => {
        if (!state.capture) return
        for (const entry of list.getEntries()) {
          state.capture.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          })
        }
      })
      state.observer.observe({ type: 'longtask', buffered: true })
    }

    globalThis.__MIVO_BENCH__ = {
      async loadFixture(fixture) {
        const shell = document.querySelector('.canvas-shell')
        if (!shell) throw new Error('Canvas shell not found')

        window.localStorage.setItem(
          `mivo-canvas-viewport:${fixture.snapshot.sceneId}`,
          JSON.stringify(fixture.meta.recommendedViewport),
        )

        const { useCanvasStore } = await import('/src/store/canvasStore.ts')
        performance.clearMeasures('store-to-renderer-sync')
        performance.clearMarks('store-to-renderer-sync:start')
        performance.clearMarks('store-to-renderer-sync:end')
        performance.clearMarks('store-to-renderer-sync')
        performance.mark('store-to-renderer-sync')
        performance.mark('store-to-renderer-sync:start')
        useCanvasStore.getState().replaceSnapshot(fixture.snapshot)

        const expectedNodeCount = String(fixture.meta.nodeCount)
        const expectedScale = fixture.meta.recommendedViewport.scale
        const startedAt = performance.now()
        while (performance.now() - startedAt < 5000) {
          const nextShell = document.querySelector('.canvas-shell')
          const totalNodeCount = nextShell?.getAttribute('data-total-node-count')
          const viewportScale = Number(nextShell?.getAttribute('data-viewport-scale') || 0)
          if (totalNodeCount === expectedNodeCount && Math.abs(viewportScale - expectedScale) < 0.01) {
            break
          }
          await waitFrames(1)
        }
        await waitFrames(4)
        performance.mark('store-to-renderer-sync:end')
        performance.measure('store-to-renderer-sync', 'store-to-renderer-sync:start', 'store-to-renderer-sync:end')
        useCanvasStore.getState().setActiveTool('hand')

        const currentShell = document.querySelector('.canvas-shell')
        return {
          sceneId: fixture.snapshot.sceneId,
          totalNodeCount: Number(currentShell?.getAttribute('data-total-node-count') || 0),
          renderedNodeCount: Number(currentShell?.getAttribute('data-rendered-node-count') || 0),
          viewportScale: Number(currentShell?.getAttribute('data-viewport-scale') || 0),
          viewportX: Number(currentShell?.getAttribute('data-viewport-x') || 0),
          viewportY: Number(currentShell?.getAttribute('data-viewport-y') || 0),
          syncDurationMs: performance.getEntriesByName('store-to-renderer-sync').at(-1)?.duration || 0,
        }
      },
      startCapture(label) {
        ensureObserver()
        performance.clearMeasures(label)
        performance.clearMarks(label)
        performance.clearMarks(`${label}:start`)
        performance.clearMarks(`${label}:end`)

        const capture = {
          label,
          frames: [],
          longTasks: [],
          rafId: 0,
          active: true,
          lastFrameTs: undefined,
        }

        const sample = (timestamp) => {
          if (!capture.active) return
          if (capture.lastFrameTs != null) {
            capture.frames.push(timestamp - capture.lastFrameTs)
          }
          capture.lastFrameTs = timestamp
          capture.rafId = window.requestAnimationFrame(sample)
        }

        state.capture = capture
        performance.mark(label)
        performance.mark(`${label}:start`)
        capture.rafId = window.requestAnimationFrame(sample)
      },
      async stopCapture(label) {
        const capture = state.capture
        if (!capture || capture.label !== label) {
          throw new Error(`No active capture for ${label}`)
        }

        capture.active = false
        window.cancelAnimationFrame(capture.rafId)
        await waitFrames(2)
        performance.mark(`${label}:end`)
        performance.measure(label, `${label}:start`, `${label}:end`)
        state.capture = undefined

        return {
          label,
          durationMs: performance.getEntriesByName(label).at(-1)?.duration || 0,
          frames: capture.frames.filter((value) => Number.isFinite(value) && value > 0 && value < 1000),
          longTasks: capture.longTasks,
        }
      },
      idleFrames: waitFrames,
    }
  })
}

const traceAction = async (cdpSession, action) => {
  const userTimingEvents = []
  const onData = (payload) => {
    for (const event of payload.value || []) {
      if (
        event.cat?.includes('blink.user_timing') ||
        event.name?.includes('canvas-') ||
        event.name?.includes('store-to-renderer-sync')
      ) {
        userTimingEvents.push(event)
      }
    }
  }
  const tracingComplete = new Promise((resolve) => cdpSession.once('Tracing.tracingComplete', resolve))

  cdpSession.on('Tracing.dataCollected', onData)
  await cdpSession.send('Tracing.start', {
    categories: TRACE_CATEGORIES,
    transferMode: 'ReportEvents',
  })
  try {
    await action()
  } finally {
    await cdpSession.send('Tracing.end')
    await tracingComplete
    cdpSession.off('Tracing.dataCollected', onData)
  }

  return userTimingEvents
}

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
    for (let index = 0; index < 6; index += 1) {
      await page.mouse.wheel(0, -220)
      await page.waitForTimeout(40)
    }
    for (let index = 0; index < 4; index += 1) {
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
  const syncDurations = runs.map((run) => run.storeToRendererSyncMs)
  const overallP95Values = runs.map((run) => run.overall.p95FrameMs).filter((value) => value != null)
  const overallP50Values = runs.map((run) => run.overall.p50FrameMs).filter((value) => value != null)
  const heapUsedValues = runs.map((run) => run.heap.usedMb).filter((value) => value != null)
  const heapDeltaValues = runs.map((run) => run.heap.deltaMb).filter((value) => value != null)
  const longTaskCountValues = runs.map((run) => run.overall.longTaskCount)
  const longTaskTotalValues = runs.map((run) => run.overall.longTaskTotalMs)

  const perAction = {}
  for (const label of ['canvas-pan', 'canvas-zoom']) {
    const summaries = runs.map((run) => run.actions[label])
    perAction[label] = {
      p50FrameMs: median(summaries.map((summary) => summary.p50FrameMs).filter((value) => value != null)),
      p95FrameMs: median(summaries.map((summary) => summary.p95FrameMs).filter((value) => value != null)),
      durationMs: median(summaries.map((summary) => summary.durationMs).filter((value) => value != null)),
      longTaskCount: median(summaries.map((summary) => summary.longTaskCount)),
      longTaskTotalMs: median(summaries.map((summary) => summary.longTaskTotalMs)),
    }
  }

  return {
    runs: runs.length,
    storeToRendererSyncMs: median(syncDurations),
    overall: {
      p50FrameMs: median(overallP50Values),
      p95FrameMs: median(overallP95Values),
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

const runSingleCapture = async ({ browser, fixture, dpr, runIndex, port }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })
  await page.addStyleTag({
    content: [
      '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}',
      'html,body{caret-color:transparent!important;}',
    ].join(''),
  })
  await page.waitForSelector('.canvas-shell')
  await installBenchRuntime(page)

  const shellState = await page.evaluate((inputFixture) => globalThis.__MIVO_BENCH__.loadFixture(inputFixture), fixture)
  const cdpSession = await context.newCDPSession(page)
  const beforeHeap = await cdpSession.send('Runtime.getHeapUsage')
  const browserVersion = await browser.version()

  const runAction = async (label, action) => {
    const traceEvents = await traceAction(cdpSession, async () => {
      await page.evaluate((name) => globalThis.__MIVO_BENCH__.startCapture(name), label)
      await action()
    })
    const capture = await page.evaluate((name) => globalThis.__MIVO_BENCH__.stopCapture(name), label)
    const summary = summariseCapture(capture)
    return {
      summary,
      trace: {
        eventCount: traceEvents.length,
        markNamesSeen: Array.from(new Set(traceEvents.map((event) => event.name).filter(Boolean))).sort(),
      },
    }
  }

  const pan = await runAction('canvas-pan', () => panCanvas(page))
  const zoom = await runAction('canvas-zoom', () => zoomCanvas(page))
  const afterHeap = await cdpSession.send('Runtime.getHeapUsage')
  const overall = {
    p50FrameMs: round(Math.max(pan.summary.p50FrameMs ?? 0, zoom.summary.p50FrameMs ?? 0), 3),
    p95FrameMs: round(Math.max(pan.summary.p95FrameMs ?? 0, zoom.summary.p95FrameMs ?? 0), 3),
    longTaskCount: pan.summary.longTaskCount + zoom.summary.longTaskCount,
    longTaskTotalMs: round(pan.summary.longTaskTotalMs + zoom.summary.longTaskTotalMs, 3),
  }

  const result = {
    runIndex,
    browser: {
      chromiumVersion: browserVersion,
      viewport: { width: 1920, height: 1080 },
      dpr,
    },
    fixture: {
      sceneId: fixture.meta.sceneId,
      nodeCount: fixture.meta.nodeCount,
      seed: fixture.meta.seed,
      counts: fixture.meta.counts,
    },
    storeToRendererSyncMs: round(shellState.syncDurationMs),
    shellState,
    heap: {
      usedMb: round(afterHeap.usedSize / (1024 * 1024), 3),
      totalMb: round(afterHeap.totalSize / (1024 * 1024), 3),
      deltaMb: round((afterHeap.usedSize - beforeHeap.usedSize) / (1024 * 1024), 3),
    },
    actions: {
      'canvas-pan': pan.summary,
      'canvas-zoom': zoom.summary,
    },
    trace: {
      'canvas-pan': pan.trace,
      'canvas-zoom': zoom.trace,
    },
    overall,
  }

  await context.close()
  return result
}

const assertTraceMarks = (run) => {
  for (const [label, action] of Object.entries(run.trace)) {
    if (!action.markNamesSeen.includes(label)) {
      throw new Error(`Trace mark ${label} missing from ${label} trace`)
    }
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(`${projectRoot}/bench/baselines`, { recursive: true })
  await writeFixtureFiles({ nodeCounts: options.nodes, seed: options.seed })

  const devServer = await startDevServer(options.port)
  const browser = await chromium.launch({
    headless: options.headless,
    args: DEFAULT_BROWSER_FLAGS,
  })

  try {
    const configs = []
    for (const nodeCount of options.nodes) {
      const fixture = await loadFixture(nodeCount)
      const dprResults = []
      for (const dpr of options.dprs) {
        const runs = []
        for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
          const run = await runSingleCapture({
            browser,
            fixture,
            dpr,
            runIndex,
            port: options.port,
          })
          assertTraceMarks(run)
          runs.push(run)
        }
        dprResults.push({
          dpr,
          median: aggregateRuns(runs),
          runs,
        })
      }

      const dprGateValues = dprResults.map((result) => ({
        dpr: result.dpr,
        p95FrameMs: result.median.overall.p95FrameMs,
      }))
      const worstP95 = Math.max(...dprGateValues.map((result) => result.p95FrameMs ?? 0))

      configs.push({
        nodeCount,
        fixture: fixture.meta,
        dprResults,
        gate: {
          thresholdMs: 33,
          dprP95FrameMs: dprGateValues,
          worstP95FrameMs: round(worstP95, 3),
          status: options.gateStatus,
          note: options.note,
        },
      })
    }

    const outputPath = options.output || defaultOutputPathFor(options)
    const baseline = {
      protocol: {
        roadmapSection: '§12.1 / §13 SC6.2',
        renderer: options.renderer,
        date: options.date,
        referenceMachine: 'same-machine-only',
        browser: 'Chromium via Playwright',
        viewport: { width: 1920, height: 1080 },
        dprs: options.dprs,
        runsPerConfig: options.runs,
        seed: options.seed,
        motion: 'prefers-reduced-motion + transition/animation disabled',
        syncMeasurement: 'replaceSnapshot(full snapshot) until expected node count / viewport settle',
        traceMarks: ['store-to-renderer-sync', 'canvas-pan', 'canvas-zoom'],
        ...(options.mainSha ? { mainSha: options.mainSha } : {}),
      },
      note: options.note,
      outputType: options.outputType,
      ...(options.supersedes ? { supersedes: options.supersedes } : {}),
      configs,
    }

    await writeFile(`${projectRoot}/${outputPath}`, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(outputPath)
  } finally {
    await browser.close()
    await devServer.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
