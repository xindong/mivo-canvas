/**
 * 坐标 probe scenario（Leafer 接入 PR-1 / Phase 0a 工装）。
 *
 * 在不同 zoom / pan / DPR 下，采样若干节点的四角/中心屏幕坐标
 * （getBoundingClientRect），输出 JSON artifact。
 *
 * text/connector 等非 Leafer 真画节点在 dom/leafer 两种模式都走 DOM；leafer
 * 模式额外记录 image/frame 的 Leafer probe screenRect，用来定位 DOM 坐标一致但真画几何偏移的问题。
 *
 * probe 性质：不断言精确值，仅校验采样到足够节点 + viewport 已推进，
 * 避免空跑。zoom/pan 驱动用真实交互（Ctrl+wheel / hand-drag），actual
 * viewport 随同采样记录，后续对照以 actual 为准。
 */

const SAMPLE_NODE_LIMIT = 6
const ARTIFACT_PATH = 'test-artifacts/coordinate-probe.json'

const round = (value, digits = 3) => (value == null ? null : Number(value.toFixed(digits)))

const readViewport = async (page) =>
  page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    return {
      scale: Number(shell?.getAttribute('data-viewport-scale') || 0),
      x: Number(shell?.getAttribute('data-viewport-x') || 0),
      y: Number(shell?.getAttribute('data-viewport-y') || 0),
      rendererMode: shell?.getAttribute('data-renderer-mode') || 'dom',
      totalNodeCount: Number(shell?.getAttribute('data-total-node-count') || 0),
    }
  })

const sampleNodes = async (page) => {
  const shellBox = await page.locator('.canvas-shell').boundingBox()
  const sample = await page.evaluate((limit) => {
    const preferred = Array.from(
      document.querySelectorAll(
        [
          '.dom-node[data-node-type="text"]',
          '.dom-node[data-node-type="connector"]',
          '.dom-node[data-node-type="task-placeholder"]',
          '.dom-node[data-node-type="ai-slot"]',
          '.dom-node:not([data-node-type="image"]):not([data-node-type="frame"]):not([data-markup-kind="rect"])',
        ].join(','),
      ),
    )
    const elements = (preferred.length >= 3 ? preferred : Array.from(document.querySelectorAll('.dom-node'))).slice(0, limit)
    const sampleKind = preferred.length >= 3 ? 'dom-non-painted' : 'dom-all-fallback'
    return elements.map((element) => {
      const id = element.getAttribute('data-node-id') || element.getAttribute('data-id') || null
      const rect = element.getBoundingClientRect()
      return {
        id,
        sampleKind,
        nodeType: element.getAttribute('data-node-type'),
        markupKind: element.getAttribute('data-markup-kind'),
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        corners: {
          topLeft: { x: rect.left, y: rect.top },
          topRight: { x: rect.right, y: rect.top },
          bottomLeft: { x: rect.left, y: rect.bottom },
          bottomRight: { x: rect.right, y: rect.bottom },
          center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        },
      }
    })
  }, SAMPLE_NODE_LIMIT)
  const viewport = await readViewport(page)
  const leafer = await page.evaluate(() => {
    const stats = window.__MIVO_LEAFER_SPIKE__?.getStats?.() || null
    const paintedNodes = window.__MIVO_LEAFER_SPIKE__?.getPaintedNodes?.().slice(0, 6) || []
    return { stats, paintedNodes }
  })
  return { viewport, shellBox, nodeCount: sample.length, nodes: sample, leafer }
}

const wheelZoom = async (page, steps, direction) => {
  const shell = page.locator('.canvas-shell')
  const box = await shell.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  try {
    for (let i = 0; i < steps; i += 1) {
      await page.mouse.wheel(0, direction > 0 ? -140 : 140)
      await page.waitForTimeout(40)
    }
  } finally {
    await page.keyboard.up('Control')
  }
  await page.waitForTimeout(120)
}

const handPan = async (page, dx, dy) => {
  const shell = page.locator('.canvas-shell')
  const box = await shell.boundingBox()
  const startX = box.x + box.width * 0.5
  const startY = box.y + box.height * 0.5
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}

const probeSequence = async (page, labelPrefix) => {
  const results = []
  // Baseline at default viewport (scale ~1 after load).
  results.push({ label: `${labelPrefix}-baseline`, ...(await sampleNodes(page)) })
  // Zoom in twice.
  await wheelZoom(page, 4, 1)
  results.push({ label: `${labelPrefix}-zoom-in-1`, ...(await sampleNodes(page)) })
  await wheelZoom(page, 6, 1)
  results.push({ label: `${labelPrefix}-zoom-in-2`, ...(await sampleNodes(page)) })
  // Zoom out toward small scale.
  await wheelZoom(page, 12, -1)
  results.push({ label: `${labelPrefix}-zoom-out`, ...(await sampleNodes(page)) })
  // Pan at this zoom.
  await handPan(page, 160, -100)
  results.push({ label: `${labelPrefix}-pan`, ...(await sampleNodes(page)) })
  return results
}

const serialize = (results) =>
  results.map((r) => ({
    label: r.label,
    viewport: r.viewport,
    shellBox: r.shellBox,
    nodeCount: r.nodeCount,
    leafer: r.leafer,
    nodes: (r.nodes || []).map((node) => ({
      id: node.id,
      sampleKind: node.sampleKind,
      nodeType: node.nodeType,
      markupKind: node.markupKind,
      rect: node.rect,
      corners: Object.fromEntries(
        Object.entries(node.corners).map(([key, point]) => [key, { x: round(point.x), y: round(point.y) }]),
      ),
    })),
  }))

export const runCoordinateProbeScenario = async (context) => {
  const { page, browser, canvasUrl, baseUrl } = context
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const dpr1Results = await probeSequence(page, 'dpr1')

  // DPR 2 probe (new context; subset to keep runtime bounded).
  let dpr2Results = []
  let dpr2Error = null
  try {
    const dpr2Context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, colorScheme: 'light' })
    const dpr2Page = await dpr2Context.newPage()
    await dpr2Page.emulateMedia({ reducedMotion: 'reduce' })
    await dpr2Page.goto(canvasUrl || baseUrl, { waitUntil: 'networkidle' })
    await dpr2Page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}' })
    await dpr2Page.waitForSelector('.canvas-shell')
    if (context.rendererMode === 'leafer') {
      await dpr2Page.waitForFunction(() => {
        const shell = document.querySelector('.canvas-shell')
        const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
        const children = Number(shell?.getAttribute('data-leafer-children') || 0)
        return expected > 0 && children === expected && shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
      }, { timeout: 15000 })
    } else {
      await dpr2Page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
    }
    await dpr2Page.waitForTimeout(300)
    dpr2Results = await probeSequence(dpr2Page, 'dpr2')
    await dpr2Context.close()
  } catch (error) {
    dpr2Error = error instanceof Error ? error.message : String(error)
  }

  const artifact = {
    protocol: {
      scenario: 'coordinate-probe',
      renderer: context.rendererMode,
      dprValues: [1, 2],
      note: 'text/connector 等非 Leafer 真画节点两模式都走 DOM；坐标应逐像素一致。Leafer 模式额外记录真画节点 probe rect。',
      sampleNodeLimit: SAMPLE_NODE_LIMIT,
    },
    dpr1: serialize(dpr1Results),
    dpr2: dpr2Error ? { error: dpr2Error } : serialize(dpr2Results),
  }

  const artifactDir = path.resolve(process.cwd(), 'test-artifacts')
  await fs.mkdir(artifactDir, { recursive: true })
  const artifactFile = `coordinate-probe-${context.rendererMode}.json`
  await fs.writeFile(path.join(artifactDir, artifactFile), `${JSON.stringify(artifact, null, 2)}\n`)

  // Framework self-check: baseline DPR=1 must sample >=3 nodes and have a non-zero viewport scale.
  const baseline = dpr1Results[0]
  const leaferPaintedCount = baseline?.leafer?.stats?.children || 0
  if (!baseline || (baseline.nodeCount < 3 && leaferPaintedCount < 3)) {
    throw new Error(
      `Coordinate probe framework check failed: expected >=3 sampled DOM nodes or Leafer painted nodes at DPR=1 baseline, `
      + `got dom=${baseline?.nodeCount ?? 0} leafer=${leaferPaintedCount}`,
    )
  }
  if (!baseline.viewport.scale || baseline.viewport.scale <= 0) {
    throw new Error(`Coordinate probe framework check failed: viewport scale not reported (${baseline.viewport.scale})`)
  }
  if (dpr2Error) {
    throw new Error(`Coordinate probe DPR=2 context failed: ${dpr2Error}`)
  }
}
