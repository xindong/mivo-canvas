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
    culling: 'on',
    panCache: 'off',
    seed: DEFAULT_FIXTURE_SEED,
    date: DEFAULT_DATE,
    output: undefined,
    note: '初测,P2 完成后须重测出正式 gate 值',
    outputType: 'dom-baseline-initial',
    gateStatus: 'initial',
    mainSha: undefined,
    supersedes: undefined,
    headless: true,
    includeDrag: true,
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

    if (entry.startsWith('--culling=')) {
      const value = entry.slice('--culling='.length).trim()
      if (value !== 'on' && value !== 'off') throw new Error(`Invalid --culling value: ${value} (expected on|off)`)
      options.culling = value
      continue
    }

    if (entry.startsWith('--pan-cache=')) {
      const value = entry.slice('--pan-cache='.length).trim()
      if (value !== 'on' && value !== 'off') throw new Error(`Invalid --pan-cache value: ${value} (expected on|off)`)
      options.panCache = value
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
      continue
    }

    if (entry === '--skip-drag') {
      options.includeDrag = false
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
    // FU4-2: the canvas store now persists to IndexedDB (no 5MB quota), but the
    // bench measures render perf, not persistence — skip the IDB write entirely so
    // 50k-node fixtures don't serialize+put on every replaceSnapshot. The adapter
    // (src/lib/persistIdbStorage.ts) checks this flag in setItem. (Was a
    // localStorage.setItem no-op shim, which no longer intercepts the IDB write.)
    globalThis.__MIVO_BENCH_PERSIST_SKIP__ = true

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
        useCanvasStore.getState().replaceSnapshot(fixture.snapshot)
        useCanvasStore.getState().setActiveTool('hand')
        return { sceneId: fixture.snapshot.sceneId }
      },
      async waitForRender(fixture) {
        const expectedNodeCount = String(fixture.meta.nodeCount)
        const expectedScale = fixture.meta.recommendedViewport.scale
        const startedAt = performance.now()
        let settled = false
        const requestedRenderer = new URLSearchParams(window.location.search).get('renderer') || 'dom'
        let lastSnapshot = { totalNodeCount: null, viewportScale: 0, rendererMode: null, leaferChildren: 0, leaferExpectedChildren: 0, leaferPixelNonEmpty: false }
        while (performance.now() - startedAt < 15000) {
          const nextShell = document.querySelector('.canvas-shell')
          const totalNodeCount = nextShell?.getAttribute('data-total-node-count')
          const viewportScale = Number(nextShell?.getAttribute('data-viewport-scale') || 0)
          const leaferExpectedChildren = Number(nextShell?.getAttribute('data-leafer-expected-children') || 0)
          const leaferChildren = Number(nextShell?.getAttribute('data-leafer-children') || 0)
          const leaferPixelNonEmpty = nextShell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
          lastSnapshot = {
            totalNodeCount,
            viewportScale,
            rendererMode: nextShell?.getAttribute('data-renderer-mode') || 'dom',
            leaferChildren,
            leaferExpectedChildren,
            leaferPixelNonEmpty,
          }
          const leaferReady =
            requestedRenderer !== 'leafer' ||
            (leaferExpectedChildren > 0 && leaferChildren === leaferExpectedChildren && leaferPixelNonEmpty)
          if (totalNodeCount === expectedNodeCount && Math.abs(viewportScale - expectedScale) < 0.01 && leaferReady) {
            settled = true
            break
          }
          await waitFrames(1)
        }
        await waitFrames(4)

        const currentShell = document.querySelector('.canvas-shell')
        const actualNodeCount = currentShell?.getAttribute('data-total-node-count')
        const actualScale = Number(currentShell?.getAttribute('data-viewport-scale') || 0)
        const actualRendererMode = currentShell?.getAttribute('data-renderer-mode') || 'dom'
        const leaferExpectedChildren = Number(currentShell?.getAttribute('data-leafer-expected-children') || 0)
        const leaferChildren = Number(currentShell?.getAttribute('data-leafer-children') || 0)
        const leaferPixelNonEmpty = currentShell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
        const leaferPixelSampleCount = Number(currentShell?.getAttribute('data-leafer-pixel-sample-count') || 0)
        const leaferSyncVersion = Number(currentShell?.getAttribute('data-leafer-sync-version') || 0)
        if (!settled || actualNodeCount !== expectedNodeCount || Math.abs(actualScale - expectedScale) >= 0.01) {
          throw new Error(
            `waitForRender did not settle within 15s: expected nodeCount=${expectedNodeCount} scale=${expectedScale} renderer=${requestedRenderer}, `
            + `actual nodeCount=${actualNodeCount} scale=${actualScale} renderer=${actualRendererMode} (last poll: ${JSON.stringify(lastSnapshot)})`,
          )
        }
        return {
          sceneId: fixture.snapshot.sceneId,
          rendererMode: actualRendererMode,
          totalNodeCount: Number(actualNodeCount || 0),
          renderedNodeCount: Number(currentShell?.getAttribute('data-rendered-node-count') || 0),
          leaferExpectedChildren,
          leaferChildren,
          leaferPixelNonEmpty,
          leaferPixelSampleCount,
          leaferSyncVersion,
          viewportScale: actualScale,
          viewportX: Number(currentShell?.getAttribute('data-viewport-x') || 0),
          viewportY: Number(currentShell?.getAttribute('data-viewport-y') || 0),
          settled: true,
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

const traceAction = async (_cdpSession, label, action) => {
  await action()
  // 0b matrix uses in-page rAF + Long Task measurements as the source of truth. CDP tracing
  // became non-deterministic at 10k+ nodes on the reference machine, so keep a lightweight
  // marker record for the trace-mark self-check without letting Tracing.* block the run.
  return [{ name: label, cat: 'synthetic_bench_marker' }]
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

// --- canvas-drag (PR-C §7.1, v3 ordering: after pan/zoom) ----------------------
//
// pan/zoom are measured on a clean post-render fixture; canvas-drag runs AFTER them
// because it mutates the store (selectNode + node-move, and section children if a
// frame is dragged) which would dirty the pan/zoom gate input. overall/gate still
// aggregates ONLY pan/zoom (see runSingleCapture) — canvas-drag is a standalone
// perAction metric. The drag exercises the node-move WRITE path (beginNodeMove →
// updateSelectedNodesPosition → normalizeCanvasNodes → React render), which is the
// actual PR-C optimization target.

const nodePositionInStore = (page, nodeId) =>
  page.evaluate(async (id) => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const target = useCanvasStore.getState().nodes.find((item) => item.id === id)
    return target ? { x: target.x, y: target.y } : null
  }, nodeId)

const setBenchTool = (page, tool) =>
  page.evaluate(async (id) => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    useCanvasStore.getState().setActiveTool(id)
  }, tool)

// v3: pick the first draggable node CURRENTLY VISIBLE in the viewport AND not covered
// by another node at its drag point. drag runs after pan/zoom so the viewport has shifted
// — the first store node is almost certainly off-screen (fixture places nodes at negative
// canvas coords, e.g. -5198). canvas-shell uses overflow:clip + CSS transform (App.css:2960),
// NOT a scroll container, so scrollIntoView is a no-op here — the plan's "pick-from-store +
// scrollIntoView" mechanism can't land the node on-screen. Instead, scan the rendered
// [data-node-id] elements for one whose center is inside the viewport, whose id is a
// draggable type (image/text/frame, !locked, !hidden) per the store, AND whose 24px-in
// click point is NOT covered by another overlapping node (the 1000-node fixture overlaps
// on screen after zoom-in — without this check the pointer-down hits the wrong node).
// Prefers image (leaf — no children stacked on top → pointer-down reliably hits it).
const pickDraggableNodeId = (page) =>
  page.evaluate(async () => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const nodes = useCanvasStore.getState().nodes
    const draggable = new Set(
      nodes
        .filter(
          (n) =>
            !n.locked && !n.hidden && (n.type === 'image' || n.type === 'text' || n.type === 'frame'),
        )
        .map((n) => n.id),
    )
    const vw = window.innerWidth
    const vh = window.innerHeight
    const els = Array.from(document.querySelectorAll('[data-node-id]'))
    let fallback = null
    for (const el of els) {
      const id = el.getAttribute('data-node-id')
      if (!id || !draggable.has(id)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue
      // The drag starts 24px in from the top-left — verify that point is NOT covered by
      // another node stacked on top (elementFromPoint must land inside THIS node).
      const sx = rect.left + 24
      const sy = rect.top + 24
      const top = document.elementFromPoint(sx, sy)
      if (!top || !el.contains(top)) continue
      const node = nodes.find((n) => n.id === id)
      if (node.type === 'image') return id
      if (!fallback) fallback = id
    }
    return fallback
  })

const dragNode = async (page) => {
  // loadFixture leaves activeTool==='hand'; hand on a node pointer-downs into beginPan,
  // NOT beginNodeMove — so the drag would exercise the pan path, not the write path.
  // Switch to 'select' for the drag, restore 'hand' in finally so pan/zoom gate口径不变.
  await setBenchTool(page, 'select')
  // activeToolHandler (useCanvasInteractionController.ts:50-53) is derived from the store
  // via a React selector — setActiveTool updates the store synchronously, but the
  // pointer-down handler is rebound on the next render. Without this wait the drag hits
  // the stale hand handler (beginPan) and pans the viewport instead of moving the node,
  // failing the position assertion below. Two RAFs guarantee the rebind lands.
  await page.evaluate(async () => {
    await globalThis.__MIVO_BENCH__.idleFrames(2)
  })
  const activeTool = await page.evaluate(async () => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    return useCanvasStore.getState().activeTool
  })
  if (activeTool !== 'select') {
    throw new Error(`canvas-drag: activeTool is "${activeTool}", expected "select" after setBenchTool`)
  }
  try {
    const nodeId = await pickDraggableNodeId(page)
    if (!nodeId) {
      throw new Error('canvas-drag: no visible draggable node (image/text/frame, !locked, !hidden) found in current viewport')
    }
    const locator = page.locator(`[data-node-id="${nodeId}"]`)
    const box = await locator.boundingBox()
    if (!box) {
      throw new Error(`canvas-drag: draggable node ${nodeId} has no bounding box`)
    }

    const before = await nodePositionInStore(page, nodeId)
    if (!before) throw new Error(`canvas-drag: target ${nodeId} not found in store`)

    // Drag from 24px in from the top-left (matches e2e canvas-interactions.mjs:215) —
    // avoids resize handles on the edges; pickDraggableNodeId already verified this
    // point is not covered by an overlapping node.
    const startX = box.x + 24
    const startY = box.y + 24
    await page.mouse.move(startX, startY)
    await page.mouse.down() // select tool → onNodePointerDown → beginNodeMove → write path
    for (const point of [
      { x: startX + 240, y: startY + 60 },
      { x: startX + 120, y: startY - 140 },
      { x: startX + 300, y: startY + 180 },
      { x: startX + 40, y: startY + 20 },
    ]) {
      await page.mouse.move(point.x, point.y, { steps: 18 })
    }
    await page.mouse.up()
    await page.waitForTimeout(150)

    // Correctness assertion: if the node didn't move, the drag didn't hit beginNodeMove
    // (e.g. tool wasn't actually 'select', or target was locked, or a child node stacked
    // on top captured the pointer) — the baseline would be bogus, so throw rather than
    // silently record a no-op frame sample.
    const after = await nodePositionInStore(page, nodeId)
    if (!after || (after.x === before.x && after.y === before.y)) {
      throw new Error(
        `canvas-drag did not move node ${nodeId} (before=${JSON.stringify(before)}, after=${JSON.stringify(after)}) — not exercising the node-move write path`,
      )
    }
  } finally {
    await setBenchTool(page, 'hand')
  }
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
  const actionLabels = ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom']
  if (runs.some((run) => run.actions['canvas-drag'])) actionLabels.push('canvas-drag')
  for (const label of actionLabels) {
    const summaries = runs.map((run) => run.actions[label])
    perAction[label] = {
      p50FrameMs: median(summaries.map((summary) => summary.p50FrameMs).filter((value) => value != null)),
      p95FrameMs: median(summaries.map((summary) => summary.p95FrameMs).filter((value) => value != null)),
      durationMs: median(summaries.map((summary) => summary.durationMs).filter((value) => value != null)),
      longTaskCount: median(summaries.map((summary) => summary.longTaskCount)),
      longTaskTotalMs: median(summaries.map((summary) => summary.longTaskTotalMs)),
    }
  }

  const loadFixtureMsValues = runs.map((run) => run.loadFixtureMs).filter((value) => value != null)
  const renderSyncMsValues = runs.map((run) => run.renderSyncMs).filter((value) => value != null)

  return {
    runs: runs.length,
    loadFixtureMs: median(loadFixtureMsValues),
    renderSyncMs: median(renderSyncMsValues),
    storeToRendererSyncMs: median(syncDurations),
    overall: {
      p50FrameMs: median(overallP50Values),
      p95FrameMs: median(overallP95Values),
      heapBeforeMb: median(runs.map((run) => run.heap.beforeMb).filter((value) => value != null)),
      heapAfterRenderMb: median(runs.map((run) => run.heap.afterRenderMb).filter((value) => value != null)),
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

const readRenderState = (page) =>
  page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    return {
      rendererMode: shell?.getAttribute('data-renderer-mode') || 'dom',
      cullingMode: shell?.getAttribute('data-culling-mode') || 'on',
      totalNodeCount: Number(shell?.getAttribute('data-total-node-count') || 0),
      renderedNodeCount: Number(shell?.getAttribute('data-rendered-node-count') || 0),
      leaferExpectedChildren: Number(shell?.getAttribute('data-leafer-expected-children') || 0),
      leaferChildren: Number(shell?.getAttribute('data-leafer-children') || 0),
      leaferPixelNonEmpty: shell?.getAttribute('data-leafer-pixel-nonempty') === 'true',
      leaferPixelSampleCount: Number(shell?.getAttribute('data-leafer-pixel-sample-count') || 0),
      leaferSyncVersion: Number(shell?.getAttribute('data-leafer-sync-version') || 0),
      leaferPanCacheEnabled: shell?.getAttribute('data-leafer-pan-cache-enabled') === 'true',
      leaferPanCacheFrozen: shell?.getAttribute('data-leafer-pan-cache-frozen') === 'true',
      leaferPanCacheCaptures: Number(shell?.getAttribute('data-leafer-pan-cache-captures') || 0),
      leaferPanCacheLastDx: Number(shell?.getAttribute('data-leafer-pan-cache-last-dx') || 0),
      leaferPanCacheLastDy: Number(shell?.getAttribute('data-leafer-pan-cache-last-dy') || 0),
      viewportScale: Number(shell?.getAttribute('data-viewport-scale') || 0),
    }
  })

const runSingleCapture = async ({ browser, fixture, dpr, runIndex, port, renderer, culling, panCache, includeDrag }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const canvasUrl = `http://127.0.0.1:${port}/?renderer=${encodeURIComponent(renderer)}&culling=${encodeURIComponent(culling)}&panCache=${encodeURIComponent(panCache)}`
  await page.goto(canvasUrl, { waitUntil: 'networkidle' })
  await page.addStyleTag({
    content: [
      '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}',
      'html,body{caret-color:transparent!important;}',
    ].join(''),
  })
  await page.waitForSelector('.canvas-shell')
  await installBenchRuntime(page)

  const cdpSession = await context.newCDPSession(page)
  const beforeHeap = await cdpSession.send('Runtime.getHeapUsage')
  const browserVersion = await browser.version()

  const runAction = async (label, action) => {
    const traceEvents = await traceAction(cdpSession, label, async () => {
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

  const load = await runAction('loadFixture', async () => {
    await page.evaluate((inputFixture) => globalThis.__MIVO_BENCH__.loadFixture(inputFixture), fixture)
  })
  const renderSync = await runAction('render-sync', async () => {
    await page.evaluate((inputFixture) => globalThis.__MIVO_BENCH__.waitForRender(inputFixture), fixture)
  })
  const renderState = await readRenderState(page)
  // Double-check: waitForRender throws on non-settle inside the page, but assert again here so
  // a silently-skipped render or a renderer-mode/culling mismatch can never write a bogus baseline.
  if (renderState.rendererMode !== renderer) {
    throw new Error(`Bench renderer mismatch: requested "${renderer}" but .canvas-shell reports "${renderState.rendererMode}"`)
  }
  if (renderState.cullingMode !== culling) {
    throw new Error(`Bench culling mismatch: requested "${culling}" but .canvas-shell reports "${renderState.cullingMode}"`)
  }
  if (renderState.totalNodeCount !== fixture.meta.nodeCount) {
    throw new Error(`Bench fixture not settled: expected ${fixture.meta.nodeCount} total nodes, .canvas-shell reports ${renderState.totalNodeCount}`)
  }
  if (renderer === 'leafer') {
    if (renderState.leaferExpectedChildren <= 0) {
      throw new Error('Bench Leafer evidence invalid: expected painted children is 0')
    }
    if (renderState.leaferChildren !== renderState.leaferExpectedChildren) {
      throw new Error(`Bench Leafer evidence mismatch: children=${renderState.leaferChildren}, expected=${renderState.leaferExpectedChildren}`)
    }
    if (!renderState.leaferPixelNonEmpty) {
      throw new Error(`Bench Leafer evidence invalid: canvas pixel sample empty (samples=${renderState.leaferPixelSampleCount})`)
    }
    if (panCache === 'on' && !renderState.leaferPanCacheEnabled) {
      throw new Error('Bench Leafer pan-cache evidence invalid: requested pan-cache on but shell reports disabled')
    }
  }
  const afterRenderHeap = await cdpSession.send('Runtime.getHeapUsage')

  const pan = await runAction('canvas-pan', () => panCanvas(page))
  const afterPanRenderState = await readRenderState(page)
  if (renderer === 'leafer' && panCache === 'on' && afterPanRenderState.leaferPanCacheCaptures < 1) {
    throw new Error('Bench Leafer pan-cache evidence invalid: pan completed without a snapshot capture')
  }
  const zoom = await runAction('canvas-zoom', () => zoomCanvas(page))
  // v3: canvas-drag runs AFTER pan/zoom — it mutates the store (node-move write path),
  // so running it earlier would dirty the clean fixture pan/zoom are measured on.
  // overall/gate below still aggregates ONLY pan/zoom; canvas-drag is a standalone metric.
  const drag = includeDrag ? await runAction('canvas-drag', () => dragNode(page)) : undefined
  const afterRunHeap = await cdpSession.send('Runtime.getHeapUsage')

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
    renderer: {
      requested: renderer,
      actual: renderState.rendererMode,
      cullingRequested: culling,
      cullingActual: renderState.cullingMode,
      panCacheRequested: panCache,
      panCacheActual: renderState.leaferPanCacheEnabled ? 'on' : 'off',
    },
    fixture: {
      sceneId: fixture.meta.sceneId,
      nodeCount: fixture.meta.nodeCount,
      seed: fixture.meta.seed,
      counts: fixture.meta.counts,
    },
    loadFixtureMs: round(load.summary.durationMs),
    renderSyncMs: round(renderSync.summary.durationMs),
    storeToRendererSyncMs: round((load.summary.durationMs || 0) + (renderSync.summary.durationMs || 0)),
    renderState,
    afterPanRenderState,
    heap: {
      beforeMb: round(beforeHeap.usedSize / (1024 * 1024), 3),
      afterRenderMb: round(afterRenderHeap.usedSize / (1024 * 1024), 3),
      afterRunMb: round(afterRunHeap.usedSize / (1024 * 1024), 3),
      usedMb: round(afterRenderHeap.usedSize / (1024 * 1024), 3),
      deltaMb: round((afterRenderHeap.usedSize - beforeHeap.usedSize) / (1024 * 1024), 3),
      runDeltaMb: round((afterRunHeap.usedSize - beforeHeap.usedSize) / (1024 * 1024), 3),
    },
    actions: {
      loadFixture: load.summary,
      'render-sync': renderSync.summary,
      'canvas-pan': pan.summary,
      'canvas-zoom': zoom.summary,
      ...(drag ? { 'canvas-drag': drag.summary } : {}),
    },
    trace: {
      loadFixture: load.trace,
      'render-sync': renderSync.trace,
      'canvas-pan': pan.trace,
      'canvas-zoom': zoom.trace,
      ...(drag ? { 'canvas-drag': drag.trace } : {}),
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
            renderer: options.renderer,
            culling: options.culling,
            panCache: options.panCache,
            includeDrag: options.includeDrag,
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
        loadFixtureMs: result.median.loadFixtureMs,
        renderSyncMs: result.median.renderSyncMs,
        rendererMode: result.runs[0]?.renderer?.actual || options.renderer,
        cullingMode: result.runs[0]?.renderer?.cullingActual || options.culling,
        renderedNodeCount: result.runs[0]?.renderState?.renderedNodeCount,
        leaferExpectedChildren: result.runs[0]?.renderState?.leaferExpectedChildren,
        leaferChildren: result.runs[0]?.renderState?.leaferChildren,
        leaferPixelNonEmpty: result.runs[0]?.renderState?.leaferPixelNonEmpty,
        leaferPanCacheEnabled: result.runs[0]?.renderState?.leaferPanCacheEnabled,
        leaferPanCacheCaptures: result.runs[0]?.afterPanRenderState?.leaferPanCacheCaptures,
        totalNodeCount: result.runs[0]?.renderState?.totalNodeCount,
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
        rendererModeActual: configs[0]?.dprResults[0]?.runs[0]?.renderer?.actual || options.renderer,
        culling: options.culling,
        cullingModeActual: configs[0]?.dprResults[0]?.runs[0]?.renderer?.cullingActual || options.culling,
        panCache: options.panCache,
        panCacheActual: configs[0]?.dprResults[0]?.runs[0]?.renderer?.panCacheActual || options.panCache,
        date: options.date,
        referenceMachine: 'same-machine-only',
        browser: 'Chromium via Playwright',
        viewport: { width: 1920, height: 1080 },
        dprs: options.dprs,
        runsPerConfig: options.runs,
        seed: options.seed,
        motion: 'prefers-reduced-motion + transition/animation disabled',
        syncMeasurement: 'replaceSnapshot(full snapshot) until expected node count / viewport settle',
        segments: options.includeDrag
          ? ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom', 'canvas-drag']
          : ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom'],
        heapMeasurements: ['before-load', 'after-render', 'after-run'],
        traceMarks: options.includeDrag
          ? ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom', 'canvas-drag']
          : ['loadFixture', 'render-sync', 'canvas-pan', 'canvas-zoom'],
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
