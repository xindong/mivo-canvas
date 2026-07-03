export const runArchiveAssetsScenario = async (context) => {
  const {
    Buffer,
    assertLibraryLayoutStable,
    baseUrl,
    page,
    readLibraryLayout,
    readLibrarySurfaceColors,
    wait,
  } = context

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
      version: 2,
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
  // R6: 底部任务条移除后画布下沿降低、工具条下移，可能与底部节点重叠遮挡点击。
  // space+drag 上移画布 140px，使视频节点脱离工具条遮挡（viewport 偏移持续，后续 video dblclick 同样受益）。
  {
    const shellBox = await page.locator('.canvas-shell').boundingBox()
    if (shellBox) {
      const startX = shellBox.x + shellBox.width / 2
      const startY = shellBox.y + shellBox.height / 2
      await page.keyboard.down('Space')
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      await page.mouse.move(startX, startY - 140, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Space')
      await page.waitForTimeout(150)
    }
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
  await page.waitForSelector('.asset-masonry-card img[src^="/api/mivo/eagle/assets/"]')
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.asset-masonry-card')]
    return cards.length === 1 && cards[0].querySelector('strong')?.textContent?.trim() === 'Mock Eagle Concept'
  })
  const eagleAssetCard = page.locator('.asset-masonry-card').filter({
    has: page.locator('strong', { hasText: /^Mock Eagle Concept$/ }),
  })
  await eagleAssetCard.first().waitFor()

  if ((await page.locator('.eagle-tag-directory').getByRole('button', { name: /mock/i }).count()) !== 1) {
    throw new Error('Eagle workspace should render connector tags in the tag directory')
  }
  await page.locator('.eagle-tag-directory').getByRole('button', { name: /mock/i }).click()
  await page.waitForFunction(() => {
    const heading = document.querySelector('.asset-browser .library-section-heading strong')?.textContent || ''
    return heading.includes('Tag: mock') && document.querySelectorAll('.asset-masonry-card').length === 1
  })
  await page.locator('.eagle-tag-directory').getByRole('button', { name: /^All/i }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-masonry-card').length === 1)

  const eagleCardCopy = await eagleAssetCard.evaluate((card) => ({
    title: card.querySelector('strong')?.textContent,
    summary: card.querySelector('small')?.textContent,
  }))
  if (
    eagleCardCopy.title !== 'Mock Eagle Concept' ||
    !eagleCardCopy.summary?.includes('SVG') ||
    !eagleCardCopy.summary.includes('120 x 90')
  ) {
    throw new Error(`Eagle masonry card should show compact image metadata: ${JSON.stringify(eagleCardCopy)}`)
  }
  await eagleAssetCard.click()
  await page.waitForSelector('.asset-lightbox-panel')
  await page.waitForFunction(() => {
    const preview = document.querySelector('.asset-lightbox-image')
    return preview && !preview.classList.contains('loading')
  })
  const eagleAssetPreview = await page.locator('.asset-lightbox-panel').evaluate((panel) => ({
    title: panel.querySelector('h2')?.textContent,
    source: panel.querySelector('.library-kicker')?.textContent,
    copy: panel.textContent,
    imageState: panel.querySelector('.asset-lightbox-image')?.getAttribute('class'),
  }))
  if (
    eagleAssetPreview.title !== 'Mock Eagle Concept' ||
    eagleAssetPreview.source !== 'Eagle libraries' ||
    !eagleAssetPreview.copy?.includes('120 x 90') ||
    !eagleAssetPreview.imageState?.includes('ready')
  ) {
    throw new Error(`Single-clicking an Eagle asset should open the current lightbox preview: ${JSON.stringify(eagleAssetPreview)}`)
  }
  await page.getByRole('button', { name: 'Close asset preview' }).click()
  await page.waitForSelector('.asset-lightbox-panel', { state: 'detached' })
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
  if ((await page.locator('.asset-library-drawer').count()) !== 1 || (await page.locator('.canvas-shell').count()) !== 1) {
    throw new Error('Single-clicking a drawer asset should open details while keeping the canvas behind the drawer')
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
  await page.locator('.asset-detail-panel').getByRole('button', { name: 'Add to canvas' }).click()
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
  if (libraryTypeScale.fontSize !== '22px') {
    throw new Error(`Assets drawer heading should use the compact drawer heading scale: ${JSON.stringify(libraryTypeScale)}`)
  }
  if ((await page.locator('.canvas-shell').count()) !== 1 || (await page.locator('.asset-library-drawer').count()) !== 1) {
    throw new Error('Assets drawer should keep a single canvas shell behind the asset browser')
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
  const assetsDrawerState = await page.evaluate(() => ({
    hasDrawer: Boolean(document.querySelector('.asset-library-drawer')),
    hasCanvas: Boolean(document.querySelector('.canvas-shell')),
    hasLibraryActiveClass: document.querySelector('.mivo-app')?.classList.contains('library-active'),
  }))
  if (!assetsDrawerState.hasDrawer || !assetsDrawerState.hasCanvas || assetsDrawerState.hasLibraryActiveClass) {
    throw new Error(
      `Assets should render as a drawer over the canvas, not as a full library workspace: state=${JSON.stringify(
        assetsDrawerState,
      )}, colors=${JSON.stringify(assetsSurfaceColors)}`,
    )
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
}
