const DEFAULT_VIEWPORT = { x: 688, y: 240, scale: 1 } // 全铺后默认视口 x=688(旧 420+旧列宽 268)
const MIN_SCALE = 0.08
const MAX_SCALE = 4
const KEYBOARD_ZOOM_FACTOR = 1.12

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale.toFixed(3))))

const expectNear = (actual, expected, tolerance, message) => {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected} +/- ${tolerance}, got ${actual}`)
  }
}

const readViewport = async (page) => {
  const viewport = await page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    if (!shell) return null

    return {
      x: Number(shell.getAttribute('data-viewport-x')),
      y: Number(shell.getAttribute('data-viewport-y')),
      scale: Number(shell.getAttribute('data-viewport-scale')),
      className: shell.className,
    }
  })
  if (!viewport) throw new Error('Canvas shell should expose viewport attributes')
  return viewport
}

const waitForViewport = async (page, predicate, label, { timeout = 3000 } = {}) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const viewport = await readViewport(page)
    if (predicate(viewport)) return viewport
    await page.waitForTimeout(40)
  }
  throw new Error(`Timed out waiting for viewport: ${label}; last=${JSON.stringify(await readViewport(page))}`)
}

const waitForViewportScale = (page, expectedScale, { tolerance = 0.02 } = {}) =>
  waitForViewport(
    page,
    (viewport) => Math.abs(viewport.scale - expectedScale) <= tolerance,
    `scale=${expectedScale}`,
  )

const waitForDefaultViewport = (page) =>
  waitForViewport(
    page,
    (viewport) =>
      Math.abs(viewport.scale - DEFAULT_VIEWPORT.scale) <= 0.02 &&
      Math.abs(viewport.x - DEFAULT_VIEWPORT.x) <= 1 &&
      Math.abs(viewport.y - DEFAULT_VIEWPORT.y) <= 1,
    'default viewport',
  )

const waitForStoredScale = async (page, sceneId, expectedScale) => {
  await page.waitForFunction(
    ({ sceneId, expectedScale }) => {
      try {
        const raw = window.localStorage.getItem(`mivo-canvas-viewport:${sceneId}`)
        if (!raw) return false
        const viewport = JSON.parse(raw)
        return Math.abs(Number(viewport.scale) - expectedScale) <= 0.02
      } catch {
        return false
      }
    },
    { sceneId, expectedScale },
    { timeout: 3000 },
  )
}

const blurActiveElement = async (page) => {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

const setActiveTool = async (page, label, runtimeClass) => {
  await page.locator('.canvas-tool-dock').getByRole('button', { name: label }).click()
  await page.waitForFunction(
    (runtimeClass) => document.querySelector('.canvas-shell')?.classList.contains(runtimeClass),
    runtimeClass,
  )
}

const resetView = async (page) => {
  await page.getByRole('button', { name: 'Reset view' }).click()
  await waitForDefaultViewport(page)
}

const setupZoomCanvas = async (page, canvasStoreModuleSpec) => {
  const setup = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const store = useCanvasStore.getState()
    const sceneId = store.createCanvas('E2E Zoom Tool')
    useCanvasStore.getState().addImportedImage('/demo-assets/courage-1.jpg', 'zoom-anchor', 'source', { x: 0, y: 0 }, {
      dimensions: { width: 180, height: 120 },
      mimeType: 'image/jpeg',
      originalName: 'zoom-anchor.jpg',
    })
    const nextStore = useCanvasStore.getState()
    const node = nextStore.nodes[nextStore.nodes.length - 1]
    nextStore.selectNode(undefined)
    nextStore.setActiveTool('select')
    return { sceneId, nodeId: node.id }
  }, canvasStoreModuleSpec)

  await page.waitForSelector(`[data-node-id="${setup.nodeId}"]`)
  await waitForDefaultViewport(page)
  return setup
}

const readNodeGeometry = async (page, canvasStoreModuleSpec, nodeId) =>
  page.evaluate(async ({ moduleSpec, nodeId }) => {
    const { useCanvasStore } = await import(moduleSpec)
    const state = useCanvasStore.getState()
    const node = state.nodes.find((item) => item.id === nodeId)
    if (!node) return null
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      selectedNodeId: state.selectedNodeId,
      selectedNodeIds: state.selectedNodeIds,
    }
  }, { moduleSpec: canvasStoreModuleSpec, nodeId })

const readSelection = async (page, canvasStoreModuleSpec) =>
  page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const state = useCanvasStore.getState()
    return {
      selectedNodeId: state.selectedNodeId,
      selectedNodeIds: state.selectedNodeIds,
    }
  }, canvasStoreModuleSpec)

const clearSelection = async (page, canvasStoreModuleSpec) => {
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().selectNode(undefined)
  }, canvasStoreModuleSpec)
}

const canvasPointForScreen = (shellBox, viewport, point) => ({
  x: (point.x - shellBox.x - viewport.x) / viewport.scale,
  y: (point.y - shellBox.y - viewport.y) / viewport.scale,
})

const screenPointForCanvas = (shellBox, viewport, point) => ({
  x: shellBox.x + viewport.x + point.x * viewport.scale,
  y: shellBox.y + viewport.y + point.y * viewport.scale,
})

const assertScreenAnchorPreserved = ({ label, shellBox, beforeViewport, afterViewport, screenPoint }) => {
  const canvasPoint = canvasPointForScreen(shellBox, beforeViewport, screenPoint)
  const projectedPoint = screenPointForCanvas(shellBox, afterViewport, canvasPoint)
  expectNear(projectedPoint.x, screenPoint.x, 2, `${label}: zoom should preserve pointer x`)
  expectNear(projectedPoint.y, screenPoint.y, 2, `${label}: zoom should preserve pointer y`)
}

const findBlankPoint = async (page, preferredFractions = []) => {
  const point = await page.evaluate((preferredFractions) => {
    const shell = document.querySelector('.canvas-shell')
    const shellRect = shell?.getBoundingClientRect()
    if (!shell || !shellRect) return null

    const fractions = [
      ...preferredFractions,
      [0.18, 0.24],
      [0.24, 0.68],
      [0.38, 0.18],
      [0.48, 0.72],
      [0.62, 0.22],
      [0.72, 0.64],
    ]
    const blockedSelector = [
      '.dom-node',
      '.canvas-tool-dock',
      '.canvas-controls',
      '.selection-quick-toolbar',
      '.node-context-menu',
      '.node-action-menu',
      '.ai-panel',
      '.asset-library-drawer',
      'button',
      'input',
      'textarea',
      'select',
    ].join(', ')

    for (const [fx, fy] of fractions) {
      const x = shellRect.left + shellRect.width * fx
      const y = shellRect.top + shellRect.height * fy
      const target = document.elementFromPoint(x, y)
      if (target?.closest('.canvas-shell') && !target.closest(blockedSelector)) {
        return { x, y }
      }
    }

    return null
  }, preferredFractions)

  if (!point) throw new Error('Could not find a blank canvas point for zoom interaction')
  return point
}

const withTemporaryZoom = async (page, expectedReturnClass, callback) => {
  await blurActiveElement(page)
  await page.keyboard.down('z')
  await page.waitForFunction(() => document.querySelector('.canvas-shell')?.classList.contains('tool-zoom'))

  try {
    await callback()
  } finally {
    await page.keyboard.up('z')
  }

  await page.waitForFunction(
    (expectedReturnClass) => {
      const shell = document.querySelector('.canvas-shell')
      return shell && !shell.classList.contains('tool-zoom') && shell.classList.contains(expectedReturnClass)
    },
    expectedReturnClass,
  )
}

const dispatchWindowShortcut = async (page, { key, code, metaKey = false, ctrlKey = false, altKey = false, shiftKey = false }) => {
  await blurActiveElement(page)
  await page.evaluate(({ key, code, metaKey, ctrlKey, altKey, shiftKey }) => {
    const eventInit = {
      key,
      code,
      metaKey,
      ctrlKey,
      altKey,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }
    window.dispatchEvent(new KeyboardEvent('keydown', eventInit))
    window.dispatchEvent(new KeyboardEvent('keyup', eventInit))
  }, { key, code, metaKey, ctrlKey, altKey, shiftKey })
}

const assertToolbarRetiredButtonsRemoved = async (page) => {
  for (const label of ['Comment', 'Image', 'Video']) {
    const count = await page.locator('.canvas-tool-dock').getByRole('button', { name: label, exact: true }).count()
    if (count !== 0) {
      throw new Error(`Canvas tool dock should not expose retired ${label} button`)
    }
  }
}

const assertKeyboardZoomShortcuts = async (page) => {
  await resetView(page)

  const beforePlus = await readViewport(page)
  await dispatchWindowShortcut(page, { key: '+', code: 'Equal' })
  await waitForViewportScale(page, clampScale(beforePlus.scale * KEYBOARD_ZOOM_FACTOR))

  const beforeMinus = await readViewport(page)
  await dispatchWindowShortcut(page, { key: '-', code: 'Minus' })
  await waitForViewportScale(page, clampScale(beforeMinus.scale / KEYBOARD_ZOOM_FACTOR))

  const shortcutModifier = process.platform === 'darwin'
    ? { metaKey: true, ctrlKey: false }
    : { metaKey: false, ctrlKey: true }
  const beforeAliasPlus = await readViewport(page)
  await dispatchWindowShortcut(page, { key: '=', code: 'Equal', ...shortcutModifier })
  await waitForViewportScale(page, clampScale(beforeAliasPlus.scale * KEYBOARD_ZOOM_FACTOR))

  const beforeAliasMinus = await readViewport(page)
  await dispatchWindowShortcut(page, { key: '-', code: 'Minus', ...shortcutModifier })
  await waitForViewportScale(page, clampScale(beforeAliasMinus.scale / KEYBOARD_ZOOM_FACTOR))
}

const assertShortcutResetKeepsCenter = async (page) => {
  await resetView(page)
  const shellBox = await page.locator('.canvas-shell').boundingBox()
  if (!shellBox) throw new Error('Missing canvas shell geometry for shortcut reset check')

  await page.mouse.move(shellBox.x + shellBox.width / 2, shellBox.y + shellBox.height / 2)
  await page.mouse.wheel(160, -120)
  await waitForViewport(
    page,
    (viewport) =>
      Math.abs(viewport.x - DEFAULT_VIEWPORT.x) > 20 ||
      Math.abs(viewport.y - DEFAULT_VIEWPORT.y) > 20,
    'wheel pan before shortcut reset',
  )

  const beforeCenterZoom = await readViewport(page)
  await dispatchWindowShortcut(page, { key: '+', code: 'Equal' })
  const beforeReset = await waitForViewportScale(page, clampScale(beforeCenterZoom.scale * KEYBOARD_ZOOM_FACTOR))
  const centerScreenPoint = {
    x: shellBox.x + shellBox.width / 2,
    y: shellBox.y + shellBox.height / 2,
  }
  const centerCanvasBefore = canvasPointForScreen(shellBox, beforeReset, centerScreenPoint)
  const shortcutModifier = process.platform === 'darwin'
    ? { metaKey: true, ctrlKey: false }
    : { metaKey: false, ctrlKey: true }

  await dispatchWindowShortcut(page, { key: '0', code: 'Digit0', ...shortcutModifier })
  const afterReset = await waitForViewportScale(page, 1)
  const centerCanvasAfter = canvasPointForScreen(shellBox, afterReset, centerScreenPoint)

  expectNear(centerCanvasAfter.x, centerCanvasBefore.x, 2, 'Cmd/Ctrl+0 should preserve viewport-center canvas x')
  expectNear(centerCanvasAfter.y, centerCanvasBefore.y, 2, 'Cmd/Ctrl+0 should preserve viewport-center canvas y')
  if (
    Math.abs(afterReset.x - DEFAULT_VIEWPORT.x) <= 2 &&
    Math.abs(afterReset.y - DEFAULT_VIEWPORT.y) <= 2
  ) {
    throw new Error(`Cmd/Ctrl+0 should not jump back to the default viewport position: ${JSON.stringify(afterReset)}`)
  }
}

const assertInputFocusIgnoresZoomKeys = async (page, ensureChatPanelOpen) => {
  await ensureChatPanelOpen()
  const before = await readViewport(page)
  await page.locator('.chat-composer-textarea').focus()
  await page.evaluate(() => {
    const target = document.querySelector('.chat-composer-textarea')
    if (!(target instanceof HTMLElement)) throw new Error('Chat composer textarea should be focusable')
    const keys = [
      { key: '+', code: 'Equal' },
      { key: '-', code: 'Minus' },
      { key: 'z', code: 'KeyZ' },
    ]
    for (const keyInit of keys) {
      const eventInit = { ...keyInit, bubbles: true, cancelable: true }
      target.dispatchEvent(new KeyboardEvent('keydown', eventInit))
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit))
    }
  })
  await page.waitForTimeout(120)
  const after = await readViewport(page)
  expectNear(after.scale, before.scale, 0.001, 'Focused input should ignore +/-/z zoom shortcuts')
  expectNear(after.x, before.x, 0.001, 'Focused input should not pan or reset viewport x')
  expectNear(after.y, before.y, 0.001, 'Focused input should not pan or reset viewport y')
  if (after.className.includes('tool-zoom')) {
    throw new Error(`Focused input should not enter temporary zoom mode: ${after.className}`)
  }
}

export const runZoomToolScenario = async (context) => {
  const { canvasStoreSpec, ensureChatPanelOpen, page } = context
  const canvasStoreModuleSpec = await canvasStoreSpec()
  const { sceneId, nodeId } = await setupZoomCanvas(page, canvasStoreModuleSpec)

  await assertToolbarRetiredButtonsRemoved(page)

  await setActiveTool(page, 'Hand', 'tool-hand')
  const blankZoomPoint = await findBlankPoint(page, [[0.22, 0.28]])
  const shellBoxForClick = await page.locator('.canvas-shell').boundingBox()
  if (!shellBoxForClick) throw new Error('Missing canvas shell geometry for hold-Z click')
  const beforeHoldZoom = await readViewport(page)
  await withTemporaryZoom(page, 'tool-hand', async () => {
    await page.mouse.click(blankZoomPoint.x, blankZoomPoint.y)
    const afterHoldZoom = await waitForViewportScale(page, clampScale(beforeHoldZoom.scale * 2))
    assertScreenAnchorPreserved({
      label: 'hold-Z blank click',
      shellBox: shellBoxForClick,
      beforeViewport: beforeHoldZoom,
      afterViewport: afterHoldZoom,
      screenPoint: blankZoomPoint,
    })
  })
  await waitForStoredScale(page, sceneId, 2)

  await setActiveTool(page, 'Select', 'tool-select')
  await resetView(page)
  const altPoint = await findBlankPoint(page, [[0.26, 0.64]])
  const shellBoxForAlt = await page.locator('.canvas-shell').boundingBox()
  if (!shellBoxForAlt) throw new Error('Missing canvas shell geometry for Alt zoom')
  const beforeAltZoom = await readViewport(page)
  await withTemporaryZoom(page, 'tool-select', async () => {
    await page.keyboard.down('Alt')
    try {
      await page.waitForFunction(() => document.querySelector('.canvas-shell')?.classList.contains('zoom-out-cursor'))
      await page.mouse.click(altPoint.x, altPoint.y)
      const afterAltZoom = await waitForViewportScale(page, clampScale(beforeAltZoom.scale / 2))
      assertScreenAnchorPreserved({
        label: 'Z+Alt blank click',
        shellBox: shellBoxForAlt,
        beforeViewport: beforeAltZoom,
        afterViewport: afterAltZoom,
        screenPoint: altPoint,
      })
    } finally {
      await page.keyboard.up('Alt')
    }
  })

  await resetView(page)
  await clearSelection(page, canvasStoreModuleSpec)
  const nodeBeforeZoom = await readNodeGeometry(page, canvasStoreModuleSpec, nodeId)
  if (!nodeBeforeZoom) throw new Error('Missing imported image node before node zoom')
  const nodeBoxBeforeZoom = await page.locator(`[data-node-id="${nodeId}"]`).boundingBox()
  const shellBoxForNode = await page.locator('.canvas-shell').boundingBox()
  if (!nodeBoxBeforeZoom || !shellBoxForNode) throw new Error('Missing node or shell geometry for node zoom')
  const nodeZoomPoint = {
    x: nodeBoxBeforeZoom.x + nodeBoxBeforeZoom.width / 2,
    y: nodeBoxBeforeZoom.y + nodeBoxBeforeZoom.height / 2,
  }
  const beforeNodeZoom = await readViewport(page)
  await withTemporaryZoom(page, 'tool-select', async () => {
    await page.mouse.click(nodeZoomPoint.x, nodeZoomPoint.y)
    const afterNodeZoom = await waitForViewportScale(page, clampScale(beforeNodeZoom.scale * 2))
    assertScreenAnchorPreserved({
      label: 'hold-Z node click',
      shellBox: shellBoxForNode,
      beforeViewport: beforeNodeZoom,
      afterViewport: afterNodeZoom,
      screenPoint: nodeZoomPoint,
    })
  })
  const nodeAfterZoom = await readNodeGeometry(page, canvasStoreModuleSpec, nodeId)
  const selectionAfterNodeZoom = await readSelection(page, canvasStoreModuleSpec)
  if (
    !nodeAfterZoom ||
    nodeAfterZoom.x !== nodeBeforeZoom.x ||
    nodeAfterZoom.y !== nodeBeforeZoom.y ||
    nodeAfterZoom.width !== nodeBeforeZoom.width ||
    nodeAfterZoom.height !== nodeBeforeZoom.height
  ) {
    throw new Error(`hold-Z node click should not move or resize the node: before=${JSON.stringify(nodeBeforeZoom)}, after=${JSON.stringify(nodeAfterZoom)}`)
  }
  if (selectionAfterNodeZoom.selectedNodeId || selectionAfterNodeZoom.selectedNodeIds.length !== 0) {
    throw new Error(`hold-Z node click should not select the node: ${JSON.stringify(selectionAfterNodeZoom)}`)
  }

  await resetView(page)
  const marqueeShellBox = await page.locator('.canvas-shell').boundingBox()
  if (!marqueeShellBox) throw new Error('Missing canvas shell geometry for zoom marquee')
  const marqueeRect = {
    left: marqueeShellBox.x + marqueeShellBox.width * 0.22,
    top: marqueeShellBox.y + marqueeShellBox.height * 0.18,
    right: marqueeShellBox.x + marqueeShellBox.width * 0.62,
    bottom: marqueeShellBox.y + marqueeShellBox.height * 0.58,
  }
  const beforeMarqueeZoom = await readViewport(page)
  const marqueeCanvasStart = canvasPointForScreen(marqueeShellBox, beforeMarqueeZoom, { x: marqueeRect.left, y: marqueeRect.top })
  const marqueeCanvasEnd = canvasPointForScreen(marqueeShellBox, beforeMarqueeZoom, { x: marqueeRect.right, y: marqueeRect.bottom })
  const marqueeBounds = {
    x: Math.min(marqueeCanvasStart.x, marqueeCanvasEnd.x),
    y: Math.min(marqueeCanvasStart.y, marqueeCanvasEnd.y),
    width: Math.abs(marqueeCanvasEnd.x - marqueeCanvasStart.x),
    height: Math.abs(marqueeCanvasEnd.y - marqueeCanvasStart.y),
  }
  await withTemporaryZoom(page, 'tool-select', async () => {
    await page.mouse.move(marqueeRect.left, marqueeRect.top)
    await page.mouse.down()
    await page.mouse.move(marqueeRect.right, marqueeRect.bottom, { steps: 8 })
    await page.waitForSelector('.zoom-marquee')
    await page.mouse.up()
    await page.waitForSelector('.zoom-marquee', { state: 'detached' }).catch(() => {})
  })
  const afterMarqueeZoom = await waitForViewport(
    page,
    (viewport) => viewport.scale > beforeMarqueeZoom.scale * 2,
    'zoom marquee should increase scale',
  )
  const marqueeTopLeft = screenPointForCanvas(marqueeShellBox, afterMarqueeZoom, { x: marqueeBounds.x, y: marqueeBounds.y })
  const marqueeBottomRight = screenPointForCanvas(marqueeShellBox, afterMarqueeZoom, {
    x: marqueeBounds.x + marqueeBounds.width,
    y: marqueeBounds.y + marqueeBounds.height,
  })
  expectNear(marqueeTopLeft.x, marqueeShellBox.x, 3, 'Zoom marquee should fit left edge with zero padding')
  expectNear(marqueeTopLeft.y, marqueeShellBox.y, 3, 'Zoom marquee should fit top edge with zero padding')
  expectNear(marqueeBottomRight.x, marqueeShellBox.x + marqueeShellBox.width, 3, 'Zoom marquee should fit right edge with zero padding')
  expectNear(marqueeBottomRight.y, marqueeShellBox.y + marqueeShellBox.height, 3, 'Zoom marquee should fit bottom edge with zero padding')

  await assertKeyboardZoomShortcuts(page)
  await assertShortcutResetKeepsCenter(page)
  await assertInputFocusIgnoresZoomKeys(page, ensureChatPanelOpen)
}
