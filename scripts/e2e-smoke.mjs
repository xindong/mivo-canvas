import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import {
  assertLibraryLayoutStable,
  createPageReaders,
  nearlyEqual,
  rectsOverlap,
  wait,
  waitForServer,
} from './e2e-helpers.mjs'

const port = Number(process.env.MIVO_E2E_PORT ?? 5174)
const baseUrl = `http://127.0.0.1:${port}`
const localAssetFixtureDir = path.resolve('test-artifacts/local-assets')
const eagleMockDir = path.resolve('test-artifacts/eagle-mock')
const eagleMockItemId = 'E2E-EAGLE-ASSET'
const eagleMockItemDir = path.join(eagleMockDir, `${eagleMockItemId}.info`)
const localAssetFixtureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72" viewBox="0 0 96 72">
  <rect width="96" height="72" rx="10" fill="#fffaf0"/>
  <circle cx="34" cy="36" r="18" fill="#6957e8"/>
  <path d="M48 18l22 36H26z" fill="#ff8a00" fill-opacity=".82"/>
</svg>`
const eagleMockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90">
  <rect width="120" height="90" rx="12" fill="#f4efe6"/>
  <rect x="18" y="18" width="84" height="54" rx="8" fill="#6957e8"/>
  <circle cx="60" cy="45" r="18" fill="#ff8a00"/>
</svg>`

mkdirSync(localAssetFixtureDir, { recursive: true })
mkdirSync(eagleMockItemDir, { recursive: true })
writeFileSync(path.join(localAssetFixtureDir, 'mivo-local-fixture.svg'), localAssetFixtureSvg)
writeFileSync(path.join(eagleMockItemDir, 'Mock Eagle Concept.svg'), eagleMockSvg)
writeFileSync(path.join(eagleMockItemDir, 'Mock Eagle Concept_thumbnail.svg'), eagleMockSvg)

const eagleMockItem = {
  id: eagleMockItemId,
  name: 'Mock Eagle Concept',
  size: Buffer.byteLength(eagleMockSvg),
  btime: Date.now(),
  mtime: Date.now(),
  ext: 'svg',
  tags: ['mock', 'eagle'],
  folders: ['MOCK-FOLDER'],
  isDeleted: false,
  url: 'https://example.com/mock-eagle-concept',
  annotation: 'Mock Eagle metadata note',
  modificationTime: Date.now(),
  height: 90,
  width: 120,
}
const eagleMockServer = createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (requestUrl.pathname === '/api/application/info') {
    response.end(JSON.stringify({ status: 'success', data: { version: 'E2E', platform: 'darwin' } }))
    return
  }

  if (requestUrl.pathname === '/api/library/info') {
    response.end(
      JSON.stringify({
        status: 'success',
        data: {
          folders: [{ id: 'MOCK-FOLDER', name: 'Mock Eagle Folder', children: [] }],
          libPath: eagleMockDir,
        },
      }),
    )
    return
  }

  if (requestUrl.pathname === '/api/folder/list') {
    response.end(
      JSON.stringify({
        status: 'success',
        data: [{ id: 'MOCK-FOLDER', name: 'Mock Eagle Folder', children: [] }],
      }),
    )
    return
  }

  if (requestUrl.pathname === '/api/item/list') {
    const folderId = requestUrl.searchParams.get('folderId')
    const keyword = requestUrl.searchParams.get('keyword')?.toLowerCase() || ''
    const matchesFolder = !folderId || folderId === 'MOCK-FOLDER'
    const matchesKeyword = !keyword || eagleMockItem.name.toLowerCase().includes(keyword)
    response.end(JSON.stringify({ status: 'success', data: matchesFolder && matchesKeyword ? [eagleMockItem] : [] }))
    return
  }

  if (requestUrl.pathname === '/api/item/info') {
    response.end(JSON.stringify({ status: 'success', data: eagleMockItem }))
    return
  }

  if (requestUrl.pathname === '/api/item/thumbnail') {
    response.end(
      JSON.stringify({
        status: 'success',
        data: path.join(eagleMockItemDir, 'Mock Eagle Concept_thumbnail.svg'),
      }),
    )
    return
  }

  response.statusCode = 404
  response.end(JSON.stringify({ status: 'error', message: 'not found' }))
})
await new Promise((resolve) => eagleMockServer.listen(0, '127.0.0.1', resolve))
const eagleMockAddress = eagleMockServer.address()
const eagleMockPort = typeof eagleMockAddress === 'object' && eagleMockAddress ? eagleMockAddress.port : 41895

const server = spawn(
  'npm',
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIVO_ASSET_DIR: localAssetFixtureDir,
      MIVO_EAGLE_API_URL: `http://127.0.0.1:${eagleMockPort}`,
    },
  },
)

try {
  await mkdir('test-artifacts', { recursive: true })
  const [nodeRegistrySource, actionModelSource] = await Promise.all([
    readFile('src/canvas/nodeTypes/canvasNodeRegistry.ts', 'utf8'),
    readFile('src/canvas/actions/canvasActionModel.ts', 'utf8'),
  ])
  for (const nodeType of [
    'image',
    'task-placeholder',
    'text',
    'frame',
    'ai-slot',
    'annotation',
    'markup',
    'markdown',
    'pdf',
    'video',
  ]) {
    if (!nodeRegistrySource.includes(`${nodeType}:`) && !nodeRegistrySource.includes(`'${nodeType}':`)) {
      throw new Error(`Node registry should declare ${nodeType}`)
    }
  }
  for (const extensionMap of ['contextMenuExtensionsByNodeType', 'quickToolbarExtensionsByNodeType']) {
    if (!actionModelSource.includes(extensionMap)) {
      throw new Error(`Action model should compose node actions through ${extensionMap}`)
    }
  }
  await waitForServer(baseUrl)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 1 })
  const errors = []
  const { readFloatingChrome, readLibraryLayout, readLibrarySurfaceColors } = createPageReaders(page)

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.addInitScript(() => window.localStorage.clear())
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')

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
    !nearlyEqual(openSidebarChrome.logo.left, 14) ||
    !nearlyEqual(openSidebarChrome.logo.top, 16) ||
    !nearlyEqual(openSidebarChrome.logo.width, 78) ||
    !nearlyEqual(openSidebarChrome.logo.height, 40) ||
    !nearlyEqual(openSidebarChrome.button.left, 100) ||
    !nearlyEqual(openSidebarChrome.button.top, 14) ||
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
    !nearlyEqual(openTitle.areaLeft ?? -1, 254) ||
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

  await page.getByRole('button', { name: 'Settings' }).click()
  if ((await page.getByRole('menu', { name: 'Settings menu' }).count()) !== 1) {
    throw new Error('Settings should expand into an inline menu')
  }
  for (const item of ['Preferences', 'Appearance', 'Keyboard shortcuts', 'Theme', 'Help and feedback']) {
    if ((await page.getByRole('menuitem', { name: item }).count()) !== 1) {
      throw new Error(`Settings menu should include: ${item}`)
    }
  }
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
    !nearlyEqual(collapsedLayout.titleAreaLeft ?? -1, 154) ||
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
      Math.abs(sidebar.getBoundingClientRect().left) <= 2 &&
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
    !nearlyEqual(peekLayout.drawerLeft ?? -1, 0) ||
    !nearlyEqual(peekLayout.drawerWidth ?? -1, 240, 2) ||
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
    !nearlyEqual(drawerLoopState.drawerLeft ?? -1, 0) ||
    !nearlyEqual(drawerLoopState.drawerWidth ?? -1, 240, 2)
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
  if (drawerLoopSettled.drawerCount !== 1 || drawerLoopSettled.isClosing || !nearlyEqual(drawerLoopSettled.drawerLeft ?? -1, 0)) {
    throw new Error(
      `Peeked drawer should remain stable after returning to the trigger: ${JSON.stringify(drawerLoopSettled)}`,
    )
  }
  await page.mouse.move(1510, 890)
  await page.waitForFunction(() => !document.querySelector('.project-sidebar.drawer'))
  await page.getByRole('button', { name: 'Open projects' }).hover()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar.drawer')

    return sidebar && sidebar.getBoundingClientRect().width > 200 && Math.abs(sidebar.getBoundingClientRect().left) <= 2
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
    !nearlyEqual(pinningMotion.sidebarLeft ?? -1, 0) ||
    !nearlyEqual(pinningMotion.sidebarWidth ?? -1, 240, 2)
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

  const initialCount = await page.locator('.dom-node').count()
  const initialSources = await page
    .locator('.dom-node-media img')
    .evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))

  if (initialCount !== 3) throw new Error(`Expected 3 initial nodes, got ${initialCount}`)
  if (!initialSources.every((src) => src?.startsWith('/demo-assets/courage-'))) {
    throw new Error(`Initial sources are not real demo assets: ${initialSources.join(', ')}`)
  }

  await page.getByRole('searchbox').fill('courage')
  await page.getByRole('searchbox').fill('')
  for (const navItem of ['Canvas', 'Assets', 'Plugins', 'Skills']) {
    if ((await page.getByRole('button', { name: navItem, exact: true }).count()) !== 1) {
      throw new Error(`Sidebar should expose the ${navItem} workspace tab`)
    }
  }
  const newCanvasButton = page.getByRole('button', { name: 'New canvas', exact: true })
  if ((await newCanvasButton.count()) !== 1) {
    throw new Error('Canvas tab should expose one hidden new-canvas action')
  }
  const newCanvasOpacityBeforeHover = await newCanvasButton.evaluate((button) => window.getComputedStyle(button).opacity)
  if (Number(newCanvasOpacityBeforeHover) > 0.01) {
    throw new Error(`Canvas plus should stay hidden until hover, opacity=${newCanvasOpacityBeforeHover}`)
  }
  await page.getByRole('button', { name: 'Canvas', exact: true }).hover()
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="New canvas"]')
    return button ? Number(window.getComputedStyle(button).opacity) > 0.9 : false
  })
  await newCanvasButton.click()
  await page.waitForFunction(
    () =>
      document.querySelector('.top-title-lockup strong')?.textContent === 'Untitled Canvas' &&
      document.querySelector('.top-title-lockup span')?.textContent === '0 nodes · 0 tasks' &&
      document.querySelectorAll('.dom-node').length === 0,
  )
  if ((await page.getByRole('button', { name: 'Untitled Canvas' }).count()) !== 1) {
    throw new Error('Creating a canvas should add a dynamic standalone canvas row')
  }

  const embeddedArchiveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="none"/>
    <circle cx="32" cy="32" r="24" fill="#6957e8"/>
    <path d="M21 34l7 7 16-20" fill="none" stroke="#fffaf0" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
  const archive = {
    kind: 'mivo-canvas-archive',
    version: 2,
    snapshot: {
      version: 1,
      sceneId: 'canvas-e2e-archive',
      nodes: [
        {
          id: 'archive-text',
          type: 'text',
          title: 'Imported archive note',
          x: 80,
          y: 80,
          width: 240,
          height: 96,
          text: 'Archive text\nSecond line',
          fontSize: 24,
          textColor: '#6957e8',
          fontWeight: 700,
          textAlign: 'center',
          status: 'ready',
        },
        {
          id: 'archive-image',
          type: 'image',
          title: 'Embedded archive asset',
          x: 360,
          y: 96,
          width: 64,
          height: 64,
          assetUrl: 'mivo-asset:e2e-embedded',
          imageHasTransparency: true,
          status: 'ready',
        },
      ],
      tasks: [],
      selectedNodeId: 'archive-text',
      selectedNodeIds: ['archive-text'],
    },
    assets: [
      {
        assetUrl: 'mivo-asset:e2e-embedded',
        name: 'embedded-archive.svg',
        type: 'image/svg+xml',
        dataUrl: `data:image/svg+xml;base64,${Buffer.from(embeddedArchiveSvg).toString('base64')}`,
      },
    ],
  }
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
    name: 'mivo-archive.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.top-title-lockup strong')?.textContent === 'canvas-e2e-archive' &&
      document.querySelectorAll('.dom-node').length === 2 &&
      document.querySelector('.dom-node.text-node .dom-text-node')?.textContent?.includes('Archive text'),
  )
  const importedArchiveAsset = await page.locator('[data-node-id="archive-image"] .dom-node-media img').evaluate((image) => ({
    src: image.getAttribute('src') || '',
    naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
    naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
  }))
  if (
    !importedArchiveAsset.src.startsWith('blob:') ||
    importedArchiveAsset.naturalWidth !== 64 ||
    importedArchiveAsset.naturalHeight !== 64
  ) {
    throw new Error(`Importing a Mivo archive should restore embedded local assets: ${JSON.stringify(importedArchiveAsset)}`)
  }

  await page.evaluate(async () => {
    const shell = document.querySelector('.canvas-shell')
    if (!shell) throw new Error('Missing canvas shell for multi-format import test')
    const rect = shell.getBoundingClientRect()
    const videoFile = await new Promise((resolve) => {
      const canvas = document.createElement('canvas')
      canvas.width = 240
      canvas.height = 320
      const context = canvas.getContext('2d')
      if (!context || !('captureStream' in canvas) || typeof MediaRecorder === 'undefined') {
        resolve(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50])], 'mivo-motion.mp4', { type: 'video/mp4' }))
        return
      }

      context.fillStyle = '#26231f'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#fffaf0'
      context.beginPath()
      context.moveTo(132, 72)
      context.lineTo(132, 108)
      context.lineTo(176, 90)
      context.closePath()
      context.fill()

      const stream = canvas.captureStream(5)
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      const chunks = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        resolve(new File(chunks, 'mivo-motion.webm', { type: 'video/webm' }))
      }
      recorder.start()
      window.setTimeout(() => recorder.stop(), 240)
    })
    const transfer = new DataTransfer()
    transfer.items.add(
      new File(
        [
          '# Mivo format brief\n\n',
          'Markdown should render as a complete document node, not a clipped summary card.\n\n',
          '- [x] Keep original files\n',
          '- [ ] Add richer document tools\n',
          '- Preview **formatted** documents on canvas\n\n',
          '| Feature | State |\n',
          '| --- | --- |\n',
          '| Tables | Ready |\n',
          '| Task lists | Ready |\n\n',
          '> Markdown should keep blockquote styling.\n\n',
          '```ts\n',
          'const fullDocumentPreview = true\n',
          '```\n\n',
          '~~Old summary card~~\n',
        ],
        'mivo-format-brief.md',
        { type: 'text/markdown' },
      ),
    )
    transfer.items.add(new File(['%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'], 'mivo-reference.pdf', { type: 'application/pdf' }))
    transfer.items.add(videoFile)

    shell.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.dom-node.markdown-node[data-node-type="markdown"]') &&
      document.querySelector('.dom-node.pdf-node[data-node-type="pdf"]') &&
      document.querySelector('.dom-node.video-node[data-node-type="video"]') &&
      document.querySelector('.dom-node.video-node video')?.getAttribute('src')?.startsWith('blob:'),
  )
  await page.waitForFunction(() => {
    const node = document.querySelector('.dom-node.markdown-node')
    const documentNode = node?.querySelector('.dom-markdown-document')
    if (!(node instanceof HTMLElement) || !(documentNode instanceof HTMLElement)) return false
    return node.getBoundingClientRect().height >= documentNode.scrollHeight - 2
  })
  const importedFileNodes = await page.evaluate(() => ({
    markdownText: document.querySelector('.dom-node.markdown-node .markdown-preview')?.textContent,
    markdownHasTable: Boolean(document.querySelector('.dom-node.markdown-node table')),
    markdownHasTask: Boolean(document.querySelector('.dom-node.markdown-node input[type="checkbox"]')),
    markdownHasCode: Boolean(document.querySelector('.dom-node.markdown-node pre code')),
    markdownFitsContent: (() => {
      const node = document.querySelector('.dom-node.markdown-node')
      const documentNode = node?.querySelector('.dom-markdown-document')
      return node instanceof HTMLElement && documentNode instanceof HTMLElement
        ? node.getBoundingClientRect().height >= documentNode.scrollHeight - 2
        : false
    })(),
    pdfTitle: document.querySelector('.dom-node.pdf-node')?.textContent,
    videoSrc: document.querySelector('.dom-node.video-node video')?.getAttribute('src'),
    videoHasPlay: Boolean(document.querySelector('.dom-node.video-node .dom-file-video-play')),
    videoBox: (() => {
      const rect = document.querySelector('.dom-node.video-node')?.getBoundingClientRect()
      return rect ? { width: rect.width, height: rect.height } : undefined
    })(),
  }))
  if (
    !importedFileNodes.markdownText?.includes('Mivo format brief') ||
    !importedFileNodes.markdownText.includes('fullDocumentPreview') ||
    !importedFileNodes.markdownHasTable ||
    !importedFileNodes.markdownHasTask ||
    !importedFileNodes.markdownHasCode ||
    !importedFileNodes.markdownFitsContent ||
    !importedFileNodes.pdfTitle?.includes('mivo-reference') ||
    !importedFileNodes.videoSrc?.startsWith('blob:') ||
    !importedFileNodes.videoHasPlay ||
    !importedFileNodes.videoBox ||
    Math.abs(importedFileNodes.videoBox.width / importedFileNodes.videoBox.height - 240 / 320) > 0.04
  ) {
    throw new Error(`Multi-format imports should render Markdown, PDF, and Video nodes: ${JSON.stringify(importedFileNodes)}`)
  }

  await page.locator('.canvas-shell').click({ position: { x: 12, y: 820 } })
  await page.locator('.dom-node.markdown-node').click({ position: { x: 20, y: 20 } })
  if ((await page.locator('.selection-quick-toolbar').count()) !== 0) {
    throw new Error('Markdown selection should not show a download-only quick toolbar')
  }
  await page.locator('.dom-node.video-node').click({ position: { x: 20, y: 20 } })
  if ((await page.locator('.selection-quick-toolbar').count()) !== 0) {
    throw new Error('Video selection should not show a download-only quick toolbar')
  }
  await page.locator('.dom-node.pdf-node').click({ position: { x: 20, y: 20 } })
  await page.waitForSelector('.selection-quick-toolbar')
  if ((await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'Download original' }).count()) !== 1) {
    throw new Error('PDF selection should keep the original-file download quick action')
  }
  await page.locator('.canvas-shell').click({ position: { x: 12, y: 820 } })

  await page.locator('.dom-node.markdown-node').dblclick({ position: { x: 20, y: 20 } })
  await page.getByRole('dialog', { name: 'Asset details' }).waitFor()
  if ((await page.locator('.node-preview-markdown .markdown-preview.details').count()) !== 1) {
    throw new Error('Markdown details should render a document preview')
  }
  if ((await page.locator('.details-dialog .field textarea').count()) !== 0) {
    throw new Error('Markdown details should not show an image-generation prompt field')
  }
  if ((await page.getByRole('button', { name: 'Raw', exact: true }).count()) !== 1) {
    throw new Error('Markdown details should expose a Raw view toggle')
  }
  await page.getByRole('button', { name: 'Raw', exact: true }).click()
  await page.waitForSelector('.node-preview-markdown-raw')
  if (!((await page.locator('.node-preview-markdown-raw').textContent()) || '').includes('# Mivo format brief')) {
    throw new Error('Markdown raw view should show original Markdown source')
  }
  await page.getByRole('button', { name: 'Rendered', exact: true }).click()
  await page.waitForSelector('.node-preview-markdown .markdown-preview.details')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.dom-node.markdown-node')
    return node instanceof HTMLElement && node.classList.contains('markdown-preview-mode')
  })
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.locator('.dom-node.pdf-node').dblclick({ position: { x: 20, y: 20 } })
  await page.getByRole('dialog', { name: 'Asset details' }).waitFor()
  if ((await page.locator('iframe.node-preview-pdf[src^="blob:"]').count()) !== 1) {
    throw new Error('PDF details should render a blob-backed document viewer')
  }
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.locator('.canvas-shell').click({ position: { x: 12, y: 820 } })
  await page.locator('.dom-node.video-node').dblclick({ position: { x: 20, y: 20 } })
  await page.getByRole('dialog', { name: 'Asset details' }).waitFor()
  if ((await page.locator('video.node-preview-video[src^="blob:"]').count()) !== 1) {
    throw new Error('Video details should render a blob-backed video preview')
  }
  await page.getByRole('button', { name: 'Close details' }).click()

  await page.evaluate(async () => {
    const shell = document.querySelector('.canvas-shell')
    if (!shell) throw new Error('Missing canvas shell for long Markdown import test')
    const rect = shell.getBoundingClientRect()
    const imageLine = '![Concept reference](https://example.com/mivo-reference.png)'
    const sections = Array.from({ length: 72 }, (_, index) =>
      [
        `## Direction ${index + 1}`,
        imageLine,
        'This longer research note should land on the canvas as a preview card instead of a very tall document column.',
      ].join('\n\n'),
    )
    const transfer = new DataTransfer()
    transfer.items.add(
      new File(
        ['# Mivo long research brief\n\n', sections.join('\n\n')],
        'mivo-long-research-brief.md',
        { type: 'text/markdown' },
      ),
    )

    shell.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2 + 260,
        clientY: rect.top + rect.height / 2,
      }),
    )
  })
  await page.waitForFunction(() => {
    const node = [...document.querySelectorAll('.dom-node.markdown-node')].find((candidate) =>
      candidate.textContent?.includes('Mivo long research brief'),
    )
    if (!(node instanceof HTMLElement)) return false

    const rect = node.getBoundingClientRect()
    return node.classList.contains('markdown-preview-mode') && rect.height <= 660 && Boolean(node.querySelector('.dom-markdown-preview-fade'))
  })

  await page.getByRole('button', { name: 'Assets' }).click()
  await page.getByRole('heading', { name: 'Assets' }).waitFor()
  const localAssetsResponse = await page.request.get(`${baseUrl}/api/mivo/local-assets`)
  if (!localAssetsResponse.ok()) {
    throw new Error(`Local asset API should be available in dev, got ${localAssetsResponse.status()}`)
  }
  const localAssetsPayload = await localAssetsResponse.json()
  if (
    !String(localAssetsPayload.root).includes('test-artifacts/local-assets') ||
    !Array.isArray(localAssetsPayload.assets) ||
    !localAssetsPayload.assets.some((asset) => asset.name === 'mivo-local-fixture.svg')
  ) {
    throw new Error(`Local asset API should index the configured fixture folder: ${JSON.stringify(localAssetsPayload)}`)
  }
  await page.getByRole('button', { name: /Pinterest boards/i }).click()
  await page.getByRole('button', { name: 'Add source' }).click()
  await page.getByRole('dialog', { name: 'Pinterest settings' }).waitFor()
  if ((await page.locator('.source-settings-dialog input').count()) !== 0) {
    throw new Error('Pinterest settings should default to an OAuth login view without credential fields')
  }
  if ((await page.getByRole('button', { name: 'Developer settings' }).count()) !== 0) {
    throw new Error('Pinterest product dialog should not expose developer settings')
  }
  await page.getByRole('button', { name: 'Connect Pinterest' }).click()
  await page.getByText(/layout prototype/).waitFor()
  await page.getByRole('button', { name: 'Close Pinterest settings' }).click()
  await page.getByRole('button', { name: /Eagle libraries/i }).click()
  await page.getByRole('button', { name: 'Mock Eagle Folder' }).waitFor()
  await page.getByRole('button', { name: 'Mock Eagle Folder' }).click()
  await page.waitForSelector('.asset-tile img[src^="/api/mivo/eagle/assets/"]')
  const eagleAssetTile = page.getByRole('button', { name: /Mock Eagle Concept/i })
  if ((await eagleAssetTile.count()) !== 1) {
    throw new Error('Assets workspace should render Eagle folder assets through the connector model')
  }
  await eagleAssetTile.click()
  await page.waitForSelector('.asset-detail-panel')
  const eagleAssetDetail = await page.locator('.asset-detail-panel').evaluate((panel) => ({
    title: panel.querySelector('h2')?.textContent,
    source: panel.querySelector('.library-kicker')?.textContent,
    copy: panel.textContent,
  }))
  if (
    eagleAssetDetail.title !== 'Mock Eagle Concept' ||
    eagleAssetDetail.source !== 'Eagle libraries' ||
    !eagleAssetDetail.copy?.includes('120 x 90') ||
    !eagleAssetDetail.copy.includes('mock, eagle') ||
    !eagleAssetDetail.copy.includes('https://example.com/mock-eagle-concept')
  ) {
    throw new Error(`Single-clicking an Eagle asset should open connector metadata details: ${JSON.stringify(eagleAssetDetail)}`)
  }
  await page.getByRole('button', { name: /Local folders/i }).click()
  await page.waitForSelector('.asset-tile img[src^="/api/mivo/local-assets/"]')
  const localAssetTile = page.getByRole('button', { name: /mivo-local-fixture/i })
  if ((await localAssetTile.count()) !== 1) {
    throw new Error('Assets workspace should render the local fixture as a real draggable tile')
  }
  await page.waitForFunction(() => {
    const tile = [...document.querySelectorAll('.asset-tile')].find((item) =>
      item.textContent?.includes('mivo-local-fixture'),
    )
    return tile?.textContent?.includes('SVG') && tile.textContent.includes('96 x 72')
  })
  await localAssetTile.click()
  await page.waitForSelector('.asset-detail-panel')
  if ((await page.locator('.canvas-shell').count()) !== 0) {
    throw new Error('Single-clicking an asset should open details without entering the canvas')
  }
  const localAssetDetail = await page.locator('.asset-detail-panel').evaluate((panel) => ({
    title: panel.querySelector('h2')?.textContent,
    source: panel.querySelector('.library-kicker')?.textContent,
    copy: panel.textContent,
  }))
  if (
    !localAssetDetail.title?.includes('mivo-local-fixture') ||
    localAssetDetail.source !== 'Local folders' ||
    !localAssetDetail.copy?.includes('96 x 72')
  ) {
    throw new Error(`Single-clicking a local asset should open metadata details: ${JSON.stringify(localAssetDetail)}`)
  }
  await localAssetTile.dblclick()
  await page.waitForSelector('.canvas-shell')
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.dom-node')].some(
        (node) =>
          node.getAttribute('data-node-id')?.startsWith('imported-') &&
          node.querySelector('.dom-node-media img')?.getAttribute('src')?.startsWith('blob:'),
      ),
  )

  await page.getByRole('button', { name: '角色参考图流程' }).click()
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')

  await page.getByRole('button', { name: 'Assets' }).click()
  await page.getByRole('heading', { name: 'Assets' }).waitFor()
  const assetsOpenLayout = await readLibraryLayout()
  const libraryTypeScale = await page.locator('.library-header h1').evaluate((heading) => ({
    fontSize: window.getComputedStyle(heading).fontSize,
    lineHeight: window.getComputedStyle(heading).lineHeight,
  }))
  if (libraryTypeScale.fontSize !== '28px') {
    throw new Error(`Library heading should use the quieter workspace heading scale: ${JSON.stringify(libraryTypeScale)}`)
  }
  if ((await page.locator('.canvas-shell').count()) !== 0) {
    throw new Error('Assets should switch the main workspace away from the canvas')
  }
  for (const source of ['Local folders', 'Eagle libraries', 'Pinterest boards']) {
    if ((await page.getByRole('button', { name: source }).count()) !== 1) {
      throw new Error(`Assets workspace should show source: ${source}`)
    }
  }
  await page.getByRole('button', { name: 'Collapse projects' }).click()
  await page.waitForFunction(() => {
    const workspace = document.querySelector('.workspace')
    const workspaceRect = workspace?.getBoundingClientRect()

    return (
      document.querySelector('.mivo-app')?.classList.contains('project-collapsed') &&
      Boolean(document.querySelector('[aria-label="Open projects"]')) &&
      document.querySelector('.library-workspace h1')?.textContent === 'Assets' &&
      workspaceRect &&
      Math.abs(workspaceRect.left - 240) <= 2 &&
      Math.abs(workspaceRect.width - (window.innerWidth - 240)) <= 2
    )
  })
  assertLibraryLayoutStable('Assets', assetsOpenLayout, await readLibraryLayout())
  const assetsSurfaceColors = await readLibrarySurfaceColors()
  if (
    !assetsSurfaceColors.hasLibraryActiveClass ||
    assetsSurfaceColors.appBackground !== assetsSurfaceColors.workspaceBackground ||
    assetsSurfaceColors.appBackground !== assetsSurfaceColors.libraryBackground ||
    assetsSurfaceColors.leftProbeBackground !== assetsSurfaceColors.appBackground ||
    assetsSurfaceColors.rightProbeBackground !== assetsSurfaceColors.workspaceBackground
  ) {
    throw new Error(`Library surfaces should share one background with no visible middle seam: ${JSON.stringify(assetsSurfaceColors)}`)
  }
  await page.getByRole('button', { name: 'Open projects' }).hover()
  await page.mouse.move(1510, 890)
  await wait(40)
  await page.getByRole('button', { name: 'Open projects' }).hover()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar.drawer')

    return sidebar && Math.abs(sidebar.getBoundingClientRect().left) <= 2
  })
  await page.mouse.move(1510, 890)
  await page.waitForFunction(() => !document.querySelector('.project-sidebar.drawer'))
  await page.getByRole('button', { name: 'Open projects' }).click()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar')
    return sidebar && !sidebar.classList.contains('drawer') && sidebar.getBoundingClientRect().width > 200
  })

  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.getByRole('heading', { name: 'Plugins' }).waitFor()
  const pluginsOpenLayout = await readLibraryLayout()
  if ((await page.locator('.canvas-shell').count()) !== 0) {
    throw new Error('Plugins should switch the main workspace away from the canvas')
  }
  for (const plugin of [
    'Character Consistency',
    'Eagle Connector',
    'Pinterest Connector',
    'Batch Variant Runner',
    'Product Image Presets',
  ]) {
    if ((await page.getByRole('button', { name: plugin }).count()) !== 1) {
      throw new Error(`Plugins workspace should show plugin: ${plugin}`)
    }
  }
  await page.getByRole('button', { name: 'Collapse projects' }).click()
  await page.waitForFunction(() => {
    const workspace = document.querySelector('.workspace')
    const workspaceRect = workspace?.getBoundingClientRect()

    return (
      document.querySelector('.mivo-app')?.classList.contains('project-collapsed') &&
      Boolean(document.querySelector('[aria-label="Open projects"]')) &&
      document.querySelector('.library-workspace h1')?.textContent === 'Plugins' &&
      workspaceRect &&
      Math.abs(workspaceRect.left - 240) <= 2 &&
      Math.abs(workspaceRect.width - (window.innerWidth - 240)) <= 2
    )
  })
  assertLibraryLayoutStable('Plugins', pluginsOpenLayout, await readLibraryLayout())
  await page.getByRole('button', { name: 'Open projects' }).click()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar')
    return sidebar && !sidebar.classList.contains('drawer') && sidebar.getBoundingClientRect().width > 200
  })

  await page.getByRole('button', { name: 'Skills' }).click()
  await page.getByRole('heading', { name: 'Skills' }).waitFor()
  const skillsOpenLayout = await readLibraryLayout()
  if ((await page.locator('.canvas-shell').count()) !== 0) {
    throw new Error('Skills should switch the main workspace away from the canvas')
  }
  for (const skill of ['Character Reference SOP', 'Prompt Critic', 'Asset Intake', 'Variant Planner']) {
    if ((await page.getByRole('button', { name: skill }).count()) !== 1) {
      throw new Error(`Skills workspace should show skill: ${skill}`)
    }
  }
  await page.getByRole('button', { name: 'Collapse projects' }).click()
  await page.waitForFunction(() => {
    const workspace = document.querySelector('.workspace')
    const workspaceRect = workspace?.getBoundingClientRect()

    return (
      document.querySelector('.mivo-app')?.classList.contains('project-collapsed') &&
      Boolean(document.querySelector('[aria-label="Open projects"]')) &&
      document.querySelector('.library-workspace h1')?.textContent === 'Skills' &&
      workspaceRect &&
      Math.abs(workspaceRect.left - 240) <= 2 &&
      Math.abs(workspaceRect.width - (window.innerWidth - 240)) <= 2
    )
  })
  assertLibraryLayoutStable('Skills', skillsOpenLayout, await readLibraryLayout())
  await page.getByRole('button', { name: 'Open projects' }).click()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.project-sidebar')
    return sidebar && !sidebar.classList.contains('drawer') && sidebar.getBoundingClientRect().width > 200
  })

  const sidebarSectionOrder = await page
    .locator('.project-sidebar .section-heading')
    .evaluateAll((headings) => headings.map((heading) => heading.textContent?.trim() ?? ''))
  const projectsIndex = sidebarSectionOrder.findIndex((heading) => heading.includes('Projects'))
  const canvasesIndex = sidebarSectionOrder.findIndex((heading) => heading.includes('Canvases'))
  if (projectsIndex === -1 || canvasesIndex === -1 || projectsIndex > canvasesIndex) {
    throw new Error(`Sidebar should list Projects before Canvases: ${sidebarSectionOrder.join(' > ')}`)
  }

  if ((await page.locator('.canvas-details').count()) !== 0) {
    throw new Error('Canvas rows should not show screenshot metadata')
  }

  const projectRowStructure = await page
    .locator('.project-sidebar .project-row.tree-row')
    .evaluateAll((rows) =>
      rows.map((row) => ({
        firstIconClass: row.children[0]?.getAttribute('class') ?? '',
        hasName: row.children[1]?.tagName === 'SPAN',
        hasHoverArrowAfterName: row.children[2]?.classList.contains('row-hover-arrow') ?? false,
        hoverArrowOpacity: row.children[2] ? window.getComputedStyle(row.children[2]).opacity : undefined,
      })),
    )
  if (
    !projectRowStructure.every(
      (row) =>
        row.firstIconClass.includes('folder') &&
        !row.firstIconClass.includes('chevron') &&
        row.hasName &&
        row.hasHoverArrowAfterName &&
        row.hoverArrowOpacity === '0',
    )
  ) {
    throw new Error(`Project rows should use folder state icons with hidden trailing arrows`)
  }

  const canvasRowStructure = await page
    .locator('.project-sidebar .canvas-row')
    .evaluateAll((rows) =>
      rows.map((row) => ({
        hasCanvasIconFirst: row.children[0]?.getAttribute('class')?.includes('monitor-up') ?? false,
        hasName: row.children[1]?.tagName === 'SPAN',
        hasHoverArrowAfterName: row.children[2]?.classList.contains('row-hover-arrow') ?? false,
        hoverArrowOpacity: row.children[2] ? window.getComputedStyle(row.children[2]).opacity : undefined,
      })),
    )
  if (
    !canvasRowStructure.every(
      (row) => row.hasCanvasIconFirst && row.hasName && row.hasHoverArrowAfterName && row.hoverArrowOpacity === '0',
    )
  ) {
    throw new Error('Canvas rows should show a trailing arrow only after the canvas name')
  }

  if ((await page.getByRole('button', { name: '生成中 / 失败 / 重试' }).count()) !== 1) {
    throw new Error('Sidebar should show standalone canvases outside projects')
  }

  const rootListAlignment = await page.evaluate(() => {
    const projectIcon = document.querySelector('.project-sidebar .project-row.tree-row svg')
    const canvasIcon = document.querySelector('.project-sidebar .standalone-tree .canvas-row svg')

    return {
      projectLeft: projectIcon?.getBoundingClientRect().left,
      canvasLeft: canvasIcon?.getBoundingClientRect().left,
    }
  })
  if (
    rootListAlignment.projectLeft === undefined ||
    rootListAlignment.canvasLeft === undefined ||
    Math.abs(rootListAlignment.projectLeft - rootListAlignment.canvasLeft) > 2
  ) {
    throw new Error(
      `Root project and canvas rows should be left-aligned: project=${rootListAlignment.projectLeft}, canvas=${rootListAlignment.canvasLeft}`,
    )
  }

  const conceptProject = page.getByRole('button', { name: 'Concept Battlepass' })
  if ((await conceptProject.count()) !== 1) throw new Error('Project tree should show Concept Battlepass')
  await conceptProject.hover()
  await page.waitForFunction(
    (button) => {
      const arrow = button?.querySelector('.row-hover-arrow')
      return arrow ? Number(window.getComputedStyle(arrow).opacity) > 0.9 : false
    },
    await conceptProject.elementHandle(),
  )

  if ((await page.getByRole('button', { name: '角色参考图流程' }).count()) !== 1) {
    throw new Error('Expanded project should show its canvas rows')
  }
  await page.getByRole('button', { name: '角色参考图流程' }).click()
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')

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
  for (const tool of ['Arrow', 'Line', 'Rectangle', 'Ellipse', 'Brush']) {
    if ((await page.locator('.canvas-tool-flyout').getByRole('menuitem', { name: tool }).count()) !== 1) {
      throw new Error(`Draw flyout should expose ${tool}`)
    }
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
  await arrowMarkupNode.dblclick()
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
  await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(textBox.x + textBox.width / 2 + 54, textBox.y + textBox.height / 2 + 32, { steps: 5 })
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

  await page.locator('.dom-node.text-node').last().click({ button: 'right' })
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

  await page.mouse.move(textResizeHandle.x + textResizeHandle.width / 2, textResizeHandle.y + textResizeHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(textResizeHandle.x + textResizeHandle.width / 2 + 90, textResizeHandle.y + textResizeHandle.height / 2)
  await page.mouse.up()

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

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
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

  const countBeforeGenerate = await page.locator('.dom-node').count()
  await page.getByRole('button', { name: '立即生成' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count + 1, countBeforeGenerate)

  const generatedCount = await page.locator('.dom-node').count()
  if (generatedCount !== countBeforeGenerate + 1) {
    throw new Error(`Expected ${countBeforeGenerate + 1} nodes after generation, got ${generatedCount}`)
  }
  const besideResult = await page.locator('.dom-node').last().evaluate((node) => ({
    kind: node.getAttribute('data-ai-kind'),
    operation: node.getAttribute('data-ai-operation'),
    sourceNodeIds: node.getAttribute('data-ai-source-node-ids'),
  }))
  if (
    besideResult.kind !== 'result' ||
    besideResult.operation !== 'beside-generation' ||
    !besideResult.sourceNodeIds?.includes(firstNodeId)
  ) {
    throw new Error(`Immediate generation should create a derived result beside the selected source: ${JSON.stringify(besideResult)}`)
  }

  const countBeforeSlot = await page.locator('.dom-node').count()
  await page.getByRole('button', { name: '新建生成槽位' }).click()
  await page.waitForSelector('.dom-node.ai-slot-node')
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count + 1, countBeforeSlot)
  const slotNodeId = await page.locator('.dom-node.ai-slot-node').last().getAttribute('data-node-id')
  if (!slotNodeId) throw new Error('AI slot creation should produce a selectable slot node')
  await page.getByRole('button', { name: '生成到槽位' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count + 2, countBeforeSlot)
  const slotResult = await page.locator('.dom-node').last().evaluate((node) => ({
    kind: node.getAttribute('data-ai-kind'),
    operation: node.getAttribute('data-ai-operation'),
    sourceNodeIds: node.getAttribute('data-ai-source-node-ids'),
  }))
  if (
    slotResult.kind !== 'result' ||
    slotResult.operation !== 'slot-generation' ||
    !slotResult.sourceNodeIds?.includes(slotNodeId)
  ) {
    throw new Error(`Slot generation should keep the slot and create a result linked to it: ${JSON.stringify(slotResult)}`)
  }

  const countBeforeAnnotation = await page.locator('.dom-node').count()
  await page.locator(`[data-node-id="${firstNodeId}"]`).click()
  await page.getByRole('button', { name: '添加批注修图' }).click()
  await page.waitForSelector('.dom-node.annotation-node')
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count + 1, countBeforeAnnotation)
  const annotationNodeId = await page.locator('.dom-node.annotation-node').last().getAttribute('data-node-id')
  if (!annotationNodeId) throw new Error('Annotation creation should produce a selectable note node')
  await page.getByRole('button', { name: '从批注生成' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count + 2, countBeforeAnnotation)
  const annotationResult = await page.locator('.dom-node').last().evaluate((node) => ({
    kind: node.getAttribute('data-ai-kind'),
    operation: node.getAttribute('data-ai-operation'),
    sourceNodeIds: node.getAttribute('data-ai-source-node-ids'),
  }))
  if (
    annotationResult.kind !== 'result' ||
    annotationResult.operation !== 'annotation-edit' ||
    !annotationResult.sourceNodeIds?.includes(firstNodeId)
  ) {
    throw new Error(`Annotation generation should create a clean derived result beside the source: ${JSON.stringify(annotationResult)}`)
  }

  await page.getByRole('button', { name: '查看 AI 上下文' }).click()
  const aiContextPreview = await page.locator('.ai-context-preview').textContent()
  if (
    !aiContextPreview?.includes('"slots": 1') ||
    !aiContextPreview.includes('"annotations": 1') ||
    !aiContextPreview.includes('"annotation-edit"') ||
    !aiContextPreview.includes('"slot-generation"')
  ) {
    throw new Error(`AI context preview should serialize slots, annotations, and derivation links: ${aiContextPreview}`)
  }
  const aiContext = JSON.parse(aiContextPreview)
  const aiLinkKeys = aiContext.links.map((link) => `${link.kind}:${link.fromNodeId}:${link.toNodeId}`)
  if (new Set(aiLinkKeys).size !== aiLinkKeys.length) {
    throw new Error(`AI context links should be de-duplicated: ${aiLinkKeys.join(', ')}`)
  }
  const workflowCount = await page.locator('.dom-node').count()

  await page.getByRole('button', { name: '4 张变体结果' }).click()
  await page.waitForFunction(() => document.querySelector('.top-title-lockup strong')?.textContent === '4 张变体结果')
  await page.getByRole('button', { name: '角色参考图流程' }).click()
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count, workflowCount)

  page.once('dialog', (dialog) => {
    void dialog.accept('Mivo Persistent Canvas')
  })
  await page.getByRole('button', { name: 'Canvas options' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.waitForFunction(() => document.querySelector('.top-title-lockup strong')?.textContent === 'Mivo Persistent Canvas')
  if ((await page.getByRole('button', { name: 'Mivo Persistent Canvas' }).count()) !== 1) {
    throw new Error('Renamed canvas should update the sidebar row')
  }
  await page.getByRole('button', { name: 'Canvas options' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate canvas' }).click()
  await page.waitForFunction(() => document.querySelector('.top-title-lockup strong')?.textContent === 'Mivo Persistent Canvas Copy')
  if ((await page.getByRole('button', { name: 'Mivo Persistent Canvas Copy' }).count()) !== 1) {
    throw new Error('Duplicate canvas should create and activate a real canvas copy')
  }
  page.once('dialog', (dialog) => {
    void dialog.accept()
  })
  await page.getByRole('button', { name: 'Canvas options' }).click()
  await page.getByRole('menuitem', { name: 'Delete canvas' }).click()
  await page.waitForFunction(() => document.querySelector('.top-title-lockup strong')?.textContent === 'Mivo Persistent Canvas')
  if ((await page.getByRole('button', { name: 'Mivo Persistent Canvas Copy' }).count()) !== 0) {
    throw new Error('Delete canvas should remove the duplicated canvas from the sidebar')
  }
  await page.getByRole('button', { name: 'Assets' }).click()
  await page.getByRole('heading', { name: 'Assets' }).waitFor()
  await page.getByRole('button', { name: 'Mivo Persistent Canvas' }).click()
  await page.waitForFunction(() => document.querySelector('.top-title-lockup strong')?.textContent === 'Mivo Persistent Canvas')
  await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length === count, workflowCount)

  const geometry = await page.evaluate(() => {
    const controls = document.querySelector('.canvas-controls')?.getBoundingClientRect()
    const aiPanel = document.querySelector('.ai-panel')?.getBoundingClientRect()
    const canvas = document.querySelector('.canvas-shell')?.getBoundingClientRect()
    const workSurface = document.querySelector('.work-surface')?.getBoundingClientRect()

    return {
      controls,
      aiPanel,
      aiPanelRadius: aiPanel ? window.getComputedStyle(document.querySelector('.ai-panel')).borderRadius : undefined,
      canvas,
      workSurface,
    }
  })

  if (!geometry.controls || !geometry.aiPanel || !geometry.canvas || !geometry.workSurface) {
    throw new Error('Missing required layout elements')
  }

  if (rectsOverlap(geometry.controls, geometry.aiPanel)) {
    throw new Error('Zoom controls overlap the floating AI panel')
  }

  if (geometry.aiPanelRadius !== '16px') {
    throw new Error(`AI panel should use the shared large panel radius: ${geometry.aiPanelRadius}`)
  }

  if (Math.abs(geometry.canvas.width - geometry.workSurface.width) > 1) {
    throw new Error('Canvas is being squeezed by floating overlays')
  }

  const countBeforeClipboardPaste = await page.locator('.dom-node').count()
  await page.evaluate(async () => {
    const response = await fetch('/demo-assets/courage-1.jpg')
    const blob = await response.blob()
    const file = new File([blob], 'clipboard-courage.jpg', { type: blob.type || 'image/jpeg' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    window.dispatchEvent(event)
  })
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count + 1,
    countBeforeClipboardPaste,
  )

  await page.getByRole('button', { name: 'Reset view' }).click()
  const countBeforeTransparentPaste = await page.locator('.dom-node').count()
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Missing canvas context for transparent paste test')

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = 'rgba(105, 87, 232, 0.88)'
    context.beginPath()
    context.arc(64, 64, 46, 0, Math.PI * 2)
    context.fill()

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!(blob instanceof Blob)) throw new Error('Failed to create transparent png blob')

    const file = new File([blob], 'transparent-sticker.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    window.dispatchEvent(event)
  })
  await page.waitForFunction(
    (count) => document.querySelectorAll('.dom-node').length === count + 1,
    countBeforeTransparentPaste,
  )
  await page.locator('.dom-node').last().locator('.dom-node-media img').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const image = [...document.querySelectorAll('.dom-node')].at(-1)?.querySelector('.dom-node-media img')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  })
  const transparentPasteRender = await page.locator('.dom-node').last().evaluate((node) => {
    const media = node.querySelector('.dom-node-media')
    const image = node.querySelector('.dom-node-media img')
    const nodeStyle = window.getComputedStyle(node)
    const mediaStyle = media ? window.getComputedStyle(media) : undefined
    const imageStyle = image ? window.getComputedStyle(image) : undefined
    const rect = node.getBoundingClientRect()
    const imageRect = image?.getBoundingClientRect()

    return {
      width: rect.width,
      height: rect.height,
      nodeBoxShadow: nodeStyle.boxShadow,
      mediaBackground: mediaStyle?.backgroundColor,
      imageClass: image?.getAttribute('class') || '',
      imageFilter: imageStyle?.filter,
      imageObjectFit: imageStyle?.objectFit,
      imageWidth: imageRect?.width || 0,
      imageHeight: imageRect?.height || 0,
      naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
      naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
    }
  })
  if (
    Math.abs(transparentPasteRender.width - transparentPasteRender.height) > 1 ||
    !nearlyEqual(transparentPasteRender.width, 128, 1) ||
    !nearlyEqual(transparentPasteRender.height, 128, 1) ||
    transparentPasteRender.nodeBoxShadow !== 'none' ||
    transparentPasteRender.mediaBackground !== 'rgba(0, 0, 0, 0)' ||
    transparentPasteRender.imageClass.includes('cropped-image') ||
    transparentPasteRender.imageFilter === 'none' ||
    transparentPasteRender.imageObjectFit !== 'contain' ||
    !nearlyEqual(transparentPasteRender.imageWidth, transparentPasteRender.width, 1) ||
    !nearlyEqual(transparentPasteRender.imageHeight, transparentPasteRender.height, 1) ||
    transparentPasteRender.naturalWidth !== 128 ||
    transparentPasteRender.naturalHeight !== 128
  ) {
    throw new Error(`Transparent PNG paste should keep the original image frame while rendering alpha transparently: ${JSON.stringify(transparentPasteRender)}`)
  }

  await page.screenshot({ path: 'test-artifacts/e2e-smoke.png', fullPage: true })
  await browser.close()

  if (errors.length) {
    throw new Error(`Console errors:\n${errors.join('\n')}`)
  }

  console.log('E2E smoke test passed')
} finally {
  server.kill('SIGTERM')
  eagleMockServer.close()
}
