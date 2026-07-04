export const runMaskScenario = async (context) => {
  const { canvasStoreSpec, horizontalMaskSourceB64, mivoEditRequests, page, readCanvasState, waitForCanvasState } = context

  const assertMaskFloatingControlsSeparated = async () => {
    const layout = await page.evaluate(() => {
      const boundsFor = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return undefined
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        }
      }
      const toolbar = boundsFor('.image-mask-edit-toolbar')
      const prompt = boundsFor('.image-mask-edit-prompt')
      const overlaps =
        toolbar &&
        prompt &&
        !(toolbar.right <= prompt.left || prompt.right <= toolbar.left || toolbar.bottom <= prompt.top || prompt.bottom <= toolbar.top)

      return { toolbar, prompt, overlaps: Boolean(overlaps) }
    })

    if (!layout.toolbar || !layout.prompt || layout.overlaps) {
      throw new Error(`Mask floating toolbar and prompt should not overlap: ${JSON.stringify(layout)}`)
    }
  }

  const addHorizontalMaskSource = async () => {
    const spec = await canvasStoreSpec()
    return page.evaluate(async ({ moduleSpec, assetUrl }) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().addImportedImage(assetUrl, 'E2E horizontal mask source', 'source', { x: -280, y: 260 }, {
        dimensions: { width: 1600, height: 900 },
        mimeType: 'image/svg+xml',
        originalName: 'e2e-horizontal-mask-source.svg',
      })
      return useCanvasStore.getState().selectedNodeId
    }, { moduleSpec: spec, assetUrl: horizontalMaskSourceB64 })
  }

  // rev4: box/brush tools removed — local repaint is point-select only. One click
  // drops a circular region (radius = 8% of the source's short edge), replacing the
  // old drag-to-draw box/brush interaction.
  const drawPointRegion = async () => {
    const stage = await page.locator('.image-mask-edit-stage').boundingBox()
    if (!stage) throw new Error('Mask edit stage should be visible')
    await page.mouse.click(stage.x + stage.width * 0.52, stage.y + stage.height * 0.5)
  }

  const imageCountFor = (state) => state.nodes.filter((node) => node.type === 'image').length
  const verifyMaskEditFlow = async ({ sourceNodeId, sourceLabel }) => {
    await page.locator(`[data-node-id="${sourceNodeId}"]`).click()
    await page.waitForSelector('.selection-quick-toolbar')
    await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
    await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
    await page.waitForSelector('.image-mask-edit-stage')
    await assertMaskFloatingControlsSeparated()
    // Point tool is the only tool and the default; click it explicitly for robustness.
    await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '点选', exact: true }).click()
    await drawPointRegion()
    await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
    const regionCount = Number(await page.locator('.image-mask-edit-overlay').getAttribute('data-region-count'))
    const maskRegionCount = Number(await page.locator('.image-mask-edit-overlay').getAttribute('data-mask-region-count'))
    const pointAnchorCount = Number(await page.locator('.image-mask-edit-overlay').getAttribute('data-point-anchor-count'))
    const before = await readCanvasState()
    const beforeSourceEditEdges = before.edges.filter((edge) => edge.from === sourceNodeId && edge.type === 'edit').length
    const editRequestCountBefore = mivoEditRequests.length
    await page.locator('.image-mask-edit-prompt textarea').fill(`E2E ${sourceLabel} point repaint`)

    // rev4: a point click now yields a circular mask region (no block); submit issues
    // the sync /api/mivo/edit request carrying image + mask.
    const editResponse = page.waitForResponse((response) => response.url().includes('/api/mivo/edit') && response.status() === 200)
    await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
    await editResponse
    await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
    await waitForCanvasState(
      (state, payload) =>
        state.nodes.filter((node) => node.type === 'image').length >= payload.minImageCount &&
        state.edges.length >= payload.minEdgeCount,
      {
        minImageCount: imageCountFor(before) + 1,
        minEdgeCount: before.edges.length + 1,
      },
    )
    const after = await readCanvasState()
    const editEdges = after.edges.filter((edge) => edge.from === sourceNodeId && edge.type === 'edit')
    const resultNode = after.nodes.find((node) => editEdges.some((edge) => edge.to === node.id))
    const latestRequest = mivoEditRequests.at(-1)

    if (mivoEditRequests.length !== editRequestCountBefore + 1) {
      throw new Error(`${sourceLabel}/point should issue exactly one edit request`)
    }
    if (maskRegionCount < 1) {
      throw new Error(`${sourceLabel}/point should create at least one circular mask region, got ${maskRegionCount}`)
    }
    if (pointAnchorCount !== 0) {
      throw new Error(`${sourceLabel}/point should not leave standalone point anchors (region is a circle), got ${pointAnchorCount}`)
    }
    if (!latestRequest?.fileKeys.includes('image:1')) {
      throw new Error(`${sourceLabel}/point edit request should include image: ${JSON.stringify(latestRequest)}`)
    }
    if (!latestRequest.fileKeys.includes('mask:1')) {
      throw new Error(`${sourceLabel}/point edit request should include mask: ${JSON.stringify(latestRequest)}`)
    }
    if (!after.nodes.some((node) => node.id === sourceNodeId && node.type === 'image')) {
      throw new Error(`${sourceLabel}/point should keep the source image`)
    }
    if (imageCountFor(after) < imageCountFor(before) + 1) {
      throw new Error(`${sourceLabel}/point should create a new image node`)
    }
    if (editEdges.length < beforeSourceEditEdges + 1 || !resultNode) {
      throw new Error(`${sourceLabel}/point should create a derived edit edge`)
    }

    return {
      source: sourceLabel,
      regionCount,
      maskRegionCount,
      pointAnchorCount,
      imagesBefore: imageCountFor(before),
      imagesAfter: imageCountFor(after),
      editEdgesFromSource: editEdges.length,
      requestFiles: latestRequest.fileKeys,
    }
  }

  await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/src/store/canvasStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/canvasStore.ts'
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  })
  await page.waitForSelector('[data-node-id="ref-hero"]')
  const horizontalMaskSourceId = await addHorizontalMaskSource()
  if (!horizontalMaskSourceId) throw new Error('Horizontal mask source should be created')

  const maskEditSmokeResults = []
  for (const source of [
    { sourceNodeId: 'ref-hero', sourceLabel: 'vertical' },
    { sourceNodeId: horizontalMaskSourceId, sourceLabel: 'horizontal' },
  ]) {
    maskEditSmokeResults.push(await verifyMaskEditFlow(source))
  }
  if (maskEditSmokeResults.some((result) => result.regionCount < 1)) {
    throw new Error(`Mask edit smoke should mark at least one region per source: ${JSON.stringify(maskEditSmokeResults)}`)
  }

  // Assert mask-edit notice persisted in chatStore after local repaint
  const maskNoticeCount = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('mivo-chat-demo')
      if (!raw) return 0
      const parsed = JSON.parse(raw)
      const byScene = parsed?.state?.messagesByScene ?? {}
      return Object.values(byScene).flat().filter((m) => m.kind === 'notice' && m.origin === 'mask-edit').length
    } catch {
      return 0
    }
  })
  if (maskNoticeCount < 1) {
    throw new Error(`chatStore should contain at least one mask-edit notice after local repaint, got ${maskNoticeCount}`)
  }
}
