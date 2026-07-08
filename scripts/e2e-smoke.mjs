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
import { assertPublicModeSecurity } from './e2e/prod-auth-assertions.mjs'
import { startUpstreamMockServer } from './e2e/upstream-mock-server.mjs'
import { leaferSkippedScenarios, scenarioOrder, scenarioRunners } from './e2e/scenarios/index.mjs'
import {
  clearAllStorage,
  createBaseUrl,
  createSmokePage,
  prepareSmokeArtifacts,
  readPersistedKv,
  runCommand,
  startSmokeBffServer,
  startSmokeDevServer,
  stopSmokeDevServer,
  waitForPersistedKv,
  writePersistedKv,
} from './e2e/harness.mjs'

const requestedPort = Number(process.env.MIVO_E2E_PORT ?? 5174)
const cliArgs = process.argv.slice(2)
const resolveTopology = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--topology') {
      const value = argv[index + 1]
      if (value === 'prod') return 'prod'
      if (value === 'dev') return 'dev'
      throw new Error('--topology requires dev or prod')
    }
    if (arg.startsWith('--topology=')) {
      const value = arg.slice('--topology='.length)
      if (value === 'prod' || value === 'dev') return value
      throw new Error(`Unknown --topology value: ${value}`)
    }
  }
  return 'dev'
}
const topology = resolveTopology(cliArgs)
const isProdTopology = topology === 'prod'
const resolveRenderer = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--renderer') {
      const value = argv[index + 1]
      if (value === 'dom' || value === 'leafer') return value
      throw new Error('--renderer requires dom or leafer')
    }
    if (arg.startsWith('--renderer=')) {
      const value = arg.slice('--renderer='.length)
      if (value === 'dom' || value === 'leafer') return value
      throw new Error(`Unknown --renderer value: ${value}`)
    }
  }
  return 'dom'
}
const rendererMode = resolveRenderer(cliArgs)
const useRealUpstream = process.env.MIVO_E2E_USE_REAL_UPSTREAM === '1'
const disableApiRouteMocks = process.env.MIVO_E2E_DISABLE_API_ROUTE_MOCKS === '1'
const securityPort = requestedPort
const runtimePort = isProdTopology ? requestedPort + 1 : requestedPort
const securityBaseUrl = createBaseUrl(securityPort)
const baseUrl = createBaseUrl(runtimePort)
const canvasUrl = `${baseUrl}?renderer=${rendererMode}`
const devBffBaseUrl = createBaseUrl(requestedPort + 1)
const debugViewToken = 'test-token'
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
const upstreamMockHandle = useRealUpstream ? null : await startUpstreamMockServer({ generatedImageB64 })
const startTopologyServer = ({ activePort, debugViewToken: serverDebugViewToken, enableLocalAssets, enableEagleProxy }) =>
  isProdTopology
    ? startSmokeBffServer({
        port: activePort,
        localAssetFixtureDir,
        eagleMockPort: eagleMockHandle.port,
        upstreamBaseUrl: upstreamMockHandle?.url,
        debugViewToken: serverDebugViewToken,
        enableLocalAssets,
        enableEagleProxy,
      })
    : (() => {
        const bffPort = activePort + 1
        const bff = startSmokeBffServer({
          port: bffPort,
          localAssetFixtureDir,
          eagleMockPort: eagleMockHandle.port,
          upstreamBaseUrl: upstreamMockHandle?.url,
          debugViewToken: serverDebugViewToken,
          enableLocalAssets,
          enableEagleProxy,
          isPublic: false,
        })
        const dev = startSmokeDevServer({ port: activePort, localAssetFixtureDir, eagleMockPort: eagleMockHandle.port, bffPort })
        return { bff, dev }
      })()

// prod topology 跑的是 dist/ 静态产物;逐场景直接调 runner 不会重新 build,
// dist 落后 src 时跑的是过期代码(2026-07-06 验收事故:旧 dist 无 FU-11/3c,
// prod leafer 假失败)。这里只警告不中断——CI 的 test:e2e:prod 永远先 build。
if (isProdTopology) {
  try {
    const { statSync } = await import('node:fs')
    const { execSync } = await import('node:child_process')
    const distMtime = statSync('dist/index.html').mtimeMs
    const newestSrc = execSync(
      "find src server -type f -newer dist/index.html 2>/dev/null | head -5",
      { encoding: 'utf8' },
    ).trim()
    if (newestSrc) {
      console.warn(
        `[e2e-smoke] WARNING: dist/ (${new Date(distMtime).toISOString()}) 比以下源码文件旧,prod 跑的可能是过期构建;请先 npm run build(或用 npm run test:e2e:prod):\n${newestSrc}`,
      )
    }
  } catch {
    console.warn('[e2e-smoke] WARNING: dist/index.html 不存在或不可读,prod topology 需要先 npm run build')
  }
}

let server

try {
  await prepareSmokeArtifacts()
  await runCommand('npm', ['run', 'verify:logging'])
  server = startTopologyServer({
    activePort: securityPort,
    debugViewToken: '',
    enableLocalAssets: !isProdTopology,
    enableEagleProxy: !isProdTopology,
  })
  await waitForServer(isProdTopology ? `${securityBaseUrl}/healthz` : baseUrl)
  if (!isProdTopology) {
    await waitForServer(`${devBffBaseUrl}/healthz`)
  }

  if (isProdTopology) {
    // SSO 模型:app 无 auth gate。public 模式(MIVO_PUBLIC=1)下验 dev 桩硬关
    // (/api/auth/me 401)+ feature flag 收紧(local-assets/eagle 404、debug-logs 403)。
    // 旧 BFF token gate / unauthorized-gate 断言已删(app gate 按设计删,裸请求本就
    // 该到 handler)。authedFetch=普通 fetch(无鉴权 header;debug-logs 不带 view
    // token → 403,正是要验的 fail-closed)。
    await assertPublicModeSecurity({ baseUrl: securityBaseUrl, authedFetch: fetch })

    await stopSmokeDevServer(server)
    server = startTopologyServer({
      activePort: runtimePort,
      debugViewToken,
      enableLocalAssets: true,
      enableEagleProxy: true,
    })
    await waitForServer(`${baseUrl}/healthz`)
  }

  const [nodeRegistrySource, actionModelSource, bffConfigSource, modelCapabilitiesSource] = await Promise.all([
    readFile('src/canvas/nodeTypes/canvasNodeRegistry.ts', 'utf8'),
    readFile('src/canvas/actions/canvasActionModel.ts', 'utf8'),
    readFile('server/lib/config.ts', 'utf8'),
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
    if (!bffConfigSource.includes(expectedSize)) {
      throw new Error(`R3 high quality size map should include ${expectedSize}`)
    }
  }

  // ⑥ 能力表双写同步（SC-3）：modelCapabilities.ts 与 server/lib/config.ts mivoModelRatioMap 的 gemini ratios 必须一致且无 21:9（hard fail，两端已合并）。
  {
    // modelCapabilities.ts: 'gemini-3-pro-image': { ... ratios: ['1:1', ...] }
    const extractFromModelCaps = (source) => {
      const match = source.match(/'gemini-3-pro-image':\s*\{[\s\S]*?ratios:\s*\[([^\]]*)\]/)
      if (!match) return null
      return match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    }
    // server/lib/config.ts mivoModelRatioMap: 'gemini-3-pro-image': ['1:1', ...]（直接数组，无 ratios 键）
    const extractFromViteMap = (source) => {
      const match = source.match(/'gemini-3-pro-image':\s*\[([^\]]*)\]/)
      if (!match) return null
      return match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    }
    const capsRatios = extractFromModelCaps(modelCapabilitiesSource)
    const viteRatios = extractFromViteMap(bffConfigSource)
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

  const createScenarioSmokePage = () => createSmokePage({
    baseUrl,
    generatedImageB64,
    enableApiRouteMocks: !(isProdTopology && disableApiRouteMocks),
    enableStoreBridgeModules: isProdTopology,
    mockAuthMe: isProdTopology,
    extraHTTPHeaders: isProdTopology
      ? {
          'x-mivo-debug-token': debugViewToken,
        }
      : undefined,
  })
  let smokePage = await createScenarioSmokePage()
  let { browser, context, errors, mivoEditRequests, page } = smokePage
  let { readFloatingChrome, readLibraryLayout, readLibrarySurfaceColors } = createPageReaders(page)
  const prodExtraHTTPHeaders = isProdTopology
    ? {
        'x-mivo-debug-token': debugViewToken,
      }
    : undefined


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
    await page.goto(canvasUrl, { waitUntil: 'networkidle' })
    // FU4-2: clear IDB + localStorage + sessionStorage (migration markers). Each
    // scenario runs on a fresh browser so this is defensive, but it guarantees no
    // stale persisted state bleeds into the next scenario.
    await clearAllStorage(page)
    await page.goto(canvasUrl, { waitUntil: 'networkidle' })
    if (rendererMode === 'leafer') {
      await page.waitForFunction(() => {
        const shell = document.querySelector('.canvas-shell')
        const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
        const children = Number(shell?.getAttribute('data-leafer-children') || 0)
        return expected > 0 && children === expected && shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
      }, { timeout: 15000 })
    } else {
      await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
    }
    const actualRenderer = await page.evaluate(() => document.querySelector('.canvas-shell')?.getAttribute('data-renderer-mode') || 'dom')
    if (actualRenderer !== rendererMode) {
      throw new Error(`Renderer mode mismatch: requested ${rendererMode} but shell reports ${actualRenderer}`)
    }
  }

  // leafer 模式显式 skip(名单+理由见 scenarios/index.mjs leaferSkippedScenarios)。
  // skip 打印在 stdout,矩阵汇总时可见;dom 模式不受影响。
  const selectedScenarios = resolveScenarioSelection(cliArgs).filter((name) => {
    if (rendererMode === 'leafer' && leaferSkippedScenarios[name]) {
      console.log(`[e2e-smoke] SKIP scenario=${name} renderer=leafer reason=${leaferSkippedScenarios[name]}`)
      return false
    }
    return true
  })
  const scenarioContext = {
    Buffer,
    assertLibraryLayoutStable,
    baseUrl,
    canvasUrl,
    rendererMode,
    browser,
    canvasStoreSpec,
    chatStoreSpec,
    clearAllStorage,
    ensureChatPanelOpen,
    firstNodeId: undefined,
    generatedImageB64,
    horizontalMaskSourceB64,
    isProdTopology,
    localAssetFixtureSvg,
    mivoEditRequests,
    nearlyEqual,
    page,
    prodExtraHTTPHeaders,
    readCanvasState,
    readChatState,
    readFloatingChrome,
    readHeaderTasksIndicator,
    readLibraryLayout,
    readLibrarySurfaceColors,
    readPersistedKv,
    rectsOverlap,
    wait,
    waitForCanvasState,
    waitForChatIdle,
    waitForPersistedKv,
    writePersistedKv,
    assertTasksHeaderCopy,
  }
  const allErrors = []
  const rebindSmokePage = (nextSmokePage) => {
    smokePage = nextSmokePage
    ;({ browser, context, errors, mivoEditRequests, page } = smokePage)
    ;({ readFloatingChrome, readLibraryLayout, readLibrarySurfaceColors } = createPageReaders(page))
    scenarioContext.browser = browser
    scenarioContext.mivoEditRequests = mivoEditRequests
    scenarioContext.page = page
    scenarioContext.readFloatingChrome = readFloatingChrome
    scenarioContext.readLibraryLayout = readLibraryLayout
    scenarioContext.readLibrarySurfaceColors = readLibrarySurfaceColors
  }

  for (let index = 0; index < selectedScenarios.length; index += 1) {
    const scenarioName = selectedScenarios[index]
    if (index > 0) {
      allErrors.push(...errors)
      await browser.close()
      rebindSmokePage(await createScenarioSmokePage())
    }
    scenarioContext.firstNodeId = undefined
    await bootstrapBaseCanvas()
    await scenarioRunners[scenarioName](scenarioContext)
  }


  allErrors.push(...errors)
  await page.screenshot({ path: 'test-artifacts/e2e-smoke.png', fullPage: true })
  await browser.close()

  // Filter known spurious network errors (Eagle mock uses filesystem paths as image URLs on macOS)
  const realErrors = allErrors.filter((e) =>
    !e.includes('ERR_UNKNOWN_URL_SCHEME') &&
    !e.includes('status of 504 (Gateway Timeout)'),
  )
  if (realErrors.length) {
    throw new Error(`Console errors:\n${realErrors.join('\n')}`)
  }

  console.log('E2E smoke test passed')
} finally {
  await stopSmokeDevServer(server)
  await eagleMockHandle.close()
  if (upstreamMockHandle) await upstreamMockHandle.close()
}
