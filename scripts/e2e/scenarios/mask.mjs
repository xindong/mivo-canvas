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

  const drawMaskRegion = async (toolId) => {
    const stage = await page.locator('.image-mask-edit-stage').boundingBox()
    if (!stage) throw new Error('Mask edit stage should be visible')

    if (toolId === 'point') {
      await page.mouse.click(stage.x + stage.width * 0.52, stage.y + stage.height * 0.5)
      return
    }

    if (toolId === 'box') {
      await page.mouse.move(stage.x + stage.width * 0.38, stage.y + stage.height * 0.42)
      await page.mouse.down()
      await page.mouse.move(stage.x + stage.width * 0.65, stage.y + stage.height * 0.6, { steps: 8 })
      await page.mouse.up()
      return
    }

    await page.mouse.move(stage.x + stage.width * 0.34, stage.y + stage.height * 0.42)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width * 0.45, stage.y + stage.height * 0.48, { steps: 4 })
    await page.mouse.move(stage.x + stage.width * 0.58, stage.y + stage.height * 0.54, { steps: 4 })
    await page.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.58, { steps: 4 })
    await page.mouse.up()
  }

  const imageCountFor = (state) => state.nodes.filter((node) => node.type === 'image').length
  const verifyMaskEditFlow = async ({ sourceNodeId, sourceLabel, toolId, toolLabel }) => {
    await page.locator(`[data-node-id="${sourceNodeId}"]`).click()
    await page.waitForSelector('.selection-quick-toolbar')
    await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
    await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
    await page.waitForSelector('.image-mask-edit-stage')
    await assertMaskFloatingControlsSeparated()
    await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: toolLabel, exact: true }).click()
    await drawMaskRegion(toolId)
    await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
    const regionCount = Number(await page.locator('.image-mask-edit-overlay').getAttribute('data-region-count'))
    const maskRegionCount = Number(await page.locator('.image-mask-edit-overlay').getAttribute('data-mask-region-count'))
    const pointAnchorCount = Number(await page.locator('.image-mask-edit-overlay').getAttribute('data-point-anchor-count'))
    const before = await readCanvasState()
    const beforeSourceEditEdges = before.edges.filter((edge) => edge.from === sourceNodeId && edge.type === 'edit').length
    const editRequestCountBefore = mivoEditRequests.length
    await page.locator('.image-mask-edit-prompt textarea').fill(`E2E ${sourceLabel} ${toolId} repaint`)
    if (toolId === 'point') {
      await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
      await page.locator('.image-mask-edit-error').getByText('请框选或涂抹要重绘的区域。').waitFor()
      const after = await readCanvasState()
      const editEdges = after.edges.filter((edge) => edge.from === sourceNodeId && edge.type === 'edit')

      if (mivoEditRequests.length !== editRequestCountBefore) {
        throw new Error(`${sourceLabel}/${toolId} should not issue an edit request without a mask region`)
      }
      if (maskRegionCount !== 0 || pointAnchorCount < 1) {
        throw new Error(`${sourceLabel}/${toolId} should keep point anchors out of mask regions: ${JSON.stringify({ maskRegionCount, pointAnchorCount })}`)
      }
      if (imageCountFor(after) !== imageCountFor(before)) {
        throw new Error(`${sourceLabel}/${toolId} should not create a new image node when blocked`)
      }
      if (editEdges.length !== beforeSourceEditEdges) {
        throw new Error(`${sourceLabel}/${toolId} should not create a derived edit edge when blocked`)
      }

      await page.locator('.image-mask-edit-history').getByRole('button', { name: 'Cancel mask edit' }).click()
      await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })

      return {
        source: sourceLabel,
        tool: toolId,
        regionCount,
        maskRegionCount,
        pointAnchorCount,
        imagesBefore: imageCountFor(before),
        imagesAfter: imageCountFor(after),
        editEdgesFromSource: editEdges.length,
        requestFiles: [],
      }
    }

    // P2-C1b: the mask-edit path (MivoCanvas submitMaskEdit) still uses the sync
    // /api/mivo/edit route (out of generationSlice scope); wait for its 200. The
    // substring '/api/mivo/edit' does not match '/api/mivo/tasks/edit'.
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
      throw new Error(`${sourceLabel}/${toolId} should issue exactly one edit request`)
    }
    if (maskRegionCount < 1) {
      throw new Error(`${sourceLabel}/${toolId} should create at least one mask region`)
    }
    if (!latestRequest?.fileKeys.includes('image:1')) {
      throw new Error(`${sourceLabel}/${toolId} edit request should include image: ${JSON.stringify(latestRequest)}`)
    }
    if (!latestRequest.fileKeys.includes('mask:1')) {
      throw new Error(`${sourceLabel}/${toolId} edit request should include mask: ${JSON.stringify(latestRequest)}`)
    }
    if (!after.nodes.some((node) => node.id === sourceNodeId && node.type === 'image')) {
      throw new Error(`${sourceLabel}/${toolId} should keep the source image`)
    }
    if (imageCountFor(after) < imageCountFor(before) + 1) {
      throw new Error(`${sourceLabel}/${toolId} should create a new image node`)
    }
    if (editEdges.length < beforeSourceEditEdges + 1 || !resultNode) {
      throw new Error(`${sourceLabel}/${toolId} should create a derived edit edge`)
    }

    return {
      source: sourceLabel,
      tool: toolId,
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
    for (const tool of [
      { toolId: 'point', toolLabel: '点选' },
      { toolId: 'box', toolLabel: '框选' },
      { toolId: 'brush', toolLabel: '涂抹' },
    ]) {
      maskEditSmokeResults.push(await verifyMaskEditFlow({ ...source, ...tool }))
    }
  }
  if (maskEditSmokeResults.some((result) => result.regionCount < 1)) {
    throw new Error(`Mask edit smoke should mark at least one region per tool: ${JSON.stringify(maskEditSmokeResults)}`)
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
