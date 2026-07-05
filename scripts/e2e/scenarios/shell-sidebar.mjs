export const runShellSidebarScenario = async (context) => {
  const {
    assertTasksHeaderCopy,
    baseUrl,
    canvasStoreSpec,
    canvasUrl,
    ensureChatPanelOpen,
    nearlyEqual,
    page,
    readChatState,
    readFloatingChrome,
    readHeaderTasksIndicator,
    wait,
  } = context
  const sidebarGap = 14
  const sidebarWidth = 240
  const sidebarBorderWidth = 1
  const sidebarPadding = 14
  const sidebarColumnWidth = sidebarWidth + sidebarGap * 2
  const sidebarContentLeft = sidebarGap + sidebarBorderWidth + sidebarPadding
  const sidebarContentTop = sidebarGap + sidebarBorderWidth + sidebarPadding
  const sidebarLogoTop = sidebarContentTop + 2
  const sidebarToggleLeft = sidebarContentLeft + 78 + 8
  const sidebarWorkspaceTitleLeft = sidebarColumnWidth + sidebarGap
  const collapsedTitleLeft = sidebarGap + 154

  // FU4-2: clear web storage before app scripts. addInitScript runs sync before the
  // hydration gate, so it can't await an IDB clear — but each scenario runs on a fresh
  // browser (IDB empty), so clearing localStorage + sessionStorage (migration markers)
  // suffices. e2e-smoke's bootstrapBaseCanvas uses the async clearAllStorage for the
  // shared-page case.
  await page.addInitScript(() => {
    try { window.localStorage.clear() } catch { /* opaque origin */ }
    try { window.sessionStorage.clear() } catch { /* opaque origin */ }
  })
  await page.goto(canvasUrl || baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')

  await ensureChatPanelOpen()
  await assertTasksHeaderCopy('idle header')
  const idleTasksIndicator = await readHeaderTasksIndicator()
  if (!idleTasksIndicator.hasIndicator || !idleTasksIndicator.hasLabel || idleTasksIndicator.hasSpinner) {
    throw new Error(`Idle header should keep TASKS title without spinner: ${JSON.stringify(idleTasksIndicator)}`)
  }
  if (
    idleTasksIndicator.expectedLeft === null ||
    !idleTasksIndicator.label ||
    Math.abs(idleTasksIndicator.label.left - idleTasksIndicator.expectedLeft) > 1.5
  ) {
    throw new Error(`Idle TASKS title should align to the header content left edge: ${JSON.stringify(idleTasksIndicator)}`)
  }
  const previousTasks = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const previousTasks = useCanvasStore.getState().tasks
    useCanvasStore.setState({
      tasks: [{
        id: 'e2e-running-header-spinner',
        label: 'E2E running header spinner',
        status: 'running',
        progress: 50,
        nodeIds: [],
      }],
    })
    return previousTasks
  }, await canvasStoreSpec())
  try {
    await page.waitForSelector('.ai-panel-tasks-spinner', { state: 'visible' })
    await assertTasksHeaderCopy('running header')
    const runningTasksIndicator = await readHeaderTasksIndicator()
    if (!runningTasksIndicator.hasIndicator || !runningTasksIndicator.hasLabel || !runningTasksIndicator.hasSpinner) {
      throw new Error(`Running header should keep TASKS title and render the generation spinner: ${JSON.stringify(runningTasksIndicator)}`)
    }
    if (
      runningTasksIndicator.expectedLeft === null ||
      !runningTasksIndicator.label ||
      Math.abs(runningTasksIndicator.label.left - runningTasksIndicator.expectedLeft) > 1.5 ||
      Math.abs(runningTasksIndicator.label.left - idleTasksIndicator.label.left) > 1
    ) {
      throw new Error(`Running TASKS title should not shift when spinner appears: ${JSON.stringify({ idleTasksIndicator, runningTasksIndicator })}`)
    }
  } finally {
    await page.evaluate(async ({ moduleSpec, previousTasks }) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.setState({ tasks: previousTasks })
    }, { moduleSpec: await canvasStoreSpec(), previousTasks })
  }
  await page.waitForSelector('.ai-panel-tasks-spinner', { state: 'detached' })
  await assertTasksHeaderCopy('restored idle header')

  // ⑤ 默认模型切 gemini（D-R5b）：localStorage.clear 后新用户吃到新默认，不破既有段落
  {
    const chatState = await readChatState()
    if (chatState.selectedModel !== 'gemini-3-pro-image') {
      throw new Error(`Default selectedModel should be gemini-3-pro-image after localStorage.clear, got ${chatState.selectedModel}`)
    }
  }

  const logoResponse = await page.request.get(`${baseUrl}/mivo-logo.svg`)
  if (!logoResponse.ok()) throw new Error(`Mivo logo asset should be reachable, got ${logoResponse.status()}`)

  const logoRendered = await page.locator('.sidebar-mark .mivo-logo').evaluate((logo) => {
    const rect = logo.getBoundingClientRect()
    const style = window.getComputedStyle(logo)
    const maskImage = style.maskImage || style.webkitMaskImage

    return {
      width: rect.width,
      height: rect.height,
      backgroundColor: style.backgroundColor,
      maskImage,
    }
  })
  if (
    logoRendered.width <= 0 ||
    logoRendered.height <= 0 ||
    logoRendered.backgroundColor === 'rgba(0, 0, 0, 0)' ||
    !logoRendered.maskImage.includes('mivo-logo.svg')
  ) {
    throw new Error(`Expanded sidebar should keep a colorable Mivo logo: ${JSON.stringify(logoRendered)}`)
  }
  const openSidebarChrome = await page.evaluate(() => {
    const logo = document.querySelector('.sidebar-mark .mivo-logo')?.getBoundingClientRect()
    const button = document.querySelector('[aria-label="Collapse projects"]')?.getBoundingClientRect()

    return {
      logo: logo
        ? {
            left: logo.left,
            top: logo.top,
            width: logo.width,
            height: logo.height,
          }
        : undefined,
      button: button
        ? {
            left: button.left,
            top: button.top,
            width: button.width,
            height: button.height,
          }
        : undefined,
    }
  })
  if (
    !openSidebarChrome.logo ||
    !openSidebarChrome.button ||
    !nearlyEqual(openSidebarChrome.logo.left, sidebarContentLeft) ||
    !nearlyEqual(openSidebarChrome.logo.top, sidebarLogoTop) ||
    !nearlyEqual(openSidebarChrome.logo.width, 78) ||
    !nearlyEqual(openSidebarChrome.logo.height, 40) ||
    !nearlyEqual(openSidebarChrome.button.left, sidebarToggleLeft) ||
    !nearlyEqual(openSidebarChrome.button.top, sidebarContentTop) ||
    !nearlyEqual(openSidebarChrome.button.width, 44) ||
    !nearlyEqual(openSidebarChrome.button.height, 44)
  ) {
    throw new Error(`Open sidebar logo and toggle should match collapsed chrome geometry: ${JSON.stringify(openSidebarChrome)}`)
  }

  if (
    (await page.getByText('Mivo Studio').count()) !== 0 ||
    (await page.getByText('AI image workspace').count()) !== 0 ||
    (await page.getByText('Mivo Canvas').count()) !== 0
  ) {
    throw new Error('Top chrome should not show the old product lockup')
  }

  const faviconHref = await page.locator('link[rel="icon"]').getAttribute('href')
  if (faviconHref !== '/mivo-logo.svg') throw new Error(`Expected Mivo logo favicon, got ${faviconHref}`)

  const openTitle = await page.locator('.top-title-lockup').evaluate((lockup) => {
    const title = lockup.querySelector('strong')
    const meta = lockup.querySelector('span')
    const titleStyle = title ? window.getComputedStyle(title) : undefined
    const metaStyle = meta ? window.getComputedStyle(meta) : undefined
    const titleArea = lockup.closest('.top-title-area')?.getBoundingClientRect()
    const titleAreaStyle = lockup.closest('.top-title-area')
      ? window.getComputedStyle(lockup.closest('.top-title-area'))
      : undefined

    return {
      title: title?.textContent,
      meta: meta?.textContent,
      titleOverflow: titleStyle?.overflow,
      titleTextOverflow: titleStyle?.textOverflow,
      metaOverflow: metaStyle?.overflow,
      metaTextOverflow: metaStyle?.textOverflow,
      areaLeft: titleArea?.left,
      areaRadius: titleAreaStyle?.borderRadius,
    }
  })
  if (openTitle.title !== '角色参考图流程' || openTitle.meta !== '3 nodes · 1 tasks') {
    throw new Error(`Top bar should show only canvas title and meta: ${JSON.stringify(openTitle)}`)
  }
  if (
    openTitle.titleOverflow !== 'visible' ||
    openTitle.titleTextOverflow !== 'clip' ||
    openTitle.metaOverflow !== 'visible' ||
    openTitle.metaTextOverflow !== 'clip' ||
    !nearlyEqual(openTitle.areaLeft ?? -1, sidebarWorkspaceTitleLeft) ||
    openTitle.areaRadius !== '999px'
  ) {
    throw new Error(`Canvas title should stay untruncated at the open-sidebar anchor: ${JSON.stringify(openTitle)}`)
  }
  const floatingChrome = await page.evaluate(() => {
    const topBar = document.querySelector('.top-bar')
    const topBarRect = topBar?.getBoundingClientRect()
    const canvasRect = document.querySelector('.canvas-shell')?.getBoundingClientRect()
    const topBarStyle = topBar ? window.getComputedStyle(topBar) : undefined

    return {
      position: topBarStyle?.position,
      backgroundColor: topBarStyle?.backgroundColor,
      borderBottomWidth: topBarStyle?.borderBottomWidth,
      topBar: topBarRect
        ? {
            top: topBarRect.top,
            bottom: topBarRect.bottom,
          }
        : undefined,
      canvas: canvasRect
        ? {
            top: canvasRect.top,
          }
        : undefined,
    }
  })
  if (
    floatingChrome.position !== 'absolute' ||
    floatingChrome.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    floatingChrome.borderBottomWidth !== '0px' ||
    !floatingChrome.topBar ||
    !floatingChrome.canvas ||
    floatingChrome.canvas.top > 1 ||
    floatingChrome.topBar.bottom <= floatingChrome.canvas.top
  ) {
    throw new Error(`Canvas title chrome should float over the canvas: ${JSON.stringify(floatingChrome)}`)
  }

  if ((await page.locator('.top-navigation').count()) !== 0) {
    throw new Error('Open sidebar state should keep navigation controls in the sidebar header')
  }

  const sidebarMotion = await page.locator('.mivo-app').evaluate((app) => {
    const sidebar = document.querySelector('.project-sidebar')

    return {
      appTransition: window.getComputedStyle(app).transitionProperty,
      sidebarTransition: sidebar ? window.getComputedStyle(sidebar).transitionProperty : '',
    }
  })
  if (
    !sidebarMotion.appTransition.includes('grid-template-columns') ||
    !sidebarMotion.sidebarTransition.includes('width')
  ) {
    throw new Error(`Sidebar open/close should use smooth width transitions: ${JSON.stringify(sidebarMotion)}`)
  }

  if (
    (await page.getByRole('button', { name: 'Back' }).count()) !== 0 ||
    (await page.getByRole('button', { name: 'Forward' }).count()) !== 0
  ) {
    throw new Error('Back/forward controls should be removed from the workspace chrome')
  }

  const debugLogButton = page.getByRole('button', { name: 'Debug Log', exact: true })
  if ((await debugLogButton.count()) !== 1) {
    throw new Error('Project sidebar should expose one Debug Log button above Settings')
  }
  const debugLogPlacement = await page.evaluate(() => {
    const debugLog = document.querySelector('[aria-label="Debug Log"]')?.getBoundingClientRect()
    const settings = document.querySelector('[aria-label="Settings"]')?.getBoundingClientRect()

    return {
      debugBottom: debugLog?.bottom,
      settingsTop: settings?.top,
    }
  })
  if (
    typeof debugLogPlacement.debugBottom !== 'number' ||
    typeof debugLogPlacement.settingsTop !== 'number' ||
    debugLogPlacement.debugBottom > debugLogPlacement.settingsTop
  ) {
    throw new Error(`Debug Log should sit directly above Settings: ${JSON.stringify(debugLogPlacement)}`)
  }
  const initialDebugBadges = await debugLogButton.evaluate((button) => ({
    warnings: button.querySelectorAll('.debug-log-badge.warning').length,
    errors: button.querySelectorAll('.debug-log-badge.error').length,
  }))
  // errors 严格 0;warnings 容忍 hydration 类(S276 zombie generation cleanup)。
  // dev topology 用真实 canvasStore persist/merge,demo scenes 初始含 running/queued
  // task,hydrate 时 settleExpiredCanvasGenerations 会 warn("Hydration settled expired
  // canvas generations: ...")(见 src/store/canvasGenerationHydration.ts:69)。这是产品
  // 预期行为,不是测试 bug。prod topology 用 store bridge 绕过 persist,不触发,故 CI
  // 全绿而本地 dev 红。这里容忍 0 或 N 条 hydration 类 warning,其他 warning 仍失败。
  if (initialDebugBadges.errors !== 0) {
    throw new Error(`Debug Log button should show 0 error badges at init: ${JSON.stringify(initialDebugBadges)}`)
  }
  if (initialDebugBadges.warnings > 0) {
    const warningEntries = await page.evaluate(async () => {
      const resource = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => name.includes('/src/store/debugLogStore.ts'))
      if (!resource) return null
      const { useDebugLogStore } = await import(new URL(resource).pathname + new URL(resource).search)
      return useDebugLogStore
        .getState()
        .entries.filter((entry) => entry.level === 'warning')
        .map((entry) => ({ source: entry.source, message: entry.message }))
    })
    if (warningEntries === null) {
      throw new Error(
        `Debug Log shows ${initialDebugBadges.warnings} warning badge(s) but debugLogStore module was not reachable to verify they are hydration-class: ${JSON.stringify(initialDebugBadges)}`,
      )
    }
    const nonHydration = warningEntries.filter((entry) => !(entry.message || '').includes('Hydration settled'))
    if (nonHydration.length > 0) {
      throw new Error(
        `Debug Log init should only contain hydration-class warnings (S276 zombie cleanup), got non-hydration: ${JSON.stringify(nonHydration)}`,
      )
    }
  }
  await page.evaluate(() => {
    console.log('__MIVO_E2E_EXPECTED_LOG__ unity-style log')
    console.warn('__MIVO_E2E_EXPECTED_WARNING__ unity-style warning')
    console.error('__MIVO_E2E_EXPECTED_ERROR__ unity-style error')
  })
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="Debug Log"]')
    return (
      button?.querySelector('.debug-log-badge.warning')?.textContent?.trim() === '1' &&
      button?.querySelector('.debug-log-badge.error')?.textContent?.trim() === '1'
    )
  })
  const debugBadgeColors = await debugLogButton.evaluate((button) => {
    const warning = button.querySelector('.debug-log-badge.warning')
    const error = button.querySelector('.debug-log-badge.error')

    return {
      warningText: warning?.textContent?.trim(),
      warningColor: warning ? window.getComputedStyle(warning).backgroundColor : undefined,
      warningTextColor: warning ? window.getComputedStyle(warning).color : undefined,
      errorText: error?.textContent?.trim(),
      errorColor: error ? window.getComputedStyle(error).backgroundColor : undefined,
      errorTextColor: error ? window.getComputedStyle(error).color : undefined,
    }
  })
  if (
    debugBadgeColors.warningText !== '1' ||
    debugBadgeColors.errorText !== '1' ||
    !debugBadgeColors.warningColor?.includes('199') ||
    !debugBadgeColors.errorColor?.includes('191') ||
    !debugBadgeColors.warningTextColor?.includes('255, 255, 255') ||
    !debugBadgeColors.errorTextColor?.includes('255, 255, 255')
  ) {
    throw new Error(`Debug Log button should show yellow/red counts with white text: ${JSON.stringify(debugBadgeColors)}`)
  }
  await page.evaluate(() => {
    for (let index = 0; index < 11; index += 1) {
      console.error(`__MIVO_E2E_EXPECTED_ERROR__ badge-center-${index}`)
    }
  })
  await page.waitForFunction(() => document.querySelector('[aria-label="Debug Log"] .debug-log-badge.error')?.textContent?.trim() === '12')
  const debugBadgeAlignment = await debugLogButton.evaluate((button) => {
    const warning = button.querySelector('.debug-log-badge.warning')
    const error = button.querySelector('.debug-log-badge.error')
    const warningRect = warning?.getBoundingClientRect()
    const style = error ? window.getComputedStyle(error) : undefined
    const rect = error?.getBoundingClientRect()

    return {
      text: error?.textContent?.trim(),
      display: style?.display,
      alignItems: style?.alignItems,
      justifyContent: style?.justifyContent,
      height: rect?.height,
      lineHeight: style?.lineHeight,
      warningRight: warningRect?.right,
      warningCenterY: warningRect ? warningRect.top + warningRect.height / 2 : undefined,
      errorLeft: rect?.left,
      errorCenterY: rect ? rect.top + rect.height / 2 : undefined,
    }
  })
  if (
    debugBadgeAlignment.text !== '12' ||
    !['flex', 'inline-flex'].includes(debugBadgeAlignment.display || '') ||
    debugBadgeAlignment.alignItems !== 'center' ||
    debugBadgeAlignment.justifyContent !== 'center' ||
    debugBadgeAlignment.lineHeight !== `${debugBadgeAlignment.height}px` ||
    typeof debugBadgeAlignment.warningRight !== 'number' ||
    typeof debugBadgeAlignment.errorLeft !== 'number' ||
    debugBadgeAlignment.warningRight > debugBadgeAlignment.errorLeft ||
    Math.abs((debugBadgeAlignment.warningCenterY || 0) - (debugBadgeAlignment.errorCenterY || 0)) > 1
  ) {
    throw new Error(`Debug Log count badges should align horizontally and center text: ${JSON.stringify(debugBadgeAlignment)}`)
  }
  await debugLogButton.click()
  const debugLogPanel = page.getByRole('dialog', { name: 'Debug log console' })
  if ((await debugLogPanel.count()) !== 1) {
    throw new Error('Debug Log should open a modal console dialog')
  }
  const debugLogDialogGeometry = await debugLogPanel.evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect()

    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      viewportCenterX: window.innerWidth / 2,
      viewportCenterY: window.innerHeight / 2,
    }
  })
  if (
    Math.abs(debugLogDialogGeometry.centerX - debugLogDialogGeometry.viewportCenterX) > 3 ||
    Math.abs(debugLogDialogGeometry.centerY - debugLogDialogGeometry.viewportCenterY) > 3
  ) {
    throw new Error(`Debug Log dialog should be centered in the browser viewport: ${JSON.stringify(debugLogDialogGeometry)}`)
  }
  const debugLogDialogStyle = await debugLogPanel.evaluate((dialog) => {
    const closeButton = dialog.querySelector('[aria-label="Close debug log"]')
    const logEntry = dialog.querySelector('.debug-log-entry')

    return {
      panelRadius: Number.parseFloat(window.getComputedStyle(dialog).borderRadius),
      closeRadius: closeButton ? Number.parseFloat(window.getComputedStyle(closeButton).borderRadius) : 0,
      entryRadius: logEntry ? Number.parseFloat(window.getComputedStyle(logEntry).borderRadius) : 0,
      panelBackground: window.getComputedStyle(dialog).backgroundColor,
    }
  })
  if (
    debugLogDialogStyle.panelRadius < 12 ||
    debugLogDialogStyle.closeRadius < 8 ||
    debugLogDialogStyle.entryRadius < 8 ||
    !debugLogDialogStyle.panelBackground.includes('250')
  ) {
    throw new Error(`Debug Log dialog should match the rounded Mivo panel style: ${JSON.stringify(debugLogDialogStyle)}`)
  }
  for (const filter of ['All', 'Log', 'Warning', 'Error']) {
    if ((await debugLogPanel.getByRole('button', { name: new RegExp(`^${filter} \\d+`) }).count()) !== 1) {
      throw new Error(`Debug Log panel should expose a ${filter} level filter with a count`)
    }
  }
  if ((await debugLogPanel.getByRole('button', { name: 'Clear debug log' }).count()) !== 1) {
    throw new Error('Debug Log panel should expose a Clear action')
  }
  for (const message of ['App ready', 'Canvas loaded', 'Tool changed', 'Selection changed']) {
    if ((await debugLogPanel.getByText(message, { exact: false }).count()) < 1) {
      throw new Error(`Debug Log panel should include runtime log: ${message}`)
    }
  }
  for (const message of [
    '__MIVO_E2E_EXPECTED_LOG__ unity-style log',
    '__MIVO_E2E_EXPECTED_WARNING__ unity-style warning',
    '__MIVO_E2E_EXPECTED_ERROR__ unity-style error',
  ]) {
    await debugLogPanel.getByText(message, { exact: false }).waitFor()
  }
  const logListSelection = await debugLogPanel.locator('.debug-log-list').evaluate((list) => window.getComputedStyle(list).userSelect)
  if (logListSelection !== 'text') {
    throw new Error(`Debug Log modal should allow selecting log text for copy, user-select=${logListSelection}`)
  }
  await debugLogPanel.getByRole('button', { name: /^Warning \d+/ }).click()
  if ((await debugLogPanel.getByText('__MIVO_E2E_EXPECTED_WARNING__', { exact: false }).count()) !== 1) {
    throw new Error('Warning filter should keep warning entries visible')
  }
  if ((await debugLogPanel.getByText('__MIVO_E2E_EXPECTED_LOG__', { exact: false }).count()) !== 0) {
    throw new Error('Warning filter should hide log entries')
  }
  await debugLogPanel.getByRole('button', { name: /^Error \d+/ }).click()
  if ((await debugLogPanel.getByText('__MIVO_E2E_EXPECTED_ERROR__ unity-style error', { exact: false }).count()) !== 1) {
    throw new Error('Error filter should keep error entries visible')
  }
  if ((await debugLogPanel.locator('.debug-log-entry:not(.error) [aria-label^="Copy error log"]').count()) !== 0) {
    throw new Error('Only error entries should expose copy controls')
  }
  const expectedErrorEntry = debugLogPanel
    .locator('.debug-log-entry.error')
    .filter({ hasText: '__MIVO_E2E_EXPECTED_ERROR__ unity-style error' })
  if ((await expectedErrorEntry.getByRole('button', { name: 'Copy error log content' }).count()) !== 1) {
    throw new Error('Each error entry should expose one copy-log icon button')
  }
  await expectedErrorEntry.getByRole('button', { name: 'Copy error log content' }).click()
  const copiedErrorLog = await page.evaluate(() => navigator.clipboard.readText())
  if (
    !copiedErrorLog.includes('[ERROR]') ||
    !copiedErrorLog.includes('Console') ||
    !copiedErrorLog.includes('__MIVO_E2E_EXPECTED_ERROR__ unity-style error')
  ) {
    throw new Error(`Copying an error log should place the formatted error content on the clipboard: ${copiedErrorLog}`)
  }
  const copyToast = page.getByRole('status').filter({ hasText: 'Error log copied' })
  await copyToast.waitFor()
  const toastPlacement = await page.locator('.toast-viewport').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return {
      horizontalCenterDelta: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
      bottom: style.bottom,
      pointerEvents: style.pointerEvents,
    }
  })
  if (toastPlacement.horizontalCenterDelta > 2 || toastPlacement.pointerEvents !== 'none') {
    throw new Error(`Toast viewport should be bottom-centered and non-blocking: ${JSON.stringify(toastPlacement)}`)
  }
  await debugLogPanel.getByRole('button', { name: /^All \d+/ }).click()
  if ((await debugLogPanel.getByText('Copied error log content', { exact: false }).count()) !== 0) {
    throw new Error('Copying an error log successfully should not add a normal Debug Log entry')
  }
  await debugLogPanel.getByRole('button', { name: 'Clear debug log' }).click()
  if ((await debugLogPanel.getByText('__MIVO_E2E_EXPECTED_ERROR__', { exact: false }).count()) !== 0) {
    throw new Error('Clear should remove captured debug entries')
  }
  await debugLogPanel.getByRole('button', { name: 'Close debug log' }).click()
  if ((await debugLogPanel.count()) !== 0) {
    throw new Error('Debug Log modal should close from its close button')
  }

  await page.getByRole('button', { name: 'Settings' }).click()
  if ((await page.getByRole('menu', { name: 'Settings menu' }).count()) !== 1) {
    throw new Error('Settings should expand into an inline menu')
  }
  for (const item of ['Preferences', 'Appearance', 'Keyboard shortcuts', 'Theme', 'Help and feedback']) {
    if ((await page.getByRole('menuitem', { name: item }).count()) !== 1) {
      throw new Error(`Settings menu should include: ${item}`)
    }
  }
  await page.getByRole('menuitem', { name: 'Preferences' }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="Debug Log"] .debug-log-badge.warning')?.textContent?.trim() === '1')
  const settingsRowDisplay = await page.getByRole('button', { name: 'Settings' }).evaluate((row) => ({
    display: window.getComputedStyle(row).display,
    columns: window.getComputedStyle(row).gridTemplateColumns,
  }))
  if (settingsRowDisplay.display !== 'grid' || settingsRowDisplay.columns.split(' ').length < 3) {
    throw new Error(`Settings row should keep icon/text in a horizontal layout: ${JSON.stringify(settingsRowDisplay)}`)
  }
  const sidebarTypeScale = await page.evaluate(() => {
    const navRow = document.querySelector('.project-sidebar .nav-row')
    const canvasRow = document.querySelector('.project-sidebar .canvas-row')

    return {
      navRowFontSize: navRow ? window.getComputedStyle(navRow).fontSize : undefined,
      canvasRowFontSize: canvasRow ? window.getComputedStyle(canvasRow).fontSize : undefined,
    }
  })
  if (sidebarTypeScale.navRowFontSize !== '13px' || sidebarTypeScale.canvasRowFontSize !== '13px') {
    throw new Error(`Sidebar rows should use the compact tool typography scale: ${JSON.stringify(sidebarTypeScale)}`)
  }
  await page.getByRole('button', { name: 'Settings' }).click()

  const canvasMenuButton = page.getByRole('button', { name: 'Canvas options' })
  if ((await canvasMenuButton.count()) !== 1) throw new Error('Top bar should expose one canvas options menu')
  await canvasMenuButton.click()
  for (const action of [
    'Rename',
    'Duplicate canvas',
    'Move to project',
    'Delete canvas',
    'Copy JSON',
    'Export JSON',
    'Import JSON',
  ]) {
    if ((await page.getByRole('menuitem', { name: action }).count()) !== 1) {
      throw new Error(`Canvas options menu should include: ${action}`)
    }
  }
  const canvasMenuLayer = await page.locator('.canvas-title-menu').evaluate((menu) => {
    const rect = menu.getBoundingClientRect()
    const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)

    return {
      menuTop: rect.top,
      topElementClass: topElement?.className?.toString(),
      isMenuOnTop: Boolean(topElement?.closest('.canvas-title-menu')),
    }
  })
  if (!canvasMenuLayer.isMenuOnTop) {
    throw new Error(`Canvas options menu should render above canvas overlays: ${JSON.stringify(canvasMenuLayer)}`)
  }
  await canvasMenuButton.click()

  await page.getByRole('button', { name: 'Collapse projects' }).click()
  await page.waitForSelector('[aria-label="Open projects"]')
  await wait(60)
  const closingChrome = await page.evaluate(() => {
    const sidebar = document.querySelector('.project-sidebar')?.getBoundingClientRect()
    const floatingLogo = document.querySelector('.floating-sidebar-mark .mivo-logo')?.getBoundingClientRect()
    const openButton = document.querySelector('[aria-label="Open projects"]')?.getBoundingClientRect()

    return {
      sidebarWidth: sidebar?.width,
      floatingLogo: floatingLogo
        ? {
            left: floatingLogo.left,
            top: floatingLogo.top,
            width: floatingLogo.width,
            height: floatingLogo.height,
          }
        : undefined,
      openButton: openButton
        ? {
            left: openButton.left,
            top: openButton.top,
            width: openButton.width,
            height: openButton.height,
          }
        : undefined,
    }
  })
  if (
    !closingChrome.floatingLogo ||
    !closingChrome.openButton ||
    !nearlyEqual(closingChrome.floatingLogo.left, openSidebarChrome.logo.left) ||
    !nearlyEqual(closingChrome.floatingLogo.top, openSidebarChrome.logo.top) ||
    !nearlyEqual(closingChrome.floatingLogo.width, openSidebarChrome.logo.width) ||
    !nearlyEqual(closingChrome.floatingLogo.height, openSidebarChrome.logo.height) ||
    !nearlyEqual(closingChrome.openButton.left, openSidebarChrome.button.left) ||
    !nearlyEqual(closingChrome.openButton.top, openSidebarChrome.button.top) ||
    !nearlyEqual(closingChrome.openButton.width, openSidebarChrome.button.width) ||
    !nearlyEqual(closingChrome.openButton.height, openSidebarChrome.button.height)
  ) {
    throw new Error(`Logo and collapsed menu button should stay fixed while the sidebar closes: ${JSON.stringify(closingChrome)}`)
  }
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar')
    const workspace = document.querySelector('.workspace')

    return (
      (!sidebar || (sidebar.classList.contains('closed') && sidebar.getBoundingClientRect().width <= 2)) &&
      workspace &&
      Math.abs(workspace.getBoundingClientRect().width - window.innerWidth) <= 2
    )
  })

  const collapsedLayout = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace')?.getBoundingClientRect()
    const sidebar = document.querySelector('.project-sidebar')?.getBoundingClientRect()
    const sidebarElement = document.querySelector('.project-sidebar')
    const title = document.querySelector('.top-title-lockup')
    const titleArea = document.querySelector('.top-title-area')?.getBoundingClientRect()
    const titleAreaStyle = document.querySelector('.top-title-area')
      ? window.getComputedStyle(document.querySelector('.top-title-area'))
      : undefined
    const floatingLogoWrap = document.querySelector('.floating-sidebar-mark')
    const floatingLogo = floatingLogoWrap?.querySelector('.mivo-logo')
    const floatingLogoRect = floatingLogo?.getBoundingClientRect()
    const openButton = document.querySelector('[aria-label="Open projects"]')
    const openButtonRect = openButton?.getBoundingClientRect()
    const openButtonStyle = openButton ? window.getComputedStyle(openButton) : undefined
    const logoWrapStyle = floatingLogoWrap ? window.getComputedStyle(floatingLogoWrap) : undefined

    return {
      projectWidth: window.getComputedStyle(document.querySelector('.mivo-app')).getPropertyValue('--project-w').trim(),
      viewportWidth: window.innerWidth,
      sidebarCount: document.querySelectorAll('.project-sidebar').length,
      sidebarWidth: sidebar?.width,
      sidebarOpacity: sidebarElement ? window.getComputedStyle(sidebarElement).opacity : undefined,
      workspaceLeft: workspace?.left,
      workspaceWidth: workspace?.width,
      hasTopNavigation: Boolean(document.querySelector('.top-navigation')),
      hasFloatingLogo: Boolean(floatingLogo),
      floatingLogo: floatingLogoRect
        ? {
            left: floatingLogoRect.left,
            top: floatingLogoRect.top,
            width: floatingLogoRect.width,
            height: floatingLogoRect.height,
          }
        : undefined,
      floatingLogoBackground: logoWrapStyle?.backgroundColor,
      hasCollapsedNewCanvas: Boolean(document.querySelector('.top-navigation [aria-label="New canvas"]')),
      openButton: openButtonRect
        ? {
            left: openButtonRect.left,
            top: openButtonRect.top,
            width: openButtonRect.width,
            height: openButtonRect.height,
            radius: openButtonStyle?.borderRadius,
          }
        : undefined,
      title: title?.querySelector('strong')?.textContent,
      titleAreaLeft: titleArea?.left,
      titleAreaRadius: titleAreaStyle?.borderRadius,
      meta: title?.querySelector('span')?.textContent,
    }
  })
  if (
    collapsedLayout.projectWidth !== '0px' ||
    !nearlyEqual(collapsedLayout.sidebarWidth ?? -1, 0, 2) ||
    Number(collapsedLayout.sidebarOpacity) > 0.01 ||
    !nearlyEqual(collapsedLayout.workspaceLeft ?? -1, 0) ||
    !nearlyEqual(collapsedLayout.workspaceWidth ?? -1, collapsedLayout.viewportWidth)
  ) {
    throw new Error(`Collapsed sidebar should disappear from layout: ${JSON.stringify(collapsedLayout)}`)
  }

  if (
    !collapsedLayout.hasTopNavigation ||
    !collapsedLayout.hasFloatingLogo ||
    !collapsedLayout.floatingLogo ||
    !nearlyEqual(collapsedLayout.floatingLogo.left, openSidebarChrome.logo.left) ||
    !nearlyEqual(collapsedLayout.floatingLogo.top, openSidebarChrome.logo.top) ||
    !nearlyEqual(collapsedLayout.floatingLogo.width, openSidebarChrome.logo.width) ||
    !nearlyEqual(collapsedLayout.floatingLogo.height, openSidebarChrome.logo.height) ||
    collapsedLayout.floatingLogoBackground !== 'rgba(0, 0, 0, 0)' ||
    collapsedLayout.hasCollapsedNewCanvas ||
    !collapsedLayout.openButton ||
    !nearlyEqual(collapsedLayout.openButton.left, openSidebarChrome.button.left) ||
    !nearlyEqual(collapsedLayout.openButton.top, openSidebarChrome.button.top) ||
    !nearlyEqual(collapsedLayout.openButton.width, collapsedLayout.openButton.height) ||
    collapsedLayout.openButton.radius !== '999px' ||
    !nearlyEqual(collapsedLayout.titleAreaLeft ?? -1, collapsedTitleLeft) ||
    !(collapsedLayout.titleAreaLeft < openTitle.areaLeft) ||
    collapsedLayout.titleAreaRadius !== '999px' ||
    collapsedLayout.title !== '角色参考图流程' ||
    collapsedLayout.meta !== '3 nodes · 1 tasks'
  ) {
    throw new Error(`Collapsed top bar should show floating logo, a circular menu button, title, and meta: ${JSON.stringify(collapsedLayout)}`)
  }

  await page.getByRole('button', { name: 'Open projects' }).hover()
  await page.mouse.move(1510, 890)
  await wait(40)
  await page.getByRole('button', { name: 'Open projects' }).hover()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar.drawer')
    const workspace = document.querySelector('.workspace')
    const app = document.querySelector('.mivo-app')

    return (
      sidebar &&
      app?.classList.contains('project-collapsed') &&
      sidebar.getBoundingClientRect().width > 200 &&
      Math.abs(sidebar.getBoundingClientRect().left - 14) <= 2 &&
      workspace &&
      Math.abs(workspace.getBoundingClientRect().width - window.innerWidth) <= 2
    )
  })
  const peekLayout = await page.evaluate(() => {
    const app = document.querySelector('.mivo-app')
    const drawer = document.querySelector('.project-sidebar.drawer')?.getBoundingClientRect()
    const drawerHeader = document.querySelector('.project-sidebar.drawer .sidebar-header')
    const drawerHeaderStyle = drawerHeader ? window.getComputedStyle(drawerHeader) : undefined
    const openButton = document.querySelector('[aria-label="Open projects"]')?.getBoundingClientRect()
    const titleArea = document.querySelector('.top-title-area')?.getBoundingClientRect()
    const titleProbe = titleArea
      ? document.elementFromPoint(titleArea.left + 12, titleArea.top + titleArea.height / 2)
      : undefined
    const workspace = document.querySelector('.workspace')?.getBoundingClientRect()

    return {
      projectWidth: app ? window.getComputedStyle(app).getPropertyValue('--project-w').trim() : undefined,
      appCollapsed: app?.classList.contains('project-collapsed'),
      drawerWidth: drawer?.width,
      drawerLeft: drawer?.left,
      drawerHeaderVisibility: drawerHeaderStyle?.visibility,
      isTitleCoveredByDrawer: Boolean(titleProbe?.closest('.project-sidebar.drawer')),
      openButtonLeft: openButton?.left,
      openButtonTop: openButton?.top,
      workspaceLeft: workspace?.left,
      workspaceWidth: workspace?.width,
      viewportWidth: window.innerWidth,
    }
  })
  if (
    peekLayout.projectWidth !== '0px' ||
    !peekLayout.appCollapsed ||
    !nearlyEqual(peekLayout.drawerLeft ?? -1, sidebarGap) ||
    !nearlyEqual(peekLayout.drawerWidth ?? -1, sidebarWidth, 2) ||
    peekLayout.drawerHeaderVisibility !== 'hidden' ||
    !peekLayout.isTitleCoveredByDrawer ||
    !nearlyEqual(peekLayout.openButtonLeft ?? -1, collapsedLayout.openButton.left) ||
    !nearlyEqual(peekLayout.openButtonTop ?? -1, collapsedLayout.openButton.top) ||
    !nearlyEqual(peekLayout.workspaceLeft ?? -1, 0) ||
    !nearlyEqual(peekLayout.workspaceWidth ?? -1, peekLayout.viewportWidth)
  ) {
    throw new Error(`Hovering the collapsed control should show a floating drawer without moving canvas: ${JSON.stringify(peekLayout)}`)
  }
  const peekChromeBeforeSwitch = await readFloatingChrome()
  if (
    peekChromeBeforeSwitch.chromeCount !== 1 ||
    peekChromeBeforeSwitch.navigationCount !== 1 ||
    peekChromeBeforeSwitch.chromePosition !== 'fixed' ||
    !peekChromeBeforeSwitch.navigationExists ||
    !peekChromeBeforeSwitch.logo ||
    !peekChromeBeforeSwitch.openButton
  ) {
    throw new Error(`Collapsed sidebar chrome should be a single fixed app-level control: ${JSON.stringify(peekChromeBeforeSwitch)}`)
  }

  for (const target of [
    { button: 'Assets', heading: 'Assets' },
    { button: 'Plugins', heading: 'Plugins' },
    { button: 'Skills', heading: 'Skills' },
  ]) {
    await page.getByRole('button', { name: target.button, exact: true }).click()
    await page.getByRole('heading', { name: target.heading }).waitFor()
    const switchedChrome = await readFloatingChrome()
    const drawerStillOpen = await page.locator('.project-sidebar.drawer').count()

    if (
      drawerStillOpen !== 1 ||
      switchedChrome.chromeCount !== 1 ||
      switchedChrome.navigationCount !== 1 ||
      !switchedChrome.logo ||
      !switchedChrome.openButton ||
      !nearlyEqual(switchedChrome.logo.left, peekChromeBeforeSwitch.logo.left) ||
      !nearlyEqual(switchedChrome.logo.top, peekChromeBeforeSwitch.logo.top) ||
      !nearlyEqual(switchedChrome.logo.width, peekChromeBeforeSwitch.logo.width) ||
      !nearlyEqual(switchedChrome.logo.height, peekChromeBeforeSwitch.logo.height) ||
      !nearlyEqual(switchedChrome.openButton.left, peekChromeBeforeSwitch.openButton.left) ||
      !nearlyEqual(switchedChrome.openButton.top, peekChromeBeforeSwitch.openButton.top) ||
      !nearlyEqual(switchedChrome.openButton.width, peekChromeBeforeSwitch.openButton.width) ||
      !nearlyEqual(switchedChrome.openButton.height, peekChromeBeforeSwitch.openButton.height)
    ) {
      throw new Error(
        `Floating sidebar chrome should not jitter when switching to ${target.heading} from a peeked drawer: ${JSON.stringify(switchedChrome)}`,
      )
    }
  }

  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
  const peekChromeAfterCanvasSwitch = await readFloatingChrome()
  if (
    !peekChromeAfterCanvasSwitch.logo ||
    !peekChromeAfterCanvasSwitch.openButton ||
    !nearlyEqual(peekChromeAfterCanvasSwitch.logo.left, peekChromeBeforeSwitch.logo.left) ||
    !nearlyEqual(peekChromeAfterCanvasSwitch.logo.top, peekChromeBeforeSwitch.logo.top) ||
    !nearlyEqual(peekChromeAfterCanvasSwitch.openButton.left, peekChromeBeforeSwitch.openButton.left) ||
    !nearlyEqual(peekChromeAfterCanvasSwitch.openButton.top, peekChromeBeforeSwitch.openButton.top)
  ) {
    throw new Error(
      `Floating sidebar chrome should stay fixed when returning to Canvas from a peeked drawer: ${JSON.stringify(peekChromeAfterCanvasSwitch)}`,
    )
  }

  const openButtonBox = await page.getByRole('button', { name: 'Open projects' }).boundingBox()
  if (!openButtonBox) throw new Error('Missing collapsed sidebar toggle for hover loop check')
  await wait(230)
  await page.mouse.move(36, 108)
  await wait(30)
  await page.mouse.move(openButtonBox.x + openButtonBox.width / 2, openButtonBox.y + openButtonBox.height / 2)
  await wait(30)
  const drawerLoopState = await page.evaluate(() => {
    const drawer = document.querySelector('.project-sidebar.drawer')
    const drawerRect = drawer?.getBoundingClientRect()

    return {
      drawerCount: document.querySelectorAll('.project-sidebar.drawer').length,
      isClosing: drawer?.classList.contains('closing'),
      drawerLeft: drawerRect?.left,
      drawerWidth: drawerRect?.width,
    }
  })
  if (
    drawerLoopState.drawerCount !== 1 ||
    drawerLoopState.isClosing ||
    !nearlyEqual(drawerLoopState.drawerLeft ?? -1, sidebarGap) ||
    !nearlyEqual(drawerLoopState.drawerWidth ?? -1, sidebarWidth, 2)
  ) {
    throw new Error(
      `Moving between the peek trigger and drawer should not restart the drawer animation: ${JSON.stringify(drawerLoopState)}`,
    )
  }
  await wait(160)
  const drawerLoopSettled = await page.evaluate(() => {
    const drawer = document.querySelector('.project-sidebar.drawer')
    const drawerRect = drawer?.getBoundingClientRect()

    return {
      drawerCount: document.querySelectorAll('.project-sidebar.drawer').length,
      isClosing: drawer?.classList.contains('closing'),
      drawerLeft: drawerRect?.left,
    }
  })
  if (drawerLoopSettled.drawerCount !== 1 || drawerLoopSettled.isClosing || !nearlyEqual(drawerLoopSettled.drawerLeft ?? -1, sidebarGap)) {
    throw new Error(
      `Peeked drawer should remain stable after returning to the trigger: ${JSON.stringify(drawerLoopSettled)}`,
    )
  }
  await page.mouse.move(1510, 890)
  await page.waitForFunction(() => !document.querySelector('.project-sidebar.drawer'))
  await page.getByRole('button', { name: 'Open projects' }).hover()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar.drawer')

    return sidebar && sidebar.getBoundingClientRect().width > 200 && Math.abs(sidebar.getBoundingClientRect().left - 14) <= 2
  })
  await page.getByRole('button', { name: 'Open projects' }).click()
  await page.waitForSelector('.mivo-app.project-pinning')
  const pinningMotion = await page.locator('.mivo-app.project-pinning').evaluate((app) => {
    const sidebar = document.querySelector('.project-sidebar')
    const appStyle = window.getComputedStyle(app)
    const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : undefined

    return {
      appTransitionProperty: appStyle.transitionProperty,
      appTransitionDuration: appStyle.transitionDuration,
      sidebarPosition: sidebarStyle?.position,
      sidebarTransitionDuration: sidebarStyle?.transitionDuration,
      sidebarAnimationName: sidebarStyle?.animationName,
      sidebarIsDrawer: sidebar?.classList.contains('drawer'),
      sidebarIsClosed: sidebar?.classList.contains('closed'),
      sidebarLeft: sidebar?.getBoundingClientRect().left,
      sidebarWidth: sidebar?.getBoundingClientRect().width,
    }
  })
  if (
    !pinningMotion.appTransitionProperty.includes('grid-template-columns') ||
    pinningMotion.appTransitionDuration === '0s' ||
    pinningMotion.sidebarPosition !== 'fixed' ||
    pinningMotion.sidebarTransitionDuration !== '0s' ||
    pinningMotion.sidebarAnimationName !== 'none' ||
    pinningMotion.sidebarIsDrawer ||
    pinningMotion.sidebarIsClosed ||
    !nearlyEqual(pinningMotion.sidebarLeft ?? -1, sidebarGap) ||
    !nearlyEqual(pinningMotion.sidebarWidth ?? -1, sidebarWidth, 2)
  ) {
    throw new Error(
      `Pinning an already-peeked drawer should keep canvas layout motion but not replay the drawer slide: ${JSON.stringify(pinningMotion)}`,
    )
  }
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar')
    const workspace = document.querySelector('.workspace')

    return (
      sidebar &&
      !sidebar.classList.contains('drawer') &&
      !sidebar.classList.contains('closed') &&
      sidebar.getBoundingClientRect().width > 200 &&
      workspace &&
      workspace.getBoundingClientRect().left > 200
    )
  })
}
