export const runCanvasInteractionsScenario = async (context) => {
  const { canvasStoreSpec, nearlyEqual, page, wait } = context
  const initialCount = context.initialCount ?? await page.locator('.dom-node').count()
  const shortcutModifier = process.platform === 'darwin'
    ? { metaKey: true, ctrlKey: false }
    : { metaKey: false, ctrlKey: true }
  const pressCanvasShortcut = async (key, { shiftKey = false } = {}) => {
    await page.locator('.canvas-shell').click({ position: { x: 32, y: 32 }, force: true })
    await page.evaluate(
      ({ keyValue, metaKey, ctrlKey, shiftKey: shortcutShiftKey }) => {
        const code = keyValue.length === 1 ? `Key${keyValue.toUpperCase()}` : keyValue
        const eventInit = {
          key: keyValue,
          code,
          metaKey,
          ctrlKey,
          shiftKey: shortcutShiftKey,
          bubbles: true,
          cancelable: true,
        }
        window.dispatchEvent(new KeyboardEvent('keydown', eventInit))
        window.dispatchEvent(new KeyboardEvent('keyup', eventInit))
      },
      { keyValue: key, shiftKey, ...shortcutModifier },
    )
  }

  const firstNode = page.locator('.dom-node').first()
  const firstNodeId = await firstNode.getAttribute('data-node-id')
  if (!firstNodeId) throw new Error('Canvas node should expose a stable data-node-id')
  const secondImageNodeId = await page.locator('.dom-node').nth(1).getAttribute('data-node-id')
  if (!secondImageNodeId) throw new Error('Canvas should expose a second image node for interaction checks')
  const selectedNode = page.locator(`[data-node-id="${firstNodeId}"]`)
  const secondImageNode = page.locator(`[data-node-id="${secondImageNodeId}"]`)
  const canvasNodeInfoCount = await page.locator('.dom-node-footer, .favorite-dot').count()
  if (canvasNodeInfoCount !== 0) throw new Error('Canvas image nodes should not show footer or badge metadata')

  await selectedNode.click()
  const dialogAfterSingleClick = await page.locator('.details-dialog').count()
  if (dialogAfterSingleClick !== 0) throw new Error('Single click should not open the details dialog')

  await page.waitForSelector('.node-handle.nw')
  const singleHandleStyle = await page.locator('.node-handle.nw').evaluate((handle) => {
    const style = getComputedStyle(handle)

    return {
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      width: style.width,
      height: style.height,
    }
  })
  if (singleHandleStyle.borderRadius !== '4px' || singleHandleStyle.width !== singleHandleStyle.height) {
    throw new Error(`Single-selection handles should use the square multi-selection style: ${JSON.stringify(singleHandleStyle)}`)
  }
  const singleHandleAlignment = await page.locator('.dom-node.selected').first().evaluate((node) => {
    const nodeRect = node.getBoundingClientRect()
    const readHandle = (corner) => {
      const handle = node.querySelector(`.node-handle.${corner}`)
      const rect = handle?.getBoundingClientRect()
      return rect
        ? {
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
          }
        : undefined
    }

    return {
      nodeRect: {
        left: nodeRect.left,
        top: nodeRect.top,
        right: nodeRect.right,
        bottom: nodeRect.bottom,
      },
      nw: readHandle('nw'),
      ne: readHandle('ne'),
      sw: readHandle('sw'),
      se: readHandle('se'),
    }
  })
  for (const [corner, expected] of [
    ['nw', { x: singleHandleAlignment.nodeRect.left, y: singleHandleAlignment.nodeRect.top }],
    ['ne', { x: singleHandleAlignment.nodeRect.right, y: singleHandleAlignment.nodeRect.top }],
    ['sw', { x: singleHandleAlignment.nodeRect.left, y: singleHandleAlignment.nodeRect.bottom }],
    ['se', { x: singleHandleAlignment.nodeRect.right, y: singleHandleAlignment.nodeRect.bottom }],
  ]) {
    const handle = singleHandleAlignment[corner]
    if (!handle || !nearlyEqual(handle.centerX, expected.x, 1) || !nearlyEqual(handle.centerY, expected.y, 1)) {
      throw new Error(`Single-selection ${corner} handle should be centered on its corner: ${JSON.stringify(singleHandleAlignment)}`)
    }
  }

  await page.waitForSelector('.selection-quick-toolbar')
  if ((await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Details' }).count()) !== 0) {
    throw new Error('Image selection quick toolbar should rely on double-click for details')
  }
  for (const action of ['Crop', 'AI Edit']) {
    if ((await page.locator('.selection-quick-toolbar').getByRole('button', { name: action }).count()) !== 1) {
      throw new Error(`Image selection quick toolbar should expose ${action}`)
    }
  }
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
  for (const action of ['Edit with prompt', 'Select area', 'Remove background', 'Expand', 'Boost resolution']) {
    if ((await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Image AI Edit quick menu should expose ${action}`)
    }
  }
  await page.keyboard.press('Escape')
  await page.waitForSelector('.selection-quick-toolbar-menu', { state: 'detached' })
  const imageQuickToolbarStyle = await page.locator('.selection-quick-toolbar').evaluate((toolbar) => {
    const style = getComputedStyle(toolbar)

    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      minHeight: style.minHeight,
      padding: style.padding,
    }
  })

  const firstNodeMedia = firstNode.locator('.dom-node-media')
  const canvasImageStyle = await firstNodeMedia.evaluate((media) => {
    const nodeStyle = window.getComputedStyle(media.closest('.dom-node'))
    const mediaStyle = window.getComputedStyle(media)

    return {
      nodeBorderRadius: nodeStyle.borderRadius,
      mediaBorderRadius: mediaStyle.borderRadius,
      boxShadow: nodeStyle.boxShadow,
    }
  })

  if (canvasImageStyle.nodeBorderRadius !== '0px' || canvasImageStyle.mediaBorderRadius !== '0px') {
    throw new Error('Canvas images should use straight corners')
  }

  if (canvasImageStyle.boxShadow === 'none') {
    throw new Error('Canvas images should keep a shadow')
  }

  const canvasRasterizationHints = await page.evaluate(() => ({
    layerWillChange: window.getComputedStyle(document.querySelector('.dom-canvas-layer')).willChange,
    nodeWillChange: window.getComputedStyle(document.querySelector('.dom-node')).willChange,
    renderedNodeCount: Number(document.querySelector('.canvas-shell')?.getAttribute('data-rendered-node-count') || 0),
    totalNodeCount: Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0),
    imageLoading: document.querySelector('.dom-node-media img')?.getAttribute('loading'),
    imageDecoding: document.querySelector('.dom-node-media img')?.getAttribute('decoding'),
  }))
  if (canvasRasterizationHints.layerWillChange !== 'auto' || canvasRasterizationHints.nodeWillChange !== 'auto') {
    throw new Error(
      `Canvas DOM should not keep persistent transform raster caches after zoom: ${JSON.stringify(canvasRasterizationHints)}`,
    )
  }
  if (
    canvasRasterizationHints.renderedNodeCount < 1 ||
    canvasRasterizationHints.totalNodeCount < canvasRasterizationHints.renderedNodeCount ||
    canvasRasterizationHints.imageLoading !== 'lazy' ||
    canvasRasterizationHints.imageDecoding !== 'async'
  ) {
    throw new Error(`Canvas should expose culling metrics and lazy image decoding: ${JSON.stringify(canvasRasterizationHints)}`)
  }

  const beforePan = await firstNodeMedia.boundingBox()
  const canvasBox = await page.locator('.canvas-shell').boundingBox()
  if (!beforePan || !canvasBox) throw new Error('Missing canvas geometry for pan check')
  const farBlankPoint = { x: canvasBox.x + 120, y: canvasBox.y + 200 }

  await selectedNode.click()
  if ((await page.locator('.dom-node.selected').count()) === 0) {
    throw new Error('Clicking an image should select it before the blank-area deselection check')
  }
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 0)

  await page.getByRole('button', { name: /^Select$/ }).click()
  await page.mouse.move(farBlankPoint.x, farBlankPoint.y)
  await page.mouse.down()
  await page.mouse.move(farBlankPoint.x + 80, farBlankPoint.y + 45)
  await page.mouse.up()

  const afterPointerDrag = await firstNodeMedia.boundingBox()
  if (!afterPointerDrag || !nearlyEqual(afterPointerDrag.x, beforePan.x, 2) || !nearlyEqual(afterPointerDrag.y, beforePan.y, 2)) {
    throw new Error(
      `Dragging empty canvas with the pointer should start a selection marquee, not pan: before=${JSON.stringify(beforePan)}, after=${JSON.stringify(afterPointerDrag)}`,
    )
  }

  await page.getByRole('button', { name: 'Hand' }).click()
  await page.mouse.move(farBlankPoint.x, farBlankPoint.y)
  await page.mouse.down()
  await page.mouse.move(farBlankPoint.x + 80, farBlankPoint.y + 45)
  await page.mouse.up()

  const afterPan = await firstNodeMedia.boundingBox()
  if (!afterPan || !nearlyEqual(afterPan.x - beforePan.x, 80, 2) || !nearlyEqual(afterPan.y - beforePan.y, 45, 2)) {
    throw new Error(`Dragging empty canvas should pan the viewport: before=${JSON.stringify(beforePan)}, after=${JSON.stringify(afterPan)}`)
  }

  await page.getByRole('button', { name: 'Reset view' }).click()
  await page.getByRole('button', { name: /^Select$/ }).click()
  const afterReset = await firstNodeMedia.boundingBox()
  if (!afterReset || !nearlyEqual(afterReset.x, beforePan.x, 2) || !nearlyEqual(afterReset.y, beforePan.y, 2)) {
    throw new Error(`Reset view should restore the default viewport: before=${JSON.stringify(beforePan)}, after=${JSON.stringify(afterReset)}`)
  }

  // Phase 1b-1: large-delta drag past the node bbox keeps tracking the pointer
  // via setPointerCapture (move stream sustained even after the pointer exits
  // the node's bounding rect). Run early while the first node is unlocked.
  await firstNode.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 1)
  const captureDragBefore = await firstNodeMedia.boundingBox()
  if (!captureDragBefore) throw new Error('Missing first node for pointer-capture drag check')
  const captureDelta = { x: 300, y: 200 }
  await page.mouse.move(captureDragBefore.x + 24, captureDragBefore.y + 24)
  await page.mouse.down()
  await page.mouse.move(
    captureDragBefore.x + 24 + captureDelta.x,
    captureDragBefore.y + 24 + captureDelta.y,
    { steps: 14 },
  )
  await page.mouse.up()
  const captureDragAfter = await firstNodeMedia.boundingBox()
  // Tolerance covers snap-alignment to peer node edges (the drag still tracks
  // the full pointer path past the node bbox; snapping only shifts the final
  // position by a few px near a peer edge).
  if (
    !captureDragAfter ||
    !nearlyEqual(captureDragAfter.x - captureDragBefore.x, captureDelta.x, 12) ||
    !nearlyEqual(captureDragAfter.y - captureDragBefore.y, captureDelta.y, 12)
  ) {
    throw new Error(
      `Large-delta drag past the node bbox should keep tracking via pointer capture: before=${JSON.stringify(captureDragBefore)}, after=${JSON.stringify(captureDragAfter)}, delta=${JSON.stringify(captureDelta)}`,
    )
  }
  await pressCanvasShortcut('z')
  await page.waitForFunction(
    ({ nodeId, x, y }) => {
      const media = document.querySelector(`[data-node-id="${nodeId}"] .dom-node-media`)
      if (!media) return false
      const rect = media.getBoundingClientRect()
      return Math.abs(rect.x - x) <= 2 && Math.abs(rect.y - y) <= 2
    },
    { nodeId: firstNodeId, x: captureDragBefore.x, y: captureDragBefore.y },
  )
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)

  await page.mouse.click(farBlankPoint.x, farBlankPoint.y, { button: 'right' })
  for (const action of [
    'New text here',
    'New section here',
    'New AI image slot here',
    'New arrow markup',
    'New rectangle markup',
    'New markup note',
    'Fit all objects',
    'Select all objects',
    'Import asset',
  ]) {
    if ((await page.getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Blank right-click menu should expose ${action}`)
    }
  }
  if ((await page.getByRole('menuitem', { name: 'Delete image' }).count()) !== 0) {
    throw new Error('Blank right-click menu should not reuse image object actions')
  }
  await page.keyboard.press('Escape')
  await page.waitForSelector('.node-context-menu', { state: 'detached' })

  const markupCountBefore = await page.locator('.dom-node.markup-node').count()
  const drawToolButton = page.locator('.canvas-tool-dock').getByRole('button', { name: 'Draw' })
  if ((await drawToolButton.count()) !== 1) {
    throw new Error('Markup shape tools should be collapsed behind one Draw toolbar button')
  }
  await drawToolButton.hover()
  await page.waitForFunction(() => {
    const flyout = document.querySelector('.canvas-tool-flyout')
    return flyout && window.getComputedStyle(flyout).visibility === 'visible'
  })
  for (const tool of ['Arrow', 'Line', 'Rectangle', 'Ellipse']) {
    if ((await page.locator('.canvas-tool-flyout').getByRole('menuitem', { name: tool }).count()) !== 1) {
      throw new Error(`Draw flyout should expose ${tool}`)
    }
  }
  if ((await page.locator('.canvas-tool-flyout').getByRole('menuitem', { name: 'Brush' }).count()) !== 0) {
    throw new Error('Brush should be a first-class dock tool instead of a Draw flyout item')
  }
  if ((await page.locator('.canvas-tool-dock > button[aria-label="Brush"]').count()) !== 1) {
    throw new Error('Brush should render as a top-level dock button')
  }
  await drawToolButton.click()
  await page.mouse.move(farBlankPoint.x, farBlankPoint.y)
  await page.mouse.down()
  await page.mouse.move(farBlankPoint.x + 150, farBlankPoint.y - 70, { steps: 6 })
  await page.waitForSelector('.markup-creation-box.kind-arrow')
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count + 1,
    markupCountBefore,
  )
  const arrowMarkupNode = page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').last()
  const arrowMarkupNodeId = await arrowMarkupNode.getAttribute('data-node-id')
  const arrowMarkupBox = await arrowMarkupNode.boundingBox()
  const arrowMissTarget =
    arrowMarkupBox && arrowMarkupNodeId
      ? await page.evaluate(({ x, y, id }) => {
          return document.elementFromPoint(x, y)?.closest(`[data-node-id="${id}"]`)?.getAttribute('data-node-id') || null
        }, {
          x: arrowMarkupBox.x + arrowMarkupBox.width - 6,
          y: arrowMarkupBox.y + arrowMarkupBox.height - 6,
          id: arrowMarkupNodeId,
        })
      : null
  if (arrowMissTarget) {
    throw new Error('Arrow markup should not use its full bounding rectangle as the click target')
  }
  const selectButtonClassAfterMarkupCreate = await page.getByRole('button', { name: /^Select$/ }).getAttribute('class')
  if (!selectButtonClassAfterMarkupCreate?.includes('active')) {
    throw new Error('Creating markup should return the active tool to Select')
  }
  if ((await page.locator('.dom-node.markup-node.selected').count()) !== 0) {
    throw new Error('Freshly drawn markup should not immediately show the purple edit frame')
  }
  if ((await page.locator('.selection-quick-toolbar').count()) !== 0) {
    throw new Error('Freshly drawn markup should wait for a second click before showing edit controls')
  }
  await arrowMarkupNode.click()
  await page.waitForSelector('.selection-quick-toolbar')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.markup-node.selected .markup-point-handle').length === 2)
  if ((await arrowMarkupNode.locator('.node-handle').count()) !== 0) {
    throw new Error('Selected arrow markup should expose endpoint handles instead of the four resize corners')
  }
  const endPointHandle = await arrowMarkupNode.locator('.markup-point-handle').nth(1).boundingBox()
  const lineEndBefore = await arrowMarkupNode.locator('.markup-visible-line').evaluate((line) => ({
    x2: Number(line.getAttribute('x2')),
    y2: Number(line.getAttribute('y2')),
  }))
  if (!endPointHandle) throw new Error('Arrow markup should expose a draggable endpoint handle')
  await page.mouse.move(endPointHandle.x + endPointHandle.width / 2, endPointHandle.y + endPointHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(endPointHandle.x + endPointHandle.width / 2 + 44, endPointHandle.y + endPointHandle.height / 2 + 26, {
    steps: 5,
  })
  await page.mouse.up()
  const lineEndAfter = await arrowMarkupNode.locator('.markup-visible-line').evaluate((line) => ({
    x2: Number(line.getAttribute('x2')),
    y2: Number(line.getAttribute('y2')),
  }))
  const endPointHandleAfter = await arrowMarkupNode.locator('.markup-point-handle').nth(1).boundingBox()
  const endpointHandleTravel =
    endPointHandleAfter && endPointHandle
      ? Math.abs(endPointHandleAfter.x - endPointHandle.x) + Math.abs(endPointHandleAfter.y - endPointHandle.y)
      : 0
  if (
    (lineEndAfter.x2 === lineEndBefore.x2 && lineEndAfter.y2 === lineEndBefore.y2) ||
    !endPointHandleAfter ||
    endpointHandleTravel <= 20
  ) {
    throw new Error(
      `Dragging an arrow endpoint should edit the arrow geometry: before=${JSON.stringify(lineEndBefore)}, after=${JSON.stringify(lineEndAfter)}, handleBefore=${JSON.stringify(endPointHandle)}, handleAfter=${JSON.stringify(endPointHandleAfter)}`,
    )
  }
  const arrowHitLineBox = await arrowMarkupNode.locator('.markup-hit-line').boundingBox()
  if (!arrowHitLineBox) throw new Error('Arrow markup should expose a line hit target for label editing')
  await page.mouse.dblclick(
    arrowHitLineBox.x + arrowHitLineBox.width / 2,
    arrowHitLineBox.y + arrowHitLineBox.height / 2,
  )
  await page.waitForSelector('.dom-node.markup-node[data-markup-kind="arrow"].editing .dom-markup-text-editor')
  if ((await page.locator('.details-dialog').count()) !== 0) {
    throw new Error('Double-clicking arrow markup should edit its label instead of opening image details')
  }
  const arrowEditorChrome = await arrowMarkupNode.locator('.dom-markup-text-editor').evaluate((editor) => {
    const style = getComputedStyle(editor)
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    }
  })
  if (
    arrowEditorChrome.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    arrowEditorChrome.borderTopWidth !== '0px' ||
    arrowEditorChrome.boxShadow !== 'none'
  ) {
    throw new Error(`Arrow label editor should be transparent and chrome-free: ${JSON.stringify(arrowEditorChrome)}`)
  }
  await page.keyboard.type('Flow label')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.dom-node.markup-node[data-markup-kind="arrow"]:not(.editing) .dom-markup-label.line-label')
  const arrowVisibleSegmentsWithLabel = await arrowMarkupNode.locator('.markup-visible-line').count()
  if (arrowVisibleSegmentsWithLabel !== 2) {
    throw new Error(`Arrow label should split the visible arrow stroke around text, got ${arrowVisibleSegmentsWithLabel} segments`)
  }
  const arrowLabelBeforeMove = await arrowMarkupNode.locator('.dom-markup-label.line-label').boundingBox()
  if (!arrowLabelBeforeMove) throw new Error('Arrow markup should render a label after text editing')
  const endPointHandleWithLabel = await arrowMarkupNode.locator('.markup-point-handle').nth(1).boundingBox()
  if (!endPointHandleWithLabel) throw new Error('Arrow markup should keep endpoint handles after label editing')
  await page.mouse.move(
    endPointHandleWithLabel.x + endPointHandleWithLabel.width / 2,
    endPointHandleWithLabel.y + endPointHandleWithLabel.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    endPointHandleWithLabel.x + endPointHandleWithLabel.width / 2 + 34,
    endPointHandleWithLabel.y + endPointHandleWithLabel.height / 2 - 28,
    { steps: 5 },
  )
  await page.mouse.up()
  const arrowLabelAfterMove = await arrowMarkupNode.locator('.dom-markup-label.line-label').boundingBox()
  const arrowLabelTravel = arrowLabelAfterMove
    ? Math.abs(arrowLabelAfterMove.x - arrowLabelBeforeMove.x) + Math.abs(arrowLabelAfterMove.y - arrowLabelBeforeMove.y)
    : 0
  if (!arrowLabelAfterMove || arrowLabelTravel <= 6) {
    throw new Error(
      `Arrow label should stay attached to the line midpoint when an endpoint moves: before=${JSON.stringify(
        arrowLabelBeforeMove,
      )}, after=${JSON.stringify(arrowLabelAfterMove)}`,
    )
  }
  for (const action of ['Edit text', 'Fill color', 'Line', 'Duplicate', 'Front', 'Delete']) {
    if ((await page.locator('.selection-quick-toolbar').getByRole('button', { name: action }).count()) !== 1) {
      throw new Error(`Markup quick toolbar should expose ${action}`)
    }
  }
  if ((await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Copy' }).count()) !== 0) {
    throw new Error('Markup quick toolbar should keep Copy in the right-click menu instead of the floating bar')
  }
  await arrowMarkupNode.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    node.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
  })
  await page.waitForSelector('.node-action-menu')
  await page.locator('.node-action-menu').getByRole('menuitem', { name: 'Line' }).hover()
  await page.waitForSelector('.node-action-submenu')
  if (
    (await page.locator('.node-action-submenu').getByRole('menuitem', { name: 'Blue' }).count()) !== 1 ||
    (await page.locator('.node-action-submenu').getByRole('menuitem', { name: 'Red' }).count()) !== 1
  ) {
    throw new Error('Node context menu should render nested markup style actions')
  }
  await page.mouse.click(12, 12)
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Line' }).click()
  if (
    !(await page.locator('.selection-quick-toolbar-menu').evaluate((menu) => menu.classList.contains('palette-menu'))) ||
    (await page.locator('.selection-quick-toolbar-menu .choice-button.selected').count()) !== 2
  ) {
    throw new Error('Markup Line menu should combine color, style, and active stroke width controls')
  }
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Bold' }).click()
  const boldMarkupStrokes = await arrowMarkupNode
    .locator('.markup-visible-line')
    .evaluateAll((lines) => lines.map((line) => line.getAttribute('stroke-width')))
  if (!boldMarkupStrokes.length || boldMarkupStrokes.some((stroke) => stroke !== '6')) {
    throw new Error(`Markup stroke-width action should update every rendered SVG line segment, got ${boldMarkupStrokes}`)
  }
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Line' }).click()
  if (
    !(await page.locator('.selection-quick-toolbar-menu').evaluate((menu) => menu.classList.contains('palette-menu'))) ||
    (await page.locator('.selection-quick-toolbar-menu .choice-button.selected').count()) !== 2
  ) {
    throw new Error('Markup Line menu should keep active style and width visible')
  }
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Dashed line' }).click()
  const dashedMarkupStrokes = await arrowMarkupNode
    .locator('.markup-visible-line')
    .evaluateAll((lines) => lines.map((line) => line.getAttribute('stroke-dasharray')))
  if (!dashedMarkupStrokes.length || dashedMarkupStrokes.some((stroke) => !stroke)) {
    throw new Error('Markup dashed action should update the rendered SVG dash array')
  }
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node').length === count,
    markupCountBefore,
  )

  const chooseDrawTool = async (toolName) => {
    await drawToolButton.hover()
    await page.waitForFunction(() => {
      const flyout = document.querySelector('.canvas-tool-flyout')
      return flyout && window.getComputedStyle(flyout).visibility === 'visible'
    })
    await page.locator('.canvas-tool-flyout').getByRole('menuitem', { name: toolName }).click()
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('.canvas-tool-dock button.active')].some(
          (button) => button.getAttribute('aria-label') === name,
        ),
      toolName,
    )
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
  }

  const connectorCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').count()
  const firstImageBoxForConnector = await selectedNode.boundingBox()
  const secondImageBoxForConnector = await secondImageNode.boundingBox()
  if (!firstImageBoxForConnector || !secondImageBoxForConnector) {
    throw new Error('Missing image bounds for connector binding check')
  }
  await chooseDrawTool('Arrow')
  await page.mouse.move(
    firstImageBoxForConnector.x + firstImageBoxForConnector.width / 2,
    firstImageBoxForConnector.y + firstImageBoxForConnector.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    secondImageBoxForConnector.x + secondImageBoxForConnector.width / 2,
    secondImageBoxForConnector.y + secondImageBoxForConnector.height / 2,
    { steps: 8 },
  )
  await page.waitForFunction(
    (nodeId) => document.querySelector(`[data-node-id="${nodeId}"]`)?.classList.contains('connector-drop-target'),
    secondImageNodeId,
  )
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count + 1,
    connectorCountBefore,
  )
  const boundConnector = page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').last()
  const boundConnectorStartId = await boundConnector.getAttribute('data-connector-start-node-id')
  const boundConnectorEndId = await boundConnector.getAttribute('data-connector-end-node-id')
  if (boundConnectorStartId !== firstNodeId || boundConnectorEndId !== secondImageNodeId) {
    throw new Error(
      `Arrow endpoints should bind to nearby image nodes: start=${boundConnectorStartId}, end=${boundConnectorEndId}`,
    )
  }
  await boundConnector.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.markup-node.selected .markup-point-handle.bound').length === 2)
  const connectorEndAbsoluteBefore = await boundConnector.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const line = [...node.querySelectorAll('.markup-visible-line')].at(-1)
    return {
      x: rect.left + Number(line?.getAttribute('x2') || 0),
      y: rect.top + Number(line?.getAttribute('y2') || 0),
    }
  })
  const secondImageMoveStartBox = await secondImageNode.boundingBox()
  if (!secondImageMoveStartBox) throw new Error('Missing second image bounds before connector follow check')
  await page.mouse.move(
    secondImageMoveStartBox.x + secondImageMoveStartBox.width / 2,
    secondImageMoveStartBox.y + secondImageMoveStartBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    secondImageMoveStartBox.x + secondImageMoveStartBox.width / 2 + 72,
    secondImageMoveStartBox.y + secondImageMoveStartBox.height / 2 + 26,
    { steps: 8 },
  )
  await page.mouse.up()
  const connectorEndAbsoluteAfter = await boundConnector.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const line = [...node.querySelectorAll('.markup-visible-line')].at(-1)
    return {
      x: rect.left + Number(line?.getAttribute('x2') || 0),
      y: rect.top + Number(line?.getAttribute('y2') || 0),
    }
  })
  if (
    connectorEndAbsoluteAfter.x <= connectorEndAbsoluteBefore.x + 40 ||
    connectorEndAbsoluteAfter.y <= connectorEndAbsoluteBefore.y + 12
  ) {
    throw new Error(
      `Bound connector endpoint should follow the moved target: before=${JSON.stringify(
        connectorEndAbsoluteBefore,
      )}, after=${JSON.stringify(connectorEndAbsoluteAfter)}`,
    )
  }
  await boundConnector.click()
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Arrowheads' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Both arrows' }).click()
  const connectorArrowheads = await boundConnector.locator('.markup-visible-line').evaluate((line) => ({
    markerStart: line.getAttribute('marker-start'),
    markerEnd: line.getAttribute('marker-end'),
  }))
  if (!connectorArrowheads.markerStart || !connectorArrowheads.markerEnd) {
    throw new Error(`Both arrows action should render start and end arrowheads: ${JSON.stringify(connectorArrowheads)}`)
  }
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count,
    connectorCountBefore,
  )

  const noteCountBeforeConnector = await page.locator('.dom-node.markup-node[data-markup-kind="note"]').count()
  const connectorNotePoint = { x: farBlankPoint.x, y: farBlankPoint.y }
  await page.locator('.canvas-tool-dock').getByRole('button', { name: 'Markup note' }).click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.canvas-tool-dock button.active')].some(
      (button) => button.getAttribute('aria-label') === 'Markup note',
    ),
  )
  await page.mouse.click(connectorNotePoint.x, connectorNotePoint.y)
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="note"]').length === count + 1,
    noteCountBeforeConnector,
  )
  const connectorNote = page.locator('.dom-node.markup-node[data-markup-kind="note"]').last()
  const connectorNoteId = await connectorNote.getAttribute('data-node-id')
  const connectorNoteBox = await connectorNote.boundingBox()
  if (!connectorNoteId || !connectorNoteBox) throw new Error('Markup note should be available for connector binding checks')
  const connectorStartPoint = await page.evaluate((nodeId) => {
    const node = document.querySelector(`[data-node-id="${nodeId}"]`)
    const canvas = document.querySelector('.canvas-shell')
    const nodeRect = node?.getBoundingClientRect()
    const canvasRect = canvas?.getBoundingClientRect()
    if (!nodeRect || !canvasRect) return null
    const candidates = [
      { x: nodeRect.right + 180, y: nodeRect.bottom + 72 },
      { x: nodeRect.right + 180, y: nodeRect.top - 72 },
      { x: nodeRect.left - 180, y: nodeRect.bottom + 72 },
      { x: nodeRect.left - 180, y: nodeRect.top - 72 },
      { x: nodeRect.left + nodeRect.width / 2, y: nodeRect.bottom + 160 },
      { x: nodeRect.left + nodeRect.width / 2, y: nodeRect.top - 160 },
    ].map((point) => ({
      x: Math.max(canvasRect.left + 24, Math.min(canvasRect.right - 24, point.x)),
      y: Math.max(canvasRect.top + 24, Math.min(canvasRect.bottom - 24, point.y)),
    }))

    return (
      candidates.find((point) => {
        const target = document.elementFromPoint(point.x, point.y)
        return Boolean(
          target &&
            target.closest('.canvas-shell') &&
            !target.closest('.dom-node') &&
            !target.closest('.canvas-tool-dock') &&
            !target.closest('.selection-quick-toolbar') &&
            !target.closest('.node-context-menu'),
        )
      }) || null
    )
  }, connectorNoteId)
  if (!connectorStartPoint) throw new Error('Could not find a blank connector start point near the markup note')

  const freeNoteConnectorCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').count()
  await chooseDrawTool('Arrow')
  await page.mouse.move(connectorStartPoint.x, connectorStartPoint.y)
  await page.mouse.down()
  await page.mouse.move(connectorNoteBox.x + connectorNoteBox.width * 0.72, connectorNoteBox.y + connectorNoteBox.height * 0.52, {
    steps: 8,
  })
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count + 1,
    freeNoteConnectorCountBefore,
  )
  const freeNoteConnector = page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').last()
  const freeNoteConnectorEndId = await freeNoteConnector.getAttribute('data-connector-end-node-id')
  if (freeNoteConnectorEndId) {
    throw new Error(`Arrow endpoint dropped in the free interior of a note should not auto-bind, got ${freeNoteConnectorEndId}`)
  }
  await freeNoteConnector.click()
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count,
    freeNoteConnectorCountBefore,
  )

  const noteConnectorCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').count()
  await chooseDrawTool('Arrow')
  await page.mouse.move(connectorStartPoint.x, connectorStartPoint.y)
  await page.mouse.down()
  await page.mouse.move(connectorNoteBox.x + connectorNoteBox.width * 0.72, connectorNoteBox.y + connectorNoteBox.height * 0.92, {
    steps: 8,
  })
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count + 1,
    noteConnectorCountBefore,
  )
  const boundNoteConnector = page.locator('.dom-node.markup-node[data-markup-kind="arrow"]').last()
  const boundNoteConnectorEndId = await boundNoteConnector.getAttribute('data-connector-end-node-id')
  const boundNoteConnectorEndAnchor = await boundNoteConnector.getAttribute('data-connector-end-anchor')
  const boundNoteConnectorEndOffset = Number(await boundNoteConnector.getAttribute('data-connector-end-offset'))
  if (boundNoteConnectorEndId !== connectorNoteId || !boundNoteConnectorEndAnchor || !Number.isFinite(boundNoteConnectorEndOffset)) {
    throw new Error(
      `Arrow should bind to a specific note edge point: end=${boundNoteConnectorEndId}, anchor=${boundNoteConnectorEndAnchor}, offset=${boundNoteConnectorEndOffset}`,
    )
  }
  if (boundNoteConnectorEndAnchor === 'center') {
    throw new Error('Connector dropped inside a note but away from the center should bind to the nearest note edge')
  }
  const pointForBoxAnchor = (box, anchor, offset = 0.5) => {
    if (anchor === 'top') return { x: box.x + box.width * offset, y: box.y }
    if (anchor === 'right') return { x: box.x + box.width, y: box.y + box.height * offset }
    if (anchor === 'bottom') return { x: box.x + box.width * offset, y: box.y + box.height }
    if (anchor === 'left') return { x: box.x, y: box.y + box.height * offset }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const readConnectorEndPoint = async (connector) =>
    connector.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const line = [...node.querySelectorAll('.markup-visible-line')].at(-1)
      return {
        markerEnd: line?.getAttribute('marker-end'),
        x: rect.left + Number(line?.getAttribute('x2') || 0),
        y: rect.top + Number(line?.getAttribute('y2') || 0),
      }
    })
  const noteExpectedBefore = pointForBoxAnchor(connectorNoteBox, boundNoteConnectorEndAnchor, boundNoteConnectorEndOffset)
  const boundNoteConnectorEndBefore = await readConnectorEndPoint(boundNoteConnector)
  if (
    boundNoteConnectorEndBefore.markerEnd &&
    (!nearlyEqual(boundNoteConnectorEndBefore.x, noteExpectedBefore.x, 1.5) ||
      !nearlyEqual(boundNoteConnectorEndBefore.y, noteExpectedBefore.y, 1.5))
  ) {
    throw new Error(
      `Bound note connector endpoint should sit on the saved note edge point before moving: expected=${JSON.stringify(
        noteExpectedBefore,
      )}, actual=${JSON.stringify(boundNoteConnectorEndBefore)}`,
    )
  }

  await page.mouse.move(connectorNoteBox.x + connectorNoteBox.width / 2, connectorNoteBox.y + connectorNoteBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(connectorNoteBox.x + connectorNoteBox.width / 2 + 68, connectorNoteBox.y + connectorNoteBox.height / 2 - 42, {
    steps: 8,
  })
  await page.mouse.up()
  const movedConnectorNoteBox = await connectorNote.boundingBox()
  const boundNoteConnectorEndAfter = await readConnectorEndPoint(boundNoteConnector)
  if (!movedConnectorNoteBox) throw new Error('Missing note bounds after connector follow move')
  const noteExpectedAfter = pointForBoxAnchor(movedConnectorNoteBox, boundNoteConnectorEndAnchor, boundNoteConnectorEndOffset)
  if (
    !nearlyEqual(boundNoteConnectorEndAfter.x, noteExpectedAfter.x, 1.5) ||
    !nearlyEqual(boundNoteConnectorEndAfter.y, noteExpectedAfter.y, 1.5)
  ) {
    throw new Error(
      `Bound connector endpoint should keep its note edge offset when the note moves: expected=${JSON.stringify(
        noteExpectedAfter,
      )}, actual=${JSON.stringify(boundNoteConnectorEndAfter)}`,
    )
  }
  const noteConnectorMarkerRef = await boundNoteConnector.locator('marker').first().getAttribute('refX')
  if (noteConnectorMarkerRef !== '15') {
    throw new Error(`Arrow marker refX should align the visual arrow tip with the connector endpoint, got ${noteConnectorMarkerRef}`)
  }
  const noteConnectorMarkerFill = await boundNoteConnector.locator('marker path').first().getAttribute('fill')
  if (noteConnectorMarkerFill !== 'none') {
    throw new Error(`Arrowheads should use FigJam-style open strokes, got fill=${noteConnectorMarkerFill}`)
  }
  const noteConnectorLineCap = await boundNoteConnector.locator('.markup-visible-line').last().getAttribute('stroke-linecap')
  if (noteConnectorLineCap !== 'butt') {
    throw new Error(`Arrow lines with marker heads should use butt caps to avoid a protruding tip, got ${noteConnectorLineCap}`)
  }
  await boundNoteConnector.click()
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="arrow"]').length === count,
    noteConnectorCountBefore,
  )
  await connectorNote.click()
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="note"]').length === count,
    noteCountBeforeConnector,
  )

  const markupShapeTestPoint = { x: canvasBox.x + 520, y: canvasBox.y + 240 }
  const rectMarkupCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="rect"]').count()
  await chooseDrawTool('Rectangle')
  await page.keyboard.down('Shift')
  await page.mouse.move(markupShapeTestPoint.x, markupShapeTestPoint.y)
  await page.mouse.down()
  await page.mouse.move(markupShapeTestPoint.x + 150, markupShapeTestPoint.y + 58, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="rect"]').length === count + 1,
    rectMarkupCountBefore,
  )
  const shiftedRectMarkup = page.locator('.dom-node.markup-node[data-markup-kind="rect"]').last()
  const shiftedRectBox = await shiftedRectMarkup.boundingBox()
  if (!shiftedRectBox || Math.abs(shiftedRectBox.width - shiftedRectBox.height) > 2) {
    throw new Error(`Shift-dragged rectangle should become a square, got ${JSON.stringify(shiftedRectBox)}`)
  }
  await shiftedRectMarkup.dblclick()
  await page.waitForSelector('.dom-node.markup-node[data-markup-kind="rect"].editing .dom-markup-text-editor')
  if ((await page.locator('.details-dialog').count()) !== 0) {
    throw new Error('Double-clicking rectangle markup should edit shape text instead of opening image details')
  }
  const rectEditorChrome = await shiftedRectMarkup.locator('.dom-markup-text-editor').evaluate((editor) => {
    const style = getComputedStyle(editor)
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    }
  })
  if (
    rectEditorChrome.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    rectEditorChrome.borderTopWidth !== '0px' ||
    rectEditorChrome.boxShadow !== 'none'
  ) {
    throw new Error(`Shape text editor should be transparent and chrome-free: ${JSON.stringify(rectEditorChrome)}`)
  }
  await page.keyboard.type('Shape text')
  const rectBoxWhileEditing = await shiftedRectMarkup.boundingBox()
  const rectEditorBox = await shiftedRectMarkup.locator('.dom-markup-text-editor').boundingBox()
  if (
    !rectBoxWhileEditing ||
    !rectEditorBox ||
    Math.abs(rectEditorBox.y + rectEditorBox.height / 2 - (rectBoxWhileEditing.y + rectBoxWhileEditing.height / 2)) > 8
  ) {
    throw new Error(
      `Shape text editor should stay visually centered while editing: node=${JSON.stringify(
        rectBoxWhileEditing,
      )}, editor=${JSON.stringify(rectEditorBox)}`,
    )
  }
  await page.keyboard.press('Escape')
  const rectMarkupText = await shiftedRectMarkup.locator('.dom-markup-label.shape-label').textContent()
  if (!rectMarkupText?.includes('Shape text')) {
    throw new Error(`Rectangle markup should keep text inside the shape, got ${rectMarkupText}`)
  }
  await shiftedRectMarkup.click()
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Corner radius' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Round' }).click()
  const roundedRectRadius = await shiftedRectMarkup.locator('rect').getAttribute('rx')
  if (roundedRectRadius !== '18') {
    throw new Error(`Rectangle corner radius action should update the rendered SVG rect, got ${roundedRectRadius}`)
  }
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()

  const ellipseMarkupCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="ellipse"]').count()
  await chooseDrawTool('Ellipse')
  await page.mouse.move(markupShapeTestPoint.x + 20, markupShapeTestPoint.y + 20)
  await page.mouse.down()
  await page.mouse.move(markupShapeTestPoint.x + 140, markupShapeTestPoint.y + 66, { steps: 4 })
  await page.waitForSelector('.markup-creation-box.kind-ellipse')
  const ellipsePreviewRadius = await page.locator('.markup-creation-box.kind-ellipse').evaluate((box) => getComputedStyle(box).borderTopLeftRadius)
  if (ellipsePreviewRadius !== '50%') {
    throw new Error(`Ellipse creation preview should use an oval radius instead of a pill radius, got ${ellipsePreviewRadius}`)
  }
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="ellipse"]').length === count + 1,
    ellipseMarkupCountBefore,
  )
  const ellipseMarkup = page.locator('.dom-node.markup-node[data-markup-kind="ellipse"]').last()
  await ellipseMarkup.click()
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()

  const lineMarkupCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="line"]').count()
  await chooseDrawTool('Line')
  await page.keyboard.down('Shift')
  await page.mouse.move(markupShapeTestPoint.x + 20, markupShapeTestPoint.y + 40)
  await page.mouse.down()
  await page.mouse.move(markupShapeTestPoint.x + 190, markupShapeTestPoint.y + 92, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="line"]').length === count + 1,
    lineMarkupCountBefore,
  )
  const shiftedLineMarkup = page.locator('.dom-node.markup-node[data-markup-kind="line"]').last()
  const shiftedLine = await shiftedLineMarkup.locator('.markup-visible-line').evaluate((line) => ({
    x1: Number(line.getAttribute('x1')),
    y1: Number(line.getAttribute('y1')),
    x2: Number(line.getAttribute('x2')),
    y2: Number(line.getAttribute('y2')),
  }))
  const shiftedLineAngle = Math.abs(Math.atan2(shiftedLine.y2 - shiftedLine.y1, shiftedLine.x2 - shiftedLine.x1))
  const snappedAngles = [0, Math.PI / 4, Math.PI / 2]
  if (!snappedAngles.some((angle) => Math.abs(shiftedLineAngle - angle) < 0.03)) {
    throw new Error(`Shift-dragged line should snap to 0/45/90 degrees, got ${JSON.stringify(shiftedLine)}`)
  }
  const shiftedLineBox = await shiftedLineMarkup.boundingBox()
  if (!shiftedLineBox) throw new Error('Missing shifted line geometry for deletion')
  await page.mouse.click(
    shiftedLineBox.x + (shiftedLine.x1 + shiftedLine.x2) / 2,
    shiftedLineBox.y + (shiftedLine.y1 + shiftedLine.y2) / 2,
  )
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Delete' }).click()

  const brushCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="brush"]').count()
  const brushStrokeStart = { x: markupShapeTestPoint.x, y: markupShapeTestPoint.y + 150 }
  const drawBrushStroke = async (offsetY) => {
    await page.mouse.move(brushStrokeStart.x, brushStrokeStart.y + offsetY)
    await page.mouse.down()
    await page.mouse.move(brushStrokeStart.x + 60, brushStrokeStart.y + offsetY - 24, { steps: 5 })
    await page.mouse.move(brushStrokeStart.x + 130, brushStrokeStart.y + offsetY + 12, { steps: 5 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: 'Brush' }).click()
  await page.waitForSelector('.brush-options-bar')
  const defaultBrushColorChecked = await page
    .locator('.brush-options-bar')
    .getByRole('radio', { name: 'Brush color Black' })
    .getAttribute('aria-checked')
  if (defaultBrushColorChecked !== 'true') {
    throw new Error('Brush should default to the black color preset')
  }
  const markerCursor = await page.evaluate(
    () => window.getComputedStyle(document.querySelector('.canvas-shell')).cursor,
  )
  if (!markerCursor.includes('data:image/svg+xml')) {
    throw new Error(`Brush tool should show a pen cursor instead of the default one, got ${markerCursor}`)
  }
  await page.locator('.brush-options-bar').getByRole('radio', { name: 'Brush width Bold' }).click()
  await page.locator('.brush-options-bar').getByRole('radio', { name: 'Brush color Orange' }).click()
  await drawBrushStroke(0)
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="brush"]').length === count + 1,
    brushCountBefore,
  )
  const brushButtonClassAfterStroke = await page
    .locator('.canvas-tool-dock > button[aria-label="Brush"]')
    .getAttribute('class')
  if (!brushButtonClassAfterStroke?.includes('active')) {
    throw new Error('Brush should stay active after a stroke for continuous drawing')
  }
  await drawBrushStroke(40)
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="brush"]').length === count + 2,
    brushCountBefore,
  )
  const markerBrushNode = page.locator('.dom-node.markup-node[data-markup-kind="brush"]').last()
  const markerBrushFill = await markerBrushNode.locator('svg.dom-markup-node > path').getAttribute('fill')
  if (markerBrushFill !== '#ff8a00') {
    throw new Error(`Brush strokes should render a filled freehand path in the picked color, got ${markerBrushFill}`)
  }

  await page.locator('.brush-options-bar').getByRole('radio', { name: 'Highlighter' }).click()
  await drawBrushStroke(80)
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="brush"]').length === count + 3,
    brushCountBefore,
  )
  const highlighterNode = page.locator('.dom-node.markup-node[data-markup-kind="brush"]').last()
  const highlighterFillOpacity = await highlighterNode
    .locator('svg.dom-markup-node > path')
    .getAttribute('fill-opacity')
  if (Math.abs(Number(highlighterFillOpacity) - 0.42) > 0.01) {
    throw new Error(`Highlighter strokes should render semi-transparent, got fill-opacity=${highlighterFillOpacity}`)
  }

  await page.locator('.brush-options-bar').getByRole('radio', { name: 'Eraser' }).click()
  const eraserCursor = await page.evaluate(
    () => window.getComputedStyle(document.querySelector('.canvas-shell')).cursor,
  )
  if (!eraserCursor.includes('data:image/svg+xml') || eraserCursor === markerCursor) {
    throw new Error('Eraser mode should switch to its own cursor')
  }
  if (
    !(await page
      .locator('.brush-options-bar')
      .getByRole('radio', { name: 'Brush color Orange' })
      .isDisabled())
  ) {
    throw new Error('Eraser mode should disable stroke color options')
  }
  await page.mouse.move(brushStrokeStart.x + 65, brushStrokeStart.y - 40)
  await page.mouse.down()
  await page.mouse.move(brushStrokeStart.x + 65, brushStrokeStart.y + 120, { steps: 24 })
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="brush"]').length === count,
    brushCountBefore,
  )

  await page.keyboard.press('Escape')
  await page.waitForFunction(() => {
    const selectButton = [...document.querySelectorAll('.canvas-tool-dock button')].find(
      (button) => button.getAttribute('aria-label') === 'Select',
    )
    return selectButton?.classList.contains('active') && !document.querySelector('.brush-options-bar')
  })

  await page.keyboard.press('e')
  await page.waitForSelector('.brush-options-bar')
  if (
    (await page.locator('.brush-options-bar').getByRole('radio', { name: 'Eraser' }).getAttribute('aria-checked')) !==
    'true'
  ) {
    throw new Error('The E shortcut should activate eraser mode')
  }
  await page.keyboard.press('p')
  await page.waitForFunction(() => {
    const marker = document.querySelector('.brush-options-bar [aria-label="Marker"]')
    return marker?.getAttribute('aria-checked') === 'true'
  })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.brush-options-bar'))

  const stampCountBefore = await page.locator('.dom-node.markup-node[data-markup-kind="stamp"]').count()
  await page.keyboard.press('s')
  await page.waitForSelector('.stamp-options-bar')
  const stampCursor = await page.evaluate(
    () => window.getComputedStyle(document.querySelector('.canvas-shell')).cursor,
  )
  if (!stampCursor.includes('stickers/')) {
    throw new Error(`Stamp tool should show the stamp as cursor, got ${stampCursor}`)
  }
  const stampPoint = { x: markupShapeTestPoint.x + 40, y: markupShapeTestPoint.y + 320 }
  await page.mouse.click(stampPoint.x, stampPoint.y)
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="stamp"]').length === count + 1,
    stampCountBefore,
  )
  const stampButtonClass = await page
    .locator('.canvas-tool-dock > button[aria-label="Stamp"]')
    .getAttribute('class')
  if (!stampButtonClass?.includes('active')) {
    throw new Error('Stamp should stay active after placing for continuous stamping')
  }
  const quickStampNode = page.locator('.dom-node.markup-node[data-markup-kind="stamp"]').last()
  const quickStampSrc = await quickStampNode.locator('.dom-markup-stamp img').getAttribute('src')
  if (!quickStampSrc || !quickStampSrc.includes('plus-one.svg')) {
    throw new Error(`Default stamp should be the +1 sticker (plus-one.svg), got ${quickStampSrc}`)
  }
  const quickStampBox = await quickStampNode.boundingBox()
  if (!quickStampBox) throw new Error('Missing stamp geometry after quick click')

  await page.locator('.stamp-options-bar').getByRole('radio', { name: 'Sticker Heart' }).click()
  await page.mouse.move(stampPoint.x + 90, stampPoint.y)
  await page.mouse.down()
  await page.waitForSelector('.stamp-placement-preview')
  await wait(950)
  await page.mouse.up()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="stamp"]').length === count + 2,
    stampCountBefore,
  )
  const heldStampNode = page.locator('.dom-node.markup-node[data-markup-kind="stamp"]').last()
  const heldStampSrc = await heldStampNode.locator('.dom-markup-stamp img').getAttribute('src')
  if (!heldStampSrc || !heldStampSrc.includes('heart.svg')) {
    throw new Error(`Switching stamps should place the picked sticker (heart.svg), got ${heldStampSrc}`)
  }
  const heldStampBox = await heldStampNode.boundingBox()
  if (!heldStampBox || heldStampBox.width <= quickStampBox.width + 8) {
    throw new Error(
      `Press-and-hold should grow the stamp before placing: quick=${JSON.stringify(quickStampBox)}, held=${JSON.stringify(heldStampBox)}`,
    )
  }

  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.stamp-options-bar'))
  for (let stampIndex = 0; stampIndex < 2; stampIndex += 1) {
    await page.locator('.dom-node.markup-node[data-markup-kind="stamp"]').last().click()
    await page.keyboard.press('Backspace')
    await page.waitForFunction(
      (count) => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="stamp"]').length === count,
      stampCountBefore + 1 - stampIndex,
    )
  }

  const secondNode = page.locator('.dom-node').nth(1)
  const visibleNodeCountBeforeOrganization = await page.locator('.dom-node').count()
  await firstNode.click()
  await page.keyboard.down('Shift')
  await secondNode.click()
  await page.keyboard.up('Shift')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 2)
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Group' }).click()

  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)
  await firstNode.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 2)
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Lock' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.dom-node.selected')].every((node) => node.classList.contains('locked-node')))
  if ((await page.locator('.selection-handle').count()) !== 0) {
    throw new Error('Locked multi-selections should not expose resize handles')
  }
  const lockedFirstBox = await firstNode.boundingBox()
  if (!lockedFirstBox) throw new Error('Missing locked first node geometry')
  await firstNode.dragTo(page.locator('.canvas-shell'), {
    sourcePosition: { x: Math.min(24, lockedFirstBox.width / 2), y: Math.min(24, lockedFirstBox.height / 2) },
    targetPosition: { x: farBlankPoint.x - canvasBox.x + 80, y: farBlankPoint.y - canvasBox.y + 60 },
  })
  const lockedFirstBoxAfterDrag = await firstNode.boundingBox()
  if (
    !lockedFirstBoxAfterDrag ||
    !nearlyEqual(lockedFirstBoxAfterDrag.x, lockedFirstBox.x, 2) ||
    !nearlyEqual(lockedFirstBoxAfterDrag.y, lockedFirstBox.y, 2)
  ) {
    throw new Error(`Locked group should not move when dragged: before=${JSON.stringify(lockedFirstBox)}, after=${JSON.stringify(lockedFirstBoxAfterDrag)}`)
  }

  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Unlock' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.dom-node.selected')].every((node) => !node.classList.contains('locked-node')))
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Ungroup' }).click()
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)
  await firstNode.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 1)
  if ((await page.locator('.canvas-controls').getByRole('button', { name: 'Fit selection' }).count()) !== 1) {
    throw new Error('Canvas zoom controls should switch to Fit selection when an object is selected')
  }

  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 0)
  await pressCanvasShortcut('a')
  await page.waitForFunction(() => {
    const rendered = document.querySelectorAll('.dom-node').length
    return rendered > 0 && document.querySelectorAll('.dom-node.selected').length === rendered
  })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 0)

  const nodeCountBeforeCut = await page.locator('.dom-node').count()
  await firstNode.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 1)
  await pressCanvasShortcut('x')
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count - 1,
    nodeCountBeforeCut,
  )
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y, { button: 'right' })
  await page.getByRole('menuitem', { name: /^Paste 1 item$/ }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count,
    nodeCountBeforeCut,
  )
  await pressCanvasShortcut('z')
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count - 1,
    nodeCountBeforeCut,
  )
  await pressCanvasShortcut('z')
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count,
    nodeCountBeforeCut,
  )

  await firstNode.click()
  await page.keyboard.down('Shift')
  await secondNode.click()
  await page.keyboard.up('Shift')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 2)
  await pressCanvasShortcut('g')
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 0)
  await firstNode.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 2)
  await pressCanvasShortcut('g', { shiftKey: true })
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y)
  await firstNode.click()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selected').length === 1)

  const altResizeBoxBefore = await firstNode.boundingBox()
  if (!altResizeBoxBefore) throw new Error('Missing node geometry before Alt centered resize')
  const altResizeHandleBox = await firstNode.locator('.node-handle.se').boundingBox()
  if (!altResizeHandleBox) throw new Error('Missing se resize handle for Alt centered resize')
  await page.keyboard.down('Alt')
  await page.mouse.move(
    altResizeHandleBox.x + altResizeHandleBox.width / 2,
    altResizeHandleBox.y + altResizeHandleBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    altResizeHandleBox.x + altResizeHandleBox.width / 2 + 30,
    altResizeHandleBox.y + altResizeHandleBox.height / 2 + 30,
    { steps: 4 },
  )
  await page.mouse.up()
  await page.keyboard.up('Alt')
  const altResizeBoxAfter = await firstNode.boundingBox()
  if (
    !altResizeBoxAfter ||
    altResizeBoxAfter.width <= altResizeBoxBefore.width + 20 ||
    !nearlyEqual(
      altResizeBoxBefore.x + altResizeBoxBefore.width / 2,
      altResizeBoxAfter.x + altResizeBoxAfter.width / 2,
      3,
    ) ||
    !nearlyEqual(
      altResizeBoxBefore.y + altResizeBoxBefore.height / 2,
      altResizeBoxAfter.y + altResizeBoxAfter.height / 2,
      3,
    )
  ) {
    throw new Error(
      `Alt corner resize should grow the node around its center: before=${JSON.stringify(altResizeBoxBefore)}, after=${JSON.stringify(altResizeBoxAfter)}`,
    )
  }
  await pressCanvasShortcut('z')
  await wait(200)
  const altResizeBoxRestored = await firstNode.boundingBox()
  if (!altResizeBoxRestored || !nearlyEqual(altResizeBoxRestored.width, altResizeBoxBefore.width, 2)) {
    throw new Error(
      `Undo should restore geometry after Alt centered resize: before=${JSON.stringify(altResizeBoxBefore)}, restored=${JSON.stringify(altResizeBoxRestored)}`,
    )
  }

  const firstNodeBoxForMenu = await firstNode.boundingBox()
  if (!firstNodeBoxForMenu) throw new Error('Missing first node geometry for hide menu')
  await page.mouse.click(firstNodeBoxForMenu.x + 12, firstNodeBoxForMenu.y + 12, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide image' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count - 1,
    visibleNodeCountBeforeOrganization,
  )
  await page.mouse.click(farBlankPoint.x, farBlankPoint.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Show 1 hidden object' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count,
    visibleNodeCountBeforeOrganization,
  )

  await page.keyboard.down('Space')
  await page.mouse.move(farBlankPoint.x, farBlankPoint.y)
  await page.mouse.down()
  await page.mouse.move(farBlankPoint.x + 60, farBlankPoint.y + 40)
  await page.mouse.up()
  await page.keyboard.up('Space')

  const afterSpacePan = await firstNodeMedia.boundingBox()
  if (!afterSpacePan || !nearlyEqual(afterSpacePan.x - beforePan.x, 60, 2) || !nearlyEqual(afterSpacePan.y - beforePan.y, 40, 2)) {
    throw new Error(
      `Holding Space should temporarily switch to the hand tool: before=${JSON.stringify(beforePan)}, after=${JSON.stringify(afterSpacePan)}`,
    )
  }
  await page.getByRole('button', { name: 'Reset view' }).click()

  await page.keyboard.press('h')
  const handButtonClass = await page.getByRole('button', { name: 'Hand' }).getAttribute('class')
  if (!handButtonClass?.includes('active')) {
    throw new Error('The H shortcut should activate the hand tool')
  }

  await page.keyboard.press('t')
  const textButtonClass = await page.getByRole('button', { name: 'Text' }).getAttribute('class')
  if (!textButtonClass?.includes('active')) {
    throw new Error('The T shortcut should activate the text tool')
  }

  await page.keyboard.press('v')
  const selectButtonClass = await page.getByRole('button', { name: /^Select$/ }).getAttribute('class')
  if (!selectButtonClass?.includes('active')) {
    throw new Error('The V shortcut should activate the select tool')
  }

  await page.keyboard.press('f')
  const sectionButtonClass = await page.getByRole('button', { name: 'Section' }).getAttribute('class')
  if (!sectionButtonClass?.includes('active')) {
    throw new Error('The F shortcut should activate the section tool')
  }

  const sectionCountBefore = await page.locator('.dom-node.frame-node').count()
  await page.mouse.move(farBlankPoint.x, farBlankPoint.y)
  await page.mouse.down()
  await page.mouse.move(farBlankPoint.x + 520, farBlankPoint.y + 320, { steps: 6 })
  await page.waitForSelector('.frame-creation-box')
  await page.mouse.up()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node.frame-node').length === count + 1, sectionCountBefore)

  const sectionNode = page.locator('.dom-node.frame-node').last()
  const sectionNodeId = await sectionNode.getAttribute('data-node-id')
  if (!sectionNodeId) throw new Error('Created section should have a node id')
  const sectionBox = await sectionNode.boundingBox()
  if (!sectionBox || sectionBox.width < 500 || sectionBox.height < 300) {
    throw new Error(`Dragging with the section tool should create a sized section, got: ${JSON.stringify(sectionBox)}`)
  }

  const selectButtonClassAfterSectionCreate = await page.getByRole('button', { name: /^Select$/ }).getAttribute('class')
  if (!selectButtonClassAfterSectionCreate?.includes('active')) {
    throw new Error('Creating a section should return the active tool to Select')
  }

  page.once('dialog', (dialog) => dialog.accept('Reference Section'))
  await sectionNode.dblclick()
  await page.waitForFunction(() => [...document.querySelectorAll('.dom-frame-title')].some((title) => title.textContent === 'Reference Section'))

  const sectionHandle = sectionNode.locator('.node-handle.se')
  const sectionHandleBox = await sectionHandle.boundingBox()
  if (!sectionHandleBox) throw new Error('Section should expose a resize handle')
  await page.mouse.move(sectionHandleBox.x + sectionHandleBox.width / 2, sectionHandleBox.y + sectionHandleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sectionHandleBox.x + sectionHandleBox.width / 2 + 380, sectionHandleBox.y + sectionHandleBox.height / 2 + 160, { steps: 8 })
  await page.mouse.up()
  const resizedSectionBox = await sectionNode.boundingBox()
  if (!resizedSectionBox || resizedSectionBox.width < 850 || resizedSectionBox.height < 450) {
    throw new Error(`Section resize should be free-size and exceed the old 720px image limit: ${JSON.stringify(resizedSectionBox)}`)
  }

  await page.waitForSelector('.selection-quick-toolbar')
  const sectionToolbarChrome = await page.locator('.selection-quick-toolbar').evaluate((toolbar) => {
    const buttons = Array.from(
      toolbar.querySelectorAll(':scope > .selection-quick-toolbar-group > .selection-quick-toolbar-item > button'),
    )

    return {
      width: toolbar.getBoundingClientRect().width,
      buttonCount: buttons.length,
      labelsHidden: buttons.every((button) => {
        const label = button.querySelector('.selection-quick-toolbar-label')
        if (!label) return true
        const style = window.getComputedStyle(label)
        return style.position === 'absolute' && Number.parseFloat(style.width) <= 1 && style.overflow === 'hidden'
      }),
      firstTooltip: buttons[0]?.getAttribute('data-tooltip'),
    }
  })
  if (
    sectionToolbarChrome.buttonCount > 6 ||
    sectionToolbarChrome.width > 340 ||
    !sectionToolbarChrome.labelsHidden ||
    !sectionToolbarChrome.firstTooltip
  ) {
    throw new Error(`Section quick toolbar should be compact icon-only controls with hover tooltips: ${JSON.stringify(sectionToolbarChrome)}`)
  }

  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Section fill' }).click()
  const sectionFillPalette = await page.locator('.selection-quick-toolbar-menu').evaluate((menu) => ({
    className: menu.className,
    swatches: menu.querySelectorAll('.palette-swatch-button').length,
    visibleText: menu.textContent?.trim() || '',
  }))
  if (
    !sectionFillPalette.className.includes('palette-menu') ||
    sectionFillPalette.swatches < 5 ||
    sectionFillPalette.visibleText.length !== 0
  ) {
    throw new Error(`Section fill should render as an icon-only color palette: ${JSON.stringify(sectionFillPalette)}`)
  }
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Warm' }).click()
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Section line' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Blue' }).click()
  const styledSection = await sectionNode.locator('.dom-frame-node').evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderStyle: style.borderStyle,
    }
  })
  if (!styledSection.backgroundColor.includes('255, 247, 230') || !styledSection.borderColor.includes('21, 155, 255')) {
    throw new Error(`Section style toolbar should update fill and line colors: ${JSON.stringify(styledSection)}`)
  }
  await sectionNode.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    node.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + 24,
      }),
    )
  })
  await page.waitForSelector('.node-action-menu')
  if (
    (await page.locator('.node-action-menu').getByRole('menuitem', { name: 'Section fill' }).count()) !== 1 ||
    (await page.locator('.node-action-menu').getByRole('menuitem', { name: 'Section line' }).count()) !== 1 ||
    (await page.locator('.node-action-menu').getByRole('menuitem', { name: 'Orange dashed border' }).count()) !== 0
  ) {
    throw new Error('Section right-click menu should use unified Section fill / Section line naming')
  }
  await page.locator('.node-action-menu').getByRole('menuitem', { name: 'Section line' }).hover()
  await page.waitForSelector('.node-action-submenu')
  if (
    (await page.locator('.node-action-submenu').getByRole('menuitem', { name: 'Blue' }).count()) !== 1 ||
    (await page.locator('.node-action-submenu').getByRole('menuitem', { name: 'Thin' }).count()) !== 1 ||
    (await page.locator('.node-action-submenu').getByRole('menuitem', { name: 'Thin border' }).count()) !== 0
  ) {
    throw new Error('Section line submenu should use unified color and weight labels')
  }
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }))
  })
  await page.waitForSelector('.node-action-menu', { state: 'detached' })
  await page.waitForSelector('.selection-quick-toolbar')

  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Hide title' }).click()
  await page.waitForFunction((id) => !document.querySelector(`[data-node-id="${id}"] .dom-frame-title`), sectionNodeId)
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Show title' }).click()
  await page.waitForFunction((id) => Boolean(document.querySelector(`[data-node-id="${id}"] .dom-frame-title`)), sectionNodeId)

  const dragTargetInsideSection = await sectionNode.boundingBox()
  if (!dragTargetInsideSection) throw new Error('Missing section geometry for drag-in check')
  const imageBoxBeforeSectionDrop = await selectedNode.boundingBox()
  if (!imageBoxBeforeSectionDrop) throw new Error('Missing image geometry for drag-in feedback check')
  await page.mouse.move(
    imageBoxBeforeSectionDrop.x + imageBoxBeforeSectionDrop.width / 2,
    imageBoxBeforeSectionDrop.y + imageBoxBeforeSectionDrop.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    dragTargetInsideSection.x + Math.min(180, dragTargetInsideSection.width / 3),
    dragTargetInsideSection.y + Math.min(160, dragTargetInsideSection.height / 3),
    { steps: 8 },
  )
  await page.waitForFunction((id) => {
    return document.querySelector(`[data-node-id="${id}"]`)?.classList.contains('section-drop-target')
  }, sectionNodeId)
  const sectionDropTargetStyle = await sectionNode.locator('.dom-frame-node').evaluate((node) => {
    const style = window.getComputedStyle(node)

    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
    }
  })
  if (
    !sectionDropTargetStyle.borderColor.includes('105, 87, 232') ||
    !sectionDropTargetStyle.boxShadow.includes('105, 87, 232') ||
    sectionDropTargetStyle.backgroundColor.includes('105, 87, 232')
  ) {
    throw new Error(`Section drag-in feedback should highlight only the boundary, not tint the whole area: ${JSON.stringify(sectionDropTargetStyle)}`)
  }
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.frame-node.section-drop-target').length === 0)
  await page.waitForFunction(
    ({ imageId, parentId }) =>
      document.querySelector(`[data-node-id="${imageId}"]`)?.getAttribute('data-section-id') === parentId,
    { imageId: firstNodeId, parentId: sectionNodeId },
  )

  const imageBoxAlreadyInsideSection = await selectedNode.boundingBox()
  const secondImageBoxBeforeDrop = await secondImageNode.boundingBox()
  if (!imageBoxAlreadyInsideSection || !secondImageBoxBeforeDrop) {
    throw new Error('Missing image geometry for Section stacking regression check')
  }
  await page.mouse.move(
    secondImageBoxBeforeDrop.x + secondImageBoxBeforeDrop.width / 2,
    secondImageBoxBeforeDrop.y + secondImageBoxBeforeDrop.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    dragTargetInsideSection.x + Math.max(260, dragTargetInsideSection.width - 180),
    dragTargetInsideSection.y + Math.min(180, dragTargetInsideSection.height / 3),
    { steps: 8 },
  )
  await page.waitForFunction((id) => {
    return document.querySelector(`[data-node-id="${id}"]`)?.classList.contains('section-drop-target')
  }, sectionNodeId)
  const topNodeOverExistingSectionImage = await page.evaluate(({ x, y }) => {
    return document.elementFromPoint(x, y)?.closest('.dom-node')?.getAttribute('data-node-id')
  }, {
    x: imageBoxAlreadyInsideSection.x + imageBoxAlreadyInsideSection.width / 2,
    y: imageBoxAlreadyInsideSection.y + imageBoxAlreadyInsideSection.height / 2,
  })
  if (topNodeOverExistingSectionImage !== firstNodeId) {
    throw new Error(`Section drag-in feedback should not cover existing images; top node was ${topNodeOverExistingSectionImage}`)
  }
  await page.mouse.move(
    secondImageBoxBeforeDrop.x + secondImageBoxBeforeDrop.width / 2,
    secondImageBoxBeforeDrop.y + secondImageBoxBeforeDrop.height / 2,
    { steps: 8 },
  )
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.frame-node.section-drop-target').length === 0)

  await selectedNode.dragTo(page.locator('.canvas-shell'), {
    targetPosition: {
      x: 32,
      y: canvasBox.height - 64,
    },
  })
  await page.waitForFunction((imageId) => !document.querySelector(`[data-node-id="${imageId}"]`)?.getAttribute('data-section-id'), firstNodeId)

  await selectedNode.dragTo(page.locator('.canvas-shell'), {
    targetPosition: {
      x: dragTargetInsideSection.x - canvasBox.x + Math.min(220, dragTargetInsideSection.width / 2),
      y: dragTargetInsideSection.y - canvasBox.y + Math.min(220, dragTargetInsideSection.height / 2),
    },
  })
  await page.waitForFunction(
    ({ imageId, parentId }) =>
      document.querySelector(`[data-node-id="${imageId}"]`)?.getAttribute('data-section-id') === parentId,
    { imageId: firstNodeId, parentId: sectionNodeId },
  )

  await sectionNode.click({ position: { x: 24, y: 24 } })
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Lock' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Lock background only' }).click()
  const lockedBackgroundBox = await sectionNode.boundingBox()
  if (!lockedBackgroundBox) throw new Error('Missing locked-background section geometry')
  await sectionNode.dragTo(page.locator('.canvas-shell'), {
    sourcePosition: { x: 32, y: 32 },
    targetPosition: { x: farBlankPoint.x - canvasBox.x + 160, y: farBlankPoint.y - canvasBox.y + 120 },
  })
  const lockedBackgroundBoxAfterDrag = await sectionNode.boundingBox()
  if (
    !lockedBackgroundBoxAfterDrag ||
    !nearlyEqual(lockedBackgroundBoxAfterDrag.x, lockedBackgroundBox.x, 2) ||
    !nearlyEqual(lockedBackgroundBoxAfterDrag.y, lockedBackgroundBox.y, 2)
  ) {
    throw new Error('Lock background only should keep the section background fixed')
  }
  const imageBoxInsideBackgroundLockedSection = await selectedNode.boundingBox()
  if (!imageBoxInsideBackgroundLockedSection) throw new Error('Missing image geometry inside background-locked section')
  await selectedNode.dragTo(page.locator('.canvas-shell'), {
    targetPosition: { x: 32, y: canvasBox.height - 64 },
  })
  await page.waitForFunction((imageId) => !document.querySelector(`[data-node-id="${imageId}"]`)?.getAttribute('data-section-id'), firstNodeId)

  await selectedNode.dragTo(page.locator('.canvas-shell'), {
    targetPosition: {
      x: lockedBackgroundBox.x - canvasBox.x + Math.min(260, lockedBackgroundBox.width / 2),
      y: lockedBackgroundBox.y - canvasBox.y + Math.min(260, lockedBackgroundBox.height / 2),
    },
  })
  await page.waitForFunction(
    ({ imageId, parentId }) =>
      document.querySelector(`[data-node-id="${imageId}"]`)?.getAttribute('data-section-id') === parentId,
    { imageId: firstNodeId, parentId: sectionNodeId },
  )
  await sectionNode.click({ position: { x: 24, y: 24 } })
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Unlock' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Lock all' }).click()
  await selectedNode.click()
  await page.waitForFunction((imageId) => document.querySelector(`[data-node-id="${imageId}"]`)?.classList.contains('locked-node'), firstNodeId)
  const lockedBySectionImageBox = await selectedNode.boundingBox()
  if (!lockedBySectionImageBox) throw new Error('Missing lock-all child geometry')
  await selectedNode.dragTo(page.locator('.canvas-shell'), {
    targetPosition: { x: 32, y: canvasBox.height - 64 },
  })
  const lockedBySectionImageBoxAfterDrag = await selectedNode.boundingBox()
  if (
    !lockedBySectionImageBoxAfterDrag ||
    !nearlyEqual(lockedBySectionImageBoxAfterDrag.x, lockedBySectionImageBox.x, 2) ||
    !nearlyEqual(lockedBySectionImageBoxAfterDrag.y, lockedBySectionImageBox.y, 2)
  ) {
    throw new Error('Lock all should prevent section children from moving')
  }

  await sectionNode.click({ position: { x: 24, y: 24 } })
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Unlock' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Unlock section' }).click()
  await sectionNode.click({ button: 'right', position: { x: 24, y: 24 } })
  const sectionContextMenuOverflow = await page.locator('.node-action-menu').evaluate((menu) => ({
    clientWidth: menu.clientWidth,
    scrollWidth: menu.scrollWidth,
  }))
  if (sectionContextMenuOverflow.scrollWidth > sectionContextMenuOverflow.clientWidth + 1) {
    throw new Error(`Section context menu should not show horizontal overflow: ${JSON.stringify(sectionContextMenuOverflow)}`)
  }
  await page.getByRole('menuitem', { name: 'Remove section only' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node.frame-node').length === count, sectionCountBefore)
  await page.waitForFunction((imageId) => !document.querySelector(`[data-node-id="${imageId}"]`)?.getAttribute('data-section-id'), firstNodeId)

  await page.keyboard.press('v')
  const selectButtonClassAfterSectionRemove = await page.getByRole('button', { name: /^Select$/ }).getAttribute('class')
  if (!selectButtonClassAfterSectionRemove?.includes('active')) {
    throw new Error('The V shortcut should restore Select after testing the section tool')
  }

  const postSectionBlankPoint = { x: canvasBox.x + 130, y: canvasBox.y + canvasBox.height - 170 }
  await page.keyboard.press('t')
  await page.mouse.click(postSectionBlankPoint.x, postSectionBlankPoint.y)
  await page.waitForSelector('.dom-node.text-node.editing .dom-text-editor')
  const selectButtonClassAfterTextCreate = await page.getByRole('button', { name: /^Select$/ }).getAttribute('class')
  if (!selectButtonClassAfterTextCreate?.includes('active')) {
    throw new Error('Creating canvas text should return the active tool to Select while keeping the editor focused')
  }
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.text-node').length === 0)

  await page.keyboard.press('t')
  await page.mouse.move(postSectionBlankPoint.x, postSectionBlankPoint.y)
  await page.mouse.down()
  await page.mouse.move(postSectionBlankPoint.x + 260, postSectionBlankPoint.y + 96, { steps: 6 })
  await page.waitForSelector('.text-creation-box')
  await page.mouse.up()
  await page.waitForSelector('.dom-node.text-node.editing .dom-text-editor')
  const createdTextBox = await page.locator('.dom-node.text-node.editing').last().boundingBox()
  if (!createdTextBox || createdTextBox.width < 240 || createdTextBox.height < 80) {
    throw new Error(`Dragging with the text tool should create a sized text box, got: ${JSON.stringify(createdTextBox)}`)
  }
  const editingTextOutline = await page.locator('.dom-node.text-node.editing').last().evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  if (editingTextOutline.outlineStyle !== 'dashed' || editingTextOutline.outlineWidth === '0px') {
    throw new Error(`Editing text should keep the text area visible, got: ${JSON.stringify(editingTextOutline)}`)
  }
  await page.keyboard.type('Mivo note')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second line')
  await page.keyboard.press('Enter')
  await page.keyboard.type('阿萨德考拉建档立卡暗色调阿德啊阿达稍等暗色调暗色调暗色调阿德阿德阿德阿德阿打算')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.dom-node.text-node:not(.editing)')

  const textContent = await page.locator('.dom-node.text-node .dom-text-node').last().textContent()
  if (!textContent?.includes('Mivo note') || !textContent.includes('Second line')) {
    throw new Error(`Text tool should create an editable multi-line canvas text node, got: ${textContent}`)
  }

  const textBoundsFit = await page.locator('.dom-node.text-node').last().evaluate((node) => {
    const text = node.querySelector('.dom-text-node')
    const rect = node.getBoundingClientRect()

    return {
      nodeHeight: rect.height,
      textScrollHeight: text?.scrollHeight || 0,
      textClientHeight: text?.clientHeight || 0,
    }
  })
  if (
    textBoundsFit.nodeHeight + 1 < textBoundsFit.textScrollHeight ||
    textBoundsFit.textClientHeight + 1 < textBoundsFit.textScrollHeight
  ) {
    throw new Error(`Text selection bounds should contain all rendered lines: ${JSON.stringify(textBoundsFit)}`)
  }

  const lowerBlankPoint = {
    x: canvasBox.x + 40,
    y: canvasBox.y + canvasBox.height - 40,
  }
  await page.mouse.click(lowerBlankPoint.x, lowerBlankPoint.y)
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.text-node.selected').length === 0)

  let textBox = await page.locator('.dom-node.text-node').last().boundingBox()
  if (!textBox) throw new Error('Missing text node for FigJam-style text selection check')
  await page.mouse.click(textBox.x + Math.min(32, textBox.width / 2), textBox.y + Math.min(28, textBox.height / 2))
  await page.waitForSelector('.dom-node.text-node.selected:not(.editing)')
  if ((await page.locator('.dom-node.text-node.editing').count()) !== 0) {
    throw new Error('The first click on an unselected text node should select it without entering text editing')
  }

  textBox = await page.locator('.dom-node.text-node').last().boundingBox()
  if (!textBox) throw new Error('Missing selected text node for drag check')
  // Use the upper-left text area so the floating bottom toolbar cannot intercept the drag on short viewports.
  const textDragStart = {
    x: textBox.x + Math.min(32, textBox.width / 2),
    y: textBox.y + Math.min(28, textBox.height / 2),
  }
  await page.mouse.move(textDragStart.x, textDragStart.y)
  await page.mouse.down()
  await page.mouse.move(textDragStart.x + 54, textDragStart.y + 32, { steps: 5 })
  await page.mouse.up()
  const movedTextBox = await page.locator('.dom-node.text-node').last().boundingBox()
  if (
    !movedTextBox ||
    movedTextBox.x <= textBox.x + 24 ||
    movedTextBox.y <= textBox.y + 12 ||
    (await page.locator('.dom-node.text-node.editing').count()) !== 0
  ) {
    throw new Error(`Dragging a selected text node should move it without entering edit mode: before=${JSON.stringify(textBox)}, after=${JSON.stringify(movedTextBox)}`)
  }

  await page.mouse.click(
    movedTextBox.x + Math.min(32, movedTextBox.width / 2),
    movedTextBox.y + Math.min(28, movedTextBox.height / 2),
  )
  await page.waitForSelector('.dom-node.text-node.editing .dom-text-editor')
  await page.keyboard.type(' updated')
  await page.keyboard.press('Escape')

  const editedTextContent = await page.locator('.dom-node.text-node .dom-text-node').last().textContent()
  if (!editedTextContent?.includes('updated')) {
    throw new Error(`Double-clicking canvas text should reopen text editing, got: ${editedTextContent}`)
  }

  await page.keyboard.press('v')
  await page.waitForSelector('.text-format-toolbar')
  const textQuickToolbarStyle = await page.locator('.text-format-toolbar').evaluate((toolbar) => {
    const style = getComputedStyle(toolbar)

    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      minHeight: style.minHeight,
      padding: style.padding,
    }
  })
  if (
    textQuickToolbarStyle.backgroundColor !== imageQuickToolbarStyle.backgroundColor ||
    textQuickToolbarStyle.borderRadius !== imageQuickToolbarStyle.borderRadius ||
    textQuickToolbarStyle.minHeight !== imageQuickToolbarStyle.minHeight ||
    textQuickToolbarStyle.padding !== imageQuickToolbarStyle.padding
  ) {
    throw new Error(
      `Text and image quick toolbars should share one visual shell: image=${JSON.stringify(
        imageQuickToolbarStyle,
      )}, text=${JSON.stringify(textQuickToolbarStyle)}`,
    )
  }
  const textStyleBeforeFormat = await page.locator('.dom-node.text-node .dom-text-node').last().evaluate((text) => {
    const style = getComputedStyle(text)

    return {
      color: style.color,
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10),
      textAlign: style.textAlign,
    }
  })
  await page.getByRole('button', { name: 'Increase text size' }).click()
  await page.getByRole('button', { name: 'Toggle bold' }).click()
  await page.getByRole('button', { name: 'Align text center' }).click()
  await page.getByRole('button', { name: 'Set text color #6957e8' }).click()

  const textStyleAfterFormat = await page.locator('.dom-node.text-node .dom-text-node').last().evaluate((text) => {
    const style = getComputedStyle(text)

    return {
      color: style.color,
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10),
      textAlign: style.textAlign,
    }
  })
  if (
    textStyleAfterFormat.fontSize <= textStyleBeforeFormat.fontSize ||
    textStyleAfterFormat.fontWeight < 700 ||
    textStyleAfterFormat.textAlign !== 'center' ||
    textStyleAfterFormat.color !== 'rgb(105, 87, 232)'
  ) {
    throw new Error(
      `Text format toolbar should update size, weight, alignment, and color: before=${JSON.stringify(
        textStyleBeforeFormat,
      )}, after=${JSON.stringify(textStyleAfterFormat)}`,
    )
  }

  const formattedTextBox = await page.locator('.dom-node.text-node').last().boundingBox()
  if (!formattedTextBox) throw new Error('Missing formatted text node for context menu check')
  await page.mouse.click(
    formattedTextBox.x + Math.min(32, formattedTextBox.width / 2),
    formattedTextBox.y + Math.min(28, formattedTextBox.height / 2),
    { button: 'right' },
  )
  for (const action of [
    'Edit text',
    'Copy text',
    'Duplicate text',
    'Generate beside',
    'Add edit note',
    'Bring to front',
    'Delete text',
  ]) {
    if ((await page.getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Text right-click menu should expose ${action}`)
    }
  }
  await page.getByRole('menuitem', { name: 'Edit text' }).click()
  await page.waitForSelector('.dom-node.text-node.editing .dom-text-editor')
  await page.keyboard.press('Escape')

  const beforeTextResize = await page.locator('.dom-node.text-node').last().boundingBox()
  const textResizeHandle = await page.locator('.dom-node.text-node .text-resize-handle.e').last().boundingBox()
  if (!beforeTextResize || !textResizeHandle) {
    throw new Error('Selected canvas text should expose horizontal resize handles')
  }

  const textResizeGrabPoint = {
    x: textResizeHandle.x + textResizeHandle.width / 2,
    // On CI the text box can sit low enough that the handle center falls just
    // below the viewport. Clamp the grab point back into the visible slice
    // while still staying inside the handle itself.
    y: Math.max(
      textResizeHandle.y + 1,
      Math.min(
        textResizeHandle.y + textResizeHandle.height / 2,
        textResizeHandle.y + textResizeHandle.height - 1,
        canvasBox.y + canvasBox.height - 8,
      ),
    ),
  }

  // 在 dev topology 下 Playwright `page.mouse.down()` 合成的 pointerdown 不会命中
  // handle button 的 React onPointerDown(导致 beginTextResize 不执行、textResizeRef 不
  // 设置、后续 pointermove 的 pointerId 全部不匹配 → resizeTextNode 从不调用 → width
  // 不增长 → waitForFunction 超时)。prod topology 受 store bridge 等差异影响不复发。
  // 这里直接在 handle 元素上 dispatch native PointerEvent 序列,绕开 Playwright mouse
  // 合成的时序问题,让 beginTextResize → setPointerCapture → tryMoveTextResize 正常走通。
  await page.evaluate(({ grabX, grabY, endX }) => {
    const handle = document.querySelector('.dom-node.text-node .text-resize-handle.e')
    if (!handle) throw new Error('text-resize handle not found for pointer dispatch')
    const fire = (type, x, y, buttons) => {
      handle.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      }))
    }
    fire('pointerdown', grabX, grabY, 1)
    const steps = 6
    for (let index = 1; index <= steps; index += 1) {
      const x = grabX + (endX - grabX) * (index / steps)
      fire('pointermove', x, grabY, 1)
    }
    fire('pointerup', endX, grabY, 0)
  }, { grabX: textResizeGrabPoint.x, grabY: textResizeGrabPoint.y, endX: textResizeGrabPoint.x + 90 })
  await page.waitForFunction(
    (minWidth) => {
      const nodes = document.querySelectorAll('.dom-node.text-node')
      const lastNode = nodes.item(nodes.length - 1)
      return Boolean(lastNode && lastNode.getBoundingClientRect().width > minWidth)
    },
    beforeTextResize.width + 20,
  )

  const afterTextResize = await page.locator('.dom-node.text-node').last().boundingBox()
  if (!afterTextResize || afterTextResize.width <= beforeTextResize.width + 20) {
    throw new Error(
      `Dragging the text width handle should resize the text box: before=${JSON.stringify(beforeTextResize)}, after=${JSON.stringify(afterTextResize)}`,
    )
  }

  await page.keyboard.press('Delete')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.text-node').length === 0)
  await page.keyboard.press('v')

  const zoomBefore = await page.locator('.zoom-readout').textContent()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  const zoomAfter = await page.locator('.zoom-readout').textContent()
  if (Number.parseInt(zoomAfter || '0', 10) <= Number.parseInt(zoomBefore || '0', 10)) {
    throw new Error(`Zoom in should increase the canvas scale: before=${zoomBefore}, after=${zoomAfter}`)
  }

  await page.getByRole('button', { name: 'Reset view' }).click()
  await page.waitForFunction(() => {
    const shell = document.querySelector('.canvas-shell')
    return (
      shell &&
      Number(shell.getAttribute('data-viewport-scale')) === 1 &&
      Math.abs(Number(shell.getAttribute('data-viewport-x')) - 420) <= 0.5 &&
      Math.abs(Number(shell.getAttribute('data-viewport-y')) - 240) <= 0.5
    )
  })
  await wait(60)
  const pointerZoomMedia = selectedNode.locator('.dom-node-media')
  const beforePointerZoom = await pointerZoomMedia.boundingBox()
  if (!beforePointerZoom) throw new Error('Missing first node for pointer-centered zoom check')
  const pointerZoomAnchor = {
    x: beforePointerZoom.x + beforePointerZoom.width / 2,
    y: beforePointerZoom.y + beforePointerZoom.height / 2,
  }
  const scaleBeforePointerZoom = Number(await page.locator('.canvas-shell').getAttribute('data-viewport-scale'))
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y)
    target?.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        ctrlKey: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 0,
        deltaY: -180,
      }),
    )
  }, pointerZoomAnchor)
  await page.waitForFunction(
    (previousScale) => Number(document.querySelector('.canvas-shell')?.getAttribute('data-viewport-scale')) > previousScale,
    scaleBeforePointerZoom,
  )
  const afterPointerZoom = await pointerZoomMedia.boundingBox()
  if (
    !afterPointerZoom ||
    afterPointerZoom.width <= beforePointerZoom.width ||
    !nearlyEqual(afterPointerZoom.x + afterPointerZoom.width / 2, pointerZoomAnchor.x, 2) ||
    !nearlyEqual(afterPointerZoom.y + afterPointerZoom.height / 2, pointerZoomAnchor.y, 2)
  ) {
    throw new Error(
      `Ctrl-wheel zoom should keep the pointer anchor fixed: before=${JSON.stringify(beforePointerZoom)}, after=${JSON.stringify(afterPointerZoom)}, anchor=${JSON.stringify(pointerZoomAnchor)}`,
    )
  }

  const scaleAfterPointerZoom = Number(await page.locator('.canvas-shell').getAttribute('data-viewport-scale'))
  await page.keyboard.down('Shift')
  await page.keyboard.press('Digit1')
  await page.keyboard.up('Shift')
  const scaleAfterFitAll = Number(await page.locator('.canvas-shell').getAttribute('data-viewport-scale'))
  if (!(scaleAfterFitAll > 0) || scaleAfterFitAll >= scaleAfterPointerZoom) {
    throw new Error(`Shift+1 should fit all objects after zooming in: before=${scaleAfterPointerZoom}, after=${scaleAfterFitAll}`)
  }

  await selectedNode.click()
  await page.keyboard.down('Shift')
  await page.keyboard.press('Digit2')
  await page.keyboard.up('Shift')
  const scaleAfterFitSelection = Number(await page.locator('.canvas-shell').getAttribute('data-viewport-scale'))
  if (scaleAfterFitSelection <= scaleAfterFitAll) {
    throw new Error(`Shift+2 should fit the selected object tighter than Fit all: all=${scaleAfterFitAll}, selection=${scaleAfterFitSelection}`)
  }

  await page.keyboard.down('Control')
  await page.keyboard.press('Digit0')
  await page.keyboard.up('Control')
  const zoomAfterKeyboardReset = await page.locator('.zoom-readout').textContent()
  if (zoomAfterKeyboardReset !== '100%') {
    throw new Error(`Control+0 should reset the canvas view to 100%, got ${zoomAfterKeyboardReset}`)
  }
  await page.getByRole('button', { name: 'Reset view' }).click()

  const secondNodeMedia = page.locator('.dom-node').nth(1).locator('.dom-node-media')
  const beforeGroupSelectFirst = await firstNodeMedia.boundingBox()
  const beforeGroupSelectSecond = await secondNodeMedia.boundingBox()
  if (!beforeGroupSelectFirst || !beforeGroupSelectSecond) throw new Error('Missing nodes for group selection check')

  const groupSelectStart = {
    x: canvasBox.x + 32,
    y: canvasBox.y + canvasBox.height - 72,
  }
  const groupSelectEnd = {
    x: canvasBox.x + 980,
    y: canvasBox.y + 120,
  }

  await page.mouse.move(groupSelectStart.x, groupSelectStart.y)
  await page.mouse.down()
  await page.mouse.move(groupSelectEnd.x, groupSelectEnd.y, { steps: 8 })
  await page.waitForSelector('.selection-marquee')
  await page.waitForFunction(() => document.querySelectorAll('.dom-node.selection-preview').length >= 2)
  await page.mouse.up()
  await page.waitForSelector('[data-selection-bounds="true"]')

  if ((await page.locator('.dom-node.selected').count()) < 2) {
    throw new Error('Marquee selection should select multiple canvas nodes')
  }
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Align' }).click()
  if (!(await page.locator('.selection-quick-toolbar-menu').evaluate((menu) => menu.classList.contains('icon-grid-menu')))) {
    throw new Error('Multi-selection Align quick menu should render as an icon grid')
  }
  const expectedMultiQuickActions = [
    'Align left',
    'Align center',
    'Align right',
    'Align top',
    'Align middle',
    'Align bottom',
    'Distribute horizontal',
    'Distribute vertical',
  ]
  for (const action of expectedMultiQuickActions) {
    if ((await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Multi-selection Align quick menu should expose ${action}`)
    }
  }
  await page.keyboard.press('Escape')
  await page.waitForSelector('.selection-quick-toolbar-menu', { state: 'detached' })
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Arrange' }).click()
  if (!(await page.locator('.selection-quick-toolbar-menu').evaluate((menu) => menu.classList.contains('icon-grid-menu')))) {
    throw new Error('Multi-selection Arrange quick menu should render as an icon grid')
  }
  for (const action of ['Arrange row', 'Arrange column', 'Arrange grid', 'Tidy selection']) {
    if ((await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Multi-selection Arrange quick menu should expose ${action}`)
    }
  }
  const arrangeTargetsBefore = await page.locator('.dom-node.selected:not([data-node-type="markup"])').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        id: node.getAttribute('data-node-id'),
        left: rect.left,
        top: rect.top,
      }
    }),
  )
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Arrange row' }).click()
  await page.waitForSelector('.selection-quick-toolbar-menu', { state: 'detached' })
  const arrangeTargetsAfter = await page.locator('.dom-node.selected:not([data-node-type="markup"])').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        id: node.getAttribute('data-node-id'),
        left: rect.left,
        top: rect.top,
      }
    }),
  )
  const movedArrangeTargets = arrangeTargetsAfter.filter((after) => {
    const before = arrangeTargetsBefore.find((item) => item.id === after.id)
    return before && (Math.abs(before.left - after.left) > 2 || Math.abs(before.top - after.top) > 2)
  })
  const arrangedRowCenters = await page.locator('.dom-node.selected:not([data-node-type="markup"])').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return rect.top + rect.height / 2
    }),
  )
  if (
    arrangedRowCenters.length < 2 ||
    movedArrangeTargets.length < 1 ||
    Math.max(...arrangedRowCenters) - Math.min(...arrangedRowCenters) > 2 ||
    (await page.locator('.selection-quick-toolbar').count()) !== 1
  ) {
    throw new Error(
      `Arrange row should move selected objects, keep a multi-selection, and align object centers: centers=${JSON.stringify(
        arrangedRowCenters,
      )}, before=${JSON.stringify(arrangeTargetsBefore)}, after=${JSON.stringify(arrangeTargetsAfter)}`,
    )
  }
  const selectedRowGapsBefore = await page.locator('.dom-node.selected:not([data-node-type="markup"])').evaluateAll((nodes) => {
    const sorted = nodes
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return { id: node.getAttribute('data-node-id'), left: rect.left, right: rect.right }
      })
      .sort((a, b) => a.left - b.left)

    return sorted.slice(0, -1).map((node, index) => sorted[index + 1].left - node.right)
  })
  const spacingHandle = page.locator('.selection-spacing-handle.horizontal').first()
  if ((await spacingHandle.count()) !== 1 || selectedRowGapsBefore.length < 1) {
    throw new Error(`Arrange row should expose a draggable horizontal spacing handle: gaps=${JSON.stringify(selectedRowGapsBefore)}`)
  }
  const spacingHandleLabelHidden = await spacingHandle.locator('span').evaluate((label) => getComputedStyle(label).opacity === '0')
  if (!spacingHandleLabelHidden) {
    throw new Error('Smart spacing labels should stay hidden until hover or drag')
  }
  const spacingHandleBox = await spacingHandle.boundingBox()
  if (!spacingHandleBox) throw new Error('Missing spacing handle bounds')
  const spacingHandleElement = await spacingHandle.elementHandle()
  if (!spacingHandleElement) throw new Error('Missing spacing handle element')
  await page.mouse.move(spacingHandleBox.x + spacingHandleBox.width / 2, spacingHandleBox.y + spacingHandleBox.height / 2)
  await page.waitForFunction((element) => {
    const label = element.querySelector('span')
    return label ? Number(getComputedStyle(label).opacity) > 0.5 : false
  }, spacingHandleElement)
  await page.mouse.down()
  await page.mouse.move(spacingHandleBox.x + spacingHandleBox.width / 2 + 48, spacingHandleBox.y + spacingHandleBox.height / 2, {
    steps: 6,
  })
  await page.mouse.up()
  const selectedRowGapsAfter = await page.locator('.dom-node.selected:not([data-node-type="markup"])').evaluateAll((nodes) => {
    const sorted = nodes
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return { id: node.getAttribute('data-node-id'), left: rect.left, right: rect.right }
      })
      .sort((a, b) => a.left - b.left)

    return sorted.slice(0, -1).map((node, index) => sorted[index + 1].left - node.right)
  })
  const gapSpreadAfterDrag = Math.max(...selectedRowGapsAfter) - Math.min(...selectedRowGapsAfter)
  if (selectedRowGapsAfter.some((gap) => gap < selectedRowGapsBefore[0] + 24) || gapSpreadAfterDrag > 2) {
    throw new Error(
      `Dragging the horizontal spacing handle should create a larger uniform smart-selection gap: before=${JSON.stringify(
        selectedRowGapsBefore,
      )}, after=${JSON.stringify(selectedRowGapsAfter)}`,
    )
  }
  await pressCanvasShortcut('z')
  await page.waitForSelector('.selection-quick-toolbar')

  if ((await page.locator('.node-handle').count()) !== 0) {
    throw new Error('Multi-selection should hide individual node resize handles')
  }

  const multiSelectionStyle = await page.locator('.dom-node.selected').first().evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    }
  })
  if (
    multiSelectionStyle.outlineWidth === '0px' ||
    multiSelectionStyle.boxShadow !== 'none' ||
    !multiSelectionStyle.outlineColor.includes('105, 87, 232')
  ) {
    throw new Error(`Multi-selection should keep subtle per-node outlines without heavy shadows: ${JSON.stringify(multiSelectionStyle)}`)
  }

  const groupHandleStyle = await page.locator('.selection-handle.nw').evaluate((handle) => {
    const style = getComputedStyle(handle)
    return {
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      width: style.width,
      height: style.height,
    }
  })
  if (
    groupHandleStyle.borderRadius !== singleHandleStyle.borderRadius ||
    groupHandleStyle.borderWidth !== singleHandleStyle.borderWidth ||
    groupHandleStyle.width !== singleHandleStyle.width ||
    groupHandleStyle.height !== singleHandleStyle.height
  ) {
    throw new Error(`Single and multi-selection handles should match: single=${JSON.stringify(singleHandleStyle)}, group=${JSON.stringify(groupHandleStyle)}`)
  }
  const groupHandleAlignment = await page.evaluate(() => {
    const bounds = document.querySelector('[data-selection-bounds="true"]')?.getBoundingClientRect()
    const readHandle = (corner) => {
      const handle = document.querySelector(`.selection-handle.${corner}`)
      const rect = handle?.getBoundingClientRect()
      return rect
        ? {
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
          }
        : undefined
    }

    return bounds
      ? {
          bounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
          },
          nw: readHandle('nw'),
          ne: readHandle('ne'),
          sw: readHandle('sw'),
          se: readHandle('se'),
        }
      : undefined
  })
  if (!groupHandleAlignment) throw new Error('Missing group bounds for handle alignment check')
  for (const [corner, expected] of [
    ['nw', { x: groupHandleAlignment.bounds.left, y: groupHandleAlignment.bounds.top }],
    ['ne', { x: groupHandleAlignment.bounds.right, y: groupHandleAlignment.bounds.top }],
    ['sw', { x: groupHandleAlignment.bounds.left, y: groupHandleAlignment.bounds.bottom }],
    ['se', { x: groupHandleAlignment.bounds.right, y: groupHandleAlignment.bounds.bottom }],
  ]) {
    const handle = groupHandleAlignment[corner]
    if (!handle || !nearlyEqual(handle.centerX, expected.x, 1) || !nearlyEqual(handle.centerY, expected.y, 1)) {
      throw new Error(`Multi-selection ${corner} handle should be centered on its corner: ${JSON.stringify(groupHandleAlignment)}`)
    }
  }

  const selectedBeforeShiftToggle = await page.locator('.dom-node.selected').count()
  const shiftToggleNode = page.locator('.dom-node.selected').first()
  const shiftToggleNodeId = await shiftToggleNode.getAttribute('data-node-id')
  const shiftToggleBox = await shiftToggleNode.boundingBox()
  if (!shiftToggleNodeId || !shiftToggleBox) throw new Error('Missing selected node for Shift-toggle check')
  await page.keyboard.down('Shift')
  await page.mouse.click(shiftToggleBox.x + shiftToggleBox.width / 2, shiftToggleBox.y + shiftToggleBox.height / 2)
  await page.keyboard.up('Shift')
  await page.waitForFunction(
    ({ nodeId, expectedCount }) => {
      const node = document.querySelector(`[data-node-id="${nodeId}"]`)
      return !node?.classList.contains('selected') && document.querySelectorAll('.dom-node.selected').length === expectedCount
    },
    { nodeId: shiftToggleNodeId, expectedCount: selectedBeforeShiftToggle - 1 },
  )
  await page.keyboard.down('Shift')
  await page.mouse.click(shiftToggleBox.x + shiftToggleBox.width / 2, shiftToggleBox.y + shiftToggleBox.height / 2)
  await page.keyboard.up('Shift')
  await page.waitForFunction(
    ({ nodeId, expectedCount }) => {
      const node = document.querySelector(`[data-node-id="${nodeId}"]`)
      return node?.classList.contains('selected') && document.querySelectorAll('.dom-node.selected').length === expectedCount
    },
    { nodeId: shiftToggleNodeId, expectedCount: selectedBeforeShiftToggle },
  )

  const selectedMedia = page.locator('.dom-node.selected .dom-node-media')
  const beforeGroupResizeFirst = await selectedMedia.nth(0).boundingBox()
  const beforeGroupResizeSecond = await selectedMedia.nth(1).boundingBox()
  const groupHandle = await page.locator('.selection-handle.se').boundingBox()
  if (!beforeGroupResizeFirst || !beforeGroupResizeSecond || !groupHandle) {
    throw new Error('Missing group selection geometry before resize')
  }

  const distanceBeforeGroupResize = Math.abs(
    beforeGroupResizeSecond.x + beforeGroupResizeSecond.width / 2 -
      (beforeGroupResizeFirst.x + beforeGroupResizeFirst.width / 2),
  )

  await page.mouse.move(groupHandle.x + groupHandle.width / 2, groupHandle.y + groupHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(groupHandle.x + groupHandle.width / 2 + 120, groupHandle.y + groupHandle.height / 2 + 120)
  await page.mouse.up()

  const afterGroupResizeFirst = await selectedMedia.nth(0).boundingBox()
  const afterGroupResizeSecond = await selectedMedia.nth(1).boundingBox()
  if (!afterGroupResizeFirst || !afterGroupResizeSecond) throw new Error('Missing group-resized node geometry')

  if (
    afterGroupResizeFirst.width <= beforeGroupResizeFirst.width ||
    afterGroupResizeSecond.width <= beforeGroupResizeSecond.width
  ) {
    throw new Error(
      `Dragging the multi-selection handle should scale every selected node: before=${JSON.stringify({
        first: beforeGroupResizeFirst,
        second: beforeGroupResizeSecond,
      })}, after=${JSON.stringify({ first: afterGroupResizeFirst, second: afterGroupResizeSecond })}`,
    )
  }

  const distanceAfterGroupResize = Math.abs(
    afterGroupResizeSecond.x + afterGroupResizeSecond.width / 2 -
      (afterGroupResizeFirst.x + afterGroupResizeFirst.width / 2),
  )
  if (distanceAfterGroupResize <= distanceBeforeGroupResize) {
    throw new Error('Group resize should preserve and scale the relative spacing between selected nodes')
  }

  await pressCanvasShortcut('z')
  await page.waitForFunction(
    ({ nodeId, width }) => {
      const media = document.querySelector(`[data-node-id="${nodeId}"] .dom-node-media`)
      const rect = media?.getBoundingClientRect()
      return rect ? Math.abs(rect.width - width) <= 2 : false
    },
    { nodeId: firstNodeId, width: beforeGroupSelectFirst.width },
  )
  await page.keyboard.press('Escape')
  await selectedNode.click()

  const beforeSnap = await firstNodeMedia.boundingBox()
  const snapTarget = await secondNodeMedia.boundingBox()
  if (!beforeSnap || !snapTarget) throw new Error('Missing nodes for snap alignment check')

  await page.mouse.move(beforeSnap.x + beforeSnap.width / 2, beforeSnap.y + beforeSnap.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    beforeSnap.x + beforeSnap.width / 2 + (snapTarget.x - beforeSnap.x) + 5,
    beforeSnap.y + beforeSnap.height / 2,
  )
  await page.waitForFunction(() => document.querySelectorAll('.snap-guide').length > 0)
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.snap-guide').length === 0)

  const afterSnap = await firstNodeMedia.boundingBox()
  if (!afterSnap || !nearlyEqual(afterSnap.x, snapTarget.x)) {
    throw new Error(`Dragging near another image edge should snap-align: got ${afterSnap?.x}, want ${snapTarget.x}`)
  }

  const resizeSnapData = await page.evaluate((nodeId) => {
    const node = document.querySelector(`[data-node-id="${nodeId}"]`)
    const media = node?.querySelector('.dom-node-media')
    const mediaRect = media?.getBoundingClientRect()
    const peerEdges = [...document.querySelectorAll('.dom-node')]
      .filter((item) => item.getAttribute('data-node-id') !== nodeId)
      .map((item) => item.querySelector('.dom-node-media')?.getBoundingClientRect())
      .filter(Boolean)
      .flatMap((rect) => [rect.left, rect.left + rect.width / 2, rect.right])
      .filter((edge) => mediaRect && edge > mediaRect.left + mediaRect.width + 40 && edge - mediaRect.left <= 720)
      .sort((a, b) => a - b)

    return mediaRect && peerEdges[0]
      ? {
          left: mediaRect.left,
          top: mediaRect.top,
          width: mediaRect.width,
          height: mediaRect.height,
          targetRight: peerEdges[0],
        }
      : undefined
  }, firstNodeId)

  if (!resizeSnapData) throw new Error('Missing a peer edge for resize snap check')

  const resizeSnapHandle = await page.locator('.node-handle.se').first().boundingBox()
  if (!resizeSnapHandle) throw new Error('Missing selected node resize handle for snap check')

  const resizeSnapTargetWidth = resizeSnapData.targetRight - resizeSnapData.left
  const resizeSnapWidth = resizeSnapTargetWidth - 5
  const resizeSnapHeight = resizeSnapWidth / (resizeSnapData.width / resizeSnapData.height)

  await page.mouse.move(
    resizeSnapHandle.x + resizeSnapHandle.width / 2,
    resizeSnapHandle.y + resizeSnapHandle.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    resizeSnapHandle.x + resizeSnapHandle.width / 2 + (resizeSnapWidth - resizeSnapData.width),
    resizeSnapHandle.y + resizeSnapHandle.height / 2 + (resizeSnapHeight - resizeSnapData.height),
  )
  await page.waitForFunction(() => document.querySelectorAll('.snap-guide').length > 0)
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.snap-guide').length === 0)

  const afterResizeSnap = await firstNodeMedia.boundingBox()
  if (!afterResizeSnap || !nearlyEqual(afterResizeSnap.x + afterResizeSnap.width, resizeSnapData.targetRight)) {
    const actualRight = afterResizeSnap ? afterResizeSnap.x + afterResizeSnap.width : 'missing'
    throw new Error(
      `Resizing near another image edge should snap-align: got ${actualRight}, want ${resizeSnapData.targetRight}`,
    )
  }

  await page.locator('.canvas-controls').getByRole('button', { name: 'Fit selection' }).click()
  const beforeResize = await firstNodeMedia.boundingBox()
  const resizeHandle = await selectedNode.locator('.node-handle.se').boundingBox()
  if (!beforeResize || !resizeHandle) throw new Error('Missing selected node resize handle')

  await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(resizeHandle.x + 80, resizeHandle.y + 120)
  await page.mouse.up()

  const afterResize = await firstNodeMedia.boundingBox()
  if (!afterResize || afterResize.width <= beforeResize.width || afterResize.height <= beforeResize.height) {
    const resizeDebug = await selectedNode.evaluate((node) => ({
      className: node.className,
      sectionId: node.getAttribute('data-section-id'),
      handleCount: node.querySelectorAll('.node-handle').length,
    }))
    throw new Error(
      `Dragging a corner handle should resize the selected image: before=${JSON.stringify(beforeResize)}, after=${JSON.stringify(afterResize)}, handle=${JSON.stringify(resizeHandle)}, node=${JSON.stringify(resizeDebug)}`,
    )
  }

  if (!nearlyEqual(afterResize.x, beforeResize.x) || !nearlyEqual(afterResize.y, beforeResize.y)) {
    throw new Error('Dragging the bottom-right handle should keep the top-left anchor fixed')
  }

  if (afterResize.x + afterResize.width <= beforeResize.x + beforeResize.width) {
    throw new Error('Dragging the bottom-right handle should grow the image to the right')
  }

  if (afterResize.y + afterResize.height <= beforeResize.y + beforeResize.height) {
    throw new Error('Dragging the bottom-right handle should grow the image downward')
  }

  const beforeRatio = beforeResize.width / beforeResize.height
  const afterRatio = afterResize.width / afterResize.height
  if (Math.abs(beforeRatio - afterRatio) > 0.02) {
    throw new Error(`Corner resize should preserve aspect ratio: before=${beforeRatio}, after=${afterRatio}`)
  }

  const beforeNorthwestResize = await firstNodeMedia.boundingBox()
  const northwestHandle = await page.locator('.node-handle.nw').first().boundingBox()
  if (!beforeNorthwestResize || !northwestHandle) throw new Error('Missing selected node northwest resize handle')

  await page.mouse.move(northwestHandle.x + northwestHandle.width / 2, northwestHandle.y + northwestHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(northwestHandle.x - 80, northwestHandle.y - 120)
  await page.mouse.up()

  const afterNorthwestResize = await firstNodeMedia.boundingBox()
  if (!afterNorthwestResize) throw new Error('Missing resized node media after northwest drag')

  if (
    !nearlyEqual(
      afterNorthwestResize.x + afterNorthwestResize.width,
      beforeNorthwestResize.x + beforeNorthwestResize.width,
    ) ||
    !nearlyEqual(
      afterNorthwestResize.y + afterNorthwestResize.height,
      beforeNorthwestResize.y + beforeNorthwestResize.height,
    )
  ) {
    throw new Error('Dragging the top-left handle should keep the bottom-right anchor fixed')
  }

  if (afterNorthwestResize.x >= beforeNorthwestResize.x || afterNorthwestResize.y >= beforeNorthwestResize.y) {
    throw new Error('Dragging the top-left handle should grow the image upward and leftward')
  }

  await selectedNode.click()
  await page.locator('.canvas-controls').getByRole('button', { name: 'Fit selection' }).click()
  await wait(60)
  const beforeCrop = await selectedNode.locator('.dom-node-media').boundingBox()
  if (!beforeCrop) throw new Error('Missing selected node media before crop')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Crop' }).click()
  await page.waitForSelector('.image-crop-overlay')
  const cropHandle = await page.locator('.image-crop-handle.se').boundingBox()
  if (!cropHandle) throw new Error('Crop overlay should expose corner handles')
  await page.mouse.move(cropHandle.x + cropHandle.width / 2, cropHandle.y + cropHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(cropHandle.x + cropHandle.width / 2 - 48, cropHandle.y + cropHandle.height / 2 - 36)
  await page.mouse.up()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForSelector('.image-crop-overlay', { state: 'detached' })

  const afterCrop = await selectedNode.locator('.dom-node-media').boundingBox()
  const cropRenderState = await selectedNode.evaluate((node) => {
    const image = node.querySelector('.dom-node-media img')
    const imageStyle = image ? window.getComputedStyle(image) : undefined

    return {
      imageClass: image?.getAttribute('class') || '',
      imageObjectFit: imageStyle?.objectFit,
    }
  })
  if (
    !afterCrop ||
    afterCrop.width >= beforeCrop.width - 16 ||
    afterCrop.height >= beforeCrop.height - 16 ||
    !cropRenderState.imageClass.includes('cropped-image') ||
    cropRenderState.imageObjectFit !== 'fill'
  ) {
    throw new Error(
      `Crop should shrink the display frame while rendering the original image through a crop window: before=${JSON.stringify(
        beforeCrop,
      )}, after=${JSON.stringify(afterCrop)}, render=${JSON.stringify(cropRenderState)}`,
    )
  }

  await selectedNode.click()
  await selectedNode.dblclick()
  await page.waitForSelector('.details-dialog[role="dialog"]')

  const detailPreviewFit = await page.locator('.details-dialog .node-preview').evaluate((preview) => {
    const image = preview.querySelector('img')
    const previewRect = preview.getBoundingClientRect()
    const imageRect = image?.getBoundingClientRect()

    return {
      hasImage: Boolean(imageRect),
      preview: {
        width: previewRect.width,
        height: previewRect.height,
      },
      image: imageRect
        ? {
            width: imageRect.width,
            height: imageRect.height,
          }
        : undefined,
    }
  })

  if (!detailPreviewFit.hasImage || !detailPreviewFit.image) {
    throw new Error('Details dialog should render the selected image')
  }

  if (
    detailPreviewFit.image.width > detailPreviewFit.preview.width + 1 ||
    detailPreviewFit.image.height > detailPreviewFit.preview.height + 1
  ) {
    throw new Error(
      `Details image overflows preview: image=${detailPreviewFit.image.width}x${detailPreviewFit.image.height}, preview=${detailPreviewFit.preview.width}x${detailPreviewFit.preview.height}`,
    )
  }

  await page.getByRole('button', { name: 'Close details' }).click()
  await page.waitForSelector('.details-dialog', { state: 'detached' })

  await selectedNode.click({ button: 'right' })
  await page.waitForFunction(() => {
    const menu = document.querySelector('.node-context-menu')
    if (!menu) return false
    const rect = menu.getBoundingClientRect()

    return rect.left >= 11 && rect.top >= 11 && rect.right <= window.innerWidth - 11 && rect.bottom <= window.innerHeight - 11
  })
  const expectedContextActions = [
    'View details',
    'Duplicate image',
    'Generate beside',
    'Add edit note',
    'Make variations',
    'Crop',
    'Bring forward',
    'Send backward',
    'Bring to front',
    'Send to back',
    'Download original',
    'Delete image',
  ]

  for (const action of expectedContextActions) {
    if ((await page.getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Missing right-click menu action: ${action}`)
    }
  }
  for (const action of ['Upscale HD', 'Video', 'Expand', 'Mask', 'Remove background', 'Erase']) {
    if ((await page.getByRole('menuitem', { name: action }).count()) !== 0) {
      throw new Error(`${action} should stay hidden until its workflow exists`)
    }
  }

  if ((await page.locator('.node-action-separator').count()) < 5) {
    throw new Error('Right-click menu actions should be grouped with separators')
  }

  const originalDownload = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Download original' }).click()
  const downloadedOriginal = await originalDownload
  if (downloadedOriginal.suggestedFilename() !== 'courage-1.jpg') {
    throw new Error(`Download original should use the source asset filename, got ${downloadedOriginal.suggestedFilename()}`)
  }
  await page.waitForSelector('.node-context-menu', { state: 'detached' })

  await selectedNode.evaluate((node) => {
    node.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: window.innerWidth - 8,
      clientY: window.innerHeight - 8,
    }))
  })
  await page.waitForFunction(() => {
    const menu = document.querySelector('.node-context-menu')
    if (!menu) return false
    const rect = menu.getBoundingClientRect()

    return rect.left >= 11 && rect.top >= 11 && rect.right <= window.innerWidth - 11 && rect.bottom <= window.innerHeight - 11
  })

  await page.getByRole('menuitem', { name: 'Bring to front' }).click()
  const topNodeId = await page.locator('.dom-node').last().getAttribute('data-node-id')
  if (topNodeId !== firstNodeId) {
    throw new Error(`Bring to front should move the node to the top layer: got ${topNodeId}`)
  }

  await selectedNode.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Duplicate image' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count + 1, initialCount)
  const countAfterDuplicate = await page.locator('.dom-node').count()
  const duplicateNodeId = await page.locator('.dom-node').last().getAttribute('data-node-id')
  if (!duplicateNodeId || duplicateNodeId === firstNodeId) {
    throw new Error('Duplicate image should create a new node on the top layer')
  }

  await page.locator(`[data-node-id="${duplicateNodeId}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete image' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count - 1, countAfterDuplicate)

  const countAfterDelete = await page.locator('.dom-node').count()
  if (countAfterDelete !== initialCount) {
    throw new Error(`Expected ${initialCount} nodes after duplicate and deletion, got ${countAfterDelete}`)
  }

  await selectedNode.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View details' }).click()
  await page.waitForSelector('.details-dialog[role="dialog"]')
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.waitForSelector('.details-dialog', { state: 'detached' })

  // Phase 1b-1 pointer capture plumbing: Hand-on-node pans (not moves) the node,
  // Select large-delta drag past the node bbox keeps tracking via pointer capture.
  await page.getByRole('button', { name: 'Reset view' }).click()
  await page.waitForFunction(() => {
    const shell = document.querySelector('.canvas-shell')
    return shell && Number(shell.getAttribute('data-viewport-scale')) === 1
  })
  const handOnNodeViewportBefore = Number(await page.locator('.canvas-shell').getAttribute('data-viewport-x'))
  const handOnNodeMediaBefore = await firstNodeMedia.boundingBox()
  if (!handOnNodeMediaBefore) throw new Error('Missing first node for Hand-on-node pan check')
  await page.getByRole('button', { name: 'Hand' }).click()
  await page.mouse.move(
    handOnNodeMediaBefore.x + handOnNodeMediaBefore.width / 2,
    handOnNodeMediaBefore.y + handOnNodeMediaBefore.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    handOnNodeMediaBefore.x + handOnNodeMediaBefore.width / 2 + 70,
    handOnNodeMediaBefore.y + handOnNodeMediaBefore.height / 2 + 50,
    { steps: 6 },
  )
  await page.mouse.up()
  const handOnNodeViewportAfter = Number(await page.locator('.canvas-shell').getAttribute('data-viewport-x'))
  if (handOnNodeViewportAfter === handOnNodeViewportBefore) {
    throw new Error(
      `Hand tool dragging on a node should pan the viewport instead of moving the node: before=${handOnNodeViewportBefore}, after=${handOnNodeViewportAfter}`,
    )
  }

  context.firstNodeId = firstNodeId
}
