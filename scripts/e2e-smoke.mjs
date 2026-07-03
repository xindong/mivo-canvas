import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import {
  assertLibraryLayoutStable,
  createPageReaders,
  nearlyEqual,
  rectsOverlap,
  wait,
  waitForServer,
} from './e2e-helpers.mjs'
import { attachDefaultMivoApiMocks } from './e2e/api-mocks.mjs'
import { startEagleMockServer } from './e2e/eagle-mock-server.mjs'
import { prepareSmokeFixtures } from './e2e/fixtures.mjs'
import { scenarioBootstrapPredecessor, scenarioOrder, scenarioRunners } from './e2e/scenarios/index.mjs'
import {
  createBaseUrl,
  createSmokePage,
  prepareSmokeArtifacts,
  runCommand,
  startSmokeDevServer,
  stopSmokeDevServer,
} from './e2e/harness.mjs'

const port = Number(process.env.MIVO_E2E_PORT ?? 5174)
const baseUrl = createBaseUrl(port)
const {
  eagleMockDir,
  eagleMockItem,
  eagleMockItemDir,
  generatedImageB64,
  horizontalMaskSourceB64,
  localAssetFixtureDir,
  localAssetFixtureSvg,
} = prepareSmokeFixtures()
const eagleMockHandle = await startEagleMockServer({ eagleMockDir, eagleMockItem, eagleMockItemDir })
const server = startSmokeDevServer({ port, localAssetFixtureDir, eagleMockPort: eagleMockHandle.port })

try {
  await prepareSmokeArtifacts()
  await runCommand('npm', ['run', 'verify:logging'])
  const [nodeRegistrySource, actionModelSource, viteConfigSource, modelCapabilitiesSource] = await Promise.all([
    readFile('src/canvas/nodeTypes/canvasNodeRegistry.ts', 'utf8'),
    readFile('src/canvas/actions/canvasActionModel.ts', 'utf8'),
    readFile('vite.config.ts', 'utf8'),
    readFile('src/lib/modelCapabilities.ts', 'utf8'),
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
  for (const expectedSize of [
    "high: '2304x2304'",
    "high: '3456x2304'",
    "high: '2304x3456'",
    "high: '2560x1440'",
    "high: '1440x2560'",
  ]) {
    if (!viteConfigSource.includes(expectedSize)) {
      throw new Error(`R3 high quality size map should include ${expectedSize}`)
    }
  }

  // ⑥ 能力表双写同步（SC-3）：modelCapabilities.ts 与 vite.config.ts mivoModelRatioMap 的 gemini ratios 必须一致且无 21:9（hard fail，两端已合并）。
  {
    // modelCapabilities.ts: 'gemini-3-pro-image': { ... ratios: ['1:1', ...] }
    const extractFromModelCaps = (source) => {
      const match = source.match(/'gemini-3-pro-image':\s*\{[\s\S]*?ratios:\s*\[([^\]]*)\]/)
      if (!match) return null
      return match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    }
    // vite.config.ts mivoModelRatioMap: 'gemini-3-pro-image': ['1:1', ...]（直接数组，无 ratios 键）
    const extractFromViteMap = (source) => {
      const match = source.match(/'gemini-3-pro-image':\s*\[([^\]]*)\]/)
      if (!match) return null
      return match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    }
    const capsRatios = extractFromModelCaps(modelCapabilitiesSource)
    const viteRatios = extractFromViteMap(viteConfigSource)
    if (!capsRatios) throw new Error(`Could not extract gemini ratios from modelCapabilities.ts`)
    if (capsRatios.includes('21:9')) {
      throw new Error(`modelCapabilities gemini must not have 21:9, got ${JSON.stringify(capsRatios)}`)
    }
    if (!viteRatios) {
      throw new Error(`dual-write: could not extract gemini ratios from vite.config.ts mivoModelRatioMap`)
    }
    const same = capsRatios.length === viteRatios.length && capsRatios.every((r, i) => r === viteRatios[i])
    if (!same) {
      throw new Error(`dual-write: gemini ratios differ — modelCapabilities=${JSON.stringify(capsRatios)} vs vite.mivoModelRatioMap=${JSON.stringify(viteRatios)}`)
    }
    if (viteRatios.includes('21:9')) {
      throw new Error(`dual-write: vite mivoModelRatioMap gemini must not have 21:9, got ${JSON.stringify(viteRatios)}`)
    }
  }

  await waitForServer(baseUrl)

  const { browser, errors, mivoEditRequests, page } = await createSmokePage({ baseUrl, generatedImageB64 })
  const { readFloatingChrome, readLibraryLayout, readLibrarySurfaceColors } = createPageReaders(page)


  const canvasStoreSpec = async () =>
    page.evaluate(() => {
      const resource = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => name.includes('/src/store/canvasStore.ts'))
      return resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/canvasStore.ts'
    })
  const chatStoreSpec = async () =>
    page.evaluate(() => {
      const resource = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => name.includes('/src/store/chatStore.ts'))
      return resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    })

  const readCanvasState = async () => {
    const spec = await canvasStoreSpec()
    return page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      const state = useCanvasStore.getState()
      return {
        selectedNodeId: state.selectedNodeId,
        selectedNodeIds: state.selectedNodeIds,
        nodes: state.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title,
          sourceNodeId: node.sourceNodeId,
          aiWorkflow: node.aiWorkflow,
        })),
        edges: state.edges.map((edge) => ({ ...edge })),
      }
    }, spec)
  }

  const readChatState = async () => {
    const spec = await chatStoreSpec()
    return page.evaluate(async (moduleSpec) => {
      const { useChatStore } = await import(moduleSpec)
      const state = useChatStore.getState()
      return {
        isBusy: state.isBusy,
        messagesByScene: state.messagesByScene,
        selectedModel: state.selectedModel,
        paramOverrides: state.paramOverrides,
      }
    }, spec)
  }

  const waitForChatIdle = async () => {
    const spec = await chatStoreSpec()
    const startedAt = Date.now()
    while (Date.now() - startedAt < 10000) {
      const idle = await page.evaluate(async (moduleSpec) => {
        const { useChatStore } = await import(moduleSpec)
        return !useChatStore.getState().isBusy
      }, spec)
      if (idle) return
      await wait(50)
    }
    throw new Error('Timed out waiting for chat generation to finish')
  }

  const waitForCanvasState = async (predicate, payload) => {
    const spec = await canvasStoreSpec()
    const startedAt = Date.now()
    while (Date.now() - startedAt < 8000) {
      const matches = await page.evaluate(async ({ moduleSpec, predicateSource, payload }) => {
        const { useCanvasStore } = await import(moduleSpec)
        return new Function('state', 'payload', `return (${predicateSource})(state, payload)`)(useCanvasStore.getState(), payload)
      }, { moduleSpec: spec, predicateSource: predicate.toString(), payload })
      if (matches) return
      await wait(50)
    }
    throw new Error(`Timed out waiting for canvas state: ${predicate.toString()}`)
  }

  const ensureChatPanelOpen = async () => {
    if (await page.locator('.ai-panel.collapsed').isVisible()) {
      await page.getByRole('button', { name: 'Open AI panel' }).click()
      await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
    }
    await page.waitForSelector('.ai-panel-header')
  }

  const assertTasksHeaderCopy = async (label) => {
    const tasksCopy = await page.evaluate(() => {
      const countPattern = /\b\d+\s*\/\s*\d+\b/
      const titleWithCount = Array.from(document.querySelectorAll('[title]'))
        .map((element) => element.getAttribute('title') || '')
        .find((title) => countPattern.test(title)) || null
      const ariaWithCount = Array.from(document.querySelectorAll('[aria-label]'))
        .map((element) => element.getAttribute('aria-label') || '')
        .find((ariaLabel) => countPattern.test(ariaLabel)) || null
      const bodyCountText = document.body.innerText.match(countPattern)?.[0] || null
      return {
        labelText: document.querySelector('.ai-panel-tasks-label')?.textContent?.trim() || '',
        headerText: document.querySelector('.ai-panel-header')?.textContent || '',
        bodyCountText,
        titleWithCount,
        ariaWithCount,
      }
    })
    if (tasksCopy.labelText !== 'TASKS' || !tasksCopy.headerText.includes('TASKS')) {
      throw new Error(`${label}: header should keep TASKS title: ${JSON.stringify(tasksCopy)}`)
    }
    if (tasksCopy.bodyCountText || tasksCopy.titleWithCount || tasksCopy.ariaWithCount) {
      throw new Error(`${label}: header should not expose done/total count: ${JSON.stringify(tasksCopy)}`)
    }
  }

  const readHeaderTasksIndicator = async () => page.evaluate(() => {
    const rectFor = (element) => {
      const rect = element?.getBoundingClientRect()
      return rect ? {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      } : null
    }
    const header = document.querySelector('.ai-panel-header')
    const indicator = document.querySelector('.ai-panel-tasks')
    const label = document.querySelector('.ai-panel-tasks-label')
    const spinner = document.querySelector('.ai-panel-tasks-spinner')
    const headerStyle = header ? window.getComputedStyle(header) : null
    const expectedLeft = header && headerStyle ? header.getBoundingClientRect().left + Number.parseFloat(headerStyle.paddingLeft) : null
    return {
      hasIndicator: Boolean(indicator),
      hasLabel: label?.textContent?.trim() === 'TASKS',
      hasSpinner: Boolean(spinner),
      header: rectFor(header),
      indicator: rectFor(indicator),
      label: rectFor(label),
      spinner: rectFor(spinner),
      expectedLeft,
    }
  })

  const parseScenarioArgs = (argv) => {
    const values = []

    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]
      if (arg === '--scenario') {
        const value = argv[index + 1]
        if (!value || value.startsWith('--')) {
          throw new Error('--scenario requires a value')
        }
        values.push(value)
        index += 1
        continue
      }

      if (arg.startsWith('--scenario=')) {
        values.push(arg.slice('--scenario='.length))
      }
    }

    return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
  }

  const resolveScenarioSelection = (argv) => {
    const requested = parseScenarioArgs(argv)
    if (requested.length === 0) return scenarioOrder

    const unique = [...new Set(requested)]
    const unknown = unique.filter((name) => !scenarioOrder.includes(name))
    if (unknown.length > 0) {
      throw new Error(`Unknown --scenario value(s): ${unknown.join(', ')}. Expected one of: ${scenarioOrder.join(', ')}`)
    }

    return scenarioOrder.filter((name) => unique.includes(name))
  }

  const restoreDefaultApiMocks = async () => {
    await page.unroute('**/api/mivo/generate')
    await page.unroute('**/api/mivo/edit')
    await page.unroute('**/api/mivo/enhance')
    mivoEditRequests.length = 0
    await attachDefaultMivoApiMocks(page, { generatedImageB64, mivoEditRequests })
  }

  const bootstrapBaseCanvas = async () => {
    await restoreDefaultApiMocks()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.evaluate(() => window.localStorage.clear())
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
  }

  const selectedScenarios = resolveScenarioSelection(process.argv.slice(2))
  const isFilteredRun = selectedScenarios.length !== scenarioOrder.length
  const scenarioContext = {
    Buffer,
    assertLibraryLayoutStable,
    baseUrl,
    browser,
    canvasStoreSpec,
    chatStoreSpec,
    ensureChatPanelOpen,
    firstNodeId: undefined,
    generatedImageB64,
    horizontalMaskSourceB64,
    localAssetFixtureSvg,
    mivoEditRequests,
    nearlyEqual,
    page,
    readCanvasState,
    readChatState,
    readFloatingChrome,
    readHeaderTasksIndicator,
    readLibraryLayout,
    readLibrarySurfaceColors,
    rectsOverlap,
    wait,
    waitForCanvasState,
    waitForChatIdle,
    assertTasksHeaderCopy,
  }

  let previousScenarioName = null
  for (const scenarioName of selectedScenarios) {
    const requiredPrevious = scenarioBootstrapPredecessor[scenarioName]
    if (isFilteredRun && requiredPrevious && previousScenarioName !== requiredPrevious) {
      scenarioContext.firstNodeId = undefined
      await bootstrapBaseCanvas()
    }
    await scenarioRunners[scenarioName](scenarioContext)
    previousScenarioName = scenarioName
  }


  await page.screenshot({ path: 'test-artifacts/e2e-smoke.png', fullPage: true })
  await browser.close()

  // Filter known spurious network errors (Eagle mock uses filesystem paths as image URLs on macOS)
  const realErrors = errors.filter((e) =>
    !e.includes('ERR_UNKNOWN_URL_SCHEME') &&
    !e.includes('status of 504 (Gateway Timeout)'),
  )
  if (realErrors.length) {
    throw new Error(`Console errors:\n${realErrors.join('\n')}`)
  }

  console.log('E2E smoke test passed')
} finally {
  stopSmokeDevServer(server)
  await eagleMockHandle.close()
}
