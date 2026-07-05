import { failedTaskView, doneTaskView } from '../api-mocks.mjs'
import { clickCanvasNode, nodeScreenRect } from '../renderer-evidence.mjs'

const readViewport = async (page) => {
  const viewport = await page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    if (!shell) return null
    return {
      x: Number(shell.getAttribute('data-viewport-x')),
      y: Number(shell.getAttribute('data-viewport-y')),
      scale: Number(shell.getAttribute('data-viewport-scale')),
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

const nodeCenterDeltaFromCanvasCenter = async (page, rendererMode, nodeId) => {
  const shellBox = await page.locator('.canvas-shell').boundingBox()
  const rect = await nodeScreenRect(page, rendererMode, nodeId)
  if (!shellBox || !rect) throw new Error(`Canvas node should render after focus: ${nodeId}`)
  return {
    dx: rect.x + rect.width / 2 - (shellBox.x + shellBox.width / 2),
    dy: rect.y + rect.height / 2 - (shellBox.y + shellBox.height / 2),
  }
}

export const runChatGenerationScenario = async (context) => {
  const {
    Buffer,
    canvasStoreSpec,
    chatStoreSpec,
    generatedImageB64,
    localAssetFixtureSvg,
    nearlyEqual,
    page,
    readCanvasState,
    readChatState,
    rectsOverlap,
    wait,
    waitForChatIdle,
    waitForPersistedKv,
  } = context
  const { rendererMode } = context
  const leaferMode = rendererMode === 'leafer'
  // leafer 模式 image 无 DOM,首节点 id 从 store 取;计数走 data-total-node-count
  // (全量口径);dom 模式保持原断言不变。
  const countRenderedNodes = () => (leaferMode
    ? page.evaluate(() => Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0))
    : page.locator('.dom-node').count())
  const firstNodeId = context.firstNodeId ?? (leaferMode
    ? (await readCanvasState()).nodes[0]?.id
    : await page.locator('.dom-node').first().getAttribute('data-node-id'))

  // Chat branch (W4): mode=chat now also generates an image (enhance always ships
  // first). replyText surfaces as a notice; the assistant message shows the final
  // prompt and a param card; /tasks/generate is called once.
  if (await page.locator('.ai-panel.collapsed').isVisible()) {
    await page.getByRole('button', { name: 'Open AI panel' }).click()
    await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
  }
  let chatBranchGenerateRequests = 0
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'chat',
        replyText: '可以。你可以直接和我讨论游戏美术方向，也可以让我帮你生成角色、场景、UI 或道具图。',
        enhanced: true,
      }),
    })
  })
  await page.unroute('**/api/mivo/tasks/generate')
  await page.route('**/api/mivo/tasks/generate', async (route) => {
    chatBranchGenerateRequests += 1
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'task-e2e' }),
    })
  })
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().selectNode(undefined)
  }, await canvasStoreSpec())
  const chatBranchBefore = await readCanvasState()
  await page.locator('.chat-composer-textarea').fill('这里能对话么')
  await page.locator('.chat-composer-textarea').press('Enter')
  await waitForChatIdle()
  // W4: chat 模式也生图 —— /tasks/generate 调 1 次、node +1、param card ≥1。
  // replyText 作附言展示在 .chat-notice-text。
  const chatBranchAfter = await readCanvasState()
  if (chatBranchGenerateRequests !== 1) {
    throw new Error(`W4 chat mode should call /tasks/generate once (image always generated), got ${chatBranchGenerateRequests}`)
  }
  if (chatBranchAfter.nodes.length <= chatBranchBefore.nodes.length) {
    throw new Error(`W4 chat mode should create a canvas node, got before=${chatBranchBefore.nodes.length} after=${chatBranchAfter.nodes.length}`)
  }
  const latestAssistantParamCards = await page.locator('.chat-message-assistant').last().locator('.chat-param-card').count()
  if (latestAssistantParamCards < 1) {
    throw new Error('W4 chat mode should render enhance parameter card (image always generated)')
  }
  const chatNoticeText = await page.locator('.chat-notice-text').last().innerText()
  if (!chatNoticeText.includes('可以') || !chatNoticeText.includes('游戏美术')) {
    throw new Error(`W4 chat mode replyText should surface as notice, got: ${JSON.stringify(chatNoticeText)}`)
  }
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e',
        richPrompt: 'e2e derived concept image',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })
  // Restore default /tasks/generate (202 {taskId}) for chat-based generation.
  await page.unroute('**/api/mivo/tasks/generate')
  await page.route('**/api/mivo/tasks/generate', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'task-e2e' }),
    })
  })
  // Re-register GET /tasks/:id with a FRESH progressive counter. The default mock
  // (attachDefaultMivoApiMocks) holds a module-level getCalls that the first chat
  // branch already exhausted (4 GETs → 10/30/60/100). Without this reset, the
  // second generation's first GET clamps to sequence[3]=done(100) → no
  // intermediate samples → "Expected ≥3 strictly increasing" fails with [100,0,100].
  await page.unroute('**/api/mivo/tasks/*')
  let secondGenGetCalls = 0
  const secondGenSequence = [
    { id: 'task-e2e', kind: 'generate', status: 'running', progress: 10, stage: 'submit', requestId: 'e2e-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'generate', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'generate', status: 'running', progress: 60, stage: 'poll', requestId: 'e2e-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'generate', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-1', model: 'gpt-image-2', result: { images: [{ b64: generatedImageB64 }] } },
  ]
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    secondGenGetCalls += 1
    const view = secondGenSequence[Math.min(secondGenGetCalls - 1, secondGenSequence.length - 1)]
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) })
  })

  // P2-C1b: subscribe to canvasStore tasks to capture real server-side progress
  // samples (must be monotonic, non-hardcoded — assert ≥3 strictly increasing).
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    window.__mivoProgressSamples = []
    let last = -1
    window.__mivoProgressUnsub = useCanvasStore.subscribe((s) => {
      const t = s.tasks[0]
      if (t && t.progress !== last) { window.__mivoProgressSamples.push(t.progress); last = t.progress }
    })
  }, await canvasStoreSpec())

  // Chat-based generation: select node, fill composer, send
  await clickCanvasNode(page, rendererMode, firstNodeId)
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    const { useChatStore } = await import(moduleSpec)
    useChatStore.getState().setParamOverride('imgRatio', '16:9')
    useChatStore.getState().setParamOverride('quality', 'high')
  })
  const canvasBeforeGenerate = await readCanvasState()
  const countBeforeGenerate = await countRenderedNodes()
  await page.locator('.chat-composer-textarea').fill('e2e derived concept image')
  await page.locator('.chat-composer-textarea').press('Enter')
  if (leaferMode) {
    await page.waitForFunction(
      (count) => Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0) >= count + 1,
      countBeforeGenerate,
    )
  } else {
    await page.waitForFunction((count) => document.querySelectorAll('.dom-node').length >= count + 1, countBeforeGenerate)
  }

  const generatedCount = await countRenderedNodes()
  if (generatedCount < countBeforeGenerate + 1) {
    throw new Error(`Expected at least ${countBeforeGenerate + 1} nodes after chat generation result, got ${generatedCount}`)
  }

  // P2-C1b: assert ≥3 strictly increasing, non-hardcoded progress samples from
  // the tasks API (10→30→60→100 — not the old hardcoded 20→100 jump).
  const progressSamples = await page.evaluate(() => {
    if (typeof window.__mivoProgressUnsub === 'function') window.__mivoProgressUnsub()
    return window.__mivoProgressSamples || []
  })
  const strictlyIncreasingSamples = progressSamples.filter((v, i, a) => i === 0 || v > a[i - 1])
  if (strictlyIncreasingSamples.length < 3) {
    throw new Error(`Expected ≥3 strictly increasing progress samples from the tasks API, got ${JSON.stringify(progressSamples)}`)
  }
  // Sanity: the old hardcoded sequence was 20→100 (2 samples). The real sequence
  // must include intermediate values the server reported, not just start+terminal.
  if (progressSamples.length < 3 || progressSamples.at(-1) !== 100) {
    throw new Error(`Progress samples should end at 100 and have intermediate values, got ${JSON.stringify(progressSamples)}`)
  }
  // leafer 模式 image 无 DOM;data-ai-* 与 store node.aiWorkflow 同源(CanvasNodeView
  // 直接透传),leafer 分支从 store 读同字段。
  const besideResult = leaferMode
    ? await page.evaluate(async (moduleSpec) => {
        const { useCanvasStore } = await import(moduleSpec)
        const results = useCanvasStore.getState().nodes.filter(
          (node) => node.aiWorkflow?.kind === 'result' && node.aiWorkflow?.operation === 'beside-generation',
        )
        const node = results.at(-1)
        if (!node) return { id: null, kind: null, operation: null, sourceNodeIds: null }
        return {
          id: node.id,
          kind: node.aiWorkflow.kind,
          operation: node.aiWorkflow.operation,
          sourceNodeIds: node.aiWorkflow.sourceNodeIds?.join(',') ?? null,
        }
      }, await canvasStoreSpec())
    : await page.locator('.dom-node[data-ai-kind="result"][data-ai-operation="beside-generation"]').last().evaluate((node) => ({
        id: node.getAttribute('data-node-id'),
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
  const canvasAfterGenerate = await readCanvasState()
  const newChatEdges = canvasAfterGenerate.edges.filter((edge) =>
    !canvasBeforeGenerate.edges.some((beforeEdge) => beforeEdge.id === edge.id),
  )
  if (newChatEdges.length !== 0) {
    throw new Error(`Chat image-to-image should not create derivation edges: ${JSON.stringify(newChatEdges)}`)
  }

  const shellBoxForResultFocus = await page.locator('.canvas-shell').boundingBox()
  if (!shellBoxForResultFocus) throw new Error('Canvas shell should be measurable for result focus check')
  await page.getByRole('button', { name: 'Hand' }).click()
  const viewportBeforePan = await readViewport(page)
  await page.mouse.move(shellBoxForResultFocus.x + 408, shellBoxForResultFocus.y + 140)
  await page.mouse.down()
  await page.mouse.move(shellBoxForResultFocus.x + 588, shellBoxForResultFocus.y + 260 /* 全铺补偿:起终点 x+268,旧屏幕轨迹不变 */)
  await page.mouse.up()
  const viewportBeforeLocate = await waitForViewport(
    page,
    (viewport) => Math.abs(viewport.x - viewportBeforePan.x) > 80 || Math.abs(viewport.y - viewportBeforePan.y) > 80,
    'manual pan before chat result locate',
  )
  await page.locator('.chat-result-image-btn').last().click()
  await page.waitForFunction(
    async ({ nodeId, leaferMode, moduleSpec }) => {
      if (document.querySelector(`[data-node-id="${nodeId}"]`)?.classList.contains('selected')) return true
      if (!leaferMode) return false
      const { useCanvasStore } = await import(moduleSpec)
      const state = useCanvasStore.getState()
      return state.selectedNodeId === nodeId || (state.selectedNodeIds || []).includes(nodeId)
    },
    { nodeId: besideResult.id, leaferMode, moduleSpec: await canvasStoreSpec() },
  )
  await waitForViewport(
    page,
    (viewport) => Math.abs(viewport.x - viewportBeforeLocate.x) > 40 || Math.abs(viewport.y - viewportBeforeLocate.y) > 40,
    'chat result image click recenters viewport',
  )
  const resultFocusDelta = await nodeCenterDeltaFromCanvasCenter(page, rendererMode, besideResult.id)
  if (Math.abs(resultFocusDelta.dx) > 4 || Math.abs(resultFocusDelta.dy) > 4) {
    throw new Error(`Clicking a chat result image should center its canvas node: ${JSON.stringify(resultFocusDelta)}`)
  }
  await page.getByRole('button', { name: /^Select$/ }).click()

  // Assert chat state: param card appeared in assistant bubble. W4 makes BOTH
  // chat branches generate (image always ships), so two .chat-param-card exist
  // by this point. The first (from the earlier "这里能对话么" branch) may be
  // scrolled/collapsed out of visibility; target the LAST one — the card from
  // the generation that just completed — consistent with the .last() usage below.
  const paramCard = page.locator('.chat-param-card').last()
  await paramCard.waitFor({ state: 'visible' })
  const paramCardVisible = await paramCard.isVisible()
  if (!paramCardVisible) throw new Error('Enhance param card should be visible after generation')
  // R6 SC-e: 参数卡不再渲染 scene chip 与比例/质量 chips 行（composer 底部按钮已可见，卡内不重复）；保留「预计较慢」提示
  const paramCardText = await paramCard.innerText()
  if (!paramCardText.includes('预计较慢')) {
    throw new Error(`Enhance param card should keep the slow hint: ${JSON.stringify(paramCardText)}`)
  }
  const sceneChipCount = await paramCard.locator('.chat-chip-scene').count()
  const ratioChipCount = await paramCard.locator('.chat-chip-ratio').count()
  const qualityChipCount = await paramCard.locator('.chat-chip-quality').count()
  if (sceneChipCount + ratioChipCount + qualityChipCount !== 0) {
    throw new Error(`Enhance param card should not render scene/ratio/quality chips, got ${JSON.stringify({ sceneChipCount, ratioChipCount, qualityChipCount })}`)
  }
  await paramCard.getByRole('button', { name: '深度思考' }).click()
  const reasoningText = await paramCard.locator('.chat-param-fold-body').innerText()
  if (!reasoningText.includes('Agent 建议：1:1 / 中')) {
    throw new Error(`Enhance param card should move differing agent suggestion into reasoning foldout: ${JSON.stringify(reasoningText)}`)
  }
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    const { useChatStore } = await import(moduleSpec)
    useChatStore.getState().setParamOverride('imgRatio', 'auto')
    useChatStore.getState().setParamOverride('quality', 'auto')
  })

  // Assert chat state: assistant result bubble present
  const assistantBubbles = await page.locator('.chat-message-assistant').count()
  if (assistantBubbles < 1) throw new Error('Assistant message bubble should appear after generation')

  // Persist check: verify messages are durably stored in IDB before reload. The IDB
  // write is async (zustand persist fire-and-forgets setItem), so poll until the
  // stored count reflects the generation. (FU4-2: was a sync localStorage.getItem.)
  const storedMsgCount = await waitForPersistedKv(page, 'mivo-chat-demo', (raw) => {
    try {
      const parsed = JSON.parse(raw)
      const byScene = parsed?.state?.messagesByScene ?? {}
      return Object.values(byScene).flat().length >= 2
    } catch {
      return false
    }
  }).then((raw) => {
    if (!raw) return 0
    try {
      const parsed = JSON.parse(raw)
      const byScene = parsed?.state?.messagesByScene ?? {}
      return Object.values(byScene).flat().length
    } catch {
      return 0
    }
  })
  if (storedMsgCount < 2) throw new Error(`Chat messages should be persisted in IDB, got ${storedMsgCount}`)

  // NB3: gemini 4:3 → client sends {model, imgRatio:"4:3"}（gemini 专属比例，gpt 无；走 mivo 平台通道）
  let capturedGeminiPayload = null
  await page.unroute('**/api/mivo/tasks/generate')
  await page.route('**/api/mivo/tasks/generate', async (route) => {
    try { capturedGeminiPayload = JSON.parse(route.request().postData() || '{}') } catch { capturedGeminiPayload = {} }
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
  })
  // Deselect canvas nodes so generate (not edit) is called
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().selectNode(undefined)
  }, await canvasStoreSpec())
  await page.waitForFunction(
    async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      return !useCanvasStore.getState().selectedNodeId
    },
    await canvasStoreSpec(),
  )
  await page.waitForTimeout(100)
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    const { useChatStore } = await import(moduleSpec)
    useChatStore.getState().setSelectedModel('gemini-3-pro-image')
    useChatStore.getState().setParamOverride('imgRatio', '4:3')
  })
  // ② gemini 比例弹层断言：含 4:3，不含 21:9（能力表去 21:9 的前端表现）
  {
    await page.locator('[aria-label="选择比例和质量"]').click()
    await page.waitForSelector('#chat-ratio-popover .chat-ratio-btn')
    const ratioLabels = (await page.locator('#chat-ratio-popover .chat-ratio-btn').allInnerTexts()).map((t) => t.trim())
    if (!ratioLabels.some((t) => t === '4:3')) {
      throw new Error(`Gemini ratio popover should include 4:3, got: ${JSON.stringify(ratioLabels)}`)
    }
    if (ratioLabels.some((t) => t === '21:9')) {
      throw new Error(`Gemini ratio popover should NOT include 21:9, got: ${JSON.stringify(ratioLabels)}`)
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector('#chat-ratio-popover', { state: 'detached' })
  }
  const canvasBeforeGemini = await readCanvasState()
  await page.locator('.chat-composer-textarea').fill('gemini aspect ratio test')
  await page.locator('.chat-composer-textarea').press('Enter')
  // 断言绑行为(slot 创建落 store):镜头跟随会把视口平移到新 slot,culling(overscan
  // 520px)下 .dom-node 数量随视口变化不再单调增长,不能作为 slot 创建信号。
  {
    const deadline = Date.now() + 30000
    let nodesNow = canvasBeforeGemini.nodes.length
    while (Date.now() < deadline) {
      nodesNow = (await readCanvasState()).nodes.length
      if (nodesNow > canvasBeforeGemini.nodes.length) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (nodesNow <= canvasBeforeGemini.nodes.length) {
      throw new Error(`gemini submit should create an ai-slot node in the store, count stuck at ${nodesNow}`)
    }
  }
  // 节点增长（slot 创建）先于 generate 请求发出 —— 轮询直到请求被捕获，消除竞态
  {
    const geminiDeadline = Date.now() + 30000
    while (!capturedGeminiPayload && Date.now() < geminiDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  // Client sends {model, imgRatio} — gemini 走 mivo 平台通道（不再经 llm-proxy/aspect_ratio）
  if (capturedGeminiPayload?.model !== 'gemini-3-pro-image' || capturedGeminiPayload?.imgRatio !== '4:3') {
    throw new Error(`gemini 4:3 request should carry model and imgRatio, got: ${JSON.stringify(capturedGeminiPayload)}`)
  }
  await page.unroute('**/api/mivo/tasks/generate')
  await page.route('**/api/mivo/tasks/generate', async (route) => {
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
  })
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    const { useChatStore } = await import(moduleSpec)
    useChatStore.getState().setSelectedModel('gpt-image-2')
    useChatStore.getState().setParamOverride('imgRatio', 'auto')
  })
  // Wait for isBusy to clear after gemini generation
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    const { useChatStore } = await import(moduleSpec)
    const waitIdle = () => new Promise((resolve) => {
      if (!useChatStore.getState().isBusy) return resolve(null)
      const unsub = useChatStore.subscribe((s) => { if (!s.isBusy) { unsub(); resolve(null) } })
    })
    await waitIdle()
  })
  const canvasAfterGemini = await readCanvasState()
  const newGeminiEdges = canvasAfterGemini.edges.filter((edge) =>
    !canvasBeforeGemini.edges.some((beforeEdge) => beforeEdge.id === edge.id),
  )
  if (newGeminiEdges.length !== 0) {
    throw new Error(`Chat text-to-image should not create derivation edges: ${JSON.stringify(newGeminiEdges)}`)
  }

  // Regression: chat generation must commit to the scene where it started, even after switching canvases.
  const sceneScopedBefore = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const state = useCanvasStore.getState()
    return {
      nodes: state.canvases['character-flow']?.nodes.length || 0,
      variantsNodes: state.canvases.variants?.nodes.length || 0,
    }
  }, await canvasStoreSpec())
  let releaseSceneScopedPoll
  let sceneScopedGenerateSeen = false
  const sceneScopedTasksHandler = async (route) => {
    const method = route.request().method()
    const url = route.request().url()
    if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
      sceneScopedGenerateSeen = true
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'GET') {
      // Hold the poll until the scene switch happens, then complete — this keeps
      // the generation in-flight across the scene switch (the regression's point).
      await new Promise((resolve) => {
        releaseSceneScopedPoll = resolve
      })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])),
      })
      return
    }
    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', sceneScopedTasksHandler)
  try {
    await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().loadScene('character-flow')
      useCanvasStore.getState().selectNode(undefined)
    }, await canvasStoreSpec())
    await page.locator('.chat-composer-textarea').fill('scene scoped generation regression')
    await page.locator('.chat-composer-textarea').press('Enter')
    const startedAt = Date.now()
    while (!sceneScopedGenerateSeen && Date.now() - startedAt < 5000) await wait(25)
    if (!sceneScopedGenerateSeen) throw new Error('Scene-scoped regression should reach POST /api/mivo/tasks/generate')
    await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().loadScene('variants')
    }, await canvasStoreSpec())
    releaseSceneScopedPoll()
    await waitForChatIdle()
  } finally {
    await page.unroute('**/api/mivo/tasks/**', sceneScopedTasksHandler)
  }
  const sceneScopedAfter = await page.evaluate(async ({ canvasModuleSpec, chatModuleSpec }) => {
    const { useCanvasStore } = await import(canvasModuleSpec)
    const { useChatStore } = await import(chatModuleSpec)
    const canvasState = useCanvasStore.getState()
    const chatState = useChatStore.getState()
    return {
      activeSceneId: canvasState.sceneId,
      characterNodes: canvasState.canvases['character-flow']?.nodes.length || 0,
      variantsNodes: canvasState.canvases.variants?.nodes.length || 0,
      characterAssistantErrors: (chatState.messagesByScene['character-flow'] || [])
        .filter((message) => message.role === 'assistant' && message.status === 'error')
        .map((message) => message.error || ''),
      currentNotices: (chatState.messagesByScene[canvasState.sceneId] || [])
        .filter((message) => message.kind === 'notice')
        .map((message) => message.text),
    }
  }, { canvasModuleSpec: await canvasStoreSpec(), chatModuleSpec: await chatStoreSpec() })
  if (sceneScopedAfter.activeSceneId !== 'variants') {
    throw new Error(`Scene-scoped regression should leave user on variants, got ${sceneScopedAfter.activeSceneId}`)
  }
  if (sceneScopedAfter.characterNodes <= sceneScopedBefore.nodes) {
    throw new Error(`Scene-scoped generation should add nodes to character-flow: ${JSON.stringify({ sceneScopedBefore, sceneScopedAfter })}`)
  }
  if (sceneScopedAfter.variantsNodes !== sceneScopedBefore.variantsNodes) {
    throw new Error(`Scene-scoped generation should not patch active variants nodes: ${JSON.stringify({ sceneScopedBefore, sceneScopedAfter })}`)
  }
  if (sceneScopedAfter.characterAssistantErrors.some((error) => error.includes('Source node not found'))) {
    throw new Error(`Scene-scoped generation should not surface Source node not found: ${JSON.stringify(sceneScopedAfter.characterAssistantErrors)}`)
  }
  if (!sceneScopedAfter.currentNotices.some((text) => text.includes('结果已生成到画布'))) {
    throw new Error(`Scene switch completion should append a current-scene notice: ${JSON.stringify(sceneScopedAfter.currentNotices)}`)
  }
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
  }, await canvasStoreSpec())

  // ④ Regression: gemini high 超时 → 出现「中质量重试」且二次请求 quality=medium（Step 4b 条件化）
  const timeoutRetryGenerateRequests = []
  let timeoutRetryGenerateCount = 0
  const timeoutRetryGenerateHandler = async (route) => {
    const method = route.request().method()
    const url = route.request().url()
    if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
      try { timeoutRetryGenerateRequests.push(JSON.parse(route.request().postData() || '{}')) } catch { timeoutRetryGenerateRequests.push({}) }
      timeoutRetryGenerateCount += 1
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'GET') {
      // 1st generation: upstream timeout (high quality → offers 中质量重试).
      // 2nd generation (medium retry): success.
      if (timeoutRetryGenerateCount === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(failedTaskView('上游生成超时，可降低质量重试')) })
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
      }
      return
    }
    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', timeoutRetryGenerateHandler)
  try {
    await page.evaluate(async ({ canvasModuleSpec, chatModuleSpec }) => {
      const { useCanvasStore } = await import(canvasModuleSpec)
      const { useChatStore } = await import(chatModuleSpec)
      useCanvasStore.getState().selectNode(undefined)
      useChatStore.getState().setSelectedModel('gemini-3-pro-image')
      useChatStore.getState().setParamOverride('imgRatio', '16:9')
      useChatStore.getState().setParamOverride('quality', 'high')
    }, { canvasModuleSpec: await canvasStoreSpec(), chatModuleSpec: await chatStoreSpec() })
    await page.locator('.chat-composer-textarea').fill('timeout retry should lower only quality')
    await page.locator('.chat-composer-textarea').press('Enter')
    await page.waitForSelector('.chat-error-text', { timeout: 10000 })
    const timeoutText = await page.locator('.chat-error-text').last().innerText()
    if (!timeoutText.includes('上游生成超时，可降低质量重试')) {
      throw new Error(`Upstream 504 should show a lowering-quality timeout message: ${JSON.stringify(timeoutText)}`)
    }
    // 采纳 8：中质量重试按钮 title 含"降到 1K"
    const mediumRetryBtnTitle = await page.locator('.chat-message-assistant').last().getByRole('button', { name: '中质量重试' }).first().getAttribute('title') || ''
    if (!mediumRetryBtnTitle.includes('降到 1K')) {
      throw new Error(`medium-retry button title should include "降到 1K", got: ${JSON.stringify(mediumRetryBtnTitle)}`)
    }
    await page.getByRole('button', { name: '中质量重试' }).last().click()
    await waitForChatIdle()
    await page.waitForSelector('.chat-result-image, .chat-result-image-placeholder', { timeout: 10000 })
    if (timeoutRetryGenerateRequests.length !== 2) {
      throw new Error(`Timeout retry should issue exactly two generate requests, got ${timeoutRetryGenerateRequests.length}`)
    }
    const [firstTimeoutRequest, mediumRetryRequest] = timeoutRetryGenerateRequests
    if (
      firstTimeoutRequest.quality !== 'high' ||
      mediumRetryRequest.quality !== 'medium' ||
      mediumRetryRequest.imgRatio !== firstTimeoutRequest.imgRatio ||
      mediumRetryRequest.model !== firstTimeoutRequest.model ||
      mediumRetryRequest.prompt !== firstTimeoutRequest.prompt
    ) {
      throw new Error(`Medium retry should lower only quality: ${JSON.stringify(timeoutRetryGenerateRequests)}`)
    }
  } finally {
    await page.unroute('**/api/mivo/tasks/**', timeoutRetryGenerateHandler)
    await page.evaluate(async () => {
      const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
      const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
      const { useChatStore } = await import(moduleSpec)
      useChatStore.getState().setParamOverride('imgRatio', 'auto')
      useChatStore.getState().setParamOverride('quality', 'auto')
    })
  }

  // ④b Regression: gemini medium 超时 → 不出现降质按钮、文案为"稍后重试/换比例"（Step 4b 条件化）
  {
    const mediumTimeoutHandler = async (route) => {
      const method = route.request().method()
      const url = route.request().url()
      if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
        return
      }
      if (method === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(failedTaskView('上游生成超时，可稍后重试、换比例或减少参考图')) })
        return
      }
      await route.continue()
    }
    await page.route('**/api/mivo/tasks/**', mediumTimeoutHandler)
    try {
      await page.evaluate(async ({ canvasModuleSpec, chatModuleSpec }) => {
        const { useCanvasStore } = await import(canvasModuleSpec)
        const { useChatStore } = await import(chatModuleSpec)
        useCanvasStore.getState().selectNode(undefined)
        useChatStore.getState().setSelectedModel('gemini-3-pro-image')
        useChatStore.getState().setParamOverride('imgRatio', '4:3')
        useChatStore.getState().setParamOverride('quality', 'medium')
      }, { canvasModuleSpec: await canvasStoreSpec(), chatModuleSpec: await chatStoreSpec() })
      await page.locator('.chat-composer-textarea').fill('medium timeout should not offer downgrade')
      await page.locator('.chat-composer-textarea').press('Enter')
      await page.waitForSelector('.chat-error-text', { timeout: 10000 })
      await waitForChatIdle()
      const mediumTimeoutText = await page.locator('.chat-error-text').last().innerText()
      if (!mediumTimeoutText.includes('稍后重试') || !mediumTimeoutText.includes('换比例')) {
        throw new Error(`Medium-quality timeout should suggest retry/ratio (not downgrade), got: ${JSON.stringify(mediumTimeoutText)}`)
      }
      // medium(1K) 不应出现"中质量重试"降质按钮（showMediumRetry 仅 high 才显示）
      const mediumRetryBtnCount = await page.locator('.chat-message-assistant').last().getByRole('button', { name: '中质量重试' }).count()
      if (mediumRetryBtnCount > 0) {
        throw new Error(`Medium-quality timeout should NOT show a downgrade button, got ${mediumRetryBtnCount}`)
      }
    } finally {
      await page.unroute('**/api/mivo/tasks/**', mediumTimeoutHandler)
      // 清掉本用例留下的 error 消息，避免后续 retry-edit 用例的 waitForSelector('.chat-error-text') 命中残留
      await page.evaluate(async () => {
        const canvasResource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('canvasStore.ts'))
        const chatResource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
        const canvasModuleSpec = canvasResource ? new URL(canvasResource).pathname + new URL(canvasResource).search : '/src/store/canvasStore.ts'
        const chatModuleSpec = chatResource ? new URL(chatResource).pathname + new URL(chatResource).search : '/src/store/chatStore.ts'
        const { useCanvasStore } = await import(canvasModuleSpec)
        const { useChatStore } = await import(chatModuleSpec)
        useChatStore.getState().clearScene(useCanvasStore.getState().sceneId)
        useChatStore.getState().setParamOverride('imgRatio', 'auto')
        useChatStore.getState().setParamOverride('quality', 'auto')
      })
    }
  }

  // ④c Regression: medium 504 → 点普通重试 → 再 504 → 断言无"降低质量"字样、无中质量重试按钮、二次 quality=medium
  {
    const retry504Requests = []
    const retry504Handler = async (route) => {
      const method = route.request().method()
      const url = route.request().url()
      if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
        try { retry504Requests.push(JSON.parse(route.request().postData() || '{}')) } catch { retry504Requests.push({}) }
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
        return
      }
      if (method === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(failedTaskView('上游生成超时，可稍后重试、换比例或减少参考图')) })
        return
      }
      await route.continue()
    }
    await page.route('**/api/mivo/tasks/**', retry504Handler)
    try {
      await page.evaluate(async ({ canvasModuleSpec, chatModuleSpec }) => {
        const { useCanvasStore } = await import(canvasModuleSpec)
        const { useChatStore } = await import(chatModuleSpec)
        useCanvasStore.getState().selectNode(undefined)
        useChatStore.getState().setSelectedModel('gemini-3-pro-image')
        useChatStore.getState().setParamOverride('imgRatio', '4:3')
        useChatStore.getState().setParamOverride('quality', 'medium')
      }, { canvasModuleSpec: await canvasStoreSpec(), chatModuleSpec: await chatStoreSpec() })
      await page.locator('.chat-composer-textarea').fill('medium retry 504 no downgrade')
      await page.locator('.chat-composer-textarea').press('Enter')
      await page.waitForSelector('.chat-error-text', { timeout: 10000 })
      await waitForChatIdle()
      // 点普通重试（非中质量重试）
      const requestsBefore = retry504Requests.length
      await page.locator('.chat-message-assistant').last().getByRole('button', { name: '重试' }).click()
      const retryDeadline = Date.now() + 10000
      while (retry504Requests.length <= requestsBefore && Date.now() < retryDeadline) {
        await new Promise((r) => setTimeout(r, 200))
      }
      if (retry504Requests.length <= requestsBefore) {
        throw new Error('medium retry-504: retry did not issue a new request')
      }
      await waitForChatIdle()
      const retryText = await page.locator('.chat-error-text').last().innerText()
      if (retryText.includes('降低质量')) {
        throw new Error(`medium retry-504 should not mention downgrade, got: ${JSON.stringify(retryText)}`)
      }
      const retryMediumBtn = await page.locator('.chat-message-assistant').last().getByRole('button', { name: '中质量重试' }).count()
      if (retryMediumBtn > 0) {
        throw new Error(`medium retry-504 should NOT show medium-quality retry button, got ${retryMediumBtn}`)
      }
      const lastRequest = retry504Requests[retry504Requests.length - 1]
      if (lastRequest.quality !== 'medium') {
        throw new Error(`medium retry should keep quality=medium, got ${JSON.stringify(lastRequest.quality)}`)
      }
    } finally {
      await page.unroute('**/api/mivo/tasks/**', retry504Handler)
      await page.evaluate(async () => {
        const canvasResource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('canvasStore.ts'))
        const chatResource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
        const canvasModuleSpec = canvasResource ? new URL(canvasResource).pathname + new URL(canvasResource).search : '/src/store/canvasStore.ts'
        const chatModuleSpec = chatResource ? new URL(chatResource).pathname + new URL(chatResource).search : '/src/store/chatStore.ts'
        const { useCanvasStore } = await import(canvasModuleSpec)
        const { useChatStore } = await import(chatModuleSpec)
        useChatStore.getState().clearScene(useCanvasStore.getState().sceneId)
        useChatStore.getState().setParamOverride('imgRatio', 'auto')
        useChatStore.getState().setParamOverride('quality', 'auto')
      })
    }
  }

  // Regression: retry reuses the original user message and preserves uploaded reference assets.
  const retryEditRequests = []
  let retryEditCount = 0
  const retryEditHandler = async (route) => {
    const method = route.request().method()
    const url = route.request().url()
    if (method === 'POST' && url.includes('/api/mivo/tasks/edit')) {
      const request = route.request()
      try {
        const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', {
          method: 'POST',
          headers: request.headers(),
          body: request.postDataBuffer(),
        })
        const formData = await formRequest.formData()
        retryEditRequests.push({
          prompt: String(formData.get('prompt') || ''),
          fileKeys: ['image', 'mask', 'reference[]', 'reference']
            .map((key) => `${key}:${formData.getAll(key).length}`)
            .filter((entry) => !entry.endsWith(':0')),
        })
      } catch (error) {
        retryEditRequests.push({
          prompt: '',
          fileKeys: [],
          parseError: error instanceof Error ? error.message : 'Unable to inspect edit request',
        })
      }
      retryEditCount += 1
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'GET') {
      // 1st attempt: done but empty images → commit throws → error (retry shown).
      // 2nd attempt (retry): done with a real image.
      if (retryEditCount === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([])) })
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
      }
      return
    }
    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', retryEditHandler)
  try {
    await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().selectNode(undefined)
    }, await canvasStoreSpec())
    await page.locator('.ai-panel input[type="file"][accept*="image/png"]').setInputFiles({
      name: 'retry-reference.png',
      mimeType: 'image/png',
      buffer: Buffer.from(localAssetFixtureSvg),
    })
    await page.waitForSelector('.chat-ref-chip')
    const retryUserCountBefore = (await readChatState()).messagesByScene['character-flow'].filter((message) => message.role === 'user').length
    await page.locator('.chat-composer-textarea').fill('retry should preserve uploaded reference')
    await page.locator('.chat-composer-textarea').press('Enter')
    await page.waitForSelector('.chat-error-text', { timeout: 10000 })
    await page.locator('.chat-retry-btn').last().click()
    await waitForChatIdle()
    await page.waitForSelector('.chat-result-image, .chat-result-image-placeholder', { timeout: 10000 })
    const retryUserCountAfter = (await readChatState()).messagesByScene['character-flow'].filter((message) => message.role === 'user').length
    if (retryUserCountAfter !== retryUserCountBefore + 1) {
      throw new Error(`Retry should not duplicate the original user message: before=${retryUserCountBefore}, after=${retryUserCountAfter}`)
    }
    if (retryEditRequests.length !== 2 || !retryEditRequests.every((request) => request.fileKeys.includes('image:1'))) {
      throw new Error(`Retry should replay edit with the original reference image: ${JSON.stringify(retryEditRequests)}`)
    }
  } finally {
    await page.unroute('**/api/mivo/tasks/**', retryEditHandler)
  }

  // Cancel mid-flight. rev4 (SC5.2): canceling a chat first-time generation now
  // REMOVES the temporary ai-slot placeholder (rollback to the pre-generation
  // history baseline) and drops its task — it no longer leaves a lingering
  // status='canceled' task/slot. Still: DELETE /tasks/:id is issued, polling stops
  // after DELETE, and no result node is committed.
  {
    let cancelPostSeen = false
    let cancelDeleteSeen = false
    let getBeforeDelete = 0
    let getAfterDelete = 0
    const cancelHandler = async (route) => {
      const method = route.request().method()
      const url = route.request().url()
      if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
        cancelPostSeen = true
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
        return
      }
      if (method === 'DELETE') {
        cancelDeleteSeen = true
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
        return
      }
      if (method === 'GET') {
        if (cancelDeleteSeen) getAfterDelete += 1
        else getBeforeDelete += 1
        // Stay running so the generation stays in-flight until the client cancels.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'task-e2e', kind: 'generate', status: 'running', progress: 40, stage: 'poll', requestId: 'e2e-cancel', model: 'gpt-image-2' }),
        })
        return
      }
      await route.continue()
    }
    await page.route('**/api/mivo/tasks/**', cancelHandler)
    try {
      await page.evaluate(async (moduleSpec) => {
        const { useCanvasStore } = await import(moduleSpec)
        useCanvasStore.getState().selectNode(undefined)
      }, await canvasStoreSpec())
      const cancelBaseline = await page.evaluate(async (moduleSpec) => {
        const { useCanvasStore } = await import(moduleSpec)
        const s = useCanvasStore.getState()
        return {
          aiSlots: s.nodes.filter((n) => n.type === 'ai-slot').length,
          images: s.nodes.filter((n) => n.type === 'image').length,
        }
      }, await canvasStoreSpec())
      await page.locator('.chat-composer-textarea').fill('cancel mid-flight test')
      await page.locator('.chat-composer-textarea').press('Enter')
      // Wait until the generation is in-flight: POST seen AND at least one GET poll
      // landed (the GET only happens after the POST returned 202, so serverTaskId is
      // set by then — canceling mid-poll exercises the DELETE path, not the pre-submit
      // short-circuit).
      const inFlightDeadline = Date.now() + 5000
      while (!(cancelPostSeen && getBeforeDelete > 0) && Date.now() < inFlightDeadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (!cancelPostSeen) throw new Error('Cancel test: generation POST /tasks/generate not seen')
      if (getBeforeDelete === 0) throw new Error('Cancel test: generation did not start polling (GET /tasks/:id not seen)')
      await page.evaluate(async () => {
        const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
        const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
        const { useChatStore } = await import(moduleSpec)
        useChatStore.getState().cancelGeneration()
      })
      await waitForChatIdle()
      // Allow a brief moment for any stray poll to land, then assert no GET after DELETE.
      await new Promise((r) => setTimeout(r, 200))
      const cancelState = await page.evaluate(async (moduleSpec) => {
        const { useCanvasStore } = await import(moduleSpec)
        const s = useCanvasStore.getState()
        return {
          tasks: s.tasks.map((t) => ({ id: t.id, status: t.status, nodeIds: t.nodeIds })),
          aiSlots: s.nodes.filter((n) => n.type === 'ai-slot').length,
          images: s.nodes.filter((n) => n.type === 'image').length,
          lingeringSlotStatuses: s.nodes.filter((n) => n.type === 'ai-slot').map((n) => n.aiWorkflow?.status),
        }
      }, await canvasStoreSpec())
      // rev4: the placeholder + its task are rolled back on cancel — no lingering
      // canceled/generating slot, ai-slot count returns to the pre-submit baseline.
      if (cancelState.aiSlots !== cancelBaseline.aiSlots) {
        throw new Error(`Cancel should remove the placeholder (ai-slots back to ${cancelBaseline.aiSlots}), got ${cancelState.aiSlots}`)
      }
      if (cancelState.lingeringSlotStatuses.some((status) => status === 'canceled' || status === 'generating')) {
        throw new Error(`Cancel should not leave a canceled/generating placeholder, got ${JSON.stringify(cancelState.lingeringSlotStatuses)}`)
      }
      if (cancelState.tasks.some((t) => t.status === 'canceled' || (t.status === 'running' && t.nodeIds.length === 0))) {
        throw new Error(`Cancel should drop the placeholder's task (no lingering canceled/running task), got ${JSON.stringify(cancelState.tasks)}`)
      }
      // Cancel must never commit a result image.
      if (cancelState.images !== cancelBaseline.images) {
        throw new Error(`Cancel must not commit a result image (before ${cancelBaseline.images}, after ${cancelState.images})`)
      }
      if (!cancelDeleteSeen) throw new Error('Cancel should issue DELETE /tasks/:id')
      if (getAfterDelete > 0) {
        throw new Error(`Poll should stop after DELETE; got ${getAfterDelete} GET(s) after DELETE`)
      }
    } finally {
      await page.unroute('**/api/mivo/tasks/**', cancelHandler)
      await page.evaluate(async () => {
        const canvasResource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('canvasStore.ts'))
        const chatResource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
        const canvasModuleSpec = canvasResource ? new URL(canvasResource).pathname + new URL(canvasResource).search : '/src/store/canvasStore.ts'
        const chatModuleSpec = chatResource ? new URL(chatResource).pathname + new URL(chatResource).search : '/src/store/chatStore.ts'
        const { useCanvasStore } = await import(canvasModuleSpec)
        const { useChatStore } = await import(chatModuleSpec)
        useChatStore.getState().clearScene(useCanvasStore.getState().sceneId)
      })
    }
  }

  const workflowCount = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.length
  }, await canvasStoreSpec())

  await page.getByRole('button', { name: '4 张变体结果' }).click()
  // 标题药丸已移除;画布切换改用 store 的 active canvas title 校验(等价原 .top-title-lockup 读法)。
  await page.waitForFunction(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const state = useCanvasStore.getState()
    return state.canvases[state.sceneId]?.title === '4 张变体结果'
  }, await canvasStoreSpec())
  await page.getByRole('button', { name: '角色参考图流程' }).click()
  await page.waitForFunction(
    async ({ moduleSpec, count }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const state = useCanvasStore.getState()
      return state.sceneId === 'character-flow' && state.nodes.length === count
    },
    { moduleSpec: await canvasStoreSpec(), count: workflowCount },
  )

  // 画布 Rename / Duplicate / Delete 原仅通过标题药丸的 "..." 菜单可达,药丸移除后这些
  // 入口一并消失(功能损失已在交付报告中显式列出),故此处对应的菜单驱动子测试删除。
  // 保留上方基于 store 的画布切换校验(active canvas = character-flow, nodes = workflowCount)。

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

  await page.locator('.canvas-shell').click({ position: { x: 160, y: 160 }, force: true })
  const countBeforeClipboardPaste = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.length
  }, await canvasStoreSpec())
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
    async ({ moduleSpec, count }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.length === count + 1
    },
    { moduleSpec: await canvasStoreSpec(), count: countBeforeClipboardPaste },
  )

  await page.getByRole('button', { name: 'Reset view' }).click()
  await page.locator('.canvas-shell').click({ position: { x: 160, y: 160 }, force: true })
  const countBeforeTransparentPaste = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.filter((node) => node.type === 'image').length
  }, await canvasStoreSpec())
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
    async ({ moduleSpec, count }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.filter((node) => node.type === 'image').length === count + 1
    },
    { moduleSpec: await canvasStoreSpec(), count: countBeforeTransparentPaste },
  )
  if (!leaferMode) {
  const transparentImageNode = page.locator('.dom-node[data-node-type="image"]').last()
  await transparentImageNode.locator('.dom-node-media img').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const image = [...document.querySelectorAll('.dom-node[data-node-type="image"]')].at(-1)?.querySelector('.dom-node-media img')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  })
  const transparentPasteRender = await transparentImageNode.evaluate((node) => {
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
  }
}
