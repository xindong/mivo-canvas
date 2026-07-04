// scripts/e2e/scenarios/mask-point.mjs
// rev4 变更 6：局部重绘只留点选（圆形区）。本场景验证点选工具的 UI 与交互（无生成）：
//  SC6.1 工具条只有"点选"，无框选/涂抹；默认 tool=point
//  SC6.2 点一下 → 生成圆形 region，不被拦截、无"请框选或涂抹"提示、提交按钮可用
//  SC6.6 多次点选叠加多个圆形区；undo/redo/clear 正常
//
// SC6.3（点选提交→占位符→成功替换/失败消失）由 mask-reflow.mjs 的 SC4.x（成功）+
// SC5.3（失败）以点选驱动覆盖，此处不再重复生成。

const regionCounts = async (page) =>
  page.evaluate(() => {
    const overlay = document.querySelector('.image-mask-edit-overlay')
    return {
      region: Number(overlay?.getAttribute('data-region-count') || '0'),
      mask: Number(overlay?.getAttribute('data-mask-region-count') || '0'),
      point: Number(overlay?.getAttribute('data-point-anchor-count') || '0'),
    }
  })

// Each point click commits a region on pointerdown. Move to the target then down/up.
const clickStage = async (page, fx, fy) => {
  const stage = await page.locator('.image-mask-edit-stage').boundingBox()
  if (!stage) throw new Error('Mask edit stage should be visible')
  await page.mouse.move(stage.x + stage.width * fx, stage.y + stage.height * fy)
  await page.mouse.down()
  await page.mouse.up()
}

// Add exactly one circular region by clicking. Successive synthetic clicks on the
// canvas occasionally drop a pointerdown, so retry ONLY while the region count is
// unchanged (a landed click increments by exactly 1 — never double-adds on retry).
const addPointRegion = async (page, fx, fy, { attempts = 6 } = {}) => {
  const before = (await regionCounts(page)).region
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await clickStage(page, fx, fy)
    const deadline = Date.now() + 700
    while (Date.now() < deadline) {
      const now = (await regionCounts(page)).region
      if (now === before + 1) return before + 1
      if (now > before + 1) throw new Error(`click added more than one region (${before} → ${now})`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  throw new Error(`Point click failed to add a region after ${attempts} attempts (stuck at ${before})`)
}

const waitForRegionCount = async (page, expected, { timeout = 5000 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await regionCounts(page)).region === expected) return
    await new Promise((r) => setTimeout(r, 50))
  }
  const last = await regionCounts(page)
  throw new Error(`Timed out waiting for region-count=${expected}, last=${JSON.stringify(last)}`)
}

export const runMaskPointScenario = async (context) => {
  const { page, canvasStoreSpec } = context
  const spec = await canvasStoreSpec()

  const dockMaskButton = page.locator('.canvas-tool-dock').getByRole('button', { name: '局部重绘' })

  // P2 — no selected image and no image on canvas: dock entry stays enabled, warns, and does not arm.
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const { useToastStore } = await import('/src/store/toastStore.ts')
    useCanvasStore.getState().createCanvas('E2E Mask Point Empty')
    useCanvasStore.getState().selectNode(undefined)
    useToastStore.getState().clearToasts()
  }, spec)
  await dockMaskButton.click()
  await page.waitForFunction(() => {
    const armed = document.querySelector('.canvas-shell')?.classList.contains('mask-armed')
    const warning = Array.from(document.querySelectorAll('.toast-item.warning .toast-message')).some((item) =>
      /画布上还没有图片/.test(item.textContent || ''),
    )
    return !armed && warning
  })

  // Fresh canvas with one real (loadable) image to open the mask editor onto.
  const imageId = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().createCanvas('E2E Mask Point')
    useCanvasStore.getState().addImportedImage('/demo-assets/courage-1.jpg', 'point-source', 'source', { x: 0, y: 0 }, {
      dimensions: { width: 320, height: 320 },
      mimeType: 'image/jpeg',
      originalName: 'point-source.jpg',
    })
    const state = useCanvasStore.getState()
    const node = state.nodes[state.nodes.length - 1]
    useCanvasStore.getState().selectNode(undefined)
    return node.id
  }, spec)

  // P3 — no selection: dock click arms, image click selects + opens overlay + drops the first point.
  await dockMaskButton.click()
  await page.waitForFunction(() => document.querySelector('.canvas-shell')?.classList.contains('mask-armed'))
  const armedButtonActive = await dockMaskButton.evaluate((button) => button.classList.contains('active'))
  if (!armedButtonActive) throw new Error('P3: dock mask button should be active while point selection is armed')
  const nodeBox = await page.locator(`[data-node-id="${imageId}"]`).boundingBox()
  if (!nodeBox) throw new Error('P3: source image node should be visible')
  await page.mouse.click(nodeBox.x + nodeBox.width * 0.5, nodeBox.y + nodeBox.height * 0.5)
  await page.waitForSelector('.image-mask-edit-stage')
  await waitForRegionCount(page, 1)
  const armedState = await page.evaluate(() => {
    const overlay = document.querySelector('.image-mask-edit-overlay')
    return {
      armed: document.querySelector('.canvas-shell')?.classList.contains('mask-armed'),
      selectedNodeId: document.querySelector('.dom-node.selected')?.getAttribute('data-node-id'),
      region: Number(overlay?.getAttribute('data-region-count') || '0'),
      mask: Number(overlay?.getAttribute('data-mask-region-count') || '0'),
      point: Number(overlay?.getAttribute('data-point-anchor-count') || '0'),
      markers: document.querySelectorAll('.image-mask-edit-stage svg .image-mask-edit-point-marker').length,
      rings: document.querySelectorAll('.image-mask-edit-stage svg .image-mask-edit-point-ring').length,
    }
  })
  if (armedState.armed || armedState.selectedNodeId !== imageId || armedState.mask !== 1 || armedState.point !== 0) {
    throw new Error(`P3: armed image click should select image, open mask edit, and consume one mask region: ${JSON.stringify(armedState)}`)
  }
  if (armedState.markers < 1 || armedState.rings < 1) {
    throw new Error(`P3: initial point should render marker + radius ring: ${JSON.stringify(armedState)}`)
  }
  await page.locator('.image-mask-edit-history').getByRole('button', { name: 'Cancel mask edit' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' }).catch(() => {})

  await page.locator(`[data-node-id="${imageId}"]`).click()
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
  await page.waitForSelector('.image-mask-edit-stage')

  // ── SC6.1 — toolbar exposes only 点选; default tool=point ──
  const toolInfo = await page.evaluate(() => {
    const tools = Array.from(document.querySelectorAll('.image-mask-edit-tools button'))
    return {
      labels: tools.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()),
      activeLabels: tools.filter((b) => b.classList.contains('active')).map((b) => (b.getAttribute('aria-label') || '').trim()),
    }
  })
  if (toolInfo.labels.length !== 1 || toolInfo.labels[0] !== '点选') {
    throw new Error(`SC6.1: toolbar should expose only 点选, got ${JSON.stringify(toolInfo.labels)}`)
  }
  if (toolInfo.labels.some((l) => l === '框选' || l === '涂抹')) {
    throw new Error(`SC6.1: 框选/涂抹 tools should be removed, got ${JSON.stringify(toolInfo.labels)}`)
  }
  if (toolInfo.activeLabels[0] !== '点选') {
    throw new Error(`SC6.1: point tool should be active by default, got ${JSON.stringify(toolInfo.activeLabels)}`)
  }

  // ── SC6.2 — one click → circular region, no block, submit enabled ──
  await addPointRegion(page, 0.5, 0.5)
  const afterClick = await regionCounts(page)
  if (afterClick.mask < 1) {
    throw new Error(`SC6.2: point click should create a circular mask region, got ${JSON.stringify(afterClick)}`)
  }
  if (afterClick.point !== 0) {
    throw new Error(`SC6.2: point click should not leave a standalone point anchor (it is a circle region), got ${JSON.stringify(afterClick)}`)
  }
  // 回归守卫（bug: 单点 brush 渲染成单点 polyline → 无任何可见反馈）：点选后
  // stage SVG 里必须出现紫色 marker 与真实半径圆环。
  const visiblePointFeedback = await page.evaluate(() => ({
    markers: document.querySelectorAll('.image-mask-edit-stage svg .image-mask-edit-point-marker').length,
    rings: document.querySelectorAll('.image-mask-edit-stage svg .image-mask-edit-point-ring').length,
  }))
  if (visiblePointFeedback.markers < 1 || visiblePointFeedback.rings < 1) {
    throw new Error(`SC6.2: point click should render marker + radius ring feedback, got ${JSON.stringify(visiblePointFeedback)}`)
  }
  const blocked = await page.evaluate(() => {
    const err = document.querySelector('.image-mask-edit-error')?.textContent || ''
    return { errText: err, hasBlockMsg: /请框选或涂抹/.test(err) }
  })
  if (blocked.hasBlockMsg) {
    throw new Error(`SC6.2: removed guard should not show "请框选或涂抹" prompt, got ${JSON.stringify(blocked.errText)}`)
  }
  // Fill a prompt and confirm the 局部重绘 submit button is enabled (hasAnyAnchor).
  await page.locator('.image-mask-edit-prompt textarea').fill('E2E point region enabled')
  const submitDisabled = await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).isDisabled()
  if (submitDisabled) throw new Error('SC6.2: submit should be enabled after a point region + prompt')

  // ── SC6.6 — multiple circular regions stack; undo/redo/clear work ──
  // Keep clicks central (on the image, clear of the floating toolbar/prompt panels).
  await addPointRegion(page, 0.44, 0.48)
  await waitForRegionCount(page, 2)
  await addPointRegion(page, 0.56, 0.48)
  await waitForRegionCount(page, 3)

  // SC6.6 scope (per plan §8): 多次点选叠加多个圆形区 + clear/undo 正常.
  // undo: 3 → 2.
  await page.locator('.image-mask-edit-history').getByRole('button', { name: 'Undo mask region' }).click()
  await waitForRegionCount(page, 2)
  // clear: → 0.
  await page.locator('.image-mask-edit-history').getByRole('button', { name: 'Clear mask regions' }).click()
  await waitForRegionCount(page, 0)

  // Tear down the overlay so the shared page is clean for the next scenario.
  await page.locator('.image-mask-edit-history').getByRole('button', { name: 'Cancel mask edit' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' }).catch(() => {})
}
